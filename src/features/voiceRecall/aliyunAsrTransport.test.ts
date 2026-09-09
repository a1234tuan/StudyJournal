import { describe, expect, it } from "vitest";

import type { AsrStreamRequest, VoiceAudioFrame } from "./contracts";
import type { AsrProviderProfile } from "./providerProfiles";
import { createAliyunAsrTransport, type VoiceSocket } from "./aliyunAsrTransport";

class FakeSocket implements VoiceSocket {
  readyState = 0;
  sent: Array<string | Uint8Array> = [];
  url = "";
  headers: Record<string, string> = {};
  onopen: ((event: unknown) => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  onclose: ((event: { code?: number; reason?: string }) => void) | null = null;

  send(data: string | Uint8Array) { this.sent.push(data); }
  close() { this.readyState = 3; }
}

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

const frame = (sequence: number): VoiceAudioFrame => ({
  sequence,
  capturedAtMonotonicMs: sequence,
  format: { encoding: "pcm-s16le", sampleRate: 16_000, channelCount: 1 },
  data: new Uint8Array([1, 2, 3, 4]),
});

const request = (signal: AbortSignal): AsrStreamRequest => ({
  sessionId: "session-1",
  turnId: "turn-1",
  operationId: "operation-1",
  signal,
  language: "zh-CN",
  format: { encoding: "pcm-s16le", sampleRate: 16_000, channelCount: 1 },
  frames: (async function* () { yield frame(0); })(),
});

const openSession = async () => {
  const sockets: FakeSocket[] = [];
  const transport = createAliyunAsrTransport({
    apiKey: "test-key",
    socketFactory: (url, headers) => {
      const socket = new FakeSocket();
      socket.url = url;
      socket.headers = headers;
      sockets.push(socket);
      return socket;
    },
  });
  const controller = new AbortController();
  const opened = transport.open({
    profile,
    sessionId: "session-1",
    turnId: "turn-1",
    operationId: "operation-1",
    language: "zh-CN",
    format: { encoding: "pcm-s16le", sampleRate: 16_000, channelCount: 1 },
    signal: controller.signal,
  });
  const socket = sockets[0];
  socket.onopen?.({});
  socket.onmessage?.({ data: JSON.stringify({ header: { event: "task-started" } }) });
  return { session: await opened, socket, controller };
};

describe("Aliyun ASR transport", () => {
  it("authenticates with a bearer header and sends run-task before any audio", async () => {
    const { socket } = await openSession();
    expect(socket.url).toBe(profile.endpoint);
    expect(socket.headers.Authorization).toBe("bearer test-key");
    expect(JSON.parse(socket.sent[0] as string).header.action).toBe("run-task");
  });

  it("streams audio frames and maps server events to ASR events", async () => {
    const { session, socket } = await openSession();
    await session.send(frame(0));
    expect(socket.sent[1]).toBeInstanceOf(Uint8Array);

    const iterator = session.events[Symbol.asyncIterator]();
    socket.onmessage?.({ data: JSON.stringify({ header: { event: "result-generated" }, payload: { output: { sentence: { text: "间隔", sentence_end: false } } } }) });
    await expect(iterator.next()).resolves.toEqual({ done: false, value: { type: "partial", text: "间隔" } });

    socket.onmessage?.({ data: JSON.stringify({ header: { event: "result-generated" }, payload: { output: { sentence: { text: "间隔复习为什么有效？", sentence_end: true } } } }) });
    await expect(iterator.next()).resolves.toEqual({ done: false, value: { type: "final", text: "间隔复习为什么有效？" } });

    socket.onmessage?.({ data: JSON.stringify({ header: { event: "task-finished" } }) });
    await expect(iterator.next()).resolves.toEqual({ done: false, value: { type: "completed" } });
    await expect(iterator.next()).resolves.toEqual({ done: true, value: undefined });
  });

  it("sends finish-task and closes the socket on finish", async () => {
    const { session, socket } = await openSession();
    await session.finish();
    expect(JSON.parse(socket.sent.at(-1) as string).header.action).toBe("finish-task");
    await session.close();
    expect(socket.readyState).toBe(3);
  });

  it("rejects when the service reports a task failure", async () => {
    const sockets: FakeSocket[] = [];
    const transport = createAliyunAsrTransport({
      apiKey: "bad",
      socketFactory: () => { const socket = new FakeSocket(); sockets.push(socket); return socket; },
    });
    const opened = transport.open({
      profile,
      sessionId: "s",
      turnId: "t",
      operationId: "o",
      language: "zh-CN",
      format: { encoding: "pcm-s16le", sampleRate: 16_000, channelCount: 1 },
      signal: new AbortController().signal,
    });
    const socket = sockets[0];
    socket.onopen?.({});
    socket.onmessage?.({ data: JSON.stringify({ header: { event: "task-failed", error_message: "invalid api key" } }) });
    await expect(opened).rejects.toThrow("invalid api key");
  });

  it("does not open a socket when the request was already cancelled", async () => {
    const transport = createAliyunAsrTransport({ apiKey: "k", socketFactory: () => { throw new Error("should not open"); } });
    const controller = new AbortController();
    controller.abort();
    await expect(transport.open({
      profile,
      sessionId: "s",
      turnId: "t",
      operationId: "o",
      language: "zh-CN",
      format: { encoding: "pcm-s16le", sampleRate: 16_000, channelCount: 1 },
      signal: controller.signal,
    })).rejects.toThrow();
  });
});
