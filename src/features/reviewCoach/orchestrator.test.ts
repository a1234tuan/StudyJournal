import { describe, expect, it, vi } from "vitest";
import { AiRequestError } from "../../services/aiClientService";

import type { AdaptiveReviewTask, AnalysisBatch, AnalysisInputRef, FeedbackInterpretation, ReviewCoachFormalSnapshot, SessionBlueprint } from "./domain";
import type { SessionBlueprintAiCandidate } from "./aiSchemas";
import type { AnalysisPlanningBlock } from "./analysisPlanner";
import { ReviewCoachOrchestrator, rankWaitingTasks } from "./orchestrator";
import type { ReviewCoachRepository } from "./repository";

const stamp = "2026-09-04T08:00:00.000Z";

const inputRef = (block: string, suffix: string): AnalysisInputRef => ({
  queueItemId: `queue-${suffix}`,
  feedbackId: `feedback-${suffix}`,
  decisionBlockId: block,
  recordId: `record-${block}`,
  contentVersion: 1,
});

describe("ReviewCoachOrchestrator", () => {
  it("keeps all pending feedback for one block together and batches at most three blocks", async () => {
    const createAnalysisBatch = vi.fn(async (batch: AnalysisBatch) => batch);
    let nextId = 0;
    const orchestrator = new ReviewCoachOrchestrator({
      repository: { createAnalysisBatch } as unknown as ReviewCoachRepository,
      ids: { next: () => `generated-${++nextId}` },
      clock: { now: () => stamp },
    });
    const refs = [
      inputRef("block-1", "1a"),
      inputRef("block-1", "1b"),
      inputRef("block-2", "2"),
      inputRef("block-3", "3"),
      inputRef("block-4", "4"),
    ];

    const batch = await orchestrator.prepareAnalysisBatch({
      inputRefs: refs,
      provider: "test",
      model: "deep-model",
      promptVersion: "session-blueprint-v1",
      policyVersion: "review-coach-policy-v1",
      schemaVersion: 1,
      inputFingerprint: "input",
      operationId: "operation",
    });

    expect(batch.subBatches).toHaveLength(2);
    expect(batch.subBatches[0].inputRefs.map((ref) => ref.decisionBlockId)).toEqual(["block-1", "block-1", "block-2", "block-3"]);
    expect(new Set(batch.subBatches[0].inputRefs.map((ref) => ref.decisionBlockId)).size).toBe(3);
    expect(batch.subBatches[1].inputRefs.map((ref) => ref.decisionBlockId)).toEqual(["block-4"]);
  });

  it("uses deterministic local priority tiers and FIFO waiting age", () => {
    const task = (id: string, priorityTier: AdaptiveReviewTask["priorityTier"], queuedAt: string): AdaptiveReviewTask => ({
      id,
      blueprintId: `blueprint-${id}`,
      decisionBlockId: `block-${id}`,
      recordId: `record-${id}`,
      contentVersion: 1,
      status: "waiting",
      priorityTier,
      queuedAt,
      idempotencyKey: `operation-${id}`,
      createdAt: queuedAt,
      updatedAt: queuedAt,
    });
    const ranked = rankWaitingTasks([
      task("new", "first-difficulty", "2026-09-04T09:00:00.000Z"),
      task("old", "first-difficulty", "2026-09-04T08:00:00.000Z"),
      task("verification", "due-verification", "2026-09-04T10:00:00.000Z"),
    ]);

    expect(ranked.map((item) => item.id)).toEqual(["verification", "old", "new"]);
  });

  it("retries malformed/provider failures and persists a bounded failed result", async () => {
    const feedback = {
      id: "feedback-1",
      decisionBlockId: "block-1",
      recordId: "record-1",
      contentVersion: 1,
      comment: "I am stuck.",
      includeInAnalysis: true,
      source: "review" as const,
      occurredAt: stamp,
      idempotencyKey: "feedback-1",
      createdAt: stamp,
      updatedAt: stamp,
    };
    let interpretation: FeedbackInterpretation | undefined;
    const snapshot = (): ReviewCoachFormalSnapshot => ({
      decisionBlocks: [{ id: "block-1", recordId: "record-1", contentVersion: 1, position: 0, contentUpdatedAt: stamp, createdAt: stamp, updatedAt: stamp }],
      decisionBlockArchives: [], decisionBlockFeedback: [feedback], feedbackInterpretations: interpretation ? [interpretation] : [],
      analysisQueueItems: [], analysisBatches: [], sessionBlueprints: [], adaptiveReviewTasks: [], adaptiveQuizTurns: [], taskOutcomeEvents: [], delayedVerifications: [], aiRoleConfigs: [],
      legacyLearningEvidence: [], legacyKnowledgePoints: [], legacyRecordKnowledgePointLinks: [], legacyKnowledgeRelations: [],
    });
    const saveFeedbackInterpretation = vi.fn(async (next: FeedbackInterpretation) => { interpretation = next; return next; });
    const interpretFeedback = vi.fn(async () => { throw new AiRequestError("timeout", true, undefined, false, undefined, "timeout"); });
    const orchestrator = new ReviewCoachOrchestrator({
      repository: { getFormalSnapshot: vi.fn(async () => snapshot()), listFeedbackInterpretations: vi.fn(async () => interpretation ? [interpretation] : []), saveFeedbackInterpretation } as unknown as ReviewCoachRepository,
      ids: { next: () => "unused" }, clock: { now: () => stamp },
      aiGateway: {
        interpretFeedback,
        planSession: vi.fn(), generateTurn: vi.fn(), reviewQuestion: vi.fn(), evaluateAnswer: vi.fn(),
      },
    });
    const result = await orchestrator.interpretFeedback({ feedbackId: feedback.id, decisionBlockContent: "content", provider: "test", model: "fast", promptVersion: "p", policyVersion: "policy", schemaVersion: 1, maxRetries: 1 });
    expect(interpretFeedback).toHaveBeenCalledTimes(2);
    expect(result.status).toBe("failed");
    expect(saveFeedbackInterpretation).toHaveBeenCalled();
  });

  it("keeps a successful AI result separate until the user confirms it", async () => {
    const feedback = {
      id: "feedback-2", decisionBlockId: "block-2", recordId: "record-2", contentVersion: 1, comment: "Why?", includeInAnalysis: true,
      source: "review" as const, occurredAt: stamp, idempotencyKey: "feedback-2", createdAt: stamp, updatedAt: stamp,
    };
    let interpretation: FeedbackInterpretation | undefined;
    const snapshot = (): ReviewCoachFormalSnapshot => ({
      decisionBlocks: [{ id: "block-2", recordId: "record-2", contentVersion: 1, position: 0, contentUpdatedAt: stamp, createdAt: stamp, updatedAt: stamp }],
      decisionBlockArchives: [], decisionBlockFeedback: [feedback], feedbackInterpretations: interpretation ? [interpretation] : [], analysisQueueItems: [], analysisBatches: [], sessionBlueprints: [], adaptiveReviewTasks: [], adaptiveQuizTurns: [], taskOutcomeEvents: [], delayedVerifications: [], aiRoleConfigs: [], legacyLearningEvidence: [], legacyKnowledgePoints: [], legacyRecordKnowledgePointLinks: [], legacyKnowledgeRelations: [],
    });
    const save = vi.fn(async (next: FeedbackInterpretation) => { interpretation = next; return next; });
    const orchestrator = new ReviewCoachOrchestrator({
      repository: { getFormalSnapshot: vi.fn(async () => snapshot()), listFeedbackInterpretations: vi.fn(async () => interpretation ? [interpretation] : []), saveFeedbackInterpretation: save } as unknown as ReviewCoachRepository,
      ids: { next: () => "unused" }, clock: { now: () => stamp },
      aiGateway: { interpretFeedback: vi.fn(async () => ({ response: { status: "ok" as const, actionability: "needs_training" as const, difficultyType: "concept" as const, stuckAt: "definition", userHypothesis: null, preferredPractice: "concept-question", missingInformation: [], confidence: 0.8 }, usage: { promptTokens: 120, completionTokens: 30, totalTokens: 150 }, requestId: "request-1" })), planSession: vi.fn(), generateTurn: vi.fn(), reviewQuestion: vi.fn(), evaluateAnswer: vi.fn() },
    });
    const generated = await orchestrator.interpretFeedback({ feedbackId: feedback.id, decisionBlockContent: "definition", provider: "test", model: "fast", promptVersion: "p", policyVersion: "policy", schemaVersion: 1 });
    expect(generated.aiGenerated).toBe(true);
    expect(generated.totalTokens).toBe(150);
    expect(generated.requestId).toBe("request-1");
    const confirmed = await orchestrator.confirmFeedbackInterpretation(feedback.id, { preferredPractice: "variation" });
    expect(confirmed.aiGenerated).toBe(false);
    expect(confirmed.preferredPractice).toBe("variation");
  });

  it("persists an explicit insufficient-context result without inventing fields", async () => {
    const feedback = {
      id: "feedback-insufficient", decisionBlockId: "block-1", recordId: "record-1", contentVersion: 1,
      comment: "I do not understand.", includeInAnalysis: true, source: "review" as const, occurredAt: stamp,
      idempotencyKey: "feedback-insufficient", createdAt: stamp, updatedAt: stamp,
    };
    let current: FeedbackInterpretation | undefined;
    const formal = (): ReviewCoachFormalSnapshot => ({
      decisionBlocks: [], decisionBlockArchives: [], decisionBlockFeedback: [feedback], feedbackInterpretations: [],
      analysisQueueItems: [], analysisBatches: [], sessionBlueprints: [], adaptiveReviewTasks: [], adaptiveQuizTurns: [], taskOutcomeEvents: [], delayedVerifications: [], aiRoleConfigs: [],
      legacyLearningEvidence: [], legacyKnowledgePoints: [], legacyRecordKnowledgePointLinks: [], legacyKnowledgeRelations: [],
    });
    const orchestrator = new ReviewCoachOrchestrator({
      repository: {
        getFormalSnapshot: vi.fn(async () => formal()),
        listFeedbackInterpretations: vi.fn(async () => current ? [current] : []),
        saveFeedbackInterpretation: vi.fn(async (next: FeedbackInterpretation) => { current = next; return next; }),
      } as unknown as ReviewCoachRepository,
      ids: { next: () => "unused" }, clock: { now: () => stamp },
      aiGateway: { interpretFeedback: vi.fn(async () => ({ response: { status: "insufficient-context" as const, missingInformation: ["缺少具体卡点"] } })), planSession: vi.fn(), generateTurn: vi.fn(), reviewQuestion: vi.fn(), evaluateAnswer: vi.fn() },
    });

    const result = await orchestrator.interpretFeedback({ feedbackId: feedback.id, decisionBlockContent: "short", provider: "test", model: "fast", promptVersion: "p", policyVersion: "policy", schemaVersion: 1 });
    expect(result).toMatchObject({ status: "insufficient-context", actionability: "unclear", missingInformation: ["缺少具体卡点"] });
    expect(result.difficultyType).toBeUndefined();
  });

  it("retries once after a timeout and records the successful attempt", async () => {
    const feedback = {
      id: "feedback-retry", decisionBlockId: "block-1", recordId: "record-1", contentVersion: 1,
      comment: "Order is confusing.", includeInAnalysis: true, source: "review" as const, occurredAt: stamp,
      idempotencyKey: "feedback-retry", createdAt: stamp, updatedAt: stamp,
    };
    let current: FeedbackInterpretation | undefined;
    const interpretFeedback = vi.fn()
      .mockRejectedValueOnce(new AiRequestError("timeout", true, undefined, false, undefined, "timeout"))
      .mockResolvedValueOnce({ response: { status: "ok", actionability: "needs_training", difficultyType: "procedure", stuckAt: "order", userHypothesis: null, preferredPractice: "variation", missingInformation: [], confidence: 0.9 } });
    const orchestrator = new ReviewCoachOrchestrator({
      repository: {
        getFormalSnapshot: vi.fn(async () => ({ decisionBlocks: [], decisionBlockArchives: [], decisionBlockFeedback: [feedback], feedbackInterpretations: [], analysisQueueItems: [], analysisBatches: [], sessionBlueprints: [], adaptiveReviewTasks: [], adaptiveQuizTurns: [], taskOutcomeEvents: [], delayedVerifications: [], aiRoleConfigs: [], legacyLearningEvidence: [], legacyKnowledgePoints: [], legacyRecordKnowledgePointLinks: [], legacyKnowledgeRelations: [] })),
        listFeedbackInterpretations: vi.fn(async () => current ? [current] : []),
        saveFeedbackInterpretation: vi.fn(async (next: FeedbackInterpretation) => { current = next; return next; }),
      } as unknown as ReviewCoachRepository,
      ids: { next: () => "unused" }, clock: { now: () => stamp },
      aiGateway: { interpretFeedback, planSession: vi.fn(), generateTurn: vi.fn(), reviewQuestion: vi.fn(), evaluateAnswer: vi.fn() },
    });

    const result = await orchestrator.interpretFeedback({ feedbackId: feedback.id, decisionBlockContent: "content", provider: "test", model: "fast", promptVersion: "p", policyVersion: "policy", schemaVersion: 1, maxRetries: 1 });
    expect(result).toMatchObject({ status: "succeeded", attemptCount: 2 });
  });

  it("returns an aborted interpretation to pending for later recovery", async () => {
    const controller = new AbortController();
    controller.abort();
    const feedback = {
      id: "feedback-abort", decisionBlockId: "block-1", recordId: "record-1", contentVersion: 1,
      comment: "Pause this.", includeInAnalysis: true, source: "review" as const, occurredAt: stamp,
      idempotencyKey: "feedback-abort", createdAt: stamp, updatedAt: stamp,
    };
    let current: FeedbackInterpretation | undefined;
    const abortError = Object.assign(new Error("aborted"), { name: "AbortError" });
    const orchestrator = new ReviewCoachOrchestrator({
      repository: {
        getFormalSnapshot: vi.fn(async () => ({ decisionBlocks: [], decisionBlockArchives: [], decisionBlockFeedback: [feedback], feedbackInterpretations: [], analysisQueueItems: [], analysisBatches: [], sessionBlueprints: [], adaptiveReviewTasks: [], adaptiveQuizTurns: [], taskOutcomeEvents: [], delayedVerifications: [], aiRoleConfigs: [], legacyLearningEvidence: [], legacyKnowledgePoints: [], legacyRecordKnowledgePointLinks: [], legacyKnowledgeRelations: [] })),
        listFeedbackInterpretations: vi.fn(async () => current ? [current] : []),
        saveFeedbackInterpretation: vi.fn(async (next: FeedbackInterpretation) => { current = next; return next; }),
      } as unknown as ReviewCoachRepository,
      ids: { next: () => "unused" }, clock: { now: () => stamp },
      aiGateway: { interpretFeedback: vi.fn(async () => { throw abortError; }), planSession: vi.fn(), generateTurn: vi.fn(), reviewQuestion: vi.fn(), evaluateAnswer: vi.fn() },
    });

    const result = await orchestrator.interpretFeedback({ feedbackId: feedback.id, decisionBlockContent: "content", provider: "test", model: "fast", promptVersion: "p", policyVersion: "policy", schemaVersion: 1, signal: controller.signal });
    expect(result).toMatchObject({ status: "pending", attemptCount: 0 });
  });

  it("includes only earlier interpretations from the same decision block in historical trend", async () => {
    const feedback = (id: string, blockId: string, occurredAt: string) => ({
      id, decisionBlockId: blockId, recordId: "record-1", contentVersion: 1, comment: `comment-${id}`,
      includeInAnalysis: true, source: "review" as const, occurredAt, idempotencyKey: id, createdAt: occurredAt, updatedAt: occurredAt,
    });
    const earlier = feedback("earlier", "block-1", "2026-09-04T07:00:00.000Z");
    const target = feedback("target", "block-1", "2026-09-04T08:00:00.000Z");
    const future = feedback("future", "block-1", "2026-09-04T09:00:00.000Z");
    const other = feedback("other", "block-2", "2026-09-04T06:00:00.000Z");
    const interpreted = (item: ReturnType<typeof feedback>): FeedbackInterpretation => ({
      id: `interpretation-${item.id}`, feedbackId: item.id, decisionBlockId: item.decisionBlockId, contentVersion: 1,
      status: "succeeded", actionability: "needs_training", missingInformation: [], aiGenerated: true,
      model: "fast", provider: "test", promptVersion: "p", policyVersion: "policy", schemaVersion: 1,
      createdAt: item.createdAt, updatedAt: item.updatedAt,
    });
    const prior = [interpreted(earlier), interpreted(future), interpreted(other)];
    let current: FeedbackInterpretation | undefined;
    const interpretFeedback = vi.fn(async (_input: unknown) => ({ response: { status: "insufficient-context" as const, missingInformation: ["detail"] } }));
    const orchestrator = new ReviewCoachOrchestrator({
      repository: {
        getFormalSnapshot: vi.fn(async () => ({ decisionBlocks: [], decisionBlockArchives: [], decisionBlockFeedback: [earlier, target, future, other], feedbackInterpretations: prior, analysisQueueItems: [], analysisBatches: [], sessionBlueprints: [], adaptiveReviewTasks: [], adaptiveQuizTurns: [], taskOutcomeEvents: [], delayedVerifications: [], aiRoleConfigs: [], legacyLearningEvidence: [], legacyKnowledgePoints: [], legacyRecordKnowledgePointLinks: [], legacyKnowledgeRelations: [] })),
        listFeedbackInterpretations: vi.fn(async () => current ? [...prior, current] : prior),
        saveFeedbackInterpretation: vi.fn(async (next: FeedbackInterpretation) => { current = next; return next; }),
      } as unknown as ReviewCoachRepository,
      ids: { next: () => "unused" }, clock: { now: () => stamp },
      aiGateway: { interpretFeedback, planSession: vi.fn(), generateTurn: vi.fn(), reviewQuestion: vi.fn(), evaluateAnswer: vi.fn() },
    });

    await orchestrator.interpretFeedback({ feedbackId: target.id, decisionBlockContent: "content", provider: "test", model: "fast", promptVersion: "p", policyVersion: "policy", schemaVersion: 1 });
    expect(interpretFeedback.mock.calls[0][0]).toMatchObject({ historicalTrend: [{ originalComment: "comment-earlier" }] });
  });

  const planningBlock = (id: string, estimatedTokens = 400): AnalysisPlanningBlock => ({
    decisionBlockId: id,
    recordId: `record-${id}`,
    contentVersion: 1,
    recordTitle: `Record ${id}`,
    subject: "test",
    contextMarkdown: `context-${id}`,
    excerptHash: `hash-${id}`,
    missingOcrAssetIds: [],
    inputRefs: [{ queueItemId: `queue-${id}`, feedbackId: `feedback-${id}`, decisionBlockId: id, recordId: `record-${id}`, contentVersion: 1 }],
    feedback: [{ id: `feedback-${id}`, comment: "stuck", occurredAt: stamp }],
    estimatedTokens,
  });

  const blueprintCandidate = (id: string): SessionBlueprintAiCandidate => ({
    mainDecisionBlockId: id,
    contentVersion: 1,
    supportingDecisionBlockIds: [],
    feedbackIds: [`feedback-${id}`],
    interpretationIds: [],
    problemHypothesis: "unstable recall",
    hypothesisConfidence: 0.8,
    objective: "apply the source correctly",
    completionCriteria: ["uses the correct rule"],
    initialPracticeType: "variation",
    initialDifficulty: 2,
    expectedKeyPoints: ["source rule"],
    branches: [
      { when: "correct", nextStrategy: "finish" },
      { when: "partial", nextStrategy: "hint" },
      { when: "incorrect", nextStrategy: "explain" },
      { when: "skipped", nextStrategy: "prerequisite-check" },
    ],
    allowedStrategies: ["finish", "hint", "explain", "prerequisite-check"],
    forbiddenScope: ["unrelated material"],
    evidence: [{ decisionBlockId: id, recordId: `record-${id}`, contentVersion: 1, excerptHash: `hash-${id}`, purpose: "source" }],
    maxTurns: 4,
    maxRetriesPerTurn: 1,
    maxEstimatedTokens: 4000,
  });

  const deepAnalysisRepository = () => {
    let batch: AnalysisBatch | undefined;
    const blueprints: SessionBlueprint[] = [];
    let tasks: AdaptiveReviewTask[] = [];
    const snapshot = (): ReviewCoachFormalSnapshot => ({
      decisionBlocks: [], decisionBlockArchives: [], decisionBlockFeedback: [], feedbackInterpretations: [], analysisQueueItems: [],
      analysisBatches: batch ? [batch] : [], sessionBlueprints: blueprints, adaptiveReviewTasks: tasks, adaptiveQuizTurns: [], taskOutcomeEvents: [], delayedVerifications: [], aiRoleConfigs: [],
      legacyLearningEvidence: [], legacyKnowledgePoints: [], legacyRecordKnowledgePointLinks: [], legacyKnowledgeRelations: [],
    });
    const repository = {
      getFormalSnapshot: vi.fn(async () => snapshot()),
      createAnalysisBatch: vi.fn(async (next: AnalysisBatch) => { batch ??= next; return batch; }),
      transitionAnalysisBatch: vi.fn(async (_id: string, status: AnalysisBatch["status"], updatedAt: string) => { batch = { ...batch!, status, updatedAt }; return batch; }),
      updateAnalysisBatch: vi.fn(async (next: AnalysisBatch) => { batch = next; return next; }),
      acceptBlueprint: vi.fn(async (next: SessionBlueprint) => {
        const existing = blueprints.find((item) => item.idempotencyKey === next.idempotencyKey);
        if (existing) return existing;
        blueprints.push(next);
        return next;
      }),
      createTask: vi.fn(async (next: AdaptiveReviewTask) => {
        const existing = tasks.find((item) => item.idempotencyKey === next.idempotencyKey);
        if (existing) return existing;
        tasks.push(next);
        return next;
      }),
      transitionTask: vi.fn(async (id: string, status: AdaptiveReviewTask["status"], updatedAt: string) => {
        tasks = tasks.map((item) => item.id === id ? { ...item, status, updatedAt } : item);
        return tasks.find((item) => item.id === id)!;
      }),
    };
    return { repository: repository as unknown as ReviewCoachRepository, calls: repository, getBatch: () => batch, getTasks: () => tasks, blueprints };
  };

  it("turns a validated deep analysis into an accepted blueprint and one current task", async () => {
    const store = deepAnalysisRepository();
    let nextId = 0;
    const planSession = vi.fn(async () => ({ response: { status: "ok" as const, summary: "done", blueprints: [blueprintCandidate("block-1")] }, usage: { totalTokens: 900 }, requestId: "request-1" }));
    const orchestrator = new ReviewCoachOrchestrator({
      repository: store.repository, ids: { next: () => `generated-${++nextId}` }, clock: { now: () => stamp },
      aiGateway: { interpretFeedback: vi.fn(), planSession, generateTurn: vi.fn(), reviewQuestion: vi.fn(), evaluateAnswer: vi.fn() },
    });

    const result = await orchestrator.analyzeFeedback({ blocks: [planningBlock("block-1")], maxInputTokens: 1000, allowCrossBlockSupport: false, provider: "test", model: "deep", promptVersion: "p", policyVersion: "policy", schemaVersion: 1, operationId: "operation", maxRetries: 0 });

    expect(result.batch).toMatchObject({ status: "succeeded", totalTokens: 900 });
    expect(store.blueprints).toHaveLength(1);
    expect(store.getTasks()).toMatchObject([{ status: "current", priorityTier: "consolidation" }]);
  });

  it("keeps successful sub-batches and returns failed inputs for retry", async () => {
    const store = deepAnalysisRepository();
    let nextId = 0;
    const firstCandidates = [blueprintCandidate("block-1"), blueprintCandidate("block-2")];
    const planSession = vi.fn()
      .mockResolvedValueOnce({ response: { status: "ok", summary: "first", blueprints: firstCandidates } })
      .mockRejectedValueOnce(new AiRequestError("provider unavailable", true, 503));
    const orchestrator = new ReviewCoachOrchestrator({
      repository: store.repository, ids: { next: () => `generated-${++nextId}` }, clock: { now: () => stamp },
      aiGateway: { interpretFeedback: vi.fn(), planSession, generateTurn: vi.fn(), reviewQuestion: vi.fn(), evaluateAnswer: vi.fn() },
    });

    const result = await orchestrator.analyzeFeedback({ blocks: [planningBlock("block-1"), planningBlock("block-2"), planningBlock("block-3"), planningBlock("block-4")], maxInputTokens: 1000, allowCrossBlockSupport: false, provider: "test", model: "deep", promptVersion: "p", policyVersion: "policy", schemaVersion: 1, operationId: "operation", maxRetries: 0 });

    expect(result.batch.status).toBe("partial");
    expect(result.batch.subBatches.map((item) => item.status)).toEqual(["succeeded", "failed"]);
    expect(planSession).toHaveBeenCalledTimes(2);
    expect(store.blueprints).toHaveLength(2);
  });

  it("resumes a paused batch without calling a successful sub-batch again", async () => {
    const store = deepAnalysisRepository();
    const controller = new AbortController();
    let nextId = 0;
    const planSession = vi.fn()
      .mockResolvedValueOnce({ response: { status: "ok", summary: "first", blueprints: [blueprintCandidate("block-1"), blueprintCandidate("block-2")] } })
      .mockImplementationOnce(async () => {
        controller.abort();
        throw Object.assign(new Error("aborted"), { name: "AbortError" });
      })
      .mockResolvedValueOnce({ response: { status: "ok", summary: "second", blueprints: [blueprintCandidate("block-3"), blueprintCandidate("block-4")] } });
    const orchestrator = new ReviewCoachOrchestrator({
      repository: store.repository, ids: { next: () => `generated-${++nextId}` }, clock: { now: () => stamp },
      aiGateway: { interpretFeedback: vi.fn(), planSession, generateTurn: vi.fn(), reviewQuestion: vi.fn(), evaluateAnswer: vi.fn() },
    });
    const input = {
      blocks: [planningBlock("block-1"), planningBlock("block-2"), planningBlock("block-3"), planningBlock("block-4")],
      maxInputTokens: 1000,
      allowCrossBlockSupport: false,
      provider: "test",
      model: "deep",
      promptVersion: "p",
      policyVersion: "policy",
      schemaVersion: 1,
      operationId: "operation",
      maxRetries: 0,
    };

    const paused = await orchestrator.analyzeFeedback({ ...input, signal: controller.signal });
    expect(paused).toMatchObject({ paused: true, batch: { status: "confirmed" } });
    expect(paused.batch.subBatches.map((item) => item.status)).toEqual(["succeeded", "pending"]);

    const resumed = await orchestrator.analyzeFeedback(input);
    expect(resumed).toMatchObject({ paused: false, batch: { status: "succeeded" } });
    expect(planSession).toHaveBeenCalledTimes(3);
    expect(planSession.mock.calls.map(([request]) => request.blocks.map((block: { decisionBlockId: string }) => block.decisionBlockId))).toEqual([
      ["block-1", "block-2"],
      ["block-3", "block-4"],
      ["block-3", "block-4"],
    ]);
    expect(store.blueprints).toHaveLength(4);
  });

  it("rejects a blueprint whose evidence hash was not supplied", async () => {
    const store = deepAnalysisRepository();
    const invalid = blueprintCandidate("block-1");
    invalid.evidence[0].excerptHash = "invented";
    const orchestrator = new ReviewCoachOrchestrator({
      repository: store.repository, ids: { next: () => "generated" }, clock: { now: () => stamp },
      aiGateway: { interpretFeedback: vi.fn(), planSession: vi.fn(async () => ({ response: { status: "ok" as const, summary: "bad", blueprints: [invalid] } })), generateTurn: vi.fn(), reviewQuestion: vi.fn(), evaluateAnswer: vi.fn() },
    });

    const result = await orchestrator.analyzeFeedback({ blocks: [planningBlock("block-1")], maxInputTokens: 1000, allowCrossBlockSupport: false, provider: "test", model: "deep", promptVersion: "p", policyVersion: "policy", schemaVersion: 1, operationId: "operation", maxRetries: 0 });
    expect(result.batch.status).toBe("failed");
    expect(store.blueprints).toEqual([]);
  });
});
