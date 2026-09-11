import { describe, expect, it } from "vitest";

import { buildDoubaoAsrAudioFrame, buildDoubaoAsrStartFrame, parseDoubaoAsrFrame } from "./doubaoAsrProtocol";

const readPayload = (frame: Uint8Array) => {
  const size = new DataView(frame.buffer, frame.byteOffset, frame.byteLength).getUint32(4, false);
  return frame.slice(8, 8 + size);
};

describe("Doubao ASR binary protocol", () => {
  it("encodes the full-client request with 16 kHz PCM metadata", () => {
    const frame = buildDoubaoAsrStartFrame({
      requestId: "request-1",
      sampleRate: 16_000,
      language: "zh-CN",
      model: "bigmodel",
      punctuation: true,
      inverseTextNormalization: true,
    });

    expect([...frame.slice(0, 4)]).toEqual([0x11, 0x10, 0x10, 0x00]);
    expect(JSON.parse(new TextDecoder().decode(readPayload(frame)))).toMatchObject({
      audio: { format: "pcm", codec: "raw", rate: 16_000, bits: 16, channel: 1 },
      request: { reqid: "request-1", model_name: "bigmodel", result_type: "full" },
    });
  });

  it("marks only the last audio packet with the negative flag", () => {
    expect(buildDoubaoAsrAudioFrame(new Uint8Array([1, 2]))[1]).toBe(0x20);
    expect(buildDoubaoAsrAudioFrame(new Uint8Array(0), true)[1]).toBe(0x22);
  });

  it("parses sequenced full-server and error frames", async () => {
    const payload = new TextEncoder().encode(JSON.stringify({ result: { text: "完成" } }));
    const full = new Uint8Array(12 + payload.byteLength);
    full.set([0x11, 0x93, 0x10, 0x00]);
    new DataView(full.buffer).setInt32(4, -2, false);
    new DataView(full.buffer).setUint32(8, payload.byteLength, false);
    full.set(payload, 12);
    const parsedFull = await parseDoubaoAsrFrame(full);
    expect(parsedFull).toMatchObject({ messageType: 0x9, final: true });
    expect(new TextDecoder().decode(parsedFull.payload)).toBe(new TextDecoder().decode(payload));

    const message = new TextEncoder().encode("unauthorized");
    const error = new Uint8Array(12 + message.byteLength);
    error.set([0x11, 0xf0, 0x00, 0x00]);
    new DataView(error.buffer).setUint32(4, 45_000_001, false);
    new DataView(error.buffer).setUint32(8, message.byteLength, false);
    error.set(message, 12);
    const parsedError = await parseDoubaoAsrFrame(error);
    expect(parsedError).toMatchObject({ messageType: 0xf, errorCode: 45_000_001 });
    expect(new TextDecoder().decode(parsedError.payload)).toBe("unauthorized");
  });
});
