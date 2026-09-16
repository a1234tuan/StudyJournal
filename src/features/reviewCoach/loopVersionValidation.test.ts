import { describe, expect, it } from "vitest";

import type { DelayedVerification, ReviewCoachFormalSnapshot, TaskOutcomeEvent } from "./domain";
import { EMPTY_REVIEW_COACH_FORMAL_SNAPSHOT } from "./domain";
import { closedLoopV2Fixtures } from "./learningLoopFixtures";
import { validateReviewCoachFormalSnapshot } from "./validation";
import {
  coachTestAnswerOutcome,
  coachTestBlock,
  coachTestCompletedDisposition,
  coachTestMasteredOutcome,
  completeCoachTestSnapshot,
} from "./reviewCoachTestFixtures";

const v2Snapshot = (): ReviewCoachFormalSnapshot => {
  const { blueprint, task, turns } = closedLoopV2Fixtures({ loop: "closed" });
  const base = completeCoachTestSnapshot();
  return {
    ...base,
    // Drop the v1 task/verification so only the v2 entities are under test.
    sessionBlueprints: [blueprint],
    adaptiveReviewTasks: [task],
    adaptiveQuizTurns: turns,
    taskOutcomeEvents: [],
    delayedVerifications: [],
  };
};

const completedDisposition = (taskId: string): TaskOutcomeEvent => ({
  ...structuredClone(coachTestCompletedDisposition),
  id: `disposition-${taskId}`,
  taskId,
  occurredAt: "2026-09-15T10:00:00.000Z",
  idempotencyKey: `disposition-key-${taskId}`,
});

/** A valid post-judgment answer event plus the answer event a self-assessment needs. */
const answerEvent = (
  taskId: string,
  turnId: string,
  overrides: Partial<TaskOutcomeEvent> = {},
): TaskOutcomeEvent => ({
  ...structuredClone(coachTestAnswerOutcome),
  id: "post-answer-event",
  taskId,
  turnId,
  occurredAt: "2026-09-15T09:30:00.000Z",
  idempotencyKey: "post-answer-key",
  ...overrides,
});

describe("v1 history keeps validating under the old rules", () => {
  it("accepts the frozen v1 snapshot unchanged", () => {
    expect(() => validateReviewCoachFormalSnapshot(completeCoachTestSnapshot())).not.toThrow();
  });

  it("still requires a self-assessment for a v1 completed task", () => {
    const snapshot = completeCoachTestSnapshot();
    expect(() => validateReviewCoachFormalSnapshot(snapshot)).not.toThrow();
    expect(snapshot.taskOutcomeEvents).toContainEqual(expect.objectContaining({ kind: "self-assessment" }));
    expect(snapshot.taskOutcomeEvents).toContainEqual(coachTestMasteredOutcome);
    expect(snapshot.taskOutcomeEvents).toContainEqual(coachTestAnswerOutcome);
  });

  it("keeps accepting a v1 self-assessment sourced verification", () => {
    const snapshot = completeCoachTestSnapshot();
    expect(snapshot.delayedVerifications[0].loopVersion).toBeUndefined();
    expect(() => validateReviewCoachFormalSnapshot(snapshot)).not.toThrow();
  });
});

describe("v2 completion cannot rest on self-report", () => {
  it("rejects a completed v2 task with no qualifying post-judgment retrieval", () => {
    const snapshot = v2Snapshot();
    snapshot.adaptiveReviewTasks = [{ ...snapshot.adaptiveReviewTasks[0], status: "completed" }];
    snapshot.taskOutcomeEvents = [completedDisposition(snapshot.adaptiveReviewTasks[0].id)];
    // Remove the second retrieval: feedback was never followed by retrieval.
    snapshot.adaptiveQuizTurns = snapshot.adaptiveQuizTurns.filter((turn) => turn.phase !== "post-judgment");

    expect(() => validateReviewCoachFormalSnapshot(snapshot))
      .toThrow(expect.objectContaining({ code: "loop-not-closed" }));
  });

  it("accepts a completed v2 task that has both qualifying retrievals", () => {
    const snapshot = v2Snapshot();
    const taskId = snapshot.adaptiveReviewTasks[0].id;
    snapshot.adaptiveReviewTasks = [{ ...snapshot.adaptiveReviewTasks[0], status: "completed" }];
    snapshot.taskOutcomeEvents = [completedDisposition(taskId)];

    expect(() => validateReviewCoachFormalSnapshot(snapshot)).not.toThrow();
  });

  it("rejects a completed v2 task that still carries a subjective outcome", () => {
    const snapshot = v2Snapshot();
    const taskId = snapshot.adaptiveReviewTasks[0].id;
    const postJudgment = snapshot.adaptiveQuizTurns.find((turn) => turn.phase === "post-judgment")!;
    snapshot.adaptiveReviewTasks = [{ ...snapshot.adaptiveReviewTasks[0], status: "completed" }];
    snapshot.taskOutcomeEvents = [
      answerEvent(taskId, postJudgment.id),
      completedDisposition(taskId),
      {
        ...structuredClone(coachTestMasteredOutcome),
        id: "self-2",
        taskId,
        occurredAt: "2026-09-15T10:01:00.000Z",
        idempotencyKey: "self-key-2",
      },
    ];

    expect(() => validateReviewCoachFormalSnapshot(snapshot))
      .toThrow(expect.objectContaining({ code: "self-report-drives-completion" }));
  });
});

describe("v2 verification sources", () => {
  const verification = (overrides: Partial<DelayedVerification> = {}): DelayedVerification => ({
    id: "verification-v2",
    decisionBlockId: coachTestBlock.id,
    recordId: coachTestBlock.recordId,
    contentVersion: 1,
    sourceOutcomeEventId: "post-answer-event",
    status: "scheduled",
    verificationEligibleAt: "2026-09-16T08:00:00.000Z",
    verificationDueAt: "2026-09-18T08:00:00.000Z",
    strategyVersion: "delayed-verification-v2",
    idempotencyKey: "verification-v2-key",
    loopVersion: "closed-loop-v2",
    createdAt: "2026-09-15T10:00:00.000Z",
    updatedAt: "2026-09-15T10:00:00.000Z",
    ...overrides,
  });

  it("accepts a post-judgment answer event as the source", () => {
    const snapshot = v2Snapshot();
    const taskId = snapshot.adaptiveReviewTasks[0].id;
    const postJudgment = snapshot.adaptiveQuizTurns.find((turn) => turn.phase === "post-judgment")!;
    snapshot.taskOutcomeEvents = [answerEvent(taskId, postJudgment.id)];
    snapshot.delayedVerifications = [verification()];

    expect(() => validateReviewCoachFormalSnapshot(snapshot)).not.toThrow();
  });

  it("rejects a v2 verification opened by a self-assessment", () => {
    const snapshot = v2Snapshot();
    const taskId = snapshot.adaptiveReviewTasks[0].id;
    const postJudgment = snapshot.adaptiveQuizTurns.find((turn) => turn.phase === "post-judgment")!;
    snapshot.taskOutcomeEvents = [
      answerEvent(taskId, postJudgment.id, { id: "earlier-answer", idempotencyKey: "earlier-answer-key" }),
      {
        ...structuredClone(coachTestMasteredOutcome),
        id: "post-answer-event",
        taskId,
        occurredAt: "2026-09-15T09:40:00.000Z",
        idempotencyKey: "self-key",
      },
    ];
    snapshot.delayedVerifications = [verification()];

    expect(() => validateReviewCoachFormalSnapshot(snapshot))
      .toThrow(expect.objectContaining({ code: "invalid-verification-source" }));
  });

  it("rejects a v2 verification sourced from an initial-phase turn", () => {
    const snapshot = v2Snapshot();
    const taskId = snapshot.adaptiveReviewTasks[0].id;
    const initial = snapshot.adaptiveQuizTurns.find((turn) => turn.phase === "initial")!;
    snapshot.taskOutcomeEvents = [answerEvent(taskId, initial.id)];
    snapshot.delayedVerifications = [verification()];

    expect(() => validateReviewCoachFormalSnapshot(snapshot))
      .toThrow(expect.objectContaining({ code: "invalid-verification-source" }));
  });

  it("requires derived evidence rather than a self-reported retained outcome on completion", () => {
    const snapshot = v2Snapshot();
    const taskId = snapshot.adaptiveReviewTasks[0].id;
    const postJudgment = snapshot.adaptiveQuizTurns.find((turn) => turn.phase === "post-judgment")!;
    snapshot.taskOutcomeEvents = [answerEvent(taskId, postJudgment.id)];
    snapshot.delayedVerifications = [verification({
      status: "completed",
      lastVerifiedAt: "2026-09-16T08:00:00.000Z",
      evidenceStatus: "provisional-pass",
      evidenceTurnId: postJudgment.id,
    })];

    expect(() => validateReviewCoachFormalSnapshot(snapshot)).not.toThrow();
  });

  it("refuses to complete a v2 verification on ineligible evidence", () => {
    const snapshot = v2Snapshot();
    const taskId = snapshot.adaptiveReviewTasks[0].id;
    const postJudgment = snapshot.adaptiveQuizTurns.find((turn) => turn.phase === "post-judgment")!;
    snapshot.taskOutcomeEvents = [answerEvent(taskId, postJudgment.id)];
    snapshot.delayedVerifications = [verification({
      status: "completed",
      lastVerifiedAt: "2026-09-16T08:00:00.000Z",
      evidenceStatus: "ineligible",
    })];

    expect(() => validateReviewCoachFormalSnapshot(snapshot))
      .toThrow(expect.objectContaining({ code: "missing-verification-outcome" }));
  });
});

describe("v2 event shapes", () => {
  it("accepts an intervention selection that carries no result category", () => {
    const snapshot = v2Snapshot();
    const taskId = snapshot.adaptiveReviewTasks[0].id;
    snapshot.taskOutcomeEvents = [{
      ...answerEvent(taskId, "turn-v2-1"),
      id: "intervention-1",
      kind: "intervention-selected",
      answerAssessment: undefined,
      interventionPath: "confused",
      idempotencyKey: "intervention-key-1",
    }];
    expect(() => validateReviewCoachFormalSnapshot(snapshot)).not.toThrow();
  });

  it("rejects an intervention selection that also claims a result", () => {
    const snapshot = v2Snapshot();
    const taskId = snapshot.adaptiveReviewTasks[0].id;
    snapshot.taskOutcomeEvents = [{
      ...answerEvent(taskId, "turn-v2-1"),
      id: "intervention-1",
      kind: "intervention-selected",
      interventionPath: "confused",
      idempotencyKey: "intervention-key-1",
    }];
    expect(() => validateReviewCoachFormalSnapshot(snapshot))
      .toThrow(expect.objectContaining({ code: "invalid-outcome-shape" }));
  });

  it("requires a supersede event to say what it retires and why", () => {
    const snapshot = v2Snapshot();
    const taskId = snapshot.adaptiveReviewTasks[0].id;
    snapshot.taskOutcomeEvents = [{
      ...answerEvent(taskId, "turn-v2-1"),
      id: "supersede-1",
      kind: "evidence-superseded",
      answerAssessment: undefined,
      idempotencyKey: "supersede-key-1",
    }];
    expect(() => validateReviewCoachFormalSnapshot(snapshot))
      .toThrow(expect.objectContaining({ code: "invalid-outcome-shape" }));
  });
});

describe("empty snapshots stay valid", () => {
  it("accepts the empty formal snapshot", () => {
    expect(() => validateReviewCoachFormalSnapshot(structuredClone(EMPTY_REVIEW_COACH_FORMAL_SNAPSHOT))).not.toThrow();
  });
});
