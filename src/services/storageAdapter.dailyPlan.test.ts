import Dexie from "dexie";
import { IDBKeyRange, indexedDB } from "fake-indexeddb";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { StudyJournalDatabase } from "../db/database";
import { createBaseEntity } from "../lib/entity";
import type { DailyPlan, RecordBlock, RecordDraft } from "../types";

Dexie.dependencies.indexedDB = indexedDB;
Dexie.dependencies.IDBKeyRange = IDBKeyRange;

const STAMP = "2026-09-16T00:00:00.000Z";

let database: StudyJournalDatabase;
let adapter: InstanceType<typeof import("./storageAdapter").DexieStorageAdapter>;

beforeEach(async () => {
  vi.resetModules();
  database = new StudyJournalDatabase(`storage-daily-plan-${crypto.randomUUID()}`);
  await database.open();
  vi.doMock("../db/database", () => ({ db: database }));
  const { DexieStorageAdapter } = await import("./storageAdapter");
  adapter = new DexieStorageAdapter();
});

afterEach(async () => {
  const name = database.name;
  database.close();
  await Dexie.delete(name);
});

const plan = (overrides: Partial<DailyPlan> = {}): DailyPlan => ({
  ...createBaseEntity(),
  date: "2026-09-16",
  subject: "数学",
  title: "三大计算 660 题",
  order: 0,
  ...overrides,
});

const record = (id: string, contentHtml: string, overrides: Partial<RecordBlock> = {}): RecordBlock => ({
  id,
  createdAt: STAMP,
  updatedAt: STAMP,
  type: "record",
  date: "2026-09-16",
  order: 0,
  subject: "数学",
  tags: [],
  title: "三大计算 660 题",
  contentHtml,
  assets: [],
  formulas: [],
  mistakeRefs: [],
  ...overrides,
});

const draftFor = (recordId: string): RecordDraft => ({
  id: recordId,
  recordId,
  baseUpdatedAt: STAMP,
  draft: record(recordId, "<p>半写的内容</p>"),
  updatedAt: STAMP,
});

describe("daily plan CRUD", () => {
  it("saves, lists and reads plans back in date then order sequence", async () => {
    await adapter.saveDailyPlan(plan({ id: "p2", date: "2026-09-16", order: 1 }));
    await adapter.saveDailyPlan(plan({ id: "p1", date: "2026-09-16", order: 0 }));
    await adapter.saveDailyPlan(plan({ id: "p3", date: "2026-09-17", order: 0 }));

    expect((await adapter.listDailyPlans()).map((item) => item.id)).toEqual(["p1", "p2", "p3"]);
    expect((await adapter.listDailyPlans("2026-09-16")).map((item) => item.id)).toEqual(["p1", "p2"]);
    expect(await adapter.getDailyPlan("p2")).toMatchObject({ title: "三大计算 660 题" });
    expect(await adapter.getDailyPlan("missing")).toBeUndefined();
  });

  it("marks a cloud-sync mutation before every plan write", async () => {
    const before = await adapter.getCloudSyncMutationEpoch();
    await adapter.saveDailyPlan(plan({ id: "p1" }));
    const afterSave = await adapter.getCloudSyncMutationEpoch();
    await adapter.linkPlanRecord("p1", "r1");
    const afterLink = await adapter.getCloudSyncMutationEpoch();
    await adapter.deleteDailyPlan("p1");
    const afterDelete = await adapter.getCloudSyncMutationEpoch();

    expect(afterSave).toBeGreaterThan(before);
    expect(afterLink).toBeGreaterThan(afterSave);
    expect(afterDelete).toBeGreaterThan(afterLink);
  });

  it("soft-deletes a plan and lists it only through listDeletedDailyPlans", async () => {
    await adapter.saveDailyPlan(plan({ id: "p1" }));
    await adapter.saveDailyPlan(plan({ id: "p2" }));
    await adapter.deleteDailyPlan("p1");

    expect((await adapter.listDailyPlans()).map((item) => item.id)).toEqual(["p2"]);
    // The filter direction matters as much as the contents: a live plan must
    // never leak into the deleted view.
    expect((await adapter.listDeletedDailyPlans()).map((item) => item.id)).toEqual(["p1"]);
    expect(await database.dailyPlans.get("p1")).toMatchObject({ deletedAt: expect.any(String) });
  });

  it("treats deleting an already-deleted plan as a no-op", async () => {
    await adapter.saveDailyPlan(plan({ id: "p1" }));
    await adapter.deleteDailyPlan("p1");
    const firstDeletedAt = (await database.dailyPlans.get("p1"))?.deletedAt;

    await adapter.deleteDailyPlan("p1");

    expect((await database.dailyPlans.get("p1"))?.deletedAt).toBe(firstDeletedAt);
  });

  it("links a plan to its record in both directions and short-circuits unchanged links", async () => {
    await adapter.saveDailyPlan(plan({ id: "p1" }));
    await adapter.linkPlanRecord("p1", "r1");
    expect(await adapter.getDailyPlan("p1")).toMatchObject({ linkedRecordId: "r1" });

    const epoch = await adapter.getCloudSyncMutationEpoch();
    await adapter.linkPlanRecord("p1", "r1");
    expect(await adapter.getCloudSyncMutationEpoch()).toBe(epoch);

    await adapter.linkPlanRecord("p1", undefined);
    expect(await adapter.getDailyPlan("p1")).toMatchObject({ linkedRecordId: undefined });
  });

  it("ignores link writes for a plan that does not exist", async () => {
    await adapter.linkPlanRecord("missing", "r1");
    expect(await database.dailyPlans.count()).toBe(0);
  });
});

describe("deleting a plan never cascades (D9)", () => {
  it("keeps the log row, its planId and the link when the plan is deleted", async () => {
    await adapter.saveDailyPlan(plan({ id: "p1" }));
    await database.blocks.put(record("r1", "<p>正文</p>", { planId: "p1" }));
    await adapter.linkPlanRecord("p1", "r1");

    await adapter.deleteDailyPlan("p1");

    const log = await database.blocks.get("r1");
    expect(log).toMatchObject({ planId: "p1" });
    expect(log?.deletedAt).toBeUndefined();
    expect(await adapter.getDailyPlan("p1")).toMatchObject({ linkedRecordId: "r1" });
    // The record still resolves to a plan row, which is what lets the editor
    // render "[来自计划·已删除] 数学 · 三大计算 660 题" instead of a bare tag.
    expect((await adapter.listDeletedDailyPlans()).map((item) => item.id)).toEqual(["p1"]);
  });

  it("still reclaims the empty shell of a deleted plan but keeps a fulfilled log", async () => {
    await adapter.saveDailyPlan(plan({ id: "empty-plan" }));
    await adapter.saveDailyPlan(plan({ id: "written-plan" }));
    await database.blocks.put(record("shell", "", { planId: "empty-plan" }));
    await database.blocks.put(record("written", "<p>正文</p>", { planId: "written-plan" }));
    await adapter.linkPlanRecord("empty-plan", "shell");
    await adapter.linkPlanRecord("written-plan", "written");

    await adapter.deleteDailyPlan("empty-plan");
    await adapter.deleteDailyPlan("written-plan");
    const reclaimed = await adapter.reclaimEmptyPlanRecords();

    expect(reclaimed).toEqual(["shell"]);
    expect(await database.blocks.get("shell")).toBeUndefined();
    expect(await database.blocks.get("written")).toMatchObject({ planId: "written-plan" });
    // Deleted plans must not be written back - that would be a pointless sync delta.
    expect((await database.dailyPlans.get("empty-plan"))?.linkedRecordId).toBe("shell");
    expect((await database.dailyPlans.get("written-plan"))?.linkedRecordId).toBe("written");
  });
});

describe("empty plan record reclaim", () => {
  it("reclaims a record the user opened but never wrote to, and unlinks the plan", async () => {
    await adapter.saveDailyPlan(plan({ id: "p1" }));
    await database.blocks.put(record("r1", ""));
    await adapter.linkPlanRecord("p1", "r1");

    const reclaimed = await adapter.reclaimEmptyPlanRecords();

    expect(reclaimed).toEqual(["r1"]);
    expect(await database.blocks.get("r1")).toBeUndefined();
    expect((await adapter.getDailyPlan("p1"))?.linkedRecordId).toBeUndefined();
  });

  it("keeps a record that has content", async () => {
    await adapter.saveDailyPlan(plan({ id: "p1" }));
    await database.blocks.put(record("r1", "<p>今天做了三道题</p>"));
    await adapter.linkPlanRecord("p1", "r1");

    expect(await adapter.reclaimEmptyPlanRecords()).toEqual([]);
    expect(await database.blocks.get("r1")).toMatchObject({ id: "r1" });
  });

  it("keeps a record whose content is only an image, a formula or a tag", async () => {
    await adapter.saveDailyPlan(plan({ id: "p1" }));
    await database.blocks.put(record("image-only", "", { assets: [{ id: "a1", title: "草稿纸", kind: "image" }] }));
    await database.blocks.put(record("formula-only", "", { formulas: [{ id: "f1", latex: "x^2" }] }));
    await database.blocks.put(record("tag-only", "", { tags: ["错题"] }));
    await adapter.linkPlanRecord("p1", "image-only");
    await adapter.saveDailyPlan(plan({ id: "p2", order: 1 }));
    await adapter.linkPlanRecord("p2", "formula-only");
    await adapter.saveDailyPlan(plan({ id: "p3", order: 2 }));
    await adapter.linkPlanRecord("p3", "tag-only");

    expect(await adapter.reclaimEmptyPlanRecords()).toEqual([]);
    expect(await database.blocks.count()).toBe(3);
  });

  it("never reclaims a record that has a local draft", async () => {
    await adapter.saveDailyPlan(plan({ id: "p1" }));
    await database.blocks.put(record("r1", ""));
    await database.recordDrafts.put(draftFor("r1"));
    await adapter.linkPlanRecord("p1", "r1");

    expect(await adapter.reclaimEmptyPlanRecords()).toEqual([]);
    expect(await database.blocks.get("r1")).toBeDefined();
    expect(await database.recordDrafts.get("r1")).toBeDefined();
  });

  it("honours skipRecordIds so an in-flight draft flush cannot be deleted", async () => {
    await adapter.saveDailyPlan(plan({ id: "p1" }));
    await database.blocks.put(record("r1", ""));
    await adapter.linkPlanRecord("p1", "r1");

    expect(await adapter.reclaimEmptyPlanRecords({ skipRecordIds: ["r1"] })).toEqual([]);
    expect(await database.blocks.get("r1")).toBeDefined();

    // Once the flush settles the caller stops skipping, and the record goes.
    expect(await adapter.reclaimEmptyPlanRecords({ skipRecordIds: [] })).toEqual(["r1"]);
  });

  it("never reclaims a record that already entered the review queue", async () => {
    await adapter.saveDailyPlan(plan({ id: "p1" }));
    await database.blocks.put(record("r1", ""));
    await database.recordReviews.put({
      id: "r1",
      recordId: "r1",
      createdAt: STAMP,
      updatedAt: STAMP,
      status: "active",
      easeFactor: 2.5,
      repetition: 0,
      intervalDays: 0,
      consecutiveRemembered: 0,
      totalReviews: 0,
    });
    await adapter.linkPlanRecord("p1", "r1");

    expect(await adapter.reclaimEmptyPlanRecords()).toEqual([]);
    expect(await database.blocks.get("r1")).toBeDefined();
  });

  it("is idempotent: a second pass finds nothing to do", async () => {
    await adapter.saveDailyPlan(plan({ id: "p1" }));
    await database.blocks.put(record("r1", ""));
    await adapter.linkPlanRecord("p1", "r1");

    expect(await adapter.reclaimEmptyPlanRecords()).toEqual(["r1"]);
    expect(await adapter.reclaimEmptyPlanRecords()).toEqual([]);
  });

  it("scopes candidates to planIds when given, and ignores non-record blocks", async () => {
    await adapter.saveDailyPlan(plan({ id: "p1" }));
    await adapter.saveDailyPlan(plan({ id: "p2", order: 1 }));
    await database.blocks.put(record("r1", ""));
    await database.blocks.put(record("r2", ""));
    await database.blocks.put({
      id: "rich",
      createdAt: STAMP,
      updatedAt: STAMP,
      type: "richText",
      date: "2026-09-16",
      order: 1,
      content: "<p>不是日志的块</p>",
    });
    await adapter.linkPlanRecord("p1", "r1");
    await adapter.linkPlanRecord("p2", "r2");

    expect(await adapter.reclaimEmptyPlanRecords({ planIds: ["p1"] })).toEqual(["r1"]);
    expect(await database.blocks.get("r2")).toBeDefined();
    expect(await database.blocks.get("rich")).toBeDefined();
  });

  it("skips a soft-deleted record instead of resurrecting a reclaim", async () => {
    await adapter.saveDailyPlan(plan({ id: "p1" }));
    await database.blocks.put(record("r1", "", { deletedAt: STAMP }));
    await adapter.linkPlanRecord("p1", "r1");

    expect(await adapter.reclaimEmptyPlanRecords()).toEqual([]);
    expect((await adapter.getDailyPlan("p1"))?.linkedRecordId).toBe("r1");
  });
});

describe("batch physical delete", () => {
  it("deletes several records, their drafts and their review rows in one pass", async () => {
    await database.blocks.put(record("r1", ""));
    await database.blocks.put(record("r2", ""));
    await database.recordDrafts.put(draftFor("r1"));
    await database.recordReviewLogs.put({
      id: "log-1",
      recordId: "r1",
      reviewedAt: STAMP,
      rating: "good",
      previousEaseFactor: 2.5,
      nextEaseFactor: 2.5,
      previousRepetition: 0,
      nextRepetition: 1,
      previousIntervalDays: 0,
      nextIntervalDays: 1,
      createdAt: STAMP,
      updatedAt: STAMP,
    });

    await adapter.permanentlyDeleteBlocks(["r1", "r2"]);

    expect(await database.blocks.count()).toBe(0);
    expect(await database.recordDrafts.count()).toBe(0);
    expect(await database.recordReviewLogs.count()).toBe(0);
  });

  it("is equivalent to deleting one at a time when the batch holds a single id", async () => {
    await database.blocks.put(record("single", ""));
    await adapter.permanentlyDeleteBlock("single");
    expect(await database.blocks.get("single")).toBeUndefined();

    // Empty and unknown inputs must not throw.
    await adapter.permanentlyDeleteBlocks([]);
    await adapter.permanentlyDeleteBlocks(["never-existed"]);
    expect(await database.blocks.count()).toBe(0);
  });

  it("purges every expired soft-deleted record through the batch path", async () => {
    const expired = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000).toISOString();
    await database.blocks.put(record("old", "", { deletedAt: expired }));
    await database.blocks.put(record("fresh", "", { deletedAt: new Date().toISOString() }));

    expect(await adapter.purgeExpiredDeletedBlocks(30)).toBe(1);
    expect(await database.blocks.get("old")).toBeUndefined();
    expect(await database.blocks.get("fresh")).toBeDefined();
  });
});

describe("snapshots carry every plan row", () => {
  it("includes soft-deleted plans so the tombstone can propagate", async () => {
    await adapter.saveDailyPlan(plan({ id: "p1" }));
    await adapter.saveDailyPlan(plan({ id: "p2", order: 1 }));
    await adapter.deleteDailyPlan("p2");

    const snapshot = await adapter.createSnapshot();

    expect(snapshot.payload.dailyPlans?.map((item) => item.id).sort()).toEqual(["p1", "p2"]);
    expect(snapshot.payload.manifest.counts.dailyPlans).toBe(2);
    expect(snapshot.payload.dailyPlans?.find((item) => item.id === "p2")?.deletedAt).toEqual(expect.any(String));
  });

  it("always writes the field, even when there are no plans at all", async () => {
    const snapshot = await adapter.createStreamableSnapshot();

    expect(Array.isArray(snapshot.payload.dailyPlans)).toBe(true);
    expect(snapshot.payload.dailyPlans).toEqual([]);
    expect(snapshot.payload.manifest.counts.dailyPlans).toBe(0);
  });

  it("keeps the cloud-sync snapshot alias pointing at the same payload", async () => {
    await adapter.saveDailyPlan(plan({ id: "p1" }));

    const snapshot = await adapter.createCloudSyncSnapshot();

    expect(snapshot.payload.dailyPlans?.map((item) => item.id)).toEqual(["p1"]);
  });
});
