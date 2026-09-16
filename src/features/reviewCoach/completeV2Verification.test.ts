import Dexie from "dexie";
import { IDBKeyRange, indexedDB } from "fake-indexeddb";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { StudyJournalDatabase } from "../../db/database";
import type { AdaptiveQuizTurn, DelayedVerification, JudgmentMechanism, ReferenceOrigin } from "./domain";
import { closedLoopV2Fixtures } from "./learningLoopFixtures";
import { DexieReviewCoachRepository } from "./repository";
import { coachTestBlock, coachTestStamp, completeCoachTestSnapshot } from "./reviewCoachTestFixtures";

Dexie.dependencies.indexedDB = indexedDB;
Dexie.dependencies.IDBKeyRange = IDBKeyRange;

/**
 * M4: closing a delayed verification.
 *
 * The delayed verification is the only place the system can observe retention
 * rather than practice, so everything here is about *not* inflating it: the
 * first independent attempt is locked, later remediation cannot rewrite it, and
 * an attempt that was assisted, duplicated, off-form or unjudgeable does not
 * become evidence at all. The caller supplies an identity and a timestamp -
 * never an outcome. `retained` / `decayed` are derived, not accepted.
 */

const verificationEvent = (
  taskId: string,
  turnId: string,
  kind: "answer-assessment" | "self-assessment" | "task-disposition",
  extra: Record<string, unknown> = {},
) => ({
  id: `event-${taskId}-${turnId}-${kind}`,
  taskId,
  turnId,
  decisionBlockId: coachTestBlock.id,
  recordId: coachTestBlock.recordId,
  contentVersion: 1,
  kind,
  occurredAt: coachTestStamp,
  idempotencyKey: `event-${taskId}-${turnId}-${kind}`,
  createdAt: coachTestStamp,
  updatedAt: coachTestStamp,
  ...extra,
});

describe("completeV2Verification", () => {
  let database: StudyJournalDatabase;
  let repository: DexieReviewCoachRepository;

  beforeEach(async () => {
    database = new StudyJournalDatabase(`review-coach-v2-verify-${crypto.randomUUID()}`);
    await database.open();
    repository = new DexieReviewCoachRepository(database);
  });

  afterEach(async () => {
    const name = database.name;
    database.close();
    await Dexie.delete(name);
  });

  interface SeedOptions {
    /** The single delayed turn, unless `turns` overrides it. */
    turn?: Partial<AdaptiveQuizTurn>;
    turns?: AdaptiveQuizTurn[];
    /** Extra outcome events written alongside the default answer-assessment. */
    extraEvents?: ReturnType<typeof verificationEvent>[];
    /** Skip the answer-assessment event for the locked turn. */
    omitAnswerEvent?: boolean;
    verification?: Partial<DelayedVerification>;
  }

  /** Clears every table so a parameterised test can re-seed from scratch. */
  const resetDatabase = async () => {
    for (const table of database.tables) await table.clear();
  };

  const seed = async (options: SeedOptions = {}) => {
    const { blueprint, task: loopTask, turns: loopTurns } = closedLoopV2Fixtures({ loop: "closed" });
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

    // The preceding immediate loop, completed. Its post-judgment turn is what
    // opens the delayed verification - the verification is never opened by the
    // learner saying they think they did well.
    const postJudgmentTurn = loopTurns.find((item) => item.phase === "post-judgment")!;
    await database.adaptiveReviewTasks.put({
      ...structuredClone(loopTask),
      status: "completed",
      activeSlotKey: undefined,
      openTargetKey: undefined,
      endedAt: coachTestStamp,
    });
    await database.adaptiveQuizTurns.bulkPut(loopTurns.map((item) => structuredClone(item)));
    await database.taskOutcomeEvents.bulkPut([
      verificationEvent(loopTask.id, loopTurns[0].id, "answer-assessment", { answerAssessment: "correct" }),
      verificationEvent(loopTask.id, postJudgmentTurn.id, "answer-assessment", { answerAssessment: "correct" }),
      {
        ...verificationEvent(loopTask.id, postJudgmentTurn.id, "task-disposition"),
        id: `event-${loopTask.id}-completed`,
        idempotencyKey: `event-${loopTask.id}-completed`,
        disposition: "completed",
        turnId: undefined,
      },
    ]);

    // The verification runs on its own task.
    const verificationTask = {
      ...structuredClone(loopTask),
      id: "task-v2-verification",
      status: "in-progress" as const,
      priorityTier: "due-verification" as const,
      activeSlotKey: "global-current" as const,
      openTargetKey: `${coachTestBlock.id}:1`,
      idempotencyKey: "task-v2-verification-operation",
    };
    await database.adaptiveReviewTasks.put(verificationTask);
    const task = verificationTask;
    const blueprintRef = blueprint;

    const delayedTurn: AdaptiveQuizTurn = {
      id: "turn-delayed-1",
      taskId: task.id,
      decisionBlockId: coachTestBlock.id,
      recordId: coachTestBlock.recordId,
      contentVersion: 1,
      sequence: 1,
      status: "answered",
      practiceType: "variation",
      answerMode: "open",
      question: "延迟验证：换一个说法重新说明 BFS 的标记规则。",
      displayedAt: coachTestStamp,
      sourceEvidence: structuredClone(blueprintRef.evidence),
      answerCriteria: ["覆盖关键规则"],
      hintsUsed: [],
      answerText: "独立作答",
      answeredAt: coachTestStamp,
      assessment: "correct",
      qualityChecked: true,
      generationModel: "test-generation-model",
      promptVersion: "quiz-turn-v2",
      policyVersion: "review-coach-policy-v2",
      idempotencyKey: `quiz-turn-op:${task.id}:1`,
      phase: "delayed-first",
      independenceStatus: "independent",
      variantEligibility: "eligible",
      targetFormStatus: "target-form",
      judgmentMechanism: "ai-evaluation" as JudgmentMechanism,
      referenceOrigin: "ai-generated" as ReferenceOrigin,
      questionFingerprint: "fingerprint-delayed",
      createdAt: coachTestStamp,
      updatedAt: coachTestStamp,
      ...options.turn,
    };

    if (!options.omitAnswerEvent) {
      await database.taskOutcomeEvents.put(verificationEvent(task.id, delayedTurn.id, "answer-assessment", {
        answerAssessment: delayedTurn.assessment,
      }));
    }
    for (const event of options.extraEvents ?? []) {
      await database.taskOutcomeEvents.put(event);
    }

    await database.delayedVerifications.put({
      id: "verification-v2-1",
      sourceOutcomeEventId: `event-${loopTask.id}-${postJudgmentTurn.id}-answer-assessment`,
      taskId: task.id,
      decisionBlockId: coachTestBlock.id,
      recordId: coachTestBlock.recordId,
      contentVersion: 1,
      status: "in-progress",
      verificationEligibleAt: coachTestStamp,
      verificationDueAt: "2026-09-16T08:00:00.000Z",
      strategyVersion: "delayed-verification-v2",
      idempotencyKey: "verification-v2-operation-1",
      loopVersion: "closed-loop-v2",
      createdAt: coachTestStamp,
      updatedAt: coachTestStamp,
      ...options.verification,
    });

    await database.adaptiveQuizTurns.bulkPut(
      (options.turns ?? [delayedTurn]).map((item) => structuredClone(item)),
    );
    return { blueprint, task, turn: delayedTurn, postJudgmentTurn, loopTask };
  };

  it("completes from the locked first attempt and derives the evidence status", async () => {
    const { task, turn } = await seed();
    const completed = await repository.completeV2Verification(task.id, "2026-09-17T08:00:00.000Z");

    expect(completed.status).toBe("completed");
    expect(completed.openTargetKey).toBeUndefined();
    expect(completed.activeSlotKey).toBeUndefined();

    const verification = await database.delayedVerifications.get("verification-v2-1");
    // AI-only grading and AI-generated criteria: the strongest honest status is
    // provisional, never objective. A provisional result must therefore write no
    // durable conclusion at all - constitution art. 9.
    expect(verification).toMatchObject({
      status: "completed",
      evidenceTurnId: turn.id,
      evidenceStatus: "provisional-pass",
    });
    expect(verification!.verificationOutcome).toBeUndefined();

    // The block keeps awaiting verification instead of being declared "retained".
    const state = await database.decisionBlockStates.get(coachTestBlock.id);
    expect(state?.status).not.toBe("retained");

    // The task is closed by exactly one disposition event, and no self-assessment
    // is written: the learner did not declare this.
    const events = await database.taskOutcomeEvents.where("taskId").equals(task.id).toArray();
    expect(events.filter((event) => event.kind === "task-disposition")).toHaveLength(1);
    expect(events.filter((event) => event.kind === "self-assessment")).toHaveLength(0);
  });

  it("locks the first independent attempt and does not let remediation rewrite it", async () => {
    const { task, turn } = await seed();
    // A first attempt that failed, then a remedial success. The verification must
    // read the failure.
    const first: AdaptiveQuizTurn = {
      ...structuredClone(turn),
      id: "turn-delayed-first",
      sequence: 1,
      assessment: "incorrect",
      phase: "delayed-first",
      answerText: "第一次独立作答（不完整）",
    };
    const remedial: AdaptiveQuizTurn = {
      ...structuredClone(turn),
      id: "turn-delayed-remedial",
      sequence: 2,
      assessment: "correct",
      phase: "delayed-remediation",
      answerText: "补救后作答",
      idempotencyKey: `quiz-turn-op:${task.id}:2`,
    };
    // Replace only this task's turns; the preceding loop's post-judgment turn
    // that opened the verification must stay.
    await database.adaptiveQuizTurns.where("taskId").equals(task.id).delete();
    await database.adaptiveQuizTurns.bulkPut([structuredClone(first), structuredClone(remedial)]);
    await database.taskOutcomeEvents.where("taskId").equals(task.id).delete();
    await database.taskOutcomeEvents.put(verificationEvent(task.id, first.id, "answer-assessment", { answerAssessment: "incorrect" }));
    await database.taskOutcomeEvents.put(verificationEvent(task.id, remedial.id, "answer-assessment", { answerAssessment: "correct" }));

    await repository.completeV2Verification(task.id, "2026-09-17T08:00:00.000Z");

    const verification = await database.delayedVerifications.get("verification-v2-1");
    expect(verification!.evidenceTurnId).toBe(first.id);
    expect(verification!.evidenceStatus).toBe("provisional-fail");
    // A provisional failure schedules remediation; it does not brand the block
    // as decayed (constitution art. 9).
    expect(verification!.verificationOutcome).toBeUndefined();
    const state = await database.decisionBlockStates.get(coachTestBlock.id);
    expect(state?.status).not.toBe("needs-consolidation");
  });

  it("refuses to treat an assisted attempt as verification evidence", async () => {
    const { task } = await seed({ turn: { independenceStatus: "assisted" } });
    await expect(repository.completeV2Verification(task.id, "2026-09-17T08:00:00.000Z"))
      .rejects.toThrow("The locked first attempt is not usable verification evidence.");
    const verification = await database.delayedVerifications.get("verification-v2-1");
    expect(verification!.status).toBe("in-progress");
  });

  it("refuses to treat a duplicated or off-form question as verification evidence", async () => {
    for (const turn of [
      { variantEligibility: "duplicate" as const },
      { targetFormStatus: "training-form" as const },
    ]) {
      await resetDatabase();
      const { task } = await seed({ turn });
      await expect(repository.completeV2Verification(task.id, "2026-09-17T08:00:00.000Z"))
        .rejects.toThrow("The locked first attempt is not usable verification evidence.");
    }
  });

  it("refuses to treat an unreliable or skipped attempt as verification evidence", async () => {
    for (const turn of [
      { assessment: "unreliable" as const },
      { answerText: "[skipped]" as const },
    ]) {
      await resetDatabase();
      const { task } = await seed({ turn });
      await expect(repository.completeV2Verification(task.id, "2026-09-17T08:00:00.000Z"))
        .rejects.toThrow("The locked first attempt is not usable verification evidence.");
    }
  });

  it("refuses to complete without an assessment event for the locked turn", async () => {
    const { task } = await seed({ omitAnswerEvent: true });
    await expect(repository.completeV2Verification(task.id, "2026-09-17T08:00:00.000Z"))
      .rejects.toThrow("The locked attempt has no assessment event.");
  });

  it("refuses a v1 verification and a verification that is not in progress", async () => {
    const { task } = await seed({ verification: { loopVersion: undefined } });
    await expect(repository.completeV2Verification(task.id, "2026-09-17T08:00:00.000Z"))
      .rejects.toThrow("completeV2Verification requires a closed-loop-v2 verification.");

    await resetDatabase();
    const notStarted = await seed({ verification: { status: "scheduled" } });
    await expect(repository.completeV2Verification(notStarted.task.id, "2026-09-17T08:00:00.000Z"))
      .rejects.toThrow("Verification task is not in progress.");
  });

  it("upgrades to objective-pass only when the mechanism and reference are authoritative", async () => {
    const { task } = await seed({
      turn: { judgmentMechanism: "deterministic-check" as JudgmentMechanism, referenceOrigin: "source-material" as ReferenceOrigin },
    });
    await repository.completeV2Verification(task.id, "2026-09-17T08:00:00.000Z");
    const verification = await database.delayedVerifications.get("verification-v2-1");
    expect(verification!.evidenceStatus).toBe("objective-pass");
    // Objective evidence is the only thing allowed to write a durable conclusion.
    expect(verification!.verificationOutcome).toBe("retained");
    const state = await database.decisionBlockStates.get(coachTestBlock.id);
    expect(state?.status).toBe("retained");
  });

  it("writes a decayed conclusion from objective failure evidence", async () => {
    const { task } = await seed({
      turn: {
        judgmentMechanism: "deterministic-check" as JudgmentMechanism,
        referenceOrigin: "source-material" as ReferenceOrigin,
        assessment: "incorrect",
      },
    });
    await repository.completeV2Verification(task.id, "2026-09-17T08:00:00.000Z");
    const verification = await database.delayedVerifications.get("verification-v2-1");
    expect(verification!.evidenceStatus).toBe("objective-fail");
    expect(verification!.verificationOutcome).toBe("decayed");
    const state = await database.decisionBlockStates.get(coachTestBlock.id);
    expect(state?.status).toBe("needs-consolidation");
  });

  it("treats a self-report mechanism as no authority at all", async () => {
    // Field names must not launder authority: claiming an authoritative origin
    // while the mechanism is self-report is still no evidence.
    const { task } = await seed({
      turn: { judgmentMechanism: "self-report" as JudgmentMechanism, referenceOrigin: "official" as ReferenceOrigin },
    });
    await expect(repository.completeV2Verification(task.id, "2026-09-17T08:00:00.000Z"))
      .rejects.toThrow("The locked first attempt is not usable verification evidence.");
  });

  it("is repeatable without duplicating the disposition event", async () => {
    const { task } = await seed();
    await repository.completeV2Verification(task.id, "2026-09-17T08:00:00.000Z");
    // A second close attempt must not add a second completion to the audit trail.
    await expect(repository.completeV2Verification(task.id, "2026-09-17T09:00:00.000Z"))
      .rejects.toThrow("Verification task is not in progress.");
    const events = await database.taskOutcomeEvents.where("taskId").equals(task.id).toArray();
    expect(events.filter((event) => event.kind === "task-disposition")).toHaveLength(1);
  });

  /**
   * The verification *action* completing is not the evidence *conclusion*
   * completing.
   *
   * Constitution art. 9 forbids an AI-only judgment from becoming an
   * irreversible fact, but the first fix for that only stopped writing
   * `retained` - it also ended the chain, because `status: "completed"` was
   * treated as "settled". A provisional result must keep the target open.
   */
  describe("a provisional conclusion leaves the verification chain open", () => {
    it("records a completed action with no concluded evidence and a live next window", async () => {
      const { task } = await seed();
      await repository.completeV2Verification(task.id, "2026-09-17T08:00:00.000Z");

      const verification = await database.delayedVerifications.get("verification-v2-1");
      // The action completed - the learner did submit the attempt...
      expect(verification!.status).toBe("completed");
      // ...but nothing was settled, so there is no conclusion and the block is
      // not declared retained.
      expect(verification!.evidenceStatus).toBe("provisional-pass");
      expect(verification!.concludedAt).toBeUndefined();
      expect(verification!.verificationOutcome).toBeUndefined();
      // A successor window exists, measured from this completion rather than
      // inherited from the (now past) window it just ran in.
      expect(verification!.nextVerificationDueAt).toBeDefined();
      expect(Date.parse(verification!.nextVerificationDueAt!)).toBeGreaterThan(Date.parse("2026-09-17T08:00:00.000Z"));
      expect(verification!.nextVerificationDueAt).not.toBe(verification!.verificationDueAt);
    });

    it("concludes and stops the chain once the evidence is objective", async () => {
      // An authoritative reference makes the judgment objective, which settles
      // the target - re-asking it afterwards would be busywork.
      const { task } = await seed({
        turn: { judgmentMechanism: "deterministic-check" as JudgmentMechanism, referenceOrigin: "source-material" as ReferenceOrigin },
      });
      await repository.completeV2Verification(task.id, "2026-09-17T08:00:00.000Z");

      const verification = await database.delayedVerifications.get("verification-v2-1");
      expect(verification!.evidenceStatus).toBe("objective-pass");
      expect(verification!.concludedAt).toBe("2026-09-17T08:00:00.000Z");
      expect(verification!.nextVerificationDueAt).toBeUndefined();
      // Only an objective pass may become a durable fact.
      expect(verification!.verificationOutcome).toBe("retained");
    });

    it("refuses to re-open a verification that already settled", async () => {
      const { task } = await seed({
        turn: { judgmentMechanism: "deterministic-check" as JudgmentMechanism, referenceOrigin: "source-material" as ReferenceOrigin },
      });
      await repository.completeV2Verification(task.id, "2026-09-17T08:00:00.000Z");
      await expect(repository.detachVerificationTask("verification-v2-1", "2026-09-17T09:00:00.000Z"))
        .rejects.toThrow("already has a settled conclusion");
    });

    it("re-opens an unsettled verification by clearing the stale task link only", async () => {
      const { task } = await seed();
      await repository.completeV2Verification(task.id, "2026-09-17T08:00:00.000Z");

      const detached = await repository.detachVerificationTask("verification-v2-1", "2026-09-18T08:00:00.000Z");

      // The link to the previous (completed) task is cleared, which is what lets
      // `queueVerification` create a fresh verification task instead of
      // short-circuiting back to the finished one.
      expect(detached.taskId).toBeUndefined();
      // The status is deliberately untouched: `completed` stays terminal in the
      // state machine. What is still open is the *conclusion*.
      expect(detached.status).toBe("completed");
      expect(detached.concludedAt).toBeUndefined();
      expect(detached.verificationOutcome).toBeUndefined();
    });
  });
});
