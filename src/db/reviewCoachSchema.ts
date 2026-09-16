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

/**
 * Schema 22 adds the device-local Review Coach interaction trace.
 *
 * This table is measurement scaffolding, not a learning fact. It must never be
 * added to `reviewCoachFormalTables` in repository.ts, and must stay out of ZIP
 * backups, streaming backup, native repository, record transfer, Firebase sync
 * and knowledge export. It stores phase labels and durations only - never
 * answers, page text, prompts or provider responses.
 */
export const REVIEW_COACH_SCHEMA_22_STORES = {
  ...VOICE_RECALL_SCHEMA_21_STORES,
  reviewCoachInteractionSegments: "id, taskId, recordId, screen, category, endedAt, [taskId+endedAt]",
} as const;

/**
 * Schema 23 indexes the v2 retry chain.
 *
 * `retryOfTaskId` / `replacedByTaskId` were already written by the v2
 * defer-and-requeue path, but they were not indexed, so looking up "does this
 * attempt already have a replacement?" meant loading every task. That lookup is
 * what makes requeue idempotent, so it needs an index. Both are plain
 * (non-unique) indexes: a task has at most one predecessor and at most one
 * successor, but Dexie cannot express that without breaking tasks that have
 * neither.
 */
export const REVIEW_COACH_SCHEMA_23_STORES = {
  ...REVIEW_COACH_SCHEMA_22_STORES,
  adaptiveReviewTasks: "id, blueprintId, decisionBlockId, contentVersion, status, &activeSlotKey, &openTargetKey, &idempotencyKey, retryOfTaskId, replacedByTaskId, updatedAt, deletedAt",
} as const;

/**
 * Schema 24 adds the "Daily Plan" feature: one new `dailyPlans` table.
 *
 * No existing table's indexes change, and no other store is redefined - this is
 * a pure additive migration. `deletedAt` is deliberately not indexed (a handful
 * of rows per day; in-memory filtering is free at this scale) even though other
 * tables such as `decisionBlocks` do index it. `blocks` does not gain a `planId`
 * index either: records are already loaded in full by `refresh()`, so an index
 * would only force a large table rebuild for zero query benefit.
 * See docs/daily-plan-final-plan-2026-09-16.md section 2.4.
 */
export const DAILY_PLAN_SCHEMA_24_STORES = {
  ...REVIEW_COACH_SCHEMA_23_STORES,
  dailyPlans: "id, date, updatedAt, createdAt, linkedRecordId",
} as const;

/**
 * The current Dexie schema version.
 *
 * Tests assert against this rather than a literal, so adding a migration does
 * not require editing every "reopen and check the version" test.
 *
 * Warning: this migration is one-way. Dexie throws `VersionError` when the
 * stored version is higher than the declared one, and this repository has no
 * handler for it - so once any device has opened schema 24, `version(24)` must
 * never be removed. See docs/daily-plan-final-plan-2026-09-16.md section 12.
 */
export const REVIEW_COACH_SCHEMA_VERSION = 24;

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
