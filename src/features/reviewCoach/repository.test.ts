import Dexie from "dexie";
import { IDBKeyRange, indexedDB } from "fake-indexeddb";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { StudyJournalDatabase } from "../../db/database";
import { hashValue, syncHashPayload } from "../../services/cloudSyncModel";
import type { RecordBlock } from "../../types";
import type { AdaptiveReviewTask, DecisionBlock } from "./domain";
import { DexieReviewCoachRepository, purgeReviewCoachFactsForRecord, restoreReviewCoachFormalSnapshot, reviewCoachFormalTables, reviewCoachRestoreTables } from "./repository";
import {
  coachTestAnswerOutcome,
  coachTestBatch,
  coachTestBlock,
  coachTestBlueprint,
  coachTestFeedback,
  coachTestInterpretation,
  coachTestMasteredOutcome,
  coachTestCompletedDisposition,
  coachTestQueueItem,
  coachTestStamp,
  coachTestTask,
  coachTestTurn,
  coachTestVerification,
  completeCoachTestSnapshot,
} from "./reviewCoachTestFixtures";
import { ReviewCoachValidationError } from "./validation";
import { prepareDecisionBlockContentForSave } from "./decisionBlockContent";
import { ReviewCoachOrchestrator } from "./orchestrator";

Dexie.dependencies.indexedDB = indexedDB;
Dexie.dependencies.IDBKeyRange = IDBKeyRange;

const record: RecordBlock = {
  id: "record-1",
  createdAt: coachTestStamp,
  updatedAt: coachTestStamp,
  type: "record",
  date: "2026-09-04",
  order: 0,
  subject: "Data Structures",
  title: "BFS",
  contentHtml: "<p>BFS uses a queue.</p>",
  assets: [],
  formulas: [],
  mistakeRefs: [],
  tags: [],
};

describe("DexieReviewCoachRepository", () => {
  let database: StudyJournalDatabase;
  let repository: DexieReviewCoachRepository;

  beforeEach(async () => {
    database = new StudyJournalDatabase(`review-coach-repository-${crypto.randomUUID()}`);
    await database.open();
    await database.blocks.put(record);
    repository = new DexieReviewCoachRepository(database);
  });

  afterEach(async () => {
    const name = database.name;
    database.close();
    await Dexie.delete(name);
  });

  it.each(["eligible", "excluded", "batched", "consumed", "deleted"] as const)("does not rewrite %s queue state or sync hashes on a repeated transition", async (status) => {
    await database.transaction("rw", reviewCoachRestoreTables(database), () => restoreReviewCoachFormalSnapshot(database, completeCoachTestSnapshot()));
    const item = {
      ...coachTestQueueItem, status,
      excludedAt: status === "excluded" ? coachTestStamp : undefined,
      deletedAt: status === "deleted" ? coachTestStamp : undefined,
    };
    await database.analysisQueueItems.put(item);
    const mutationBefore = await database.cloudSyncMutation.toArray();
    const hashBefore = await hashValue(syncHashPayload("analysis-queue-item", item));
    const returned = await repository.transitionQueueItem(item.id, status, "2026-09-21T10:00:00.000Z", status === "batched" ? item.batchId : undefined);
    expect(returned).toEqual(item);
    expect(await database.analysisQueueItems.get(item.id)).toEqual(item);
    expect(await database.cloudSyncMutation.toArray()).toEqual(mutationBefore);
    expect(await hashValue(syncHashPayload("analysis-queue-item", returned))).toBe(hashBefore);
  });

  it("does not mark an unchanged analysis note or already clean eligible queue as a mutation", async () => {
    await database.transaction("rw", reviewCoachRestoreTables(database), () => restoreReviewCoachFormalSnapshot(database, completeCoachTestSnapshot()));
    const item = { ...coachTestQueueItem, status: "eligible" as const, batchId: undefined, consumedAt: undefined, analysisNote: "keep the evidence" };
    await database.analysisQueueItems.put(item);
    const mutationBefore = await database.cloudSyncMutation.toArray();
    expect(await repository.updateQueueItemAnalysisNote(item.id, "  keep the evidence  ", "2026-09-21T10:00:00.000Z")).toEqual(item);
    expect(await repository.requeueAnalysisQueueItem(item.id, "2026-09-21T10:00:00.000Z")).toEqual(item);
    expect(await database.cloudSyncMutation.toArray()).toEqual(mutationBefore);
  });

  it("still records genuine queue edits and explicit retries of consumed work", async () => {
    await database.transaction("rw", reviewCoachRestoreTables(database), () => restoreReviewCoachFormalSnapshot(database, completeCoachTestSnapshot()));
    await database.analysisQueueItems.put(coachTestQueueItem);
    const stamp = "2026-09-21T10:00:00.000Z";
    const requeued = await repository.requeueAnalysisQueueItem(coachTestQueueItem.id, stamp);
    expect(requeued).toMatchObject({ status: "eligible", updatedAt: stamp });
    expect(requeued.batchId).toBeUndefined();
    expect(requeued.consumedAt).toBeUndefined();
    const mutationBefore = await database.cloudSyncMutation.toArray();
    const edited = await repository.updateQueueItemAnalysisNote(coachTestQueueItem.id, " new user note ", stamp);
    expect(edited.analysisNote).toBe("new user note");
    expect(await database.cloudSyncMutation.toArray()).not.toEqual(mutationBefore);
    const excluded = await repository.transitionQueueItem(coachTestQueueItem.id, "excluded", stamp);
    expect(excluded).toMatchObject({ status: "excluded", excludedAt: stamp });
  });

  it("preserves terminal task and verification evidence timestamps on identical retries", async () => {
    const snapshot = completeCoachTestSnapshot();
    await database.transaction("rw", reviewCoachRestoreTables(database), () => restoreReviewCoachFormalSnapshot(database, snapshot));
    const task = (await database.adaptiveReviewTasks.get(coachTestTask.id))!;
    const verification = (await database.delayedVerifications.get(coachTestVerification.id))!;
    const mutation = await database.cloudSyncMutation.toArray();
    expect(await repository.transitionTask(task.id, task.status, "2026-09-21T10:00:00.000Z")).toEqual(task);
    expect(await repository.transitionVerification(verification.id, verification.status, "2026-09-21T10:00:00.000Z", verification.verificationOutcome)).toEqual(verification);
    expect(await database.cloudSyncMutation.toArray()).toEqual(mutation);
    const changedReason = await repository.transitionTask(task.id, task.status, "2026-09-21T10:00:00.000Z", "explicit reason");
    expect(changedReason.terminalReason).toBe("explicit reason");
    expect(changedReason.endedAt).toBe(task.endedAt);
  });

  it.each(["succeeded", "pending", "failed"] as const)("rejects a stale %s response after a synced interpretation replaces its request", async (status) => {
    await database.transaction("rw", reviewCoachRestoreTables(database), () => restoreReviewCoachFormalSnapshot(database, completeCoachTestSnapshot()));
    const running = { ...coachTestInterpretation, status: "running" as const };
    await database.feedbackInterpretations.put(running);
    const remote = { ...coachTestInterpretation, userConfirmedAt: "2026-09-21T09:00:00.000Z", stuckAt: "synced user correction" };
    await database.feedbackInterpretations.put(remote);
    const mutation = await database.cloudSyncMutation.toArray();
    await expect(repository.saveFeedbackInterpretation({ ...running, status, updatedAt: "2026-09-21T10:00:00.000Z" }, running)).rejects.toMatchObject({ code: "stale-feedback-interpretation" });
    expect(await database.feedbackInterpretations.get(remote.id)).toEqual(remote);
    expect(await database.cloudSyncMutation.toArray()).toEqual(mutation);
  });

  it("accepts a current interpretation response but never resurrects a removed request", async () => {
    await database.transaction("rw", reviewCoachRestoreTables(database), () => restoreReviewCoachFormalSnapshot(database, completeCoachTestSnapshot()));
    const running = { ...coachTestInterpretation, status: "running" as const };
    await database.feedbackInterpretations.put(running);
    expect(await repository.saveFeedbackInterpretation(coachTestInterpretation, running)).toEqual(coachTestInterpretation);
    await database.feedbackInterpretations.delete(running.id);
    const mutation = await database.cloudSyncMutation.toArray();
    await expect(repository.saveFeedbackInterpretation(coachTestInterpretation, running)).rejects.toMatchObject({ code: "stale-feedback-interpretation" });
    expect(await database.feedbackInterpretations.count()).toBe(0);
    expect(await database.cloudSyncMutation.toArray()).toEqual(mutation);
    const pending = { ...running, status: "pending" as const };
    expect(await repository.saveFeedbackInterpretation(pending, null)).toEqual(pending);
    await expect(repository.saveFeedbackInterpretation(pending, null)).rejects.toMatchObject({ code: "stale-feedback-interpretation" });
  });
  it.each(["success", "failure", "abort"] as const)("does not overwrite a synced result when an old AI request ends with %s", async (ending) => {
    await database.transaction("rw", reviewCoachRestoreTables(database), () => restoreReviewCoachFormalSnapshot(database, completeCoachTestSnapshot()));
    await database.feedbackInterpretations.put({ ...coachTestInterpretation, status: "pending" });
    const controller = new AbortController();
    const remote = { ...coachTestInterpretation, stuckAt: "synced answer", userConfirmedAt: "2026-09-21T09:00:00.000Z" };
    let mutationAfterSync: unknown;
    const interpretFeedback = vi.fn(async () => {
      await database.feedbackInterpretations.put(remote);
      mutationAfterSync = await database.cloudSyncMutation.toArray();
      if (ending === "abort") {
        controller.abort();
        throw new DOMException("cancelled", "AbortError");
      }
      if (ending === "failure") throw new Error("provider failed");
      return { response: { status: "ok" as const, actionability: "needs_training" as const, difficultyType: "procedure" as const, stuckAt: "stale answer", userHypothesis: null, preferredPractice: null, missingInformation: [], confidence: 0.9 } };
    });
    const orchestrator = new ReviewCoachOrchestrator({
      repository, ids: { next: () => "unused" }, clock: { now: () => "2026-09-21T10:00:00.000Z" },
      aiGateway: { interpretFeedback, planSession: vi.fn(), generateTurn: vi.fn(), reviewQuestion: vi.fn(), evaluateAnswer: vi.fn() },
    });
    await expect(orchestrator.interpretFeedback({ feedbackId: coachTestFeedback.id, decisionBlockContent: "source", provider: "test", model: "test", promptVersion: "test", policyVersion: "test", schemaVersion: 1, signal: controller.signal })).rejects.toMatchObject({ code: "stale-feedback-interpretation" });
    expect(interpretFeedback).toHaveBeenCalledTimes(1);
    expect(await database.feedbackInterpretations.get(remote.id)).toEqual(remote);
    expect(await database.cloudSyncMutation.toArray()).toEqual(mutationAfterSync);
  });

  it("writes feedback and its queue item atomically and retries idempotently", async () => {
    await repository.saveDecisionBlock(coachTestBlock);

    await repository.addFeedback(coachTestFeedback, { ...coachTestQueueItem, status: "eligible", batchId: undefined, consumedAt: undefined });
    await repository.addFeedback(coachTestFeedback, { ...coachTestQueueItem, status: "eligible", batchId: undefined, consumedAt: undefined });

    expect(await database.decisionBlockFeedback.count()).toBe(1);
    expect(await database.analysisQueueItems.count()).toBe(1);
    expect(await database.decisionBlockStates.get(coachTestBlock.id)).toMatchObject({ status: "needs-analysis" });
  });

  it("finalizes successful analysis inputs as consumed while preserving frozen input", async () => {
    await repository.saveDecisionBlock(coachTestBlock);
    await repository.addFeedback(coachTestFeedback, { ...coachTestQueueItem, status: "eligible", batchId: undefined, consumedAt: undefined });
    const inputRef = { queueItemId: coachTestQueueItem.id, feedbackId: coachTestFeedback.id, decisionBlockId: coachTestBlock.id, recordId: coachTestBlock.recordId, contentVersion: 1 };
    const draft = await repository.createAnalysisBatch({
      ...coachTestBatch,
      status: "draft",
      inputRefs: [inputRef],
      subBatches: [{ id: "sub-1", inputRefs: [inputRef], status: "pending", estimatedTokens: 500 }],
      requestedAt: undefined,
      completedAt: undefined,
      finalSummary: undefined,
    });
    await repository.transitionAnalysisBatch(draft.id, "confirmed", coachTestStamp);
    const running = await repository.transitionAnalysisBatch(draft.id, "running", coachTestStamp);
    const completed = await repository.updateAnalysisBatch({
      ...running,
      status: "succeeded",
      subBatches: [{ ...running.subBatches[0], status: "succeeded", totalTokens: 420 }],
      totalTokens: 420,
      updatedAt: coachTestStamp,
    });

    expect(completed.status).toBe("succeeded");
    expect(await database.analysisQueueItems.get(coachTestQueueItem.id)).toMatchObject({ status: "consumed", batchId: draft.id });
    await expect(repository.updateAnalysisBatch({ ...completed, inputFingerprint: "changed" })).rejects.toMatchObject({ code: "changed-analysis-input" });
  });

  it("rejects reuse of an idempotency key with different event content", async () => {
    await repository.saveDecisionBlock(coachTestBlock);
    await repository.addFeedback(coachTestFeedback, { ...coachTestQueueItem, status: "eligible", batchId: undefined, consumedAt: undefined });

    await expect(repository.addFeedback({ ...coachTestFeedback, comment: "Different fact" })).rejects.toMatchObject({
      code: "duplicate-event",
    });
    expect(await database.decisionBlockFeedback.count()).toBe(1);
  });

  it("excludes and restores an analysis queue item without retaining excludedAt", async () => {
    await repository.saveDecisionBlock(coachTestBlock);
    await repository.addFeedback(coachTestFeedback, { ...coachTestQueueItem, status: "eligible", batchId: undefined, consumedAt: undefined });

    const excluded = await repository.transitionQueueItem(coachTestQueueItem.id, "excluded", "2026-09-04T09:00:00.000Z");
    const restored = await repository.transitionQueueItem(coachTestQueueItem.id, "eligible", "2026-09-04T09:05:00.000Z");

    expect(excluded).toMatchObject({ status: "excluded", excludedAt: "2026-09-04T09:00:00.000Z" });
    expect(restored.status).toBe("eligible");
    expect(restored.excludedAt).toBeUndefined();
    expect(await database.decisionBlockStates.get(coachTestBlock.id)).toMatchObject({ status: "needs-analysis" });
  });

  it("saves, normalizes, and clears a queue item's one-time analysis note", async () => {
    await repository.saveDecisionBlock(coachTestBlock);
    await repository.addFeedback(coachTestFeedback, { ...coachTestQueueItem, status: "eligible", batchId: undefined, consumedAt: undefined });

    const saved = await repository.updateQueueItemAnalysisNote(coachTestQueueItem.id, "  Focus on visited timing.  ", "2026-09-04T09:00:00.000Z");
    const cleared = await repository.updateQueueItemAnalysisNote(coachTestQueueItem.id, "  ", "2026-09-04T09:05:00.000Z");

    expect(saved.analysisNote).toBe("Focus on visited timing.");
    expect(cleared.analysisNote).toBeUndefined();
    expect((await repository.getFormalSnapshot()).analysisQueueItems[0].analysisNote).toBeUndefined();
  });

  it("tombstones deleted feedback and its queue item in the synchronized snapshot", async () => {
    await repository.saveDecisionBlock(coachTestBlock);
    await repository.addFeedback(coachTestFeedback, { ...coachTestQueueItem, status: "eligible", batchId: undefined, consumedAt: undefined });

    await repository.deleteFeedback(coachTestFeedback.id, "2026-09-04T09:00:00.000Z");

    expect(await database.decisionBlockFeedback.get(coachTestFeedback.id)).toMatchObject({
      deletedAt: "2026-09-04T09:00:00.000Z",
    });
    expect(await database.analysisQueueItems.get(coachTestQueueItem.id)).toMatchObject({
      status: "deleted",
      deletedAt: "2026-09-04T09:00:00.000Z",
    });
    const snapshot = await repository.getFormalSnapshot();
    expect(snapshot.decisionBlockFeedback).toEqual([
      expect.objectContaining({ id: coachTestFeedback.id, deletedAt: "2026-09-04T09:00:00.000Z" }),
    ]);
    expect(snapshot.analysisQueueItems).toEqual([
      expect.objectContaining({ id: coachTestQueueItem.id, status: "deleted" }),
    ]);
  });

  it("rejects a feedback event for an old content version", async () => {
    await repository.saveDecisionBlock(coachTestBlock);
    await repository.saveDecisionBlock({
      ...coachTestBlock,
      contentVersion: 2,
      contentUpdatedAt: "2026-09-04T09:00:00.000Z",
      updatedAt: "2026-09-04T09:00:00.000Z",
    });

    await expect(repository.addFeedback(coachTestFeedback)).rejects.toMatchObject({
      code: "stale-content-version",
    });
    expect(await database.decisionBlockFeedback.count()).toBe(0);
  });

  it("marks open derived work stale when decision block content changes", async () => {
    await repository.saveDecisionBlock(coachTestBlock);
    await repository.addFeedback(coachTestFeedback, { ...coachTestQueueItem, status: "eligible", batchId: undefined, consumedAt: undefined });

    await repository.saveDecisionBlock({
      ...coachTestBlock,
      contentVersion: 2,
      contentUpdatedAt: "2026-09-04T09:00:00.000Z",
      updatedAt: "2026-09-04T09:00:00.000Z",
    });

    expect(await database.analysisQueueItems.get(coachTestQueueItem.id)).toMatchObject({ status: "stale" });
    expect(await database.decisionBlockStates.get(coachTestBlock.id)).toMatchObject({
      contentVersion: 2,
      status: "unassessed",
    });
  });

  it("soft-deletes a decision block only with a recoverable archive in the same transaction", async () => {
    await repository.saveDecisionBlock(coachTestBlock);
    const deleted = await repository.softDeleteDecisionBlock({
      id: "archive-1",
      decisionBlockId: coachTestBlock.id,
      recordId: coachTestBlock.recordId,
      contentVersion: 1,
      contentHtml: "<div data-decision-block-id=\"decision-block-1\">BFS</div>",
      archivedAt: "2026-09-04T09:00:00.000Z",
      reason: "deleted",
      idempotencyKey: "delete-operation-1",
      createdAt: "2026-09-04T09:00:00.000Z",
      updatedAt: "2026-09-04T09:00:00.000Z",
    });

    expect(deleted.deletedAt).toBe("2026-09-04T09:00:00.000Z");
    expect(await database.decisionBlockArchives.get("archive-1")).toMatchObject({ contentHtml: expect.stringContaining("BFS") });
    expect(await database.decisionBlockStates.get(coachTestBlock.id)).toMatchObject({ status: "stale" });
  });

  it("rejects a decision-block identity already owned by another record", async () => {
    await repository.saveDecisionBlock(coachTestBlock);
    const secondRecord = { ...record, id: "record-2", title: "DFS" };
    await database.blocks.put(secondRecord);
    const reusedHtml = `<record-decision-block data-decision-block-id="${coachTestBlock.id}" data-content-version="1"><p>DFS stack</p></record-decision-block>`;
    const prepared = prepareDecisionBlockContentForSave("<p></p>", reusedHtml, coachTestStamp);

    await expect(repository.saveRecordWithDecisionBlocks(
      { ...secondRecord, contentHtml: prepared.contentHtml },
      prepared,
    )).rejects.toMatchObject({ code: "record-mismatch" });
    expect(await database.decisionBlocks.get(coachTestBlock.id)).toEqual(coachTestBlock);
  });

  it("saves, archives, and restores editor decision blocks without changing record-level FSRS state", async () => {
    const fsrsState = {
      id: record.id,
      recordId: record.id,
      status: "active" as const,
      reviewKind: "memory" as const,
      scheduler: "fsrs-v6" as const,
      easeFactor: 2.3,
      repetition: 5,
      intervalDays: 21,
      nextReviewDate: "2026-09-20",
      consecutiveRemembered: 4,
      totalReviews: 6,
      createdAt: coachTestStamp,
      updatedAt: coachTestStamp,
    };
    await database.recordReviews.put(fsrsState);
    const blockHtml = `<record-decision-block data-decision-block-id="editor-block" data-content-version="1" data-created-at="${coachTestStamp}" data-updated-at="${coachTestStamp}"><p>BFS 队列</p><record-asset data-asset-id="image-1" data-kind="image" data-title="图"></record-asset></record-decision-block>`;
    const preparedCreate = prepareDecisionBlockContentForSave(record.contentHtml, blockHtml, coachTestStamp);
    const withBlock = { ...record, contentHtml: preparedCreate.contentHtml, updatedAt: coachTestStamp };

    await repository.saveRecordWithDecisionBlocks(withBlock, preparedCreate);
    expect(await database.decisionBlocks.get("editor-block")).toMatchObject({ contentVersion: 1, position: 0 });
    expect(await database.recordReviews.get(record.id)).toEqual(fsrsState);

    const deleteStamp = "2026-09-04T09:00:00.000Z";
    const preparedDelete = prepareDecisionBlockContentForSave(withBlock.contentHtml, "<p>保留正文</p>", deleteStamp, [{
      decisionBlockId: "editor-block",
      reason: "deleted",
      contentHtml: blockHtml.replace("BFS 队列", "BFS 入队队列"),
    }]);
    await repository.saveRecordWithDecisionBlocks({ ...withBlock, contentHtml: preparedDelete.contentHtml, updatedAt: deleteStamp }, preparedDelete);
    const archive = (await repository.listRestorableDecisionBlockArchives(record.id))[0];
    expect(archive.contentVersion).toBe(2);
    expect(archive.contentHtml).toContain("BFS 入队队列");
    expect(archive.contentHtml).toContain('data-asset-id="image-1"');
    expect(await database.decisionBlocks.get("editor-block")).toMatchObject({ deletedAt: deleteStamp });

    const restoreStamp = "2026-09-04T10:00:00.000Z";
    const preparedRestore = prepareDecisionBlockContentForSave(
      "<p>保留正文</p>",
      `<p>保留正文</p>${archive.contentHtml}`,
      restoreStamp,
      [],
      undefined,
      new Map([["editor-block", archive.contentHtml]]),
    );
    await repository.saveRecordWithDecisionBlocks({ ...withBlock, contentHtml: preparedRestore.contentHtml, updatedAt: restoreStamp }, preparedRestore);
    const restoredBlock = await database.decisionBlocks.get("editor-block");
    expect(restoredBlock).toMatchObject({ contentVersion: 2 });
    expect(restoredBlock?.deletedAt).toBeUndefined();
    expect(await repository.listRestorableDecisionBlockArchives(record.id)).toEqual([]);
    expect(await database.recordReviews.get(record.id)).toEqual(fsrsState);
  });

  it("keeps execution-only interpretation states out of formal snapshots", async () => {
    await repository.saveDecisionBlock(coachTestBlock);
    await repository.addFeedback(coachTestFeedback, { ...coachTestQueueItem, status: "eligible", batchId: undefined, consumedAt: undefined });
    await repository.saveFeedbackInterpretation({ ...coachTestInterpretation, status: "pending" });

    expect(await database.feedbackInterpretations.count()).toBe(1);
    expect((await repository.getFormalSnapshot()).feedbackInterpretations).toEqual([]);
  });

  it("purges all decision-block-owned facts before a record is permanently removed", async () => {
    await repository.saveDecisionBlock(coachTestBlock);
    await repository.addFeedback(coachTestFeedback, { ...coachTestQueueItem, status: "eligible", batchId: undefined, consumedAt: undefined });
    await repository.saveFeedbackInterpretation({ ...coachTestInterpretation, status: "pending" });

    await database.transaction("rw", reviewCoachFormalTables(database), () => purgeReviewCoachFactsForRecord(database, record.id));

    expect(await database.decisionBlocks.count()).toBe(0);
    expect(await database.decisionBlockFeedback.count()).toBe(0);
    expect(await database.feedbackInterpretations.count()).toBe(0);
    expect(await database.analysisQueueItems.count()).toBe(0);
    expect(await database.decisionBlockStates.count()).toBe(0);
  });

  it("prunes a mixed batch without deleting another record's independent work", async () => {
    const snapshot = completeCoachTestSnapshot();
    const secondRecord = { ...record, id: "record-2", title: "DFS" };
    const secondBlock: DecisionBlock = { ...coachTestBlock, id: "decision-block-2", recordId: secondRecord.id };
    const secondFeedback = {
      ...coachTestFeedback,
      id: "feedback-2",
      decisionBlockId: secondBlock.id,
      recordId: secondRecord.id,
      idempotencyKey: "feedback-operation-2",
    };
    const secondInterpretation = {
      ...coachTestInterpretation,
      id: "interpretation-2",
      feedbackId: secondFeedback.id,
      decisionBlockId: secondBlock.id,
    };
    const secondQueue = {
      ...coachTestQueueItem,
      id: "queue-2",
      feedbackId: secondFeedback.id,
      decisionBlockId: secondBlock.id,
      recordId: secondRecord.id,
    };
    const secondRef = {
      queueItemId: secondQueue.id,
      feedbackId: secondFeedback.id,
      interpretationId: secondInterpretation.id,
      decisionBlockId: secondBlock.id,
      recordId: secondRecord.id,
      contentVersion: 1,
    };
    snapshot.decisionBlocks.push(secondBlock);
    snapshot.decisionBlockFeedback.push(secondFeedback);
    snapshot.feedbackInterpretations.push(secondInterpretation);
    snapshot.analysisQueueItems.push(secondQueue);
    snapshot.analysisBatches[0] = {
      ...snapshot.analysisBatches[0],
      inputRefs: [...snapshot.analysisBatches[0].inputRefs, secondRef],
      subBatches: [{ ...snapshot.analysisBatches[0].subBatches[0], inputRefs: [...snapshot.analysisBatches[0].subBatches[0].inputRefs, secondRef] }],
    };
    const secondBlueprint = {
      ...coachTestBlueprint,
      id: "blueprint-2",
      decisionBlockId: secondBlock.id,
      recordId: secondRecord.id,
      feedbackIds: [secondFeedback.id],
      interpretationIds: [secondInterpretation.id],
      evidence: [{ ...coachTestBlueprint.evidence[0], decisionBlockId: secondBlock.id, recordId: secondRecord.id }],
      idempotencyKey: "blueprint-operation-2",
    };
    snapshot.sessionBlueprints.push(secondBlueprint);
    snapshot.adaptiveReviewTasks.push({
      ...snapshot.adaptiveReviewTasks[0],
      id: "task-2",
      blueprintId: secondBlueprint.id,
      decisionBlockId: secondBlock.id,
      recordId: secondRecord.id,
      status: "waiting",
      startedAt: undefined,
      endedAt: undefined,
      idempotencyKey: "task-operation-2",
    });
    await database.blocks.put(secondRecord);
    await database.transaction("rw", reviewCoachRestoreTables(database), () => restoreReviewCoachFormalSnapshot(database, snapshot));

    await database.transaction("rw", reviewCoachFormalTables(database), () => purgeReviewCoachFactsForRecord(database, record.id));
    await repository.rebuildProjections();

    expect((await database.analysisBatches.get(coachTestBatch.id))?.inputRefs).toEqual([secondRef]);
    expect(await database.decisionBlocks.toArray()).toEqual([secondBlock]);
    expect(await database.sessionBlueprints.toArray()).toEqual([secondBlueprint]);
    expect((await database.adaptiveReviewTasks.toArray()).map((task) => task.id)).toEqual(["task-2"]);
  });

  it("enforces a single global current task with a database unique key", async () => {
    const secondBlock: DecisionBlock = { ...coachTestBlock, id: "decision-block-2", position: 1 };
    await database.decisionBlocks.bulkPut([coachTestBlock, secondBlock]);
    await database.analysisBatches.put(coachTestBatch);
    await database.sessionBlueprints.bulkPut([
      coachTestBlueprint,
      {
        ...coachTestBlueprint,
        id: "blueprint-2",
        decisionBlockId: secondBlock.id,
        idempotencyKey: "blueprint-operation-2",
        evidence: [{ ...coachTestBlueprint.evidence[0], decisionBlockId: secondBlock.id }],
      },
    ]);
    const first: AdaptiveReviewTask = {
      id: "task-current-1",
      blueprintId: coachTestBlueprint.id,
      decisionBlockId: coachTestBlock.id,
      recordId: record.id,
      contentVersion: 1,
      status: "current",
      priorityTier: "first-difficulty",
      queuedAt: coachTestStamp,
      idempotencyKey: "task-current-operation-1",
      createdAt: coachTestStamp,
      updatedAt: coachTestStamp,
    };
    await database.adaptiveReviewTasks.put({
      ...first,
      activeSlotKey: "global-current",
      openTargetKey: `${first.decisionBlockId}:${first.contentVersion}`,
    });

    await expect(repository.createTask({
      ...first,
      id: "task-current-2",
      blueprintId: "blueprint-2",
      decisionBlockId: secondBlock.id,
      idempotencyKey: "task-current-operation-2",
    })).rejects.toMatchObject({ code: "task-uniqueness" });
    expect(await database.adaptiveReviewTasks.count()).toBe(1);
  });

  it("switches the global current task atomically", async () => {
    const secondBlock: DecisionBlock = { ...coachTestBlock, id: "decision-block-2", position: 1 };
    const secondBlueprint = {
      ...coachTestBlueprint,
      id: "blueprint-2",
      decisionBlockId: secondBlock.id,
      idempotencyKey: "blueprint-operation-2",
      evidence: [{ ...coachTestBlueprint.evidence[0], decisionBlockId: secondBlock.id }],
    };
    await database.decisionBlocks.bulkPut([coachTestBlock, secondBlock]);
    await database.decisionBlockFeedback.put(coachTestFeedback);
    await database.feedbackInterpretations.put(coachTestInterpretation);
    await database.analysisQueueItems.put(coachTestQueueItem);
    await database.analysisBatches.put(coachTestBatch);
    await database.sessionBlueprints.bulkPut([coachTestBlueprint, secondBlueprint]);
    await repository.createTask({ ...coachTestTask, id: "task-current", status: "current", endedAt: undefined, idempotencyKey: "task-current" });
    await repository.createTask({ ...coachTestTask, id: "task-waiting", blueprintId: secondBlueprint.id, decisionBlockId: secondBlock.id, status: "waiting", endedAt: undefined, idempotencyKey: "task-waiting" });

    const switched = await repository.switchCurrentTask("task-waiting", "2026-09-07T08:00:00.000Z");

    expect(switched.status).toBe("current");
    expect(await database.adaptiveReviewTasks.get("task-current")).toMatchObject({ status: "waiting", activeSlotKey: undefined });
    expect((await database.adaptiveReviewTasks.where("activeSlotKey").equals("global-current").toArray()).map((item) => item.id)).toEqual(["task-waiting"]);
  });

  it.each(["task", "turn", "deleted"] as const)("rejects an old AI answer after synchronized %s changes even with the same timestamp", async (changed) => {
    await database.decisionBlocks.put(coachTestBlock);
    const task = { ...coachTestTask, status: "in-progress" as const, endedAt: undefined };
    const turn = { ...coachTestTurn, status: "displayed" as const, answeredAt: undefined, answerText: undefined, assessment: undefined };
    await database.adaptiveReviewTasks.put(task);
    await database.adaptiveQuizTurns.put(turn);
    if (changed === "task") await database.adaptiveReviewTasks.put({ ...task, terminalReason: "remote-change" });
    if (changed === "turn") await database.adaptiveQuizTurns.put({ ...turn, question: "remote-question" });
    if (changed === "deleted") await database.adaptiveQuizTurns.delete(turn.id);
    const before = await database.cloudSyncMutation.toArray();
    await expect(repository.commitQuizAnswer(coachTestTurn, coachTestAnswerOutcome, undefined, { turn, task })).rejects.toBeInstanceOf(ReviewCoachValidationError);
    expect(await database.taskOutcomeEvents.count()).toBe(0);
    expect(await database.cloudSyncMutation.toArray()).toEqual(before);
  });

  it("accepts a guarded answer at a later time and keeps a terminal-task retry idempotent", async () => {
    await database.transaction("rw", reviewCoachRestoreTables(database), () => restoreReviewCoachFormalSnapshot(database, completeCoachTestSnapshot()));
    await database.taskOutcomeEvents.clear();
    await database.delayedVerifications.clear();
    const task = { ...coachTestTask, status: "in-progress" as const, endedAt: undefined };
    const turn = { ...coachTestTurn, status: "displayed" as const, answeredAt: undefined, answerText: undefined, assessment: undefined };
    await database.adaptiveReviewTasks.put(task);
    await database.adaptiveQuizTurns.put(turn);
    const answered = { ...coachTestTurn, updatedAt: "2026-09-21T10:00:00.000Z" };
    expect(await repository.commitQuizAnswer(answered, coachTestAnswerOutcome, undefined, { turn, task })).toMatchObject({ status: "answered", updatedAt: answered.updatedAt });
    await database.adaptiveReviewTasks.put({ ...task, status: "completed" });
    const before = await database.cloudSyncMutation.toArray();
    expect(await repository.commitQuizAnswer(answered, coachTestAnswerOutcome, undefined, { turn, task })).toMatchObject({ status: "answered" });
    expect(await database.taskOutcomeEvents.count()).toBe(1);
    expect(await database.cloudSyncMutation.toArray()).toEqual(before);
  });

  it.each(["succeeded", "failed", "confirmed"] as const)("rejects stale %s analysis callbacks without touching the remote batch", async (status) => {
    const running = { ...coachTestBatch, status: "running" as const, completedAt: undefined };
    const remote = { ...running, finalSummary: "remote result with unchanged timestamp" };
    await database.analysisBatches.put(remote);
    const before = await database.cloudSyncMutation.toArray();
    await expect(repository.updateAnalysisBatch({ ...running, status }, running)).rejects.toMatchObject({ code: "stale-analysis-batch" });
    expect(await database.analysisBatches.get(remote.id)).toEqual(remote);
    expect(await database.cloudSyncMutation.toArray()).toEqual(before);
  });

  it("rejects a blueprint returned after the batch was replaced", async () => {
    await database.decisionBlocks.put(coachTestBlock);
    const running = { ...coachTestBatch, status: "running" as const, completedAt: undefined };
    await database.analysisBatches.put({ ...running, finalSummary: "remote result" });
    await expect(repository.acceptBlueprint(coachTestBlueprint, running)).rejects.toMatchObject({ code: "stale-analysis-batch" });
    expect(await database.sessionBlueprints.count()).toBe(0);
    expect(await database.cloudSyncMutation.count()).toBe(0);
  });

  it("commits answer, self-assessment, disposition, and task terminal state atomically", async () => {
    const snapshot = completeCoachTestSnapshot();
    snapshot.adaptiveReviewTasks[0] = {
      ...snapshot.adaptiveReviewTasks[0],
      status: "in-progress",
      activeSlotKey: "global-current",
      openTargetKey: `${coachTestBlock.id}:1`,
      endedAt: undefined,
    };
    snapshot.taskOutcomeEvents = [];
    snapshot.delayedVerifications = [];
    await database.transaction("rw", reviewCoachRestoreTables(database), () => restoreReviewCoachFormalSnapshot(database, snapshot));

    const completed = await repository.commitTaskOutcome(
      snapshot.adaptiveReviewTasks[0].id,
      [coachTestAnswerOutcome, coachTestMasteredOutcome, coachTestCompletedDisposition],
      "completed",
      "2026-09-04T10:00:00.000Z",
    );

    expect(completed.status).toBe("completed");
    expect(await database.taskOutcomeEvents.count()).toBe(3);
    expect(await database.decisionBlockStates.get(coachTestBlock.id)).toMatchObject({ status: "improved-pending-verification" });
  });

  it("commits task completion and its delayed-verification plan atomically", async () => {
    const snapshot = completeCoachTestSnapshot();
    snapshot.adaptiveReviewTasks[0] = { ...snapshot.adaptiveReviewTasks[0], status: "in-progress", activeSlotKey: "global-current", openTargetKey: `${coachTestBlock.id}:1`, endedAt: undefined };
    snapshot.taskOutcomeEvents = [];
    snapshot.delayedVerifications = [];
    await database.transaction("rw", reviewCoachRestoreTables(database), () => restoreReviewCoachFormalSnapshot(database, snapshot));
    const verification = {
      ...coachTestVerification,
      status: "scheduled" as const,
      sourceOutcomeEventId: coachTestMasteredOutcome.id,
      taskId: undefined,
      lastVerifiedAt: undefined,
      verificationOutcome: undefined,
    };

    await repository.commitTaskOutcome(
      coachTestTask.id,
      [coachTestAnswerOutcome, coachTestMasteredOutcome, coachTestCompletedDisposition],
      "completed",
      "2026-09-04T10:00:00.000Z",
      undefined,
      verification,
    );

    expect(await database.adaptiveReviewTasks.get(coachTestTask.id)).toMatchObject({ status: "completed" });
    expect(await database.delayedVerifications.get(verification.id)).toMatchObject({ status: "scheduled", sourceOutcomeEventId: coachTestMasteredOutcome.id });
    expect(await database.decisionBlockStates.get(coachTestBlock.id)).toMatchObject({ status: "improved-pending-verification", pendingVerificationId: verification.id });
  });

  it("queues and completes a retained verification with linked projections", async () => {
    const snapshot = completeCoachTestSnapshot();
    snapshot.delayedVerifications[0] = {
      ...coachTestVerification,
      status: "eligible",
      taskId: undefined,
      lastVerifiedAt: undefined,
      verificationOutcome: undefined,
    };
    await database.transaction("rw", reviewCoachRestoreTables(database), () => restoreReviewCoachFormalSnapshot(database, snapshot));
    const verificationTask: AdaptiveReviewTask = {
      ...coachTestTask,
      id: "verification-task-1",
      status: "waiting",
      priorityTier: "due-verification",
      startedAt: undefined,
      endedAt: undefined,
      idempotencyKey: "verification-task-1",
    };

    const queued = await repository.queueVerification(coachTestVerification.id, verificationTask, "2026-09-07T08:00:00.000Z");
    await repository.transitionTask(queued.task.id, "current", "2026-09-07T08:01:00.000Z");
    await repository.transitionTask(queued.task.id, "in-progress", "2026-09-07T08:02:00.000Z");
    await database.adaptiveQuizTurns.put({
      ...coachTestTurn,
      id: "verification-turn-1",
      taskId: verificationTask.id,
      idempotencyKey: "verification-turn-1",
      createdAt: "2026-09-07T08:02:00.000Z",
      updatedAt: "2026-09-07T08:03:00.000Z",
    });
    const retainedAt = "2026-09-07T08:04:00.000Z";
    await repository.completeVerification(verificationTask.id, [
      { ...coachTestAnswerOutcome, id: "verification-answer-1", taskId: verificationTask.id, turnId: "verification-turn-1", occurredAt: retainedAt, idempotencyKey: "verification-answer-1", createdAt: retainedAt, updatedAt: retainedAt },
      { ...coachTestMasteredOutcome, id: "verification-self-1", taskId: verificationTask.id, occurredAt: retainedAt, idempotencyKey: "verification-self-1", createdAt: retainedAt, updatedAt: retainedAt },
      { ...coachTestCompletedDisposition, id: "verification-disposition-1", taskId: verificationTask.id, occurredAt: retainedAt, idempotencyKey: "verification-disposition-1", createdAt: retainedAt, updatedAt: retainedAt },
    ], "retained", retainedAt);

    expect(await database.adaptiveReviewTasks.get(verificationTask.id)).toMatchObject({ status: "completed", endedAt: retainedAt });
    expect(await database.delayedVerifications.get(coachTestVerification.id)).toMatchObject({ status: "completed", verificationOutcome: "retained", lastVerifiedAt: retainedAt });
    expect(await database.decisionBlockStates.get(coachTestBlock.id)).toMatchObject({ status: "retained", pendingVerificationId: undefined });
    expect(await database.interventionEffectSummaries.toArray()).toEqual([
      expect.objectContaining({ sampleCount: 1, delayedRetainedCount: 1, delayedDecayedCount: 0, retentionRate: 1, evidenceStatus: "insufficient" }),
    ]);
  });

  it("commits a displayed quiz answer and its assessment event atomically", async () => {
    const snapshot = completeCoachTestSnapshot();
    snapshot.adaptiveReviewTasks[0] = { ...snapshot.adaptiveReviewTasks[0], status: "in-progress", activeSlotKey: "global-current", openTargetKey: `${coachTestBlock.id}:1`, endedAt: undefined };
    snapshot.adaptiveQuizTurns[0] = { ...snapshot.adaptiveQuizTurns[0], status: "displayed", answerText: undefined, answeredAt: undefined, assessment: undefined, assessmentRationale: undefined, availableHints: ["first hint"], hintsUsed: [] };
    snapshot.taskOutcomeEvents = [];
    snapshot.delayedVerifications = [];
    await database.transaction("rw", reviewCoachRestoreTables(database), () => restoreReviewCoachFormalSnapshot(database, snapshot));
    await repository.recordQuizHint(snapshot.adaptiveQuizTurns[0].id, 1, "2026-09-04T09:00:00.000Z");
    const answered = { ...snapshot.adaptiveQuizTurns[0], status: "answered" as const, answerText: "Before enqueue", answeredAt: "2026-09-04T09:01:00.000Z", assessment: "correct" as const, assessmentRationale: "Matches", updatedAt: "2026-09-04T09:01:00.000Z" };
    const event = { ...coachTestAnswerOutcome, id: "answer-stage6", idempotencyKey: "answer-stage6", occurredAt: answered.answeredAt, updatedAt: answered.updatedAt };

    await repository.commitQuizAnswer(answered, event);

    expect(await database.adaptiveQuizTurns.get(answered.id)).toMatchObject({ status: "answered", answerText: "Before enqueue", hintsUsed: [{ level: 1 }] });
    expect(await database.taskOutcomeEvents.get(event.id)).toMatchObject({ answerAssessment: "correct", turnId: answered.id });
  });

  it("rolls back an answer and outcome when cancelled during the transaction", async () => {
    const snapshot = completeCoachTestSnapshot();
    snapshot.adaptiveReviewTasks[0] = { ...snapshot.adaptiveReviewTasks[0], status: "in-progress", activeSlotKey: "global-current", openTargetKey: `${coachTestBlock.id}:1`, endedAt: undefined };
    snapshot.adaptiveQuizTurns[0] = { ...snapshot.adaptiveQuizTurns[0], status: "displayed", answerText: undefined, assessment: undefined };
    snapshot.taskOutcomeEvents = [];
    snapshot.delayedVerifications = [];
    await database.transaction("rw", reviewCoachRestoreTables(database), () => restoreReviewCoachFormalSnapshot(database, snapshot));
    const controller = new AbortController();
    const add = database.taskOutcomeEvents.add.bind(database.taskOutcomeEvents);
    const spy = vi.spyOn(database.taskOutcomeEvents, "add").mockImplementationOnce((...args) => add(...args).then((key) => {
      controller.abort();
      return key;
    }));
    const answered = { ...snapshot.adaptiveQuizTurns[0], status: "answered" as const, answerText: "answer", assessment: "correct" as const };
    await expect(repository.commitQuizAnswer(answered, coachTestAnswerOutcome, controller.signal)).rejects.toMatchObject({ name: "AbortError" });
    spy.mockRestore();
    expect((await database.adaptiveQuizTurns.get(answered.id))?.status).toBe("displayed");
    expect(await database.taskOutcomeEvents.count()).toBe(0);
  });

  it("rolls back quiz and task invalidation when the outcome event write fails", async () => {
    const snapshot = completeCoachTestSnapshot();
    const turn = { ...snapshot.adaptiveQuizTurns[0], status: "displayed" as const, answerText: undefined, answeredAt: undefined, assessment: undefined, assessmentRationale: undefined };
    const task: AdaptiveReviewTask = { ...snapshot.adaptiveReviewTasks[0], status: "in-progress", activeSlotKey: "global-current", openTargetKey: `${coachTestBlock.id}:1`, endedAt: undefined };
    snapshot.adaptiveQuizTurns = [turn];
    snapshot.adaptiveReviewTasks = [task];
    snapshot.taskOutcomeEvents = [];
    snapshot.delayedVerifications = [];
    await database.transaction("rw", reviewCoachRestoreTables(database), () => restoreReviewCoachFormalSnapshot(database, snapshot));
    const event = {
      ...coachTestCompletedDisposition,
      id: "question-invalid-stage6",
      taskId: task.id,
      turnId: turn.id,
      disposition: "question-invalid" as const,
      reason: "ambiguous question",
      idempotencyKey: "question-invalid-stage6",
    };
    vi.spyOn(database.taskOutcomeEvents, "add").mockRejectedValueOnce(new Error("simulated event write failure"));

    await expect(repository.invalidateQuizTurn(turn.id, event, coachTestStamp)).rejects.toThrow("simulated event write failure");

    expect(await database.adaptiveQuizTurns.get(turn.id)).toMatchObject({ status: "displayed" });
    expect(await database.adaptiveReviewTasks.get(task.id)).toMatchObject({ status: "in-progress", activeSlotKey: "global-current" });
    expect(await database.taskOutcomeEvents.count()).toBe(0);
  });
});
