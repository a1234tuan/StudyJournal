import type {
  AiCompletionUsage,
} from "../../types";
import type {
  AdaptiveQuizTurn,
  AdaptiveReviewTask,
  AnalysisBatch,
  AnalysisInputRef,
  AnalysisQueueItem,
  DecisionBlockFeedback,
  FeedbackInterpretation,
  FeedbackInterpretationStatus,
  SessionBlueprint,
  SubjectiveOutcome,
  TaskOutcomeEvent,
  TaskPriorityTier,
} from "./domain";
import { calculateDelayedVerificationSchedule, isVerificationDue, isVerificationEligible } from "./verificationPolicy";
import type {
  AnswerEvaluationAiResponse,
  FeedbackInterpretationAiResponse,
  QuestionQualityAiResponse,
  QuizTurnAiResponse,
  SessionBlueprintAiResponse,
  SessionBlueprintAiCandidate,
} from "./aiSchemas";
import type { ReviewCoachRepository } from "./repository";
import { planAnalysisBatches, type AnalysisPlanningBlock } from "./analysisPlanner";
import { isAbortError, isRetryableAiError } from "../../services/aiClientService";

/** 重试退避基数；指数退避 base * 2^attempt，受 signal 取消。 */
const ORCHESTRATOR_BACKOFF_BASE_MS = 500;
const abortableDelay = (ms: number, signal?: AbortSignal): Promise<void> => {
  if (signal?.aborted) return Promise.resolve();
  return new Promise<void>((resolve) => {
    const onAbort = () => { globalThis.clearTimeout(timeout); resolve(); };
    const timeout = globalThis.setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
};

export interface ReviewCoachAiGateway {
  interpretFeedback(input: unknown, signal?: AbortSignal): Promise<FeedbackInterpretationAiCallResult>;
  planSession(input: unknown, signal?: AbortSignal): Promise<SessionPlanningAiCallResult>;
  generateTurn(input: unknown, signal?: AbortSignal): Promise<QuizTurnAiResponse>;
  reviewQuestion(input: unknown, signal?: AbortSignal): Promise<QuestionQualityAiResponse>;
  evaluateAnswer(input: unknown, signal?: AbortSignal): Promise<AnswerEvaluationAiResponse>;
}

export interface FeedbackInterpretationAiCallResult {
  response: FeedbackInterpretationAiResponse;
  usage?: AiCompletionUsage;
  requestId?: string;
}

export interface SessionPlanningAiCallResult {
  response: SessionBlueprintAiResponse;
  usage?: AiCompletionUsage;
  requestId?: string;
}

export interface InterpretFeedbackInput {
  feedbackId: string;
  decisionBlockContent: string;
  provider: string;
  model: string;
  promptVersion: string;
  policyVersion: string;
  schemaVersion: number;
  maxRetries?: number;
  force?: boolean;
  signal?: AbortSignal;
}

export interface ReviewCoachOrchestratorDependencies {
  repository: ReviewCoachRepository;
  ids: { next(): string };
  clock: { now(): string };
  aiGateway?: ReviewCoachAiGateway;
}

export interface RecordDecisionBlockFeedbackInput {
  decisionBlockId: string;
  recordId: string;
  contentVersion: number;
  reviewLogId?: string;
  comment: string;
  includeInAnalysis: boolean;
  source?: DecisionBlockFeedback["source"];
  operationId: string;
}

export interface PrepareAnalysisBatchInput {
  inputRefs: AnalysisInputRef[];
  provider: string;
  model: string;
  promptVersion: string;
  policyVersion: string;
  schemaVersion: number;
  inputFingerprint: string;
  operationId: string;
  subBatches?: Array<{ inputRefs: AnalysisInputRef[]; estimatedTokens: number }>;
  estimatedTokens?: number;
  allowCrossBlockSupport?: boolean;
}

export interface AnalyzeFeedbackInput {
  blocks: AnalysisPlanningBlock[];
  maxInputTokens: number;
  allowCrossBlockSupport: boolean;
  provider: string;
  model: string;
  promptVersion: string;
  policyVersion: string;
  schemaVersion: number;
  operationId: string;
  maxRetries?: number;
  signal?: AbortSignal;
}

export interface AnalyzeFeedbackResult {
  batch: AnalysisBatch;
  blueprints: SessionBlueprint[];
  tasks: AdaptiveReviewTask[];
  paused: boolean;
}

export interface GenerateQuizTurnInput {
  taskId: string;
  decisionBlockContent: string;
  provider: string;
  model: string;
  promptVersion: string;
  qualityPromptVersion: string;
  policyVersion: string;
  operationId: string;
  signal?: AbortSignal;
}

export interface SubmitQuizAnswerInput {
  turnId: string;
  answerText: string;
  provider: string;
  model: string;
  promptVersion: string;
  policyVersion: string;
  operationId: string;
  signal?: AbortSignal;
}

const priorityRank: Record<AdaptiveReviewTask["priorityTier"], number> = {
  "due-verification": 0,
  "repeated-difficulty": 1,
  "first-difficulty": 2,
  consolidation: 3,
};

const validateBlueprintCandidates = (
  candidates: SessionBlueprintAiCandidate[],
  blocks: readonly AnalysisPlanningBlock[],
  allowCrossBlockSupport: boolean,
) => {
  const blockById = new Map(blocks.map((item) => [item.decisionBlockId, item]));
  const expectedMainIds = new Set(blockById.keys());
  const seenMainIds = new Set<string>();
  if (candidates.length !== blocks.length) throw new Error("Deep analysis must return one blueprint per selected decision block.");
  for (const candidate of candidates) {
    const main = blockById.get(candidate.mainDecisionBlockId);
    if (!main || seenMainIds.has(candidate.mainDecisionBlockId) || candidate.contentVersion !== main.contentVersion) {
      throw new Error("Blueprint main decision block is missing, duplicated, or stale.");
    }
    seenMainIds.add(candidate.mainDecisionBlockId);
    if (candidate.supportingDecisionBlockIds.some((id) =>
      id === candidate.mainDecisionBlockId || !blockById.has(id) || !allowCrossBlockSupport)) {
      throw new Error("Blueprint references an unconfirmed supporting decision block.");
    }
    const suppliedFeedback = new Set(blocks.flatMap((item) => item.feedback.map((feedback) => feedback.id)));
    const suppliedInterpretations = new Set(blocks.flatMap((item) => item.feedback.map((feedback) => feedback.interpretation?.id).filter((id): id is string => Boolean(id))));
    const mainFeedback = new Set(main.feedback.map((item) => item.id));
    if (candidate.feedbackIds.length === 0 || !candidate.feedbackIds.some((id) => mainFeedback.has(id)) || candidate.feedbackIds.some((id) => !suppliedFeedback.has(id))) {
      throw new Error("Blueprint feedback references are missing or outside the frozen input.");
    }
    if (candidate.interpretationIds.some((id) => !suppliedInterpretations.has(id))) {
      throw new Error("Blueprint interpretation references are outside the frozen input.");
    }
    if (!candidate.evidence.some((item) => item.decisionBlockId === main.decisionBlockId)) {
      throw new Error("Blueprint has no evidence for its main decision block.");
    }
    for (const evidence of candidate.evidence) {
      const source = blockById.get(evidence.decisionBlockId);
      if (!source || evidence.recordId !== source.recordId || evidence.contentVersion !== source.contentVersion || evidence.excerptHash !== source.excerptHash) {
        throw new Error("Blueprint evidence is stale or outside the frozen input.");
      }
    }
  }
  if ([...expectedMainIds].some((id) => !seenMainIds.has(id))) throw new Error("Deep analysis omitted a selected decision block.");
};

const priorityForPlanningBlock = (block: AnalysisPlanningBlock): TaskPriorityTier => {
  if (block.feedback.length > 1) return "repeated-difficulty";
  if (block.feedback.some((item) => item.interpretation?.actionability === "needs_training")) return "first-difficulty";
  return "consolidation";
};

const effectivePriorityRank = (task: AdaptiveReviewTask, now?: string) => {
  const base = priorityRank[task.priorityTier];
  if (!now || task.priorityTier === "due-verification") return base;
  const waitedWeeks = Math.floor(Math.max(0, Date.parse(now) - Date.parse(task.queuedAt)) / (7 * 86_400_000));
  return Math.max(0, base - waitedWeeks);
};

export const rankWaitingTasks = (tasks: AdaptiveReviewTask[], now?: string): AdaptiveReviewTask[] => [...tasks]
  .filter((task) => (task.status === "waiting" || task.status === "deferred") && (!now || !task.notBeforeAt || task.notBeforeAt <= now))
  .sort((left, right) =>
    effectivePriorityRank(left, now) - effectivePriorityRank(right, now) ||
    (left.notBeforeAt ?? left.queuedAt).localeCompare(right.notBeforeAt ?? right.queuedAt) ||
    left.queuedAt.localeCompare(right.queuedAt) ||
    left.id.localeCompare(right.id),
  );

export class ReviewCoachOrchestrator {
  constructor(private readonly dependencies: ReviewCoachOrchestratorDependencies) {}

  async recordFeedback(input: RecordDecisionBlockFeedbackInput): Promise<DecisionBlockFeedback> {
    const comment = input.comment.trim();
    if (!comment) throw new Error("Empty feedback is not recorded.");
    const stamp = this.dependencies.clock.now();
    const feedbackId = this.dependencies.ids.next();
    const feedback: DecisionBlockFeedback = {
      id: feedbackId,
      createdAt: stamp,
      updatedAt: stamp,
      decisionBlockId: input.decisionBlockId,
      recordId: input.recordId,
      contentVersion: input.contentVersion,
      reviewLogId: input.reviewLogId,
      comment,
      includeInAnalysis: input.includeInAnalysis,
      source: input.source ?? "review",
      occurredAt: stamp,
      idempotencyKey: `feedback:${input.operationId}`,
    };
    let queueItem: AnalysisQueueItem | undefined;
    if (input.includeInAnalysis) {
      queueItem = {
        id: this.dependencies.ids.next(),
        createdAt: stamp,
        updatedAt: stamp,
        decisionBlockId: input.decisionBlockId,
        recordId: input.recordId,
        contentVersion: input.contentVersion,
        feedbackId,
        status: "eligible",
        eligibilityReason: "user-feedback",
      };
    }
    return this.dependencies.repository.addFeedback(feedback, queueItem);
  }

  /** Run the quick interpreter without blocking the review transaction. */
  async interpretFeedback(input: InterpretFeedbackInput): Promise<FeedbackInterpretation> {
    if (!this.dependencies.aiGateway) throw new Error("Review coach AI gateway is not configured.");
    const [snapshot, allInterpretations] = await Promise.all([
      this.dependencies.repository.getFormalSnapshot(),
      this.dependencies.repository.listFeedbackInterpretations(),
    ]);
    const feedback = snapshot.decisionBlockFeedback.find((item) => item.id === input.feedbackId && !item.deletedAt);
    if (!feedback) throw new Error(`Feedback ${input.feedbackId} does not exist.`);
    const current = allInterpretations.find((item) => item.feedbackId === feedback.id && !item.deletedAt);
    if (!input.force && current && ["succeeded", "insufficient-context"].includes(current.status)) return current;

    const stamp = this.dependencies.clock.now();
    const interpretationId = current?.id ?? `feedback-interpretation:${feedback.id}`;
    const metadata = {
      feedbackId: feedback.id,
      decisionBlockId: feedback.decisionBlockId,
      contentVersion: feedback.contentVersion,
      aiGenerated: true,
      model: input.model,
      provider: input.provider,
      promptVersion: input.promptVersion,
      policyVersion: input.policyVersion,
      schemaVersion: input.schemaVersion,
    };
    let interpretation: FeedbackInterpretation = current ?? {
      id: interpretationId,
      createdAt: stamp,
      updatedAt: stamp,
      ...metadata,
      status: "pending",
      missingInformation: [],
    };
    if (interpretation.status !== "pending" && interpretation.status !== "running") {
      interpretation = { ...interpretation, ...metadata, status: "pending", updatedAt: stamp, errorCode: undefined };
      await this.dependencies.repository.saveFeedbackInterpretation(interpretation);
    } else if (!current) {
      await this.dependencies.repository.saveFeedbackInterpretation(interpretation);
    }
    interpretation = { ...interpretation, ...metadata, status: "running", updatedAt: this.dependencies.clock.now(), errorCode: undefined };
    await this.dependencies.repository.saveFeedbackInterpretation(interpretation);

    const maxRetries = Math.max(0, Math.min(3, Math.floor(input.maxRetries ?? 2)));
    const feedbackById = new Map(snapshot.decisionBlockFeedback.map((item) => [item.id, item]));
    const historicalTrend = snapshot.feedbackInterpretations
      .filter((item) => item.decisionBlockId === feedback.decisionBlockId && item.feedbackId !== feedback.id && !item.deletedAt)
      .map((item) => ({ feedback: feedbackById.get(item.feedbackId), interpretation: item }))
      .filter((item) => item.feedback && item.feedback.occurredAt < feedback.occurredAt)
      .sort((left, right) => left.feedback!.occurredAt.localeCompare(right.feedback!.occurredAt))
      .map(({ feedback: earlier, interpretation: prior }) => ({
        occurredAt: earlier!.occurredAt,
        originalComment: earlier!.comment,
        status: prior.status,
        actionability: prior.actionability,
        difficultyType: prior.difficultyType,
        stuckAt: prior.stuckAt,
        preferredPractice: prior.preferredPractice,
        confidence: prior.confidence,
        userConfirmed: Boolean(prior.userConfirmedAt),
      }));
    let lastError: unknown;
    for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
      try {
        const call = await this.dependencies.aiGateway.interpretFeedback({
          feedbackId: feedback.id,
          decisionBlockId: feedback.decisionBlockId,
          recordId: feedback.recordId,
          contentVersion: feedback.contentVersion,
          comment: feedback.comment,
          decisionBlockContent: input.decisionBlockContent,
          historicalTrend,
        }, input.signal);
        const response = call.response;
        const callMetadata = {
          promptTokens: call.usage?.promptTokens,
          completionTokens: call.usage?.completionTokens,
          totalTokens: call.usage?.totalTokens,
          requestId: call.requestId,
          attemptCount: attempt + 1,
        };
        const next: FeedbackInterpretation = response.status === "insufficient-context"
          ? { ...interpretation, ...callMetadata, status: "insufficient-context", missingInformation: response.missingInformation, actionability: "unclear", confidence: undefined, updatedAt: this.dependencies.clock.now() }
          : { ...interpretation, ...callMetadata, status: "succeeded", actionability: response.actionability, difficultyType: response.difficultyType, stuckAt: response.stuckAt, userHypothesis: response.userHypothesis, preferredPractice: response.preferredPractice, missingInformation: response.missingInformation, confidence: response.confidence, updatedAt: this.dependencies.clock.now() };
        return this.dependencies.repository.saveFeedbackInterpretation(next);
      } catch (error) {
        if (input.signal?.aborted || isAbortError(error)) {
          return this.dependencies.repository.saveFeedbackInterpretation({
            ...interpretation,
            status: "pending",
            attemptCount: attempt,
            updatedAt: this.dependencies.clock.now(),
            errorCode: undefined,
          });
        }
        lastError = error;
        // 不可重试错误（4xx 凭据/参数、解析错、insufficient-context）立即转失败，避免每次都计费。
        if (!isRetryableAiError(error)) break;
        if (attempt < maxRetries) await abortableDelay(ORCHESTRATOR_BACKOFF_BASE_MS * 2 ** attempt, input.signal);
      }
    }
    const failed: FeedbackInterpretation = {
      ...interpretation,
      status: "failed" as FeedbackInterpretationStatus,
      attemptCount: maxRetries + 1,
      errorCode: lastError instanceof Error ? lastError.message.slice(0, 240) : "interpretation-failed",
      updatedAt: this.dependencies.clock.now(),
    };
    return this.dependencies.repository.saveFeedbackInterpretation(failed);
  }

  async confirmFeedbackInterpretation(
    feedbackId: string,
    patch: Partial<Pick<FeedbackInterpretation, "actionability" | "difficultyType" | "stuckAt" | "userHypothesis" | "preferredPractice" | "missingInformation" | "confidence">> = {},
  ): Promise<FeedbackInterpretation> {
    const snapshot = await this.dependencies.repository.getFormalSnapshot();
    const current = snapshot.feedbackInterpretations.find((item) => item.feedbackId === feedbackId && !item.deletedAt);
    if (!current) throw new Error(`Feedback ${feedbackId} has no interpretation.`);
    const stamp = this.dependencies.clock.now();
    return this.dependencies.repository.saveFeedbackInterpretation({
      ...current,
      ...patch,
      status: "succeeded",
      aiGenerated: false,
      userConfirmedAt: current.userConfirmedAt ?? stamp,
      userEditedAt: Object.keys(patch).length > 0 ? stamp : current.userEditedAt,
      updatedAt: stamp,
      errorCode: undefined,
    });
  }

  async prepareAnalysisBatch(input: PrepareAnalysisBatchInput): Promise<AnalysisBatch> {
    if (input.inputRefs.length === 0) throw new Error("An analysis batch requires input.");
    const stamp = this.dependencies.clock.now();
    const subBatches = input.subBatches?.map((item) => ({
      id: this.dependencies.ids.next(), inputRefs: item.inputRefs, status: "pending" as const, estimatedTokens: item.estimatedTokens,
    })) ?? (() => {
      const generated = [];
      const byDecisionBlock = new Map<string, AnalysisInputRef[]>();
      for (const ref of input.inputRefs) {
        const current = byDecisionBlock.get(ref.decisionBlockId) ?? [];
        current.push(ref);
        byDecisionBlock.set(ref.decisionBlockId, current);
      }
      const blockGroups = [...byDecisionBlock.values()];
      for (let index = 0; index < blockGroups.length; index += 3) {
        generated.push({ id: this.dependencies.ids.next(), inputRefs: blockGroups.slice(index, index + 3).flat(), status: "pending" as const });
      }
      return generated;
    })();
    return this.dependencies.repository.createAnalysisBatch({
      id: this.dependencies.ids.next(),
      createdAt: stamp,
      updatedAt: stamp,
      status: "draft",
      inputRefs: input.inputRefs,
      subBatches,
      provider: input.provider,
      model: input.model,
      promptVersion: input.promptVersion,
      policyVersion: input.policyVersion,
      schemaVersion: input.schemaVersion,
      inputFingerprint: input.inputFingerprint,
      idempotencyKey: `analysis:${input.operationId}`,
      estimatedTokens: input.estimatedTokens,
      allowCrossBlockSupport: input.allowCrossBlockSupport,
    });
  }

  async analyzeFeedback(input: AnalyzeFeedbackInput): Promise<AnalyzeFeedbackResult> {
    if (!this.dependencies.aiGateway) throw new Error("Review coach AI gateway is not configured.");
    const plan = planAnalysisBatches(input.blocks, input.maxInputTokens);
    if (plan.oversized.length > 0) throw new Error(`决策块超过模型上下文上限：${plan.oversized.map((item) => item.recordTitle).join("、")}`);
    if (plan.subBatches.length === 0) throw new Error("没有可分析的决策块。");
    const blockById = new Map(input.blocks.map((item) => [item.decisionBlockId, item]));
    let batch = await this.prepareAnalysisBatch({
      inputRefs: plan.subBatches.flatMap((item) => item.blocks.flatMap((block) => block.inputRefs)),
      provider: input.provider,
      model: input.model,
      promptVersion: input.promptVersion,
      policyVersion: input.policyVersion,
      schemaVersion: input.schemaVersion,
      inputFingerprint: plan.inputFingerprint,
      operationId: input.operationId,
      subBatches: plan.subBatches.map((item) => ({ inputRefs: item.blocks.flatMap((block) => block.inputRefs), estimatedTokens: item.estimatedTokens })),
      estimatedTokens: plan.estimatedTokens,
      allowCrossBlockSupport: input.allowCrossBlockSupport,
    });
    if (batch.status === "draft") batch = await this.dependencies.repository.transitionAnalysisBatch(batch.id, "confirmed", this.dependencies.clock.now());
    if (batch.status === "confirmed") batch = await this.dependencies.repository.transitionAnalysisBatch(batch.id, "running", this.dependencies.clock.now());

    const existingSnapshot = await this.dependencies.repository.getFormalSnapshot();
    const blueprints = existingSnapshot.sessionBlueprints.filter((item) => item.batchId === batch.id && item.status === "accepted");
    const existingBlueprintIds = new Set(blueprints.map((item) => item.id));
    const tasks = existingSnapshot.adaptiveReviewTasks.filter((item) => existingBlueprintIds.has(item.blueprintId) && !item.deletedAt);
    const summaries: string[] = [];
    const maxRetries = Math.max(0, Math.min(2, Math.floor(input.maxRetries ?? 1)));
    for (let index = 0; index < batch.subBatches.length; index += 1) {
      const subBatch = batch.subBatches[index];
      if (subBatch.status === "succeeded") continue;
      const blocks = [...new Set(subBatch.inputRefs.map((ref) => ref.decisionBlockId))].map((id) => blockById.get(id)).filter((item): item is AnalysisPlanningBlock => Boolean(item));
      if (blocks.length === 0) throw new Error("冻结批次中的决策块上下文缺失。");
      batch = {
        ...batch,
        updatedAt: this.dependencies.clock.now(),
        subBatches: batch.subBatches.map((item, itemIndex) => itemIndex === index ? { ...item, status: "running", errorCode: undefined } : item),
      };
      batch = await this.dependencies.repository.updateAnalysisBatch(batch);
      let lastError: unknown;
      let completed = false;
      for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
        try {
          const call = await this.dependencies.aiGateway.planSession({
            blocks: blocks.map((block) => ({
              decisionBlockId: block.decisionBlockId,
              recordId: block.recordId,
              contentVersion: block.contentVersion,
              recordTitle: block.recordTitle,
              subject: block.subject,
              contextMarkdown: block.contextMarkdown,
              excerptHash: block.excerptHash,
              feedback: block.feedback.map((feedback) => ({
                id: feedback.id,
                originalComment: feedback.comment,
                occurredAt: feedback.occurredAt,
                analysisNote: feedback.analysisNote,
                interpretation: feedback.interpretation ? {
                  id: feedback.interpretation.id,
                  actionability: feedback.interpretation.actionability,
                  difficultyType: feedback.interpretation.difficultyType,
                  stuckAt: feedback.interpretation.stuckAt,
                  userHypothesis: feedback.interpretation.userHypothesis,
                  preferredPractice: feedback.interpretation.preferredPractice,
                  confidence: feedback.interpretation.confidence,
                  userConfirmed: Boolean(feedback.interpretation.userConfirmedAt),
                } : undefined,
              })),
            })),
            allowedSupportingDecisionBlockIds: input.allowCrossBlockSupport ? blocks.map((block) => block.decisionBlockId) : [],
          }, input.signal);
          if (call.response.status === "insufficient-context") {
            // 与 interpretFeedback 一致：背景不足为终态，不重试（避免对最大上下文载荷二次计费）。
            lastError = new Error(`insufficient-context:${call.response.missingInformation.join("、")}`);
            break;
          }
          validateBlueprintCandidates(call.response.blueprints, blocks, input.allowCrossBlockSupport);
          summaries.push(call.response.summary);
          for (const candidate of call.response.blueprints) {
            const persisted = await this.persistAnalysisCandidate(batch, candidate, blockById.get(candidate.mainDecisionBlockId)!, input);
            if (!blueprints.some((item) => item.id === persisted.blueprint.id)) blueprints.push(persisted.blueprint);
            if (!tasks.some((item) => item.id === persisted.task.id)) tasks.push(persisted.task);
          }
          batch = {
            ...batch,
            updatedAt: this.dependencies.clock.now(),
            subBatches: batch.subBatches.map((item, itemIndex) => itemIndex === index ? {
              ...item,
              status: "succeeded",
              promptTokens: call.usage?.promptTokens,
              completionTokens: call.usage?.completionTokens,
              totalTokens: call.usage?.totalTokens,
              requestId: call.requestId,
              attemptCount: attempt + 1,
              errorCode: undefined,
            } : item),
          };
          batch = await this.dependencies.repository.updateAnalysisBatch(batch);
          completed = true;
          break;
        } catch (error) {
          if (input.signal?.aborted || isAbortError(error)) {
            batch = {
              ...batch,
              status: "confirmed",
              updatedAt: this.dependencies.clock.now(),
              subBatches: batch.subBatches.map((item, itemIndex) => itemIndex === index ? { ...item, status: "pending", errorCode: undefined } : item),
            };
            batch = await this.dependencies.repository.updateAnalysisBatch(batch);
            return { batch, blueprints, tasks, paused: true };
          }
          lastError = error;
          // 不可重试错误立即转失败，避免对最大上下文载荷反复计费。
          if (!isRetryableAiError(error)) break;
          if (attempt < maxRetries) await abortableDelay(ORCHESTRATOR_BACKOFF_BASE_MS * 2 ** attempt, input.signal);
        }
      }
      if (!completed) {
        batch = {
          ...batch,
          updatedAt: this.dependencies.clock.now(),
          subBatches: batch.subBatches.map((item, itemIndex) => itemIndex === index ? {
            ...item,
            status: "failed",
            attemptCount: maxRetries + 1,
            errorCode: lastError instanceof Error ? lastError.message.slice(0, 240) : "analysis-failed",
          } : item),
        };
        batch = await this.dependencies.repository.updateAnalysisBatch(batch);
      }
    }

    const succeededCount = batch.subBatches.filter((item) => item.status === "succeeded").length;
    const finalStatus = succeededCount === batch.subBatches.length ? "succeeded" : succeededCount > 0 ? "partial" : "failed";
    const successfulSubBatches = batch.subBatches.filter((item) => item.status === "succeeded");
    batch = await this.dependencies.repository.updateAnalysisBatch({
      ...batch,
      status: finalStatus,
      finalSummary: summaries.filter(Boolean).join("\n"),
      promptTokens: successfulSubBatches.reduce((sum, item) => sum + (item.promptTokens ?? 0), 0) || undefined,
      completionTokens: successfulSubBatches.reduce((sum, item) => sum + (item.completionTokens ?? 0), 0) || undefined,
      totalTokens: successfulSubBatches.reduce((sum, item) => sum + (item.totalTokens ?? 0), 0) || undefined,
      completedAt: this.dependencies.clock.now(),
      updatedAt: this.dependencies.clock.now(),
      errorCode: finalStatus === "failed" ? "all-sub-batches-failed" : undefined,
    });

    await this.selectNextTask();
    return { batch, blueprints, tasks, paused: false };
  }

  private async persistAnalysisCandidate(
    batch: AnalysisBatch,
    candidate: SessionBlueprintAiCandidate,
    block: AnalysisPlanningBlock,
    input: AnalyzeFeedbackInput,
  ): Promise<{ blueprint: SessionBlueprint; task: AdaptiveReviewTask }> {
    const stamp = this.dependencies.clock.now();
    const blueprint = await this.dependencies.repository.acceptBlueprint({
        id: this.dependencies.ids.next(),
        batchId: batch.id,
        decisionBlockId: block.decisionBlockId,
        recordId: block.recordId,
        contentVersion: block.contentVersion,
        status: "accepted",
        supportingDecisionBlockIds: candidate.supportingDecisionBlockIds,
        feedbackIds: candidate.feedbackIds,
        interpretationIds: candidate.interpretationIds,
        problemHypothesis: candidate.problemHypothesis,
        hypothesisConfidence: candidate.hypothesisConfidence,
        objective: candidate.objective,
        completionCriteria: candidate.completionCriteria,
        initialPracticeType: candidate.initialPracticeType,
        initialDifficulty: candidate.initialDifficulty,
        expectedKeyPoints: candidate.expectedKeyPoints,
        branches: candidate.branches,
        allowedStrategies: candidate.allowedStrategies,
        forbiddenScope: candidate.forbiddenScope,
        evidence: candidate.evidence.map((item) => ({ ...item, decisionBlockId: item.decisionBlockId })),
        maxTurns: candidate.maxTurns,
        maxRetriesPerTurn: candidate.maxRetriesPerTurn,
        maxEstimatedTokens: candidate.maxEstimatedTokens,
        provider: input.provider,
        model: input.model,
        promptVersion: input.promptVersion,
        policyVersion: input.policyVersion,
        schemaVersion: input.schemaVersion,
        idempotencyKey: `blueprint:${batch.id}:${block.decisionBlockId}:${block.contentVersion}`,
        createdAt: stamp,
        updatedAt: stamp,
      });
    const task = await this.dependencies.repository.createTask({
        id: this.dependencies.ids.next(),
        blueprintId: blueprint.id,
        decisionBlockId: blueprint.decisionBlockId,
        recordId: blueprint.recordId,
        contentVersion: blueprint.contentVersion,
        status: "waiting",
        priorityTier: priorityForPlanningBlock(block),
        queuedAt: stamp,
        idempotencyKey: `task:${blueprint.id}`,
        createdAt: stamp,
        updatedAt: stamp,
      });
    return { blueprint, task };
  }

  acceptBlueprint(blueprint: SessionBlueprint) {
    return this.dependencies.repository.acceptBlueprint(blueprint);
  }

  async switchCurrentTask(taskId: string): Promise<AdaptiveReviewTask> {
    return this.dependencies.repository.switchCurrentTask(taskId, this.dependencies.clock.now());
  }

  async deferTask(taskId: string, operationId: string, delayHours = 24): Promise<AdaptiveReviewTask> {
    const snapshot = await this.dependencies.repository.getFormalSnapshot();
    const task = snapshot.adaptiveReviewTasks.find((item) => item.id === taskId && !item.deletedAt);
    if (!task) throw new Error(`Task ${taskId} does not exist.`);
    const stamp = this.dependencies.clock.now();
    const notBeforeAt = new Date(Date.parse(stamp) + Math.max(1, delayHours) * 60 * 60 * 1000).toISOString();
    const deferred = await this.dependencies.repository.commitTaskOutcome(task.id, [{
      id: this.dependencies.ids.next(),
      taskId: task.id,
      decisionBlockId: task.decisionBlockId,
      recordId: task.recordId,
      contentVersion: task.contentVersion,
      kind: "task-disposition",
      disposition: "deferred",
      occurredAt: stamp,
      idempotencyKey: `task-deferred:${operationId}`,
      createdAt: stamp,
      updatedAt: stamp,
    }], "deferred", stamp, notBeforeAt);
    await this.selectNextTask();
    return deferred;
  }

  async generateQuizTurn(input: GenerateQuizTurnInput): Promise<AdaptiveQuizTurn> {
    if (!this.dependencies.aiGateway) throw new Error("Review coach AI gateway is not configured.");
    let snapshot = await this.dependencies.repository.getFormalSnapshot();
    let task = snapshot.adaptiveReviewTasks.find((item) => item.id === input.taskId && !item.deletedAt);
    if (!task || !["current", "in-progress"].includes(task.status)) throw new Error("当前复习任务不可开始。");
    const blueprint = snapshot.sessionBlueprints.find((item) => item.id === task!.blueprintId && item.status === "accepted" && !item.deletedAt);
    if (!blueprint || blueprint.decisionBlockId !== task.decisionBlockId || blueprint.contentVersion !== task.contentVersion) throw new Error("复习蓝图缺失或已经过期。");
    if (task.status === "current") {
      task = await this.dependencies.repository.transitionTask(task.id, "in-progress", this.dependencies.clock.now());
      snapshot = await this.dependencies.repository.getFormalSnapshot();
    }
    const turns = snapshot.adaptiveQuizTurns.filter((item) => item.taskId === task!.id && item.status !== "invalid").sort((a, b) => a.sequence - b.sequence);
    const active = turns.find((item) => item.status === "displayed");
    if (active) return active;
    if (turns.length >= blueprint.maxTurns) throw new Error("本次训练已达到蓝图轮次上限，请提交本次结果。");
    const verification = snapshot.delayedVerifications.find((item) => item.taskId === task!.id && ["queued", "in-progress"].includes(item.status));
    const sourceOutcome = verification ? snapshot.taskOutcomeEvents.find((item) => item.id === verification.sourceOutcomeEventId) : undefined;
    const sourceTurns = sourceOutcome ? snapshot.adaptiveQuizTurns.filter((item) => item.taskId === sourceOutcome.taskId && item.status !== "invalid") : [];
    const previousTurns = verification ? [...sourceTurns, ...turns] : turns;
    const previous = turns.at(-1);
    const previousBranch = previous?.answerText === "[skipped]" ? "skipped" : previous?.assessment;
    const branch = previousBranch ? blueprint.branches.find((item) => item.when === previousBranch) : undefined;
    const evidenceByKey = new Map(blueprint.evidence.map((item) => [`${item.decisionBlockId}:${item.recordId}:${item.contentVersion}:${item.excerptHash}`, item]));
    let lastQualityReason = "";
    for (let generationAttempt = 0; generationAttempt < 2; generationAttempt += 1) {
      const response = await this.dependencies.aiGateway.generateTurn({
        task: { id: task.id, decisionBlockId: task.decisionBlockId, recordId: task.recordId, contentVersion: task.contentVersion },
        blueprint,
        decisionBlockContent: input.decisionBlockContent,
        previousTurns: previousTurns.map((item) => ({ sequence: item.sequence, practiceType: item.practiceType, question: item.question, assessment: item.assessment, hintsUsed: item.hintsUsed.length })),
        requestedStrategy: verification ? "continue" : branch?.nextStrategy ?? (turns.length === 0 ? blueprint.initialPracticeType : "continue"),
        verificationMode: verification ? { verificationId: verification.id, requireFreshRetrieval: true } : undefined,
        priorQualityFailure: lastQualityReason || undefined,
      }, input.signal);
      if (response.status === "insufficient-context") throw new Error(`生成题目所需背景不足：${response.missingInformation.join("、")}`);
      if (response.sourceEvidence.some((item) => !evidenceByKey.has(`${item.decisionBlockId}:${item.recordId}:${item.contentVersion}:${item.excerptHash}`))) {
        throw new Error("题目引用了蓝图之外的来源。");
      }
      if (verification && previousTurns.some((item) => item.question.trim() === response.question.trim())) {
        lastQualityReason = "延迟验证题与历史题目重复";
        continue;
      }
      const requiresQualityReview = response.practiceType === "calculation" || response.answerMode !== "open";
      let qualityChecked = false;
      if (requiresQualityReview) {
        const quality = await this.dependencies.aiGateway.reviewQuestion({ blueprint, candidate: response, decisionBlockContent: input.decisionBlockContent }, input.signal);
        qualityChecked = true;
        if (quality.status === "insufficient-context" || quality.verdict === "fail") {
          lastQualityReason = quality.status === "insufficient-context" ? quality.missingInformation.join("、") : quality.rationale;
          continue;
        }
      }
      const stamp = this.dependencies.clock.now();
      return this.dependencies.repository.addQuizTurn({
        id: this.dependencies.ids.next(),
        taskId: task.id,
        decisionBlockId: task.decisionBlockId,
        recordId: task.recordId,
        contentVersion: task.contentVersion,
        sequence: turns.length + 1,
        status: "displayed",
        practiceType: response.practiceType,
        answerMode: response.answerMode,
        question: response.question,
        displayedAt: stamp,
        sourceEvidence: response.sourceEvidence,
        answerCriteria: response.answerCriteria,
        hintsUsed: [],
        availableHints: response.hints,
        qualityChecked,
        qualityModel: qualityChecked ? input.model : undefined,
        generationModel: input.model,
        promptVersion: input.promptVersion,
        policyVersion: input.policyVersion,
        idempotencyKey: `quiz-turn:${input.operationId}:${turns.length + 1}`,
        createdAt: stamp,
        updatedAt: stamp,
      });
    }
    throw new Error(`题目质检连续失败，已停止生成。${lastQualityReason ? ` ${lastQualityReason}` : ""}`);
  }

  recordQuizHint(turnId: string, level: number) {
    return this.dependencies.repository.recordQuizHint(turnId, level, this.dependencies.clock.now());
  }

  async submitQuizAnswer(input: SubmitQuizAnswerInput): Promise<AdaptiveQuizTurn> {
    if (!this.dependencies.aiGateway) throw new Error("Review coach AI gateway is not configured.");
    const answerText = input.answerText.trim();
    if (!answerText) throw new Error("请先填写回答。");
    const snapshot = await this.dependencies.repository.getFormalSnapshot();
    const turn = snapshot.adaptiveQuizTurns.find((item) => item.id === input.turnId && item.status === "displayed");
    const task = turn ? snapshot.adaptiveReviewTasks.find((item) => item.id === turn.taskId && item.status === "in-progress") : undefined;
    const blueprint = task ? snapshot.sessionBlueprints.find((item) => item.id === task.blueprintId && item.status === "accepted") : undefined;
    if (!turn || !task || !blueprint) throw new Error("当前题目已经失效或不再进行中。");
    const evaluation = await this.dependencies.aiGateway.evaluateAnswer({ blueprint, question: turn.question, answerCriteria: turn.answerCriteria, answerText, hintsUsed: turn.hintsUsed }, input.signal);
    if (evaluation.status === "insufficient-context") throw new Error(`无法可靠判断回答：${evaluation.missingInformation.join("、")}`);
    const criteria = new Set(turn.answerCriteria);
    if ([...evaluation.matchedCriteria, ...evaluation.missingCriteria].some((item) => !criteria.has(item))) throw new Error("回答判定引用了题目之外的判据。");
    const stamp = this.dependencies.clock.now();
    const answered: AdaptiveQuizTurn = { ...turn, status: "answered", answerText, answeredAt: stamp, assessment: evaluation.assessment, assessmentRationale: evaluation.rationale, updatedAt: stamp };
    const outcome: TaskOutcomeEvent = {
      id: this.dependencies.ids.next(), taskId: task.id, turnId: turn.id, decisionBlockId: task.decisionBlockId, recordId: task.recordId, contentVersion: task.contentVersion,
      kind: "answer-assessment", answerAssessment: evaluation.assessment, reason: evaluation.rationale, occurredAt: stamp,
      idempotencyKey: `answer:${input.operationId}`, createdAt: stamp, updatedAt: stamp,
    };
    return this.dependencies.repository.commitQuizAnswer(answered, outcome);
  }

  async skipQuizTurn(turnId: string, operationId: string): Promise<AdaptiveQuizTurn> {
    const snapshot = await this.dependencies.repository.getFormalSnapshot();
    const turn = snapshot.adaptiveQuizTurns.find((item) => item.id === turnId && item.status === "displayed");
    const task = turn ? snapshot.adaptiveReviewTasks.find((item) => item.id === turn.taskId && item.status === "in-progress") : undefined;
    if (!turn || !task) throw new Error("当前题目已经失效或不再进行中。");
    const stamp = this.dependencies.clock.now();
    return this.dependencies.repository.commitQuizAnswer({ ...turn, status: "answered", answerText: "[skipped]", answeredAt: stamp, assessment: "unreliable", assessmentRationale: "用户跳过本题，未形成可判断的作答证据。", updatedAt: stamp }, {
      id: this.dependencies.ids.next(), taskId: task.id, turnId: turn.id, decisionBlockId: task.decisionBlockId, recordId: task.recordId, contentVersion: task.contentVersion,
      kind: "answer-assessment", answerAssessment: "unreliable", reason: "skipped", occurredAt: stamp,
      idempotencyKey: `answer-skipped:${operationId}`, createdAt: stamp, updatedAt: stamp,
    });
  }

  async reportInvalidQuestion(turnId: string, reason: string, operationId: string): Promise<AdaptiveReviewTask> {
    const snapshot = await this.dependencies.repository.getFormalSnapshot();
    const turn = snapshot.adaptiveQuizTurns.find((item) => item.id === turnId && item.status !== "invalid");
    const task = turn ? snapshot.adaptiveReviewTasks.find((item) => item.id === turn.taskId) : undefined;
    if (!turn || !task) throw new Error("题目或任务不存在。");
    const stamp = this.dependencies.clock.now();
    const result = await this.dependencies.repository.invalidateQuizTurn(turn.id, {
      id: this.dependencies.ids.next(), taskId: task.id, turnId: turn.id, decisionBlockId: task.decisionBlockId, recordId: task.recordId, contentVersion: task.contentVersion,
      kind: "task-disposition", disposition: "question-invalid", reason: reason.trim() || "用户报告题目有问题", occurredAt: stamp,
      idempotencyKey: `question-invalid:${operationId}`, createdAt: stamp, updatedAt: stamp,
    }, stamp);
    await this.selectNextTask();
    return result;
  }

  async finishQuizTask(input: { taskId: string; outcome: SubjectiveOutcome; reason?: string; confirmedConflict?: boolean; operationId: string }): Promise<AdaptiveReviewTask> {
    const snapshot = await this.dependencies.repository.getFormalSnapshot();
    const task = snapshot.adaptiveReviewTasks.find((item) => item.id === input.taskId && item.status === "in-progress");
    const answers = task ? snapshot.adaptiveQuizTurns.filter((item) => item.taskId === task.id && item.status === "answered" && item.answerText !== "[skipped]").sort((a, b) => a.sequence - b.sequence) : [];
    if (!task || answers.length === 0) throw new Error("至少完成一轮有效作答后才能提交结果。");
    const lastAnswer = answers.at(-1)!;
    if (input.outcome === "mastered" && lastAnswer.assessment === "incorrect" && !input.confirmedConflict) throw new Error("最后一轮回答仍有明显错误；确认后才能保留“已掌握”自评。");
    if (input.outcome === "not-mastered" && !input.reason?.trim()) throw new Error("请说明仍未掌握的具体原因，以便重新规划。");
    const stamp = this.dependencies.clock.now();
    const selfAssessment: TaskOutcomeEvent = { id: this.dependencies.ids.next(), taskId: task.id, decisionBlockId: task.decisionBlockId, recordId: task.recordId, contentVersion: task.contentVersion, kind: "self-assessment", subjectiveOutcome: input.outcome, reason: input.reason?.trim(), confirmedConflict: input.confirmedConflict, occurredAt: stamp, idempotencyKey: `self-assessment:${input.operationId}`, createdAt: stamp, updatedAt: stamp };
    const events: TaskOutcomeEvent[] = [
      selfAssessment,
      { id: this.dependencies.ids.next(), taskId: task.id, decisionBlockId: task.decisionBlockId, recordId: task.recordId, contentVersion: task.contentVersion, kind: "task-disposition", disposition: "completed", occurredAt: stamp, idempotencyKey: `task-completed:${input.operationId}`, createdAt: stamp, updatedAt: stamp },
    ];
    const status = input.outcome === "not-mastered" ? "not-achieved" : "completed";
    const verificationSchedule = input.outcome === "not-mastered" ? undefined : calculateDelayedVerificationSchedule({
      completedAt: stamp,
      subjectiveOutcome: input.outcome,
      answeredTurns: answers,
      priorVerifications: snapshot.delayedVerifications.filter((item) => item.decisionBlockId === task.decisionBlockId && item.contentVersion === task.contentVersion),
    });
    const verification = verificationSchedule ? {
      id: this.dependencies.ids.next(), sourceOutcomeEventId: selfAssessment.id, decisionBlockId: task.decisionBlockId, recordId: task.recordId, contentVersion: task.contentVersion,
      status: "scheduled" as const, ...verificationSchedule, idempotencyKey: `verification:${selfAssessment.id}`, createdAt: stamp, updatedAt: stamp,
    } : undefined;
    const result = await this.dependencies.repository.commitTaskOutcome(task.id, events, status, stamp, undefined, verification);
    if (input.outcome === "not-mastered") {
      await this.recordFeedback({ decisionBlockId: task.decisionBlockId, recordId: task.recordId, contentVersion: task.contentVersion, comment: input.reason!, includeInAnalysis: true, source: "manual", operationId: `replan:${input.operationId}` });
    }
    await this.selectNextTask();
    return result;
  }

  async completeDelayedVerification(input: { taskId: string; outcome: "retained" | "decayed"; confirmedConflict?: boolean; operationId: string }): Promise<AdaptiveReviewTask> {
    const snapshot = await this.dependencies.repository.getFormalSnapshot();
    const task = snapshot.adaptiveReviewTasks.find((item) => item.id === input.taskId && item.status === "in-progress");
    const verification = task ? snapshot.delayedVerifications.find((item) => item.taskId === task.id && item.status === "in-progress") : undefined;
    const answers = task ? snapshot.adaptiveQuizTurns.filter((item) => item.taskId === task.id && item.status === "answered" && item.answerText !== "[skipped]").sort((a, b) => a.sequence - b.sequence) : [];
    if (!task || !verification || answers.length === 0) throw new Error("至少完成一轮有效验证后才能提交结果。");
    const lastAnswer = answers.at(-1)!;
    if (input.outcome === "retained" && lastAnswer.assessment === "incorrect" && !input.confirmedConflict) {
      throw new Error("最后一轮验证回答仍有明显错误；确认后才能保留“仍然掌握”。");
    }
    const stamp = this.dependencies.clock.now();
    const subjectiveOutcome = input.outcome === "retained" ? "mastered" as const : "not-mastered" as const;
    const events: TaskOutcomeEvent[] = [
      { id: this.dependencies.ids.next(), taskId: task.id, decisionBlockId: task.decisionBlockId, recordId: task.recordId, contentVersion: task.contentVersion, kind: "self-assessment", subjectiveOutcome, reason: input.outcome === "decayed" ? "延迟验证出现衰退" : undefined, confirmedConflict: input.confirmedConflict, occurredAt: stamp, idempotencyKey: `verification-self-assessment:${input.operationId}`, createdAt: stamp, updatedAt: stamp },
      { id: this.dependencies.ids.next(), taskId: task.id, decisionBlockId: task.decisionBlockId, recordId: task.recordId, contentVersion: task.contentVersion, kind: "task-disposition", disposition: "completed", occurredAt: stamp, idempotencyKey: `verification-completed:${input.operationId}`, createdAt: stamp, updatedAt: stamp },
    ];
    const result = await this.dependencies.repository.completeVerification(task.id, events, input.outcome, stamp);
    await this.selectNextTask();
    return result;
  }

  async abandonQuizTask(taskId: string, reason: string, operationId: string): Promise<AdaptiveReviewTask> {
    const snapshot = await this.dependencies.repository.getFormalSnapshot();
    const task = snapshot.adaptiveReviewTasks.find((item) => item.id === taskId && ["current", "in-progress"].includes(item.status));
    if (!task) throw new Error("当前任务不存在。");
    const stamp = this.dependencies.clock.now();
    const result = await this.dependencies.repository.commitTaskOutcome(task.id, [{
      id: this.dependencies.ids.next(), taskId: task.id, decisionBlockId: task.decisionBlockId, recordId: task.recordId, contentVersion: task.contentVersion,
      kind: "task-disposition", disposition: "abandoned", reason: reason.trim() || "用户退出任务", occurredAt: stamp,
      idempotencyKey: `task-abandoned:${operationId}`, createdAt: stamp, updatedAt: stamp,
    }], "abandoned", stamp);
    await this.selectNextTask();
    return result;
  }

  async selectNextTask(): Promise<AdaptiveReviewTask | undefined> {
    await this.refreshDueVerifications();
    const snapshot = await this.dependencies.repository.getFormalSnapshot();
    const current = snapshot.adaptiveReviewTasks.find((task) => task.status === "current" || task.status === "in-progress");
    if (current) return current;
    const ranked = rankWaitingTasks(snapshot.adaptiveReviewTasks, this.dependencies.clock.now());
    const recentTerminal = snapshot.adaptiveReviewTasks
      .filter((task) => task.endedAt && ["completed", "not-achieved", "invalid", "abandoned"].includes(task.status))
      .sort((left, right) => right.endedAt!.localeCompare(left.endedAt!));
    const consecutiveVerificationTasks = recentTerminal.findIndex((task) => task.priorityTier !== "due-verification");
    const verificationStreak = consecutiveVerificationTasks === -1 ? recentTerminal.length : consecutiveVerificationTasks;
    const next = verificationStreak >= 2 ? ranked.find((task) => task.priorityTier !== "due-verification") ?? ranked[0] : ranked[0];
    if (!next) return undefined;
    return this.dependencies.repository.transitionTask(next.id, "current", this.dependencies.clock.now());
  }

  async refreshDueVerifications(): Promise<number> {
    const now = this.dependencies.clock.now();
    let snapshot = await this.dependencies.repository.getFormalSnapshot();
    for (const verification of snapshot.delayedVerifications.filter((item) => isVerificationEligible(item, now))) {
      await this.dependencies.repository.transitionVerification(verification.id, "eligible", now);
    }
    snapshot = await this.dependencies.repository.getFormalSnapshot();
    const openTargets = new Set(snapshot.adaptiveReviewTasks
      .filter((task) => ["waiting", "current", "in-progress", "deferred"].includes(task.status))
      .map((task) => `${task.decisionBlockId}:${task.contentVersion}`));
    let queued = 0;
    for (const verification of snapshot.delayedVerifications.filter((item) => !item.taskId && isVerificationDue(item, now)).sort((a, b) => a.verificationDueAt.localeCompare(b.verificationDueAt))) {
      const targetKey = `${verification.decisionBlockId}:${verification.contentVersion}`;
      if (openTargets.has(targetKey)) continue;
      const source = snapshot.taskOutcomeEvents.find((item) => item.id === verification.sourceOutcomeEventId);
      const sourceTask = source ? snapshot.adaptiveReviewTasks.find((item) => item.id === source.taskId) : undefined;
      if (!sourceTask) continue;
      await this.dependencies.repository.queueVerification(verification.id, {
        id: `verification-task:${verification.id}`, blueprintId: sourceTask.blueprintId, decisionBlockId: verification.decisionBlockId, recordId: verification.recordId, contentVersion: verification.contentVersion,
        status: "waiting", priorityTier: "due-verification", queuedAt: verification.verificationDueAt, idempotencyKey: `verification-task:${verification.id}`, createdAt: verification.verificationDueAt, updatedAt: now,
      }, now);
      openTargets.add(targetKey);
      queued += 1;
    }
    return queued;
  }
}
