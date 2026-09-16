import Dexie from "dexie";
import { IDBKeyRange, indexedDB } from "fake-indexeddb";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { StudyJournalDatabase } from "../../db/database";
import type { TaskOutcomeEvent } from "./domain";
import { closedLoopV2Fixtures } from "./learningLoopFixtures";
import { DexieReviewCoachRepository } from "./repository";
import { ReviewCoachValidationError } from "./validation";
import { coachTestBlock, coachTestStamp, completeCoachTestSnapshot } from "./reviewCoachTestFixtures";

Dexie.dependencies.indexedDB = indexedDB;
Dexie.dependencies.IDBKeyRange = IDBKeyRange;

const event = (overrides: Partial<TaskOutcomeEvent>): TaskOutcomeEvent => ({
  id: "event-1",
  taskId: "task-v2-1",
  decisionBlockId: coachTestBlock.id,
  recordId: coachTestBlock.recordId,
  contentVersion: 1,
  kind: "task-disposition",
  disposition: "question-invalid",
  occurredAt: coachTestStamp,
  idempotencyKey: "event-key-1",
  createdAt: coachTestStamp,
  updatedAt: coachTestStamp,
  ...overrides,
});

describe("review coach v2 evidence corrections", () => {
  let database: StudyJournalDatabase;
  let repository: DexieReviewCoachRepository;

  beforeEach(async () => {
    database = new StudyJournalDatabase(`review-coach-corrections-${crypto.randomUUID()}`);
    await database.open();
    repository = new DexieReviewCoachRepository(database);
  });

  afterEach(async () => {
    const name = database.name;
    database.close();
    await Dexie.delete(name);
  });

  const seedV2Task = async () => {
    const { blueprint, task, turns } = closedLoopV2Fixtures({ loop: "closed" });
    await database.blocks.put({
      id: coachTestBlock.recordId, type: "record", date: "2026-09-15", order: 0, subject: "DS",
      title: "BFS", contentHtml: "<p>x</p>", assets: [], formulas: [], mistakeRefs: [], tags: [],
      createdAt: coachTestStamp, updatedAt: coachTestStamp,
    });
    // Seed the full v1 fixture graph first, then overwrite the v2 entities, so
    // the frozen analysis inputs the blueprint points at actually resolve.
    const formal = completeCoachTestSnapshot();
    for (const name of [
      "decisionBlocks", "decisionBlockFeedback", "feedbackInterpretations", "analysisQueueItems", "analysisBatches",
    ] as const) {
      await database.table(name).bulkPut(structuredClone(formal[name]) as unknown[]);
    }
    await database.sessionBlueprints.put(structuredClone(blueprint));
    await database.adaptiveReviewTasks.put(structuredClone(task));
    for (const turn of turns) await database.adaptiveQuizTurns.put(structuredClone(turn));
    return { blueprint, task, turns };
  };

  it("keeps a v2 task open when a single question is reported as bad", async () => {
    const { task, turns } = await seedV2Task();

    const surviving = await repository.invalidateQuizTurn(
      turns[0].id,
      event({ turnId: turns[0].id }),
      "2026-09-15T09:00:00.000Z",
    );

    // The bad question is retired; the learner is not punished for it.
    expect((await database.adaptiveQuizTurns.get(turns[0].id))?.status).toBe("invalid");
    expect(surviving.id).toBe(task.id);
    expect(surviving.status).toBe("in-progress");
    expect(surviving.openTargetKey).toBe(task.openTargetKey);
  });

  it("keeps the historical behaviour for a v1 task", async () => {
    await seedV2Task();
    const v1Task = { ...(await database.adaptiveReviewTasks.get("task-v2-1"))!, loopVersion: undefined };
    await database.adaptiveReviewTasks.put(v1Task);
    const turn = (await database.adaptiveQuizTurns.toArray())[0];

    const terminal = await repository.invalidateQuizTurn(turn.id, event({ turnId: turn.id }), "2026-09-15T09:00:00.000Z");

    expect(terminal.status).toBe("invalid");
    expect(terminal.openTargetKey).toBeUndefined();
  });

  it("retires evidence through an append-only supersede event", async () => {
    const { task, turns } = await seedV2Task();

    await repository.supersedeEvidence(event({
      id: "supersede-1",
      turnId: turns[1].id,
      kind: "evidence-superseded",
      disposition: undefined,
      supersededTurnId: turns[1].id,
      supersedeReason: "misjudged",
      idempotencyKey: "supersede-key-1",
      occurredAt: "2026-09-15T09:00:00.000Z",
    }));

    // The original judgment is still there for audit.
    expect(await database.adaptiveQuizTurns.get(turns[1].id)).toBeTruthy();
    const events = await database.taskOutcomeEvents.where("taskId").equals(task.id).toArray();
    expect(events.map((item) => item.kind)).toContain("evidence-superseded");
  });

  it("is idempotent when the same correction is submitted twice", async () => {
    const { task, turns } = await seedV2Task();
    const correction = event({
      id: "supersede-1",
      turnId: turns[1].id,
      kind: "evidence-superseded",
      disposition: undefined,
      supersededTurnId: turns[1].id,
      supersedeReason: "misjudged",
      idempotencyKey: "supersede-key-1",
    });

    await repository.supersedeEvidence(correction);
    await repository.supersedeEvidence(correction);

    const all = await database.taskOutcomeEvents.where("taskId").equals(task.id).toArray();
    expect(all.filter((item) => item.kind === "evidence-superseded")).toHaveLength(1);
  });

  it("refuses a correction that names evidence which does not exist", async () => {
    await seedV2Task();
    await expect(repository.supersedeEvidence(event({
      id: "supersede-1",
      kind: "evidence-superseded",
      disposition: undefined,
      supersededTurnId: "turn-does-not-exist",
      idempotencyKey: "supersede-key-1",
    }))).rejects.toBeInstanceOf(ReviewCoachValidationError);
  });

  it("refuses a correction that does not name anything to retire", async () => {
    await seedV2Task();
    await expect(repository.supersedeEvidence(event({
      id: "supersede-1",
      kind: "evidence-superseded",
      disposition: undefined,
      idempotencyKey: "supersede-key-1",
    }))).rejects.toBeInstanceOf(ReviewCoachValidationError);
  });

  it("refuses to retire another task's turn", async () => {
    // Without the ownership check, any task could erase another task's evidence.
    // `supersededTurnIds` is a global set, so a cross-task retire would silently
    // un-close a loop the acting task never participated in.
    const { turns } = await seedV2Task();
    const outsider = {
      ...structuredClone(turns[0]),
      id: "turn-other-task",
      taskId: "task-v2-OTHER",
      // `idempotencyKey` and the per-task slot key are unique indexes, so the
      // clone needs its own values to be storable at all.
      idempotencyKey: "turn-other-task-key",
      activeSlotKey: undefined,
    };
    await database.adaptiveQuizTurns.put(outsider);

    await expect(repository.supersedeEvidence(event({
      id: "supersede-cross",
      turnId: outsider.id,
      kind: "evidence-superseded",
      disposition: undefined,
      supersededTurnId: outsider.id,
      supersedeReason: "misjudged",
      idempotencyKey: "supersede-key-cross",
    }))).rejects.toThrow("belongs to a different task");

    // Nothing was written.
    const all = await database.taskOutcomeEvents.where("taskId").equals("task-v2-1").toArray();
    expect(all.filter((item) => item.kind === "evidence-superseded")).toHaveLength(0);
  });

  it("refuses to retire another task's answer event", async () => {
    await seedV2Task();
    await database.taskOutcomeEvents.put(event({
      id: "answer-other",
      taskId: "task-v2-OTHER",
      kind: "answer-assessment",
      disposition: undefined,
      answerAssessment: "correct",
      idempotencyKey: "answer-other",
    }));

    await expect(repository.supersedeEvidence(event({
      id: "supersede-cross-event",
      kind: "evidence-superseded",
      disposition: undefined,
      supersededEventId: "answer-other",
      supersedeReason: "misjudged",
      idempotencyKey: "supersede-key-cross-event",
    }))).rejects.toThrow("belongs to a different task");
  });
});
