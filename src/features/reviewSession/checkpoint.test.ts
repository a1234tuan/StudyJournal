import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RecordBlock, RecordReviewState } from "../../types";
import { readReviewCheckpoint, reconcileReviewCheckpoint, REVIEW_CHECKPOINT_KEY, writeReviewCheckpoint, clearReviewCheckpoint, type ReviewCheckpoint } from "./checkpoint";

const day = "2026-10-05";
const checkpoint: ReviewCheckpoint = { version: 1, day, recordIds: ["first", "second", "third"], currentRecordId: "second", selected: false };
const records = checkpoint.recordIds.map(id => ({ id } as RecordBlock));
const reviews = checkpoint.recordIds.map(recordId => ({ recordId, status: "active", nextReviewDate: day } as RecordReviewState));

describe("ordinary review checkpoint", () => {
  beforeEach(() => { vi.restoreAllMocks(); localStorage.clear(); });

  it("persists only local navigation membership, never scores or undo tokens", () => {
    writeReviewCheckpoint(checkpoint);
    expect(readReviewCheckpoint(day)).toEqual(checkpoint);
    expect(Object.keys(JSON.parse(localStorage.getItem(REVIEW_CHECKPOINT_KEY)!)).sort()).toEqual(["currentRecordId", "day", "recordIds", "selected", "version"]);
    clearReviewCheckpoint();
    expect(readReviewCheckpoint(day)).toBeUndefined();
  });

  it.each(["null", "{}", "broken", JSON.stringify({ ...checkpoint, version: 9 }), JSON.stringify({ ...checkpoint, recordIds: ["first", "first"] }), JSON.stringify({ ...checkpoint, currentRecordId: "unknown" })])("ignores damaged or unsupported data: %s", raw => {
    localStorage.setItem(REVIEW_CHECKPOINT_KEY, raw);
    expect(readReviewCheckpoint(day)).toBeUndefined();
  });

  it("does not resume yesterday's batch", () => {
    writeReviewCheckpoint(checkpoint);
    expect(readReviewCheckpoint("2026-10-06")).toBeUndefined();
  });

  it("derives completion from committed ratings even if shutdown preceded the next UI save", () => {
    const result = reconcileReviewCheckpoint({ ...checkpoint, currentRecordId: "first" }, records, reviews.map(review => review.recordId === "first" ? { ...review, lastReviewDate: day, nextReviewDate: "2026-10-08" } : review));
    expect(result.progress).toEqual({ total: 3, completed: 1 });
    expect(result.queueIds).toEqual(["second", "third"]);
    expect(result.currentRecordId).toBe("second");
  });

  it("does not trust optimistic UI advancement without a committed rating", () => {
    const result = reconcileReviewCheckpoint(checkpoint, records, reviews);
    expect(result.progress).toEqual({ total: 3, completed: 0 });
    expect(result.queueIds).toEqual(["first", "second", "third"]);
    expect(result.currentRecordId).toBe("first");
  });

  it("a reverted or undone rating becomes pending on recovery", () => {
    const result = reconcileReviewCheckpoint(checkpoint, records, reviews);
    expect(result.ratedRecordIds).toEqual([]);
    expect(result.queueIds).toContain("first");
  });

  it("drops deleted, removed, and externally rescheduled cards rather than restoring stale work", () => {
    const result = reconcileReviewCheckpoint(checkpoint, records.map(record => record.id === "first" ? { ...record, deletedAt: "2026-10-05T00:00:00Z" } : record), reviews.map(review => review.recordId === "second" ? { ...review, status: "removed" } : { ...review, nextReviewDate: "2026-10-09" }));
    expect(result.progress).toEqual({ total: 0, completed: 0 });
    expect(result.currentRecordId).toBeUndefined();
  });

  it("does not silently append new due cards to a frozen batch", () => {
    const result = reconcileReviewCheckpoint(checkpoint, [...records, { id: "new" } as RecordBlock], [...reviews, { recordId: "new", status: "active", nextReviewDate: day } as RecordReviewState]);
    expect(result.queueIds).toEqual(checkpoint.recordIds);
    expect(result.progress.total).toBe(3);
  });

  it("keeps the completed batch available after restart", () => {
    const result = reconcileReviewCheckpoint(checkpoint, records, reviews.map(review => ({ ...review, lastReviewDate: day })));
    expect(result.progress).toEqual({ total: 3, completed: 3 });
    expect(result.queueIds).toEqual([]);
  });

  it("surfaces persistence failure so the UI can disclose it", () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("quota"); });
    expect(() => writeReviewCheckpoint(checkpoint)).toThrow("quota");
  });
});
