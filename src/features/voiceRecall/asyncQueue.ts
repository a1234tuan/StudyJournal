export interface AsyncQueue<T> extends AsyncIterable<T> {
  push(value: T): void;
  close(): void;
  fail(error: unknown): void;
  readonly closed: boolean;
  readonly size: number;
}

/**
 * Single-consumer async queue used to bridge callback-driven audio capture into
 * the pull-based `AsyncIterable` the ASR transports expect.
 */
export const createAsyncQueue = <T>(): AsyncQueue<T> => {
  const values: T[] = [];
  const waiters: Array<(result: IteratorResult<T>) => void> = [];
  let closed = false;
  let failure: unknown;

  return {
    push(value) {
      if (closed) return;
      const waiter = waiters.shift();
      if (waiter) waiter({ done: false, value });
      else values.push(value);
    },
    close() {
      if (closed) return;
      closed = true;
      for (const waiter of waiters.splice(0)) waiter({ done: true, value: undefined as never });
    },
    fail(error) { failure = error; values.length = 0; this.close(); },
    get closed() { return closed; },
    get size() { return values.length; },
    [Symbol.asyncIterator]() {
      return {
        next: async () => {
          if (failure) throw failure;
          const value = values.shift();
          if (value !== undefined) return Promise.resolve({ done: false, value });
          if (closed) return Promise.resolve({ done: true, value: undefined as never });
          const result = await new Promise<IteratorResult<T>>((resolve) => waiters.push(resolve));
          if (failure) throw failure;
          return result;
        },
      };
    },
  };
};
