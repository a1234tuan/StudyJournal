import { describe, expect, it } from "vitest";
import { VoiceActivityEndpoint } from "./voiceActivity";

const frame = (amplitude: number, milliseconds = 100, sequence = 0) => {
  const samples = new Int16Array(milliseconds * 16).fill(amplitude);
  return { sequence, capturedAtMonotonicMs: 0, data: new Uint8Array(samples.buffer), format: { encoding: "pcm-s16le" as const, sampleRate: 16000, channelCount: 1 as const } };
};
describe("voice activity endpoint", () => {
  it("detects quiet Android speech after estimating the microphone noise floor", () => {
    const detector = new VoiceActivityEndpoint();
    for (let index = 0; index < 16; index += 1) detector.push(frame(25, 64, index));
    for (let index = 16; index < 24; index += 1) detector.push(frame(120, 64, index));
    expect(detector.hasSpeech).toBe(true);
    detector.updateTranscript("这是低音量识别测试。", "final");
    expect(detector.push(frame(25, 600))).toBe(false);
    expect(detector.push(frame(25, 100))).toBe(true);
  });
  it("accumulates voiced syllables across short unvoiced gaps", () => {
    const detector = new VoiceActivityEndpoint();
    for (let index = 0; index < 8; index += 1) detector.push(frame(25, 64));
    for (let index = 0; index < 4; index += 1) {
      detector.push(frame(150, 64));
      detector.push(frame(25, 64));
    }
    expect(detector.hasSpeech).toBe(true);
  });
  it("does not turn steady background noise or separated impulses into speech", () => {
    const detector = new VoiceActivityEndpoint();
    for (let index = 0; index < 80; index += 1) detector.push(frame(80, 64));
    expect(detector.hasSpeech).toBe(false);
    for (let index = 0; index < 5; index += 1) {
      detector.push(frame(3000, 64));
      detector.push(frame(80, 256));
    }
    expect(detector.hasSpeech).toBe(false);
  });
  it("accepts provider speech evidence without extending silence for duplicate text", () => {
    const detector = new VoiceActivityEndpoint();
    detector.updateTranscript("轻声回答。", "final");
    expect(detector.hasSpeech).toBe(true);
    expect(detector.push(frame(0, 600))).toBe(false);
    detector.updateTranscript("轻声回答。", "final");
    expect(detector.push(frame(0, 100))).toBe(true);
  });
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
    expect(detector.push(frame(0, 2100))).toBe(false);
    expect(detector.push(frame(0))).toBe(true);
    expect(detector.metrics.endpointReason).toBe("no-transcript");
    expect(detector.push(frame(0))).toBe(false);
  });
  it("ends quickly after stable strong punctuation", () => {
    const detector = new VoiceActivityEndpoint();
    detector.push(frame(3000, 400));
    detector.updateTranscript("TCP 提供可靠传输。", "final");
    expect(detector.push(frame(0, 600))).toBe(false);
    expect(detector.push(frame(0))).toBe(true);
    expect(detector.metrics.endpointReason).toBe("strong-punctuation");
  });
  it("uses a short provider-final threshold without punctuation", () => {
    const detector = new VoiceActivityEndpoint();
    detector.push(frame(3000, 400));
    detector.updateTranscript("TCP 提供可靠传输", "final");
    expect(detector.push(frame(0, 800))).toBe(false);
    expect(detector.push(frame(0))).toBe(true);
    expect(detector.metrics.endpointReason).toBe("provider-final");
  });
  it("ends on stable partial text while keeping a brief breath open", () => {
    const detector = new VoiceActivityEndpoint();
    detector.push(frame(3000, 400));
    detector.updatePartial("TCP 提供可靠传输");
    expect(detector.push(frame(0, 500))).toBe(false);
    detector.push(frame(3000, 100));
    expect(detector.push(frame(0, 1000))).toBe(false);
    expect(detector.push(frame(0, 100))).toBe(true);
    expect(detector.metrics.endpointReason).toBe("stable-text");
  });
  it("extends incomplete utterances and validates format", () => {
    const detector = new VoiceActivityEndpoint();
    detector.updatePartial("主要是因为");
    detector.push(frame(3000, 400));
    expect(detector.push(frame(0, 1700))).toBe(false);
    expect(detector.push(frame(0, 100))).toBe(true);
    expect(detector.metrics.endpointReason).toBe("continuation");
    expect(() => new VoiceActivityEndpoint().push({ ...frame(0), data: new Uint8Array(3) })).toThrow();
  });
});
