import type { AsrStreamEvent } from "./contracts";
import type { VoiceAsrTransport, VoiceAsrTransportSession } from "./transportAsrAdapter";
import type { VoiceSocket, VoiceSocketFactory } from "./aliyunAsrTransport";
import {
  buildAliyunNlsStartTranscription,
  buildAliyunNlsStopTranscription,
  DEFAULT_ALIYUN_NLS_ASR_CONFIG,
  parseAliyunNlsAsrMessage,
  type AliyunNlsAsrSessionConfig,
} from "./aliyunNlsAsrProtocol";
import { createAsyncQueue } from "./asyncQueue";

const DEFAULT_ALIYUN_NLS_ASR_ENDPOINT = "wss://nls-gateway-cn-shanghai.aliyuncs.com/ws/v1";
const defaultSocketFactory: VoiceSocketFactory = (url) => new WebSocket(url) as unknown as VoiceSocket;
const randomProtocolId = (): string => crypto.randomUUID().replaceAll("-", "");

const authenticatedEndpoint = (endpoint: string, accessToken: string): string => {
  const url = new URL(endpoint || DEFAULT_ALIYUN_NLS_ASR_ENDPOINT);
  url.searchParams.set("token", accessToken.trim());
  return url.toString();
};

export const createAliyunNlsAsrTransport = (options: {
  appKey: string;
  accessToken: string;
  socketFactory?: VoiceSocketFactory;
  config?: Partial<AliyunNlsAsrSessionConfig>;
  openTimeoutMs?: number;
  finalTimeoutMs?: number;
  completionGraceMs?: number;
  idFactory?: () => string;
}): VoiceAsrTransport => ({
  open: async ({ profile, signal, format }): Promise<VoiceAsrTransportSession> => {
    if (signal.aborted) throw new DOMException("ASR cancelled", "AbortError");
    const makeId = options.idFactory ?? randomProtocolId;
    const taskId = makeId();
    const socket = (options.socketFactory ?? defaultSocketFactory)(
      authenticatedEndpoint(profile.endpoint, options.accessToken),
      {},
    );
    const queue = createAsyncQueue<AsrStreamEvent>();
    const sentences = new Map<string, string>();
    let closed = false;
    let completed = false;
    let startedTask = false;
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
      const sampleRate: 8_000 | 16_000 = format.sampleRate === 8_000 ? 8_000 : 16_000;
      const config = { ...DEFAULT_ALIYUN_NLS_ASR_CONFIG, ...options.config, sampleRate, format: "pcm" as const };
      Promise.resolve()
        .then(() => socket.send(buildAliyunNlsStartTranscription(taskId, makeId(), options.appKey.trim(), config)))
        .catch(fail);
    };
    socket.onmessage = (event) => {
      if (closed) return;
      const parsed = parseAliyunNlsAsrMessage(typeof event.data === "string" ? event.data : new TextDecoder().decode(event.data as ArrayBuffer));
      if (parsed.type === "started" && !startedTask) { startedTask = true; clearTimeout(timer); resolveStarted(); }
      if (parsed.type === "partial") {
        latestPartial = [...sentences.values()].join("") + parsed.text;
        queue.push({ type: "partial", text: latestPartial });
        scheduleCompletionFallback();
      }
      if (parsed.type === "final") {
        sentences.set(parsed.segmentId ?? parsed.text, parsed.text);
        latestPartial = "";
        queue.push({ type: "final", text: [...sentences.values()].join(""), cumulative: true });
        scheduleCompletionFallback();
      }
      if (parsed.type === "failed") fail(new Error(parsed.message));
      if (parsed.type === "completed" && !startedTask) { fail(new Error("语音识别协议顺序异常")); return; }
      if (parsed.type === "completed") complete();
    };
    socket.onerror = () => {
      if (finishRequested && (sentences.size > 0 || latestPartial.trim())) complete();
      else fail(new Error("语音识别连接失败，请检查 AppKey、Access Token 与网络。"));
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
        try { await socket.send(buildAliyunNlsStopTranscription(taskId, makeId(), options.appKey.trim())); } catch (error) { fail(error); throw error; }
        scheduleCompletionFallback();
      },
      close: async () => { if (!completed) fail(new DOMException("ASR cancelled", "AbortError")); else close(); },
    };
  },
});
