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
}): VoiceAsrTransport => ({
  open: async ({ profile, turnId, signal }): Promise<VoiceAsrTransportSession> => {
    if (signal.aborted) throw new DOMException("ASR cancelled", "AbortError");
    const socket = (options.socketFactory ?? defaultSocketFactory)(profile.endpoint || DEFAULT_ALIYUN_ASR_ENDPOINT, {
      Authorization: "bearer " + options.apiKey.trim().replace(/^Bearer\s+/i, ""),
    });
    const queue = createAsyncQueue<AsrStreamEvent>();
    const sentences = new Map<string, string>();
    let closed = false;
    let completed = false;
    let taskStarted = false;
    let timer: ReturnType<typeof setTimeout>;
    let resolveStarted: () => void;
    let rejectStarted: (error: unknown) => void;
    const started = new Promise<void>((resolve, reject) => { resolveStarted = resolve; rejectStarted = reject; });
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
      timer = setTimeout(() => fail(new Error("语音识别等待超时，请重试。")), milliseconds);
    };
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    else deadline(options.openTimeoutMs ?? 10_000);
    socket.onopen = () => {
      if (closed) return;
      deadline(options.openTimeoutMs ?? 10_000);
      Promise.resolve().then(() => {
        if (!closed) return socket.send(buildAliyunRunTask(turnId, { ...DEFAULT_ALIYUN_ASR_CONFIG, model: profile.model ?? DEFAULT_ALIYUN_ASR_CONFIG.model, ...options.config }));
      }).catch(fail);
    };
    socket.onmessage = (event) => {
      if (closed) return;
      const parsed = parseAliyunAsrMessage(typeof event.data === "string" ? event.data : new TextDecoder().decode(event.data as ArrayBuffer));
      if (parsed.type === "started" && !taskStarted) { taskStarted = true; clearTimeout(timer); resolveStarted(); }
      if (parsed.type === "partial") queue.push({ type: "partial", text: [...sentences.values()].join("") + parsed.text });
      if (parsed.type === "final") {
        sentences.set(parsed.segmentId ?? parsed.text, parsed.text);
        queue.push({ type: "final", text: [...sentences.values()].join(""), cumulative: true, ...(parsed.usageSeconds !== undefined ? { usageSeconds: parsed.usageSeconds } : {}) });
      }
      if (parsed.type === "failed") fail(new Error(parsed.message));
      if (parsed.type === "completed" && !taskStarted) { fail(new Error("语音识别协议顺序异常")); return; }
      if (parsed.type === "completed") { completed = true; queue.push({ type: "completed" }); close(); }
    };
    socket.onerror = () => fail(new Error("语音识别连接失败，请检查凭据与网络。"));
    socket.onclose = () => { if (!completed) fail(new Error("语音识别连接提前关闭。")); };
    await started;
    return {
      events: queue,
      send: async (frame) => {
        if (signal.aborted || closed) throw new DOMException("ASR cancelled", "AbortError");
        try { await socket.send(frame.data); } catch (error) { fail(error); throw error; }
      },
      finish: async () => {
        if (closed) throw new Error("语音识别连接已关闭");
        deadline(options.finalTimeoutMs ?? 30_000);
        try { await socket.send(buildAliyunFinishTask(turnId)); } catch (error) { fail(error); throw error; }
      },
      close: async () => { if (!completed) fail(new DOMException("ASR cancelled", "AbortError")); else close(); },
    };
  },
});
