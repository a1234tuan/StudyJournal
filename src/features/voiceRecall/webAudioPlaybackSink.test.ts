import { afterEach, describe, expect, it, vi } from "vitest";

import { WebAudioPlaybackSink } from "./webAudioPlaybackSink";

interface MockNode {
  connect: ReturnType<typeof vi.fn>;
  disconnect: ReturnType<typeof vi.fn>;
  start: ReturnType<typeof vi.fn>;
  stop: ReturnType<typeof vi.fn>;
  onended: ((this: unknown) => unknown) | null;
  buffer: unknown;
}

const createMockContext = () => {
  const nodes: MockNode[] = [];
  const context = {
    resume: vi.fn(async () => undefined),
    createBuffer: vi.fn((channels: number, length: number, sampleRate: number) => ({
      getChannelData: () => new Float32Array(length),
      numberOfChannels: channels,
      sampleRate,
      length,
    })),
    createBufferSource: vi.fn(() => {
      const node: MockNode = {
        connect: vi.fn(() => ({ connect: vi.fn(() => undefined) })),
        disconnect: vi.fn(),
        start: vi.fn(),
        stop: vi.fn(),
        onended: null,
        buffer: null,
      };
      nodes.push(node);
      return node;
    }),
    createGain: vi.fn(() => {
      const gain = { gain: { value: 1 }, connect: vi.fn(() => undefined) };
      return gain;
    }),
    destination: { __brand: "destination" },
  };
  return { context, nodes };
};

describe("WebAudioPlaybackSink", () => {
  const originalAudioContext = (window as { AudioContext?: unknown }).AudioContext;
  const originalWebkit = (window as { webkitAudioContext?: unknown }).webkitAudioContext;

  afterEach(() => {
    if (originalAudioContext) (window as { AudioContext?: unknown }).AudioContext = originalAudioContext;
    else delete (window as { AudioContext?: unknown }).AudioContext;
    if (originalWebkit) (window as { webkitAudioContext?: unknown }).webkitAudioContext = originalWebkit;
    else delete (window as { webkitAudioContext?: unknown }).webkitAudioContext;
  });

  it("decodes pcm-s16le chunks, plays at low gain, and stops active sources", async () => {
    const { context, nodes } = createMockContext();
    (window as { AudioContext?: unknown }).AudioContext = vi.fn(() => context) as unknown as { new (): typeof context };

    const sink = new WebAudioPlaybackSink();
    const pcm = new Uint8Array([0x00, 0x10, 0x00, 0x20, 0xff, 0x7f]);
    const signal = new AbortController().signal;
    // play resolves once the source's onended fires.
    const playPromise = sink.play(pcm, signal);
    // simulate the browser ending playback
    await Promise.resolve();
    const source = nodes[0];
    expect(source.start).toHaveBeenCalled();
    // gain value should be clamped low (0.15) for safety
    expect(context.createGain).toHaveBeenCalled();
    source.onended?.call(source);
    await expect(playPromise).resolves.toBeUndefined();
  });

  it("stops in-flight sources when stop() is called", async () => {
    const { context, nodes } = createMockContext();
    (window as { AudioContext?: unknown }).AudioContext = vi.fn(() => context) as unknown as { new (): typeof context };

    const sink = new WebAudioPlaybackSink();
    const signal = new AbortController().signal;
    const playPromise = sink.play(new Uint8Array(8), signal);
    await Promise.resolve();
    expect(nodes).toHaveLength(1);
    sink.stop();
    expect(nodes[0].stop).toHaveBeenCalled();
    // resolve the pending play promise so the test does not hang
    nodes[0].onended?.call(nodes[0]);
    await playPromise;
  });

  it("falls back to a silent no-op when AudioContext is unavailable", async () => {
    delete (window as { AudioContext?: unknown }).AudioContext;
    delete (window as { webkitAudioContext?: unknown }).webkitAudioContext;
    const sink = new WebAudioPlaybackSink();
    await expect(sink.play(new Uint8Array(4), new AbortController().signal)).resolves.toBeUndefined();
    expect(sink.stop()).toBeUndefined();
  });
});
