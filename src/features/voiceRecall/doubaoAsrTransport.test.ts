import { describe, expect, it, vi } from "vitest";

import type { VoiceSocket } from "./aliyunAsrTransport";
import type { VoiceAudioFrame } from "./contracts";
import { createDoubaoAsrTransport, doubaoAsrHeaders } from "./doubaoAsrTransport";
import type { AsrProviderProfile } from "./providerProfiles";

class FakeSocket implements VoiceSocket {
  readyState = 0;
  sent: Array<string | Uint8Array> = [];
  onopen: ((event: unknown) => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  onclose: ((event: { code?: number; reason?: string }) => void) | null = null;
  send(data: string | Uint8Array) { this.sent.push(data); }
  close() { this.readyState = 3; }
}

const profile: AsrProviderProfile = {
  id: "voice-asr-doubao-seed-streaming",
  providerId: "doubao",
  providerName: "豆包流式语音识别 2.0",
  endpoint: "wss://openspeech.bytedance.com/api/v3/sauc/bigmodel",
  transport: "websocket",
  model: "bigmodel",
  resourceId: "volc.seedasr.sauc.duration",
  language: "zh-CN",
  acceptedSampleRates: [16_000],
  acceptedFormats: ["pcm-s16le"],
  punctuation: true,
  inverseTextNormalization: true,
  browserDirectSupported: false,
};

const serverFrame = (payload: object, final = false) => {
  const body = new TextEncoder().encode(JSON.stringify(payload));
  const frame = new Uint8Array(12 + body.byteLength);
  frame.set([0x11, final ? 0x93 : 0x91, 0x10, 0x00]);
  new DataView(frame.buffer).setInt32(4, final ? -1 : 1, false);
  new DataView(frame.buffer).setUint32(8, body.byteLength, false);
  frame.set(body, 12);
  return frame;
};

const audioFrame: VoiceAudioFrame = {
  sequence: 0,
  capturedAtMonotonicMs: 1,
  format: { encoding: "pcm-s16le", sampleRate: 16_000, channelCount: 1 },
  data: new Uint8Array([1, 2, 3, 4]),
};

describe("Doubao ASR transport", () => {
  it("supports new API-key and legacy App-ID credential headers", () => {
    expect(doubaoAsrHeaders({ apiKey: "new-key" }, "resource", "request")).toMatchObject({
      "X-Api-Key": "new-key",
      "X-Api-Resource-Id": "resource",
    });
    expect(doubaoAsrHeaders({ apiKey: "app-id", apiKeySecondary: "access-token" }, "resource", "request")).toMatchObject({
      "X-Api-App-Key": "app-id",
      "X-Api-Access-Key": "access-token",
    });
  });

  it("sends SAUC frames and maps cumulative partial/final results", async () => {
    const sockets: FakeSocket[] = [];
    let headers: Record<string, string> = {};
    const transport = createDoubaoAsrTransport({
      secret: { apiKey: "new-key" },
      socketFactory: (_url, nextHeaders) => {
        headers = nextHeaders;
        const socket = new FakeSocket();
        sockets.push(socket);
        return socket;
      },
    });
    const controller = new AbortController();
    const opened = transport.open({
      profile,
      sessionId: "session",
      turnId: "turn",
      operationId: "operation",
      language: "zh-CN",
      format: audioFrame.format,
      signal: controller.signal,
    });
    const socket = sockets[0];
    socket.onopen?.({});
    const session = await opened;
    expect(headers["X-Api-Resource-Id"]).toBe("volc.seedasr.sauc.duration");
    expect((socket.sent[0] as Uint8Array)[1]).toBe(0x10);

    await session.send(audioFrame);
    expect((socket.sent[1] as Uint8Array)[1]).toBe(0x20);
    const iterator = session.events[Symbol.asyncIterator]();
    socket.onmessage?.({ data: serverFrame({ result: { text: "间隔复习" }, audio_info: { duration: 500 } }) });
    await expect(iterator.next()).resolves.toEqual({ done: false, value: { type: "partial", text: "间隔复习" } });

    await session.finish();
    expect((socket.sent.at(-1) as Uint8Array)[1]).toBe(0x22);
    socket.onmessage?.({ data: serverFrame({ result: { text: "间隔复习。", utterances: [{ definite: true }] }, audio_info: { duration: 1200 } }, true) });
    await expect(iterator.next()).resolves.toEqual({ done: false, value: { type: "final", text: "间隔复习。", cumulative: true, usageSeconds: 1.2 } });
    await expect(iterator.next()).resolves.toEqual({ done: false, value: { type: "completed", usageSeconds: 1.2 } });
    await expect(iterator.next()).resolves.toEqual({ done: true, value: undefined });
  });

  it("finishes from recognized text when the terminal SAUC frame is lost", async () => {
    vi.useFakeTimers();
    try {
      const sockets: FakeSocket[] = [];
      const transport = createDoubaoAsrTransport({
        secret: { apiKey: "new-key" },
        completionGraceMs: 1_500,
        socketFactory: () => { const socket = new FakeSocket(); sockets.push(socket); return socket; },
      });
      const opened = transport.open({
        profile,
        sessionId: "session",
        turnId: "turn",
        operationId: "operation",
        language: "zh-CN",
        format: audioFrame.format,
        signal: new AbortController().signal,
      });
      const socket = sockets[0];
      socket.onopen?.({});
      const session = await opened;
      const iterator = session.events[Symbol.asyncIterator]();
      socket.onmessage?.({ data: serverFrame({ result: { text: "豆包已有转写", utterances: [{ definite: true }] } }) });
      await expect(iterator.next()).resolves.toMatchObject({ done: false, value: { type: "final", text: "豆包已有转写" } });
      await session.finish();
      const completion = iterator.next();
      await vi.advanceTimersByTimeAsync(1_501);
      await expect(completion).resolves.toEqual({ done: false, value: { type: "completed" } });
      expect(socket.readyState).toBe(3);
    } finally { vi.useRealTimers(); }
  });

  it("promotes a partial when the provider closes after finish", async () => {
    const sockets: FakeSocket[] = [];
    const transport = createDoubaoAsrTransport({
      secret: { apiKey: "new-key" },
      socketFactory: () => { const socket = new FakeSocket(); sockets.push(socket); return socket; },
    });
    const opened = transport.open({
      profile,
      sessionId: "session",
      turnId: "turn",
      operationId: "operation",
      language: "zh-CN",
      format: audioFrame.format,
      signal: new AbortController().signal,
    });
    const socket = sockets[0];
    socket.onopen?.({});
    const session = await opened;
    const iterator = session.events[Symbol.asyncIterator]();
    socket.onmessage?.({ data: serverFrame({ result: { text: "第二轮已有转写" } }) });
    await iterator.next();
    await session.finish();
    socket.onclose?.({ code: 1000, reason: "provider-finished" });
    await expect(iterator.next()).resolves.toEqual({ done: false, value: { type: "final", text: "第二轮已有转写", cumulative: true } });
    await expect(iterator.next()).resolves.toEqual({ done: false, value: { type: "completed" } });
  });

  it("keeps a trailing partial after an earlier definite result", async () => {
    const sockets: FakeSocket[] = [];
    const transport = createDoubaoAsrTransport({
      secret: { apiKey: "new-key" },
      socketFactory: () => { const socket = new FakeSocket(); sockets.push(socket); return socket; },
    });
    const opened = transport.open({
      profile,
      sessionId: "session",
      turnId: "turn",
      operationId: "operation",
      language: "zh-CN",
      format: audioFrame.format,
      signal: new AbortController().signal,
    });
    const socket = sockets[0];
    socket.onopen?.({});
    const session = await opened;
    const iterator = session.events[Symbol.asyncIterator]();
    socket.onmessage?.({ data: serverFrame({ result: { text: "第一句。", utterances: [{ definite: true }] } }) });
    await iterator.next();
    socket.onmessage?.({ data: serverFrame({ result: { text: "第一句。第二句" } }) });
    await iterator.next();
    await session.finish();
    socket.onclose?.({ code: 1000, reason: "provider-finished" });
    await expect(iterator.next()).resolves.toEqual({ done: false, value: { type: "final", text: "第一句。第二句", cumulative: true } });
    await expect(iterator.next()).resolves.toEqual({ done: false, value: { type: "completed" } });
  });
});
