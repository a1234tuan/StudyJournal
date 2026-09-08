export interface VoicePlaybackSink {
  play(chunk: Uint8Array, signal: AbortSignal): Promise<void>;
  stop(): void | Promise<void>;
}

export class VoicePlaybackQueue {
  private generation = 0;
  private controller = new AbortController();
  private tail = Promise.resolve();

  constructor(private readonly sink: VoicePlaybackSink) {}

  get currentGeneration() {
    return this.generation;
  }

  enqueue(chunk: Uint8Array, generation = this.generation): boolean {
    if (generation !== this.generation || this.controller.signal.aborted) return false;
    const signal = this.controller.signal;
    this.tail = this.tail.then(async () => {
      if (generation !== this.generation || signal.aborted) return;
      await this.sink.play(chunk, signal);
    });
    return true;
  }

  async interrupt() {
    this.generation += 1;
    this.controller.abort("playback-interrupted");
    this.controller = new AbortController();
    this.tail = Promise.resolve();
    await this.sink.stop();
    return this.generation;
  }

  waitUntilIdle() {
    return this.tail;
  }
}
