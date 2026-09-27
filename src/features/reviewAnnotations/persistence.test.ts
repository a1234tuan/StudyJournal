import { describe, expect, it, vi } from "vitest";
import type { ReviewAnnotationDraft } from "./domain";
import { createAnnotationPersistence } from "./persistence";

const draft = (value: string): ReviewAnnotationDraft & { writeGeneration: number } => ({
  id: "record:occurrence", recordId: "record", reviewOccurrenceKey: "occurrence", contentRevision: "revision",
  schemaVersion: 1, elements: [], history: [[]], historyCursor: 0, updatedAt: value, writeGeneration: 0,
});

const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
};

describe("annotation persistence coordination", () => {
  it("does not let an empty flush swallow a draft staged in the same tick", async () => {
    const repository = { openDraft: vi.fn(async (next: ReviewAnnotationDraft) => ({ ...next, writeGeneration: next.writeGeneration ?? 0 })), upsertDraft: vi.fn(async () => true) };
    const persistence = createAnnotationPersistence(repository);
    const latest = draft("latest");
    const emptyFlush = persistence.flush(latest.id);
    persistence.stage(latest);
    await persistence.flush(latest.id);
    await emptyFlush;
    expect(repository.upsertDraft).toHaveBeenCalledWith(latest);
    expect(persistence.hasPending(latest.id)).toBe(false);
  });

  it("waits for a previous save before reopening the same draft", async () => {
    const gate = deferred();
    let stored = draft("old");
    const repository = {
      openDraft: vi.fn(async () => stored),
      upsertDraft: vi.fn(async (next: ReviewAnnotationDraft) => { await gate.promise; stored = { ...next, writeGeneration: next.writeGeneration ?? 0 }; return true; }),
    };
    const persistence = createAnnotationPersistence(repository);
    const latest = draft("latest");
    persistence.stage(latest);
    const saving = persistence.flush(latest.id);
    const reopening = persistence.open(draft("empty"));
    expect(repository.openDraft).not.toHaveBeenCalled();
    gate.resolve();
    await saving;
    expect(await reopening).toEqual(latest);
    expect(persistence.hasPending(latest.id)).toBe(false);
  });

  it("serializes updates made while an older write is in flight", async () => {
    const gate = deferred();
    const repository = {
      openDraft: vi.fn(async (next: ReviewAnnotationDraft) => ({ ...next, writeGeneration: next.writeGeneration ?? 0 })),
      upsertDraft: vi.fn(async () => { await gate.promise; return true; }),
    };
    const persistence = createAnnotationPersistence(repository);
    const first = draft("first");
    const latest = draft("latest");
    persistence.stage(first);
    const saving = persistence.flush(first.id);
    persistence.stage(latest);
    expect(repository.upsertDraft).toHaveBeenCalledTimes(1);
    gate.resolve();
    await saving;
    expect(repository.upsertDraft.mock.calls).toEqual([[first], [latest]]);
    expect(persistence.hasPending(first.id)).toBe(false);
  });

  it("retains failed edits and prevents a stale reopen until retry succeeds", async () => {
    const repository = {
      openDraft: vi.fn(async (next: ReviewAnnotationDraft) => ({ ...next, writeGeneration: next.writeGeneration ?? 0 })),
      upsertDraft: vi.fn().mockRejectedValue(new Error("quota")),
    };
    const persistence = createAnnotationPersistence(repository);
    const latest = draft("latest");
    persistence.stage(latest);
    await expect(persistence.flush(latest.id)).rejects.toThrow("quota");
    expect(persistence.hasPending(latest.id)).toBe(true);
    await expect(persistence.open(draft("empty"))).rejects.toThrow("quota");
    expect(repository.openDraft).not.toHaveBeenCalled();
    repository.upsertDraft.mockResolvedValue(true);
    await persistence.flush(latest.id);
    expect(repository.upsertDraft).toHaveBeenLastCalledWith(latest);
    expect(persistence.hasPending(latest.id)).toBe(false);
  });

  it("reports a stale generation instead of treating it as a successful save", async () => {
    const repository = { openDraft: vi.fn(async (next: ReviewAnnotationDraft) => ({ ...next, writeGeneration: next.writeGeneration ?? 0 })), upsertDraft: vi.fn(async () => false) };
    const persistence = createAnnotationPersistence(repository);
    persistence.stage(draft("stale"));
    await expect(persistence.flush(draft("stale").id)).rejects.toThrow("批注版本已变化");
    expect(persistence.hasPending(draft("stale").id)).toBe(false);
  });
});
