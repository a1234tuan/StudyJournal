import { describe, expect, it, vi } from "vitest";

import type { AdaptiveQuizTurn, AdaptiveReviewTask, ReviewCoachFormalSnapshot, SessionBlueprint } from "./domain";
import { quizPracticeTypes } from "./aiSchemas";
import { ReviewCoachOrchestrator } from "./orchestrator";
import type { ReviewCoachRepository } from "./repository";

const stamp = "2026-09-07T08:00:00.000Z";
const blueprint: SessionBlueprint = {
  id: "blueprint-1", batchId: "batch-1", decisionBlockId: "block-1", recordId: "record-1", contentVersion: 1, status: "accepted", supportingDecisionBlockIds: [], feedbackIds: ["feedback-1"], interpretationIds: [], problemHypothesis: "boundary", hypothesisConfidence: 0.8, objective: "Use the correct boundary", completionCriteria: ["states invariant"], initialPracticeType: "variation", initialDifficulty: 2, expectedKeyPoints: ["invariant"], branches: [{ when: "correct", nextStrategy: "finish" }, { when: "partial", nextStrategy: "hint" }, { when: "incorrect", nextStrategy: "explain" }, { when: "skipped", nextStrategy: "prerequisite-check" }], allowedStrategies: ["finish", "hint", "explain", "prerequisite-check"], forbiddenScope: ["other"], evidence: [{ decisionBlockId: "block-1", recordId: "record-1", contentVersion: 1, excerptHash: "hash-1", purpose: "source" }], maxTurns: 2, maxRetriesPerTurn: 1, maxEstimatedTokens: 2000, provider: "test", model: "mock", promptVersion: "p", policyVersion: "policy", schemaVersion: 1, idempotencyKey: "blueprint-key", createdAt: stamp, updatedAt: stamp,
};
const task: AdaptiveReviewTask = { id: "task-1", blueprintId: blueprint.id, decisionBlockId: "block-1", recordId: "record-1", contentVersion: 1, status: "current", priorityTier: "first-difficulty", queuedAt: stamp, idempotencyKey: "task-key", createdAt: stamp, updatedAt: stamp };
const snapshot = (turns: AdaptiveQuizTurn[] = [], currentTask: AdaptiveReviewTask = task): ReviewCoachFormalSnapshot => ({ decisionBlocks: [{ id: "block-1", recordId: "record-1", contentVersion: 1, position: 0, createdAt: stamp, updatedAt: stamp, contentUpdatedAt: stamp }], decisionBlockArchives: [], decisionBlockFeedback: [{ id: "feedback-1", decisionBlockId: "block-1", recordId: "record-1", contentVersion: 1, comment: "boundary", includeInAnalysis: true, source: "manual", occurredAt: stamp, idempotencyKey: "feedback-key", createdAt: stamp, updatedAt: stamp }], feedbackInterpretations: [], analysisQueueItems: [], analysisBatches: [{ id: "batch-1", status: "succeeded", inputRefs: [{ queueItemId: "queue-1", feedbackId: "feedback-1", decisionBlockId: "block-1", recordId: "record-1", contentVersion: 1 }], subBatches: [{ id: "sub-1", inputRefs: [{ queueItemId: "queue-1", feedbackId: "feedback-1", decisionBlockId: "block-1", recordId: "record-1", contentVersion: 1 }], status: "succeeded" }], model: "mock", provider: "test", promptVersion: "p", policyVersion: "policy", schemaVersion: 1, inputFingerprint: "fp", idempotencyKey: "batch-key", createdAt: stamp, updatedAt: stamp }], sessionBlueprints: [blueprint], adaptiveReviewTasks: [currentTask], adaptiveQuizTurns: turns, taskOutcomeEvents: [], delayedVerifications: [], aiRoleConfigs: [], legacyLearningEvidence: [], legacyKnowledgePoints: [], legacyRecordKnowledgePointLinks: [], legacyKnowledgeRelations: [] });

const turnResponse = { status: "ok" as const, practiceType: "variation" as const, answerMode: "unique" as const, question: "Which boundary is correct?", answerCriteria: ["right inclusive"], sourceEvidence: blueprint.evidence, hints: ["Check the invariant."] };

describe("Stage 6 quiz orchestrator", () => {
  it("quality-fails once, regenerates once, and persists only the checked turn", async () => {
    let current = task;
    let turns: AdaptiveQuizTurn[] = [];
    const repository = {
      getFormalSnapshot: vi.fn(async () => snapshot(turns, current)),
      transitionTask: vi.fn(async (_id: string, status: AdaptiveReviewTask["status"], updatedAt: string) => (current = { ...current, status, updatedAt })),
      addQuizTurn: vi.fn(async (next: AdaptiveQuizTurn) => (turns = [...turns, next], next)),
      recordQuizHint: vi.fn(),
    } as unknown as ReviewCoachRepository;
    const reviewQuestion = vi.fn().mockResolvedValueOnce({ status: "ok", verdict: "fail", severeIssues: ["missing-condition"], rationale: "bad" }).mockResolvedValueOnce({ status: "ok", verdict: "pass", severeIssues: [], rationale: "good" });
    const orchestrator = new ReviewCoachOrchestrator({ repository, ids: { next: () => "turn-1" }, clock: { now: () => stamp }, aiGateway: { interpretFeedback: vi.fn(), planSession: vi.fn(), generateTurn: vi.fn().mockResolvedValue(turnResponse), reviewQuestion, evaluateAnswer: vi.fn() } });
    const result = await orchestrator.generateQuizTurn({ taskId: task.id, decisionBlockContent: "source", provider: "test", model: "mock", promptVersion: "quiz-v1", qualityPromptVersion: "quality-v1", policyVersion: "policy", operationId: "op-1" });
    expect(result).toMatchObject({ status: "displayed", qualityChecked: true, answerMode: "unique" });
    expect(reviewQuestion).toHaveBeenCalledTimes(2);
    expect(repository.addQuizTurn).toHaveBeenCalledTimes(1);
  });

  it("rejects a finish without answer evidence and requires a reason for not-mastered", async () => {
    const repository = { getFormalSnapshot: vi.fn(async () => snapshot()) } as unknown as ReviewCoachRepository;
    const orchestrator = new ReviewCoachOrchestrator({ repository, ids: { next: () => "id" }, clock: { now: () => stamp }, aiGateway: { interpretFeedback: vi.fn(), planSession: vi.fn(), generateTurn: vi.fn(), reviewQuestion: vi.fn(async () => ({ status: "ok" as const, verdict: "pass" as const, severeIssues: [], rationale: "ok" })), evaluateAnswer: vi.fn() } });
    await expect(orchestrator.finishQuizTask({ taskId: task.id, outcome: "not-mastered", operationId: "op" })).rejects.toThrow("至少完成一轮有效作答");
  });

  it("stops after one quality regeneration and persists no draft", async () => {
    let current = task;
    const addQuizTurn = vi.fn();
    const repository = { getFormalSnapshot: vi.fn(async () => snapshot([], current)), transitionTask: vi.fn(async (_id: string, status: AdaptiveReviewTask["status"]) => (current = { ...current, status })), addQuizTurn } as unknown as ReviewCoachRepository;
    const orchestrator = new ReviewCoachOrchestrator({ repository, ids: { next: () => "turn" }, clock: { now: () => stamp }, aiGateway: { interpretFeedback: vi.fn(), planSession: vi.fn(), generateTurn: vi.fn().mockResolvedValue(turnResponse), reviewQuestion: vi.fn().mockResolvedValue({ status: "ok", verdict: "fail", severeIssues: ["source-drift"], rationale: "drift" }), evaluateAnswer: vi.fn() } });
    await expect(orchestrator.generateQuizTurn({ taskId: task.id, decisionBlockContent: "source", provider: "test", model: "mock", promptVersion: "quiz-v1", qualityPromptVersion: "quality-v1", policyVersion: "policy", operationId: "op" })).rejects.toThrow("质检连续失败");
    expect(addQuizTurn).not.toHaveBeenCalled();
  });

  it("runs answer evaluation through a not-mastered replan without overwriting the task", async () => {
    const displayed: AdaptiveQuizTurn = { id: "turn-1", taskId: task.id, decisionBlockId: task.decisionBlockId, recordId: task.recordId, contentVersion: 1, sequence: 1, status: "displayed", practiceType: "variation", answerMode: "open", question: "Explain", displayedAt: stamp, sourceEvidence: blueprint.evidence, answerCriteria: ["states invariant"], hintsUsed: [], availableHints: [], qualityChecked: false, generationModel: "mock", promptVersion: "p", policyVersion: "policy", idempotencyKey: "turn-key", createdAt: stamp, updatedAt: stamp };
    let currentTask: AdaptiveReviewTask = { ...task, status: "in-progress" };
    let turns = [displayed];
    const addFeedback = vi.fn(async (value) => value);
    const commitTaskOutcome = vi.fn(async () => (currentTask = { ...currentTask, status: "not-achieved" as const }));
    const repository = {
      getFormalSnapshot: vi.fn(async () => snapshot(turns, currentTask)),
      commitQuizAnswer: vi.fn(async (next: AdaptiveQuizTurn) => { turns = [next]; return next; }),
      commitTaskOutcome,
      addFeedback,
    } as unknown as ReviewCoachRepository;
    let id = 0;
    const orchestrator = new ReviewCoachOrchestrator({ repository, ids: { next: () => `id-${++id}` }, clock: { now: () => stamp }, aiGateway: { interpretFeedback: vi.fn(), planSession: vi.fn(), generateTurn: vi.fn(), reviewQuestion: vi.fn(async () => ({ status: "ok" as const, verdict: "pass" as const, severeIssues: [], rationale: "ok" })), evaluateAnswer: vi.fn().mockResolvedValue({ status: "ok", assessment: "incorrect", matchedCriteria: [], missingCriteria: ["states invariant"], rationale: "missing invariant" }) } });

    await orchestrator.submitQuizAnswer({ turnId: displayed.id, answerText: "I am unsure", decisionBlockContent: "决策块材料：B 树所有叶节点深度相同。", provider: "test", model: "mock", promptVersion: "answer-v1", policyVersion: "policy", operationId: "answer-op" });
    await orchestrator.finishQuizTask({ taskId: task.id, outcome: "not-mastered", reason: "I cannot state the invariant", operationId: "finish-op" });

    expect(commitTaskOutcome).toHaveBeenCalledWith(task.id, expect.any(Array), "not-achieved", stamp, undefined, undefined);
    expect(addFeedback).toHaveBeenCalledWith(expect.objectContaining({ comment: "I cannot state the invariant", source: "manual" }), expect.anything());
  });

  it("rejects an answer evaluation that invents criteria", async () => {
    const displayed: AdaptiveQuizTurn = { id: "turn-1", taskId: task.id, decisionBlockId: task.decisionBlockId, recordId: task.recordId, contentVersion: 1, sequence: 1, status: "displayed", practiceType: "variation", question: "Explain", displayedAt: stamp, sourceEvidence: blueprint.evidence, answerCriteria: ["states invariant"], hintsUsed: [], qualityChecked: false, generationModel: "mock", promptVersion: "p", policyVersion: "policy", idempotencyKey: "turn-key", createdAt: stamp, updatedAt: stamp };
    const repository = { getFormalSnapshot: vi.fn(async () => snapshot([displayed], { ...task, status: "in-progress" })) } as unknown as ReviewCoachRepository;
    const orchestrator = new ReviewCoachOrchestrator({ repository, ids: { next: () => "id" }, clock: { now: () => stamp }, aiGateway: { interpretFeedback: vi.fn(), planSession: vi.fn(), generateTurn: vi.fn(), reviewQuestion: vi.fn(async () => ({ status: "ok" as const, verdict: "pass" as const, severeIssues: [], rationale: "ok" })), evaluateAnswer: vi.fn().mockResolvedValue({ status: "ok", assessment: "correct", matchedCriteria: ["invented"], missingCriteria: [], rationale: "wrong" }) } });
    await expect(orchestrator.submitQuizAnswer({ turnId: displayed.id, answerText: "answer", decisionBlockContent: "决策块材料", provider: "test", model: "mock", promptVersion: "p", policyVersion: "policy", operationId: "op" })).rejects.toThrow("题目之外的判据");
  });

  it("hands the raw decision-block material to the answer evaluator", async () => {
    const displayed: AdaptiveQuizTurn = { id: "turn-1", taskId: task.id, decisionBlockId: task.decisionBlockId, recordId: task.recordId, contentVersion: 1, sequence: 1, status: "displayed", practiceType: "variation", question: "Explain", displayedAt: stamp, sourceEvidence: blueprint.evidence, answerCriteria: ["states invariant"], hintsUsed: [], qualityChecked: false, generationModel: "mock", promptVersion: "p", policyVersion: "policy", idempotencyKey: "turn-key", createdAt: stamp, updatedAt: stamp };
    const commitQuizAnswer = vi.fn(async (next: AdaptiveQuizTurn) => next);
    const repository = { getFormalSnapshot: vi.fn(async () => snapshot([displayed], { ...task, status: "in-progress" })), commitQuizAnswer } as unknown as ReviewCoachRepository;
    const evaluateAnswer = vi.fn().mockResolvedValue({ status: "ok", assessment: "partial", matchedCriteria: ["states invariant"], missingCriteria: [], rationale: "partly right" });
    const orchestrator = new ReviewCoachOrchestrator({ repository, ids: { next: () => "id" }, clock: { now: () => stamp }, aiGateway: { interpretFeedback: vi.fn(), planSession: vi.fn(), generateTurn: vi.fn(), reviewQuestion: vi.fn(async () => ({ status: "ok" as const, verdict: "pass" as const, severeIssues: [], rationale: "ok" })), evaluateAnswer } });
    const material = "决策块材料：B 树的叶节点深度相同，插入时沿路径分裂。";
    await orchestrator.submitQuizAnswer({ turnId: displayed.id, answerText: "answer", decisionBlockContent: material, provider: "test", model: "mock", promptVersion: "p", policyVersion: "policy", operationId: "op" });
    expect(evaluateAnswer).toHaveBeenCalledWith(expect.objectContaining({ decisionBlockContent: material }), undefined);
    expect(commitQuizAnswer).toHaveBeenCalledTimes(1);
  });

  it("records a skipped answer and requests the Blueprint skipped strategy next", async () => {
    const displayed: AdaptiveQuizTurn = { id: "turn-1", taskId: task.id, decisionBlockId: task.decisionBlockId, recordId: task.recordId, contentVersion: 1, sequence: 1, status: "displayed", practiceType: "variation", answerMode: "open", question: "Explain", displayedAt: stamp, sourceEvidence: blueprint.evidence, answerCriteria: ["states invariant"], hintsUsed: [], availableHints: [], qualityChecked: false, generationModel: "mock", promptVersion: "p", policyVersion: "policy", idempotencyKey: "turn-key", createdAt: stamp, updatedAt: stamp };
    let turns = [displayed];
    const commitQuizAnswer = vi.fn(async (next: AdaptiveQuizTurn) => {
      turns = [next];
      return next;
    });
    const addQuizTurn = vi.fn(async (next: AdaptiveQuizTurn) => {
      turns = [...turns, next];
      return next;
    });
    const generateTurn = vi.fn().mockResolvedValue({ ...turnResponse, answerMode: "open" });
    const repository = {
      getFormalSnapshot: vi.fn(async () => snapshot(turns, { ...task, status: "in-progress" })),
      commitQuizAnswer,
      addQuizTurn,
    } as unknown as ReviewCoachRepository;
    let id = 0;
    const orchestrator = new ReviewCoachOrchestrator({ repository, ids: { next: () => `id-${++id}` }, clock: { now: () => stamp }, aiGateway: { interpretFeedback: vi.fn(), planSession: vi.fn(), generateTurn, reviewQuestion: vi.fn(async () => ({ status: "ok" as const, verdict: "pass" as const, severeIssues: [], rationale: "ok" })), evaluateAnswer: vi.fn() } });

    await orchestrator.skipQuizTurn(displayed.id, "skip-op");
    await orchestrator.generateQuizTurn({ taskId: task.id, decisionBlockContent: "source", provider: "test", model: "mock", promptVersion: "quiz-v1", qualityPromptVersion: "quality-v1", policyVersion: "policy", operationId: "next-op" });

    expect(commitQuizAnswer).toHaveBeenCalledWith(expect.objectContaining({ answerText: "[skipped]", assessment: "unreliable" }), expect.objectContaining({ answerAssessment: "unreliable", reason: "skipped" }));
    expect(generateTurn).toHaveBeenCalledWith(expect.objectContaining({ requestedStrategy: "prerequisite-check" }), undefined);
  });

  it("does not treat a skipped turn as valid answer evidence", async () => {
    const skipped: AdaptiveQuizTurn = { id: "turn-1", taskId: task.id, decisionBlockId: task.decisionBlockId, recordId: task.recordId, contentVersion: 1, sequence: 1, status: "answered", practiceType: "variation", answerMode: "open", question: "Explain", displayedAt: stamp, sourceEvidence: blueprint.evidence, answerCriteria: ["states invariant"], hintsUsed: [], availableHints: [], qualityChecked: false, generationModel: "mock", promptVersion: "p", policyVersion: "policy", idempotencyKey: "turn-key", answerText: "[skipped]", answeredAt: stamp, assessment: "unreliable", assessmentRationale: "skipped", createdAt: stamp, updatedAt: stamp };
    const repository = { getFormalSnapshot: vi.fn(async () => snapshot([skipped], { ...task, status: "in-progress" })) } as unknown as ReviewCoachRepository;
    const orchestrator = new ReviewCoachOrchestrator({ repository, ids: { next: () => "id" }, clock: { now: () => stamp }, aiGateway: { interpretFeedback: vi.fn(), planSession: vi.fn(), generateTurn: vi.fn(), reviewQuestion: vi.fn(), evaluateAnswer: vi.fn() } });

    await expect(orchestrator.finishQuizTask({ taskId: task.id, outcome: "mastered", operationId: "finish-op" })).rejects.toThrow("至少完成一轮有效作答");
  });

  it("records an unjudgeable answer explicitly and picks no strategy for the next turn (C-3)", async () => {
    const displayed: AdaptiveQuizTurn = { id: "turn-1", taskId: task.id, decisionBlockId: task.decisionBlockId, recordId: task.recordId, contentVersion: 1, sequence: 1, status: "displayed", practiceType: "variation", answerMode: "open", question: "Explain", displayedAt: stamp, sourceEvidence: blueprint.evidence, answerCriteria: ["states invariant"], hintsUsed: [], availableHints: [], qualityChecked: false, generationModel: "mock", promptVersion: "p", policyVersion: "policy", idempotencyKey: "turn-key", createdAt: stamp, updatedAt: stamp };
    let turns = [displayed];
    const commitQuizAnswer = vi.fn(async (next: AdaptiveQuizTurn) => { turns = [next]; return next; });
    const addQuizTurn = vi.fn(async (next: AdaptiveQuizTurn) => { turns = [...turns, next]; return next; });
    const commitTaskOutcome = vi.fn();
    const generateTurn = vi.fn().mockResolvedValue({ ...turnResponse, answerMode: "open" });
    const repository = {
      getFormalSnapshot: vi.fn(async () => snapshot(turns, { ...task, status: "in-progress" })),
      commitQuizAnswer,
      addQuizTurn,
      commitTaskOutcome,
    } as unknown as ReviewCoachRepository;
    const orchestrator = new ReviewCoachOrchestrator({ repository, ids: { next: () => `id-${turns.length}` }, clock: { now: () => stamp }, aiGateway: { interpretFeedback: vi.fn(), planSession: vi.fn(), generateTurn, reviewQuestion: vi.fn(async () => ({ status: "ok" as const, verdict: "pass" as const, severeIssues: [], rationale: "ok" })), evaluateAnswer: vi.fn().mockResolvedValue({ status: "ok", assessment: "unreliable", matchedCriteria: [], missingCriteria: [], rationale: "材料不足以覆盖该判据" }) } });

    await orchestrator.submitQuizAnswer({ turnId: displayed.id, answerText: "我不太确定", decisionBlockContent: "决策块材料", provider: "test", model: "mock", promptVersion: "p", policyVersion: "policy", operationId: "answer-op" });
    await orchestrator.generateQuizTurn({ taskId: task.id, decisionBlockContent: "source", provider: "test", model: "mock", promptVersion: "quiz-v1", qualityPromptVersion: "quality-v1", policyVersion: "policy", operationId: "next-op" });

    // "Could not judge" is now explicit in formal data, not silently folded into "no judgement".
    expect(commitQuizAnswer).toHaveBeenCalledWith(
      expect.objectContaining({ assessment: "unreliable" }),
      expect.objectContaining({ answerAssessment: "unreliable", reason: expect.stringMatching(/^unreliable:/) }),
      undefined,
    );
    // And it drives nothing: no mastery decision, no task outcome, no branch strategy at all —
    // in particular not the `partial` branch's strategy.
    expect(commitTaskOutcome).not.toHaveBeenCalled();
    const payload = generateTurn.mock.calls.at(-1)![0] as { requestedStrategy?: string };
    // The key is present but undefined, so it is dropped from the serialised payload entirely.
    expect(payload.requestedStrategy).toBeUndefined();
    expect(JSON.stringify(payload)).not.toContain('"requestedStrategy":"');
    // And whatever it ever carries, it must never be a practice type (F-07).
    expect(quizPracticeTypes.includes(payload.requestedStrategy as never)).toBe(false);
  });

  it("regenerates once on a local leak, then stops without another provider call (C-4)", async () => {
    let currentTask: AdaptiveReviewTask = { ...task, status: "in-progress" };
    const addQuizTurn = vi.fn();
    const repository = {
      getFormalSnapshot: vi.fn(async () => snapshot([], currentTask)),
      transitionTask: vi.fn(async (_id: string, status: AdaptiveReviewTask["status"]) => (currentTask = { ...currentTask, status })),
      addQuizTurn,
    } as unknown as ReviewCoachRepository;
    const reviewQuestion = vi.fn();
    const leaking = { status: "ok" as const, practiceType: "variation" as const, answerMode: "open" as const, question: "直接说出答案：标记必须在入队前标记。", answerCriteria: ["在入队前标记"], sourceEvidence: blueprint.evidence, hints: [] };
    const generateTurn = vi.fn().mockResolvedValue(leaking);
    const orchestrator = new ReviewCoachOrchestrator({ repository, ids: { next: () => "turn" }, clock: { now: () => stamp }, aiGateway: { interpretFeedback: vi.fn(), planSession: vi.fn(), generateTurn, reviewQuestion, evaluateAnswer: vi.fn() } });

    await expect(orchestrator.generateQuizTurn({ taskId: task.id, decisionBlockContent: "source", provider: "test", model: "mock", promptVersion: "quiz-v1", qualityPromptVersion: "quality-v1", policyVersion: "policy", operationId: "op" })).rejects.toThrow("题目质检连续失败");

    expect(generateTurn).toHaveBeenCalledTimes(2);
    expect(generateTurn.mock.calls[1][0]).toMatchObject({ priorQualityFailure: expect.stringContaining("泄露") });
    // The leak is caught locally, so the paid quality review is never reached and nothing persists.
    expect(reviewQuestion).not.toHaveBeenCalled();
    expect(addQuizTurn).not.toHaveBeenCalled();
  });
});
