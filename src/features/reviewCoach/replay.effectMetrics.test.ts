import { describe, expect, it } from "vitest";

import type { AdaptiveQuizTurn, TaskOutcomeEvent } from "./domain";
import { replayInterventionEffectSummaries, type InterventionReplayInput } from "./replay";
import {
  coachTestAnswerOutcome,
  coachTestMasteredOutcome,
  coachTestVerification,
  completeCoachTestSnapshot,
} from "./reviewCoachTestFixtures";

/** One self-assessment event per task, so a multi-task sample never reuses an idempotency key. */
const selfAssessment = (taskId: string, occurredAt: string): TaskOutcomeEvent => ({
  ...coachTestMasteredOutcome,
  id: `mastered-${taskId}`,
  taskId,
  occurredAt,
  idempotencyKey: `outcome-mastered-${taskId}`,
});

const answerAssessment = (
  taskId: string,
  turnId: string,
  assessment: NonNullable<AdaptiveQuizTurn["assessment"]>,
  occurredAt: string,
): TaskOutcomeEvent => ({
  ...coachTestAnswerOutcome,
  id: `answer-${turnId}`,
  taskId,
  turnId,
  answerAssessment: assessment,
  occurredAt,
  idempotencyKey: `outcome-answer-${turnId}`,
});

const turn = (overrides: Partial<AdaptiveQuizTurn> & Pick<AdaptiveQuizTurn, "id" | "taskId">): AdaptiveQuizTurn => {
  const snapshot = completeCoachTestSnapshot();
  return { ...snapshot.adaptiveQuizTurns[0], idempotencyKey: `turn-op-${overrides.id}`, ...overrides };
};

const replay = (input: Partial<InterventionReplayInput>): ReturnType<typeof replayInterventionEffectSummaries> => {
  const snapshot = completeCoachTestSnapshot();
  return replayInterventionEffectSummaries({
    interpretations: snapshot.feedbackInterpretations,
    blueprints: snapshot.sessionBlueprints,
    tasks: snapshot.adaptiveReviewTasks,
    turns: [],
    outcomes: [],
    verifications: [],
    replayedAt: "2026-09-12T08:00:00.000Z",
    ...input,
  });
};

/** Deterministic Fisher-Yates so a failing seed is reproducible. */
const shuffle = <T,>(items: readonly T[], seed: number): T[] => {
  const result = [...items];
  let state = seed;
  for (let index = result.length - 1; index > 0; index -= 1) {
    state = (state * 1103515245 + 12345) % 2147483648;
    const swap = state % (index + 1);
    [result[index], result[swap]] = [result[swap], result[index]];
  }
  return result;
};

describe("review coach objective effect metrics (F-18 / F-02)", () => {
  it("computes an objective correct rate that ignores the self-report and reads mastery from the last turn", () => {
    const snapshot = completeCoachTestSnapshot();
    const task = snapshot.adaptiveReviewTasks[0];
    const turns = [
      turn({ id: "turn-1", taskId: task.id, sequence: 1, assessment: "partial" }),
      turn({ id: "turn-2", taskId: task.id, sequence: 2, assessment: "incorrect" }),
      turn({ id: "turn-3", taskId: task.id, sequence: 3, assessment: "correct" }),
    ];
    const outcomes = [
      answerAssessment(task.id, "turn-1", "partial", "2026-09-04T08:00:00.000Z"),
      answerAssessment(task.id, "turn-2", "incorrect", "2026-09-04T08:01:00.000Z"),
      answerAssessment(task.id, "turn-3", "correct", "2026-09-04T08:02:00.000Z"),
      selfAssessment(task.id, "2026-09-04T09:00:00.000Z"),
    ];

    const [effect] = replay({ tasks: [task], turns, outcomes });

    expect(effect.objectiveAnswerCount).toBe(3);
    expect(effect.objectiveCorrectRate).toBeCloseTo(1 / 3);
    expect(effect.objectivePartialCount).toBe(1);
    expect(effect.objectiveIncorrectCount).toBe(1);
    // The primary figure stays the self-report, unaffected by the objective breakdown.
    expect(effect.selfReportedMasteredCount).toBe(1);
    expect(effect.masteryAssessmentBreakdown).toEqual({ correct: 1, partial: 0, incorrect: 0 });
  });

  it("keeps the objective usability gate separate from the self-report gate (D-1 option b guardrail)", () => {
    const snapshot = completeCoachTestSnapshot();
    const base = snapshot.adaptiveReviewTasks[0];
    const tasks = [
      base,
      { ...base, id: "task-2", idempotencyKey: "task-2" },
      { ...base, id: "task-3", idempotencyKey: "task-3" },
    ];

    const [effect] = replay({
      tasks,
      turns: [],
      outcomes: tasks.map((task) => selfAssessment(task.id, "2026-09-04T09:00:00.000Z")),
    });

    expect(effect.sampleCount).toBe(3);
    // The user-facing self-report figure is usable...
    expect(effect.evidenceStatus).toBe("usable");
    // ...even though there is no objective evidence at all.
    expect(effect.objectiveAnswerCount).toBe(0);
    expect(effect.objectiveEvidenceStatus).toBe("insufficient");
    expect(effect.objectiveCorrectRate).toBeUndefined();
  });

  it("never lets an unreliable judgement count as a wrong answer", () => {
    const snapshot = completeCoachTestSnapshot();
    const task = snapshot.adaptiveReviewTasks[0];
    const turns = [
      turn({ id: "turn-1", taskId: task.id, sequence: 1, assessment: "correct" }),
      turn({ id: "turn-2", taskId: task.id, sequence: 2, assessment: "unreliable", answerText: "[skipped]" }),
    ];
    const outcomes = [
      answerAssessment(task.id, "turn-1", "correct", "2026-09-04T08:00:00.000Z"),
      answerAssessment(task.id, "turn-2", "unreliable", "2026-09-04T08:01:00.000Z"),
      selfAssessment(task.id, "2026-09-04T09:00:00.000Z"),
    ];

    const [effect] = replay({ tasks: [task], turns, outcomes });

    expect(effect.objectiveAnswerCount).toBe(2);
    expect(effect.objectiveUnreliableCount).toBe(1);
    // Denominator is correct + partial + incorrect only.
    expect(effect.objectiveCorrectRate).toBe(1);
    // A skipped turn is not an attempt, so it must not inflate turns-to-mastery either:
    // the task has two turns, but only one is a real attempt.
    expect(effect.averageTurnsToMastery).toBe(1);
  });

  it("does not conflate the self-reported retention rate with the objective verification rate", () => {
    const snapshot = completeCoachTestSnapshot();
    const task = snapshot.adaptiveReviewTasks[0];
    const mastery = selfAssessment(task.id, "2026-09-04T09:00:00.000Z");
    const verification = {
      ...coachTestVerification,
      id: "verification-objective",
      taskId: "task-verify",
      sourceOutcomeEventId: mastery.id,
      idempotencyKey: "verification-objective",
    };
    const verificationTurn = turn({ id: "turn-verify", taskId: "task-verify", sequence: 1, assessment: "incorrect" });
    const tasks = [task, { ...task, id: "task-verify", idempotencyKey: "task-verify" }];

    const [effect] = replay({
      tasks,
      turns: [verificationTurn],
      outcomes: [mastery, answerAssessment("task-verify", "turn-verify", "incorrect", "2026-09-06T08:00:00.000Z")],
      verifications: [verification],
    });

    // The user said "I retained it"; the fresh retrieval says otherwise. Both are stored, neither overrides.
    expect(effect.retentionRate).toBe(1);
    expect(effect.verificationObjectiveCount).toBe(1);
    expect(effect.verificationObjectiveCorrectRate).toBe(0);
    expect(effect.retentionRate).not.toBe(effect.verificationObjectiveCorrectRate);
  });

  it("produces identical metrics for any input order of the same fact set", () => {
    const snapshot = completeCoachTestSnapshot();
    const task = snapshot.adaptiveReviewTasks[0];
    const tasks = [
      task,
      { ...task, id: "task-2", idempotencyKey: "task-2" },
      { ...task, id: "task-3", idempotencyKey: "task-3" },
    ];
    const turns = [
      turn({ id: "turn-1", taskId: task.id, sequence: 1, assessment: "partial", practiceType: "variation" }),
      turn({ id: "turn-2", taskId: "task-2", sequence: 1, assessment: "correct", practiceType: "concept-question" }),
      turn({ id: "turn-3", taskId: "task-3", sequence: 1, assessment: "incorrect", practiceType: "cloze" }),
    ];
    const outcomes = [
      selfAssessment(task.id, "2026-09-04T09:00:00.000Z"),
      selfAssessment("task-2", "2026-09-04T09:01:00.000Z"),
      answerAssessment(task.id, "turn-1", "partial", "2026-09-04T08:00:00.000Z"),
      answerAssessment("task-2", "turn-2", "correct", "2026-09-04T08:01:00.000Z"),
      answerAssessment("task-3", "turn-3", "incorrect", "2026-09-04T08:02:00.000Z"),
    ];

    const baseline = replay({ tasks, turns, outcomes });
    const reordered = replay({
      tasks: shuffle(tasks, 7),
      turns: shuffle(turns, 11),
      outcomes: shuffle(outcomes, 13),
      interpretations: shuffle(snapshot.feedbackInterpretations, 17),
    });

    expect(baseline).toHaveLength(3);
    expect(reordered).toEqual(baseline);
  });
});
