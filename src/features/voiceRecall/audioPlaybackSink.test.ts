import { describe, expect, it, vi } from "vitest";

import { createVoicePlaybackSink } from "./audioPlaybackSink";

const createFakeContext = () => {
  const sources: Array<{ buffer: AudioBuffer | null; started: boolean; stopped: boolean; onended: (() => void) | null }> = [];
  const context = {
    state: "running" as AudioContextState,
    destination: {} as AudioDestinationNode,
    resume: vi.fn(async () => undefined),
    createBuffer: vi.fn((channels: number, length: number, sampleRate: number) => {
      const data = new Float32Array(length);
      return {
        length,
        sampleRate,
        numberOfChannels: channels,
        _data: data,
        getChannelData: () => data,
        copyToChannel: (source: Float32Array) => { data.set(source); },
      } as unknown as AudioBuffer;
    }),
    decodeAudioData: vi.fn(async () => ({ duration: 1 } as AudioBuffer)),
    createBufferSource: vi.fn(() => {
      const source = { buffer: null, started: false, stopped: false, onended: null as (() => void) | null, connect: vi.fn(), start() { this.started = true; }, stop() { this.stopped = true; this.onended?.(); } };
      sources.push(source);
      return source as unknown as AudioBufferSourceNode;
    }),
    _sources: sources,
  };
  return context;
};

describe("voice playback sink", () => {
  it("converts pcm-s16le chunks to audio samples and plays them", async () => {
    const context = createFakeContext();
    const sink = createVoicePlaybackSink({ encoding: "pcm-s16le", sampleRate: 16_000, contextFactory: () => context as unknown as AudioContext });
    // two samples: 0x7fff (≈1.0) and 0x8000 (-1.0)
    const chunk = new Uint8Array([0xff, 0x7f, 0x00, 0x80]);

    const playing = sink.play(chunk, new AbortController().signal);
    await Promise.resolve();
    const source = context._sources[0];
    expect(source.started).toBe(true);
    const buffer = source.buffer as unknown as { _data: Float32Array; sampleRate: number };
    expect(buffer.sampleRate).toBe(16_000);
    expect(buffer._data[0]).toBeCloseTo(0.99997, 4);
    expect(buffer._data[1]).toBe(-1);

    source.onended?.();
    await playing;
  });

  it("decodes compressed chunks and resolves only after playback ends", async () => {
    const context = createFakeContext();
    const sink = createVoicePlaybackSink({ encoding: "provider-native", contextFactory: () => context as unknown as AudioContext });
    const settled = vi.fn();

    const playing = sink.play(new Uint8Array([1, 2, 3]), new AbortController().signal).then(settled);
    await Promise.resolve();
    expect(context.decodeAudioData).toHaveBeenCalledTimes(1);
    expect(settled).not.toHaveBeenCalled();

    context._sources[0].onended?.();
    await playing;
    expect(settled).toHaveBeenCalledTimes(1);
  });

  it("stops playback when the turn is interrupted", async () => {
    const context = createFakeContext();
    const sink = createVoicePlaybackSink({ encoding: "pcm-s16le", contextFactory: () => context as unknown as AudioContext });
    const controller = new AbortController();

    const playing = sink.play(new Uint8Array([1, 0, 2, 0]), controller.signal);
    await Promise.resolve();
    controller.abort();
    await playing;

    expect(context._sources[0].stopped).toBe(true);
  });

  it("ignores an already-aborted or empty chunk", async () => {
    const context = createFakeContext();
    const sink = createVoicePlaybackSink({ encoding: "pcm-s16le", contextFactory: () => context as unknown as AudioContext });
    const controller = new AbortController();
    controller.abort();
    await sink.play(new Uint8Array([1, 0]), controller.signal);
    await sink.play(new Uint8Array(0), new AbortController().signal);
    expect(context._sources).toHaveLength(0);
  });
});
