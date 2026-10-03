import Dexie from "dexie";
import { indexedDB, IDBKeyRange } from "fake-indexeddb";
import { beforeEach, afterEach, describe, it, expect, vi } from "vitest";

import type { RecordBlock } from "../../types";

import { buildAnalysisPlanningBlocks } from "../reviewCoach/analysisPlanner";
import { EMPTY_REVIEW_COACH_FORMAL_SNAPSHOT } from "../reviewCoach/domain";
import { coachTestBlock, coachTestFeedback, coachTestQueueItem } from "../reviewCoach/reviewCoachTestFixtures";
vi.mock("../../services/autoBackupService", () => ({ markAutoBackupDirty: vi.fn(), setAutoBackupSuspended: vi.fn() }));
Dexie.dependencies.indexedDB = indexedDB; Dexie.dependencies.IDBKeyRange = IDBKeyRange;
const { db } = await import("../../db/database");
const { saveCardFeedback } = await import("./cardFeedback");
const stamp = "2026-10-03T00:00:00.000Z";
const record: RecordBlock = { id: "record-1", type: "record", date: "2026-10-03", subject: "算法", title: "快速排序", contentHtml: '<record-decision-block data-decision-block-id="decision-block-1" data-content-version="1"><p>分区边界</p></record-decision-block>', assets: [], formulas: [], mistakeRefs: [], tags: [], createdAt: stamp, updatedAt: stamp, order: 0 };
const input = { decisionBlockId: "decision-block-1", contentVersion: 1, comment: "分区边界容易混淆", includeInAnalysis: true, operationId: "unused" };
beforeEach(async () => { await db.open(); await db.blocks.put(record); await db.decisionBlocks.put({ ...coachTestBlock, contentUpdatedAt: stamp }); await db.arrangedReviews.put({ id: "round", title: "排序", items: [{ recordId: record.id, title: record.title, source: "排序", contentRevision: stamp }], createdAt: stamp, updatedAt: stamp }); });
afterEach(async () => { await db.delete(); });
describe("explicit card feedback", () => {
  it("deduplicates analyze-before-score and retry without ordinary rating events", async () => { const first = await saveCardFeedback(record, [input], "round", { id: "round", title: "排序" }); const second = await saveCardFeedback(record, [{ ...input, operationId: "retry" }], "round", { id: "round", title: "排序" }); expect(second[0].id).toBe(first[0].id); expect(await db.analysisQueueItems.count()).toBe(1); expect(await db.recordReviewLogs.count()).toBe(0); expect(await db.recordReviews.count()).toBe(0); expect(first[0]).toMatchObject({ originRoundId: "round", originRoundTitle: "排序" }); });
  it("records independent feedback for distinct rounds instead of replacing", async () => { await db.arrangedReviews.put({ id: "other", title: "再练", items: [{ recordId: record.id, title: record.title, source: "排序", contentRevision: stamp }], createdAt: stamp, updatedAt: stamp }); await saveCardFeedback(record, [input], "round", { id: "round", title: "排序" }); await saveCardFeedback(record, [input], "other", { id: "other", title: "再练" }); expect(await db.decisionBlockFeedback.count()).toBe(2); });
  it("does not create a queue for opted-out feedback or invent empty feedback", async () => { await saveCardFeedback(record, [{ ...input, includeInAnalysis: false }, { ...input, comment: " " }], "round"); expect(await db.decisionBlockFeedback.count()).toBe(1); expect(await db.analysisQueueItems.count()).toBe(0); });
  it("rejects a stale content revision and deleted round atomically", async () => { await expect(saveCardFeedback({ ...record, updatedAt: "old" }, [input], "round")).rejects.toThrow(); await db.arrangedReviews.update("round", { deletedAt: stamp }); await expect(saveCardFeedback(record, [input], "round", { id: "round", title: "排序" })).rejects.toThrow(); expect(await db.decisionBlockFeedback.count()).toBe(0); });
  it("rolls back all feedback when one block version is invalid", async () => { await expect(saveCardFeedback(record, [input, { ...input, decisionBlockId: "missing" }], "round")).rejects.toThrow(); expect(await db.decisionBlockFeedback.count()).toBe(0); expect(await db.analysisQueueItems.count()).toBe(0); });
  it("limits analysis input to the explicitly selected feedback even on the same block", () => { const snapshot = { ...structuredClone(EMPTY_REVIEW_COACH_FORMAL_SNAPSHOT), decisionBlocks: [coachTestBlock], decisionBlockFeedback: [coachTestFeedback, { ...coachTestFeedback, id: "other-feedback", comment: "历史反馈" }], analysisQueueItems: [{ ...coachTestQueueItem, status: "eligible" as const }, { ...coachTestQueueItem, id: "other-queue", feedbackId: "other-feedback", status: "eligible" as const }] }; const blocks = buildAnalysisPlanningBlocks({ snapshot, records: [record], assets: [], onlyFeedbackIds: new Set([coachTestFeedback.id]) }); expect(blocks).toHaveLength(1); expect(blocks[0].feedback.map(item => item.id)).toEqual([coachTestFeedback.id]); expect(blocks[0].inputRefs.map(item => item.feedbackId)).toEqual([coachTestFeedback.id]); });
});
