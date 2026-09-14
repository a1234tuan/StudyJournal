import { describe, expect, it } from "vitest";

import type { DecisionBlockFeedback } from "./domain";
import { replayDecisionBlockState } from "./replay";
import { coachTestFeedback, completeCoachTestSnapshot } from "./reviewCoachTestFixtures";

const newerFeedback = (occurredAt: string): DecisionBlockFeedback => ({
  ...coachTestFeedback,
  id: "feedback-newer",
  comment: "T2: I am still unsure about the marking order.",
  occurredAt,
  idempotencyKey: "feedback-operation-newer",
});

describe("review coach projection precedence (F-08)", () => {
  it("lets unprocessed feedback outrank an older mastery result", () => {
    const snapshot = completeCoachTestSnapshot();
    const feedback = newerFeedback("2026-09-05T08:00:00.000Z");
    const state = replayDecisionBlockState({
      block: snapshot.decisionBlocks[0],
      feedback: [...snapshot.decisionBlockFeedback, feedback],
      queueItems: [],
      blueprints: snapshot.sessionBlueprints,
      tasks: snapshot.adaptiveReviewTasks,
      turns: snapshot.adaptiveQuizTurns,
      outcomes: snapshot.taskOutcomeEvents,
      // The fixture's completed verification is deliberately dropped so the only content event is
      // the T1 self-assessment ("mastered"); T2 feedback is strictly newer than it.
      verifications: [],
      replayedAt: "2026-09-06T08:00:00.000Z",
    });

    expect(state.status).toBe("needs-analysis");
    expect(state.lastFeedbackAt).toBe(feedback.occurredAt);
  });

  it("keeps the mastery result when the feedback is older than it", () => {
    const snapshot = completeCoachTestSnapshot();
    const state = replayDecisionBlockState({
      block: snapshot.decisionBlocks[0],
      feedback: [newerFeedback("2026-09-03T08:00:00.000Z")],
      queueItems: [],
      blueprints: snapshot.sessionBlueprints,
      tasks: snapshot.adaptiveReviewTasks,
      turns: snapshot.adaptiveQuizTurns,
      outcomes: snapshot.taskOutcomeEvents,
      verifications: [],
      replayedAt: "2026-09-06T08:00:00.000Z",
    });

    expect(state.status).toBe("improved-pending-verification");
  });

  it("still lets a task in flight outrank everything else", () => {
    const snapshot = completeCoachTestSnapshot();
    const state = replayDecisionBlockState({
      block: snapshot.decisionBlocks[0],
      feedback: [snapshot.decisionBlockFeedback[0], newerFeedback("2026-09-09T08:00:00.000Z")],
      queueItems: [],
      blueprints: snapshot.sessionBlueprints,
      tasks: [{ ...snapshot.adaptiveReviewTasks[0], status: "in-progress" }],
      turns: snapshot.adaptiveQuizTurns,
      outcomes: snapshot.taskOutcomeEvents,
      verifications: [],
      replayedAt: "2026-09-10T08:00:00.000Z",
    });

    expect(state.status).toBe("learning");
    expect(state.currentTaskId).toBe(snapshot.adaptiveReviewTasks[0].id);
  });

  it("falls back to planned when no content event decides the status", () => {
    const snapshot = completeCoachTestSnapshot();
    const state = replayDecisionBlockState({
      block: snapshot.decisionBlocks[0],
      feedback: [],
      queueItems: [],
      blueprints: snapshot.sessionBlueprints,
      tasks: snapshot.adaptiveReviewTasks,
      turns: snapshot.adaptiveQuizTurns,
      outcomes: [],
      verifications: [],
      replayedAt: "2026-09-06T08:00:00.000Z",
    });

    expect(state.status).toBe("planned");
  });

  it("reports unassessed when there is neither a plan nor any result", () => {
    const snapshot = completeCoachTestSnapshot();
    const state = replayDecisionBlockState({
      block: snapshot.decisionBlocks[0],
      feedback: [],
      queueItems: [],
      blueprints: [],
      tasks: [],
      turns: [],
      outcomes: [],
      verifications: [],
      replayedAt: "2026-09-06T08:00:00.000Z",
    });

    expect(state.status).toBe("unassessed");
  });
});
