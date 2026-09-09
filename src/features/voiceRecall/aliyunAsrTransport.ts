import type { AsrStreamEvent } from "./contracts";
import {
  buildAliyunFinishTask,
  buildAliyunRunTask,
  DEFAULT_ALIYUN_ASR_CONFIG,
  parseAliyunAsrMessage,
  type AliyunAsrSessionConfig,
} from "./aliyunAsrProtocol";
import type { VoiceAsrTransport, VoiceAsrTransportSession } from "./transportAsrAdapter";

export const DEFAULT_ALIYUN_ASR_ENDPOINT = "wss://dashscope.aliyuncs.com/api-ws/v1/inference";

export interface VoiceSocket {
  readyState: number;
  send(data: string | Uint8Array): void;
  close(): void;
  onopen: ((event: unknown) => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onerror: ((event: unknown) => void) | null;
  onclose: ((event: { code?: number; reason?: string }) => void) | null;
}

export type VoiceSocketFactory = (url: string, headers: Record<string, string>) => VoiceSocket;

/** Node/Electron expose a headers-aware WebSocket constructor; browsers do not,
 * which is why the web platform never builds this transport. */
const defaultSocketFactory: VoiceSocketFactory = (url, headers) => {
  const Ctor = WebSocket as unknown as new (url: string, options: { headers: Record<string, string> }) => VoiceSocket;
  return new Ctor(url, { headers });
};

class EventQueue<T> {
  private values: T[] = [];
  private waiters: Array<(result: IteratorResult<T>) => void> = [];
  private closed = false;

  push(value: T) {
    const waiter = this.waiters.shift();
    if (waiter) waiter({ done: false, value });
    else this.values.push(value);
  }

  close() {
    this.closed = true;
    for (const waiter of this.waiters.splice(0)) waiter({ done: true, value: undefined as never });
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: () => {
        const value = this.values.shift();
        if (value !== undefined) return Promise.resolve({ done: false, value });
        if (this.closed) return Promise.resolve({ done: true, value: undefined as never });
        return new Promise((resolve) => this.waiters.push(resolve));
      },
    };
  }
}

export const createAliyunAsrTransport = (options: {
  apiKey: string;
  socketFactory?: VoiceSocketFactory;
  config?: Partial<AliyunAsrSessionConfig>;
  openTimeoutMs?: number;
}): VoiceAsrTransport => {
  const socketFactory = options.socketFactory ?? defaultSocketFactory;
  const config: AliyunAsrSessionConfig = { ...DEFAULT_ALIYUN_ASR_CONFIG, ...options.config };

  return {
    open: async ({ profile, turnId, signal }): Promise<VoiceAsrTransportSession> => {
      if (signal.aborted) throw new DOMException("ASR cancelled", "AbortError");
      const endpoint = profile.endpoint || DEFAULT_ALIYUN_ASR_ENDPOINT;
      const socket = socketFactory(endpoint, {
        Authorization: `bearer ${options.apiKey.trim().replace(/^Bearer\s+/i, "")}`,
      });
      const queue = new EventQueue<AsrStreamEvent>();
      let closed = false;
      const closeSocket = () => {
        if (closed) return;
        closed = true;
        queue.close();
        try { socket.close(); } catch { /* already closed */ }
      };
      signal.addEventListener("abort", closeSocket, { once: true });

      const started = new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("阿里云语音识别连接超时。")), options.openTimeoutMs ?? 10_000);
        socket.onopen = () => {
          clearTimeout(timer);
          socket.send(buildAliyunRunTask(turnId, config));
        };
        socket.onmessage = (event) => {
          const raw = typeof event.data === "string" ? event.data : new TextDecoder().decode(event.data as ArrayBuffer);
          const parsed = parseAliyunAsrMessage(raw);
          switch (parsed.type) {
            case "started":
              clearTimeout(timer);
              resolve();
              return;
            case "partial":
              queue.push({ type: "partial", text: parsed.text });
              return;
            case "final":
              queue.push({ type: "final", text: parsed.text });
              return;
            case "completed":
              queue.push({ type: "completed" });
              closeSocket();
              return;
            case "failed":
              clearTimeout(timer);
              reject(new Error(parsed.message));
              closeSocket();
              return;
            default:
              return;
          }
        };
        socket.onerror = () => {
          clearTimeout(timer);
          reject(new Error("阿里云语音识别连接失败，请检查密钥与网络。"));
          closeSocket();
        };
        socket.onclose = (event) => {
          clearTimeout(timer);
          queue.close();
          if (event?.code && event.code !== 1000 && !closed) {
            reject(new Error(`阿里云语音识别连接中断（${event.code}）。`));
          }
        };
      });

      await started;

      return {
        events: queue,
        send: async (frame) => {
          if (signal.aborted) throw new DOMException("ASR cancelled", "AbortError");
          socket.send(frame.data);
        },
        finish: async () => { socket.send(buildAliyunFinishTask(turnId)); },
        close: async () => { closeSocket(); },
      };
    },
  };
};
