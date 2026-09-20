export interface OrderedAudioItem {
  chunk: Uint8Array;
  generation: number;
  segmentId: string;
}

interface PendingAudioItem {
  item: OrderedAudioItem;
  resolve: () => void;
  reject: (error: unknown) => void;
}

interface OrderedAudioSegment {
  completed: boolean;
  items: PendingAudioItem[];
}

/** Keeps parallel sentence synthesis while exposing audio in sentence order. */
export class OrderedAudioDispatcher {
  private readonly segments = new Map<number, OrderedAudioSegment>();
  private nextIndex = 0;
  private drainTail = Promise.resolve();
  private failure?: unknown;

  constructor(private readonly deliver: (item: OrderedAudioItem) => void | Promise<void>) {}

  begin(index: number) {
    if (!this.segments.has(index)) this.segments.set(index, { completed: false, items: [] });
  }

  push(index: number, item: OrderedAudioItem): Promise<void> {
    if (this.failure) return Promise.reject(this.failure);
    this.begin(index);
    return new Promise<void>((resolve, reject) => {
      this.segments.get(index)!.items.push({ item, resolve, reject });
      void this.schedule();
    });
  }

  complete(index: number): Promise<void> {
    this.begin(index);
    this.segments.get(index)!.completed = true;
    return this.schedule();
  }

  fail(error: unknown) {
    if (this.failure) return;
    this.failure = error;
    for (const segment of this.segments.values()) {
      for (const pending of segment.items.splice(0)) pending.reject(error);
    }
  }

  async finish() {
    await this.schedule();
    if (this.failure) throw this.failure;
    if (this.segments.size) throw new Error("TTS audio segments did not complete in order");
  }

  private schedule() {
    this.drainTail = this.drainTail.then(() => this.drain());
    return this.drainTail;
  }

  private async drain() {
    if (this.failure) throw this.failure;
    while (true) {
      const segment = this.segments.get(this.nextIndex);
      if (!segment) return;
      while (segment.items.length) {
        const pending = segment.items.shift()!;
        try {
          await this.deliver(pending.item);
          pending.resolve();
        } catch (error) {
          pending.reject(error);
          this.fail(error);
          throw error;
        }
      }
      if (!segment.completed) return;
      this.segments.delete(this.nextIndex);
      this.nextIndex += 1;
    }
  }
}
