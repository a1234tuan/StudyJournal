import { describe, expect, it } from "vitest";

import { createAsyncQueue } from "./asyncQueue";

describe("createAsyncQueue", () => {
  it("delivers buffered values in order and ends when closed", async () => {
    const queue = createAsyncQueue<number>();
    queue.push(1);
    queue.push(2);
    queue.close();

    const received: number[] = [];
    for await (const value of queue) received.push(value);
    expect(received).toEqual([1, 2]);
  });

  it("resolves a pending consumer when a value arrives later", async () => {
    const queue = createAsyncQueue<string>();
    const iterator = queue[Symbol.asyncIterator]();
    const pending = iterator.next();
    queue.push("frame");
    await expect(pending).resolves.toEqual({ done: false, value: "frame" });
    queue.close();
    await expect(iterator.next()).resolves.toEqual({ done: true, value: undefined });
  });

  it("wakes every waiting consumer on close and ignores later pushes", async () => {
    const queue = createAsyncQueue<number>();
    const iterator = queue[Symbol.asyncIterator]();
    const pending = iterator.next();
    queue.close();
    await expect(pending).resolves.toEqual({ done: true, value: undefined });
    queue.push(99);
    expect(queue.size).toBe(0);
    expect(queue.closed).toBe(true);
  });
});
