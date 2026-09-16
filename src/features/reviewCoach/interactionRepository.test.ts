import Dexie from "dexie";
import { IDBKeyRange, indexedDB } from "fake-indexeddb";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { StudyJournalDatabase } from "../../db/database";
import { REVIEW_COACH_SCHEMA_VERSION } from "../../db/reviewCoachSchema";
import { getReviewCoachFormalSnapshot, reviewCoachFormalTables, reviewCoachRestoreTables } from "./repository";
import { ReviewCoachInteractionRepository } from "./interactionRepository";
import type { ReviewCoachInteractionSegmentLocal } from "./interactionTrace";
import { coachTestBlock } from "./reviewCoachTestFixtures";

Dexie.dependencies.indexedDB = indexedDB;
Dexie.dependencies.IDBKeyRange = IDBKeyRange;

const localSegment = (
  overrides: Partial<ReviewCoachInteractionSegmentLocal> = {},
): ReviewCoachInteractionSegmentLocal => ({
  id: "segment-a",
  taskId: "task-1",
  screen: "task",
  category: "cognitive",
  phase: "initial-retrieval",
  activeMs: 30_000,
  startedAt: "2026-09-15T08:00:00.000Z",
  endedAt: "2026-09-15T08:00:30.000Z",
  ...overrides,
});

describe("review coach interaction trace boundary", () => {
  let database: StudyJournalDatabase;
  let repository: ReviewCoachInteractionRepository;

  beforeEach(async () => {
    database = new StudyJournalDatabase(`review-coach-interaction-${crypto.randomUUID()}`);
    await database.open();
    repository = new ReviewCoachInteractionRepository(database);
  });

  afterEach(async () => {
    const name = database.name;
    database.close();
    await Dexie.delete(name);
  });

  it("is not part of the formal table set used by backup, restore, sync and export", () => {
    const formalNames = reviewCoachFormalTables(database).map((table) => table.name);
    const restoreNames = reviewCoachRestoreTables(database).map((table) => table.name);
    expect(formalNames).not.toContain("reviewCoachInteractionSegments");
    expect(restoreNames).not.toContain("reviewCoachInteractionSegments");
  });

  it("never appears in the portable Review Coach snapshot", async () => {
    await repository.append([localSegment({ phase: "PHASE-MARKER-SHOULD-NOT-EXPORT" })]);
    const snapshot = await getReviewCoachFormalSnapshot(database);
    expect(JSON.stringify(snapshot)).not.toContain("PHASE-MARKER-SHOULD-NOT-EXPORT");
    expect(JSON.stringify(snapshot)).not.toContain("reviewCoachInteractionSegments");
  });

  it("stores and retrieves segments per task", async () => {
    await repository.append([
      localSegment({ id: "s1", taskId: "task-1", endedAt: "2026-09-15T08:00:10.000Z" }),
      localSegment({ id: "s2", taskId: "task-2", endedAt: "2026-09-15T08:00:20.000Z" }),
      localSegment({ id: "s3", taskId: "task-1", endedAt: "2026-09-15T08:00:30.000Z" }),
    ]);
    const forTask = await repository.listForTask("task-1");
    expect(forTask.map((segment) => segment.id)).toEqual(["s1", "s3"]);
    expect((await database.reviewCoachInteractionSegments.count())).toBe(3);
  });

  it("prunes segments past the retention window without touching the rest", async () => {
    const now = Date.parse("2026-09-15T08:00:00.000Z");
    await repository.append([
      localSegment({ id: "fresh", endedAt: "2026-09-15T07:59:00.000Z" }),
      localSegment({ id: "stale", endedAt: "2026-08-01T08:00:00.000Z" }),
    ]);
    await expect(repository.pruneExpired(now)).resolves.toEqual(["stale"]);
    expect((await database.reviewCoachInteractionSegments.toArray()).map((segment) => segment.id)).toEqual(["fresh"]);
  });

  it("survives the schema upgrade alongside existing formal facts", async () => {
    await database.blocks.put({
      id: "record-1",
      type: "record",
      date: "2026-09-15",
      order: 0,
      subject: "Data Structures",
      title: "BFS",
      contentHtml: "<p>BFS uses a queue.</p>",
      assets: [],
      formulas: [],
      mistakeRefs: [],
      tags: [],
      createdAt: "2026-09-15T08:00:00.000Z",
      updatedAt: "2026-09-15T08:00:00.000Z",
    });
    await database.decisionBlocks.put(structuredClone(coachTestBlock));
    await repository.append([localSegment()]);

    // Reopening exercises the migration path up to the current schema version.
    database.close();
    await database.open();

    expect(database.verno).toBe(REVIEW_COACH_SCHEMA_VERSION);
    expect(await database.reviewCoachInteractionSegments.count()).toBe(1);
    expect(await database.decisionBlocks.count()).toBe(1);
    expect(await database.blocks.count()).toBe(1);
  });
});
