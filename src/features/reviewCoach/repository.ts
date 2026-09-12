import Dexie, { type Table } from "dexie";

import { db as defaultDatabase, type StudyJournalDatabase } from "../../db/database";
import type { RecordBlock } from "../../types";
import type {
  AdaptiveQuizTurn,
  AdaptiveQuizTurnStatus,
  AdaptiveReviewTask,
  AdaptiveReviewTaskStatus,
  AiRoleConfig,
  AnalysisBatch,
  AnalysisBatchStatus,
  AnalysisQueueItem,
  AnalysisQueueStatus,
  DecisionBlock,
  DecisionBlockArchive,
  DecisionBlockFeedback,
  DecisionBlockState,
  DelayedVerification,
  DelayedVerificationStatus,
  FeedbackInterpretation,
  FeedbackInterpretationStatus,
  InterventionEffectSummary,
  ReviewCoachFormalSnapshot,
  SessionBlueprint,
  TaskOutcomeEvent,
} from "./domain";
import { REVIEW_COACH_REPLAY_VERSION, replayAllDecisionBlockStates, replayInterventionEffectSummaries } from "./replay";
import {
  transitionAdaptiveQuizTurn,
  transitionAdaptiveReviewTask,
  transitionAnalysisBatch,
  transitionAnalysisQueueItem,
  transitionDelayedVerification,
  transitionFeedbackInterpretation,
  transitionFeedbackStatus,
} from "./stateMachines";
import {
  ReviewCoachValidationError,
  assertBlueprintCapabilityWhitelist,
  assertCurrentDecisionBlockRef,
  assertPositiveContentVersion,
  assertTaskOutcomeShape,
  isOpenTaskStatus,
  openTargetKeyFor,
  validateReviewCoachFormalSnapshot,
} from "./validation";
import type { PreparedDecisionBlockContent } from "./decisionBlockContent";

export interface ReviewCoachRepository {
  getFormalSnapshot(): Promise<ReviewCoachFormalSnapshot>;
  listFeedbackInterpretations(): Promise<FeedbackInterpretation[]>;
  saveDecisionBlock(block: DecisionBlock): Promise<DecisionBlock>;
  archiveDecisionBlock(archive: DecisionBlockArchive): Promise<DecisionBlockArchive>;
  softDeleteDecisionBlock(archive: DecisionBlockArchive): Promise<DecisionBlock>;
  saveRecordWithDecisionBlocks(record: RecordBlock, prepared: PreparedDecisionBlockContent, recordChanged?: boolean): Promise<RecordBlock>;
  listRestorableDecisionBlockArchives(recordId: string): Promise<DecisionBlockArchive[]>;
  addFeedback(feedback: DecisionBlockFeedback, queueItem?: AnalysisQueueItem): Promise<DecisionBlockFeedback>;
  deleteFeedback(feedbackId: string, deletedAt: string): Promise<DecisionBlockFeedback>;
  updateQueueItemAnalysisNote(id: string, analysisNote: string, updatedAt: string): Promise<AnalysisQueueItem>;
  saveFeedbackInterpretation(interpretation: FeedbackInterpretation): Promise<FeedbackInterpretation>;
  transitionQueueItem(id: string, status: AnalysisQueueStatus, updatedAt: string, batchId?: string): Promise<AnalysisQueueItem>;
  createAnalysisBatch(batch: AnalysisBatch): Promise<AnalysisBatch>;
  transitionAnalysisBatch(id: string, status: AnalysisBatchStatus, updatedAt: string): Promise<AnalysisBatch>;
  updateAnalysisBatch(batch: AnalysisBatch): Promise<AnalysisBatch>;
  acceptBlueprint(blueprint: SessionBlueprint): Promise<SessionBlueprint>;
  createTask(task: AdaptiveReviewTask): Promise<AdaptiveReviewTask>;
  transitionTask(id: string, status: AdaptiveReviewTaskStatus, updatedAt: string, reason?: string): Promise<AdaptiveReviewTask>;
  switchCurrentTask(targetTaskId: string, updatedAt: string): Promise<AdaptiveReviewTask>;
  addQuizTurn(turn: AdaptiveQuizTurn, signal?: AbortSignal): Promise<AdaptiveQuizTurn>;
  transitionQuizTurn(id: string, status: AdaptiveQuizTurnStatus, updatedAt: string): Promise<AdaptiveQuizTurn>;
  recordQuizHint(id: string, level: number, requestedAt: string): Promise<AdaptiveQuizTurn>;
  commitQuizAnswer(turn: AdaptiveQuizTurn, event: TaskOutcomeEvent, signal?: AbortSignal): Promise<AdaptiveQuizTurn>;
  invalidateQuizTurn(turnId: string, event: TaskOutcomeEvent, updatedAt: string): Promise<AdaptiveReviewTask>;
  addOutcome(event: TaskOutcomeEvent): Promise<TaskOutcomeEvent>;
  commitTaskOutcome(
    taskId: string,
    events: TaskOutcomeEvent[],
    status: "deferred" | "completed" | "not-achieved" | "invalid" | "abandoned",
    updatedAt: string,
    notBeforeAt?: string,
    verification?: DelayedVerification,
  ): Promise<AdaptiveReviewTask>;
  scheduleVerification(verification: DelayedVerification): Promise<DelayedVerification>;
  transitionVerification(id: string, status: DelayedVerificationStatus, updatedAt: string, outcome?: DelayedVerification["verificationOutcome"]): Promise<DelayedVerification>;
  queueVerification(verificationId: string, task: AdaptiveReviewTask, updatedAt: string): Promise<{ verification: DelayedVerification; task: AdaptiveReviewTask }>;
  completeVerification(taskId: string, events: TaskOutcomeEvent[], outcome: "retained" | "decayed", updatedAt: string): Promise<AdaptiveReviewTask>;
  saveAiRoleConfig(config: AiRoleConfig): Promise<AiRoleConfig>;
  rebuildProjections(): Promise<{ states: DecisionBlockState[]; effects: InterventionEffectSummary[] }>;
  areProjectionsCurrent?(): Promise<boolean>;
}

const ACTIVE_QUEUE_STATUSES = new Set<AnalysisQueueStatus>(["eligible", "excluded", "batched"]);
const ACTIVE_BATCH_STATUSES = new Set<AnalysisBatchStatus>(["draft", "confirmed", "running", "succeeded", "partial"]);

const findVerificationForTask = async (database: StudyJournalDatabase, taskId: string) =>
  (await database.delayedVerifications.toArray()).find((item) => item.taskId === taskId);

const canonicalize = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.keys(value as Record<string, unknown>).sort().reduce<Record<string, unknown>>((result, key) => {
      const next = (value as Record<string, unknown>)[key];
      if (next !== undefined) result[key] = canonicalize(next);
      return result;
    }, {});
  }
  return value;
};

const sameEntity = (left: unknown, right: unknown) => JSON.stringify(canonicalize(left)) === JSON.stringify(canonicalize(right));

const ensureIdempotentInsert = async <T extends { id: string; idempotencyKey: string }>(
  table: Table<T, string>,
  value: T,
): Promise<T | undefined> => {
  const byId = await table.get(value.id);
  const byKey = await table.where("idempotencyKey").equals(value.idempotencyKey).first();
  if (byId && byKey && byId.id !== byKey.id) {
    throw new ReviewCoachValidationError("duplicate-event", `Entity ID ${value.id} and idempotency key ${value.idempotencyKey} refer to different facts.`);
  }
  const existing = byId ?? byKey;
  if (!existing) return undefined;
  if (!sameEntity(existing, value)) {
    throw new ReviewCoachValidationError("duplicate-event", `Idempotency key ${value.idempotencyKey} already has different content.`);
  }
  return existing;
};

const sameFeedbackOperation = (left: DecisionBlockFeedback, right: DecisionBlockFeedback) =>
  left.decisionBlockId === right.decisionBlockId
  && left.recordId === right.recordId
  && left.contentVersion === right.contentVersion
  && left.comment === right.comment
  && left.includeInAnalysis === right.includeInAnalysis
  && left.source === right.source;

export const persistDecisionBlockFeedbackInTransaction = async (
  database: StudyJournalDatabase,
  feedback: DecisionBlockFeedback,
  queueItem?: AnalysisQueueItem,
): Promise<{ feedback: DecisionBlockFeedback; created: boolean }> => {
  if (!feedback.comment.trim()) throw new ReviewCoachValidationError("empty-feedback", "Empty feedback is not a formal event.");
  const existingByKey = await database.decisionBlockFeedback.where("idempotencyKey").equals(feedback.idempotencyKey).first();
  if (existingByKey) {
    if (!sameFeedbackOperation(existingByKey, feedback)) {
      throw new ReviewCoachValidationError("duplicate-event", `Idempotency key ${feedback.idempotencyKey} already has different feedback content.`);
    }
    return { feedback: existingByKey, created: false };
  }
  const existingById = await database.decisionBlockFeedback.get(feedback.id);
  if (existingById) {
    throw new ReviewCoachValidationError("duplicate-event", `Feedback ID ${feedback.id} already exists.`);
  }
  assertCurrentDecisionBlockRef(await database.decisionBlocks.get(feedback.decisionBlockId), feedback);
  if (feedback.reviewLogId) {
    const log = await database.recordReviewLogs.get(feedback.reviewLogId);
    if (!log || log.recordId !== feedback.recordId) throw new ReviewCoachValidationError("dangling-review-log", "Feedback review log does not exist or belongs to another record.");
  }
  if (feedback.includeInAnalysis) {
    if (!queueItem || queueItem.feedbackId !== feedback.id) throw new ReviewCoachValidationError("missing-queue-item", "Analysis-enabled feedback requires a matching queue item.");
    if (queueItem.decisionBlockId !== feedback.decisionBlockId || queueItem.contentVersion !== feedback.contentVersion || queueItem.recordId !== feedback.recordId) {
      throw new ReviewCoachValidationError("dangling-queue-item", "Queue item does not match feedback.");
    }
  } else if (queueItem) {
    throw new ReviewCoachValidationError("unexpected-queue-item", "Opted-out feedback cannot create a queue item.");
  }
  await database.decisionBlockFeedback.add(feedback);
  if (queueItem) await database.analysisQueueItems.add(queueItem);
  return { feedback, created: true };
};

export const reviewCoachFormalTables = (database: StudyJournalDatabase) => [
  database.decisionBlocks,
  database.decisionBlockArchives,
  database.decisionBlockFeedback,
  database.feedbackInterpretations,
  database.analysisQueueItems,
  database.analysisBatches,
  database.sessionBlueprints,
  database.adaptiveReviewTasks,
  database.adaptiveQuizTurns,
  database.taskOutcomeEvents,
  database.delayedVerifications,
  database.decisionBlockStates,
  database.interventionEffectSummaries,
  database.aiRoleConfigs,
  database.learningEvidence,
  database.knowledgePoints,
  database.recordKnowledgePointLinks,
  database.knowledgeRelations,
];

const formalTables = (database: StudyJournalDatabase) => [
  database.blocks,
  ...reviewCoachFormalTables(database),
];

const PRIVATE_COACH_EXPORT_KEYS = new Set([
  "apikey",
  "authorization",
  "prompt",
  "providerresponse",
  "rawresponse",
  "responsebody",
  "secret",
  "systemprompt",
]);

const stripPrivateCoachExportFields = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(stripPrivateCoachExportFields);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .filter(([key]) => !PRIVATE_COACH_EXPORT_KEYS.has(key.toLowerCase()))
    .map(([key, item]) => [key, stripPrivateCoachExportFields(item)]));
};

export const reviewCoachRestoreTables = (database: StudyJournalDatabase) => [
  ...reviewCoachFormalTables(database),
];

/** Remove coach facts owned by a permanently deleted record.
 * The caller must include all formal tables in its surrounding read-write transaction.
 */
export const purgeReviewCoachFactsForRecord = async (database: StudyJournalDatabase, recordId: string): Promise<void> => {
  const [blocks, archives, feedback, interpretations, queueItems, batches, blueprints, tasks, turns, outcomes, verifications] = await Promise.all([
    database.decisionBlocks.where("recordId").equals(recordId).toArray(),
    database.decisionBlockArchives.where("recordId").equals(recordId).toArray(),
    database.decisionBlockFeedback.where("recordId").equals(recordId).toArray(),
    database.feedbackInterpretations.toArray(),
    database.analysisQueueItems.toArray(),
    database.analysisBatches.toArray(),
    database.sessionBlueprints.toArray(),
    database.adaptiveReviewTasks.toArray(),
    database.adaptiveQuizTurns.toArray(),
    database.taskOutcomeEvents.toArray(),
    database.delayedVerifications.toArray(),
  ]);
  const blockIds = new Set(blocks.map((item) => item.id));
  const feedbackIds = new Set(feedback.map((item) => item.id));
  const interpretationIds = new Set(interpretations.filter((item) => feedbackIds.has(item.feedbackId)).map((item) => item.id));
  const queueIds = new Set(queueItems.filter((item) => blockIds.has(item.decisionBlockId) || feedbackIds.has(item.feedbackId)).map((item) => item.id));
  const batchIds = new Set<string>();
  const prunedBatches: AnalysisBatch[] = [];
  for (const batch of batches) {
    const keepRef = (ref: AnalysisBatch["inputRefs"][number]) => !(
      blockIds.has(ref.decisionBlockId)
      || queueIds.has(ref.queueItemId)
      || feedbackIds.has(ref.feedbackId)
      || Boolean(ref.interpretationId && interpretationIds.has(ref.interpretationId))
    );
    const inputRefs = batch.inputRefs.filter(keepRef);
    if (inputRefs.length === batch.inputRefs.length) continue;
    if (inputRefs.length === 0) {
      batchIds.add(batch.id);
      continue;
    }
    prunedBatches.push({
      ...batch,
      inputRefs,
      subBatches: batch.subBatches
        .map((subBatch) => ({ ...subBatch, inputRefs: subBatch.inputRefs.filter(keepRef) }))
        .filter((subBatch) => subBatch.inputRefs.length > 0),
    });
  }
  const blueprintIds = new Set(blueprints.filter((item) => (
    blockIds.has(item.decisionBlockId)
    || batchIds.has(item.batchId)
    || item.supportingDecisionBlockIds.some((id) => blockIds.has(id))
    || item.evidence.some((ref) => blockIds.has(ref.decisionBlockId))
    || item.feedbackIds.some((id) => feedbackIds.has(id))
    || item.interpretationIds.some((id) => interpretationIds.has(id))
  )).map((item) => item.id));
  const taskIds = new Set(tasks.filter((item) => item.recordId === recordId || blockIds.has(item.decisionBlockId) || blueprintIds.has(item.blueprintId)).map((item) => item.id));
  const turnIds = new Set(turns.filter((item) => item.recordId === recordId || taskIds.has(item.taskId) || blockIds.has(item.decisionBlockId)).map((item) => item.id));
  const outcomeIds = new Set(outcomes.filter((item) => item.recordId === recordId || taskIds.has(item.taskId) || blockIds.has(item.decisionBlockId)).map((item) => item.id));
  const verificationIds = new Set(verifications
    .filter((item) => item.recordId === recordId || blockIds.has(item.decisionBlockId) || outcomeIds.has(item.sourceOutcomeEventId))
    .map((item) => item.id));

  await Promise.all([
    ...prunedBatches.map((batch) => database.analysisBatches.put(batch)),
    ...[...verificationIds].map((id) => database.delayedVerifications.delete(id)),
    ...[...outcomeIds].map((id) => database.taskOutcomeEvents.delete(id)),
    ...[...turnIds].map((id) => database.adaptiveQuizTurns.delete(id)),
    ...[...taskIds].map((id) => database.adaptiveReviewTasks.delete(id)),
    ...[...blueprintIds].map((id) => database.sessionBlueprints.delete(id)),
    ...[...batchIds].map((id) => database.analysisBatches.delete(id)),
    ...[...queueIds].map((id) => database.analysisQueueItems.delete(id)),
    ...[...interpretationIds].map((id) => database.feedbackInterpretations.delete(id)),
    ...[...feedbackIds].map((id) => database.decisionBlockFeedback.delete(id)),
    ...[...archives.map((item) => item.id)].map((id) => database.decisionBlockArchives.delete(id)),
    database.recordKnowledgePointLinks.where("recordId").equals(recordId).delete(),
    ...[...blockIds].map((id) => database.decisionBlockStates.delete(id)),
    ...[...blockIds].map((id) => database.decisionBlocks.delete(id)),
  ]);
};

export const getReviewCoachFormalSnapshot = async (database: StudyJournalDatabase): Promise<ReviewCoachFormalSnapshot> => {
  const [
    decisionBlocks,
    decisionBlockArchives,
    decisionBlockFeedback,
    feedbackInterpretations,
    analysisQueueItems,
    analysisBatches,
    sessionBlueprints,
    adaptiveReviewTasks,
    adaptiveQuizTurns,
    taskOutcomeEvents,
    delayedVerifications,
    aiRoleConfigs,
    learningEvidence,
    knowledgePoints,
    recordKnowledgePointLinks,
    knowledgeRelations,
  ] = await Promise.all([
    database.decisionBlocks.toArray(),
    database.decisionBlockArchives.toArray(),
    database.decisionBlockFeedback.toArray(),
    database.feedbackInterpretations.toArray(),
    database.analysisQueueItems.toArray(),
    database.analysisBatches.toArray(),
    database.sessionBlueprints.toArray(),
    database.adaptiveReviewTasks.toArray(),
    database.adaptiveQuizTurns.toArray(),
    database.taskOutcomeEvents.toArray(),
    database.delayedVerifications.toArray(),
    database.aiRoleConfigs.toArray(),
    database.learningEvidence.toArray(),
    database.knowledgePoints.toArray(),
    database.recordKnowledgePointLinks.toArray(),
    database.knowledgeRelations.toArray(),
  ]);
  return stripPrivateCoachExportFields({
    decisionBlocks,
    decisionBlockArchives,
    decisionBlockFeedback,
    feedbackInterpretations: feedbackInterpretations.filter((item) => item.status === "succeeded" || item.status === "insufficient-context"),
    analysisQueueItems,
    analysisBatches,
    sessionBlueprints: sessionBlueprints.filter((item) => item.status !== "rejected"),
    adaptiveReviewTasks,
    adaptiveQuizTurns,
    taskOutcomeEvents,
    delayedVerifications,
    aiRoleConfigs,
    legacyLearningEvidence: learningEvidence.filter((item) => item.origin === "user-confirmed-ai" || item.kind.endsWith("-confirmed")),
    legacyKnowledgePoints: knowledgePoints,
    legacyRecordKnowledgePointLinks: recordKnowledgePointLinks.filter((item) => item.status === "active"),
    legacyKnowledgeRelations: knowledgeRelations.filter((item) => item.status === "confirmed"),
  }) as ReviewCoachFormalSnapshot;
};

export const restoreReviewCoachFormalSnapshot = async (
  database: StudyJournalDatabase,
  snapshot: ReviewCoachFormalSnapshot,
) => {
  await Promise.all([
    database.decisionBlocks.clear(),
    database.decisionBlockArchives.clear(),
    database.decisionBlockFeedback.clear(),
    database.feedbackInterpretations.clear(),
    database.analysisQueueItems.clear(),
    database.analysisBatches.clear(),
    database.sessionBlueprints.clear(),
    database.adaptiveReviewTasks.clear(),
    database.adaptiveQuizTurns.clear(),
    database.taskOutcomeEvents.clear(),
    database.delayedVerifications.clear(),
    database.decisionBlockStates.clear(),
    database.interventionEffectSummaries.clear(),
    database.aiRoleConfigs.clear(),
    database.learningEvidence.clear(),
    database.knowledgePoints.clear(),
    database.recordKnowledgePointLinks.clear(),
    database.knowledgeRelations.clear(),
  ]);
  await Promise.all([
    database.decisionBlocks.bulkPut(snapshot.decisionBlocks),
    database.decisionBlockArchives.bulkPut(snapshot.decisionBlockArchives),
    database.decisionBlockFeedback.bulkPut(snapshot.decisionBlockFeedback),
    database.feedbackInterpretations.bulkPut(snapshot.feedbackInterpretations),
    database.analysisQueueItems.bulkPut(snapshot.analysisQueueItems),
    database.analysisBatches.bulkPut(snapshot.analysisBatches),
    database.sessionBlueprints.bulkPut(snapshot.sessionBlueprints),
    database.adaptiveReviewTasks.bulkPut(snapshot.adaptiveReviewTasks),
    database.adaptiveQuizTurns.bulkPut(snapshot.adaptiveQuizTurns),
    database.taskOutcomeEvents.bulkPut(snapshot.taskOutcomeEvents),
    database.delayedVerifications.bulkPut(snapshot.delayedVerifications),
    database.aiRoleConfigs.bulkPut(snapshot.aiRoleConfigs),
    database.learningEvidence.bulkPut(snapshot.legacyLearningEvidence),
    database.knowledgePoints.bulkPut(snapshot.legacyKnowledgePoints),
    database.recordKnowledgePointLinks.bulkPut(snapshot.legacyRecordKnowledgePointLinks),
    database.knowledgeRelations.bulkPut(snapshot.legacyKnowledgeRelations),
  ]);
};

const latestFactTime = (snapshot: ReviewCoachFormalSnapshot) => {
  const times = [
    ...snapshot.decisionBlocks.map((item) => item.updatedAt),
    ...snapshot.decisionBlockFeedback.map((item) => item.updatedAt),
    ...snapshot.sessionBlueprints.map((item) => item.updatedAt),
    ...snapshot.adaptiveReviewTasks.map((item) => item.updatedAt),
    ...snapshot.taskOutcomeEvents.map((item) => item.updatedAt),
    ...snapshot.delayedVerifications.map((item) => item.updatedAt),
  ].sort();
  return times.at(-1) ?? "1970-01-01T00:00:00.000Z";
};

export const rebuildReviewCoachProjectionsInTransaction = async (database: StudyJournalDatabase) => {
  const snapshot = await getReviewCoachFormalSnapshot(database);
  const records = (await database.blocks.toArray()).filter((block) => block.type === "record").map((block) => block.id);
  validateReviewCoachFormalSnapshot(snapshot, new Set(records));
  const replayedAt = latestFactTime(snapshot);
  const states = replayAllDecisionBlockStates(snapshot, replayedAt);
  const effects = replayInterventionEffectSummaries({
    interpretations: snapshot.feedbackInterpretations,
    blueprints: snapshot.sessionBlueprints,
    tasks: snapshot.adaptiveReviewTasks,
    turns: snapshot.adaptiveQuizTurns,
    outcomes: snapshot.taskOutcomeEvents,
    verifications: snapshot.delayedVerifications,
    replayedAt,
  });
  await Promise.all([
    database.decisionBlockStates.clear(),
    database.interventionEffectSummaries.clear(),
  ]);
  await Promise.all([
    database.decisionBlockStates.bulkPut(states),
    database.interventionEffectSummaries.bulkPut(effects),
  ]);
  return { states, effects };
};

export const tombstoneDecisionBlockFeedbackInTransaction = async (
  database: StudyJournalDatabase,
  feedbackIds: readonly string[],
  reviewLogId: string,
  deletedAt: string,
): Promise<DecisionBlockFeedback[]> => {
  const linked = await database.decisionBlockFeedback.where("reviewLogId").equals(reviewLogId).toArray();
  const ids = new Set([...feedbackIds, ...linked.map((feedback) => feedback.id)]);
  const feedback = (await Promise.all([...ids].map((id) => database.decisionBlockFeedback.get(id))))
    .filter((item): item is DecisionBlockFeedback => Boolean(item));
  const tombstoned: DecisionBlockFeedback[] = [];
  for (const item of feedback) {
    if (item.deletedAt) continue;
    transitionFeedbackStatus("active", "deleted");
    const updated = { ...item, deletedAt, updatedAt: deletedAt };
    await database.decisionBlockFeedback.put(updated);
    const queue = await database.analysisQueueItems.where("feedbackId").equals(item.id).first();
    if (queue && queue.status !== "deleted") {
      transitionAnalysisQueueItem(queue.status, "deleted");
      await database.analysisQueueItems.put({ ...queue, status: "deleted", deletedAt, updatedAt: deletedAt });
    }
    tombstoned.push(updated);
  }
  return tombstoned;
};

export class DexieReviewCoachRepository implements ReviewCoachRepository {
  constructor(private readonly database: StudyJournalDatabase = defaultDatabase) {}

  getFormalSnapshot(): Promise<ReviewCoachFormalSnapshot> {
    return getReviewCoachFormalSnapshot(this.database);
  }

  listFeedbackInterpretations(): Promise<FeedbackInterpretation[]> {
    return this.database.feedbackInterpretations.toArray();
  }

  private async bumpMutation() {
    const current = await this.database.cloudSyncMutation.get("local");
    await this.database.cloudSyncMutation.put({ id: "local", epoch: (current?.epoch ?? 0) + 1 });
  }

  private async staleDerivedWork(decisionBlockId: string, contentVersion: number, stamp: string, reason: string) {
    const [queueItems, batches, blueprints, tasks, verifications] = await Promise.all([
      this.database.analysisQueueItems.where("decisionBlockId").equals(decisionBlockId).toArray(),
      this.database.analysisBatches.toArray(),
      this.database.sessionBlueprints.where("decisionBlockId").equals(decisionBlockId).toArray(),
      this.database.adaptiveReviewTasks.where("decisionBlockId").equals(decisionBlockId).toArray(),
      this.database.delayedVerifications.where("decisionBlockId").equals(decisionBlockId).toArray(),
    ]);
    await Promise.all([
      ...queueItems.filter((item) => item.contentVersion <= contentVersion && ACTIVE_QUEUE_STATUSES.has(item.status)).map((item) => this.database.analysisQueueItems.put({ ...item, status: "stale", updatedAt: stamp })),
      ...batches.filter((batch) => ACTIVE_BATCH_STATUSES.has(batch.status) && batch.inputRefs.some((ref) => ref.decisionBlockId === decisionBlockId && ref.contentVersion <= contentVersion)).map((batch) => this.database.analysisBatches.put({ ...batch, status: "stale", updatedAt: stamp })),
      ...blueprints.filter((item) => item.contentVersion <= contentVersion && item.status === "accepted").map((item) => this.database.sessionBlueprints.put({ ...item, status: "stale", updatedAt: stamp })),
      ...tasks.filter((item) => item.contentVersion <= contentVersion && isOpenTaskStatus(item.status)).map((item) => this.database.adaptiveReviewTasks.put({ ...item, status: "stale", activeSlotKey: undefined, openTargetKey: undefined, terminalReason: reason, endedAt: stamp, updatedAt: stamp })),
      ...verifications.filter((item) => item.contentVersion <= contentVersion && !["completed", "cancelled", "stale"].includes(item.status)).map((item) => this.database.delayedVerifications.put({ ...item, status: "stale", updatedAt: stamp })),
    ]);
  }

  private async rebuildProjectionsInTransaction() {
    return rebuildReviewCoachProjectionsInTransaction(this.database);
  }

  async saveDecisionBlock(block: DecisionBlock): Promise<DecisionBlock> {
    assertPositiveContentVersion(block.contentVersion);
    return this.database.transaction("rw", [this.database.cloudSyncMutation, ...formalTables(this.database)], async () => {
      const record = await this.database.blocks.get(block.recordId);
      if (!record || record.type !== "record" || record.deletedAt) {
        throw new ReviewCoachValidationError("dangling-record", `Record ${block.recordId} does not exist.`);
      }
      const current = await this.database.decisionBlocks.get(block.id);
      if (!current && block.contentVersion !== 1) {
        throw new ReviewCoachValidationError("invalid-content-version", "A new decision block must start at contentVersion 1.");
      }
      if (current) {
        if (current.recordId !== block.recordId) throw new ReviewCoachValidationError("record-mismatch", "A decision block cannot move to another record.");
        if (block.contentVersion < current.contentVersion || block.contentVersion > current.contentVersion + 1) {
          throw new ReviewCoachValidationError("invalid-content-version", "Decision block contentVersion must stay current or increment by one.");
        }
        if (!current.deletedAt && block.deletedAt) {
          throw new ReviewCoachValidationError("missing-decision-block-archive", "Use softDeleteDecisionBlock so deletion and recoverable content are atomic.");
        }
      }
      if (!current && block.deletedAt) throw new ReviewCoachValidationError("invalid-decision-block", "A new decision block cannot start deleted.");
      await this.database.decisionBlocks.put(block);
      if (current && block.contentVersion > current.contentVersion) {
        await this.staleDerivedWork(block.id, current.contentVersion, block.updatedAt, "content-version-changed");
      }
      await this.rebuildProjectionsInTransaction();
      await this.bumpMutation();
      return block;
    });
  }

  async archiveDecisionBlock(archive: DecisionBlockArchive): Promise<DecisionBlockArchive> {
    return this.database.transaction("rw", [this.database.cloudSyncMutation, ...formalTables(this.database)], async () => {
      const existing = await ensureIdempotentInsert(this.database.decisionBlockArchives, archive);
      if (existing) return existing;
      const block = await this.database.decisionBlocks.get(archive.decisionBlockId);
      if (!block || block.recordId !== archive.recordId || archive.contentVersion > block.contentVersion) {
        throw new ReviewCoachValidationError("dangling-archive", "Archive does not match its decision block.");
      }
      await this.database.decisionBlockArchives.add(archive);
      await this.bumpMutation();
      return archive;
    });
  }

  async softDeleteDecisionBlock(archive: DecisionBlockArchive): Promise<DecisionBlock> {
    if (archive.reason !== "deleted" && archive.reason !== "converted-to-plain") {
      throw new ReviewCoachValidationError("invalid-archive-reason", "Content-conflict archives do not delete their source block.");
    }
    return this.database.transaction("rw", [this.database.cloudSyncMutation, ...formalTables(this.database)], async () => {
      const block = await this.database.decisionBlocks.get(archive.decisionBlockId);
      const existing = await ensureIdempotentInsert(this.database.decisionBlockArchives, archive);
      if (existing) {
        const deleted = block;
        if (deleted?.deletedAt) return deleted;
        throw new ReviewCoachValidationError("incomplete-delete-retry", "Archive exists but its decision block is still active.");
      }
      if (!block || block.deletedAt || block.recordId !== archive.recordId || block.contentVersion !== archive.contentVersion) {
        throw new ReviewCoachValidationError("dangling-archive", "Deletion archive must match the current active decision block version.");
      }
      const deleted = { ...block, deletedAt: archive.archivedAt, updatedAt: archive.archivedAt };
      await Promise.all([
        this.database.decisionBlockArchives.add(archive),
        this.database.decisionBlocks.put(deleted),
      ]);
      await this.staleDerivedWork(block.id, block.contentVersion, archive.archivedAt, "decision-block-deleted");
      await this.rebuildProjectionsInTransaction();
      await this.bumpMutation();
      return deleted;
    });
  }

  async saveRecordWithDecisionBlocks(record: RecordBlock, prepared: PreparedDecisionBlockContent, recordChanged = true): Promise<RecordBlock> {
    return this.database.transaction(
      "rw",
      [this.database.blocks, this.database.recordDrafts, this.database.cloudSyncMutation, ...formalTables(this.database)],
      async () => {
        const currentRows = await this.database.decisionBlocks.where("recordId").equals(record.id).toArray();
        const currentById = new Map(currentRows.map((block) => [block.id, block]));
        const nextIds = new Set(prepared.blocks.map((block) => block.decisionBlockId));
        const coachChanged = prepared.removals.length > 0 || prepared.blocks.some((block) => {
          const current = currentById.get(block.decisionBlockId);
          return !current || Boolean(current.deletedAt) || current.contentVersion !== block.contentVersion || current.position !== block.position;
        });
        if (nextIds.size !== prepared.blocks.length) {
          throw new ReviewCoachValidationError("duplicate-decision-block", "A record cannot contain duplicate decision block IDs.");
        }

        await this.database.blocks.put(record);
        await this.database.recordDrafts.delete(record.id);

        for (const parsed of prepared.blocks) {
          const current = currentById.get(parsed.decisionBlockId);
          const existingById = current ?? await this.database.decisionBlocks.get(parsed.decisionBlockId);
          if (existingById && existingById.recordId !== record.id) {
            throw new ReviewCoachValidationError("record-mismatch", "A decision block ID cannot be reused by another record.");
          }
          if (!current && parsed.contentVersion !== 1) {
            throw new ReviewCoachValidationError("invalid-content-version", "A new decision block must start at contentVersion 1.");
          }
          if (current) {
            if (parsed.contentVersion < current.contentVersion || parsed.contentVersion > current.contentVersion + 1) {
              throw new ReviewCoachValidationError("invalid-content-version", "Decision block contentVersion must stay current or increment by one.");
            }
            if (!current.deletedAt && parsed.contentVersion > current.contentVersion) {
              await this.staleDerivedWork(current.id, current.contentVersion, parsed.updatedAt, "content-version-changed");
            }
          }
          const next: DecisionBlock = {
            id: parsed.decisionBlockId,
            recordId: record.id,
            contentVersion: parsed.contentVersion,
            position: parsed.position,
            contentUpdatedAt: parsed.updatedAt,
            createdAt: current?.createdAt ?? parsed.createdAt,
            updatedAt: parsed.updatedAt,
          };
          await this.database.decisionBlocks.put(next);
        }

        for (const removal of prepared.removals) {
          const current = currentById.get(removal.decisionBlockId);
          if (!current || current.deletedAt || current.recordId !== record.id) {
            throw new ReviewCoachValidationError("dangling-archive", "Removed decision block does not match an active index row.");
          }
          if (removal.contentVersion < current.contentVersion || removal.contentVersion > current.contentVersion + 1) {
            throw new ReviewCoachValidationError("invalid-content-version", "Removed decision block version must stay current or increment by one.");
          }
          const archiveStamp = removal.archivedAt || record.updatedAt;
          const archiveKey = [
            "decision-block-archive",
            record.id,
            removal.decisionBlockId,
            removal.contentVersion,
            removal.reason,
            archiveStamp,
          ].join(":");
          const archive: DecisionBlockArchive = {
            id: archiveKey,
            decisionBlockId: removal.decisionBlockId,
            recordId: record.id,
            contentVersion: removal.contentVersion,
            contentHtml: removal.contentHtml,
            archivedAt: archiveStamp,
            reason: removal.reason,
            idempotencyKey: archiveKey,
            createdAt: archiveStamp,
            updatedAt: archiveStamp,
          };
          await this.database.decisionBlockArchives.put(archive);
          await this.database.decisionBlocks.put({
            ...current,
            contentVersion: removal.contentVersion,
            contentUpdatedAt: removal.updatedAt,
            deletedAt: archiveStamp,
            updatedAt: archiveStamp,
          });
          await this.staleDerivedWork(current.id, current.contentVersion, archiveStamp, "decision-block-deleted");
        }

        const unexpectedlyMissing = currentRows.filter((block) => !block.deletedAt && !nextIds.has(block.id)
          && !prepared.removals.some((removal) => removal.decisionBlockId === block.id));
        if (unexpectedlyMissing.length > 0) {
          throw new ReviewCoachValidationError("missing-decision-block-archive", "Every removed decision block requires recoverable HTML.");
        }

        if (coachChanged) await this.rebuildProjectionsInTransaction();
        if (recordChanged || coachChanged) await this.bumpMutation();
        return record;
      },
    );
  }

  async listRestorableDecisionBlockArchives(recordId: string): Promise<DecisionBlockArchive[]> {
    const [archives, blocks] = await Promise.all([
      this.database.decisionBlockArchives.where("recordId").equals(recordId).toArray(),
      this.database.decisionBlocks.where("recordId").equals(recordId).toArray(),
    ]);
    const deletedById = new Map(blocks.filter((block) => block.deletedAt).map((block) => [block.id, block]));
    return archives
      .filter((archive) => {
        const block = deletedById.get(archive.decisionBlockId);
        return block?.contentVersion === archive.contentVersion && !archive.deletedAt;
      })
      .sort((left, right) => right.archivedAt.localeCompare(left.archivedAt))
      .filter((archive, index, all) => all.findIndex((item) => item.decisionBlockId === archive.decisionBlockId) === index);
  }

  async addFeedback(feedback: DecisionBlockFeedback, queueItem?: AnalysisQueueItem): Promise<DecisionBlockFeedback> {
    return this.database.transaction("rw", [this.database.recordReviewLogs, this.database.cloudSyncMutation, ...formalTables(this.database)], async () => {
      const persisted = await persistDecisionBlockFeedbackInTransaction(this.database, feedback, queueItem);
      if (!persisted.created) return persisted.feedback;
      await this.rebuildProjectionsInTransaction();
      await this.bumpMutation();
      return persisted.feedback;
    });
  }

  async deleteFeedback(feedbackId: string, deletedAt: string): Promise<DecisionBlockFeedback> {
    return this.database.transaction("rw", [this.database.cloudSyncMutation, ...formalTables(this.database)], async () => {
      const feedback = await this.database.decisionBlockFeedback.get(feedbackId);
      if (!feedback) throw new ReviewCoachValidationError("missing-feedback", `Feedback ${feedbackId} does not exist.`);
      transitionFeedbackStatus(feedback.deletedAt ? "deleted" : "active", "deleted");
      const updated = { ...feedback, deletedAt, updatedAt: deletedAt };
      await this.database.decisionBlockFeedback.put(updated);
      const queue = await this.database.analysisQueueItems.where("feedbackId").equals(feedbackId).first();
      if (queue && queue.status !== "deleted") await this.database.analysisQueueItems.put({ ...queue, status: "deleted", deletedAt, updatedAt: deletedAt });
      await this.rebuildProjectionsInTransaction();
      await this.bumpMutation();
      return updated;
    });
  }

  async updateQueueItemAnalysisNote(id: string, analysisNote: string, updatedAt: string): Promise<AnalysisQueueItem> {
    return this.database.transaction("rw", [this.database.cloudSyncMutation, ...formalTables(this.database)], async () => {
      const current = await this.database.analysisQueueItems.get(id);
      if (!current || current.status === "deleted" || current.status === "stale" || current.status === "consumed") {
        throw new ReviewCoachValidationError("inactive-queue-item", `Queue item ${id} cannot be edited.`);
      }
      const normalizedNote = analysisNote.trim();
      const next = { ...current, analysisNote: normalizedNote || undefined, updatedAt };
      await this.database.analysisQueueItems.put(next);
      await this.bumpMutation();
      return next;
    });
  }

  async saveFeedbackInterpretation(interpretation: FeedbackInterpretation): Promise<FeedbackInterpretation> {
    return this.database.transaction("rw", [this.database.cloudSyncMutation, ...formalTables(this.database)], async () => {
      const feedback = await this.database.decisionBlockFeedback.get(interpretation.feedbackId);
      if (!feedback || feedback.decisionBlockId !== interpretation.decisionBlockId || feedback.contentVersion !== interpretation.contentVersion) {
        throw new ReviewCoachValidationError("dangling-feedback", "Interpretation does not match feedback.");
      }
      assertCurrentDecisionBlockRef(await this.database.decisionBlocks.get(interpretation.decisionBlockId), feedback);
      const current = await this.database.feedbackInterpretations.where("feedbackId").equals(interpretation.feedbackId).first();
      if (current && current.id !== interpretation.id) throw new ReviewCoachValidationError("duplicate-feedback-interpretation", "Feedback already has an interpretation.");
      if (current) transitionFeedbackInterpretation(current.status, interpretation.status);
      if (interpretation.confidence !== undefined && (interpretation.confidence < 0 || interpretation.confidence > 1)) throw new ReviewCoachValidationError("invalid-confidence", "Interpretation confidence must be between 0 and 1.");
      await this.database.feedbackInterpretations.put(interpretation);
      await this.bumpMutation();
      return interpretation;
    });
  }

  async transitionQueueItem(id: string, status: AnalysisQueueStatus, updatedAt: string, batchId?: string): Promise<AnalysisQueueItem> {
    return this.database.transaction("rw", [this.database.cloudSyncMutation, ...formalTables(this.database)], async () => {
      const current = await this.database.analysisQueueItems.get(id);
      if (!current) throw new ReviewCoachValidationError("missing-queue-item", `Queue item ${id} does not exist.`);
      transitionAnalysisQueueItem(current.status, status);
      if (status === "batched" && !batchId) throw new ReviewCoachValidationError("missing-analysis-batch", "Batched queue item requires batchId.");
      const next = {
        ...current,
        status,
        updatedAt,
        batchId: status === "batched" ? batchId : undefined,
        excludedAt: status === "excluded" ? updatedAt : status === "eligible" ? undefined : current.excludedAt,
        consumedAt: status === "consumed" ? updatedAt : current.consumedAt,
        deletedAt: status === "deleted" ? updatedAt : current.deletedAt,
      };
      await this.database.analysisQueueItems.put(next);
      await this.rebuildProjectionsInTransaction();
      await this.bumpMutation();
      return next;
    });
  }

  async createAnalysisBatch(batch: AnalysisBatch): Promise<AnalysisBatch> {
    return this.database.transaction("rw", [this.database.cloudSyncMutation, ...formalTables(this.database)], async () => {
      const existing = await ensureIdempotentInsert(this.database.analysisBatches, batch);
      if (existing) return existing;
      const snapshot = await getReviewCoachFormalSnapshot(this.database);
      const blocks = new Map(snapshot.decisionBlocks.map((block) => [block.id, block]));
      const partitionedRefs = batch.subBatches.flatMap((item) => item.inputRefs.map((ref) => ref.queueItemId));
      const expectedRefs = batch.inputRefs.map((ref) => ref.queueItemId);
      if (
        batch.inputRefs.length === 0 ||
        batch.subBatches.some((item) => item.inputRefs.length === 0 || new Set(item.inputRefs.map((ref) => ref.decisionBlockId)).size > 3) ||
        partitionedRefs.length !== expectedRefs.length ||
        new Set(partitionedRefs).size !== partitionedRefs.length ||
        expectedRefs.some((id) => !partitionedRefs.includes(id))
      ) {
        throw new ReviewCoachValidationError("invalid-analysis-batch-size", "Analysis sub-batches must contain one to three decision blocks.");
      }
      for (const ref of batch.inputRefs) {
        assertCurrentDecisionBlockRef(blocks.get(ref.decisionBlockId), ref);
        const queueItem = snapshot.analysisQueueItems.find((item) => item.id === ref.queueItemId);
        if (!queueItem || queueItem.feedbackId !== ref.feedbackId || queueItem.status !== "eligible") {
          throw new ReviewCoachValidationError("invalid-analysis-input", `Queue item ${ref.queueItemId} is not eligible.`);
        }
      }
      await this.database.analysisBatches.add(batch);
      await Promise.all(batch.inputRefs.map(async (ref) => {
        const item = await this.database.analysisQueueItems.get(ref.queueItemId);
        if (item) await this.database.analysisQueueItems.put({ ...item, status: "batched", batchId: batch.id, updatedAt: batch.updatedAt });
      }));
      await this.rebuildProjectionsInTransaction();
      await this.bumpMutation();
      return batch;
    });
  }

  async transitionAnalysisBatch(id: string, status: AnalysisBatchStatus, updatedAt: string): Promise<AnalysisBatch> {
    return this.database.transaction("rw", [this.database.cloudSyncMutation, ...formalTables(this.database)], async () => {
      const current = await this.database.analysisBatches.get(id);
      if (!current) throw new ReviewCoachValidationError("missing-analysis-batch", `Analysis batch ${id} does not exist.`);
      transitionAnalysisBatch(current.status, status);
      const next = {
        ...current,
        status,
        requestedAt: status === "running" ? current.requestedAt ?? updatedAt : current.requestedAt,
        completedAt: ["succeeded", "partial", "failed", "cancelled"].includes(status) ? updatedAt : current.completedAt,
        updatedAt,
      };
      await this.database.analysisBatches.put(next);
      await this.bumpMutation();
      return next;
    });
  }

  async updateAnalysisBatch(batch: AnalysisBatch): Promise<AnalysisBatch> {
    return this.database.transaction("rw", [this.database.cloudSyncMutation, ...formalTables(this.database)], async () => {
      const current = await this.database.analysisBatches.get(batch.id);
      if (!current) throw new ReviewCoachValidationError("missing-analysis-batch", `Analysis batch ${batch.id} does not exist.`);
      if (current.inputFingerprint !== batch.inputFingerprint || JSON.stringify(current.inputRefs) !== JSON.stringify(batch.inputRefs)) {
        throw new ReviewCoachValidationError("changed-analysis-input", "Frozen analysis input cannot be changed.");
      }
      transitionAnalysisBatch(current.status, batch.status);
      const partitionedRefs = batch.subBatches.flatMap((item) => item.inputRefs.map((ref) => ref.queueItemId));
      const expectedRefs = batch.inputRefs.map((ref) => ref.queueItemId);
      if (
        batch.subBatches.some((item) => item.inputRefs.length === 0 || new Set(item.inputRefs.map((ref) => ref.decisionBlockId)).size > 3) ||
        partitionedRefs.length !== expectedRefs.length ||
        new Set(partitionedRefs).size !== partitionedRefs.length ||
        expectedRefs.some((id) => !partitionedRefs.includes(id))
      ) {
        throw new ReviewCoachValidationError("invalid-analysis-batch-size", "Analysis progress does not match its frozen input.");
      }
      const next: AnalysisBatch = {
        ...batch,
        requestedAt: batch.status === "running" ? batch.requestedAt ?? batch.updatedAt : batch.requestedAt,
        completedAt: ["succeeded", "partial", "failed", "cancelled"].includes(batch.status) ? batch.completedAt ?? batch.updatedAt : undefined,
      };
      await this.database.analysisBatches.put(next);
      if (["succeeded", "partial", "failed"].includes(next.status)) {
        const succeededQueueIds = new Set(next.subBatches.filter((item) => item.status === "succeeded").flatMap((item) => item.inputRefs.map((ref) => ref.queueItemId)));
        await Promise.all(next.inputRefs.map(async (ref) => {
          const item = await this.database.analysisQueueItems.get(ref.queueItemId);
          if (!item || item.status !== "batched" || item.batchId !== next.id) return;
          const succeeded = succeededQueueIds.has(item.id);
          await this.database.analysisQueueItems.put({
            ...item,
            status: succeeded ? "consumed" : "eligible",
            batchId: succeeded ? next.id : undefined,
            consumedAt: succeeded ? next.completedAt ?? next.updatedAt : undefined,
            updatedAt: next.updatedAt,
          });
        }));
        await this.rebuildProjectionsInTransaction();
      }
      await this.bumpMutation();
      return next;
    });
  }

  async acceptBlueprint(blueprint: SessionBlueprint): Promise<SessionBlueprint> {
    return this.database.transaction("rw", [this.database.cloudSyncMutation, ...formalTables(this.database)], async () => {
      const existing = await ensureIdempotentInsert(this.database.sessionBlueprints, blueprint);
      if (existing) return existing;
      if (blueprint.status !== "accepted") throw new ReviewCoachValidationError("non-formal-blueprint", "Only accepted blueprints are formal repository data.");
      assertBlueprintCapabilityWhitelist(blueprint);
      assertCurrentDecisionBlockRef(await this.database.decisionBlocks.get(blueprint.decisionBlockId), blueprint);
      const batch = await this.database.analysisBatches.get(blueprint.batchId);
      if (!batch || !["running", "succeeded", "partial"].includes(batch.status)) throw new ReviewCoachValidationError("invalid-analysis-batch", "Blueprint requires a running or completed analysis batch.");
      const suppliedBlockIds = new Set(batch.inputRefs.map((ref) => ref.decisionBlockId));
      if (!suppliedBlockIds.has(blueprint.decisionBlockId) || blueprint.supportingDecisionBlockIds.some((id) => !suppliedBlockIds.has(id))) {
        throw new ReviewCoachValidationError("unsupplied-blueprint-source", "Blueprint references a decision block outside the frozen analysis input.");
      }
      for (const evidence of blueprint.evidence) {
        const block = await this.database.decisionBlocks.get(evidence.decisionBlockId);
        if (!block || block.recordId !== evidence.recordId || block.contentVersion !== evidence.contentVersion || !suppliedBlockIds.has(evidence.decisionBlockId)) {
          throw new ReviewCoachValidationError("invalid-blueprint-evidence", "Blueprint evidence is missing, stale, or outside the frozen input.");
        }
      }
      await this.database.sessionBlueprints.add(blueprint);
      await this.rebuildProjectionsInTransaction();
      await this.bumpMutation();
      return blueprint;
    });
  }

  async createTask(task: AdaptiveReviewTask): Promise<AdaptiveReviewTask> {
    return this.database.transaction("rw", [this.database.cloudSyncMutation, ...formalTables(this.database)], async () => {
      const existing = await ensureIdempotentInsert(this.database.adaptiveReviewTasks, task);
      if (existing) return existing;
      const blueprint = await this.database.sessionBlueprints.get(task.blueprintId);
      if (!blueprint || blueprint.status !== "accepted" || blueprint.decisionBlockId !== task.decisionBlockId || blueprint.contentVersion !== task.contentVersion) {
        throw new ReviewCoachValidationError("dangling-blueprint", "Task requires a matching accepted blueprint.");
      }
      assertCurrentDecisionBlockRef(await this.database.decisionBlocks.get(task.decisionBlockId), task);
      const normalized: AdaptiveReviewTask = {
        ...task,
        activeSlotKey: task.status === "current" || task.status === "in-progress" ? "global-current" : undefined,
        openTargetKey: isOpenTaskStatus(task.status) ? openTargetKeyFor(task) : undefined,
      };
      try {
        await this.database.adaptiveReviewTasks.add(normalized);
      } catch (error) {
        if (error instanceof Dexie.ConstraintError) throw new ReviewCoachValidationError("task-uniqueness", "Only one current task and one open task per block version are allowed.");
        throw error;
      }
      await this.rebuildProjectionsInTransaction();
      await this.bumpMutation();
      return normalized;
    });
  }

  async transitionTask(id: string, status: AdaptiveReviewTaskStatus, updatedAt: string, reason?: string): Promise<AdaptiveReviewTask> {
    return this.database.transaction("rw", [this.database.cloudSyncMutation, ...formalTables(this.database)], async () => {
      const current = await this.database.adaptiveReviewTasks.get(id);
      if (!current) throw new ReviewCoachValidationError("missing-task", `Task ${id} does not exist.`);
      transitionAdaptiveReviewTask(current.status, status);
      if (status !== "stale" && status !== "deleted") assertCurrentDecisionBlockRef(await this.database.decisionBlocks.get(current.decisionBlockId), current);
      const terminal = ["completed", "not-achieved", "invalid", "abandoned", "stale", "deleted"].includes(status);
      const next: AdaptiveReviewTask = {
        ...current,
        status,
        activeSlotKey: status === "current" || status === "in-progress" ? "global-current" : undefined,
        openTargetKey: isOpenTaskStatus(status) ? openTargetKeyFor(current) : undefined,
        startedAt: status === "in-progress" ? current.startedAt ?? updatedAt : current.startedAt,
        endedAt: terminal ? updatedAt : current.endedAt,
        terminalReason: reason ?? current.terminalReason,
        deletedAt: status === "deleted" ? updatedAt : current.deletedAt,
        updatedAt,
      };
      try {
        await this.database.adaptiveReviewTasks.put(next);
      } catch (error) {
        if (error instanceof Dexie.ConstraintError) throw new ReviewCoachValidationError("task-uniqueness", "Only one current task and one open task per block version are allowed.");
        throw error;
      }
      const verification = await findVerificationForTask(this.database, id);
      if (verification && status === "in-progress" && verification.status !== "in-progress") {
        let verificationStatus: DelayedVerificationStatus = verification.status;
        if (verificationStatus === "missed") verificationStatus = transitionDelayedVerification(verificationStatus, "eligible");
        if (verificationStatus === "eligible") verificationStatus = transitionDelayedVerification(verificationStatus, "queued");
        verificationStatus = transitionDelayedVerification(verificationStatus, "in-progress");
        await this.database.delayedVerifications.put({ ...verification, status: verificationStatus, updatedAt });
      }
      await this.rebuildProjectionsInTransaction();
      await this.bumpMutation();
      return next;
    });
  }

  async switchCurrentTask(targetTaskId: string, updatedAt: string): Promise<AdaptiveReviewTask> {
    return this.database.transaction("rw", [this.database.cloudSyncMutation, ...formalTables(this.database)], async () => {
      const target = await this.database.adaptiveReviewTasks.get(targetTaskId);
      if (!target || !["waiting", "deferred", "current"].includes(target.status)) {
        throw new ReviewCoachValidationError("inactive-task", "Only a waiting or deferred task can become current.");
      }
      if (target.status === "current") return target;
      assertCurrentDecisionBlockRef(await this.database.decisionBlocks.get(target.decisionBlockId), target);
      const tasks = await this.database.adaptiveReviewTasks.toArray();
      const current = tasks.find((item) => item.status === "current" || item.status === "in-progress");
      if (current) {
        transitionAdaptiveReviewTask(current.status, "waiting");
        await this.database.adaptiveReviewTasks.put({
          ...current,
          status: "waiting",
          activeSlotKey: undefined,
          openTargetKey: openTargetKeyFor(current),
          updatedAt,
        });
        const currentVerification = await findVerificationForTask(this.database, current.id);
        if (currentVerification?.status === "in-progress") {
          await this.database.delayedVerifications.put({ ...currentVerification, status: transitionDelayedVerification("in-progress", "eligible"), updatedAt });
        }
      }
      transitionAdaptiveReviewTask(target.status, "current");
      const next: AdaptiveReviewTask = {
        ...target,
        status: "current",
        activeSlotKey: "global-current",
        openTargetKey: openTargetKeyFor(target),
        notBeforeAt: undefined,
        updatedAt,
      };
      await this.database.adaptiveReviewTasks.put(next);
      await this.rebuildProjectionsInTransaction();
      await this.bumpMutation();
      return next;
    });
  }

  async addQuizTurn(turn: AdaptiveQuizTurn, signal?: AbortSignal): Promise<AdaptiveQuizTurn> {
    signal?.throwIfAborted();
    return this.database.transaction("rw", [this.database.cloudSyncMutation, ...formalTables(this.database)], async () => {
      const existing = await ensureIdempotentInsert(this.database.adaptiveQuizTurns, turn);
      if (existing) return existing;
      const task = await this.database.adaptiveReviewTasks.get(turn.taskId);
      if (!task || task.decisionBlockId !== turn.decisionBlockId || task.contentVersion !== turn.contentVersion) throw new ReviewCoachValidationError("dangling-task", "Quiz turn does not match its task.");
      if (task.status !== "in-progress") throw new ReviewCoachValidationError("inactive-task", "Quiz turns can only be displayed for an in-progress task.");
      if (turn.status !== "displayed") throw new ReviewCoachValidationError("non-formal-quiz-turn", "A quiz turn becomes formal only when displayed.");
      assertCurrentDecisionBlockRef(await this.database.decisionBlocks.get(turn.decisionBlockId), turn);
      try {
        await this.database.adaptiveQuizTurns.add(turn);
      } catch (error) {
        if (error instanceof Dexie.ConstraintError) throw new ReviewCoachValidationError("duplicate-quiz-turn", "Task sequence or idempotency key already exists.");
        throw error;
      }
      await this.bumpMutation();
      signal?.throwIfAborted();
      return turn;
    });
  }

  async transitionQuizTurn(id: string, status: AdaptiveQuizTurnStatus, updatedAt: string): Promise<AdaptiveQuizTurn> {
    return this.database.transaction("rw", [this.database.cloudSyncMutation, ...formalTables(this.database)], async () => {
      const current = await this.database.adaptiveQuizTurns.get(id);
      if (!current) throw new ReviewCoachValidationError("missing-quiz-turn", `Quiz turn ${id} does not exist.`);
      transitionAdaptiveQuizTurn(current.status, status);
      const next = { ...current, status, updatedAt };
      await this.database.adaptiveQuizTurns.put(next);
      await this.bumpMutation();
      return next;
    });
  }

  async recordQuizHint(id: string, level: number, requestedAt: string): Promise<AdaptiveQuizTurn> {
    return this.database.transaction("rw", [this.database.adaptiveQuizTurns, this.database.cloudSyncMutation], async () => {
      const current = await this.database.adaptiveQuizTurns.get(id);
      if (!current || current.status !== "displayed") throw new ReviewCoachValidationError("inactive-quiz-turn", "Hints require an active displayed turn.");
      if (!Number.isSafeInteger(level) || level < 1 || level > (current.availableHints?.length ?? 0)) throw new ReviewCoachValidationError("invalid-hint", "Hint level is outside the available range.");
      const existing = current.hintsUsed.find((item) => item.level === level);
      if (existing) return current;
      const next = { ...current, hintsUsed: [...current.hintsUsed, { level, requestedAt }], updatedAt: requestedAt };
      await this.database.adaptiveQuizTurns.put(next);
      await this.bumpMutation();
      return next;
    });
  }

  async commitQuizAnswer(turn: AdaptiveQuizTurn, event: TaskOutcomeEvent, signal?: AbortSignal): Promise<AdaptiveQuizTurn> {
    signal?.throwIfAborted();
    assertTaskOutcomeShape(event);
    return this.database.transaction("rw", [this.database.cloudSyncMutation, ...formalTables(this.database)], async () => {
      const current = await this.database.adaptiveQuizTurns.get(turn.id);
      if (!current) throw new ReviewCoachValidationError("missing-quiz-turn", `Quiz turn ${turn.id} does not exist.`);
      if (current.status === "answered") {
        const existing = await ensureIdempotentInsert(this.database.taskOutcomeEvents, event);
        if (!existing) throw new ReviewCoachValidationError("incomplete-answer-retry", "Answered turn is missing its outcome event.");
        return current;
      }
      transitionAdaptiveQuizTurn(current.status, "answered");
      if (turn.taskId !== current.taskId || turn.sequence !== current.sequence || !turn.answerText?.trim() || !turn.assessment || event.turnId !== turn.id || event.answerAssessment !== turn.assessment) {
        throw new ReviewCoachValidationError("invalid-quiz-answer", "Quiz answer does not match its displayed turn and outcome.");
      }
      const next = { ...current, status: "answered" as const, answerText: turn.answerText, answeredAt: turn.answeredAt, assessment: turn.assessment, assessmentRationale: turn.assessmentRationale, updatedAt: turn.updatedAt };
      await this.database.adaptiveQuizTurns.put(next);
      const existing = await ensureIdempotentInsert(this.database.taskOutcomeEvents, event);
      if (!existing) await this.database.taskOutcomeEvents.add(event);
      await this.rebuildProjectionsInTransaction();
      await this.bumpMutation();
      signal?.throwIfAborted();
      return next;
    });
  }

  async invalidateQuizTurn(turnId: string, event: TaskOutcomeEvent, updatedAt: string): Promise<AdaptiveReviewTask> {
    assertTaskOutcomeShape(event);
    return this.database.transaction("rw", [this.database.cloudSyncMutation, ...formalTables(this.database)], async () => {
      const turn = await this.database.adaptiveQuizTurns.get(turnId);
      const task = turn ? await this.database.adaptiveReviewTasks.get(turn.taskId) : undefined;
      if (!turn || !task || event.turnId !== turn.id || event.taskId !== task.id || event.disposition !== "question-invalid") {
        throw new ReviewCoachValidationError("invalid-question-report", "Question report does not match its turn and task.");
      }
      transitionAdaptiveQuizTurn(turn.status, "invalid");
      transitionAdaptiveReviewTask(task.status, "invalid");
      await this.database.adaptiveQuizTurns.put({ ...turn, status: "invalid", updatedAt });
      const existing = await ensureIdempotentInsert(this.database.taskOutcomeEvents, event);
      if (!existing) await this.database.taskOutcomeEvents.add(event);
      const next = { ...task, status: "invalid" as const, activeSlotKey: undefined, openTargetKey: undefined, endedAt: updatedAt, terminalReason: event.reason, updatedAt };
      await this.database.adaptiveReviewTasks.put(next);
      const verification = await findVerificationForTask(this.database, task.id);
      if (verification && ["queued", "in-progress"].includes(verification.status)) {
        const eligibleStatus = verification.status === "queued"
          ? transitionDelayedVerification("queued", "eligible")
          : transitionDelayedVerification("in-progress", "eligible");
        await this.database.delayedVerifications.put({ ...verification, taskId: undefined, status: eligibleStatus, updatedAt });
      }
      await this.rebuildProjectionsInTransaction();
      await this.bumpMutation();
      return next;
    });
  }

  async addOutcome(event: TaskOutcomeEvent): Promise<TaskOutcomeEvent> {
    assertTaskOutcomeShape(event);
    return this.database.transaction("rw", [this.database.cloudSyncMutation, ...formalTables(this.database)], async () => {
      const existing = await ensureIdempotentInsert(this.database.taskOutcomeEvents, event);
      if (existing) return existing;
      const task = await this.database.adaptiveReviewTasks.get(event.taskId);
      if (!task || task.decisionBlockId !== event.decisionBlockId || task.contentVersion !== event.contentVersion) throw new ReviewCoachValidationError("dangling-task", "Outcome does not match its task.");
      if (event.turnId) {
        const turn = await this.database.adaptiveQuizTurns.get(event.turnId);
        if (!turn || turn.taskId !== event.taskId) throw new ReviewCoachValidationError("dangling-turn", "Outcome does not match its quiz turn.");
      }
      await this.database.taskOutcomeEvents.add(event);
      await this.rebuildProjectionsInTransaction();
      await this.bumpMutation();
      return event;
    });
  }

  async commitTaskOutcome(
    taskId: string,
    events: TaskOutcomeEvent[],
    status: "deferred" | "completed" | "not-achieved" | "invalid" | "abandoned",
    updatedAt: string,
    notBeforeAt?: string,
    verification?: DelayedVerification,
  ): Promise<AdaptiveReviewTask> {
    if (events.length === 0) throw new ReviewCoachValidationError("missing-outcome-events", "A task outcome commit requires formal events.");
    events.forEach(assertTaskOutcomeShape);
    return this.database.transaction("rw", [this.database.cloudSyncMutation, ...formalTables(this.database)], async () => {
      const current = await this.database.adaptiveReviewTasks.get(taskId);
      if (!current) throw new ReviewCoachValidationError("missing-task", `Task ${taskId} does not exist.`);
      if (current.status === status) {
        for (const event of events) {
          const existing = await ensureIdempotentInsert(this.database.taskOutcomeEvents, event);
          if (!existing) throw new ReviewCoachValidationError("incomplete-outcome-retry", "Task is terminal but an outcome event is missing.");
        }
        if (verification) {
          const existingVerification = await ensureIdempotentInsert(this.database.delayedVerifications, verification);
          if (!existingVerification) throw new ReviewCoachValidationError("incomplete-verification-retry", "Task is terminal but its delayed verification is missing.");
        }
        return current;
      }
      transitionAdaptiveReviewTask(current.status, status);
      for (const event of events) {
        if (event.taskId !== taskId || event.decisionBlockId !== current.decisionBlockId || event.recordId !== current.recordId || event.contentVersion !== current.contentVersion) {
          throw new ReviewCoachValidationError("dangling-task", `Outcome ${event.id} does not match task ${taskId}.`);
        }
        if (event.turnId) {
          const turn = await this.database.adaptiveQuizTurns.get(event.turnId);
          if (!turn || turn.taskId !== taskId) throw new ReviewCoachValidationError("dangling-turn", `Outcome ${event.id} does not match its quiz turn.`);
        }
        const existing = await ensureIdempotentInsert(this.database.taskOutcomeEvents, event);
        if (!existing) await this.database.taskOutcomeEvents.add(event);
      }
      const next: AdaptiveReviewTask = {
        ...current,
        status,
        activeSlotKey: undefined,
        openTargetKey: status === "deferred" ? openTargetKeyFor(current) : undefined,
        notBeforeAt: status === "deferred" ? notBeforeAt : current.notBeforeAt,
        endedAt: status === "deferred" ? current.endedAt : updatedAt,
        updatedAt,
      };
      await this.database.adaptiveReviewTasks.put(next);
      if (verification) {
        const source = await this.database.taskOutcomeEvents.get(verification.sourceOutcomeEventId);
        if (!source || source.kind !== "self-assessment" || !["mastered", "needs-consolidation"].includes(source.subjectiveOutcome ?? "") || source.decisionBlockId !== verification.decisionBlockId || source.contentVersion !== verification.contentVersion) {
          throw new ReviewCoachValidationError("invalid-verification-source", "Delayed verification requires a matching completed self-assessment.");
        }
        if (verification.status !== "scheduled") throw new ReviewCoachValidationError("invalid-verification-status", "A new delayed verification must be scheduled.");
        const existingVerification = await ensureIdempotentInsert(this.database.delayedVerifications, verification);
        if (!existingVerification) await this.database.delayedVerifications.add(verification);
      }
      const linkedVerification = await findVerificationForTask(this.database, taskId);
      if (linkedVerification && (status === "deferred" || status === "abandoned")) {
        const missedStatus = linkedVerification.status === "in-progress"
          ? transitionDelayedVerification("in-progress", "missed")
          : transitionDelayedVerification(linkedVerification.status, "missed");
        await this.database.delayedVerifications.put({ ...linkedVerification, taskId: undefined, status: missedStatus, updatedAt });
      }
      await this.rebuildProjectionsInTransaction();
      await this.bumpMutation();
      return next;
    });
  }

  async scheduleVerification(verification: DelayedVerification): Promise<DelayedVerification> {
    return this.database.transaction("rw", [this.database.cloudSyncMutation, ...formalTables(this.database)], async () => {
      const existing = await ensureIdempotentInsert(this.database.delayedVerifications, verification);
      if (existing) return existing;
      const source = await this.database.taskOutcomeEvents.get(verification.sourceOutcomeEventId);
      if (!source || source.kind !== "self-assessment" || !["mastered", "needs-consolidation"].includes(source.subjectiveOutcome ?? "") || source.decisionBlockId !== verification.decisionBlockId || source.contentVersion !== verification.contentVersion) {
        throw new ReviewCoachValidationError("invalid-verification-source", "Delayed verification requires a matching completed self-assessment.");
      }
      if (verification.status !== "scheduled") throw new ReviewCoachValidationError("invalid-verification-status", "A new delayed verification must be scheduled.");
      await this.database.delayedVerifications.add(verification);
      await this.rebuildProjectionsInTransaction();
      await this.bumpMutation();
      return verification;
    });
  }

  async transitionVerification(id: string, status: DelayedVerificationStatus, updatedAt: string, outcome?: DelayedVerification["verificationOutcome"]): Promise<DelayedVerification> {
    return this.database.transaction("rw", [this.database.cloudSyncMutation, ...formalTables(this.database)], async () => {
      const current = await this.database.delayedVerifications.get(id);
      if (!current) throw new ReviewCoachValidationError("missing-verification", `Verification ${id} does not exist.`);
      transitionDelayedVerification(current.status, status);
      if (status === "completed" && !outcome) throw new ReviewCoachValidationError("missing-verification-outcome", "Completed verification requires an outcome.");
      if (status !== "completed" && outcome) throw new ReviewCoachValidationError("unexpected-verification-outcome", "Only completed verification can record an outcome.");
      const next = {
        ...current,
        status,
        verificationOutcome: status === "completed" ? outcome : current.verificationOutcome,
        lastVerifiedAt: status === "completed" ? updatedAt : current.lastVerifiedAt,
        updatedAt,
      };
      await this.database.delayedVerifications.put(next);
      await this.rebuildProjectionsInTransaction();
      await this.bumpMutation();
      return next;
    });
  }

  async queueVerification(verificationId: string, task: AdaptiveReviewTask, updatedAt: string): Promise<{ verification: DelayedVerification; task: AdaptiveReviewTask }> {
    return this.database.transaction("rw", [this.database.cloudSyncMutation, ...formalTables(this.database)], async () => {
      const verification = await this.database.delayedVerifications.get(verificationId);
      if (!verification) throw new ReviewCoachValidationError("missing-verification", `Verification ${verificationId} does not exist.`);
      if (verification.taskId) {
        const existingTask = await this.database.adaptiveReviewTasks.get(verification.taskId);
        if (!existingTask) throw new ReviewCoachValidationError("dangling-task", "Queued verification task is missing.");
        return { verification, task: existingTask };
      }
      if (!["eligible", "missed"].includes(verification.status) || verification.verificationDueAt > updatedAt) {
        throw new ReviewCoachValidationError("verification-not-due", "Only a due eligible verification can enter the task queue.");
      }
      const source = await this.database.taskOutcomeEvents.get(verification.sourceOutcomeEventId);
      const sourceTask = source ? await this.database.adaptiveReviewTasks.get(source.taskId) : undefined;
      if (!sourceTask || task.blueprintId !== sourceTask.blueprintId || task.priorityTier !== "due-verification" || task.status !== "waiting" || task.decisionBlockId !== verification.decisionBlockId || task.recordId !== verification.recordId || task.contentVersion !== verification.contentVersion) {
        throw new ReviewCoachValidationError("invalid-verification-task", "Verification task does not match its source intervention.");
      }
      assertCurrentDecisionBlockRef(await this.database.decisionBlocks.get(task.decisionBlockId), task);
      const normalized = { ...task, activeSlotKey: undefined, openTargetKey: openTargetKeyFor(task) };
      try {
        await this.database.adaptiveReviewTasks.add(normalized);
      } catch (error) {
        if (error instanceof Dexie.ConstraintError) throw new ReviewCoachValidationError("task-uniqueness", "Another open task already targets this block version.");
        throw error;
      }
      let nextStatus = verification.status;
      if (nextStatus === "missed") nextStatus = transitionDelayedVerification(nextStatus, "eligible");
      nextStatus = transitionDelayedVerification(nextStatus, "queued");
      const nextVerification = { ...verification, taskId: normalized.id, status: nextStatus, updatedAt };
      await this.database.delayedVerifications.put(nextVerification);
      await this.rebuildProjectionsInTransaction();
      await this.bumpMutation();
      return { verification: nextVerification, task: normalized };
    });
  }

  async completeVerification(taskId: string, events: TaskOutcomeEvent[], outcome: "retained" | "decayed", updatedAt: string): Promise<AdaptiveReviewTask> {
    if (events.length === 0) throw new ReviewCoachValidationError("missing-outcome-events", "Verification completion requires formal events.");
    events.forEach(assertTaskOutcomeShape);
    return this.database.transaction("rw", [this.database.cloudSyncMutation, ...formalTables(this.database)], async () => {
      const task = await this.database.adaptiveReviewTasks.get(taskId);
      const verification = await findVerificationForTask(this.database, taskId);
      if (!task || task.status !== "in-progress" || !verification || verification.status !== "in-progress") {
        throw new ReviewCoachValidationError("inactive-verification", "Verification task is not in progress.");
      }
      const answers = await this.database.adaptiveQuizTurns.where("taskId").equals(taskId).toArray();
      if (!answers.some((turn) => turn.status === "answered" && turn.answerText !== "[skipped]")) {
        throw new ReviewCoachValidationError("verification-without-answer", "Verification completion requires answer evidence.");
      }
      const selfAssessment = events.find((event) => event.kind === "self-assessment");
      const disposition = events.find((event) => event.kind === "task-disposition");
      const expectedSubjectiveOutcome = outcome === "retained" ? "mastered" : "not-mastered";
      if (selfAssessment?.subjectiveOutcome !== expectedSubjectiveOutcome || disposition?.disposition !== "completed") {
        throw new ReviewCoachValidationError("invalid-verification-outcome", "Verification events do not match the retained or decayed result.");
      }
      const taskStatus = outcome === "retained" ? "completed" as const : "not-achieved" as const;
      transitionAdaptiveReviewTask(task.status, taskStatus);
      for (const event of events) {
        if (event.taskId !== task.id || event.decisionBlockId !== task.decisionBlockId || event.recordId !== task.recordId || event.contentVersion !== task.contentVersion) {
          throw new ReviewCoachValidationError("dangling-task", "Verification outcome does not match its task.");
        }
        const existing = await ensureIdempotentInsert(this.database.taskOutcomeEvents, event);
        if (!existing) await this.database.taskOutcomeEvents.add(event);
      }
      const nextTask = { ...task, status: taskStatus, activeSlotKey: undefined, openTargetKey: undefined, endedAt: updatedAt, updatedAt };
      await this.database.adaptiveReviewTasks.put(nextTask);
      transitionDelayedVerification(verification.status, "completed");
      await this.database.delayedVerifications.put({ ...verification, status: "completed", verificationOutcome: outcome, lastVerifiedAt: updatedAt, updatedAt });
      await this.rebuildProjectionsInTransaction();
      await this.bumpMutation();
      return nextTask;
    });
  }

  async saveAiRoleConfig(config: AiRoleConfig): Promise<AiRoleConfig> {
    return this.database.transaction("rw", [this.database.aiRoleConfigs, this.database.cloudSyncMutation], async () => {
      const byRole = await this.database.aiRoleConfigs.where("role").equals(config.role).first();
      if (byRole && byRole.id !== config.id) throw new ReviewCoachValidationError("duplicate-ai-role", `AI role ${config.role} already has a configuration.`);
      await this.database.aiRoleConfigs.put(config);
      await this.bumpMutation();
      return config;
    });
  }

  async rebuildProjections(): Promise<{ states: DecisionBlockState[]; effects: InterventionEffectSummary[] }> {
    return this.database.transaction("rw", formalTables(this.database), () => this.rebuildProjectionsInTransaction());
  }

  async areProjectionsCurrent(): Promise<boolean> {
    const [snapshot, blocks, states, effects] = await Promise.all([
      getReviewCoachFormalSnapshot(this.database),
      this.database.decisionBlocks.toArray(),
      this.database.decisionBlockStates.toArray(),
      this.database.interventionEffectSummaries.toArray(),
    ]);
    const blockIds = new Set(blocks.map((block) => block.id));
    if (states.length !== blockIds.size || !states.every((state) => blockIds.has(state.decisionBlockId) && state.replayVersion === REVIEW_COACH_REPLAY_VERSION)) return false;
    const replayedAt = latestFactTime(snapshot);
    const expectedEffects = replayInterventionEffectSummaries({
      interpretations: snapshot.feedbackInterpretations,
      blueprints: snapshot.sessionBlueprints,
      tasks: snapshot.adaptiveReviewTasks,
      turns: snapshot.adaptiveQuizTurns,
      outcomes: snapshot.taskOutcomeEvents,
      verifications: snapshot.delayedVerifications,
      replayedAt,
    });
    const effectById = new Map(effects.map((effect) => [effect.id, effect]));
    return effects.length === expectedEffects.length
      && expectedEffects.every((expected) => effectById.get(expected.id)?.replayFingerprint === expected.replayFingerprint);
  }
}

export const reviewCoachRepository = new DexieReviewCoachRepository();
