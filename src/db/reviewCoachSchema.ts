import type { Transaction } from "dexie";

import type {
  CoachMigrationBackup,
  LegacyKnowledgePoint,
  LegacyKnowledgeRelation,
  LegacyLearningEvidence,
  LegacyRecordKnowledgePointLink,
} from "../features/reviewCoach/domain";

export const LEGACY_SCHEMA_16_STORES = {
  entries: "id, date, updatedAt, pinned, favorite",
  blocks: "id, date, type, order, updatedAt",
  templates: "id, title, updatedAt, createdAt",
  recordDrafts: "id, recordId, updatedAt",
  recordReviews: "id, recordId, status, nextReviewDate, lastReviewDate, updatedAt, [status+nextReviewDate]",
  recordReviewLogs: "id, recordId, reviewedAt, rating",
  recordReviewDayStats: "id, date, updatedAt, completedAt",
  mistakes: "id, subject, chapter, mastery, nextReviewAt, updatedAt, pinned, favorite",
  reviews: "id, mistakeId, dueAt, completedAt, stage",
  tags: "id, &name, parent",
  assets: "id, kind, fileName, updatedAt, generatedBy",
  studySessions: "id, date, subject, blockId",
  settings: "id",
  aiSessions: "id, sourceDate, updatedAt, createdAt",
  aiMessages: "id, sessionId, role, createdAt, updatedAt",
  aiAttachments: "id, sessionId, messageId, createdAt, updatedAt",
  aiSecrets: "id",
  restoreStagingAssets: "stagingId, sessionId, asset.id",
  knowledgePodcasts: "id, updatedAt, createdAt, scriptStatus, audioStatus",
  cloudSyncState: "id, userId",
  cloudSyncLedger: "id, entityType, cloudRevision",
  cloudSyncOperations: "id, operationId, userId, status, revision, updatedAt",
  cloudSyncMutation: "id",
  autoBackupState: "id",
  learningCoachSettings: "id",
  learningEvidence: "id, date, occurredAt, kind, subject, updatedAt",
  learningCoachSnapshots: "id, &date, updatedAt",
  learningCoachTasks: "id, date, status, snapshotId, issueKey, activeSlotKey, replanKey, knowledgePointId, updatedAt, [date+status]",
  learningCoachAiRuns: "id, date, status, snapshotId, requestedAt, updatedAt",
  knowledgePoints: "id, subject, status, normalizedKey, [subject+normalizedKey], updatedAt",
  recordKnowledgePointLinks: "id, recordId, knowledgePointId, status, [recordId+status], [knowledgePointId+status], updatedAt",
  knowledgePointExtractionRuns: "id, recordId, status, requestedAt, inputFingerprint, updatedAt",
  knowledgePointCoachSnapshots: "id, &date, updatedAt",
  knowledgeRelations: "id, fromKnowledgePointId, toKnowledgePointId, status, type, updatedAt, [fromKnowledgePointId+status], [toKnowledgePointId+status]",
} as const;

export const REVIEW_COACH_SCHEMA_17_STORES = {
  ...LEGACY_SCHEMA_16_STORES,
  decisionBlocks: "id, recordId, contentVersion, updatedAt, deletedAt, [recordId+deletedAt]",
  decisionBlockArchives: "id, decisionBlockId, recordId, contentVersion, archivedAt, &idempotencyKey, deletedAt",
  decisionBlockFeedback: "id, decisionBlockId, recordId, contentVersion, reviewLogId, occurredAt, &idempotencyKey, deletedAt, [decisionBlockId+contentVersion]",
  feedbackInterpretations: "id, &feedbackId, decisionBlockId, contentVersion, status, updatedAt, deletedAt",
  analysisQueueItems: "id, &feedbackId, decisionBlockId, contentVersion, status, batchId, updatedAt, deletedAt",
  analysisBatches: "id, status, requestedAt, &idempotencyKey, updatedAt, deletedAt",
  sessionBlueprints: "id, batchId, decisionBlockId, contentVersion, status, &idempotencyKey, updatedAt, deletedAt",
  adaptiveReviewTasks: "id, &blueprintId, decisionBlockId, contentVersion, status, &activeSlotKey, &openTargetKey, &idempotencyKey, updatedAt, deletedAt",
  adaptiveQuizTurns: "id, taskId, sequence, status, &idempotencyKey, &[taskId+sequence], displayedAt, updatedAt, deletedAt",
  taskOutcomeEvents: "id, taskId, turnId, decisionBlockId, contentVersion, kind, occurredAt, &idempotencyKey, deletedAt",
  delayedVerifications: "id, &sourceOutcomeEventId, decisionBlockId, contentVersion, status, verificationDueAt, &idempotencyKey, updatedAt, deletedAt",
  decisionBlockStates: "id, status, contentVersion, currentTaskId, pendingVerificationId, updatedAt",
  interventionEffectSummaries: "id, problemType, practiceType, evidenceStatus, updatedAt",
  aiRoleConfigs: "id, &role, providerId, updatedAt, deletedAt",
  coachMigrationBackups: "id, sourceVersion, createdAt",
} as const;

export const REVIEW_COACH_SCHEMA_18_STORES = {
  ...REVIEW_COACH_SCHEMA_17_STORES,
  adaptiveReviewTasks: "id, blueprintId, decisionBlockId, contentVersion, status, &activeSlotKey, &openTargetKey, &idempotencyKey, updatedAt, deletedAt",
} as const;

export const REVIEW_COACH_SCHEMA_19_STORES = {
  ...REVIEW_COACH_SCHEMA_18_STORES,
  learningCoachSettings: null,
  learningCoachSnapshots: null,
  learningCoachTasks: null,
  learningCoachAiRuns: null,
  knowledgePointExtractionRuns: null,
  knowledgePointCoachSnapshots: null,
} as const;

export const REVIEW_ANNOTATION_SCHEMA_20_STORES = {
  ...REVIEW_COACH_SCHEMA_19_STORES,
  reviewAnnotationDrafts: "id, recordId, [recordId+reviewOccurrenceKey], pendingClear, updatedAt",
} as const;

export const VOICE_RECALL_SCHEMA_21_STORES = {
  ...REVIEW_ANNOTATION_SCHEMA_20_STORES,
  voiceRecallSessions: "id, status, updatedAt, sourceKind",
  voiceRecallTurns: "id, sessionId, [sessionId+sequence], status, updatedAt",
  voiceRecallLocalHistory: "id, savedAt, sourceKind",
} as const;

const tableRows = async <T>(transaction: Transaction, name: string): Promise<T[]> => {
  if (!transaction.db.tables.some((table) => table.name === name)) return [];
  return transaction.table<T, string>(name).toArray();
};

export const buildSchema17MigrationBackup = async (transaction: Transaction): Promise<CoachMigrationBackup> => {
  const [
    blocks,
    recordReviews,
    recordReviewLogs,
    studySessions,
    learningEvidence,
    knowledgePoints,
    recordKnowledgePointLinks,
    knowledgeRelations,
  ] = await Promise.all([
    tableRows<Record<string, unknown>>(transaction, "blocks"),
    tableRows<Record<string, unknown>>(transaction, "recordReviews"),
    tableRows<Record<string, unknown>>(transaction, "recordReviewLogs"),
    tableRows<Record<string, unknown>>(transaction, "studySessions"),
    tableRows<LegacyLearningEvidence>(transaction, "learningEvidence"),
    tableRows<LegacyKnowledgePoint>(transaction, "knowledgePoints"),
    tableRows<LegacyRecordKnowledgePointLink>(transaction, "recordKnowledgePointLinks"),
    tableRows<LegacyKnowledgeRelation>(transaction, "knowledgeRelations"),
  ]);
  const confirmedEvidence = learningEvidence.filter((item) => item.origin === "user-confirmed-ai" || item.kind.endsWith("-confirmed"));
  const activeLinks = recordKnowledgePointLinks.filter((item) => item.status === "active");
  const confirmedRelations = knowledgeRelations.filter((item) => item.status === "confirmed");
  const hasLegacyCoachFacts = learningEvidence.length > 0 || knowledgePoints.length > 0 || recordKnowledgePointLinks.length > 0 || knowledgeRelations.length > 0;
  return {
    id: "schema-17",
    sourceVersion: hasLegacyCoachFacts ? 16 : 11,
    createdAt: new Date().toISOString(),
    status: "checkpointed",
    coreCounts: {
      blocks: blocks.length,
      recordReviews: recordReviews.length,
      recordReviewLogs: recordReviewLogs.length,
      studySessions: studySessions.length,
    },
    legacyLearningEvidence: confirmedEvidence,
    legacyKnowledgePoints: knowledgePoints,
    legacyRecordKnowledgePointLinks: activeLinks,
    legacyKnowledgeRelations: confirmedRelations,
  };
};

export const migrateToReviewCoachSchema17 = async (transaction: Transaction) => {
  const backup = await buildSchema17MigrationBackup(transaction);
  await transaction.table<CoachMigrationBackup, string>("coachMigrationBackups").put(backup);
  // Old Coach projections remain read-only. No record-level comment, candidate,
  // or unconfirmed extraction proposal is promoted into a block-level fact.
};

export const finalizeReviewCoachMigration = async (transaction: Transaction) => {
  const checkpoint = await transaction.table<CoachMigrationBackup, string>("coachMigrationBackups").get("schema-17")
    ?? await buildSchema17MigrationBackup(transaction);
  const [evidence, knowledgePoints, links, relations, blocks] = await Promise.all([
    tableRows<LegacyLearningEvidence>(transaction, "learningEvidence"),
    tableRows<LegacyKnowledgePoint>(transaction, "knowledgePoints"),
    tableRows<LegacyRecordKnowledgePointLink>(transaction, "recordKnowledgePointLinks"),
    tableRows<LegacyKnowledgeRelation>(transaction, "knowledgeRelations"),
    tableRows<{ id: string; type?: string }>(transaction, "blocks"),
  ]);
  const confirmedEvidence = evidence.filter((item) => item.origin === "user-confirmed-ai" || item.kind.endsWith("-confirmed"));
  const confirmedKnowledgePoints = knowledgePoints.filter((item) => item.status === "active");
  const knowledgePointIds = new Set(confirmedKnowledgePoints.map((item) => item.id));
  const recordIds = new Set(blocks.filter((item) => item.type === "record").map((item) => item.id));
  const confirmedLinks = links.filter((item) => item.status === "active" && recordIds.has(item.recordId) && knowledgePointIds.has(item.knowledgePointId));
  const confirmedRelations = relations.filter((item) => (
    item.status === "confirmed"
    && knowledgePointIds.has(item.fromKnowledgePointId)
    && knowledgePointIds.has(item.toKnowledgePointId)
  ));

  await Promise.all([
    transaction.table("learningEvidence").clear().then(() => transaction.table("learningEvidence").bulkPut(confirmedEvidence)),
    transaction.table("knowledgePoints").clear().then(() => transaction.table("knowledgePoints").bulkPut(confirmedKnowledgePoints)),
    transaction.table("recordKnowledgePointLinks").clear().then(() => transaction.table("recordKnowledgePointLinks").bulkPut(confirmedLinks)),
    transaction.table("knowledgeRelations").clear().then(() => transaction.table("knowledgeRelations").bulkPut(confirmedRelations)),
  ]);
  const completedAt = new Date().toISOString();
  await transaction.table<CoachMigrationBackup, string>("coachMigrationBackups").put({
    ...checkpoint,
    status: "completed",
    completedAt,
    formalCounts: {
      legacyLearningEvidence: confirmedEvidence.length,
      legacyKnowledgePoints: confirmedKnowledgePoints.length,
      legacyRecordKnowledgePointLinks: confirmedLinks.length,
      legacyKnowledgeRelations: confirmedRelations.length,
    },
  });
};
