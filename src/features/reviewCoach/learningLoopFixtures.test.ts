import { describe, expect, it } from "vitest";

import { closedLoopV2Fixtures } from "./learningLoopFixtures";
import { CLOSED_LOOP_V2_LOOP_VERSION, requiredQualifyingRetrievalsV2 } from "./learningLoopPolicy";
import { coachTestBlueprint, coachTestTask, coachTestTurn, completeCoachTestSnapshot } from "./reviewCoachTestFixtures";
describe("v1 fixtures stay readable as history", () => {
  it("keeps the legacy self-assessment based snapshot shape", () => {
    const snapshot = completeCoachTestSnapshot();
    expect(snapshot.adaptiveReviewTasks).toHaveLength(1);
    expect(snapshot.taskOutcomeEvents.some((event) => event.kind === "self-assessment")).toBe(true);
    expect(snapshot.delayedVerifications[0].verificationOutcome).toBe("retained");
    // The v1 blueprint is a freeze of the pre-v2 contract; it must not be
    // silently reinterpreted as a v2 blueprint.
    expect(coachTestBlueprint.maxTurns).toBe(4);
    expect(coachTestBlueprint.loopVersion).toBeUndefined();
    expect(coachTestTask.loopVersion).toBeUndefined();
    expect(coachTestTurn.phase).toBeUndefined();
  });
});

describe("v2 fixtures pin the closed-loop contract", () => {
  it("declares the fixed product rules rather than derived numbers", () => {
    expect(requiredQualifyingRetrievalsV2).toBe(2);
    expect(CLOSED_LOOP_V2_LOOP_VERSION).toBe("closed-loop-v2");
  });

  it("creates blueprints that budget at least two display turns", () => {
    const { blueprint } = closedLoopV2Fixtures();
    expect(blueprint.loopVersion).toBe("closed-loop-v2");
    expect(blueprint.maxTurns).toBeGreaterThanOrEqual(requiredQualifyingRetrievalsV2);
  });

  it("normalizes an AI-proposed maxTurns of 1 up to the v2 floor", () => {
    const { blueprint } = closedLoopV2Fixtures({ maxTurns: 1 });
    expect(blueprint.maxTurns).toBe(2);
  });

  it("stops after the initial retrieval unless the loop is asked to close", () => {
    // The default attempt is deliberately unfinished: a single answer is not a
    // closed loop, and a fixture that shipped both phases by default would let
    // tests treat one retrieval as completion.
    expect(closedLoopV2Fixtures().turns.map((turn) => turn.phase)).toEqual(["initial"]);
  });

  it("marks the initial and post-judgment retrievals with distinct phases", () => {
    const { turns } = closedLoopV2Fixtures({ loop: "closed" });
    expect(turns.map((turn) => turn.phase)).toEqual(["initial", "post-judgment"]);
    expect(turns.every((turn) => turn.independenceStatus === "independent")).toBe(true);
  });

  it("records the AI evaluation mechanism honestly", () => {
    const { turns } = closedLoopV2Fixtures({ loop: "closed" });
    for (const turn of turns) {
      expect(turn.judgmentMechanism).toBe("ai-evaluation");
      // An AI evaluation can never claim an official reference.
      expect(turn.referenceOrigin).toBe("ai-generated");
    }
  });

  it("keeps the task open until the loop actually closes", () => {
    const { task } = closedLoopV2Fixtures();
    expect(task.loopVersion).toBe("closed-loop-v2");
    expect(task.status).toBe("in-progress");
  });
});
