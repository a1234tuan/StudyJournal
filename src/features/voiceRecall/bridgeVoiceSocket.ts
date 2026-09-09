import type { VoiceSocket, VoiceSocketFactory } from "./aliyunAsrTransport";

/** A host bridge that owns a real WebSocket in a privileged process (Electron main
 * or an Android plugin) and relays frames to the renderer. */
export interface VoiceSocketBridge {
  open(options: { url: string; headers: Record<string, string> }): Promise<{ sessionId: string }>;
  send(sessionId: string, data: Uint8Array): Promise<unknown>;
  close(sessionId: string): Promise<unknown>;
  onEvent(listener: (payload: VoiceSocketBridgeEvent) => void): () => void;
}

export interface VoiceSocketBridgeEvent {
  sessionId: string;
  kind: "open" | "message" | "error" | "close";
  data?: Uint8Array;
  code?: number;
  reason?: string;
  message?: string;
}

/**
 * Adapts a host bridge to the `VoiceSocket` shape the ASR transports expect, so
 * `createAliyunAsrTransport` works unchanged on desktop and Android.
 */
export const createBridgeVoiceSocketFactory = (bridge: VoiceSocketBridge): VoiceSocketFactory =>
  (url, headers) => {
    const socket: VoiceSocket = {
      readyState: 0,
      onopen: null,
      onmessage: null,
      onerror: null,
      onclose: null,
      send: () => undefined,
      close: () => undefined,
    };
    let sessionId: string | undefined;
    let closed = false;
    let unsubscribe: (() => void) | undefined;
    const pending: VoiceSocketBridgeEvent[] = [];

    const dispatch = (payload: VoiceSocketBridgeEvent) => {
      if (closed) return;
      if (payload.kind === "open") {
        socket.readyState = 1;
        socket.onopen?.({});
        return;
      }
      if (payload.kind === "message") {
        socket.onmessage?.({ data: payload.data ?? new Uint8Array(0) });
        return;
      }
      if (payload.kind === "error") {
        socket.onerror?.({ message: payload.message });
        return;
      }
      closed = true;
      socket.readyState = 3;
      unsubscribe?.();
      socket.onclose?.({ code: payload.code, reason: payload.reason });
    };

    unsubscribe = bridge.onEvent((payload) => {
      // Events can arrive before open() resolves with the session id; buffer them.
      if (!sessionId) {
        pending.push(payload);
        return;
      }
      if (payload.sessionId !== sessionId) return;
      dispatch(payload);
    });

    socket.send = (data) => {
      if (!sessionId) return;
      // Control frames are strings (run-task / finish-task); audio frames are bytes.
      const bytes = typeof data === "string"
        ? new TextEncoder().encode(data)
        : data instanceof Uint8Array
          ? data
          : new Uint8Array(data as ArrayBuffer);
      void bridge.send(sessionId, bytes).catch(() => undefined);
    };
    socket.close = () => {
      if (!sessionId || closed) return;
      closed = true;
      void bridge.close(sessionId).catch(() => undefined);
      unsubscribe?.();
    };

    void bridge.open({ url, headers }).then(({ sessionId: id }) => {
      sessionId = id;
      for (const payload of pending.splice(0)) {
        if (payload.sessionId === sessionId) dispatch(payload);
      }
    }).catch((error: unknown) => {
      socket.onerror?.({ message: error instanceof Error ? error.message : "语音识别连接失败。" });
      closed = true;
      socket.readyState = 3;
      unsubscribe?.();
      socket.onclose?.({ code: 1006, reason: "bridge-open-failed" });
    });

    return socket;
  };
