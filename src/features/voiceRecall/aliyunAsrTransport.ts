import type { AsrStreamEvent } from "./contracts";
import type { VoiceAsrTransport, VoiceAsrTransportSession } from "./transportAsrAdapter";
import { buildAliyunRunTask, buildAliyunFinishTask, parseAliyunAsrMessage, DEFAULT_ALIYUN_ASR_CONFIG, type AliyunAsrSessionConfig } from "./aliyunAsrProtocol";
import { createAsyncQueue } from "./asyncQueue";

const DEFAULT_ALIYUN_ASR_ENDPOINT = "wss://dashscope.aliyuncs.com/api-ws/v1/inference";
export interface VoiceSocket {
  readyState: number;
  send(data: string | Uint8Array): void | Promise<void>;
  close(): void;
  onopen: ((event: unknown) => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onerror: ((event: unknown) => void) | null;
  onclose: ((event: { code?: number; reason?: string }) => void) | null;
}
export type VoiceSocketFactory = (url: string, headers: Record<string, string>) => VoiceSocket;
const defaultSocketFactory: VoiceSocketFactory = (url, headers) => {
  const Constructor = WebSocket as unknown as new (url: string, options: { headers: Record<string, string> }) => VoiceSocket;
  return new Constructor(url, { headers });
};
export const createAliyunAsrTransport = (options: {
  apiKey: string;
  socketFactory?: VoiceSocketFactory;
  config?: Partial<AliyunAsrSessionConfig>;
  openTimeoutMs?: number;
  finalTimeoutMs?: number;
  completionGraceMs?: number;
}): VoiceAsrTransport => ({
  open: async ({ profile, turnId, signal, format }): Promise<VoiceAsrTransportSession> => {
    if (signal.aborted) throw new DOMException("ASR cancelled", "AbortError");
    const socket = (options.socketFactory ?? defaultSocketFactory)(profile.endpoint || DEFAULT_ALIYUN_ASR_ENDPOINT, {
      Authorization: "bearer " + options.apiKey.trim().replace(/^Bearer\s+/i, ""),
    });
    const queue = createAsyncQueue<AsrStreamEvent>();
    const sentences = new Map<string, string>();
    let closed = false;
    let completed = false;
    let taskStarted = false;
    let finishRequested = false;
    let latestPartial = "";
    let timer: ReturnType<typeof setTimeout>;
    let completionTimer: ReturnType<typeof setTimeout>;
    let resolveStarted: () => void;
    let rejectStarted: (error: unknown) => void;
    const started = new Promise<void>((resolve, reject) => { resolveStarted = resolve; rejectStarted = reject; });
    const close = () => {
      if (closed) return;
      closed = true;
      clearTimeout(timer);
      clearTimeout(completionTimer);
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
      timer = setTimeout(() => fail(new Error("语音识别等待超时，请重试。")), milliseconds);
    };
    const complete = () => {
      if (closed || completed) return;
      const finalizedText = [...sentences.values()].join("");
      const partialText = latestPartial.trim();
      if (partialText && partialText !== finalizedText) {
        queue.push({ type: "final", text: partialText, cumulative: true });
      }
      completed = true;
      queue.push({ type: "completed" });
      close();
    };
    const scheduleCompletionFallback = () => {
      if (!finishRequested || (!sentences.size && !latestPartial.trim()) || closed) return;
      clearTimeout(completionTimer);
      completionTimer = setTimeout(complete, options.completionGraceMs ?? 1_500);
    };
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    else deadline(options.openTimeoutMs ?? 10_000);
    socket.onopen = () => {
      if (closed) return;
      deadline(options.openTimeoutMs ?? 10_000);
      Promise.resolve().then(() => {
        if (!closed) return socket.send(buildAliyunRunTask(turnId, { ...DEFAULT_ALIYUN_ASR_CONFIG, ...options.config, model: profile.model ?? DEFAULT_ALIYUN_ASR_CONFIG.model, sampleRate: format.sampleRate, format: "pcm" }));
      }).catch(fail);
    };
    socket.onmessage = (event) => {
      if (closed) return;
      const parsed = parseAliyunAsrMessage(typeof event.data === "string" ? event.data : new TextDecoder().decode(event.data as ArrayBuffer));
      if (parsed.type === "started" && !taskStarted) { taskStarted = true; clearTimeout(timer); resolveStarted(); }
      if (parsed.type === "partial") {
        latestPartial = [...sentences.values()].join("") + parsed.text;
        queue.push({ type: "partial", text: latestPartial });
        scheduleCompletionFallback();
      }
      if (parsed.type === "final") {
        sentences.set(parsed.segmentId ?? parsed.text, parsed.text);
        latestPartial = "";
        queue.push({ type: "final", text: [...sentences.values()].join(""), cumulative: true, ...(parsed.usageSeconds !== undefined ? { usageSeconds: parsed.usageSeconds } : {}) });
        scheduleCompletionFallback();
      }
      if (parsed.type === "failed") fail(new Error(parsed.message));
      if (parsed.type === "completed" && !taskStarted) { fail(new Error("语音识别协议顺序异常")); return; }
      if (parsed.type === "completed") complete();
    };
    socket.onerror = () => {
      if (finishRequested && (sentences.size > 0 || latestPartial.trim())) complete();
      else fail(new Error("语音识别连接失败，请检查凭据与网络。"));
    };
    socket.onclose = () => {
      if (!completed && finishRequested && (sentences.size > 0 || latestPartial.trim())) complete();
      else if (!completed) fail(new Error("语音识别连接提前关闭。"));
    };
    await started;
    return {
      events: queue,
      send: async (frame) => {
        if (frame.format.encoding !== "pcm-s16le" || frame.format.sampleRate !== format.sampleRate || frame.format.channelCount !== 1 || frame.data.byteLength % 2 !== 0) {
          const error = new Error("实际采集音频与 ASR 请求格式不一致");
          fail(error);
          throw error;
        }
        if (signal.aborted || closed) throw new DOMException("ASR cancelled", "AbortError");
        try { await socket.send(frame.data); } catch (error) { fail(error); throw error; }
      },
      finish: async () => {
        if (closed) throw new Error("语音识别连接已关闭");
        finishRequested = true;
        deadline(options.finalTimeoutMs ?? 12_000);
        try { await socket.send(buildAliyunFinishTask(turnId)); } catch (error) { fail(error); throw error; }
        scheduleCompletionFallback();
      },
      close: async () => { if (!completed) fail(new DOMException("ASR cancelled", "AbortError")); else close(); },
    };
  },
});
