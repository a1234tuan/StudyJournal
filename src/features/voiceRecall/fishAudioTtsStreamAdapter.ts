import type { TtsStreamAdapter, TtsStreamEvent, TtsStreamRequest } from "./contracts";
import type { VoiceTtsProviderProfile } from "./providerProfiles";
import { createTimeoutSignal, VoiceProviderError } from "./providerRuntime";

type FetchImplementation = typeof fetch;

export class FishAudioTtsStreamAdapter implements TtsStreamAdapter {
  readonly profileId: string;

  constructor(
    private readonly profile: VoiceTtsProviderProfile,
    private readonly apiKey: string,
    private readonly fetchImplementation: FetchImplementation = fetch,
  ) {
    this.profileId = profile.id;
  }

  async *synthesize(request: TtsStreamRequest): AsyncIterable<TtsStreamEvent> {
    const timeout = createTimeoutSignal(request.signal, this.profile.firstChunkTimeoutMs);
    try {
      const response = await this.fetchImplementation(this.profile.endpoint, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.apiKey.trim().replace(/^Bearer\s+/i, "")}`,
          "Content-Type": "application/json",
          Accept: "audio/mpeg",
          model: this.profile.model,
        },
        body: JSON.stringify({
          text: request.text,
          reference_id: request.voice || this.profile.voice,
          format: "mp3",
          normalize: true,
          prosody: { speed: request.rate ?? 1.2 },
          mp3_bitrate: 64,
          latency: "normal",
          chunk_length: 200,
        }),
        signal: timeout.signal,
      });
      if (!response.ok) {
        const retryable = response.status === 408 || response.status === 429 || response.status >= 500;
        throw new VoiceProviderError(
          response.status === 401 || response.status === 403 ? "Fish Audio 凭据无效。" : `Fish Audio 请求失败（HTTP ${response.status}）。`,
          response.status === 401 || response.status === 403 ? "unauthorized" : response.status === 429 ? "rate-limited" : "network",
          retryable,
          response.status,
        );
      }
      if (!response.body) throw new VoiceProviderError("Fish Audio 没有返回音频流。", "invalid-response", false);
      const reader = response.body.getReader();
      let received = false;
      try {
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          if (!value?.byteLength) continue;
          received = true;
          timeout.dispose();
          yield { type: "audio", chunk: value, format: { encoding: "provider-native", sampleRate: 16_000, channelCount: 1 } };
        }
      } finally {
        reader.releaseLock();
      }
      if (!received) throw new VoiceProviderError("Fish Audio 返回了空音频流。", "invalid-response", false);
      yield { type: "usage", characters: request.text.length };
      yield { type: "completed" };
    } catch (error) {
      if (request.signal.aborted) throw new DOMException("TTS request cancelled", "AbortError");
      if (timeout.didTimeout()) throw new VoiceProviderError("Fish Audio 首个音频分片超时。", "timeout", true);
      throw error;
    } finally {
      timeout.dispose();
    }
  }
}
