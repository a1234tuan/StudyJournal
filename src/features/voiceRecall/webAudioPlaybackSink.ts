import type { VoicePlaybackSink } from "./playbackQueue";

interface AudioContextCtor {
  new (contextOptions?: AudioContextOptions): AudioContext;
}

type WebkitWindow = Window & {
  webkitAudioContext?: AudioContextCtor;
  AudioContext?: AudioContextCtor;
};

const decodePcmS16le = (chunk: Uint8Array, context: AudioContext): AudioBuffer => {
  const sampleCount = Math.floor(chunk.length / 2);
  const buffer = context.createBuffer(1, Math.max(1, sampleCount), 16_000);
  const channel = buffer.getChannelData(0);
  const view = new DataView(chunk.buffer, chunk.byteOffset, chunk.byteLength);
  for (let index = 0; index < sampleCount; index += 1) {
    channel[index] = view.getInt16(index * 2, true) / 32_768;
  }
  return buffer;
};

/** Real `VoicePlaybackSink` backed by Web Audio.
 *
 * Mock template TTS emits text-encoded bytes (not valid PCM); those decode as
 * low-amplitude noise, which is acceptable — the point is that the pipeline and
 * state machine traverse the real async play/stop/drain path rather than a
 * silent stub. A low gain (0.15) keeps any unexpectedly loud chunk safe. */
export class WebAudioPlaybackSink implements VoicePlaybackSink {
  private context?: AudioContext;
  private readonly active = new Set<AudioBufferSourceNode>();

  private getContext(): AudioContext | undefined {
    if (this.context) return this.context;
    if (typeof window === "undefined") return undefined;
    const windowRef = window as WebkitWindow;
    const Ctor = windowRef.AudioContext ?? windowRef.webkitAudioContext;
    if (!Ctor) return undefined;
    this.context = new Ctor();
    return this.context;
  }

  async play(chunk: Uint8Array, signal: AbortSignal): Promise<void> {
    const context = this.getContext();
    if (!context) return;
    let buffer: AudioBuffer;
    try {
      buffer = decodePcmS16le(chunk, context);
    } catch {
      return;
    }
    const source = context.createBufferSource();
    source.buffer = buffer;
    const gain = context.createGain();
    gain.gain.value = 0.15;
    source.connect(gain).connect(context.destination);
    this.active.add(source);
    try {
      await context.resume?.();
    } catch {
      /* autoplay gesture may not yet be honoured; ignore */
    }
    await new Promise<void>((resolve) => {
      const finish = () => {
        this.active.delete(source);
        resolve();
      };
      source.onended = finish;
      if (signal.aborted) {
        try { source.stop(); } catch { /* already stopped */ }
        finish();
        return;
      }
      signal.addEventListener("abort", () => {
        try { source.stop(); } catch { /* already stopped */ }
      }, { once: true });
      source.start();
    });
  }

  stop(): void {
    for (const source of this.active) {
      try { source.stop(); } catch { /* already stopped */ }
    }
    this.active.clear();
  }
}
