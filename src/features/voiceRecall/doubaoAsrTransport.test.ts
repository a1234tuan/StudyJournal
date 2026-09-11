import { describe, expect, it } from "vitest";

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
});
