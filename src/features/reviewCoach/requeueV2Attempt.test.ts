import Dexie from "dexie";
import { IDBKeyRange, indexedDB } from "fake-indexeddb";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { StudyJournalDatabase } from "../../db/database";
import { closedLoopV2Fixtures } from "./learningLoopFixtures";
import { DexieReviewCoachRepository } from "./repository";
import { coachTestBlock, coachTestStamp, completeCoachTestSnapshot } from "./reviewCoachTestFixtures";
import { isOpenTaskStatus, openTargetKeyFor } from "./validation";

Dexie.dependencies.indexedDB = indexedDB;
Dexie.dependencies.IDBKeyRange = IDBKeyRange;

/**
 * M2: the requeue half of "budget exhausted".
 *
 * The point of these tests is that a v2 attempt which ran out of budget is
 * parked with its reason and *continued*, never rewritten and never completed.
 */

describe("requeueV2Attempt", () => {
  let database: StudyJournalDatabase;
  let repository: DexieReviewCoachRepository;

  beforeEach(async () => {
    database = new StudyJournalDatabase(`review-coach-requeue-${crypto.randomUUID()}`);
    await database.open();
    repository = new DexieReviewCoachRepository(database);
  });

  afterEach(async () => {
    const name = database.name;
    database.close();
    await Dexie.delete(name);
  });

  const seed = async () => {
    const { blueprint, task } = closedLoopV2Fixtures({ loop: "open" });
    await database.blocks.put({
      id: coachTestBlock.recordId, type: "record", date: "2026-09-15", order: 0, subject: "DS",
      title: "BFS", contentHtml: "<p>x</p>", assets: [], formulas: [], mistakeRefs: [], tags: [],
      createdAt: coachTestStamp, updatedAt: coachTestStamp,
    });
    const formal = completeCoachTestSnapshot();
    for (const name of [
      "decisionBlocks", "decisionBlockFeedback", "feedbackInterpretations", "analysisQueueItems", "analysisBatches",
    ] as const) {
      await database.table(name).bulkPut(structuredClone(formal[name]) as unknown[]);
    }
    await database.sessionBlueprints.put(structuredClone(blueprint));
    await database.adaptiveReviewTasks.put(structuredClone(task));
    // The exhausted attempt has already released its target and become deferred.
    await database.adaptiveReviewTasks.put({
      ...task,
      status: "deferred",
      activeSlotKey: undefined,
      openTargetKey: undefined,
      notBeforeAt: "2026-09-16T08:00:00.000Z",
      updatedAt: coachTestStamp,
    });
    await database.taskOutcomeEvents.put({
      id: "event-deferred",
      taskId: task.id,
      decisionBlockId: task.decisionBlockId,
      recordId: task.recordId,
      contentVersion: task.contentVersion,
      kind: "task-disposition",
      disposition: "deferred",
      reason: "budget-exhausted-before-closure",
      occurredAt: coachTestStamp,
      idempotencyKey: "event-deferred",
      createdAt: coachTestStamp,
      updatedAt: coachTestStamp,
    });
    return { blueprint, task };
  };

  it("copies the frozen blueprint and queues a replacement without double-targeting", async () => {
    const { blueprint, task } = await seed();
    const replacement = await repository.requeueV2Attempt({
      deferredTaskId: task.id,
      blueprint,
      reason: "budget-exhausted-before-closure",
      operationId: "op-requeue-1",
      now: "2026-09-15T09:00:00.000Z",
    });

    expect(replacement).toMatchObject({
      status: "waiting",
      loopVersion: "closed-loop-v2",
      retryOfTaskId: task.id,
      decisionBlockId: task.decisionBlockId,
      contentVersion: task.contentVersion,
      idempotencyKey: "requeue-task:op-requeue-1",
    });
    // The replacement takes over the target; the parked attempt no longer
    // occupies it, so exactly one open task holds the decision block.
    const targetKey = `${task.decisionBlockId}:${task.contentVersion}`;
    expect(replacement.openTargetKey).toBe(targetKey);
    const parked = await database.adaptiveReviewTasks.get(task.id);
    expect(parked!.openTargetKey).toBeUndefined();
    const open = (await database.adaptiveReviewTasks.toArray())
      .filter((item) => isOpenTaskStatus(item.status) && !item.replacedByTaskId);
    expect(open.filter((item) => openTargetKeyFor(item) === targetKey)).toHaveLength(1);

    // The blueprint is a copy with the same content and evidence, not a re-plan.
    const cloned = await database.sessionBlueprints.get(replacement.blueprintId);
    expect(cloned).toMatchObject({
      decisionBlockId: blueprint.decisionBlockId,
      contentVersion: blueprint.contentVersion,
      maxTurns: blueprint.maxTurns,
      loopVersion: "closed-loop-v2",
    });
    expect(cloned!.evidence).toEqual(blueprint.evidence);
    expect(cloned!.id).not.toBe(blueprint.id);

    // The exhausted attempt keeps its audit trail and points forward.
    const parked2 = await database.adaptiveReviewTasks.get(task.id);
    expect(parked2).toMatchObject({
      status: "deferred",
      replacedByTaskId: replacement.id,
      terminalReason: "budget-exhausted-before-closure",
    });
  });

  it("is idempotent: replaying the same operation does not open a second target", async () => {
    const { blueprint, task } = await seed();
    const first = await repository.requeueV2Attempt({
      deferredTaskId: task.id, blueprint, reason: "budget-exhausted-before-closure",
      operationId: "op-requeue-1", now: "2026-09-15T09:00:00.000Z",
    });
    const second = await repository.requeueV2Attempt({
      deferredTaskId: task.id, blueprint, reason: "budget-exhausted-before-closure",
      operationId: "op-requeue-1", now: "2026-09-15T09:05:00.000Z",
    });

    expect(second.id).toBe(first.id);
    const all = await database.adaptiveReviewTasks.toArray();
    expect(all.filter((item) => item.retryOfTaskId === task.id)).toHaveLength(1);
  });

  it("refuses to requeue a task that is not closed-loop-v2", async () => {
    const { blueprint, task } = await seed();
    await database.adaptiveReviewTasks.put({ ...task, loopVersion: undefined, status: "deferred" });
    await expect(repository.requeueV2Attempt({
      deferredTaskId: task.id, blueprint, reason: "budget-exhausted-before-closure",
      operationId: "op-requeue-v1", now: "2026-09-15T09:00:00.000Z",
    })).rejects.toThrow("Only a closed-loop-v2 attempt can be requeued");
  });

  it("refuses to requeue a task that is not actually deferred", async () => {
    // The requeue is the second half of a deferral. Accepting a live task would
    // clone an attempt that is still running and leave two open targets behind.
    const { blueprint, task } = await seed();
    await database.adaptiveReviewTasks.put({ ...task, status: "in-progress", openTargetKey: `${task.decisionBlockId}:1` });

    await expect(repository.requeueV2Attempt({
      deferredTaskId: task.id, blueprint, reason: "budget-exhausted-before-closure",
      operationId: "op-requeue-live", now: "2026-09-15T09:00:00.000Z",
    })).rejects.toThrow("Only a deferred attempt can be requeued");

    // Nothing was created.
    expect(await database.adaptiveReviewTasks.where("retryOfTaskId").equals(task.id).count()).toBe(0);
  });

  it("still replays idempotently after the deferral has been completed", async () => {
    // The status guard must not break the idempotent replay path: the first run
    // leaves the task deferred, so a second identical call finds the replacement.
    const { blueprint, task } = await seed();
    await repository.requeueV2Attempt({
      deferredTaskId: task.id, blueprint, reason: "budget-exhausted-before-closure",
      operationId: "op-requeue-replay", now: "2026-09-15T09:00:00.000Z",
    });
    // Pretend the replacement was later completed and the source re-deferred.
    await database.adaptiveReviewTasks.put({ ...task, status: "completed" });
    const replayed = await repository.requeueV2Attempt({
      deferredTaskId: task.id, blueprint, reason: "budget-exhausted-before-closure",
      operationId: "op-requeue-replay", now: "2026-09-15T09:10:00.000Z",
    });
    expect(replayed.retryOfTaskId).toBe(task.id);
    expect(await database.adaptiveReviewTasks.where("retryOfTaskId").equals(task.id).count()).toBe(1);
  });
});

describe("deferAndRequeue", () => {
  let database: StudyJournalDatabase;
  let repository: DexieReviewCoachRepository;

  beforeEach(async () => {
    database = new StudyJournalDatabase(`review-coach-defer-requeue-${crypto.randomUUID()}`);
    await database.open();
    repository = new DexieReviewCoachRepository(database);
  });

  afterEach(async () => {
    const name = database.name;
    database.close();
    await Dexie.delete(name);
  });

  const seedOpen = async () => {
    const { blueprint, task } = closedLoopV2Fixtures({ loop: "open" });
    await database.blocks.put({
      id: coachTestBlock.recordId, type: "record", date: "2026-09-15", order: 0, subject: "DS",
      title: "BFS", contentHtml: "<p>x</p>", assets: [], formulas: [], mistakeRefs: [], tags: [],
      createdAt: coachTestStamp, updatedAt: coachTestStamp,
    });
    const formal = completeCoachTestSnapshot();
    for (const name of [
      "decisionBlocks", "decisionBlockFeedback", "feedbackInterpretations", "analysisQueueItems", "analysisBatches",
    ] as const) {
      await database.table(name).bulkPut(structuredClone(formal[name]) as unknown[]);
    }
    await database.sessionBlueprints.put(structuredClone(blueprint));
    // A *live* attempt: this is the state the orchestrator defers from.
    await database.adaptiveReviewTasks.put({
      ...structuredClone(task),
      status: "in-progress",
      openTargetKey: `${task.decisionBlockId}:${task.contentVersion}`,
    });
    const events = [{
      id: "defer-1",
      taskId: task.id,
      decisionBlockId: task.decisionBlockId,
      recordId: task.recordId,
      contentVersion: task.contentVersion,
      kind: "task-disposition" as const,
      disposition: "deferred" as const,
      reason: "budget-exhausted-before-closure",
      occurredAt: coachTestStamp,
      idempotencyKey: "defer-1",
      createdAt: coachTestStamp,
      updatedAt: coachTestStamp,
    }];
    return { blueprint, task, events };
  };

  it("commits the deferral and the replacement together", async () => {
    const { blueprint, task, events } = await seedOpen();
    const result = await repository.deferAndRequeue({
      deferredTaskId: task.id,
      deferredEvents: events,
      notBeforeAt: "2026-09-16T08:00:00.000Z",
      blueprint,
      reason: "budget-exhausted-before-closure",
      operationId: "op-atomic-1",
      now: "2026-09-15T09:00:00.000Z",
    });

    expect(result.deferred.status).toBe("deferred");
    expect(result.replacement).toMatchObject({ status: "waiting", retryOfTaskId: task.id });
    // Exactly one open task holds the target, and it is the replacement. The
    // deferred attempt keeps its `deferred` status for audit but has handed the
    // target over through `replacedByTaskId`.
    const targetKey = `${task.decisionBlockId}:${task.contentVersion}`;
    const holders = (await database.adaptiveReviewTasks.toArray())
      .filter((item) => isOpenTaskStatus(item.status) && !item.replacedByTaskId && openTargetKeyFor(item) === targetKey);
    expect(holders.map((item) => item.id)).toEqual([result.replacement.id]);
    // The repository's own load-time invariant agrees: the snapshot is valid.
    await expect(repository.getFormalSnapshot()).resolves.toBeTruthy();
  });

  it("rolls the deferral back when the replacement cannot be created", async () => {
    // The failure this guards: a deferred task whose target nobody holds. Before
    // the composite existed, `commitTaskOutcome` committed and then the requeue
    // threw, leaving an orphaned deferral behind.
    //
    // The failure is injected *after* the deferral has been staged, so this
    // exercises the cross-step case rather than a single statement throwing.
    const { blueprint, task, events } = await seedOpen();
    const deferAndRequeue = repository.deferAndRequeue.bind(repository);
    const failing = vi.spyOn(repository, "requeueV2Attempt").mockRejectedValueOnce(
      new Error("FORCED: replacement creation failed"),
    );

    await expect(deferAndRequeue({
      deferredTaskId: task.id,
      deferredEvents: events,
      notBeforeAt: "2026-09-16T08:00:00.000Z",
      blueprint,
      reason: "budget-exhausted-before-closure",
      operationId: "op-atomic-fail",
      now: "2026-09-15T09:00:00.000Z",
    })).rejects.toThrow("FORCED: replacement creation failed");
    failing.mockRestore();

    // The attempt is untouched and still open: no orphaned deferral, and the
    // staged disposition event did not survive either.
    const after = await database.adaptiveReviewTasks.get(task.id);
    expect(after!.status).toBe("in-progress");
    expect(after!.openTargetKey).toBe(`${task.decisionBlockId}:${task.contentVersion}`);
    expect(await database.taskOutcomeEvents.where("taskId").equals(task.id).count()).toBe(0);
    expect(await database.adaptiveReviewTasks.where("retryOfTaskId").equals(task.id).count()).toBe(0);
  });

  it("keeps the deferral when the whole composite succeeds", async () => {
    // The control for the test above: a success must not be rolled back by the
    // same outer transaction that protects a failure.
    const { blueprint, task, events } = await seedOpen();
    await repository.deferAndRequeue({
      deferredTaskId: task.id,
      deferredEvents: events,
      notBeforeAt: "2026-09-16T08:00:00.000Z",
      blueprint,
      reason: "budget-exhausted-before-closure",
      operationId: "op-atomic-ok",
      now: "2026-09-15T09:00:00.000Z",
    });
    const after = await database.adaptiveReviewTasks.get(task.id);
    expect(after!.status).toBe("deferred");
    expect(after!.replacedByTaskId).toBe("requeue-task:op-atomic-ok");
    expect(await database.taskOutcomeEvents.where("taskId").equals(task.id).count()).toBe(1);
  });
});
