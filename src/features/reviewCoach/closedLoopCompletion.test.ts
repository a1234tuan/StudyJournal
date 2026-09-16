import { describe, expect, it, vi } from "vitest";

import type { TaskOutcomeEvent } from "./domain";
import { ReviewCoachOrchestrator } from "./orchestrator";
import type { ReviewCoachRepository } from "./repository";
import { closedLoopV2Blueprint, closedLoopV2Fixtures, closedLoopV2Task } from "./learningLoopFixtures";
import { coachTestBlock, coachTestStamp } from "./reviewCoachTestFixtures";
import { DELAYED_VERIFICATION_STRATEGY_VERSION_V2 } from "./verificationPolicy";

/**
 * M2: completion and deferral are derived, never declared.
 *
 * The v1 completion path took a `SubjectiveOutcome` and moved the task to a
 * terminal status on the strength of it. These tests pin the replacement
 * contract: the caller supplies identity and idempotency only, and the system
 * computes the rest from the retrievals that actually happened.
 */

const answerEvent = (
  taskId: string,
  turnId: string,
  overrides: Partial<TaskOutcomeEvent> = {},
): TaskOutcomeEvent => ({
  id: `answer-${turnId}`,
  taskId,
  turnId,
  decisionBlockId: coachTestBlock.id,
  recordId: coachTestBlock.recordId,
  contentVersion: 1,
  kind: "answer-assessment",
  answerAssessment: "correct",
  occurredAt: coachTestStamp,
  idempotencyKey: `answer-${turnId}`,
  createdAt: coachTestStamp,
  updatedAt: coachTestStamp,
  ...overrides,
});

const harness = (options: { events?: (ctx: { taskId: string; turns: ReturnType<typeof closedLoopV2Fixtures>["turns"] }) => TaskOutcomeEvent[]; maxTurns?: number; loop?: "open" | "closed" } = {}) => {
  const blueprint = closedLoopV2Blueprint({ maxTurns: options.maxTurns ?? 4 });
  const task = closedLoopV2Task(blueprint);
  const { turns } = closedLoopV2Fixtures({
    maxTurns: options.maxTurns ?? 4,
    loop: options.loop ?? "open",
    blueprintId: blueprint.id,
    taskId: task.id,
  });
  const events = options.events?.({ taskId: task.id, turns }) ?? [];
  let currentTask = task;
  const commitTaskOutcome = vi.fn(async (
    _taskId: string,
    _events: TaskOutcomeEvent[],
    _status: string,
    _updatedAt?: string,
    _notBeforeAt?: string,
  ) => (currentTask = { ...currentTask, status: _status as typeof currentTask.status }));
  const requeueV2Attempt = vi.fn(async (_input?: { deferredTaskId: string; blueprint: typeof blueprint; reason: string; operationId: string; now: string }) => ({ ...task, id: "replacement" }));
  // The atomic composite the orchestrator must prefer. The two halves stay
  // separately observable so the tests can still assert what each one received.
  const deferAndRequeue = vi.fn(async (input: {
    deferredTaskId: string;
    deferredEvents: TaskOutcomeEvent[];
    notBeforeAt: string;
    blueprint: typeof blueprint;
    reason: string;
    operationId: string;
    now: string;
  }) => {
    const deferred = await commitTaskOutcome(input.deferredTaskId, input.deferredEvents, "deferred", input.now, input.notBeforeAt);
    const replacement = await requeueV2Attempt({
      deferredTaskId: input.deferredTaskId,
      blueprint: input.blueprint,
      reason: input.reason,
      operationId: input.operationId,
      now: input.now,
    });
    return { deferred, replacement };
  });
  const snapshot = {
    decisionBlocks: [coachTestBlock],
    decisionBlockArchives: [],
    decisionBlockFeedback: [],
    feedbackInterpretations: [],
    analysisQueueItems: [],
    analysisBatches: [],
    sessionBlueprints: [blueprint],
    adaptiveReviewTasks: [task],
    adaptiveQuizTurns: turns,
    taskOutcomeEvents: events,
    delayedVerifications: [],
    aiRoleConfigs: [],
    legacyLearningEvidence: [],
    legacyKnowledgePoints: [],
    legacyRecordKnowledgePointLinks: [],
    legacyKnowledgeRelations: [],
  };
  const repository = {
    getFormalSnapshot: vi.fn(async () => snapshot),
    commitTaskOutcome,
    requeueV2Attempt,
    deferAndRequeue,
    transitionTask: vi.fn(),
    transitionVerification: vi.fn(),
  } as unknown as ReviewCoachRepository;
  const orchestrator = new ReviewCoachOrchestrator({
    repository,
    ids: { next: () => `id-${Math.random().toString(36).slice(2, 8)}` },
    clock: { now: () => coachTestStamp },
  });
  return { orchestrator, repository, blueprint, task, turns, events, commitTaskOutcome, requeueV2Attempt, deferAndRequeue, snapshot, setTurns: (next: typeof turns) => { snapshot.adaptiveQuizTurns = next; } };
};

describe("completeLearningLoop (M2)", () => {
  it("refuses to close a loop that has no post-judgment retrieval", async () => {
    const { orchestrator, task, commitTaskOutcome } = harness({
      events: ({ taskId, turns }) => [answerEvent(taskId, turns[0].id)],
    });
    await expect(orchestrator.completeLearningLoop(task.id, "op")).rejects.toThrow("闭环尚未闭合");
    expect(commitTaskOutcome).not.toHaveBeenCalled();
  });

  it("refuses to close on a correct first answer alone", async () => {
    // The initial retrieval is correct, which v1 would have accepted as mastery.
    const { orchestrator, task } = harness({
      events: ({ taskId, turns }) => [answerEvent(taskId, turns[0].id, { answerAssessment: "correct" })],
    });
    await expect(orchestrator.completeLearningLoop(task.id, "op")).rejects.toThrow("需要先完成反馈后的一次合格再提取");
  });

  it("closes once both retrievals qualify and schedules from the post-judgment evidence", async () => {
    const { orchestrator, task, commitTaskOutcome } = harness({
      loop: "closed",
      events: ({ taskId, turns }) => [
        answerEvent(taskId, turns[0].id),
        answerEvent(taskId, turns[1].id, { id: "answer-post" }),
      ],
    });
    await orchestrator.completeLearningLoop(task.id, "op");

    expect(commitTaskOutcome).toHaveBeenCalledTimes(1);
    const [, events, status, , , verification] = commitTaskOutcome.mock.calls[0] as unknown as [
      string, TaskOutcomeEvent[], string, string, string | undefined, Record<string, unknown>,
    ];
    expect(status).toBe("completed");
    // Exactly one event, and it is the disposition. No self-assessment is written.
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ kind: "task-disposition", disposition: "completed" });
    expect(events.some((event) => event.kind === "self-assessment")).toBe(false);
    // The verification is opened by the retrieval, not by an opinion.
    expect(verification).toMatchObject({
      sourceOutcomeEventId: "answer-post",
      loopVersion: "closed-loop-v2",
      strategyVersion: DELAYED_VERIFICATION_STRATEGY_VERSION_V2,
      status: "scheduled",
    });
  });

  it("accepts no outcome, reason or confirmation argument at all", async () => {
    const { orchestrator } = harness();
    // Two positional arguments: id and operation. Anything else is a type error,
    // and this runtime assertion keeps the arity honest for JS callers too.
    expect(orchestrator.completeLearningLoop.length).toBe(2);
  });

  it("rejects a v1 task so legacy records keep their own path", async () => {
    const { orchestrator, repository, task } = harness();
    (repository.getFormalSnapshot as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ...(await repository.getFormalSnapshot()),
      adaptiveReviewTasks: [{ ...task, loopVersion: undefined }],
    });
    await expect(orchestrator.completeLearningLoop(task.id, "op")).rejects.toThrow("只适用于 closed-loop-v2");
  });

  it("rejects when a terminal disposition was already written", async () => {
    const { orchestrator, task } = harness({
      loop: "closed",
      events: ({ taskId, turns }) => [
        answerEvent(taskId, turns[0].id),
        answerEvent(taskId, turns[1].id, { id: "answer-post" }),
        {
          id: "done",
          taskId,
          decisionBlockId: coachTestBlock.id,
          recordId: coachTestBlock.recordId,
          contentVersion: 1,
          kind: "task-disposition",
          disposition: "abandoned",
          occurredAt: coachTestStamp,
          idempotencyKey: "done",
          createdAt: coachTestStamp,
          updatedAt: coachTestStamp,
        },
      ],
    });
    await expect(orchestrator.completeLearningLoop(task.id, "op")).rejects.toThrow("已经写入终态");
  });
});

describe("deferAndRequeueV2Attempt (M2)", () => {
  it("defers with a reason and requeues the same target instead of inventing a result", async () => {
    const { orchestrator, task, deferAndRequeue, blueprint } = harness();
    const result = await orchestrator.deferAndRequeueV2Attempt({ taskId: task.id, operationId: "op-defer" });

    // One call, so the deferral and its replacement cannot be torn apart.
    expect(deferAndRequeue).toHaveBeenCalledTimes(1);
    const input = deferAndRequeue.mock.calls[0][0];
    expect(input.deferredTaskId).toBe(task.id);
    expect(input.notBeforeAt).toBeTruthy();
    expect(input.deferredEvents[0]).toMatchObject({
      kind: "task-disposition",
      disposition: "deferred",
      reason: "budget-exhausted-before-closure",
    });
    // The same frozen target is requeued, not silently re-planned.
    expect(input.blueprint).toMatchObject({ id: blueprint.id, maxTurns: blueprint.maxTurns });
    expect(input.reason).toBe("budget-exhausted-before-closure");
    expect(input.operationId).toBe("op-defer");
    expect(result.replacement).toMatchObject({ id: "replacement" });
  });

  it("refuses to defer a task whose loop is already closed", async () => {
    const { orchestrator, task, deferAndRequeue } = harness({
      loop: "closed",
      events: ({ taskId, turns }) => [
        answerEvent(taskId, turns[0].id),
        answerEvent(taskId, turns[1].id, { id: "answer-post" }),
      ],
    });
    await expect(orchestrator.deferAndRequeueV2Attempt({ taskId: task.id, operationId: "op" })).rejects.toThrow("闭环已经闭合");
    // Nothing is written at all: the refusal happens before the atomic call.
    expect(deferAndRequeue).not.toHaveBeenCalled();
  });

  it("refuses to requeue a v1 task", async () => {
    const { orchestrator, repository, task } = harness();
    (repository.getFormalSnapshot as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ...(await repository.getFormalSnapshot()),
      adaptiveReviewTasks: [{ ...task, loopVersion: undefined }],
    });
    await expect(orchestrator.deferAndRequeueV2Attempt({ taskId: task.id, operationId: "op" })).rejects.toThrow("只适用于 closed-loop-v2");
  });

  it("names the time box when wall-clock ran out instead of the turn budget", async () => {
    const { orchestrator, task, deferAndRequeue, snapshot, setTurns } = harness();
    setTurns([]);
    snapshot.adaptiveReviewTasks = [{ ...task, startedAt: "2026-09-15T08:00:00.000Z" }];
    // The harness clock is fixed at 08:00, so move it forward past the box.
    (orchestrator as unknown as { dependencies: { clock: { now(): string } } }).dependencies.clock.now = () => "2026-09-15T08:06:00.000Z";

    await orchestrator.deferAndRequeueV2Attempt({ taskId: task.id, operationId: "op-timebox" });
    expect(deferAndRequeue.mock.calls[0][0].deferredEvents[0]).toMatchObject({ reason: "time-box-exhausted" });
    expect(deferAndRequeue.mock.calls[0][0].reason).toBe("time-box-exhausted");
  });

  it("keeps the budget reason when the box has not elapsed", async () => {
    const { orchestrator, task, deferAndRequeue, setTurns } = harness();
    setTurns([]);
    await orchestrator.deferAndRequeueV2Attempt({ taskId: task.id, operationId: "op-budget" });
    expect(deferAndRequeue.mock.calls[0][0].deferredEvents[0]).toMatchObject({ reason: "budget-exhausted-before-closure" });
    expect(deferAndRequeue.mock.calls[0][0].reason).toBe("budget-exhausted-before-closure");
  });
});
