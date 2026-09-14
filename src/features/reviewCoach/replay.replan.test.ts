import { describe, expect, it } from "vitest";

import { listDecayedBlocksNeedingReplan } from "./replay";
import { coachTestFeedback, coachTestTask, completeCoachTestSnapshot } from "./reviewCoachTestFixtures";

const withDecayedVerification = () => {
  const snapshot = completeCoachTestSnapshot();
  snapshot.delayedVerifications[0] = { ...snapshot.delayedVerifications[0], verificationOutcome: "decayed" };
  return snapshot;
};

describe("review coach replan signals after a decay (F-03)", () => {
  it("reports a block whose newest word is a decay", () => {
    const snapshot = withDecayedVerification();

    expect(listDecayedBlocksNeedingReplan(snapshot)).toEqual([{
      decisionBlockId: snapshot.decisionBlocks[0].id,
      recordId: snapshot.decisionBlocks[0].recordId,
      contentVersion: snapshot.decisionBlocks[0].contentVersion,
      decayedAt: snapshot.delayedVerifications[0].lastVerifiedAt!,
    }]);
  });

  it("stops reporting once the user adds a newer note", () => {
    const snapshot = withDecayedVerification();
    snapshot.decisionBlockFeedback.push({
      ...coachTestFeedback,
      id: "feedback-after-decay",
      comment: "Saw the same mistake again today.",
      occurredAt: "2026-09-07T08:00:00.000Z",
      idempotencyKey: "feedback-after-decay",
    });

    expect(listDecayedBlocksNeedingReplan(snapshot)).toEqual([]);
  });

  it("stops reporting once a blueprint has been accepted after the decay", () => {
    const snapshot = withDecayedVerification();
    snapshot.sessionBlueprints.push({
      ...snapshot.sessionBlueprints[0],
      id: "blueprint-after-decay",
      createdAt: "2026-09-07T08:00:00.000Z",
      updatedAt: "2026-09-07T08:00:00.000Z",
      idempotencyKey: "blueprint-after-decay",
    });

    expect(listDecayedBlocksNeedingReplan(snapshot)).toEqual([]);
  });

  it("stops reporting while the user still has an open task on the block", () => {
    const snapshot = withDecayedVerification();
    snapshot.adaptiveReviewTasks.push({
      ...coachTestTask,
      id: "task-waiting",
      status: "waiting",
      startedAt: undefined,
      endedAt: undefined,
      idempotencyKey: "task-waiting",
    });

    expect(listDecayedBlocksNeedingReplan(snapshot)).toEqual([]);
  });

  it("never reports a block whose last completed verification was retained", () => {
    const snapshot = completeCoachTestSnapshot();

    expect(listDecayedBlocksNeedingReplan(snapshot)).toEqual([]);
  });

  it("ignores a decay that a later retained verification has superseded", () => {
    const snapshot = withDecayedVerification();
    snapshot.delayedVerifications.push({
      ...snapshot.delayedVerifications[0],
      id: "verification-retained-later",
      status: "completed",
      verificationOutcome: "retained",
      lastVerifiedAt: "2026-09-09T08:00:00.000Z",
      updatedAt: "2026-09-09T08:00:00.000Z",
      idempotencyKey: "verification-retained-later",
    });

    expect(listDecayedBlocksNeedingReplan(snapshot)).toEqual([]);
  });

  it("never reports a deleted block", () => {
    const snapshot = withDecayedVerification();
    snapshot.decisionBlocks[0] = { ...snapshot.decisionBlocks[0], deletedAt: "2026-09-08T08:00:00.000Z" };

    expect(listDecayedBlocksNeedingReplan(snapshot)).toEqual([]);
  });
});
