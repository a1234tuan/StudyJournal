import { describe, expect, it, vi } from "vitest";

import { createAliyunAsrTransport } from "./aliyunAsrTransport";
import { createDesktopVoiceSocketFactory, type DesktopVoiceAsrBridge, type DesktopVoiceAsrEvent } from "./desktopVoiceSocket";
import type { AsrProviderProfile } from "./providerProfiles";

const createFakeBridge = () => {
  const listeners = new Set<(payload: DesktopVoiceAsrEvent) => void>();
  const sent: Array<{ sessionId: string; data: Uint8Array }> = [];
  const opened: Array<{ url: string; headers: Record<string, string> }> = [];
  let resolveOpen: ((value: { sessionId: string }) => void) | undefined;
  let sequence = 0;
  const bridge: DesktopVoiceAsrBridge = {
    open: vi.fn((options: { url: string; headers: Record<string, string> }) => {
      opened.push(options);
      return new Promise<{ sessionId: string }>((resolve) => { resolveOpen = resolve; });
    }),
    send: vi.fn(async (sessionId, data) => { sent.push({ sessionId, data }); return { sent: true }; }),
    close: vi.fn(async () => ({ closed: true })),
    onEvent: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  const emit = (payload: DesktopVoiceAsrEvent) => { for (const listener of listeners) listener(payload); };
  const completeOpen = () => {
    sequence += 1;
    const sessionId = `session-${sequence}`;
    resolveOpen?.({ sessionId });
    return sessionId;
  };
  return { bridge, emit, completeOpen, sent, opened };
};

const profile: AsrProviderProfile = {
  id: "voice-asr-aliyun-paraformer",
  providerId: "aliyun-bailian",
  providerName: "阿里云 Paraformer 实时 ASR",
  endpoint: "wss://dashscope.aliyuncs.com/api-ws/v1/inference",
  transport: "websocket",
  model: "paraformer-realtime-v2",
  language: "zh-CN",
  acceptedSampleRates: [16_000],
  acceptedFormats: ["pcm-s16le"],
  punctuation: true,
  inverseTextNormalization: true,
  browserDirectSupported: false,
};

const format = { encoding: "pcm-s16le" as const, sampleRate: 16_000, channelCount: 1 as const };

describe("desktop voice socket", () => {
  it("buffers events that arrive before the session id is known, then forwards them", async () => {
    const { bridge, emit, completeOpen, sent, opened } = createFakeBridge();
    const socket = createDesktopVoiceSocketFactory(bridge)("wss://example/ws", { Authorization: "bearer k" });
    const onOpen = vi.fn();
    const onMessage = vi.fn();
    socket.onopen = onOpen;
    socket.onmessage = onMessage;

    expect(opened[0]).toEqual({ url: "wss://example/ws", headers: { Authorization: "bearer k" } });
    emit({ sessionId: "session-1", kind: "open" });
    expect(onOpen).not.toHaveBeenCalled();

    const sessionId = completeOpen();
    await vi.waitFor(() => expect(onOpen).toHaveBeenCalledTimes(1));
    expect(socket.readyState).toBe(1);

    socket.send(new Uint8Array([1, 2, 3]));
    await vi.waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]).toEqual({ sessionId, data: new Uint8Array([1, 2, 3]) });

    emit({ sessionId, kind: "message", data: new Uint8Array([9]) });
    expect(onMessage).toHaveBeenCalledWith({ data: new Uint8Array([9]) });

    const onClose = vi.fn();
    socket.onclose = onClose;
    emit({ sessionId, kind: "close", code: 1000 });
    expect(onClose).toHaveBeenCalledWith({ code: 1000, reason: undefined });
    expect(socket.readyState).toBe(3);
  });

  it("drives a complete Aliyun session through the main-process proxy", async () => {
    const { bridge, emit, completeOpen, sent } = createFakeBridge();
    const transport = createAliyunAsrTransport({ apiKey: "key", socketFactory: createDesktopVoiceSocketFactory(bridge) });
    const controller = new AbortController();
    const opened = transport.open({
      profile,
      sessionId: "s",
      turnId: "turn-1",
      operationId: "o",
      language: "zh-CN",
      format,
      signal: controller.signal,
    });

    const sessionId = completeOpen();
    emit({ sessionId, kind: "open" });
    await vi.waitFor(() => expect(sent.length).toBeGreaterThan(0));
    expect(JSON.parse(new TextDecoder().decode(sent[0].data)).header).toEqual({ action: "run-task", task_id: "turn-1", streaming: "duplex" });

    emit({ sessionId, kind: "message", data: new TextEncoder().encode(JSON.stringify({ header: { event: "task-started" } })) });
    const session = await opened;

    await session.send({ sequence: 0, capturedAtMonotonicMs: 0, format, data: new Uint8Array([1, 2]) });
    await vi.waitFor(() => expect(sent).toHaveLength(2));

    const iterator = session.events[Symbol.asyncIterator]();
    emit({ sessionId, kind: "message", data: new TextEncoder().encode(JSON.stringify({ header: { event: "result-generated" }, payload: { output: { sentence: { text: "间隔复习", sentence_end: true } } } })) });
    await expect(iterator.next()).resolves.toEqual({ done: false, value: { type: "final", text: "间隔复习" } });

    emit({ sessionId, kind: "message", data: new TextEncoder().encode(JSON.stringify({ header: { event: "task-finished" } })) });
    await expect(iterator.next()).resolves.toEqual({ done: false, value: { type: "completed" } });
    await session.close();
  });
});
