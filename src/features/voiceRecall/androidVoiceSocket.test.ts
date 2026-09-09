import { describe, expect, it, vi } from "vitest";

import { createAliyunAsrTransport } from "./aliyunAsrTransport";
import { createAndroidVoiceSocketFactory, type NativeVoiceAsrPlugin } from "./androidVoiceSocket";
import type { AsrProviderProfile } from "./providerProfiles";

type PluginEvent = { sessionId: string; kind: "open" | "message" | "error" | "close"; dataBase64?: string; code?: number; reason?: string; message?: string };

const createFakePlugin = () => {
  const listeners = new Set<(event: PluginEvent) => void>();
  const sent: Array<{ sessionId: string; kind: "text" | "binary"; text?: string; dataBase64?: string }> = [];
  let resolveOpen: ((value: { sessionId: string }) => void) | undefined;
  let sequence = 0;
  const plugin: NativeVoiceAsrPlugin = {
    open: vi.fn(() => new Promise<{ sessionId: string }>((resolve) => { resolveOpen = resolve; })),
    send: vi.fn(async (options) => { sent.push(options); return { sent: true }; }),
    close: vi.fn(async () => ({ closed: true })),
    addListener: vi.fn(async (_event, listener) => {
      listeners.add(listener);
      return { remove: async () => { listeners.delete(listener); } };
    }),
  };
  const emit = (event: PluginEvent) => { for (const listener of listeners) listener(event); };
  const completeOpen = () => {
    sequence += 1;
    const sessionId = `session-${sequence}`;
    resolveOpen?.({ sessionId });
    return sessionId;
  };
  return { plugin, emit, completeOpen, sent };
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

const decode = (value: string) => Uint8Array.from(atob(value), (char) => char.charCodeAt(0));
const toBase64 = (text: string) => btoa(String.fromCharCode(...new TextEncoder().encode(text)));

describe("android voice socket", () => {
  it("round-trips frames through the base64 bridge", async () => {
    const { plugin, emit, completeOpen, sent } = createFakePlugin();
    const socket = createAndroidVoiceSocketFactory(plugin)("wss://example/ws", { Authorization: "bearer k" });
    const onOpen = vi.fn();
    const onMessage = vi.fn();
    socket.onopen = onOpen;
    socket.onmessage = onMessage;
    // Capacitor's addListener resolves asynchronously; wait for registration.
    await vi.waitFor(() => expect(plugin.open).toHaveBeenCalled());

    const sessionId = completeOpen();
    emit({ sessionId, kind: "open" });
    await vi.waitFor(() => expect(onOpen).toHaveBeenCalledTimes(1));

    socket.send(new Uint8Array([1, 2, 250]));
    await vi.waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0].sessionId).toBe(sessionId);
    expect([...decode(sent[0].dataBase64!)]).toEqual([1, 2, 250]);

    emit({ sessionId, kind: "message", dataBase64: btoa(String.fromCharCode(9, 8)) });
    expect(onMessage).toHaveBeenCalledWith({ data: new Uint8Array([9, 8]) });
  });

  it("drives a complete Aliyun session through the Android plugin", async () => {
    const { plugin, emit, completeOpen, sent } = createFakePlugin();
    const transport = createAliyunAsrTransport({ apiKey: "key", socketFactory: createAndroidVoiceSocketFactory(plugin) });
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

    await vi.waitFor(() => expect(plugin.open).toHaveBeenCalled());
    const sessionId = completeOpen();
    emit({ sessionId, kind: "open" });
    await vi.waitFor(() => expect(sent.length).toBeGreaterThan(0));
    expect(sent[0].kind).toBe("text");
    expect(JSON.parse(sent[0].text!).header.action).toBe("run-task");

    emit({ sessionId, kind: "message", dataBase64: toBase64(JSON.stringify({ header: { event: "task-started" } })) });
    const session = await opened;

    await session.send({ sequence: 0, capturedAtMonotonicMs: 0, format, data: new Uint8Array([1, 2]) });
    await vi.waitFor(() => expect(sent).toHaveLength(2));

    const iterator = session.events[Symbol.asyncIterator]();
    emit({
      sessionId,
      kind: "message",
      dataBase64: toBase64(JSON.stringify({ header: { event: "result-generated" }, payload: { output: { sentence: { text: "间隔复习", sentence_end: true } } } })),
    });
    await expect(iterator.next()).resolves.toEqual({ done: false, value: { type: "final", text: "间隔复习", cumulative: true } });

    emit({ sessionId, kind: "message", dataBase64: toBase64(JSON.stringify({ header: { event: "task-finished" } })) });
    await expect(iterator.next()).resolves.toEqual({ done: false, value: { type: "completed" } });
    await session.close();
  });

  it("surfaces a native connection failure as a socket error", async () => {
    const { plugin, emit, completeOpen } = createFakePlugin();
    const socket = createAndroidVoiceSocketFactory(plugin)("wss://example/ws", {});
    const onError = vi.fn();
    socket.onerror = onError;
    await vi.waitFor(() => expect(plugin.open).toHaveBeenCalled());

    const sessionId = completeOpen();
    emit({ sessionId, kind: "error", message: "语音识别连接失败（HTTP 401）。" });
    await vi.waitFor(() => expect(onError).toHaveBeenCalledTimes(1));
  });
});
