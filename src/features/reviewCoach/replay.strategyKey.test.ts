import { describe, expect, it } from "vitest";

import type { AdaptiveQuizTurn } from "./domain";
import { replayInterventionEffectSummaries } from "./replay";
import { coachTestAnswerOutcome, coachTestMasteredOutcome, completeCoachTestSnapshot } from "./reviewCoachTestFixtures";

const taskWithTurns = (taskId: string) => {
  const snapshot = completeCoachTestSnapshot();
  return { ...snapshot.adaptiveReviewTasks[0], id: taskId, idempotencyKey: `task-${taskId}` };
};

const turn = (
  id: string,
  taskId: string,
  overrides: Partial<AdaptiveQuizTurn> = {},
): AdaptiveQuizTurn => {
  const snapshot = completeCoachTestSnapshot();
  return {
    ...snapshot.adaptiveQuizTurns[0],
    id,
    taskId,
    idempotencyKey: `turn-op-${id}`,
    ...overrides,
  };
};

const turnOutcome = (taskId: string, turnId: string) => ({
  ...coachTestAnswerOutcome,
  id: `answer-${turnId}`,
  taskId,
  turnId,
  idempotencyKey: `outcome-answer-${turnId}`,
});

const masteryOutcome = (taskId: string) => ({
  ...coachTestMasteredOutcome,
  id: `mastered-${taskId}`,
  taskId,
  idempotencyKey: `outcome-mastered-${taskId}`,
});

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

describe("review coach effect attribution to the practice actually used (F-14)", () => {
  it("splits one blueprint into one strategy key per distinct actual practice type and hint level", () => {
    const snapshot = completeCoachTestSnapshot();
    const tasks = [taskWithTurns("task-variation"), taskWithTurns("task-concept")];
    const turns = [
      // Planned "variation", stayed "variation", never asked for a hint.
      turn("turn-a1", "task-variation", { sequence: 1, practiceType: "variation", hintsUsed: [] }),
      // Branched away from the planned type and asked for an explanation (level 2).
      turn("turn-b1", "task-concept", {
        sequence: 1,
        practiceType: "concept-question",
        hintsUsed: [{ level: 2, requestedAt: "2026-09-04T08:00:00.000Z" }],
      }),
    ];
    const outcomes = [
      turnOutcome("task-variation", "turn-a1"),
      turnOutcome("task-concept", "turn-b1"),
      masteryOutcome("task-variation"),
      masteryOutcome("task-concept"),
    ];

    const effects = replayInterventionEffectSummaries({
      interpretations: snapshot.feedbackInterpretations,
      blueprints: snapshot.sessionBlueprints,
      tasks,
      turns,
      outcomes,
      verifications: [],
      replayedAt: "2026-09-12T08:00:00.000Z",
    });

    expect(effects).toHaveLength(2);
    const variation = effects.find((effect) => effect.actualPracticeType === "variation")!;
    const concept = effects.find((effect) => effect.actualPracticeType === "concept-question")!;

    // The planned type is shared, so only the new dimensions separate the two samples.
    expect(variation.practiceType).toBe("variation");
    expect(concept.practiceType).toBe("variation");
    expect(variation.hintLevelUsed).toBe("none");
    expect(concept.hintLevelUsed).toBe("explain-or-worked-example");
    expect(variation.sampleCount).toBe(1);
    expect(concept.sampleCount).toBe(1);
    expect(variation.objectiveCorrectRate).toBe(1);
    expect(concept.objectiveCorrectRate).toBe(1);
    expect(variation.strategyKey).not.toBe(concept.strategyKey);
    expect(variation.strategyKey.endsWith(":variation:none:quiz-turn-v1")).toBe(true);
    expect(concept.strategyKey.endsWith(":concept-question:explain-or-worked-example:quiz-turn-v1")).toBe(true);
  });

  it("separates level-1 hints from level-2 hints", () => {
    const snapshot = completeCoachTestSnapshot();
    const tasks = [taskWithTurns("task-light"), taskWithTurns("task-deep")];
    const turns = [
      turn("turn-light", "task-light", { practiceType: "cloze", hintsUsed: [{ level: 1, requestedAt: "2026-09-04T08:00:00.000Z" }] }),
      turn("turn-deep", "task-deep", { practiceType: "cloze", hintsUsed: [{ level: 3, requestedAt: "2026-09-04T08:00:00.000Z" }] }),
    ];

    const effects = replayInterventionEffectSummaries({
      interpretations: snapshot.feedbackInterpretations,
      blueprints: snapshot.sessionBlueprints,
      tasks,
      turns,
      outcomes: [turnOutcome("task-light", "turn-light"), turnOutcome("task-deep", "turn-deep")],
      verifications: [],
      replayedAt: "2026-09-12T08:00:00.000Z",
    });

    expect(effects.map((effect) => effect.hintLevelUsed).sort()).toEqual(["explain-or-worked-example", "hint-only"]);
  });

  it("does not pool samples produced under different turn-level prompt versions", () => {
    const snapshot = completeCoachTestSnapshot();
    const tasks = [taskWithTurns("task-v1"), taskWithTurns("task-v2")];
    const turns = [
      turn("turn-v1", "task-v1", { practiceType: "variation", promptVersion: "quiz-turn-v1" }),
      turn("turn-v2", "task-v2", { practiceType: "variation", promptVersion: "quiz-turn-v2" }),
    ];

    const effects = replayInterventionEffectSummaries({
      interpretations: snapshot.feedbackInterpretations,
      blueprints: snapshot.sessionBlueprints,
      tasks,
      turns,
      outcomes: [turnOutcome("task-v1", "turn-v1"), turnOutcome("task-v2", "turn-v2")],
      verifications: [],
      replayedAt: "2026-09-12T08:00:00.000Z",
    });

    // The blueprint-level dimensions are identical, so only the turn-level version can split them.
    expect(effects).toHaveLength(2);
    expect(effects.map((effect) => effect.strategyKey.split(":").at(-1)).sort()).toEqual(["quiz-turn-v1", "quiz-turn-v2"]);
  });

  it("still emits one entry for an accepted blueprint that has no intervention task yet", () => {
    const snapshot = completeCoachTestSnapshot();

    const effects = replayInterventionEffectSummaries({
      interpretations: snapshot.feedbackInterpretations,
      blueprints: snapshot.sessionBlueprints,
      tasks: [],
      turns: [],
      outcomes: [],
      verifications: [],
      replayedAt: "2026-09-12T08:00:00.000Z",
    });

    expect(effects).toHaveLength(1);
    expect(effects[0]).toMatchObject({ actualPracticeType: "none", hintLevelUsed: "none", sampleCount: 0 });
  });

  it("groups identically for any input order of the same fact set", () => {
    const snapshot = completeCoachTestSnapshot();
    const tasks = [
      taskWithTurns("task-a"),
      taskWithTurns("task-b"),
      taskWithTurns("task-c"),
    ];
    const turns = [
      turn("turn-a", "task-a", { practiceType: "variation" }),
      turn("turn-b", "task-b", { practiceType: "concept-question", hintsUsed: [{ level: 2, requestedAt: "2026-09-04T08:00:00.000Z" }] }),
      turn("turn-c", "task-c", { practiceType: "variation" }),
    ];
    const outcomes = [
      turnOutcome("task-a", "turn-a"),
      turnOutcome("task-b", "turn-b"),
      turnOutcome("task-c", "turn-c"),
      masteryOutcome("task-a"),
    ];

    const baseline = replayInterventionEffectSummaries({
      interpretations: snapshot.feedbackInterpretations,
      blueprints: snapshot.sessionBlueprints,
      tasks,
      turns,
      outcomes,
      verifications: [],
      replayedAt: "2026-09-12T08:00:00.000Z",
    });
    const reordered = replayInterventionEffectSummaries({
      interpretations: shuffle(snapshot.feedbackInterpretations, 3),
      blueprints: shuffle(snapshot.sessionBlueprints, 5),
      tasks: shuffle(tasks, 7),
      turns: shuffle(turns, 11),
      outcomes: shuffle(outcomes, 13),
      verifications: [],
      replayedAt: "2026-09-12T08:00:00.000Z",
    });

    // task-a and task-c share every dimension, so they must land in the same bucket.
    expect(baseline).toHaveLength(2);
    expect(reordered).toEqual(baseline);
  });
});
