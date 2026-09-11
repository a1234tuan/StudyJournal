import { stageFailure } from "./diagnostics";

export interface VoicePlaybackSink {
  prepare?(chunk: Uint8Array, signal: AbortSignal): Promise<void>;
  play(chunk: Uint8Array, signal: AbortSignal): Promise<void>;
  stop(): void | Promise<void>;
}

export class VoicePlaybackQueue {
  private generation = 0;
  private controller = new AbortController();
  private tail = Promise.resolve();
  private pending = 0;
  private failure?: unknown;
  private readonly capacityWaiters = new Set<() => void>();

  async waitForCapacity(limit: number) {
    while (this.pending >= limit) await new Promise<void>((resolve) => this.capacityWaiters.add(resolve));
    if (this.failure) throw stageFailure("playback", this.failure);
  }

  private releaseWaiters() { for (const resolve of this.capacityWaiters) resolve(); this.capacityWaiters.clear(); }

  constructor(private readonly sink: VoicePlaybackSink) {}

  get currentGeneration() {
    return this.generation;
  }

  enqueue(chunk: Uint8Array, generation = this.generation): boolean {
    if (generation !== this.generation || this.controller.signal.aborted) return false;
    const signal = this.controller.signal;
    this.pending += 1;
    const prepared = Promise.resolve().then(() => this.sink.prepare?.(chunk, signal));
    void prepared.catch(() => undefined);
    this.tail = this.tail.then(async () => {
      if (generation !== this.generation || signal.aborted) return;
      if (this.failure) return;
      await prepared;
      await this.sink.play(chunk, signal);
    }).catch((error) => { if (generation === this.generation && !signal.aborted) this.failure = error; })
      .finally(() => { if (generation === this.generation) this.pending -= 1; this.releaseWaiters(); });
    return true;
  }

  async interrupt() {
    this.generation += 1;
    this.controller.abort("playback-interrupted");
    this.controller = new AbortController();
    this.tail = Promise.resolve();
    this.pending = 0;
    this.failure = undefined;
    this.releaseWaiters();
    await this.sink.stop();
    return this.generation;
  }

  async waitUntilIdle() {
    await this.tail;
    if (this.failure) throw stageFailure("playback", this.failure);
  }
}
