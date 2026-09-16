import Dexie from "dexie";
import { IDBKeyRange, indexedDB } from "fake-indexeddb";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { StudyJournalDatabase } from "../../db/database";
import { closedLoopV2Fixtures } from "./learningLoopFixtures";
import { ReviewCoachOrchestrator } from "./orchestrator";
import { DexieReviewCoachRepository } from "./repository";
import { authorityOfTurn, isIndependentRetrieval } from "./evidencePolicy";
import { coachTestBlock, coachTestStamp, completeCoachTestSnapshot } from "./reviewCoachTestFixtures";

Dexie.dependencies.indexedDB = indexedDB;
Dexie.dependencies.IDBKeyRange = IDBKeyRange;

/**
 * M3: help must visibly weaken the evidence, and action choices must stay
 * action-shaped.
 */

describe("intervention paths at the repository and orchestrator (M3)", () => {
  let database: StudyJournalDatabase;
  let repository: DexieReviewCoachRepository;

  beforeEach(async () => {
    database = new StudyJournalDatabase(`review-coach-intervention-${crypto.randomUUID()}`);
    await database.open();
    repository = new DexieReviewCoachRepository(database);
  });

  afterEach(async () => {
    const name = database.name;
    database.close();
    await Dexie.delete(name);
  });

  const seed = async () => {
    const { blueprint, task, turns } = closedLoopV2Fixtures({ loop: "open" });
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
    await database.adaptiveReviewTasks.put(structuredClone(task));
    for (const turn of turns) await database.adaptiveQuizTurns.put(structuredClone(turn));
    return { blueprint, task, turns };
  };

  it("marks a retrieval assisted once a hint is used, so it stops being independent evidence", async () => {
    const { turns } = await seed();
    const turn = { ...turns[0], status: "displayed" as const, availableHints: ["想想边界条件", "把它写成一条规则"] };
    await database.adaptiveQuizTurns.put(turn);
    expect(isIndependentRetrieval(turn)).toBe(true);

    const afterHint = await repository.recordQuizHint(turn.id, 1, coachTestStamp);
    expect(afterHint.hintsUsed).toHaveLength(1);
    expect(afterHint.independenceStatus).toBe("assisted");
    expect(isIndependentRetrieval(afterHint)).toBe(false);
  });

  it("keeps the hint record even when the same level is requested twice", async () => {
    const { turns } = await seed();
    const turn = { ...turns[0], status: "displayed" as const, availableHints: ["a", "b"] };
    await database.adaptiveQuizTurns.put(turn);
    await repository.recordQuizHint(turn.id, 1, coachTestStamp);
    const again = await repository.recordQuizHint(turn.id, 1, "2026-09-15T09:00:00.000Z");
    expect(again.hintsUsed).toHaveLength(1);
    expect(again.independenceStatus).toBe("assisted");
  });

  it("records an action choice without any result category", async () => {
    const { task } = await seed();
    const orchestrator = new ReviewCoachOrchestrator({
      repository,
      ids: { next: () => `id-${Math.random().toString(36).slice(2, 8)}` },
      clock: { now: () => coachTestStamp },
    });

    const resolution = await orchestrator.selectInterventionPath({
      taskId: task.id,
      path: "confused",
      operationId: "op-intervention-1",
    });
    expect(resolution.path).toBe("confused");
    expect(resolution.action.nextStrategy).toBe("discriminate");

    const stored = (await database.taskOutcomeEvents.toArray()).filter((event) => event.kind === "intervention-selected");
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({ interventionPath: "confused" });
    // Selecting an action is not a judgment about the answer.
    expect(stored[0].answerAssessment).toBeUndefined();
    expect(stored[0].subjectiveOutcome).toBeUndefined();
    expect(stored[0].disposition).toBeUndefined();
  });

  it("downgrades the third execution-failed choice to the material path", async () => {
    const { task } = await seed();
    const orchestrator = new ReviewCoachOrchestrator({
      repository,
      ids: { next: () => `id-${Math.random().toString(36).slice(2, 8)}` },
      clock: { now: () => coachTestStamp },
    });

    const first = await orchestrator.selectInterventionPath({ taskId: task.id, path: "execution-failed", operationId: "op-1" });
    const second = await orchestrator.selectInterventionPath({ taskId: task.id, path: "execution-failed", operationId: "op-2" });
    const third = await orchestrator.selectInterventionPath({ taskId: task.id, path: "execution-failed", operationId: "op-3" });

    expect(first.downgraded).toBe(false);
    expect(second.downgraded).toBe(false);
    expect(third.downgraded).toBe(true);
    expect(third.path).toBe("not-formed");

    const stored = (await database.taskOutcomeEvents.toArray())
      .filter((event) => event.kind === "intervention-selected")
      .sort((left, right) => left.idempotencyKey.localeCompare(right.idempotencyKey));
    expect(stored).toHaveLength(3);
    expect(stored[2]).toMatchObject({ interventionPath: "not-formed" });
    // The enforced downgrade explains itself in the record.
    expect(stored[2].reason).toContain("回到材料重建");
  });

  it("refuses action selection on a v1 task", async () => {
    const { task } = await seed();
    await database.adaptiveReviewTasks.put({ ...task, loopVersion: undefined });
    const orchestrator = new ReviewCoachOrchestrator({
      repository,
      ids: { next: () => "id" },
      clock: { now: () => coachTestStamp },
    });
    await expect(orchestrator.selectInterventionPath({ taskId: task.id, path: "confused", operationId: "op" }))
      .rejects.toThrow("只适用于 closed-loop-v2");
  });

  it("never lets an assisted retrieval carry objective authority", async () => {
    const { turns } = await seed();
    const assisted = { ...turns[0], independenceStatus: "assisted" as const };
    expect(authorityOfTurn(assisted)).toBe("provisional");
  });
});

describe("intervention paths drive the next generation (M3)", () => {
  let database: StudyJournalDatabase;
  let repository: DexieReviewCoachRepository;

  beforeEach(async () => {
    database = new StudyJournalDatabase(`review-coach-intervention-gen-${crypto.randomUUID()}`);
    await database.open();
    repository = new DexieReviewCoachRepository(database);
  });

  afterEach(async () => {
    const name = database.name;
    database.close();
    await Dexie.delete(name);
  });

  const seed = async () => {
    const { blueprint, task, turns } = closedLoopV2Fixtures({ loop: "open" });
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
    await database.adaptiveReviewTasks.put(structuredClone(task));
    for (const turn of turns) await database.adaptiveQuizTurns.put(structuredClone(turn));
    return { blueprint, task, turns };
  };

  /** A generation call that records what it was told and returns a valid turn. */
  const capturingOrchestrator = (generateTurn: ReturnType<typeof vi.fn>) => new ReviewCoachOrchestrator({
    repository,
    ids: { next: () => `id-${Math.random().toString(36).slice(2, 8)}` },
    clock: { now: () => coachTestStamp },
    aiGateway: {
      interpretFeedback: vi.fn(),
      planSession: vi.fn(),
      generateTurn,
      reviewQuestion: vi.fn(async () => ({ status: "ok" as const, verdict: "pass" as const, severeIssues: [], rationale: "ok" })),
      evaluateAnswer: vi.fn(),
    } as never,
  });

  /** The gateway resolves to the parsed turn itself, not a `{ response }` wrapper. */
  const turnResponse = (question = "用自己的话描述 BFS 的队列不变式。") => ({
    status: "ok" as const,
    practiceType: "variation" as const,
    answerMode: "open" as const,
    question,
    answerCriteria: ["一次遍历按层推进"],
    sourceEvidence: [],
    hints: ["想想出队顺序"],
  });

  const lastGenerateInput = (generateTurn: ReturnType<typeof vi.fn>) =>
    generateTurn.mock.calls.at(-1)![0] as Record<string, unknown>;

  it("carries the recorded action into the generation call", async () => {
    const { task } = await seed();
    const generateTurn = vi.fn(async () => turnResponse());
    const orchestrator = capturingOrchestrator(generateTurn);

    await orchestrator.selectInterventionPath({ taskId: task.id, path: "confused", operationId: "op-confused" });
    await orchestrator.generateQuizTurn({
      taskId: task.id,
      decisionBlockContent: "<p>BFS 使用队列，按层访问。</p>",
      provider: "stub",
      model: "stub",
      promptVersion: "quiz-turn-v2",
      qualityPromptVersion: "question-quality-v1",
      policyVersion: "review-coach-policy-v1",
      operationId: "op-generate",
    });

    const input = lastGenerateInput(generateTurn);
    // The system-owned action always travels, in its own vocabulary.
    expect(input.interventionAction).toBe("discriminate");
    expect(input.interventionPath).toBe("confused");
    // And the branch strategy is the regime hint the generator understands,
    // kept distinct from the action itself.
    expect(input.requestedStrategy).toBe("explain");
  });

  it("sends the material-backed action for a rebuild choice", async () => {
    const { task } = await seed();
    const generateTurn = vi.fn(async () => turnResponse());
    const orchestrator = capturingOrchestrator(generateTurn);

    await orchestrator.selectInterventionPath({ taskId: task.id, path: "not-formed", operationId: "op-rebuild" });
    await orchestrator.generateQuizTurn({
      taskId: task.id,
      decisionBlockContent: "<p>BFS 使用队列。</p>",
      provider: "stub", model: "stub", promptVersion: "quiz-turn-v2", qualityPromptVersion: "question-quality-v1", policyVersion: "review-coach-policy-v1", operationId: "op-generate",
    });

    const input = lastGenerateInput(generateTurn);
    expect(input.interventionAction).toBe("rebuild");
    expect(input.requestedStrategy).toBe("prerequisite-check");
  });

  it("does not send an action when the learner never chose one", async () => {
    const { task } = await seed();
    const generateTurn = vi.fn(async () => turnResponse());
    const orchestrator = capturingOrchestrator(generateTurn);

    await orchestrator.generateQuizTurn({
      taskId: task.id,
      decisionBlockContent: "<p>BFS 使用队列。</p>",
      provider: "stub", model: "stub", promptVersion: "quiz-turn-v2", qualityPromptVersion: "question-quality-v1", policyVersion: "review-coach-policy-v1", operationId: "op-generate",
    });

    const input = lastGenerateInput(generateTurn);
    expect(input.interventionAction).toBeUndefined();
    expect(input.interventionPath).toBeUndefined();
  });

  it("does not let another task's action steer this task's generation", async () => {
    const { task, blueprint } = await seed();
    // Record an action against a different task on the same block. The clone
    // needs its own unique-index values to be storable as a separate row.
    await database.adaptiveReviewTasks.put({
      ...structuredClone(task),
      id: "task-v2-OTHER",
      activeSlotKey: undefined,
      openTargetKey: "decision-block-other:1",
      idempotencyKey: "task-v2-OTHER-key",
    });
    await database.taskOutcomeEvents.put({
      id: "intervention-other",
      taskId: "task-v2-OTHER",
      decisionBlockId: task.decisionBlockId,
      recordId: task.recordId,
      contentVersion: task.contentVersion,
      kind: "intervention-selected",
      interventionPath: "not-formed",
      occurredAt: coachTestStamp,
      idempotencyKey: "intervention-other",
      createdAt: coachTestStamp,
      updatedAt: coachTestStamp,
    });
    expect(blueprint).toBeTruthy();

    const generateTurn = vi.fn(async () => turnResponse());
    const orchestrator = capturingOrchestrator(generateTurn);
    await orchestrator.generateQuizTurn({
      taskId: task.id,
      decisionBlockContent: "<p>BFS 使用队列。</p>",
      provider: "stub", model: "stub", promptVersion: "quiz-turn-v2", qualityPromptVersion: "question-quality-v1", policyVersion: "review-coach-policy-v1", operationId: "op-generate",
    });

    const input = lastGenerateInput(generateTurn);
    expect(input.interventionAction).toBeUndefined();
    expect(input.interventionPath).toBeUndefined();
  });
});
