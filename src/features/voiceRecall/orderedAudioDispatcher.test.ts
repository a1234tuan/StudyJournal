import { describe, expect, it } from "vitest";

import { OrderedAudioDispatcher } from "./orderedAudioDispatcher";

describe("OrderedAudioDispatcher", () => {
  it("allows later synthesis to finish first without reordering playback", async () => {
    const delivered: number[] = [];
    const dispatcher = new OrderedAudioDispatcher(async ({ chunk }) => { delivered.push(chunk[0]); });
    dispatcher.begin(0);
    dispatcher.begin(1);

    const second = dispatcher.push(1, { chunk: new Uint8Array([2]), generation: 1, segmentId: "s:1" });
    await dispatcher.complete(1);
    expect(delivered).toEqual([]);

    await dispatcher.push(0, { chunk: new Uint8Array([1]), generation: 1, segmentId: "s:0" });
    await dispatcher.complete(0);
    await second;
    await dispatcher.finish();
    expect(delivered).toEqual([1, 2]);
  });

  it("forwards chunks from the current segment before that segment completes", async () => {
    const delivered: number[] = [];
    const dispatcher = new OrderedAudioDispatcher(({ chunk }) => { delivered.push(chunk[0]); });
    dispatcher.begin(0);

    await dispatcher.push(0, { chunk: new Uint8Array([1]), generation: 1, segmentId: "s:0" });
    expect(delivered).toEqual([1]);
    await dispatcher.push(0, { chunk: new Uint8Array([2]), generation: 1, segmentId: "s:0" });
    await dispatcher.complete(0);
    await dispatcher.finish();
    expect(delivered).toEqual([1, 2]);
  });
});
