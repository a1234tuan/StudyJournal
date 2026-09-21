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
  DelayedVerification,
  FeedbackInterpretation,
  FeedbackInterpretationStatus,
  InterventionPath,
  SessionBlueprint,
  SubjectiveOutcome,
  TaskOutcomeEvent,
  TaskPriorityTier,
} from "./domain";
import { AiRequestError } from "../../services/aiClientService";
import { waitAiRetry } from "../../services/aiRetry";
import { analysisFailureCode } from "./analysisErrors";
import {
  calculateClosedLoopVerificationSchedule,
  calculateDelayedVerificationSchedule,
  isVerificationDue,
  isVerificationEligible,
  isVerificationRecheckDue,
} from "./verificationPolicy";
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
import { assertNoAnswerLeakage } from "./questionIntegrity";
import {
  BUDGET_EXHAUSTED_REASON,
  CLOSED_LOOP_V2_LOOP_VERSION,
  TIME_BOX_EXHAUSTED_REASON,
  TURN_BUDGET_POLICY_VERSION,
  isTimeBoxExhausted,
  normalizeTurnBudgetForV2,
} from "./learningLoopPolicy";
import { isReviewCoachV2Enabled } from "./releaseGate";
import {
  effectiveTurns,
  isLoopClosed,
  loopClosureEvidence,
  verificationEvidenceStatusFor,
} from "./evidencePolicy";
import {
  interventionDirectiveFor,
  resolveInterventionChoice,
  type InterventionChoiceResolution,
} from "./interventionPolicy";
import { checkVariantEligibility, normalizeQuestion, targetFormStatusFor } from "./variantPolicy";
import type { AiChatAttachment } from "../../types";

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

/**
 * Raised when the display budget runs out before the loop closed.
 *
 * Distinct from a genuine failure: the caller is expected to call
 * `deferAndRequeueV2Attempt` rather than surface an error or invent a result.
 */
export class ReviewCoachBudgetExhaustedError extends Error {
  constructor(readonly reason: string, message: string) {
    super(message);
    this.name = "ReviewCoachBudgetExhaustedError";
  }
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

const MAX_HISTORY_ANSWER_CHARS = 2_000;
const MAX_HISTORY_RATIONALE_CHARS = 1_000;

const truncateHistoryText = (value: string | undefined, maxChars: number) => {
  if (!value) return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  return trimmed.length <= maxChars ? trimmed : trimmed.slice(0, maxChars) + "…[已截断]";
};

/**
 * C-3 (F-06): marks a per-turn assessment as "the model could not judge this answer".
 *
 * `unreliable` mixes "the model could not judge" with "the user skipped the turn"
 * (`skipQuizTurn` writes `reason: "skipped"`), and treating either as a wrong answer would
 * penalise the user for the model's limits. The prefix keeps the not-assessable case explicit in
 * the existing, synchronised `TaskOutcomeEvent.reason` field — no schema change — so "could not
 * judge" can never again be confused with "nothing judged this turn".
 */
export const UNRELIABLE_ASSESSMENT_REASON_PREFIX = "unreliable:";

export interface SubmitQuizAnswerInput {
  turnId: string;
  answerText: string;
  /** Full decision-block material. Required so the evaluator can contradict a wrong criterion
   *  produced by the question generator (the criteria alone are not self-validating). */
  decisionBlockContent: string;
  provider: string;
  model: string;
  promptVersion: string;
  policyVersion: string;
  operationId: string;
  signal?: AbortSignal;
  imageInputMode?: "vision" | "local-ocr";
  imageAttachments?: AiChatAttachment[];
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
    // C-5 (F-19): `allowCrossBlockSupport` used to only gate `supportingDecisionBlockIds`, while
    // feedback / interpretation / evidence references were validated against the *whole* sub-batch
    // union and only had to hit "at least one" main-block feedback. So a candidate could anchor
    // itself in another block's evidence even with support disabled. The allowed sets now differ
    // per mode, and every reference must be inside them.
    const allowedFeedback = allowCrossBlockSupport ? suppliedFeedback : mainFeedback;
    const allowedInterpretations = allowCrossBlockSupport
      ? suppliedInterpretations
      : new Set(main.feedback.map((item) => item.interpretation?.id).filter((id): id is string => Boolean(id)));
    if (candidate.feedbackIds.length === 0 || candidate.feedbackIds.some((id) => !allowedFeedback.has(id))) {
      throw new Error("Blueprint feedback references are missing or outside the frozen input.");
    }
    if (candidate.interpretationIds.some((id) => !allowedInterpretations.has(id))) {
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
      if (!allowCrossBlockSupport && evidence.decisionBlockId !== main.decisionBlockId) {
        throw new Error("Blueprint evidence is outside its main decision block.");
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

/** Local, dependency-free time arithmetic for requeue windows. */
const addHoursIso = (stamp: string, hours: number): string =>
  new Date(Date.parse(stamp) + hours * 60 * 60 * 1000).toISOString();

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
        if (attempt > 0) await waitAiRetry(lastError, attempt, input.signal);
        if (input.signal?.aborted) throw new DOMException("AI request cancelled", "AbortError");
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
        if (input.signal?.aborted || (error instanceof DOMException && error.name === "AbortError")) {
          return this.dependencies.repository.saveFeedbackInterpretation({
            ...interpretation,
            status: "pending",
            attemptCount: attempt,
            updatedAt: this.dependencies.clock.now(),
            errorCode: undefined,
          });
        }
        lastError = error;
        // A bad key, wrong Base URL or schema mismatch will fail identically on
        // every attempt; retrying only burns quota across the whole queue.
        if (!(error instanceof AiRequestError) || !error.retryable) break;
      }
    }
    const failed: FeedbackInterpretation = {
      ...interpretation,
      status: "failed" as FeedbackInterpretationStatus,
      attemptCount: maxRetries + 1,
      errorCode: analysisFailureCode(lastError),
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
    const existingSnapshot = await this.dependencies.repository.getFormalSnapshot();
    // Planning no longer consumes `InterventionEffectSummary`. Those rows were
    // named `objective*` but every one of them came from AI grading, so feeding
    // them to the planner laundered AI statistics into "measured strategy
    // effectiveness" (dev plan section 1.5). The table and its replay are kept
    // for compatibility and audit only; it no longer reaches a new blueprint.
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
          if (attempt > 0) await waitAiRetry(lastError, attempt, input.signal);
          if (input.signal?.aborted) throw new DOMException("AI request cancelled", "AbortError");
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
          if (call.response.status === "insufficient-context") throw new AiRequestError(`insufficient-context:${call.response.missingInformation.join("、")}`, false);
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
          if (input.signal?.aborted || (error instanceof DOMException && error.name === "AbortError")) {
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
          if (!(error instanceof AiRequestError) || !error.retryable) break;
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
            errorCode: analysisFailureCode(lastError),
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
        maxTurns: normalizeTurnBudgetForV2(candidate.maxTurns),
        maxRetriesPerTurn: candidate.maxRetriesPerTurn,
        maxEstimatedTokens: candidate.maxEstimatedTokens,
        provider: input.provider,
        model: input.model,
        promptVersion: input.promptVersion,
        policyVersion: input.policyVersion,
        schemaVersion: input.schemaVersion,
        idempotencyKey: `blueprint:${batch.id}:${block.decisionBlockId}:${block.contentVersion}`,
        // Only stamped when the v2 gate is open, so a plain development or
        // production build keeps producing v1 blueprints with their historical
        // turn budgets.
        ...(isReviewCoachV2Enabled() ? {
          loopVersion: CLOSED_LOOP_V2_LOOP_VERSION,
          turnBudgetPolicyVersion: TURN_BUDGET_POLICY_VERSION,
        } : {}),
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
        ...(blueprint.loopVersion ? { loopVersion: blueprint.loopVersion } : {}),
        createdAt: stamp,
        updatedAt: stamp,
      });
    return { blueprint, task };
  }

  acceptBlueprint(blueprint: SessionBlueprint) {
    return this.dependencies.repository.acceptBlueprint(blueprint);
  }

  async switchCurrentTask(taskId: string): Promise<AdaptiveReviewTask> {
    const snapshot = await this.dependencies.repository.getFormalSnapshot();
    const target = snapshot.adaptiveReviewTasks.find((item) => item.id === taskId && !item.deletedAt);
    const now = this.dependencies.clock.now();
    if (!target || !["waiting", "deferred", "current"].includes(target.status)) throw new Error("目标任务当前不可切换。");
    if (target.status === "deferred" && target.notBeforeAt && target.notBeforeAt > now) throw new Error("该任务尚未到提醒时间。");
    return this.dependencies.repository.switchCurrentTask(taskId, now);
  }

  async requeueDecayedBlock(input: { decisionBlockId: string; recordId: string; contentVersion: number }): Promise<AnalysisQueueItem> {
    const snapshot = await this.dependencies.repository.getFormalSnapshot();
    const feedback = snapshot.decisionBlockFeedback
      .filter((item) => item.decisionBlockId === input.decisionBlockId && item.recordId === input.recordId && item.contentVersion === input.contentVersion && item.includeInAnalysis && !item.deletedAt)
      .sort((left, right) => right.occurredAt.localeCompare(left.occurredAt))[0];
    if (!feedback) throw new Error("没有可复用的用户反馈，不能自动重新规划。");
    const queueItem = snapshot.analysisQueueItems.find((item) => item.feedbackId === feedback.id && !item.deletedAt);
    if (!queueItem) throw new Error("最近的用户反馈缺少分析队列记录，不能自动重新规划。");
    return this.dependencies.repository.requeueAnalysisQueueItem(queueItem.id, this.dependencies.clock.now());
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
    const turns = snapshot.adaptiveQuizTurns.filter((item) => item.taskId === task!.id && item.status !== "invalid" && !item.deletedAt).sort((a, b) => a.sequence - b.sequence);
    const active = turns.find((item) => item.status === "displayed");
    if (active) return active;
    if (turns.length >= blueprint.maxTurns) {
      // v1 treated the display budget as "you must submit a verdict now", which
      // is how a subjective outcome ended up deciding completion. v2 treats it
      // as a budget: the caller may still close the loop (the qualifying
      // retrievals may already be there), otherwise it defers and requeues.
      const isV2Task = task!.loopVersion === CLOSED_LOOP_V2_LOOP_VERSION;
      // Scoped to this task: whether the loop is closable is a property of this
      // task's own history, never of other tasks sharing the block.
      const alreadyClosable = isV2Task && isLoopClosed({ turns, events: snapshot.taskOutcomeEvents, taskId: task!.id });
      if (alreadyClosable) throw new Error("本次训练的提取次数已满足闭环条件，请提交本次结果。");
      throw new ReviewCoachBudgetExhaustedError(
        isV2Task ? BUDGET_EXHAUSTED_REASON : "turn-budget-exhausted",
        isV2Task
          ? "本次训练的显示轮次已用完，但闭环尚未闭合；可以延期重排，而不是由用户宣告结果。"
          : "本次训练已达到蓝图轮次上限，请提交本次结果。",
      );
    }
    const verification = snapshot.delayedVerifications.find((item) => item.taskId === task!.id && ["queued", "in-progress"].includes(item.status));
    const sourceOutcome = verification ? snapshot.taskOutcomeEvents.find((item) => item.id === verification.sourceOutcomeEventId) : undefined;
    const sourceTurns = sourceOutcome ? snapshot.adaptiveQuizTurns.filter((item) => item.taskId === sourceOutcome.taskId && item.status !== "invalid" && !item.deletedAt) : [];
    const previousTurns = verification ? [...sourceTurns, ...turns] : turns;
    const answerHistoryIds = new Set(previousTurns
      .filter((item) => item.status === "answered" && item.answerText && item.answerText !== "[skipped]")
      .slice(-3)
      .map((item) => item.id));
    const previous = turns.at(-1);
    const previousBranch = previous?.answerText === "[skipped]" ? "skipped" : previous?.assessment;
    const branch = previousBranch ? blueprint.branches.find((item) => item.when === previousBranch) : undefined;
    // M3: when the learner has chosen a next action, that action - not the
    // model-authored branch - decides how the next retrieval is framed. The
    // action itself always travels; the branch strategy is only the regime hint
    // the generator understands. Reading this from the task's own scoped events
    // keeps one task's choice from leaking into another's generation.
    const directive = interventionDirectiveFor(
      snapshot.taskOutcomeEvents.filter((event) => event.taskId === task.id),
    );
    const evidenceByKey = new Map(blueprint.evidence.map((item) => [`${item.decisionBlockId}:${item.recordId}:${item.contentVersion}:${item.excerptHash}`, item]));
    let lastQualityReason = "";
    for (let generationAttempt = 0; generationAttempt < 2; generationAttempt += 1) {
      const response = await this.dependencies.aiGateway.generateTurn({
        task: { id: task.id, decisionBlockId: task.decisionBlockId, recordId: task.recordId, contentVersion: task.contentVersion },
        blueprint,
        decisionBlockContent: input.decisionBlockContent,
      previousTurns: previousTurns.map((item) => ({
        sequence: item.sequence,
        practiceType: item.practiceType,
        question: item.question,
        assessment: item.assessment,
        hintsUsed: item.hintsUsed.length,
        answerText: answerHistoryIds.has(item.id) ? truncateHistoryText(item.answerText, MAX_HISTORY_ANSWER_CHARS) : undefined,
        assessmentRationale: answerHistoryIds.has(item.id) ? truncateHistoryText(item.assessmentRationale, MAX_HISTORY_RATIONALE_CHARS) : undefined,
      })),
        // F-07: `requestedStrategy` carries a *strategy* only. It used to fall back to
        // `blueprint.initialPracticeType`, so a practice type was sent through a strategy field and
        // the two concepts were indistinguishable in the payload. The first turn has no branch,
        // and the practice type already travels on `blueprint.initialPracticeType`.
        requestedStrategy: verification ? "continue" : (directive?.branchStrategy ?? branch?.nextStrategy),
        // The learner's chosen action, in the system-owned vocabulary. `rebuild`
        // means the next question must send them back to the material rather
        // than ask for another unaided attempt.
        interventionAction: verification ? undefined : directive?.action,
        interventionPath: verification ? undefined : directive?.path,
        verificationMode: verification ? { verificationId: verification.id, requireFreshRetrieval: true } : undefined,
        priorQualityFailure: lastQualityReason || undefined,
      }, input.signal);
      input.signal?.throwIfAborted();
      if (response.status === "insufficient-context") throw new Error(`生成题目所需背景不足：${response.missingInformation.join("、")}`);
      // C-4 (F-20): local, deterministic leak check, run before the paid quality review. A leak is
      // handled exactly like a quality failure — one regeneration, then a readable error — so it
      // never adds a provider call. Open questions, which get no AI review at all, are covered here.
      try {
        assertNoAnswerLeakage({ question: response.question, hints: response.hints, answerCriteria: response.answerCriteria });
      } catch (error) {
        lastQualityReason = error instanceof Error ? error.message : "题面或提示泄露了答案判据";
        continue;
      }
      if (response.sourceEvidence.some((item) => !evidenceByKey.has(`${item.decisionBlockId}:${item.recordId}:${item.contentVersion}:${item.excerptHash}`))) {
        throw new Error("题目引用了蓝图之外的来源。");
      }
      if (verification) {
        // A delayed verification is only worth asking if the learner has not
        // just seen it. The old check compared trimmed strings, which let a
        // reordered or lightly reworded copy through; this compares normalised
        // n-gram overlap and is conservative on purpose (M4).
        const variant = checkVariantEligibility(response, previousTurns);
        if (variant.eligibility === "duplicate") {
          lastQualityReason = `延迟验证题与历史题目重复（${variant.reason ?? "near-repeat"}）`;
          continue;
        }
        if (variant.eligibility !== "eligible") {
          lastQualityReason = `延迟验证题不构成未见变式（${variant.reason ?? variant.eligibility}）`;
          continue;
        }
      }
      // Every generated question gets the paid review, including open ones.
      //
      // The old gate (`calculation` practice type, or a non-open answer mode)
      // exempted open questions entirely, and open questions are exactly the
      // ones a delayed verification uses. Those verifications then rested on a
      // question that no reviewer had ever seen - the one place where the
      // evidence matters most. The local leak check above still runs first, so
      // a leak is caught without spending a provider call.
      const quality = await this.dependencies.aiGateway.reviewQuestion(
        { blueprint, candidate: response, decisionBlockContent: input.decisionBlockContent },
        input.signal,
      );
      input.signal?.throwIfAborted();
      if (quality.status === "insufficient-context") throw new AiRequestError("题目质检背景不足。", false);
      if (quality.verdict === "fail") {
        lastQualityReason = quality.rationale;
        continue;
      }
      const stamp = this.dependencies.clock.now();
      // v2 stamps the retrieval phase, the independence status and - crucially -
      // which mechanism actually produced the judgment. Every answer today is
      // graded by the model against model-authored criteria, so the honest
      // record is `ai-evaluation` + `ai-generated`, which caps authority at
      // provisional and can never produce an objective pass.
      const v2 = task!.loopVersion === CLOSED_LOOP_V2_LOOP_VERSION;
      // Scoped to this task and to the turns already passed in: the phase of the
      // turn about to be written depends only on how many qualifying retrievals
      // *this* task has, not on the rest of the block.
      const effective = v2 ? effectiveTurns({ turns, events: snapshot.taskOutcomeEvents, taskId: task!.id }) : [];
      const priorQualifying = effective.filter((item) => item.status === "answered");
      const phase = v2
        ? (priorQualifying.length === 0 ? "initial" as const : "post-judgment" as const)
        : undefined;
      /**
       * A delayed verification's first turn is `delayed-first`; a later one is
       * `delayed-remediation`.
       *
       * The old code stamped every verification turn `delayed-first`, so a
       * remediation attempt looked like another first attempt. That matters
       * because `lockedVerificationTurn` reads `delayed-first` as *the* result -
       * a remediation turn recorded under that phase could be mistaken for one.
       * Only the first turn of the verification is the locked attempt.
       */
      const verificationPhase = !verification
        ? undefined
        : turns.some((item) => item.phase === "delayed-first" && item.status !== "invalid")
          ? "delayed-remediation" as const
          : "delayed-first" as const;
      // The variant verdict is recomputed against the turn we are about to
      // write, so the stored record says what it was checked against rather
      // than only that some check passed.
      const variantVerdict = v2 && verification
        ? checkVariantEligibility(response, previousTurns)
        : undefined;
      return this.dependencies.repository.addQuizTurn({
        id: this.dependencies.ids.next(),
        taskId: task!.id,
        decisionBlockId: task!.decisionBlockId,
        recordId: task!.recordId,
        contentVersion: task!.contentVersion,
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
        qualityChecked: true,
        qualityModel: input.model,
        generationModel: input.model,
        promptVersion: input.promptVersion,
        policyVersion: input.policyVersion,
        idempotencyKey: `quiz-turn:${input.operationId}:${turns.length + 1}`,
        ...(v2 ? {
          phase: verificationPhase ?? phase,
          independenceStatus: "independent" as const,
          variantEligibility: variantVerdict?.eligibility ?? "eligible" as const,
          variantIneligibility: variantVerdict?.reason ? [variantVerdict.reason] : undefined,
          // Derived, not assumed. Stamping every turn `target-form` claimed the
          // question asked for the target form before anyone checked - so a
          // question that drifted to another form still counted as on-target
          // verification evidence.
          targetFormStatus: targetFormStatusFor(response, blueprint),
          judgmentMechanism: "ai-evaluation" as const,
          referenceOrigin: "ai-generated" as const,
          questionFingerprint: normalizeQuestion(response.question),
        } : {}),
        createdAt: stamp,
        updatedAt: stamp,
      }, input.signal);
    }
    throw new Error(`题目质检连续失败，已停止生成。${lastQualityReason ? ` ${lastQualityReason}` : ""}`);
  }

  recordQuizHint(turnId: string, level: number) {
    return this.dependencies.repository.recordQuizHint(turnId, level, this.dependencies.clock.now());
  }

  /**
   * Records the learner's chosen next action for a v2 target.
   *
   * This is the M3 entry point. It takes an *action* - "I could not form it",
   * "I mixed it up", "I could have but did not produce it" - and never a
   * diagnosis, a cause, a mastery level or a prerequisite claim. The system
   * owns the mapping from action to next retrieval strategy, and it owns the
   * anti-self-esteem downgrade.
   *
   * The event deliberately carries no result category: choosing what to do next
   * is not evidence about whether the previous attempt was correct.
   */
  async selectInterventionPath(input: {
    taskId: string;
    path: InterventionPath;
    operationId: string;
    /** The turn whose feedback prompted the choice, when there is one. */
    turnId?: string;
  }): Promise<InterventionChoiceResolution> {
    const snapshot = await this.dependencies.repository.getFormalSnapshot();
    const task = snapshot.adaptiveReviewTasks.find((item) => item.id === input.taskId && !item.deletedAt);
    if (!task) throw new Error(`Task ${input.taskId} does not exist.`);
    if (task.loopVersion !== CLOSED_LOOP_V2_LOOP_VERSION) {
      throw new Error("selectInterventionPath 只适用于 closed-loop-v2 任务。");
    }
    if (task.status !== "in-progress") throw new Error("当前复盘任务已经结束，无法选择下一步。");

    // Scoped to this task: the anti-self-esteem streak belongs to one target's
    // history. Pooling it let another task's choice reset a real streak, and let
    // another task's streak force the material-backed path on a fresh task.
    const resolution = resolveInterventionChoice(input.path, snapshot.taskOutcomeEvents.filter((event) => event.taskId === task.id));
    const stamp = this.dependencies.clock.now();
    await this.dependencies.repository.addOutcome({
      id: this.dependencies.ids.next(),
      taskId: task.id,
      turnId: input.turnId,
      decisionBlockId: task.decisionBlockId,
      recordId: task.recordId,
      contentVersion: task.contentVersion,
      kind: "intervention-selected",
      interventionPath: resolution.path,
      // The downgrade is explained in the record, so a later reader can tell a
      // chosen path from an enforced one without inferring it from the count.
      reason: resolution.downgraded
        ? `连续 ${resolution.consecutiveExecutionFailed} 次选择“会但没写出来”，系统改为回到材料重建。`
        : undefined,
      occurredAt: stamp,
      idempotencyKey: `intervention:${input.operationId}`,
      createdAt: stamp,
      updatedAt: stamp,
    });
    return resolution;
  }

  async submitQuizAnswer(input: SubmitQuizAnswerInput): Promise<AdaptiveQuizTurn> {
    if (!this.dependencies.aiGateway) throw new Error("Review coach AI gateway is not configured.");
    const typedAnswer = input.answerText.trim();
    const hasImageAnswer = (input.imageAttachments?.length ?? 0) > 0;
    if (!typedAnswer && !hasImageAnswer) throw new Error("请先填写文字回答或添加图片。");
    // Keep the formal turn non-empty when the learner answers entirely with a
    // handwritten/photo attachment. The actual image is sent only to the AI
    // evaluator and never persisted in the learning fact.
    const answerText = typedAnswer || "（图片作答，见本轮附件）";
    const snapshot = await this.dependencies.repository.getFormalSnapshot();
    const turn = snapshot.adaptiveQuizTurns.find((item) => item.id === input.turnId && item.status === "displayed");
    const task = turn ? snapshot.adaptiveReviewTasks.find((item) => item.id === turn.taskId && item.status === "in-progress") : undefined;
    const blueprint = task ? snapshot.sessionBlueprints.find((item) => item.id === task.blueprintId && item.status === "accepted") : undefined;
    if (!turn || !task || !blueprint) throw new Error("当前题目已经失效或不再进行中。");
    const evaluation = await this.dependencies.aiGateway.evaluateAnswer({
      blueprint,
      decisionBlockContent: input.decisionBlockContent,
      question: turn.question,
      answerCriteria: turn.answerCriteria,
      answerText,
      hintsUsed: turn.hintsUsed,
      imageInputMode: input.imageInputMode,
      imageAttachments: input.imageAttachments,
    }, input.signal);
    input.signal?.throwIfAborted();
    if (evaluation.status === "insufficient-context") throw new Error(`无法可靠判断回答：${evaluation.missingInformation.join("、")}`);
    const criteria = new Set(turn.answerCriteria);
    if ([...evaluation.matchedCriteria, ...evaluation.missingCriteria].some((item) => !criteria.has(item))) throw new Error("回答判定引用了题目之外的判据。");
    const stamp = this.dependencies.clock.now();
    const answered: AdaptiveQuizTurn = { ...turn, status: "answered", answerText, answeredAt: stamp, assessment: evaluation.assessment, assessmentRationale: evaluation.rationale, updatedAt: stamp };
    const outcome: TaskOutcomeEvent = {
      id: this.dependencies.ids.next(), taskId: task.id, turnId: turn.id, decisionBlockId: task.decisionBlockId, recordId: task.recordId, contentVersion: task.contentVersion,
      kind: "answer-assessment", answerAssessment: evaluation.assessment,
      // C-3 (F-06): "the model could not judge" and "nothing judged this turn" used to be
      // indistinguishable. The prefix makes the not-assessable case explicit in formal data without
      // touching the schema, and no strategy/difficulty/mastery decision is written for it.
      reason: evaluation.assessment === "unreliable" ? `${UNRELIABLE_ASSESSMENT_REASON_PREFIX}${evaluation.rationale}` : evaluation.rationale,
      occurredAt: stamp,
      idempotencyKey: `answer:${input.operationId}`, createdAt: stamp, updatedAt: stamp,
    };
    return this.dependencies.repository.commitQuizAnswer(answered, outcome, input.signal);
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

  /**
   * Closes a closed-loop-v2 task from the evidence it actually produced.
   *
   * The v1 `finishQuizTask` below takes a `SubjectiveOutcome` and a free-text
   * reason: the learner told the system whether they had mastered the material
   * and the system turned that into a terminal status, a plan and a schedule
   * (dev plan sections 1.1, 6.1 and 6.2). v2 inverts that. The caller supplies
   * only identity and idempotency; completion, status and scheduling are
   * *derived* from the qualifying retrievals on record.
   *
   * Preconditions, all derived and none accepted as arguments:
   *   - the task is `closed-loop-v2` and still `in-progress`;
   *   - there is a qualifying `initial` retrieval;
   *   - there is a qualifying `post-judgment` retrieval after it;
   *   - that post-judgment retrieval has not been superseded;
   *   - no terminal disposition has been written yet.
   *
   * There is deliberately no parameter for mastery, confidence, a reason or a
   * conflict flag. A learner who answered correctly on the first try still has
   * to answer again after seeing feedback, because recall after feedback is a
   * different retrieval from the one that preceded it.
   */
  async completeLearningLoop(taskId: string, operationId: string): Promise<AdaptiveReviewTask> {
    const snapshot = await this.dependencies.repository.getFormalSnapshot();
    const task = snapshot.adaptiveReviewTasks.find((item) => item.id === taskId && !item.deletedAt);
    if (!task) throw new Error(`Task ${taskId} does not exist.`);
    if (task.loopVersion !== CLOSED_LOOP_V2_LOOP_VERSION) {
      throw new Error("completeLearningLoop 只适用于 closed-loop-v2 任务；v1 历史请走 finishQuizTask。");
    }
    if (task.status !== "in-progress") throw new Error("当前复盘任务已经结束或尚未开始。");
    const terminal = snapshot.taskOutcomeEvents.some((event) => (
      event.taskId === task.id && event.kind === "task-disposition"
      && ["completed", "deferred", "abandoned"].includes(event.disposition ?? "")
    ));
    if (terminal) throw new Error("当前复盘任务已经写入终态。");

    // Scoped to this task. An unscoped query let another task's qualifying
    // post-judgment turn close *this* task's loop, which is exactly the kind of
    // accidental completion the constitution forbids.
    const query = {
      turns: snapshot.adaptiveQuizTurns.filter((turn) => turn.taskId === task.id),
      events: snapshot.taskOutcomeEvents.filter((event) => event.taskId === task.id),
      taskId: task.id,
    };
    const closure = loopClosureEvidence(query);
    if (!closure) {
      throw new Error("闭环尚未闭合：需要先完成反馈后的一次合格再提取。");
    }
    // The loop must never close on evidence that was already retired.
    const postJudgmentEvent = snapshot.taskOutcomeEvents.find((event) => (
      event.taskId === task.id && event.turnId === closure.postJudgment.id && event.kind === "answer-assessment"
    ));
    if (!postJudgmentEvent) throw new Error("闭环证据缺失：反馈后的再提取没有对应的判定事件。");

    const stamp = this.dependencies.clock.now();
    const answeredTurns = snapshot.adaptiveQuizTurns
      .filter((item) => item.taskId === task.id && item.status === "answered" && !item.deletedAt)
      .sort((left, right) => left.sequence - right.sequence);
    const schedule = calculateClosedLoopVerificationSchedule({
      completedAt: stamp,
      postJudgmentTurn: closure.postJudgment,
      answeredTurns,
      priorVerifications: snapshot.delayedVerifications.filter((item) => (
        item.decisionBlockId === task.decisionBlockId && item.contentVersion === task.contentVersion
      )),
    });
    const verification: DelayedVerification = {
      id: this.dependencies.ids.next(),
      // v2 points at the answer event that closed the loop, never at a
      // self-assessment. This is what `validateReviewCoachFormalSnapshot`
      // re-checks on load, and what makes "opened by an opinion" impossible.
      sourceOutcomeEventId: postJudgmentEvent.id,
      decisionBlockId: task.decisionBlockId,
      recordId: task.recordId,
      contentVersion: task.contentVersion,
      status: "scheduled",
      ...schedule,
      loopVersion: CLOSED_LOOP_V2_LOOP_VERSION,
      idempotencyKey: `verification:${postJudgmentEvent.id}`,
      createdAt: stamp,
      updatedAt: stamp,
    };
    const events: TaskOutcomeEvent[] = [{
      id: this.dependencies.ids.next(),
      taskId: task.id,
      decisionBlockId: task.decisionBlockId,
      recordId: task.recordId,
      contentVersion: task.contentVersion,
      kind: "task-disposition",
      disposition: "completed",
      occurredAt: stamp,
      idempotencyKey: `task-completed:${operationId}`,
      createdAt: stamp,
      updatedAt: stamp,
    }];
    const result = await this.dependencies.repository.commitTaskOutcome(task.id, events, "completed", stamp, undefined, verification);
    await this.selectNextTask();
    return result;
  }

  /**
   * Parks a v2 attempt that ran out of budget before it closed.
   *
   * Used when the display budget (`maxTurns`) or the five-minute time box ends
   * and fewer than two qualifying retrievals exist. It must not fabricate a
   * completion and must not silently drop the target:
   *
   *   - the exhausted task becomes `deferred` with the reason recorded, so the
   *     attempt keeps its audit trail instead of being rewritten;
   *   - the frozen blueprint is copied verbatim (same content, same evidence)
   *     so the next attempt is the *same* target rather than a re-plan;
   *   - the replacement is a `waiting` v2 task carrying `retryOfTaskId`, and
   *     exactly one open target key is restored for the decision block.
   *
   * Idempotent: replaying the same `operationId` finds the replacement through
   * `retryOfTaskId` instead of creating a second one, and `ensureIdempotentInsert`
   * plus the fixed idempotency keys make the replayed transaction a no-op.
   */
  async deferAndRequeueV2Attempt(input: {
    taskId: string;
    operationId: string;
    reason?: "budget-exhausted-before-closure" | "time-box-exhausted";
    notBeforeAt?: string;
  }): Promise<{ deferred: AdaptiveReviewTask; replacement: AdaptiveReviewTask }> {
    const snapshot = await this.dependencies.repository.getFormalSnapshot();
    const task = snapshot.adaptiveReviewTasks.find((item) => item.id === input.taskId && !item.deletedAt);
    if (!task) throw new Error(`Task ${input.taskId} does not exist.`);
    if (task.loopVersion !== CLOSED_LOOP_V2_LOOP_VERSION) {
      throw new Error("deferAndRequeueV2Attempt 只适用于 closed-loop-v2 任务。");
    }
    if (!["current", "in-progress"].includes(task.status)) throw new Error("只有进行中的 v2 任务可以延期重排。");
    // Scoped to this task: only this task's own history decides whether there is
    // anything left to defer.
    if (isLoopClosed({
      turns: snapshot.adaptiveQuizTurns.filter((turn) => turn.taskId === task.id),
      events: snapshot.taskOutcomeEvents.filter((event) => event.taskId === task.id),
      taskId: task.id,
    })) {
      throw new Error("闭环已经闭合，不应再延期；请改用 completeLearningLoop。");
    }
    const blueprint = snapshot.sessionBlueprints.find((item) => item.id === task.blueprintId && !item.deletedAt);
    if (!blueprint) throw new Error("复习蓝图缺失，无法重排。");

    const stamp = this.dependencies.clock.now();
    // The caller may name the budget it ran out of; when it does not, the
    // elapsed wall-clock decides between the two fixed reasons.
    const reason = input.reason
      ?? (isTimeBoxExhausted(task.startedAt, stamp) ? TIME_BOX_EXHAUSTED_REASON : BUDGET_EXHAUSTED_REASON);
    // Deferring and requeueing are one fact, not two. They run inside a single
    // repository transaction: if the replacement cannot be created, the deferral
    // is rolled back with it. Previously the second step could fail on its own
    // and leave a deferred task whose target nobody held any more.
    const { deferred, replacement } = await this.dependencies.repository.deferAndRequeue({
      deferredTaskId: task.id,
      deferredEvents: [{
        id: this.dependencies.ids.next(),
        taskId: task.id,
        decisionBlockId: task.decisionBlockId,
        recordId: task.recordId,
        contentVersion: task.contentVersion,
        kind: "task-disposition",
        disposition: "deferred",
        reason,
        occurredAt: stamp,
        idempotencyKey: `task-deferred:${input.operationId}`,
        createdAt: stamp,
        updatedAt: stamp,
      }],
      notBeforeAt: input.notBeforeAt ?? addHoursIso(stamp, 24),
      blueprint,
      reason,
      operationId: input.operationId,
      now: stamp,
    });
    await this.selectNextTask();
    return { deferred, replacement };
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

  /**
   * Closes a v2 delayed verification from the locked first attempt.
   *
   * No verdict argument, for the same reason `completeLearningLoop` takes none:
   * whether the learner "still remembers it" is what the retrieval is for. The
   * repository reads the locked turn, derives the evidence status from its
   * authority, and writes the outcome.
   */
  async completeV2DelayedVerification(taskId: string): Promise<AdaptiveReviewTask> {
    const result = await this.dependencies.repository.completeV2Verification(taskId, this.dependencies.clock.now());
    await this.selectNextTask();
    return result;
  }

  async completeDelayedVerification(input: { taskId: string; outcome: "retained" | "decayed"; confirmedConflict?: boolean; operationId: string }): Promise<AdaptiveReviewTask> {
    const snapshot = await this.dependencies.repository.getFormalSnapshot();
    const task = snapshot.adaptiveReviewTasks.find((item) => item.id === input.taskId && item.status === "in-progress");
    const verification = task ? snapshot.delayedVerifications.find((item) => item.taskId === task.id && item.status === "in-progress") : undefined;
    // A v2 verification is decided by its own locked attempt, never by the
    // learner's opinion. Routing it through the subjective v1 path would write a
    // self-assessment that the v2 contract forbids (and that `validation.ts`
    // rejects on load), so it is refused here rather than silently mis-recorded.
    if (verification?.loopVersion === CLOSED_LOOP_V2_LOOP_VERSION) {
      throw new Error("v2 延迟验证由作答证据决定结果，请走 completeV2DelayedVerification。");
    }
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
    // A verification that produced only provisional evidence is "completed" as an
    // action but settled nothing. Re-open it so the chain continues instead of
    // ending on a model's own judgment (dev plan section 6.3). Clearing the task
    // link is only half of it: it is the due-queueing pass below, which accepts
    // `isVerificationRecheckDue`, that actually puts the re-check back in line.
    let reopened = 0;
    for (const verification of snapshot.delayedVerifications.filter((item) => isVerificationRecheckDue(item, now))) {
      // Clear the stale link to the previous (completed) task so the due-queueing
      // pass below creates a fresh task instead of short-circuiting back to the
      // finished one. The verification keeps its `completed` status; the open
      // conclusion is what makes it due again.
      await this.dependencies.repository.detachVerificationTask(verification.id, now);
      reopened += 1;
    }
    if (reopened > 0) snapshot = await this.dependencies.repository.getFormalSnapshot();
    const openTargets = new Set(snapshot.adaptiveReviewTasks
      .filter((task) => ["waiting", "current", "in-progress", "deferred"].includes(task.status))
      .map((task) => `${task.decisionBlockId}:${task.contentVersion}`));
    let queued = 0;
    // Two ways a verification can be due. The ordinary one is an `eligible`/
    // `missed` verification that reached its original window. The other is a
    // re-check: a `completed` verification whose evidence never settled, so the
    // action finished but the conclusion did not. Both have to reach the queue,
    // and each is ordered by the window that actually made it due.
    const dueVerifications = snapshot.delayedVerifications
      .filter((item) => !item.taskId)
      .filter((item) => isVerificationDue(item, now) || isVerificationRecheckDue(item, now))
      .map((item) => ({ item, dueAt: isVerificationRecheckDue(item, now) ? item.nextVerificationDueAt! : item.verificationDueAt }))
      .sort((a, b) => a.dueAt.localeCompare(b.dueAt));
    for (const { item: verification, dueAt } of dueVerifications) {
      const targetKey = `${verification.decisionBlockId}:${verification.contentVersion}`;
      if (openTargets.has(targetKey)) continue;
      const source = snapshot.taskOutcomeEvents.find((item) => item.id === verification.sourceOutcomeEventId);
      const sourceTask = source ? snapshot.adaptiveReviewTasks.find((item) => item.id === source.taskId) : undefined;
      if (!sourceTask) continue;
      await this.dependencies.repository.queueVerification(verification.id, {
        id: `verification-task:${verification.id}`, blueprintId: sourceTask.blueprintId, decisionBlockId: verification.decisionBlockId, recordId: verification.recordId, contentVersion: verification.contentVersion,
        status: "waiting", priorityTier: "due-verification", queuedAt: dueAt, idempotencyKey: `verification-task:${verification.id}`, createdAt: dueAt, updatedAt: now,
        // Carried over from the verification. Without it the queued task looks
        // like a v1 attempt, so the page takes the v1 subjective-completion path
        // and `completeV2DelayedVerification` never gets a UI caller.
        loopVersion: verification.loopVersion,
      }, now);
      openTargets.add(targetKey);
      queued += 1;
    }
    return queued;
  }
}
