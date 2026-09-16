import { describe, expect, it } from "vitest";

import type { TaskOutcomeEvent } from "./domain";
import {
  INTERVENTION_ACTIONS,
  MAX_CONSECUTIVE_EXECUTION_FAILED,
  independenceForTurn,
  interventionActionFor,
  interventionOptionsFor,
  resolveInterventionChoice,
} from "./interventionPolicy";
import { coachTestBlock, coachTestStamp } from "./reviewCoachTestFixtures";

/**
 * M3: the three action paths.
 *
 * The learner picks an *action*. These tests pin the mapping to follow-up work,
 * and the anti-self-esteem rule that stops the third "I could but did not
 * produce it" from being honoured.
 */

const selection = (
  index: number,
  path: TaskOutcomeEvent["interventionPath"],
): TaskOutcomeEvent => ({
  id: `intervention-${index}`,
  taskId: "task-v2-1",
  decisionBlockId: coachTestBlock.id,
  recordId: coachTestBlock.recordId,
  contentVersion: 1,
  kind: "intervention-selected",
  interventionPath: path,
  occurredAt: `2026-09-15T08:0${index}:00.000Z`,
  idempotencyKey: `intervention-${index}`,
  createdAt: coachTestStamp,
  updatedAt: coachTestStamp,
});

describe("intervention paths (M3)", () => {
  it("offers exactly three actions, each stating an action rather than a diagnosis", () => {
    expect(INTERVENTION_ACTIONS.map((item) => item.path)).toEqual(["not-formed", "confused", "execution-failed"]);
    const labels = INTERVENTION_ACTIONS.map((item) => item.label);
    expect(labels).toEqual(["我没有想出来", "我记混了", "我会，但没写出来"]);
    // No label may ask the learner to name a cause, a deficiency or a mastery level.
    for (const label of labels) {
      expect(label).not.toMatch(/掌握|能力|基础|因为|原因|先修/);
    }
  });

  it("routes each action to distinct follow-up work", () => {
    expect(interventionActionFor("not-formed").nextStrategy).toBe("rebuild");
    expect(interventionActionFor("confused").nextStrategy).toBe("discriminate");
    expect(interventionActionFor("execution-failed").nextStrategy).toBe("produce");
    const strategies = INTERVENTION_ACTIONS.map((item) => item.nextStrategy);
    expect(new Set(strategies).size).toBe(3);
  });

  it("records the chosen path unchanged on the first two attempts", () => {
    const first = resolveInterventionChoice("execution-failed", []);
    expect(first).toMatchObject({ path: "execution-failed", downgraded: false, consecutiveExecutionFailed: 0 });

    const second = resolveInterventionChoice("execution-failed", [selection(1, "execution-failed")]);
    expect(second).toMatchObject({ path: "execution-failed", downgraded: false, consecutiveExecutionFailed: 1 });
  });

  it("forces the third consecutive execution-failed choice into the material path", () => {
    const events = [selection(1, "execution-failed"), selection(2, "execution-failed")];
    const resolution = resolveInterventionChoice("execution-failed", events);
    expect(resolution.requested).toBe("execution-failed");
    expect(resolution.downgraded).toBe(true);
    expect(resolution.path).toBe("not-formed");
    expect(resolution.action.nextStrategy).toBe("rebuild");
    expect(MAX_CONSECUTIVE_EXECUTION_FAILED).toBe(2);
  });

  it("lets another action break the execution-failed streak", () => {
    const events = [
      selection(1, "execution-failed"),
      selection(2, "execution-failed"),
      selection(3, "confused"),
    ];
    const resolution = resolveInterventionChoice("execution-failed", events);
    expect(resolution).toMatchObject({ downgraded: false, consecutiveExecutionFailed: 0 });
  });

  it("marks the execution-failed option as forced rather than hiding it", () => {
    const events = [selection(1, "execution-failed"), selection(2, "execution-failed")];
    const options = interventionOptionsFor(events);
    expect(options).toHaveLength(3);
    expect(options.find((item) => item.path === "execution-failed")?.forced).toBe(true);
    expect(options.find((item) => item.path === "confused")?.forced).toBe(false);
    // The option stays visible: hiding it would read as a bug.
    expect(options.some((item) => item.path === "execution-failed")).toBe(true);
  });

  it("treats a hinted retrieval as assisted and a clean one as independent", () => {
    expect(independenceForTurn(0)).toBe("independent");
    expect(independenceForTurn(1)).toBe("assisted");
    expect(independenceForTurn(3)).toBe("assisted");
  });
});
