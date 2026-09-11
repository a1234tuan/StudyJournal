import { describe, expect, it } from "vitest";
import { VoiceActivityEndpoint } from "./voiceActivity";

const frame = (amplitude: number, milliseconds = 100, sequence = 0) => {
  const samples = new Int16Array(milliseconds * 16).fill(amplitude);
  return { sequence, capturedAtMonotonicMs: 0, data: new Uint8Array(samples.buffer), format: { encoding: "pcm-s16le" as const, sampleRate: 16000, channelCount: 1 as const } };
};
describe("voice activity endpoint", () => {
  it("rejects silence and a brief impulse", () => {
    const detector = new VoiceActivityEndpoint();
    detector.push(frame(3000));
    for (let index = 0; index < 60; index += 1) expect(detector.push(frame(80))).toBe(false);
    expect(detector.hasSpeech).toBe(false);
  });
  it("does not finish at a breath and waits longer without a partial", () => {
    const detector = new VoiceActivityEndpoint();
    detector.push(frame(3000, 400));
    expect(detector.push(frame(0, 300))).toBe(false);
    detector.push(frame(3000, 400));
    expect(detector.push(frame(0, 3900))).toBe(false);
    expect(detector.push(frame(0))).toBe(true);
    expect(detector.push(frame(0))).toBe(false);
  });
  it("uses two seconds only with a complete partial", () => {
    const detector = new VoiceActivityEndpoint();
    detector.updatePartial("TCP 提供可靠传输。");
    detector.push(frame(3000, 400));
    expect(detector.push(frame(0, 1900))).toBe(false);
    expect(detector.push(frame(0))).toBe(true);
  });
  it("extends incomplete utterances and validates format", () => {
    const detector = new VoiceActivityEndpoint();
    detector.updatePartial("主要是因为");
    detector.push(frame(3000, 400));
    expect(detector.push(frame(0, 2000))).toBe(false);
    expect(detector.push(frame(0, 2000))).toBe(true);
    expect(() => new VoiceActivityEndpoint().push({ ...frame(0), data: new Uint8Array(3) })).toThrow();
  });
});
