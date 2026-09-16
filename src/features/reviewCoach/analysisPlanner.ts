import type { AiProviderProfile, Asset, RecordBlock, RecordReviewLog } from "../../types";
import { buildDecisionBlockAiContextPack, estimateAiTokens, hashAiContext } from "../../services/aiContextService";
import type { AnalysisInputRef, FeedbackInterpretation, ReviewCoachFormalSnapshot } from "./domain";

export interface AnalysisPlanningFeedback {
  id: string;
  comment: string;
  occurredAt: string;
  analysisNote?: string;
  interpretation?: FeedbackInterpretation;
}

export interface AnalysisPlanningBlock {
  decisionBlockId: string;
  recordId: string;
  contentVersion: number;
  recordTitle: string;
  subject: string;
  lastReviewedAt?: string;
  contextMarkdown: string;
  excerptHash: string;
  missingOcrAssetIds: string[];
  inputRefs: AnalysisInputRef[];
  feedback: AnalysisPlanningFeedback[];
  estimatedTokens: number;
}

export interface PlannedAnalysisSubBatch {
  blocks: AnalysisPlanningBlock[];
  estimatedTokens: number;
}

export interface AnalysisBatchPlan {
  subBatches: PlannedAnalysisSubBatch[];
  oversized: AnalysisPlanningBlock[];
  estimatedTokens: number;
  inputFingerprint: string;
  maxInputTokens: number;
}

const PLANNER_PROMPT_OVERHEAD_TOKENS = 700;
const PLANNER_OUTPUT_RESERVE_TOKENS = 6_000;
const PLANNER_SAFETY_RESERVE_TOKENS = 2_000;

export const maxAnalysisInputTokensForProvider = (provider: AiProviderProfile): number =>
  Math.max(1_000, (provider.contextWindowTokens ?? 65_536) - Math.min(provider.maxTokens, PLANNER_OUTPUT_RESERVE_TOKENS) - PLANNER_SAFETY_RESERVE_TOKENS);

export const buildAnalysisPlanningBlocks = (input: {
  snapshot: ReviewCoachFormalSnapshot;
  records: readonly RecordBlock[];
  assets: readonly Asset[];
  reviewLogs?: readonly RecordReviewLog[];
  includeQueueItemIds?: ReadonlySet<string>;
}): AnalysisPlanningBlock[] => {
  const records = new Map(input.records.filter((item) => !item.deletedAt).map((item) => [item.id, item]));
  const feedbackById = new Map(input.snapshot.decisionBlockFeedback.filter((item) => !item.deletedAt).map((item) => [item.id, item]));
  const interpretationByFeedbackId = new Map(input.snapshot.feedbackInterpretations.filter((item) => !item.deletedAt).map((item) => [item.feedbackId, item]));
  const logsByRecord = new Map<string, RecordReviewLog[]>();
  for (const log of input.reviewLogs ?? []) {
    const current = logsByRecord.get(log.recordId) ?? [];
    current.push(log);
    logsByRecord.set(log.recordId, current);
  }
  const queueByBlock = new Map<string, typeof input.snapshot.analysisQueueItems>();
  for (const queueItem of input.snapshot.analysisQueueItems.filter((item) =>
    !item.deletedAt && (item.status === "eligible" || Boolean(input.includeQueueItemIds?.has(item.id))))) {
    const current = queueByBlock.get(queueItem.decisionBlockId) ?? [];
    current.push(queueItem);
    queueByBlock.set(queueItem.decisionBlockId, current);
  }

  const result: AnalysisPlanningBlock[] = [];
  for (const [decisionBlockId, queueItems] of queueByBlock) {
    const block = input.snapshot.decisionBlocks.find((item) => item.id === decisionBlockId && !item.deletedAt);
    if (!block || queueItems.some((item) => item.contentVersion !== block.contentVersion)) continue;
    const record = records.get(block.recordId);
    if (!record) continue;
    let context;
    try {
      context = buildDecisionBlockAiContextPack(record, decisionBlockId, [...input.assets]);
    } catch {
      continue;
    }
    const feedback = queueItems
      .map((queueItem) => ({ queueItem, source: feedbackById.get(queueItem.feedbackId) }))
      .filter((item): item is typeof item & { source: NonNullable<typeof item.source> } => Boolean(item.source))
      .sort((left, right) => left.source.occurredAt.localeCompare(right.source.occurredAt))
      .map(({ queueItem, source }) => ({
        id: source.id,
        comment: source.comment,
        occurredAt: source.occurredAt,
        analysisNote: queueItem.analysisNote,
        interpretation: interpretationByFeedbackId.get(source.id),
      }));
    if (feedback.length === 0) continue;
    const inputRefs = queueItems.map((queueItem): AnalysisInputRef => ({
      queueItemId: queueItem.id,
      feedbackId: queueItem.feedbackId,
      interpretationId: interpretationByFeedbackId.get(queueItem.feedbackId)?.id,
      decisionBlockId,
      recordId: block.recordId,
      contentVersion: block.contentVersion,
    }));
    const contextMarkdown = context.markdown;
    const estimatePayload = JSON.stringify({ contextMarkdown, feedback });
    const recordLogs = logsByRecord.get(record.id) ?? [];
    result.push({
      decisionBlockId,
      recordId: block.recordId,
      contentVersion: block.contentVersion,
      recordTitle: record.title,
      subject: record.subject,
      lastReviewedAt: [...recordLogs].sort((left, right) => right.reviewedAt.localeCompare(left.reviewedAt))[0]?.reviewedAt,
      contextMarkdown,
      excerptHash: hashAiContext(contextMarkdown),
      missingOcrAssetIds: context.missingOcrAssetIds,
      inputRefs,
      feedback,
      estimatedTokens: estimateAiTokens(estimatePayload) + PLANNER_PROMPT_OVERHEAD_TOKENS,
    });
  }
  return result.sort((left, right) =>
    left.feedback.at(-1)!.occurredAt.localeCompare(right.feedback.at(-1)!.occurredAt) || left.decisionBlockId.localeCompare(right.decisionBlockId));
};

/**
 * Plans analysis sub-batches.
 *
 * The fingerprint deliberately covers only the decision-block inputs. It used to
 * also fold in `InterventionEffectSummary` rows, which meant the "objective"
 * strategy-effect table silently shaped which evidence a batch was planned
 * against (dev plan section 1.5). Those rows are AI-evaluation statistics, not
 * objective evidence, so they no longer enter planning at all.
 */
export const planAnalysisBatches = (
  blocks: readonly AnalysisPlanningBlock[],
  maxInputTokens: number,
): AnalysisBatchPlan => {
  const oversized = blocks.filter((item) => item.estimatedTokens > maxInputTokens);
  const eligible = blocks.filter((item) => item.estimatedTokens <= maxInputTokens);
  const subBatches: PlannedAnalysisSubBatch[] = [];
  for (const block of eligible) {
    const current = subBatches.at(-1);
    if (!current || current.blocks.length >= 3 || current.estimatedTokens + block.estimatedTokens > maxInputTokens) {
      subBatches.push({ blocks: [block], estimatedTokens: block.estimatedTokens });
    } else {
      current.blocks.push(block);
      current.estimatedTokens += block.estimatedTokens;
    }
  }
  return {
    subBatches,
    oversized,
    estimatedTokens: eligible.reduce((total, item) => total + item.estimatedTokens, 0),
    inputFingerprint: hashAiContext(JSON.stringify({
      blocks: eligible.map((item) => ({
        decisionBlockId: item.decisionBlockId,
        contentVersion: item.contentVersion,
        inputRefs: item.inputRefs,
        excerptHash: item.excerptHash,
      })),
    })),
    maxInputTokens,
  };
};
