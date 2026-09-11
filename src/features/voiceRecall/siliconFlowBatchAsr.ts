import type { AsrStreamAdapter, AsrStreamEvent, AsrStreamRequest } from "./contracts";
import { createTimeoutSignal, VoiceProviderError } from "./providerRuntime";

export const SILICONFLOW_BATCH_CAPABILITIES = Object.freeze({ realtime: false, partial: false, endpointControl: false, cancellation: true, browserDirectSupported: false, verified: false });

export class SiliconFlowBatchAsrAdapter implements AsrStreamAdapter {
  readonly profileId = "siliconflow-batch-candidate";
  constructor(private readonly config: { model: string; apiKey: string; endpoint: string }, private readonly hostFetch: typeof fetch) {}

  async *transcribe(request: AsrStreamRequest): AsyncIterable<AsrStreamEvent> {
    request.signal.throwIfAborted();
    const endpoint = new URL(this.config.endpoint);
    if (endpoint.protocol !== "https:" || !["api.siliconflow.com", "api.siliconflow.cn"].includes(endpoint.hostname) || endpoint.pathname !== "/v1/audio/transcriptions" || endpoint.search || endpoint.username || endpoint.password) throw new VoiceProviderError("硅基流动端点配置无效", "unsupported", false);
    if (!this.config.model.trim() || !this.config.apiKey.trim()) throw new VoiceProviderError("硅基流动模型或密钥未配置", "unauthorized", false);
    if (request.format.encoding !== "pcm-s16le" || request.format.sampleRate !== 16000 || request.format.channelCount !== 1) throw new VoiceProviderError("批量转写只接受 16kHz 单声道 PCM", "unsupported", false);
    const chunks: Uint8Array[] = [];
    let length = 0;
    for await (const frame of request.frames) {
      request.signal.throwIfAborted();
      if (frame.format.sampleRate !== 16000 || frame.format.encoding !== "pcm-s16le" || frame.format.channelCount !== 1 || frame.data.byteLength % 2) throw new VoiceProviderError("采集格式不一致", "invalid-response", false);
      length += frame.data.byteLength;
      if (length > 16000 * 2 * 120) throw new VoiceProviderError("录音超过 120 秒", "unsupported", false);
      chunks.push(frame.data.slice());
    }
    if (!length) throw new VoiceProviderError("录音为空", "invalid-response", false);
    const wav = new Uint8Array(44 + length);
    const header = new DataView(wav.buffer);
    const text = new TextEncoder();
    wav.set(text.encode("RIFF")); header.setUint32(4, length + 36, true); wav.set(text.encode("WAVEfmt "), 8);
    header.setUint32(16, 16, true); header.setUint16(20, 1, true); header.setUint16(22, 1, true);
    header.setUint32(24, 16000, true); header.setUint32(28, 32000, true); header.setUint16(32, 2, true); header.setUint16(34, 16, true);
    wav.set(text.encode("data"), 36); header.setUint32(40, length, true);
    let offset = 44;
    for (const chunk of chunks) { wav.set(chunk, offset); offset += chunk.byteLength; }
    const form = new FormData();
    form.append("file", new Blob([wav.buffer], { type: "audio/wav" }), "voice.wav");
    form.append("model", this.config.model);
    const timeout = createTimeoutSignal(request.signal, 30000);
    try {
      const response = await this.hostFetch(endpoint.href, { method: "POST", headers: { Authorization: `Bearer ${this.config.apiKey.trim().replace(/^Bearer\s+/i, "")}` }, body: form, signal: timeout.signal });
      if (!response.ok) throw new VoiceProviderError("批量识别请求失败", response.status === 401 || response.status === 403 ? "unauthorized" : "network", false, response.status);
      const result: unknown = await response.json();
      request.signal.throwIfAborted();
      if (!result || typeof result !== "object" || !("text" in result) || typeof result.text !== "string" || !result.text.trim()) throw new VoiceProviderError("批量识别未返回有效正文", "invalid-response", false);
      yield { type: "final", text: result.text.trim(), cumulative: true };
      yield { type: "completed" };
    } finally { timeout.dispose(); }
  }
}
