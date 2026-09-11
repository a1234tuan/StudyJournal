import type { AiSecret } from "../../types";
import { createAsyncQueue } from "./asyncQueue";
import type { VoiceSocket, VoiceSocketFactory } from "./aliyunAsrTransport";
import type { AsrStreamEvent } from "./contracts";
import {
  buildDoubaoAsrAudioFrame,
  buildDoubaoAsrStartFrame,
  isDoubaoAsrErrorFrame,
  isDoubaoAsrResultFrame,
  parseDoubaoAsrFrame,
} from "./doubaoAsrProtocol";
import type { VoiceAsrTransport, VoiceAsrTransportSession } from "./transportAsrAdapter";

const DEFAULT_ENDPOINT = "wss://openspeech.bytedance.com/api/v3/sauc/bigmodel";

const frameBytes = (value: unknown): Uint8Array => {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  throw new Error("豆包 ASR 返回了无法识别的数据帧。");
};

const responseMessage = (payload: Uint8Array) => {
  const text = new TextDecoder().decode(payload);
  try {
    const parsed = JSON.parse(text) as { message?: string };
    return parsed.message?.trim() || text.trim();
  } catch {
    return text.trim();
  }
};

export const doubaoAsrHeaders = (secret: Pick<AiSecret, "apiKey" | "apiKeySecondary">, resourceId: string, requestId: string) => ({
  ...(secret.apiKeySecondary?.trim()
    ? { "X-Api-App-Key": secret.apiKey.trim(), "X-Api-Access-Key": secret.apiKeySecondary.trim() }
    : { "X-Api-Key": secret.apiKey.trim() }),
  "X-Api-Resource-Id": resourceId,
  "X-Api-Request-Id": requestId,
  "X-Api-Connect-Id": requestId,
  "X-Api-Sequence": "-1",
});

export const createDoubaoAsrTransport = (options: {
  secret: Pick<AiSecret, "apiKey" | "apiKeySecondary">;
  socketFactory: VoiceSocketFactory;
  openTimeoutMs?: number;
  finalTimeoutMs?: number;
}): VoiceAsrTransport => ({
  open: async ({ profile, operationId, language, format, signal }): Promise<VoiceAsrTransportSession> => {
    if (signal.aborted) throw new DOMException("ASR cancelled", "AbortError");
    const requestId = operationId || crypto.randomUUID();
    const resourceId = profile.resourceId?.trim();
    if (!resourceId) throw new Error("豆包 ASR 缺少 Resource ID。");
    const socket: VoiceSocket = options.socketFactory(
      profile.endpoint || DEFAULT_ENDPOINT,
      doubaoAsrHeaders(options.secret, resourceId, requestId),
    );
    const queue = createAsyncQueue<AsrStreamEvent>();
    let closed = false;
    let completed = false;
    let lastText = "";
    let lastFinalText = "";
    let timer: ReturnType<typeof setTimeout>;
    let resolveStarted!: () => void;
    let rejectStarted!: (error: unknown) => void;
    const started = new Promise<void>((resolve, reject) => { resolveStarted = resolve; rejectStarted = reject; });
    let receiveTail = Promise.resolve();

    const close = () => {
      if (closed) return;
      closed = true;
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      queue.close();
      try { socket.close(); } catch { }
    };
    const fail = (error: unknown) => {
      if (closed) return;
      queue.fail(error);
      rejectStarted(error);
      close();
    };
    const abort = () => fail(new DOMException("ASR cancelled", "AbortError"));
    const deadline = (milliseconds: number) => {
      clearTimeout(timer);
      timer = setTimeout(() => fail(new Error("豆包语音识别等待超时，请重试。")), milliseconds);
    };

    signal.addEventListener("abort", abort, { once: true });
    deadline(options.openTimeoutMs ?? 10_000);
    socket.onopen = () => {
      if (closed) return;
      Promise.resolve(socket.send(buildDoubaoAsrStartFrame({
        requestId,
        sampleRate: format.sampleRate,
        language,
        model: profile.model,
        punctuation: profile.punctuation,
        inverseTextNormalization: profile.inverseTextNormalization,
        disfluencyRemoval: profile.recognitionOptions?.disfluencyRemovalEnabled,
      }))).then(() => {
        if (closed) return;
        clearTimeout(timer);
        resolveStarted();
      }).catch(fail);
    };
    socket.onmessage = (event) => {
      receiveTail = receiveTail.then(async () => {
        if (closed) return;
        const parsed = await parseDoubaoAsrFrame(frameBytes(event.data));
        if (isDoubaoAsrErrorFrame(parsed)) {
          throw new Error(`豆包 ASR 请求失败（${parsed.errorCode ?? "未知错误"}）：${responseMessage(parsed.payload)}`);
        }
        if (!isDoubaoAsrResultFrame(parsed)) return;
        const payload = JSON.parse(new TextDecoder().decode(parsed.payload)) as {
          code?: number;
          message?: string;
          audio_info?: { duration?: number };
          result?: { text?: string; utterances?: Array<{ definite?: boolean }> };
        };
        if (payload.code && payload.code !== 20_000_000) throw new Error(`豆包 ASR 请求失败（${payload.code}）：${payload.message || "未知错误"}`);
        const text = payload.result?.text?.trim() ?? "";
        const usageSeconds = payload.audio_info?.duration !== undefined ? payload.audio_info.duration / 1000 : undefined;
        const definite = payload.result?.utterances?.some((utterance) => utterance.definite) ?? false;
        if (text && text !== lastText) {
          lastText = text;
          if (definite || parsed.final) {
            lastFinalText = text;
            queue.push({ type: "final", text, cumulative: true, ...(usageSeconds !== undefined ? { usageSeconds } : {}) });
          } else {
            queue.push({ type: "partial", text });
          }
        } else if (parsed.final && text && text !== lastFinalText) {
          lastFinalText = text;
          queue.push({ type: "final", text, cumulative: true, ...(usageSeconds !== undefined ? { usageSeconds } : {}) });
        }
        if (parsed.final) {
          completed = true;
          queue.push({ type: "completed", ...(usageSeconds !== undefined ? { usageSeconds } : {}) });
          close();
        }
      }).catch(fail);
    };
    socket.onerror = () => fail(new Error("豆包语音识别连接失败，请检查凭据与网络。"));
    socket.onclose = () => { if (!completed) fail(new Error("豆包语音识别连接提前关闭。")); };
    await started;

    return {
      events: queue,
      send: async (frame) => {
        if (frame.format.encoding !== "pcm-s16le" || frame.format.sampleRate !== format.sampleRate || frame.format.channelCount !== 1 || frame.data.byteLength % 2 !== 0) {
          const error = new Error("实际采集音频与豆包 ASR 请求格式不一致");
          fail(error);
          throw error;
        }
        if (signal.aborted || closed) throw new DOMException("ASR cancelled", "AbortError");
        try { await socket.send(buildDoubaoAsrAudioFrame(frame.data)); } catch (error) { fail(error); throw error; }
      },
      finish: async () => {
        if (closed) throw new Error("豆包语音识别连接已关闭");
        deadline(options.finalTimeoutMs ?? 30_000);
        try { await socket.send(buildDoubaoAsrAudioFrame(new Uint8Array(0), true)); } catch (error) { fail(error); throw error; }
      },
      close: async () => { if (!completed) fail(new DOMException("ASR cancelled", "AbortError")); else close(); },
    };
  },
});
