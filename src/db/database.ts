import Dexie, { type Table } from "dexie";

import type {
  AdaptiveQuizTurn,
  AdaptiveReviewTask,
  AiRoleConfig,
  AnalysisBatch,
  AnalysisQueueItem,
  CoachMigrationBackup,
  DecisionBlock,
  DecisionBlockArchive,
  DecisionBlockFeedback,
  DecisionBlockState,
  DelayedVerification,
  FeedbackInterpretation,
  InterventionEffectSummary,
  LegacyKnowledgePoint,
  LegacyKnowledgeRelation,
  LegacyLearningEvidence,
  LegacyRecordKnowledgePointLink,
  SessionBlueprint,
  TaskOutcomeEvent,
} from "../features/reviewCoach/domain";

import type {
  AiChatAttachment,
  AiChatMessage,
  AiChatSession,
  AiSecret,
  AppSettings,
  Asset,
  AutoBackupStateRecord,
  CloudSyncLedgerRecord,
  CloudSyncOperationRecord,
  CloudSyncMutationRecord,
  CloudSyncStateRecord,
  Block,
  ContentTemplate,
  DailyPlan,
  DayEntry,
  KnowledgePodcast,
  MistakeCard,
  RecordDraft,
  RecordReviewDayStat,
  RecordReviewLog,
  RecordReviewState,
  ReviewSchedule,
  StudySession,
  Tag,
} from "../types";
import {
  DAILY_PLAN_SCHEMA_24_STORES,
  LEGACY_SCHEMA_16_STORES,
  REVIEW_COACH_SCHEMA_17_STORES,
  REVIEW_COACH_SCHEMA_18_STORES,
  REVIEW_COACH_SCHEMA_19_STORES,
  REVIEW_ANNOTATION_SCHEMA_20_STORES,
  REVIEW_COACH_SCHEMA_22_STORES,
  REVIEW_COACH_SCHEMA_23_STORES,
  VOICE_RECALL_SCHEMA_21_STORES,
  finalizeReviewCoachMigration,
  migrateToReviewCoachSchema17,
} from "./reviewCoachSchema";
import type { ReviewAnnotationDraft } from "../features/reviewAnnotations/domain";
import type { VoiceRecallLocalHistory, VoiceRecallSessionLocal, VoiceRecallTurnLocal } from "../features/voiceRecall/localTypes";
import type { ReviewCoachInteractionSegmentLocal } from "../features/reviewCoach/interactionTrace";

import { KNOWLEDGE_SCHEMA_25_STORES, type StoredKnowledgeEntity, type StoredKnowledgeRevision, type StoredKnowledgeConflict, type StoredKnowledgeRemote, type StoredKnowledgeCommand, type StoredKnowledgeDraft } from "../features/knowledgeLibrary/schema";
import type { KnowledgeLibrary, KnowledgeSyncState, KnowledgeBackupScope } from "../features/knowledgeLibrary/domain";

export interface RestoreStagingAsset {
  stagingId: string;
  sessionId: string;
  asset: Asset;
}

export class StudyJournalDatabase extends Dexie {
  knowledgeLibraries!: Table<KnowledgeLibrary, string>;
  knowledgeWorkspaces!: Table<StoredKnowledgeEntity, [string, string]>;
  knowledgeNodes!: Table<StoredKnowledgeEntity, [string, string]>;
  knowledgeReferences!: Table<StoredKnowledgeEntity, [string, string]>;
  knowledgeRevisions!: Table<StoredKnowledgeRevision, [string, string]>;
  knowledgeConflicts!: Table<StoredKnowledgeConflict, [string, string]>;
  knowledgeRemoteEntities!: Table<StoredKnowledgeRemote, [string, string]>;
  knowledgeCommands!: Table<StoredKnowledgeCommand, [string, string]>;
  knowledgeSyncState!: Table<KnowledgeSyncState, string>;
  knowledgeDrafts!: Table<StoredKnowledgeDraft, [string, string]>;
  knowledgeBackupScopes!: Table<KnowledgeBackupScope, string>;
  aiAttachments!: Table<AiChatAttachment, string>;
  aiSessions!: Table<AiChatSession, string>;
  aiMessages!: Table<AiChatMessage, string>;
  aiSecrets!: Table<AiSecret, string>;
  entries!: Table<DayEntry, string>;
  blocks!: Table<Block, string>;
  templates!: Table<ContentTemplate, string>;
  recordDrafts!: Table<RecordDraft, string>;
  recordReviews!: Table<RecordReviewState, string>;
  recordReviewLogs!: Table<RecordReviewLog, string>;
  recordReviewDayStats!: Table<RecordReviewDayStat, string>;
  mistakes!: Table<MistakeCard, string>;
  reviews!: Table<ReviewSchedule, string>;
  tags!: Table<Tag, string>;
  assets!: Table<Asset, string>;
  studySessions!: Table<StudySession, string>;
  settings!: Table<AppSettings, string>;
  restoreStagingAssets!: Table<RestoreStagingAsset, string>;
  knowledgePodcasts!: Table<KnowledgePodcast, string>;
  cloudSyncState!: Table<CloudSyncStateRecord, string>;
  cloudSyncLedger!: Table<CloudSyncLedgerRecord, string>;
  cloudSyncOperations!: Table<CloudSyncOperationRecord, string>;
  cloudSyncMutation!: Table<CloudSyncMutationRecord, string>;
  autoBackupState!: Table<AutoBackupStateRecord, string>;
  learningEvidence!: Table<LegacyLearningEvidence, string>;
  knowledgePoints!: Table<LegacyKnowledgePoint, string>;
  recordKnowledgePointLinks!: Table<LegacyRecordKnowledgePointLink, string>;
  knowledgeRelations!: Table<LegacyKnowledgeRelation, string>;
  decisionBlocks!: Table<DecisionBlock, string>;
  decisionBlockArchives!: Table<DecisionBlockArchive, string>;
  decisionBlockFeedback!: Table<DecisionBlockFeedback, string>;
  feedbackInterpretations!: Table<FeedbackInterpretation, string>;
  analysisQueueItems!: Table<AnalysisQueueItem, string>;
  analysisBatches!: Table<AnalysisBatch, string>;
  sessionBlueprints!: Table<SessionBlueprint, string>;
  adaptiveReviewTasks!: Table<AdaptiveReviewTask, string>;
  adaptiveQuizTurns!: Table<AdaptiveQuizTurn, string>;
  taskOutcomeEvents!: Table<TaskOutcomeEvent, string>;
  delayedVerifications!: Table<DelayedVerification, string>;
  decisionBlockStates!: Table<DecisionBlockState, string>;
  interventionEffectSummaries!: Table<InterventionEffectSummary, string>;
  aiRoleConfigs!: Table<AiRoleConfig, string>;
  coachMigrationBackups!: Table<CoachMigrationBackup, string>;
  reviewAnnotationDrafts!: Table<ReviewAnnotationDraft, string>;
  voiceRecallSessions!: Table<VoiceRecallSessionLocal, string>;
  voiceRecallTurns!: Table<VoiceRecallTurnLocal, string>;
  voiceRecallLocalHistory!: Table<VoiceRecallLocalHistory, string>;
  /**
   * Device-local Review Coach interaction trace. Measurement scaffolding only:
   * never a formal learning fact, never exported, never synced. See
   * src/features/reviewCoach/interactionTrace.ts.
   */
  reviewCoachInteractionSegments!: Table<ReviewCoachInteractionSegmentLocal, string>;
  /**
   * Daily plan rows. Completion is derived from whether `linkedRecordId` points
   * at a live record, so this table carries no status field. Soft-deleted rows
   * stay here forever (there is no purge task) - that is what keeps the "from
   * plan" attribution label on a log resolvable after its plan row is deleted.
   */
  dailyPlans!: Table<DailyPlan, string>;

  constructor(name = "study-journal-408") {
    super(name);
    this.version(1).stores({
      entries: "id, date, updatedAt, pinned, favorite",
      blocks: "id, date, type, order, updatedAt",
      mistakes: "id, subject, chapter, mastery, nextReviewAt, updatedAt, pinned, favorite",
      reviews: "id, mistakeId, dueAt, completedAt, stage",
      tags: "id, &name, parent",
      assets: "id, kind, fileName, updatedAt",
      studySessions: "id, date, subject, blockId",
      settings: "id",
    });
    this.version(2).stores({
      entries: "id, date, updatedAt, pinned, favorite",
      blocks: "id, date, type, order, updatedAt",
      mistakes: "id, subject, chapter, mastery, nextReviewAt, updatedAt, pinned, favorite",
      reviews: "id, mistakeId, dueAt, completedAt, stage",
      tags: "id, &name, parent",
      assets: "id, kind, fileName, updatedAt",
      studySessions: "id, date, subject, blockId",
      settings: "id",
      aiSessions: "id, sourceDate, updatedAt, createdAt",
      aiMessages: "id, sessionId, role, createdAt, updatedAt",
      aiSecrets: "id",
    });
    this.version(3).stores({
      entries: "id, date, updatedAt, pinned, favorite",
      blocks: "id, date, type, order, updatedAt",
      recordDrafts: "id, recordId, updatedAt",
      mistakes: "id, subject, chapter, mastery, nextReviewAt, updatedAt, pinned, favorite",
      reviews: "id, mistakeId, dueAt, completedAt, stage",
      tags: "id, &name, parent",
      assets: "id, kind, fileName, updatedAt",
      studySessions: "id, date, subject, blockId",
      settings: "id",
      aiSessions: "id, sourceDate, updatedAt, createdAt",
      aiMessages: "id, sessionId, role, createdAt, updatedAt",
      aiSecrets: "id",
    });
    this.version(4).stores({
      entries: "id, date, updatedAt, pinned, favorite",
      blocks: "id, date, type, order, updatedAt",
      recordDrafts: "id, recordId, updatedAt",
      mistakes: "id, subject, chapter, mastery, nextReviewAt, updatedAt, pinned, favorite",
      reviews: "id, mistakeId, dueAt, completedAt, stage",
      tags: "id, &name, parent",
      assets: "id, kind, fileName, updatedAt",
      studySessions: "id, date, subject, blockId",
      settings: "id",
      aiSessions: "id, sourceDate, updatedAt, createdAt",
      aiMessages: "id, sessionId, role, createdAt, updatedAt",
      aiAttachments: "id, sessionId, messageId, createdAt, updatedAt",
      aiSecrets: "id",
    });
    this.version(5).stores({
      entries: "id, date, updatedAt, pinned, favorite",
      blocks: "id, date, type, order, updatedAt",
      recordDrafts: "id, recordId, updatedAt",
      recordReviews: "id, recordId, status, nextReviewDate, lastReviewDate, updatedAt, [status+nextReviewDate]",
      recordReviewLogs: "id, recordId, reviewedAt, rating",
      recordReviewDayStats: "id, date, updatedAt, completedAt",
      mistakes: "id, subject, chapter, mastery, nextReviewAt, updatedAt, pinned, favorite",
      reviews: "id, mistakeId, dueAt, completedAt, stage",
      tags: "id, &name, parent",
      assets: "id, kind, fileName, updatedAt",
      studySessions: "id, date, subject, blockId",
      settings: "id",
      aiSessions: "id, sourceDate, updatedAt, createdAt",
      aiMessages: "id, sessionId, role, createdAt, updatedAt",
      aiAttachments: "id, sessionId, messageId, createdAt, updatedAt",
      aiSecrets: "id",
    });
    this.version(6).stores({
      entries: "id, date, updatedAt, pinned, favorite",
      blocks: "id, date, type, order, updatedAt",
      recordDrafts: "id, recordId, updatedAt",
      recordReviews: "id, recordId, status, nextReviewDate, lastReviewDate, updatedAt, [status+nextReviewDate]",
      recordReviewLogs: "id, recordId, reviewedAt, rating",
      recordReviewDayStats: "id, date, updatedAt, completedAt",
      mistakes: "id, subject, chapter, mastery, nextReviewAt, updatedAt, pinned, favorite",
      reviews: "id, mistakeId, dueAt, completedAt, stage",
      tags: "id, &name, parent",
      assets: "id, kind, fileName, updatedAt",
      studySessions: "id, date, subject, blockId",
      settings: "id",
      aiSessions: "id, sourceDate, updatedAt, createdAt",
      aiMessages: "id, sessionId, role, createdAt, updatedAt",
      aiAttachments: "id, sessionId, messageId, createdAt, updatedAt",
      aiSecrets: "id",
      restoreStagingAssets: "stagingId, sessionId, asset.id",
    });
    this.version(7).stores({
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
      assets: "id, kind, fileName, updatedAt",
      studySessions: "id, date, subject, blockId",
      settings: "id",
      aiSessions: "id, sourceDate, updatedAt, createdAt",
      aiMessages: "id, sessionId, role, createdAt, updatedAt",
      aiAttachments: "id, sessionId, messageId, createdAt, updatedAt",
      aiSecrets: "id",
      restoreStagingAssets: "stagingId, sessionId, asset.id",
    });
    this.version(8).stores({
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
    });
    this.version(9).stores({
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
    });
    this.version(10).stores({
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
      autoBackupState: "id",
    });
    this.version(11).stores({
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
    });
    this.version(16).stores(LEGACY_SCHEMA_16_STORES);
    this.version(17)
      .stores(REVIEW_COACH_SCHEMA_17_STORES)
      .upgrade(migrateToReviewCoachSchema17);
    this.version(18).stores(REVIEW_COACH_SCHEMA_18_STORES);
    this.version(19)
      .stores(REVIEW_COACH_SCHEMA_19_STORES)
      .upgrade(finalizeReviewCoachMigration);
    this.version(20).stores(REVIEW_ANNOTATION_SCHEMA_20_STORES);
    this.version(21).stores(VOICE_RECALL_SCHEMA_21_STORES);
    this.version(22).stores(REVIEW_COACH_SCHEMA_22_STORES);
    this.version(23).stores(REVIEW_COACH_SCHEMA_23_STORES);
    this.version(24).stores(DAILY_PLAN_SCHEMA_24_STORES);
    this.version(25).stores(KNOWLEDGE_SCHEMA_25_STORES);
  }
}

export const db = new StudyJournalDatabase();
