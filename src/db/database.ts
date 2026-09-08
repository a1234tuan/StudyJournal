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
  LEGACY_SCHEMA_16_STORES,
  REVIEW_COACH_SCHEMA_17_STORES,
  REVIEW_COACH_SCHEMA_18_STORES,
  REVIEW_COACH_SCHEMA_19_STORES,
  REVIEW_ANNOTATION_SCHEMA_20_STORES,
  VOICE_RECALL_SCHEMA_21_STORES,
  finalizeReviewCoachMigration,
  migrateToReviewCoachSchema17,
} from "./reviewCoachSchema";
import type { ReviewAnnotationDraft } from "../features/reviewAnnotations/domain";
import type { VoiceRecallLocalHistory, VoiceRecallSessionLocal, VoiceRecallTurnLocal } from "../features/voiceRecall/localTypes";

export interface RestoreStagingAsset {
  stagingId: string;
  sessionId: string;
  asset: Asset;
}

export class StudyJournalDatabase extends Dexie {
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
  }
}

export const db = new StudyJournalDatabase();
