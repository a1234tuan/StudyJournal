export type CoachEntityId = string;
export type CoachIsoDateTime = string;

export interface CoachBaseEntity {
  id: CoachEntityId;
  createdAt: CoachIsoDateTime;
  updatedAt: CoachIsoDateTime;
  deletedAt?: CoachIsoDateTime;
}

export interface VersionedDecisionBlockRef {
  decisionBlockId: CoachEntityId;
  recordId: CoachEntityId;
  contentVersion: number;
}

export interface DecisionBlock extends CoachBaseEntity {
  recordId: CoachEntityId;
  contentVersion: number;
  position: number;
  contentUpdatedAt: CoachIsoDateTime;
}

export type DecisionBlockArchiveReason = "deleted" | "converted-to-plain" | "content-conflict";

export interface DecisionBlockArchive extends CoachBaseEntity, VersionedDecisionBlockRef {
  contentHtml: string;
  archivedAt: CoachIsoDateTime;
  reason: DecisionBlockArchiveReason;
  idempotencyKey: string;
}

export type DecisionBlockFeedbackSource = "review" | "manual" | "legacy-manual-link";

export interface DecisionBlockFeedback extends CoachBaseEntity, VersionedDecisionBlockRef {
  reviewLogId?: CoachEntityId;
  comment: string;
  includeInAnalysis: boolean;
  source: DecisionBlockFeedbackSource;
  occurredAt: CoachIsoDateTime;
  idempotencyKey: string;
}

export type FeedbackActionability = "needs_training" | "reflection_only" | "unclear";
export type FeedbackDifficultyType =
  | "concept"
  | "procedure"
  | "confusion"
  | "calculation"
  | "application"
  | "expression"
  | "other";
export type FeedbackInterpretationStatus =
  | "pending"
  | "running"
  | "succeeded"
  | "insufficient-context"
  | "failed"
  | "superseded";

export interface FeedbackInterpretation extends CoachBaseEntity {
  feedbackId: CoachEntityId;
  decisionBlockId: CoachEntityId;
  contentVersion: number;
  status: FeedbackInterpretationStatus;
  actionability?: FeedbackActionability;
  difficultyType?: FeedbackDifficultyType;
  stuckAt?: string | null;
  userHypothesis?: string | null;
  preferredPractice?: string | null;
  missingInformation: string[];
  confidence?: number;
  aiGenerated: boolean;
  userConfirmedAt?: CoachIsoDateTime;
  userEditedAt?: CoachIsoDateTime;
  model: string;
  provider: string;
  promptVersion: string;
  policyVersion: string;
  schemaVersion: number;
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
  requestId?: string;
  attemptCount?: number;
  errorCode?: string;
}

export type AnalysisQueueStatus = "eligible" | "excluded" | "batched" | "consumed" | "stale" | "deleted";
export type AnalysisEligibilityReason =
  | "user-feedback"
  | "replan-after-failure"
  | "delayed-verification-decay"
  | "manual-retry";

export interface AnalysisQueueItem extends CoachBaseEntity, VersionedDecisionBlockRef {
  feedbackId: CoachEntityId;
  status: AnalysisQueueStatus;
  eligibilityReason: AnalysisEligibilityReason;
  analysisNote?: string;
  batchId?: CoachEntityId;
  excludedAt?: CoachIsoDateTime;
  consumedAt?: CoachIsoDateTime;
}

export interface AnalysisInputRef extends VersionedDecisionBlockRef {
  queueItemId: CoachEntityId;
  feedbackId: CoachEntityId;
  interpretationId?: CoachEntityId;
}

export interface AnalysisSubBatch {
  id: CoachEntityId;
  inputRefs: AnalysisInputRef[];
  status: "pending" | "running" | "succeeded" | "failed" | "cancelled";
  estimatedTokens?: number;
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
  requestId?: string;
  attemptCount?: number;
  errorCode?: string;
}

export type AnalysisBatchStatus =
  | "draft"
  | "confirmed"
  | "running"
  | "succeeded"
  | "partial"
  | "failed"
  | "cancelled"
  | "stale";

export interface AnalysisBatch extends CoachBaseEntity {
  status: AnalysisBatchStatus;
  inputRefs: AnalysisInputRef[];
  subBatches: AnalysisSubBatch[];
  requestedAt?: CoachIsoDateTime;
  completedAt?: CoachIsoDateTime;
  finalSummary?: string;
  model: string;
  provider: string;
  promptVersion: string;
  policyVersion: string;
  schemaVersion: number;
  inputFingerprint: string;
  idempotencyKey: string;
  estimatedTokens?: number;
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
  allowCrossBlockSupport?: boolean;
  errorCode?: string;
}

export type AdaptivePracticeType =
  | "concept-question"
  | "calculation"
  | "distinction"
  | "cloze"
  | "variation"
  | "chunk-training"
  | "prerequisite-check";

export interface BlueprintEvidenceRef extends VersionedDecisionBlockRef {
  excerptHash: string;
  purpose: string;
}

export interface BlueprintBranch {
  when: "correct" | "partial" | "incorrect" | "skipped";
  nextStrategy: "continue" | "hint" | "explain" | "worked-example" | "prerequisite-check" | "finish";
}

export type SessionBlueprintStatus = "accepted" | "rejected" | "stale";

export interface SessionBlueprint extends CoachBaseEntity, VersionedDecisionBlockRef {
  batchId: CoachEntityId;
  status: SessionBlueprintStatus;
  supportingDecisionBlockIds: CoachEntityId[];
  feedbackIds: CoachEntityId[];
  interpretationIds: CoachEntityId[];
  problemHypothesis: string;
  hypothesisConfidence: number;
  objective: string;
  completionCriteria: string[];
  initialPracticeType: AdaptivePracticeType;
  initialDifficulty: 1 | 2 | 3 | 4 | 5;
  expectedKeyPoints: string[];
  branches: BlueprintBranch[];
  allowedStrategies: BlueprintBranch["nextStrategy"][];
  forbiddenScope: string[];
  evidence: BlueprintEvidenceRef[];
  maxTurns: number;
  maxRetriesPerTurn: number;
  maxEstimatedTokens: number;
  model: string;
  provider: string;
  promptVersion: string;
  policyVersion: string;
  schemaVersion: number;
  idempotencyKey: string;
}

export type AdaptiveReviewTaskStatus =
  | "waiting"
  | "current"
  | "in-progress"
  | "deferred"
  | "completed"
  | "not-achieved"
  | "invalid"
  | "abandoned"
  | "stale"
  | "deleted";
export type TaskPriorityTier =
  | "due-verification"
  | "repeated-difficulty"
  | "first-difficulty"
  | "consolidation";

export interface AdaptiveReviewTask extends CoachBaseEntity, VersionedDecisionBlockRef {
  blueprintId: CoachEntityId;
  status: AdaptiveReviewTaskStatus;
  priorityTier: TaskPriorityTier;
  queuedAt: CoachIsoDateTime;
  notBeforeAt?: CoachIsoDateTime;
  startedAt?: CoachIsoDateTime;
  endedAt?: CoachIsoDateTime;
  activeSlotKey?: "global-current";
  openTargetKey?: string;
  idempotencyKey: string;
  terminalReason?: string;
}

export type AdaptiveQuizTurnStatus = "displayed" | "answered" | "invalid";
export type ImmediateAnswerAssessment = "correct" | "partial" | "incorrect" | "unreliable";

/** Strongest hint level used inside an intervention group. Derived locally from `hintsUsed`
 *  (`QuizHintUsage.level` is 1-based and ordered weak → strong); never inferred from the model. */
export type EffectHintLevel = "none" | "hint-only" | "explain-or-worked-example";

export interface QuizHintUsage {
  level: number;
  requestedAt: CoachIsoDateTime;
}

export interface AdaptiveQuizTurn extends CoachBaseEntity, VersionedDecisionBlockRef {
  taskId: CoachEntityId;
  sequence: number;
  status: AdaptiveQuizTurnStatus;
  practiceType: AdaptivePracticeType;
  answerMode?: "open" | "objective" | "unique";
  question: string;
  displayedAt: CoachIsoDateTime;
  sourceEvidence: BlueprintEvidenceRef[];
  answerCriteria: string[];
  hintsUsed: QuizHintUsage[];
  availableHints?: string[];
  answerText?: string;
  answeredAt?: CoachIsoDateTime;
  assessment?: ImmediateAnswerAssessment;
  assessmentRationale?: string;
  qualityChecked: boolean;
  qualityModel?: string;
  generationModel: string;
  promptVersion: string;
  policyVersion: string;
  idempotencyKey: string;
}

export type SubjectiveOutcome = "mastered" | "needs-consolidation" | "not-mastered";
export type TaskDisposition = "completed" | "deferred" | "abandoned" | "question-invalid";
export type TaskOutcomeEventKind = "answer-assessment" | "self-assessment" | "task-disposition";

export interface TaskOutcomeEvent extends CoachBaseEntity, VersionedDecisionBlockRef {
  taskId: CoachEntityId;
  turnId?: CoachEntityId;
  kind: TaskOutcomeEventKind;
  answerAssessment?: ImmediateAnswerAssessment;
  subjectiveOutcome?: SubjectiveOutcome;
  disposition?: TaskDisposition;
  reason?: string;
  confirmedConflict?: boolean;
  occurredAt: CoachIsoDateTime;
  idempotencyKey: string;
}

export type DelayedVerificationStatus =
  | "scheduled"
  | "eligible"
  | "queued"
  | "in-progress"
  | "completed"
  | "missed"
  | "cancelled"
  | "stale";
export type DelayedVerificationOutcome = "retained" | "decayed" | "not-completed";

export interface DelayedVerification extends CoachBaseEntity, VersionedDecisionBlockRef {
  sourceOutcomeEventId: CoachEntityId;
  taskId?: CoachEntityId;
  status: DelayedVerificationStatus;
  verificationEligibleAt: CoachIsoDateTime;
  verificationDueAt: CoachIsoDateTime;
  lastVerifiedAt?: CoachIsoDateTime;
  verificationOutcome?: DelayedVerificationOutcome;
  strategyVersion: string;
  idempotencyKey: string;
}

export type DecisionBlockLearningStatus =
  | "unassessed"
  | "needs-analysis"
  | "planned"
  | "learning"
  | "improved-pending-verification"
  | "retained"
  | "needs-consolidation"
  | "not-mastered"
  | "stale";

export interface DecisionBlockState extends CoachBaseEntity, VersionedDecisionBlockRef {
  status: DecisionBlockLearningStatus;
  lastFeedbackAt?: CoachIsoDateTime;
  lastOutcomeAt?: CoachIsoDateTime;
  lastVerifiedAt?: CoachIsoDateTime;
  currentTaskId?: CoachEntityId;
  pendingVerificationId?: CoachEntityId;
  replayFingerprint: string;
  replayVersion: string;
}

export interface InterventionEffectSummary extends CoachBaseEntity {
  problemType: FeedbackDifficultyType;
  /** The blueprint's planned practice type. This is what the workbench label shows. */
  practiceType: AdaptivePracticeType;
  strategyKey: string;
  sampleFrom: CoachIsoDateTime;
  sampleTo: CoachIsoDateTime;
  sampleCount: number;
  recentSampleCount: number;
  recencyWeight: number;
  /** The practice type that actually dominated the turns of this group's tasks. Differs from
   *  `practiceType` whenever the blueprint branched away from its planned type. `"none"` when
   *  the tasks produced no turns at all. */
  actualPracticeType: AdaptivePracticeType | "none";
  /** Strongest hint level reached inside this group: no hints, level-1 hints only, or a
   *  level >= 2 hint (explanation / worked example). Derived locally from `hintsUsed`. */
  hintLevelUsed: EffectHintLevel;
  /** Self-reported "mastered" count. The user-facing retention figure is still derived from
   *  self-assessment only (D-1 option b); this is the canonical name for that count. */
  selfReportedMasteredCount: number;
  /** @deprecated Renamed to `selfReportedMasteredCount`. Kept so existing readers keep compiling. */
  immediateMasteredCount: number;
  delayedRetainedCount: number;
  delayedDecayedCount: number;
  retentionRate?: number;
  decayRate?: number;
  /**
   * Objective (AI-graded) answer evidence. Computed and persisted, but deliberately NOT
   * shown in the workbench (D-1 option b) and NOT used as the primary mastery figure.
   * It exists so the system can calibrate teaching internally and so a future UI decision
   * can surface it without a data migration.
   *
   * `unreliable` is excluded from every denominator: it mixes "the model could not judge"
   * with "the user skipped the turn" (`orchestrator.skipQuizTurn`), so counting it as a
   * wrong answer would penalise the user for the model's limits.
   */
  objectiveAnswerCount: number;
  objectiveCorrectCount: number;
  objectivePartialCount: number;
  objectiveIncorrectCount: number;
  objectiveUnreliableCount: number;
  objectiveCorrectRate?: number;
  /** Same objective measure restricted to delayed-verification turns (fresh retrieval). */
  verificationObjectiveCount: number;
  verificationObjectiveCorrectCount: number;
  verificationObjectiveCorrectRate?: number;
  /** Usability gate for the objective measure alone. Intentionally separate from
   *  `evidenceStatus`, which gates the primary (self-reported) figure. */
  objectiveEvidenceStatus: "insufficient" | "usable";
  /** Last-turn assessments of the tasks the user self-reported as mastered: answers
   *  "how far apart are the user's confidence and their actual performance". */
  masteryAssessmentBreakdown: { correct: number; partial: number; incorrect: number };
  averageTurnsToMastery?: number;
  averageHintsUsed?: number;
  deferredCount: number;
  abandonedCount: number;
  invalidQuestionCount: number;
  replanCount: number;
  deletedCount: number;
  confidence: number;
  evidenceStatus: "insufficient" | "usable";
  modelVersions: string[];
  promptVersions: string[];
  policyVersions: string[];
  replayFingerprint: string;
}

export type AiRole =
  | "feedback-interpreter"
  | "session-planner"
  | "turn-generator"
  | "question-quality-reviewer"
  | "answer-evaluator";

export interface AiRoleConfig extends CoachBaseEntity {
  role: AiRole;
  providerId: string;
  model: string;
  enabled: boolean;
  promptVersion: string;
  policyVersion: string;
  schemaVersion: number;
  timeoutMs: number;
  maxRetries: number;
  maxConcurrency: number;
}

export interface LegacyLearningEvidence extends CoachBaseEntity {
  date: string;
  occurredAt: CoachIsoDateTime;
  subject: string;
  kind: string;
  origin?: string;
  source?: Record<string, unknown>;
  target?: Record<string, unknown>;
  payload?: Record<string, unknown>;
}

export interface LegacyKnowledgePoint extends CoachBaseEntity {
  subject: string;
  name: string;
  normalizedKey: string;
  aliases?: string[];
  status: string;
}

export interface LegacyRecordKnowledgePointLink extends CoachBaseEntity {
  recordId: CoachEntityId;
  knowledgePointId: CoachEntityId;
  status: string;
  role?: string;
  confirmationSource?: string;
  confirmedAt?: CoachIsoDateTime;
  recordFingerprint?: string;
}

export interface LegacyKnowledgeRelation extends CoachBaseEntity {
  fromKnowledgePointId: CoachEntityId;
  toKnowledgePointId: CoachEntityId;
  status: string;
  type: string;
  origin?: string;
  confirmedAt?: CoachIsoDateTime;
  sourceRefs?: Array<Record<string, unknown>>;
}

export interface CoachMigrationBackup {
  id: "schema-17";
  sourceVersion: 11 | 16;
  createdAt: CoachIsoDateTime;
  completedAt?: CoachIsoDateTime;
  status?: "checkpointed" | "completed";
  coreCounts: Record<string, number>;
  formalCounts?: Record<string, number>;
  legacyLearningEvidence: LegacyLearningEvidence[];
  legacyKnowledgePoints: LegacyKnowledgePoint[];
  legacyRecordKnowledgePointLinks: LegacyRecordKnowledgePointLink[];
  legacyKnowledgeRelations: LegacyKnowledgeRelation[];
}

export interface ReviewCoachFormalSnapshot {
  decisionBlocks: DecisionBlock[];
  decisionBlockArchives: DecisionBlockArchive[];
  decisionBlockFeedback: DecisionBlockFeedback[];
  feedbackInterpretations: FeedbackInterpretation[];
  analysisQueueItems: AnalysisQueueItem[];
  analysisBatches: AnalysisBatch[];
  sessionBlueprints: SessionBlueprint[];
  adaptiveReviewTasks: AdaptiveReviewTask[];
  adaptiveQuizTurns: AdaptiveQuizTurn[];
  taskOutcomeEvents: TaskOutcomeEvent[];
  delayedVerifications: DelayedVerification[];
  aiRoleConfigs: AiRoleConfig[];
  legacyLearningEvidence: LegacyLearningEvidence[];
  legacyKnowledgePoints: LegacyKnowledgePoint[];
  legacyRecordKnowledgePointLinks: LegacyRecordKnowledgePointLink[];
  legacyKnowledgeRelations: LegacyKnowledgeRelation[];
}

export const EMPTY_REVIEW_COACH_FORMAL_SNAPSHOT: ReviewCoachFormalSnapshot = {
  decisionBlocks: [],
  decisionBlockArchives: [],
  decisionBlockFeedback: [],
  feedbackInterpretations: [],
  analysisQueueItems: [],
  analysisBatches: [],
  sessionBlueprints: [],
  adaptiveReviewTasks: [],
  adaptiveQuizTurns: [],
  taskOutcomeEvents: [],
  delayedVerifications: [],
  aiRoleConfigs: [],
  legacyLearningEvidence: [],
  legacyKnowledgePoints: [],
  legacyRecordKnowledgePointLinks: [],
  legacyKnowledgeRelations: [],
};
