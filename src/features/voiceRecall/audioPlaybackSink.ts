import type { VoicePlaybackSink } from "./playbackQueue";

export type VoicePlaybackEncoding = "provider-native" | "pcm-s16le";

export interface VoicePlaybackSinkOptions {
  /** `provider-native` chunks are decoded as compressed audio (e.g. Fish Audio MP3);
   * `pcm-s16le` chunks are raw little-endian samples and are converted directly. */
  encoding: VoicePlaybackEncoding;
  sampleRate?: number;
  contextFactory?: () => AudioContext;
}

const toFloat32 = (chunk: Uint8Array): Float32Array<ArrayBuffer> => {
  const view = new DataView(chunk.buffer, chunk.byteOffset, chunk.byteLength);
  const samples = new Float32Array(Math.floor(chunk.byteLength / 2));
  for (let index = 0; index < samples.length; index += 1) {
    samples[index] = view.getInt16(index * 2, true) / 0x8000;
  }
  return samples;
};

/**
 * Plays real TTS audio through the Web Audio API. `play()` resolves when the
 * chunk has finished (or was interrupted), which is what lets the runtime mark a
 * turn as spoken only after the user actually heard it.
 */
export const createVoicePlaybackSink = (options: VoicePlaybackSinkOptions): VoicePlaybackSink => {
  let context: AudioContext | undefined;
  let current: AudioBufferSourceNode | undefined;

  const getContext = (): AudioContext => {
    context ??= (options.contextFactory ?? (() => new AudioContext()))();
    return context;
  };

  const stopCurrent = () => {
    try { current?.stop(); } catch { /* already stopped */ }
    current = undefined;
  };

  return {
    play: async (chunk, signal) => {
      if (signal.aborted || chunk.byteLength === 0) return;
      const ctx = getContext();
      if (ctx.state === "suspended") await ctx.resume().catch(() => undefined);
      if (signal.aborted) return;

      let buffer: AudioBuffer;
      if (options.encoding === "pcm-s16le") {
        const samples = toFloat32(chunk);
        buffer = ctx.createBuffer(1, samples.length, options.sampleRate ?? 16_000);
        buffer.copyToChannel(samples, 0);
      } else {
        buffer = await ctx.decodeAudioData(chunk.slice().buffer as ArrayBuffer);
      }
      if (signal.aborted) return;

      const source = ctx.createBufferSource();
      source.buffer = buffer;
      source.connect(ctx.destination);
      current = source;
      await new Promise<void>((resolve) => {
        const finish = () => {
          signal.removeEventListener("abort", onAbort);
          if (current === source) current = undefined;
          resolve();
        };
        const onAbort = () => {
          try { source.stop(); } catch { /* not started */ }
          finish();
        };
        signal.addEventListener("abort", onAbort, { once: true });
        source.onended = finish;
        source.start();
      });
    },
    stop: () => { stopCurrent(); },
  };
};
