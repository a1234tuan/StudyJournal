import { describe, expect, it, vi } from "vitest";

import type { VoiceAudioFrame } from "./contracts";
import type { AsrProviderProfile } from "./providerProfiles";
import type { VoiceSocket } from "./aliyunAsrTransport";
import { createAliyunNlsAsrTransport } from "./aliyunNlsAsrTransport";

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
  id: "voice-asr-aliyun-nls-shiyinshi-v1",
  providerId: "aliyun-nls",
  providerName: "阿里云 识音石 V1 实时 ASR",
  endpoint: "wss://nls-gateway-cn-shanghai.aliyuncs.com/ws/v1",
  transport: "websocket",
  language: "zh-CN",
  acceptedSampleRates: [16_000],
  acceptedFormats: ["pcm-s16le"],
  punctuation: true,
  inverseTextNormalization: true,
  browserDirectSupported: true,
};

const frame = (): VoiceAudioFrame => ({
  sequence: 0,
  capturedAtMonotonicMs: 0,
  format: { encoding: "pcm-s16le", sampleRate: 16_000, channelCount: 1 },
  data: new Uint8Array([1, 2, 3, 4]),
});

const openSession = async (overrides: { completionGraceMs?: number } = {}) => {
  const sockets: FakeSocket[] = [];
  let id = 0;
  const transport = createAliyunNlsAsrTransport({
    appKey: "project-app-key",
    accessToken: "temporary-token",
    completionGraceMs: overrides.completionGraceMs,
    idFactory: () => (++id).toString(16).padStart(32, "0"),
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
  socket.onmessage?.({ data: JSON.stringify({ header: { name: "TranscriptionStarted", status: 20_000_000 } }) });
  return { session: await opened, socket, controller };
};

describe("Aliyun NLS ASR transport", () => {
  it("authenticates in the URL and sends StartTranscription before audio", async () => {
    const { session, socket } = await openSession();
    const url = new URL(socket.url);
    expect(url.origin + url.pathname).toBe(profile.endpoint);
    expect(url.searchParams.get("token")).toBe("temporary-token");
    expect(socket.headers).toEqual({});
    const start = JSON.parse(socket.sent[0] as string);
    expect(start.header).toMatchObject({ name: "StartTranscription", appkey: "project-app-key" });
    expect(start.header.task_id).toMatch(/^[0-9a-f]{32}$/);
    await session.close();
  });

  it("streams PCM and accumulates final sentences", async () => {
    const { session, socket } = await openSession();
    await session.send(frame());
    expect(socket.sent[1]).toBeInstanceOf(Uint8Array);
    const iterator = session.events[Symbol.asyncIterator]();
    socket.onmessage?.({ data: JSON.stringify({ header: { name: "TranscriptionResultChanged", status: 20_000_000 }, payload: { index: 1, result: "第一句" } }) });
    await expect(iterator.next()).resolves.toEqual({ done: false, value: { type: "partial", text: "第一句" } });
    socket.onmessage?.({ data: JSON.stringify({ header: { name: "SentenceEnd", status: 20_000_000 }, payload: { index: 1, result: "第一句。" } }) });
    await expect(iterator.next()).resolves.toEqual({ done: false, value: { type: "final", text: "第一句。", cumulative: true } });
    socket.onmessage?.({ data: JSON.stringify({ header: { name: "SentenceEnd", status: 20_000_000 }, payload: { index: 2, result: "第二句。" } }) });
    await expect(iterator.next()).resolves.toEqual({ done: false, value: { type: "final", text: "第一句。第二句。", cumulative: true } });
    socket.onmessage?.({ data: JSON.stringify({ header: { name: "TranscriptionCompleted", status: 20_000_000 } }) });
    await expect(iterator.next()).resolves.toEqual({ done: false, value: { type: "completed" } });
    await expect(iterator.next()).resolves.toEqual({ done: true, value: undefined });
  });

  it("sends StopTranscription and recovers when the completion event is lost", async () => {
    vi.useFakeTimers();
    try {
      const { session, socket } = await openSession({ completionGraceMs: 1_500 });
      const iterator = session.events[Symbol.asyncIterator]();
      socket.onmessage?.({ data: JSON.stringify({ header: { name: "SentenceEnd", status: 20_000_000 }, payload: { index: 1, result: "识别完成。" } }) });
      await iterator.next();
      await session.finish();
      expect(JSON.parse(socket.sent.at(-1) as string).header.name).toBe("StopTranscription");
      const completion = iterator.next();
      await vi.advanceTimersByTimeAsync(1_501);
      await expect(completion).resolves.toEqual({ done: false, value: { type: "completed" } });
      expect(socket.readyState).toBe(3);
    } finally { vi.useRealTimers(); }
  });

  it("surfaces provider task failures", async () => {
    const { session, socket } = await openSession();
    const failure = session.events[Symbol.asyncIterator]().next();
    socket.onmessage?.({ data: JSON.stringify({ header: { name: "TaskFailed", status: 40_000_004, status_text: "invalid token" } }) });
    await expect(failure).rejects.toThrow("invalid token");
    expect(socket.readyState).toBe(3);
  });
});
