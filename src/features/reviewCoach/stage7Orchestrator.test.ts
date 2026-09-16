import { describe, expect, it, vi } from "vitest";

import type { AdaptiveReviewTask, ReviewCoachFormalSnapshot } from "./domain";
import { rankWaitingTasks, ReviewCoachOrchestrator } from "./orchestrator";
import type { ReviewCoachRepository } from "./repository";
import { coachTestStamp, coachTestTask, coachTestTurn, coachTestVerification, completeCoachTestSnapshot } from "./reviewCoachTestFixtures";

const now = "2026-09-07T08:00:00.000Z";

const createIds = () => {
  let value = 0;
  return { next: () => `stage7-id-${++value}` };
};

describe("Stage 7 delayed verification orchestrator", () => {
  it.each([
    ["mastered", "2026-09-08T08:00:00.000Z", "2026-09-10T08:00:00.000Z"],
    ["needs-consolidation", "2026-09-07T16:00:00.000Z", "2026-09-08T08:00:00.000Z"],
  ] as const)("schedules %s without prematurely recording retention", async (outcome, eligibleAt, dueAt) => {
    const snapshot = completeCoachTestSnapshot();
    snapshot.adaptiveReviewTasks[0] = { ...snapshot.adaptiveReviewTasks[0], status: "in-progress", endedAt: undefined };
    snapshot.adaptiveQuizTurns[0] = { ...snapshot.adaptiveQuizTurns[0], updatedAt: now, answeredAt: now };
    snapshot.taskOutcomeEvents = [];
    snapshot.delayedVerifications = [];
    const commitTaskOutcome = vi.fn(async (_taskId, events, status, updatedAt, _notBeforeAt, verification) => {
      snapshot.taskOutcomeEvents.push(...events);
      snapshot.adaptiveReviewTasks[0] = { ...snapshot.adaptiveReviewTasks[0], status, endedAt: updatedAt };
      if (verification) snapshot.delayedVerifications.push(verification);
      return snapshot.adaptiveReviewTasks[0];
    });
    const repository = { getFormalSnapshot: vi.fn(async () => snapshot), commitTaskOutcome } as unknown as ReviewCoachRepository;
    const orchestrator = new ReviewCoachOrchestrator({ repository, ids: createIds(), clock: { now: () => now } });

    await orchestrator.finishQuizTask({ taskId: coachTestTask.id, outcome, operationId: `finish-${outcome}` });

    const verification = commitTaskOutcome.mock.calls[0][5];
    expect(verification).toMatchObject({
      status: "scheduled",
      verificationEligibleAt: eligibleAt,
      verificationDueAt: dueAt,
    });
    expect(verification).not.toHaveProperty("verificationOutcome");
  });

  it("regenerates an exact historical question for a verification task", async () => {
    const snapshot = completeCoachTestSnapshot();
    const verificationTask: AdaptiveReviewTask = {
      ...coachTestTask,
      id: "verification-task",
      status: "current",
      priorityTier: "due-verification",
      startedAt: undefined,
      endedAt: undefined,
      idempotencyKey: "verification-task",
    };
    snapshot.adaptiveReviewTasks.push(verificationTask);
    snapshot.delayedVerifications[0] = { ...coachTestVerification, taskId: verificationTask.id, status: "queued", lastVerifiedAt: undefined, verificationOutcome: undefined };
    const transitionTask = vi.fn(async (id: string, status: AdaptiveReviewTask["status"], updatedAt: string) => {
      const index = snapshot.adaptiveReviewTasks.findIndex((task) => task.id === id);
      snapshot.adaptiveReviewTasks[index] = { ...snapshot.adaptiveReviewTasks[index], status, updatedAt };
      snapshot.delayedVerifications[0] = { ...snapshot.delayedVerifications[0], status: "in-progress", updatedAt };
      return snapshot.adaptiveReviewTasks[index];
    });
    const addQuizTurn = vi.fn(async (turn) => turn);
    const repository = { getFormalSnapshot: vi.fn(async () => snapshot), transitionTask, addQuizTurn } as unknown as ReviewCoachRepository;
    const response = (question: string) => ({
      status: "ok" as const,
      practiceType: "variation" as const,
      answerMode: "open" as const,
      question,
      answerCriteria: ["before enqueue"],
      sourceEvidence: snapshot.sessionBlueprints[0].evidence,
      hints: [],
    });
    const generateTurn = vi.fn()
      .mockResolvedValueOnce(response(coachTestTurn.question))
      // Deliberately does not restate the criterion, so C-4's local leak check lets it through:
      // this test is about duplicate-history regeneration, and the previous fixture text
      // ("...marking before enqueue...") actually leaked the acceptance criterion.
      .mockResolvedValueOnce(response("Explain why duplicate enqueueing happens when a node is marked late."));
    const orchestrator = new ReviewCoachOrchestrator({
      repository,
      ids: createIds(),
      clock: { now: () => now },
      aiGateway: { interpretFeedback: vi.fn(), planSession: vi.fn(), generateTurn, reviewQuestion: vi.fn(async () => ({ status: "ok" as const, verdict: "pass" as const, severeIssues: [], rationale: "ok" })), evaluateAnswer: vi.fn() },
    });

    const result = await orchestrator.generateQuizTurn({ taskId: verificationTask.id, decisionBlockContent: "source", provider: "test", model: "fast", promptVersion: "quiz-v1", qualityPromptVersion: "quality-v1", policyVersion: "policy-v1", operationId: "verify" });

    expect(result.question).toBe("Explain why duplicate enqueueing happens when a node is marked late.");
    expect(generateTurn).toHaveBeenCalledTimes(2);
    // The rejection reason now names which previous question it matched, so the
    // record distinguishes an exact repeat from a near-repeat.
    expect(generateTurn.mock.calls[1][0]).toMatchObject({
      verificationMode: { verificationId: coachTestVerification.id, requireFreshRetrieval: true },
    });
    expect((generateTurn.mock.calls[1][0] as { priorQualityFailure?: string }).priorQualityFailure)
      .toMatch(/延迟验证题与历史题目重复/);
  });

  it("completes a decayed verification as a separate not-mastered fact", async () => {
    const snapshot = completeCoachTestSnapshot();
    snapshot.adaptiveReviewTasks[0] = { ...coachTestTask, status: "in-progress", priorityTier: "due-verification", endedAt: undefined };
    snapshot.delayedVerifications[0] = { ...coachTestVerification, taskId: coachTestTask.id, status: "in-progress", lastVerifiedAt: undefined, verificationOutcome: undefined };
    const completeVerification = vi.fn(async () => ({ ...snapshot.adaptiveReviewTasks[0], status: "not-achieved" as const }));
    const repository = { getFormalSnapshot: vi.fn(async () => snapshot), completeVerification } as unknown as ReviewCoachRepository;
    const orchestrator = new ReviewCoachOrchestrator({ repository, ids: createIds(), clock: { now: () => now } });

    await orchestrator.completeDelayedVerification({ taskId: coachTestTask.id, outcome: "decayed", operationId: "decayed" });

    expect(completeVerification).toHaveBeenCalledWith(coachTestTask.id, [
      expect.objectContaining({ kind: "self-assessment", subjectiveOutcome: "not-mastered", reason: "延迟验证出现衰退" }),
      expect.objectContaining({ kind: "task-disposition", disposition: "completed" }),
    ], "decayed", now);
  });

  it("does not let repeated due verifications starve an ordinary task", async () => {
    const snapshot = completeCoachTestSnapshot();
    const terminal = (id: string, endedAt: string): AdaptiveReviewTask => ({ ...coachTestTask, id, priorityTier: "due-verification", status: "completed", endedAt, idempotencyKey: id });
    const due = { ...coachTestTask, id: "due-next", status: "waiting" as const, priorityTier: "due-verification" as const, endedAt: undefined, idempotencyKey: "due-next" };
    const ordinary = { ...coachTestTask, id: "ordinary-next", status: "waiting" as const, priorityTier: "first-difficulty" as const, endedAt: undefined, idempotencyKey: "ordinary-next" };
    snapshot.adaptiveReviewTasks = [terminal("verification-2", "2026-09-07T07:00:00.000Z"), terminal("verification-1", "2026-09-07T06:00:00.000Z"), due, ordinary];
    snapshot.delayedVerifications = [];
    const transitionTask = vi.fn(async (id: string) => snapshot.adaptiveReviewTasks.find((task) => task.id === id)!);
    const repository = { getFormalSnapshot: vi.fn(async () => snapshot), transitionTask } as unknown as ReviewCoachRepository;
    const orchestrator = new ReviewCoachOrchestrator({ repository, ids: createIds(), clock: { now: () => now } });

    await orchestrator.selectNextTask();

    expect(transitionTask).toHaveBeenCalledWith(ordinary.id, "current", now);
  });

  it("derives startup verification task identity and queue time from the formal verification", async () => {
    const refreshAt = async (clockNow: string) => {
      const snapshot = completeCoachTestSnapshot();
      snapshot.adaptiveReviewTasks[0] = { ...snapshot.adaptiveReviewTasks[0], status: "completed", endedAt: coachTestStamp };
      snapshot.delayedVerifications[0] = {
        ...snapshot.delayedVerifications[0],
        status: "scheduled",
        taskId: undefined,
        verificationEligibleAt: "2026-09-07T06:00:00.000Z",
        verificationDueAt: "2026-09-07T07:00:00.000Z",
      };
      const transitionVerification = vi.fn(async (_id: string, status: ReviewCoachFormalSnapshot["delayedVerifications"][number]["status"], updatedAt: string) => {
        snapshot.delayedVerifications[0] = { ...snapshot.delayedVerifications[0], status, updatedAt };
        return snapshot.delayedVerifications[0];
      });
      const queueVerification = vi.fn(async (_id: string, task: AdaptiveReviewTask) => ({ verification: snapshot.delayedVerifications[0], task }));
      const repository = { getFormalSnapshot: vi.fn(async () => snapshot), transitionVerification, queueVerification } as unknown as ReviewCoachRepository;
      const orchestrator = new ReviewCoachOrchestrator({ repository, ids: createIds(), clock: { now: () => clockNow } });

      await orchestrator.refreshDueVerifications();
      return queueVerification.mock.calls[0][1];
    };

    const firstDevice = await refreshAt("2026-09-07T08:00:00.000Z");
    const secondDevice = await refreshAt("2026-09-07T09:00:00.000Z");

    expect(firstDevice).toMatchObject({
      id: `verification-task:${coachTestVerification.id}`,
      idempotencyKey: `verification-task:${coachTestVerification.id}`,
      queuedAt: "2026-09-07T07:00:00.000Z",
      createdAt: "2026-09-07T07:00:00.000Z",
    });
    expect(secondDevice).toEqual({ ...firstDevice, updatedAt: "2026-09-07T09:00:00.000Z" });
  });

  it("re-queues a completed but unsettled verification instead of letting the chain end", async () => {
    // `status: "completed"` records that the learner submitted an attempt. When
    // only provisional evidence came back, nothing has been concluded, so the
    // chain must continue: refreshDueVerifications has to clear the stale task
    // link and queue a fresh task for the same target.
    const refresh = async (verification: Partial<ReviewCoachFormalSnapshot["delayedVerifications"][number]>) => {
      const snapshot = completeCoachTestSnapshot();
      snapshot.adaptiveReviewTasks[0] = { ...snapshot.adaptiveReviewTasks[0], status: "completed", endedAt: coachTestStamp };
      snapshot.delayedVerifications[0] = {
        ...snapshot.delayedVerifications[0],
        status: "completed",
        taskId: coachTestTask.id,
        lastVerifiedAt: "2026-09-07T06:00:00.000Z",
        verificationOutcome: undefined,
        ...verification,
      };
      const detachVerificationTask = vi.fn(async (_id: string, updatedAt: string) => {
        snapshot.delayedVerifications[0] = { ...snapshot.delayedVerifications[0], taskId: undefined, updatedAt };
        return snapshot.delayedVerifications[0];
      });
      const queueVerification = vi.fn(async (_id: string, task: AdaptiveReviewTask) => ({ verification: snapshot.delayedVerifications[0], task }));
      const repository = { getFormalSnapshot: vi.fn(async () => snapshot), detachVerificationTask, queueVerification } as unknown as ReviewCoachRepository;
      const orchestrator = new ReviewCoachOrchestrator({ repository, ids: createIds(), clock: { now: () => now } });

      const queuedCount = await orchestrator.refreshDueVerifications();
      return { detachVerificationTask, queueVerification, queuedCount };
    };

    const unsettled = await refresh({ concludedAt: undefined, nextVerificationDueAt: "2026-09-07T07:00:00.000Z" });

    expect(unsettled.detachVerificationTask).toHaveBeenCalledWith(coachTestVerification.id, now);
    expect(unsettled.queueVerification).toHaveBeenCalledTimes(1);
    expect(unsettled.queueVerification.mock.calls[0][1]).toMatchObject({
      id: `verification-task:${coachTestVerification.id}`,
      priorityTier: "due-verification",
      status: "waiting",
    });
    expect(unsettled.queuedCount).toBe(1);
  });

  it("leaves a verification that reached an objective conclusion alone", async () => {
    // The counterpart to the test above: once the evidence settled the target,
    // there is nothing left to re-check, so the same refresh must not queue it.
    const snapshot = completeCoachTestSnapshot();
    snapshot.adaptiveReviewTasks[0] = { ...snapshot.adaptiveReviewTasks[0], status: "completed", endedAt: coachTestStamp };
    snapshot.delayedVerifications[0] = {
      ...snapshot.delayedVerifications[0],
      status: "completed",
      taskId: coachTestTask.id,
      concludedAt: "2026-09-07T06:00:00.000Z",
      nextVerificationDueAt: undefined,
      evidenceStatus: "objective-pass",
      verificationOutcome: "retained",
    };
    const detachVerificationTask = vi.fn(async () => snapshot.delayedVerifications[0]);
    const queueVerification = vi.fn(async (_id: string, task: AdaptiveReviewTask) => ({ verification: snapshot.delayedVerifications[0], task }));
    const repository = { getFormalSnapshot: vi.fn(async () => snapshot), detachVerificationTask, queueVerification } as unknown as ReviewCoachRepository;
    const orchestrator = new ReviewCoachOrchestrator({ repository, ids: createIds(), clock: { now: () => now } });

    const queuedCount = await orchestrator.refreshDueVerifications();

    expect(detachVerificationTask).not.toHaveBeenCalled();
    expect(queueVerification).not.toHaveBeenCalled();
    expect(queuedCount).toBe(0);
  });

  it("ages a long-waiting consolidation task into an earlier scheduling tier", () => {
    const older = { ...coachTestTask, id: "older", status: "waiting" as const, priorityTier: "consolidation" as const, queuedAt: "2026-08-20T08:00:00.000Z", endedAt: undefined };
    const newer = { ...coachTestTask, id: "newer", status: "waiting" as const, priorityTier: "first-difficulty" as const, queuedAt: "2026-09-07T07:00:00.000Z", endedAt: undefined };

    expect(rankWaitingTasks([newer, older], now).map((task) => task.id)).toEqual(["older", "newer"]);
  });
});
