import Dexie from "dexie";
import { indexedDB, IDBKeyRange } from "fake-indexeddb";
import { beforeEach, afterEach, describe, it, expect, vi } from "vitest";
import { DEFAULT_SETTINGS } from "../../db/defaults";
import type { RecordBlock } from "../../types";
import { projectReviewMarks, validateReviewMarkEvents } from "./domain";
import { markTestEvent, markTestStamp as stamp, markTestValue as value } from "./fixtures";
vi.mock("../../services/autoBackupService", () => ({ markAutoBackupDirty: vi.fn(), setAutoBackupSuspended: vi.fn() }));
Dexie.dependencies.indexedDB = indexedDB; Dexie.dependencies.IDBKeyRange = IDBKeyRange;
const { db } = await import("../../db/database");
const { storage } = await import("../../services/storageAdapter");
const { ReviewMarkRepository } = await import("./repository");
const { exportCloudSync, materializeCloudSyncSnapshot, mergeCloudSyncEntities } = await import("../../services/cloudSyncModel");
const { snapshotToZip, zipToSnapshot } = await import("../../services/backup");
const record: RecordBlock = { id: "mark-record", type: "record", date: "2026-10-11", subject: "数学", title: "印记", favorite: false, contentHtml: "<p>这里需要巩固的内容</p>", assets: [], formulas: [], tags: [], mistakeRefs: [], order: 0, createdAt: stamp, updatedAt: stamp };
const repository = new ReviewMarkRepository(db);
beforeEach(async () => { await db.open(); await db.settings.put(DEFAULT_SETTINGS); await db.blocks.put(record); });
afterEach(async () => { await db.delete(); });

describe("permanent review mark facts", () => {
  it("persists across reopen without changing source or scheduling and advances the mutation epoch", async () => {
    await repository.write(record.id, stamp, value, "mark", [], "first");
    expect((await db.cloudSyncMutation.get("local"))?.epoch).toBe(1);
    db.close(); await db.open();
    expect(await db.reviewMarkEvents.count()).toBe(1);
    expect(await db.blocks.get(record.id)).toEqual(record);
    expect(await db.recordReviews.count()).toBe(0); expect(await db.recordReviewLogs.count()).toBe(0);
  });
  it("stores erasure and explicit undo as causal events", async () => {
    await repository.write(record.id, stamp, value, "mark", [], "first");
    await repository.write(record.id, stamp, null, "mark", ["first"], "erase");
    expect(projectReviewMarks(await db.reviewMarkEvents.toArray())[0].value).toBeNull();
    await repository.write(record.id, stamp, value, "mark", ["erase"], "undo");
    expect(projectReviewMarks(await db.reviewMarkEvents.toArray())[0].value).toEqual(value);
    expect(await db.reviewMarkEvents.count()).toBe(3);
  });
  it("rejects stale branches, revisions and deleted records without additional writes", async () => {
    await repository.write(record.id, stamp, value, "mark", [], "first");
    await expect(repository.write(record.id, stamp, null, "mark", [])).rejects.toThrow("印记已");
    await expect(repository.write(record.id, "old", value)).rejects.toThrow("日志内容");
    await db.blocks.update(record.id, { deletedAt: stamp });
    await expect(repository.write(record.id, stamp, value)).rejects.toThrow("日志内容");
    expect(await db.reviewMarkEvents.count()).toBe(1);
  });
  it("is idempotent for an identical operation and rejects identity reuse", async () => {
    await repository.write(record.id, stamp, value, "mark", [], "first");
    await repository.write(record.id, stamp, value, "mark", [], "first");
    await expect(repository.write(record.id, stamp, null, "mark", [], "first")).rejects.toThrow("身份");
    expect(await db.reviewMarkEvents.count()).toBe(1); expect((await db.cloudSyncMutation.get("local"))?.epoch).toBe(1);
  });
  it("merges independent offline branches, with erase-wins visibility and explicit conflict resolution", async () => {
    const base = markTestEvent(); const changed = markTestEvent("changed", [base.id], { ...value, color: "blue" }); const erased = markTestEvent("erased", [base.id], null);
    const initial = await storage.createSnapshot();
    const deviceA = await exportCloudSync({ ...initial, payload: { ...initial.payload, reviewMarkEvents: [base, changed] } });
    const deviceB = await exportCloudSync({ ...initial, payload: { ...initial.payload, reviewMarkEvents: [base, erased, { ...markTestEvent("other-event"), markId: "other" }] } });
    await storage.restoreCloudSyncSnapshot(materializeCloudSyncSnapshot(mergeCloudSyncEntities(deviceA.entities, deviceB.entities), [], new Map()));
    const projections = projectReviewMarks(await db.reviewMarkEvents.toArray());
    expect(projections).toHaveLength(2);
    expect(projections.find(mark => mark.markId === "mark")).toMatchObject({ conflict: true, value: null });
    await repository.write(record.id, stamp, value, "mark", [changed.id, erased.id]);
    expect(projectReviewMarks(await db.reviewMarkEvents.toArray()).find(mark => mark.markId === "mark")).toMatchObject({ conflict: false, value });
  });
  it("round trips version 8 zip including erasure history", async () => {
    await db.reviewMarkEvents.bulkPut([markTestEvent(), markTestEvent("erase", ["mark-event"], null)]);
    const snapshot = await storage.createSnapshot(); const stream = await storage.createStreamableSnapshot();
    expect(snapshot.payload.manifest.version).toBe(8); expect(stream.payload.reviewMarkEvents).toEqual(snapshot.payload.reviewMarkEvents);
    const archive = await snapshotToZip(snapshot);
    const restored = await zipToSnapshot(new File([archive], "marks.zip", { type: "application/zip" }));
    await db.reviewMarkEvents.clear(); await storage.restoreSnapshot(restored);
    expect(await db.reviewMarkEvents.toArray()).toEqual(snapshot.payload.reviewMarkEvents);
  });
  it("restores streamable marks and rejects broken ancestry before replacing data", async () => {
    await db.reviewMarkEvents.put(markTestEvent()); const snapshot = await storage.createStreamableSnapshot();
    await db.reviewMarkEvents.clear(); await storage.restoreStreamableSnapshot(snapshot, async () => undefined);
    expect(await db.reviewMarkEvents.count()).toBe(1);
    snapshot.payload.reviewMarkEvents![0].parents = ["missing"];
    await expect(storage.restoreStreamableSnapshot(snapshot, async () => undefined)).rejects.toThrow("印记");
    expect(await db.blocks.get(record.id)).toEqual(record);
  });
  it("preserves marks on legacy restore, distinguishes explicit empty and rejects missing v8 data", async () => {
    await db.reviewMarkEvents.put(markTestEvent()); const snapshot = await storage.createSnapshot();
    delete snapshot.payload.reviewMarkEvents;
    await expect(storage.restoreSnapshot(snapshot)).rejects.toThrow("印记");
    snapshot.payload.manifest.version = 7; await storage.restoreSnapshot(snapshot); expect(await db.reviewMarkEvents.count()).toBe(1);
    snapshot.payload.reviewMarkEvents = []; await storage.restoreSnapshot(snapshot); expect(await db.reviewMarkEvents.count()).toBe(0);
  });
  it("keeps permanent marks through rating, review reset, removal and re-add", async () => {
    await db.reviewMarkEvents.put(markTestEvent());
    await storage.addRecordToReview(record.id);
    await storage.rateRecordReview(record.id, "good");
    await storage.resetRecordReview(record.id);
    await storage.removeRecordFromReview(record.id);
    await storage.addRecordToReview(record.id);
    expect(await db.reviewMarkEvents.toArray()).toEqual([markTestEvent()]);
  });
  it("rejects broken marks before cloud export", async () => {
    const snapshot = await storage.createSnapshot();
    snapshot.payload.reviewMarkEvents = [markTestEvent("orphan", ["absent"])];
    await expect(exportCloudSync(snapshot)).rejects.toThrow("印记");
  });
  it("purges mark history only with permanent journal deletion", async () => {
    await db.reviewMarkEvents.put(markTestEvent());
    await storage.permanentlyDeleteBlocks([record.id]);
    expect(await db.reviewMarkEvents.count()).toBe(0);
  });
});

describe("mark event integrity", () => {
  it.each(["missing-parent", "cycle", "different-record", "duplicate", "invalid-style", "missing-value"])("rejects %s", mode => {
    const first = markTestEvent(); const next = markTestEvent("next", [first.id]); const events = [first, next];
    if (mode === "missing-parent") next.parents = ["missing"];
    if (mode === "cycle") first.parents = [next.id];
    if (mode === "different-record") next.recordId = "different";
    if (mode === "duplicate") next.id = first.id;
    if (mode === "invalid-style") next.value = { ...value, color: "bad" as typeof value.color };
    if (mode === "missing-value") delete (next as Partial<typeof next>).value;
    expect(() => validateReviewMarkEvents(events)).toThrow("印记");
  });
});
