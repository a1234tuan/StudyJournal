import { describe, expect, it } from "vitest";

import { createDraftFlushTracker } from "./draftFlushTracker";

describe("createDraftFlushTracker", () => {
  it("reports a record as pending from acquire until release", () => {
    const tracker = createDraftFlushTracker();

    expect(tracker.isPending("r1")).toBe(false);
    tracker.acquire("r1");
    expect(tracker.isPending("r1")).toBe(true);
    expect(tracker.pendingRecordIds()).toEqual(["r1"]);
    expect(tracker.release("r1")).toBe(true);
    expect(tracker.isPending("r1")).toBe(false);
    expect(tracker.pendingRecordIds()).toEqual([]);
  });

  it("keeps a record pending until every overlapping flush settles", () => {
    // The editor can have two flushes for one record in the air at once (the back
    // handler's flush and the unmount cleanup's). Clearing on the first settle
    // would reopen the "no draft yet" window while the second was still writing.
    const tracker = createDraftFlushTracker();

    tracker.acquire("r1");
    tracker.acquire("r1");

    expect(tracker.release("r1")).toBe(false);
    expect(tracker.isPending("r1")).toBe(true);
    expect(tracker.release("r1")).toBe(true);
    expect(tracker.isPending("r1")).toBe(false);
  });

  it("never reports settled while a different record is still flushing", () => {
    const tracker = createDraftFlushTracker();

    tracker.acquire("r1");
    tracker.acquire("r2");
    tracker.release("r1");

    expect(tracker.pendingRecordIds()).toEqual(["r2"]);
  });

  it("ignores an unmatched release instead of going negative", () => {
    const tracker = createDraftFlushTracker();

    expect(tracker.release("r1")).toBe(true);
    expect(tracker.isPending("r1")).toBe(false);
    // A release with no matching acquire must not make the record look like it
    // has an outstanding flush.
    tracker.acquire("r1");
    expect(tracker.release("r1")).toBe(true);
  });

  it("keeps records independent", () => {
    const tracker = createDraftFlushTracker();

    tracker.acquire("r1");
    tracker.acquire("r2");
    tracker.acquire("r1");
    tracker.release("r1");

    expect(tracker.isPending("r1")).toBe(true);
    expect(tracker.isPending("r2")).toBe(true);
    expect(tracker.pendingRecordIds().sort()).toEqual(["r1", "r2"]);
  });
});
