export interface AsyncQueue<T> extends AsyncIterable<T> {
  push(value: T): void;
  close(): void;
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
    get closed() { return closed; },
    get size() { return values.length; },
    [Symbol.asyncIterator]() {
      return {
        next: () => {
          const value = values.shift();
          if (value !== undefined) return Promise.resolve({ done: false, value });
          if (closed) return Promise.resolve({ done: true, value: undefined as never });
          return new Promise<IteratorResult<T>>((resolve) => waiters.push(resolve));
        },
      };
    },
  };
};
