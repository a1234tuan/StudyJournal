import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { ActionableError } from "../lib/uiError";

import type {
  AppSettings,
  Asset,
  AutoBackupSettings,
  Block,
  ContentTemplate,
  DayEntry,
  KnowledgePodcast,
  RecordBlock,
  RecordReviewBulkResult,
  RecordReviewDayStat,
  RecordReviewDecisionBlockFeedbackInput,
  RecordReviewLog,
  RecordReviewKind,
  RecordReviewRating,
  RecordReviewState,
  RecordReviewStats,
  RecordReviewUndoToken,
  RecordSaveOptions,
  Subject,
  SubjectConfig,
} from "../types";
import { storage } from "../services/storageAdapter";
import { createBaseEntity, newId } from "../lib/entity";
import { nowISO, todayISO } from "../lib/date";
import { createTemplateBlocks } from "../db/defaults";
import { extractDecisionBlocks, renewDecisionBlockIdentitiesInHtml } from "../features/reviewCoach/decisionBlockContent";
import {
  createSubjectConfig,
  fallbackSubjectName,
  getActiveSubjects,
  getAllSubjects,
  nextRecordTitle,
  normalizeSubject,
  validateSubjectName,
} from "../lib/subjects";
import { enqueueAutoOcrForRecord } from "../services/ocrJobService";
import { flushAutoBackupNow, markAutoBackupDirty } from "../services/autoBackupService";
import { cancelAllKnowledgePodcastJobs, recoverKnowledgePodcastJobs, subscribeKnowledgePodcastJobs, syncNativeKnowledgePodcastTtsJobs } from "../services/knowledgePodcastJobService";
import { cleanupCloudRecoverySnapshotsIfDue, getCurrentCloudUser } from "../services/cloudSyncService";
import { EMPTY_REVIEW_COACH_FORMAL_SNAPSHOT, type AnalysisQueueStatus, type ReviewCoachFormalSnapshot } from "../features/reviewCoach/domain";
import type { FeedbackInterpretation } from "../features/reviewCoach/domain";
import { ReviewCoachOrchestrator } from "../features/reviewCoach/orchestrator";
import { reviewCoachRepository } from "../features/reviewCoach/repository";
import { voiceRecallRepository } from "../features/voiceRecall/repository";
import { createFeedbackInterpretationGateway, defaultFeedbackInterpretationMetadata } from "../features/reviewCoach/aiGateway";
import { processFeedbackInterpretationQueue } from "../features/reviewCoach/feedbackInterpretationWorker";
import { getCurrentAiProvider } from "../lib/aiProviders";
import { buildAnalysisPlanningBlocks, maxAnalysisInputTokensForProvider, type AnalysisPlanningBlock } from "../features/reviewCoach/analysisPlanner";
import { createSessionPlanningGateway, defaultSessionPlanningMetadata } from "../features/reviewCoach/sessionPlanningGateway";
import { createQuizExecutionGateway, defaultQuizExecutionMetadata } from "../features/reviewCoach/quizExecutionGateway";
import { buildDecisionBlockAiContextPack } from "../services/aiContextService";
import type { SubjectiveOutcome } from "../features/reviewCoach/domain";

const reviewCoachOrchestrator = new ReviewCoachOrchestrator({
  repository: reviewCoachRepository,
  ids: { next: newId },
  clock: { now: nowISO },
});

export const useAppData = () => {
  const [initialized, setInitialized] = useState(false);
  const [entries, setEntries] = useState<DayEntry[]>([]);
  const [blocks, setBlocks] = useState<Block[]>([]);
  const [assets, setAssets] = useState<Asset[]>([]);
  const [templates, setTemplates] = useState<ContentTemplate[]>([]);
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [autoBackupState, setAutoBackupState] = useState<AutoBackupSettings | null>(null);
  const [podcasts, setPodcasts] = useState<KnowledgePodcast[]>([]);
  const [deletedRecords, setDeletedRecords] = useState<RecordBlock[]>([]);
  const [recordReviews, setRecordReviews] = useState<RecordReviewState[]>([]);
  const [dueRecordReviews, setDueRecordReviews] = useState<RecordReviewState[]>([]);
  const [recordReviewLogs, setRecordReviewLogs] = useState<RecordReviewLog[]>([]);
  const [recordReviewStats, setRecordReviewStats] = useState<RecordReviewStats | null>(null);
  const [reviewCoachSnapshot, setReviewCoachSnapshot] = useState<ReviewCoachFormalSnapshot>(EMPTY_REVIEW_COACH_FORMAL_SNAPSHOT);
  const [assetsVersion, setAssetsVersion] = useState(0);
  const [interpretationRuntimeReady, setInterpretationRuntimeReady] = useState(
    () => typeof document === "undefined" || (document.visibilityState === "visible" && navigator.onLine),
  );
  const interpretationAbortControllersRef = useRef(new Set<AbortController>());

  const refresh = useCallback(async () => {
    const [entryList, blockList, templateList, currentSettings, assetList, deletedList, reviewList, dueReviews, reviewLogs, reviewStats, podcastList, currentAutoBackupState, coachSnapshot, allInterpretations] = await Promise.all([
      storage.listEntries(),
      storage.listBlocks(),
      storage.listTemplates(),
      storage.getSettings(),
      storage.listAssets(),
      storage.listDeletedBlocks(),
      storage.listRecordReviews(),
      storage.listDueRecordReviews(todayISO()),
      storage.listRecordReviewLogs(),
      storage.getRecordReviewStats(todayISO()),
      storage.listKnowledgePodcasts?.() ?? Promise.resolve([]),
      storage.getAutoBackupState(),
      reviewCoachRepository.getFormalSnapshot(),
      reviewCoachRepository.listFeedbackInterpretations(),
    ]);
    setEntries(entryList);
    setBlocks(blockList);
    setTemplates(templateList);
    setSettings(currentSettings);
    setAutoBackupState(currentAutoBackupState);
    setAssets(assetList);
    setDeletedRecords(deletedList);
    setRecordReviews(reviewList);
    setDueRecordReviews(dueReviews);
    setRecordReviewLogs(reviewLogs);
    setRecordReviewStats(reviewStats);
    setPodcasts(podcastList);
    setReviewCoachSnapshot({ ...coachSnapshot, feedbackInterpretations: allInterpretations });
  }, []);

  const runFeedbackInterpretations = useCallback(async (feedbackIds: readonly string[], force = false) => {
    if (feedbackIds.length === 0 || (typeof document !== "undefined" && (document.visibilityState !== "visible" || !navigator.onLine))) return;
    const currentSettings = await storage.getSettings();
    const provider = getCurrentAiProvider(currentSettings.ai);
    const apiKey = provider ? (await storage.getAiSecret?.(provider.id))?.apiKey : undefined;
    if (!provider || !apiKey?.trim()) return;
    const [snapshot, allInterpretations] = await Promise.all([
      reviewCoachRepository.getFormalSnapshot(),
      reviewCoachRepository.listFeedbackInterpretations(),
    ]);
    const interpretationByFeedbackId = new Map(allInterpretations.map((item) => [item.feedbackId, item]));
    const recordById = new Map(
      blocks
        .filter((block): block is RecordBlock => block.type === "record")
        .map((record) => [record.id, record]),
    );
    const jobs = feedbackIds.flatMap((feedbackId) => {
      const feedback = snapshot.decisionBlockFeedback.find((item) => item.id === feedbackId && !item.deletedAt);
      if (!feedback) return [];
      const existingInterpretation = interpretationByFeedbackId.get(feedback.id);
      if (existingInterpretation && ["succeeded", "insufficient-context"].includes(existingInterpretation.status)) return [];
      if (existingInterpretation?.status === "failed" && !force) return [];
      const record = recordById.get(feedback.recordId);
      const content = record
        ? extractDecisionBlocks(record.contentHtml, record.updatedAt).find((item) => item.decisionBlockId === feedback.decisionBlockId)?.innerHtml
        : undefined;
      if (!content) return [];
      return [{
        feedbackId,
        decisionBlockContent: content,
        provider: provider.providerName,
        model: provider.model,
        ...defaultFeedbackInterpretationMetadata,
        maxRetries: 2,
      }];
    });
    if (jobs.length === 0) return;
    const abortController = new AbortController();
    interpretationAbortControllersRef.current.add(abortController);
    const gateway = createFeedbackInterpretationGateway({ provider, apiKey, timeoutMs: 30_000 });
    const orchestrator = new ReviewCoachOrchestrator({
      repository: reviewCoachRepository,
      ids: { next: newId },
      clock: { now: nowISO },
      aiGateway: {
        interpretFeedback: gateway.interpretFeedback,
        planSession: async () => { throw new Error("Session planning is not part of Stage 4."); },
        generateTurn: async () => { throw new Error("Turn generation is not part of Stage 4."); },
        reviewQuestion: async () => { throw new Error("Question review is not part of Stage 4."); },
        evaluateAnswer: async () => { throw new Error("Answer evaluation is not part of Stage 4."); },
      },
    });
    try {
      await processFeedbackInterpretationQueue(
        orchestrator,
        jobs.map((job) => ({ ...job, signal: abortController.signal })),
        { maxConcurrency: 1 },
      );
    } finally {
      interpretationAbortControllersRef.current.delete(abortController);
      await refresh();
    }
  }, [blocks, refresh]);

  useEffect(() => {
    let mounted = true;
    void storage.initialize().then(async () => {
      if (!mounted) {
        return;
      }
      await recoverKnowledgePodcastJobs();
      if (reviewCoachRepository.areProjectionsCurrent && !(await reviewCoachRepository.areProjectionsCurrent())) await reviewCoachRepository.rebuildProjections();
      const refreshedVerifications = await reviewCoachOrchestrator.refreshDueVerifications();
      if (refreshedVerifications > 0) await markAutoBackupDirty("review-coach-delayed-verification-refresh");
      await refresh();
      setInitialized(true);
      await storage.purgeExpiredDeletedBlocks(30);
      if (!mounted) {
        return;
      }
      await refresh();
      await flushAutoBackupNow("app-start");
      if (!mounted) {
        return;
      }
      await refresh();
    });
    return () => {
      mounted = false;
    };
  }, [refresh]);

  useEffect(() => {
    const syncRuntime = () => {
      const ready = document.visibilityState === "visible" && navigator.onLine;
      setInterpretationRuntimeReady(ready);
      if (!ready) interpretationAbortControllersRef.current.forEach((controller) => controller.abort());
    };
    document.addEventListener("visibilitychange", syncRuntime);
    window.addEventListener("online", syncRuntime);
    window.addEventListener("offline", syncRuntime);
    return () => {
      document.removeEventListener("visibilitychange", syncRuntime);
      window.removeEventListener("online", syncRuntime);
      window.removeEventListener("offline", syncRuntime);
      interpretationAbortControllersRef.current.forEach((controller) => controller.abort());
      interpretationAbortControllersRef.current.clear();
    };
  }, []);

  useEffect(() => {
    if (!initialized) return;
    const interpretationsByFeedbackId = new Map(reviewCoachSnapshot.feedbackInterpretations.map((item) => [item.feedbackId, item]));
    const pendingIds = reviewCoachSnapshot.analysisQueueItems
      .filter((item) => item.status === "eligible" && !["succeeded", "insufficient-context", "failed"].includes(interpretationsByFeedbackId.get(item.feedbackId)?.status ?? ""))
      .map((item) => item.feedbackId);
    if (pendingIds.length > 0) void runFeedbackInterpretations(pendingIds).catch(() => undefined);
  }, [initialized, interpretationRuntimeReady, reviewCoachSnapshot.analysisQueueItems, reviewCoachSnapshot.feedbackInterpretations, runFeedbackInterpretations]);

  const todayEntry = useMemo(
    () => entries.find((entry) => entry.date === todayISO()) ?? null,
    [entries],
  );

  const todayBlocks = useMemo(
    () => blocks.filter((block) => block.date === todayISO() && block.type === "record").sort((a, b) => a.order - b.order),
    [blocks],
  );

  const recordBlocks = useMemo(
    () => blocks.filter((block): block is RecordBlock => block.type === "record" && !block.deletedAt),
    [blocks],
  );

  const subjects = useMemo(
    () => (settings ? getAllSubjects(settings, recordBlocks) : []),
    [recordBlocks, settings],
  );

  const activeSubjects = useMemo(
    () => (settings ? getActiveSubjects(settings) : []),
    [settings],
  );

  const ensureEntry = useCallback(
    async (date: string) => {
      const entry = await storage.getOrCreateEntry(date);
      await refresh();
      return entry;
    },
    [refresh],
  );

  const saveEntry = useCallback(
    async (entry: DayEntry) => {
      await storage.saveEntry(entry);
      await refresh();
      await markAutoBackupDirty("entry");
    },
    [refresh],
  );

  const saveBlock = useCallback(
    async (block: Block, options?: RecordSaveOptions) => {
      const saved = await storage.saveBlock(block, options);
      await refresh();
      await markAutoBackupDirty("block");
      if (saved.type === "record") {
        enqueueAutoOcrForRecord(saved, { onAssetChanged: refresh });
      }
    },
    [refresh],
  );

  const deleteBlock = useCallback(
    async (blockId: string) => {
      await storage.deleteBlock(blockId);
      // Voice sessions/history that referenced this record are no longer resumable.
      await voiceRecallRepository.markSourceUnavailable({ recordId: blockId }).catch(() => undefined);
      await refresh();
      await markAutoBackupDirty("delete-block");
    },
    [refresh],
  );

  const restoreBlock = useCallback(
    async (blockId: string) => {
      await storage.restoreBlock(blockId);
      await refresh();
      await markAutoBackupDirty("restore-block");
    },
    [refresh],
  );

  const permanentlyDeleteBlock = useCallback(
    async (blockId: string) => {
      await storage.permanentlyDeleteBlock(blockId);
      await voiceRecallRepository.markSourceUnavailable({ recordId: blockId }).catch(() => undefined);
      await refresh();
      await markAutoBackupDirty("permanent-delete-block");
    },
    [refresh],
  );

  const purgeExpiredDeletedBlocks = useCallback(
    async (retentionDays = 30) => {
      const purged = await storage.purgeExpiredDeletedBlocks(retentionDays);
      if (purged > 0) {
        await refresh();
        await markAutoBackupDirty("purge-trash");
      }
      return purged;
    },
    [refresh],
  );

  const toggleRecordFavorite = useCallback(
    async (recordId: string, favorite: boolean) => {
      await storage.toggleRecordFavorite(recordId, favorite);
      await refresh();
      await markAutoBackupDirty("record-favorite");
    },
    [refresh],
  );

  const getRecordDraft = useCallback(async (recordId: string) => storage.getRecordDraft(recordId), []);

  const saveRecordDraft = useCallback(async (draft: Parameters<typeof storage.saveRecordDraft>[0]) => {
    const saved = await storage.saveRecordDraft(draft);
    await markAutoBackupDirty("record-draft");
    return saved;
  }, []);

  const deleteRecordDraft = useCallback(async (recordId: string) => {
    await storage.deleteRecordDraft(recordId);
    await markAutoBackupDirty("record-draft-delete");
  }, []);

  const addRecordToReview = useCallback(
    async (recordId: string, kind?: RecordReviewKind) => {
      const saved = await storage.addRecordToReview(recordId, kind);
      await refresh();
      if (saved) {
        await markAutoBackupDirty("record-review-add");
      }
      return saved;
    },
    [refresh],
  );

  const addRecordsToReview = useCallback(
    async (recordIds: string[], kind?: RecordReviewKind): Promise<RecordReviewBulkResult> => {
      const result = await storage.addRecordsToReview(recordIds, kind);
      await refresh();
      if (result.added + result.reset > 0) {
        await markAutoBackupDirty("record-review-bulk-add");
      }
      return result;
    },
    [refresh],
  );

  const setRecordReviewKind = useCallback(
    async (recordId: string, kind: RecordReviewKind) => {
      const saved = await storage.setRecordReviewKind(recordId, kind);
      await refresh();
      if (saved) {
        await markAutoBackupDirty("record-review-kind");
      }
      return saved;
    },
    [refresh],
  );

  const rateRecordReview = useCallback(
    async (recordId: string, rating: RecordReviewRating, feedback?: readonly RecordReviewDecisionBlockFeedbackInput[]) => {
      const result = feedback && feedback.length > 0
        ? await storage.rateRecordReview(recordId, rating, undefined, undefined, feedback)
        : await storage.rateRecordReview(recordId, rating);
      await refresh();
      if (result) {
        await markAutoBackupDirty("record-review-rate");
        const feedbackIds = result.undoToken.decisionBlockFeedbackIds ?? [];
        if (feedbackIds.length > 0) void runFeedbackInterpretations(feedbackIds).catch(() => undefined);
      }
      return result;
    },
    [refresh, runFeedbackInterpretations],
  );

  const analysisPlanningBlocks = useMemo(() => buildAnalysisPlanningBlocks({
    snapshot: reviewCoachSnapshot,
    records: recordBlocks,
    assets,
    reviewLogs: recordReviewLogs,
  }), [assets, recordBlocks, recordReviewLogs, reviewCoachSnapshot]);

  const executeDeepAnalysis = useCallback(async (
    planningBlocks: AnalysisPlanningBlock[],
    allowCrossBlockSupport: boolean,
    operationId: string,
  ) => {
    if (planningBlocks.length === 0) throw new Error("没有可分析的复习重点。");
    if (typeof document !== "undefined" && (document.visibilityState !== "visible" || !navigator.onLine)) {
      throw new Error("请回到前台并联网后再开始深度分析。");
    }
    const currentSettings = await storage.getSettings();
    const provider = getCurrentAiProvider(currentSettings.ai);
    const apiKey = provider ? (await storage.getAiSecret?.(provider.id))?.apiKey : undefined;
    if (!provider || !apiKey?.trim()) throw new ActionableError("请先在设置中配置当前 AI 供应商和 API Key。");
    const stamp = nowISO();
    const currentRoleConfig = reviewCoachSnapshot.aiRoleConfigs.find((item) => item.role === "session-planner" && !item.deletedAt);
    await reviewCoachRepository.saveAiRoleConfig({
      id: currentRoleConfig?.id ?? "ai-role:session-planner",
      role: "session-planner",
      providerId: provider.id,
      model: provider.model,
      enabled: true,
      ...defaultSessionPlanningMetadata,
      timeoutMs: 90_000,
      maxRetries: 1,
      maxConcurrency: 1,
      createdAt: currentRoleConfig?.createdAt ?? stamp,
      updatedAt: stamp,
    });
    const controller = new AbortController();
    interpretationAbortControllersRef.current.add(controller);
    const gateway = createSessionPlanningGateway({ provider, apiKey, timeoutMs: 90_000 });
    const orchestrator = new ReviewCoachOrchestrator({
      repository: reviewCoachRepository,
      ids: { next: newId },
      clock: { now: nowISO },
      aiGateway: {
        interpretFeedback: async () => { throw new Error("Feedback interpretation is not part of Stage 5 analysis."); },
        planSession: gateway.planSession,
        generateTurn: async () => { throw new Error("Turn generation is not part of Stage 5."); },
        reviewQuestion: async () => { throw new Error("Question review is not part of Stage 5."); },
        evaluateAnswer: async () => { throw new Error("Answer evaluation is not part of Stage 5."); },
      },
    });
    try {
      const result = await orchestrator.analyzeFeedback({
        blocks: planningBlocks,
        maxInputTokens: maxAnalysisInputTokensForProvider(provider),
        allowCrossBlockSupport,
        provider: provider.providerName,
        model: provider.model,
        ...defaultSessionPlanningMetadata,
        operationId,
        maxRetries: 1,
        signal: controller.signal,
      });
      await markAutoBackupDirty("review-coach-deep-analysis");
      return result;
    } finally {
      interpretationAbortControllersRef.current.delete(controller);
      await refresh();
    }
  }, [refresh, reviewCoachSnapshot.aiRoleConfigs]);

  const runDeepAnalysis = useCallback(async (decisionBlockIds: readonly string[], allowCrossBlockSupport: boolean) => {
    const selected = new Set(decisionBlockIds);
    return executeDeepAnalysis(analysisPlanningBlocks.filter((item) => selected.has(item.decisionBlockId)), allowCrossBlockSupport, newId());
  }, [analysisPlanningBlocks, executeDeepAnalysis]);

  const resumeDeepAnalysis = useCallback(async (batchId: string) => {
    const batch = reviewCoachSnapshot.analysisBatches.find((item) => item.id === batchId && ["confirmed", "running"].includes(item.status));
    if (!batch) throw new Error("没有可继续的分析批次。");
    const queueIds = new Set(batch.inputRefs.map((item) => item.queueItemId));
    const blockIds = new Set(batch.inputRefs.map((item) => item.decisionBlockId));
    const planningBlocks = buildAnalysisPlanningBlocks({
      snapshot: reviewCoachSnapshot,
      records: recordBlocks,
      assets,
      reviewLogs: recordReviewLogs,
      includeQueueItemIds: queueIds,
    }).filter((item) => blockIds.has(item.decisionBlockId));
    return executeDeepAnalysis(
      planningBlocks,
      Boolean(batch.allowCrossBlockSupport),
      batch.idempotencyKey.startsWith("analysis:") ? batch.idempotencyKey.slice("analysis:".length) : batch.id,
    );
  }, [assets, executeDeepAnalysis, recordBlocks, recordReviewLogs, reviewCoachSnapshot]);

  const switchAdaptiveTask = useCallback(async (taskId: string) => {
    const updated = await reviewCoachOrchestrator.switchCurrentTask(taskId);
    await refresh();
    await markAutoBackupDirty("review-coach-task-switch");
    return updated;
  }, [refresh]);

  const deferAdaptiveTask = useCallback(async (taskId: string) => {
    const updated = await reviewCoachOrchestrator.deferTask(taskId, newId());
    await refresh();
    await markAutoBackupDirty("review-coach-task-defer");
    return updated;
  }, [refresh]);

  const createQuizOrchestrator = useCallback(async () => {
    const currentSettings = await storage.getSettings();
    const provider = getCurrentAiProvider(currentSettings.ai);
    const apiKey = provider ? (await storage.getAiSecret?.(provider.id))?.apiKey : undefined;
    if (!provider || !apiKey?.trim()) throw new ActionableError("请先在设置中配置当前 AI 供应商和 API Key。");
    const stamp = nowISO();
    const roleSpecs = [
      { role: "turn-generator" as const, promptVersion: defaultQuizExecutionMetadata.quizTurnPromptVersion },
      { role: "question-quality-reviewer" as const, promptVersion: defaultQuizExecutionMetadata.questionQualityPromptVersion },
      { role: "answer-evaluator" as const, promptVersion: defaultQuizExecutionMetadata.answerEvaluationPromptVersion },
    ];
    const roleTimeouts: Partial<Record<typeof roleSpecs[number]["role"], number>> = {};
    for (const spec of roleSpecs) {
      const existing = reviewCoachSnapshot.aiRoleConfigs.find((item) => item.role === spec.role && !item.deletedAt);
      // The persisted timeout is authoritative so the stored config is not a lie.
      const timeoutMs = existing?.timeoutMs ?? 60_000;
      roleTimeouts[spec.role] = timeoutMs;
      await reviewCoachRepository.saveAiRoleConfig({
        id: existing?.id ?? `ai-role:${spec.role}`, role: spec.role, providerId: provider.id, model: provider.model, enabled: true,
        promptVersion: spec.promptVersion, policyVersion: defaultQuizExecutionMetadata.policyVersion, schemaVersion: defaultQuizExecutionMetadata.schemaVersion,
        // Quiz calls are single-attempt; the orchestrator's second pass is a
        // question-quality regeneration, not a network retry.
        timeoutMs, maxRetries: 0, maxConcurrency: 1, createdAt: existing?.createdAt ?? stamp, updatedAt: stamp,
      });
    }
    const gateway = createQuizExecutionGateway({ provider, apiKey, roleTimeouts });
    return {
      provider,
      orchestrator: new ReviewCoachOrchestrator({
        repository: reviewCoachRepository, ids: { next: newId }, clock: { now: nowISO },
        aiGateway: {
          interpretFeedback: async () => { throw new Error("Not part of Stage 6."); },
          planSession: async () => { throw new Error("Not part of Stage 6."); },
          ...gateway,
        },
      }),
    };
  }, [reviewCoachSnapshot.aiRoleConfigs]);

  const generateAdaptiveQuizTurn = useCallback(async (taskId: string, signal?: AbortSignal) => {
    const task = reviewCoachSnapshot.adaptiveReviewTasks.find((item) => item.id === taskId);
    const record = task ? recordBlocks.find((item) => item.id === task.recordId) : undefined;
    if (!task || !record) throw new Error("当前任务的学习记录不存在。");
    const context = buildDecisionBlockAiContextPack(record, task.decisionBlockId, assets).markdown;
    const { provider, orchestrator } = await createQuizOrchestrator();
    try {
      return await orchestrator.generateQuizTurn({
        taskId, decisionBlockContent: context, provider: provider.providerName, model: provider.model,
        promptVersion: defaultQuizExecutionMetadata.quizTurnPromptVersion,
        qualityPromptVersion: defaultQuizExecutionMetadata.questionQualityPromptVersion,
        policyVersion: defaultQuizExecutionMetadata.policyVersion, operationId: newId(),
        signal,
      });
    } finally {
      await refresh();
      await markAutoBackupDirty("review-coach-quiz-turn");
    }
  }, [assets, createQuizOrchestrator, recordBlocks, refresh, reviewCoachSnapshot.adaptiveReviewTasks]);

  const requestAdaptiveQuizHint = useCallback(async (turnId: string, level: number) => {
    const result = await reviewCoachOrchestrator.recordQuizHint(turnId, level);
    await refresh();
    await markAutoBackupDirty("review-coach-quiz-hint");
    return result;
  }, [refresh]);

  const submitAdaptiveQuizAnswer = useCallback(async (turnId: string, answerText: string, signal?: AbortSignal) => {
    const { provider, orchestrator } = await createQuizOrchestrator();
    try {
      return await orchestrator.submitQuizAnswer({ turnId, answerText, provider: provider.providerName, model: provider.model, promptVersion: defaultQuizExecutionMetadata.answerEvaluationPromptVersion, policyVersion: defaultQuizExecutionMetadata.policyVersion, operationId: newId(), signal });
    } finally {
      await refresh();
      await markAutoBackupDirty("review-coach-quiz-answer");
    }
  }, [createQuizOrchestrator, refresh]);

  const skipAdaptiveQuizTurn = useCallback(async (turnId: string) => {
    const result = await reviewCoachOrchestrator.skipQuizTurn(turnId, newId());
    await refresh();
    await markAutoBackupDirty("review-coach-quiz-skip");
    return result;
  }, [refresh]);

  const reportAdaptiveQuizInvalid = useCallback(async (turnId: string, reason: string) => {
    const result = await reviewCoachOrchestrator.reportInvalidQuestion(turnId, reason, newId());
    await refresh();
    await markAutoBackupDirty("review-coach-question-invalid");
    return result;
  }, [refresh]);

  const finishAdaptiveQuizTask = useCallback(async (taskId: string, outcome: SubjectiveOutcome, reason?: string, confirmedConflict?: boolean) => {
    const result = await reviewCoachOrchestrator.finishQuizTask({ taskId, outcome, reason, confirmedConflict, operationId: newId() });
    await refresh();
    await markAutoBackupDirty("review-coach-quiz-finish");
    return result;
  }, [refresh]);

  const finishDelayedVerification = useCallback(async (taskId: string, outcome: "retained" | "decayed", confirmedConflict?: boolean) => {
    const result = await reviewCoachOrchestrator.completeDelayedVerification({ taskId, outcome, confirmedConflict, operationId: newId() });
    await refresh();
    await markAutoBackupDirty("review-coach-delayed-verification");
    return result;
  }, [refresh]);

  const abandonAdaptiveQuizTask = useCallback(async (taskId: string, reason: string) => {
    const result = await reviewCoachOrchestrator.abandonQuizTask(taskId, reason, newId());
    await refresh();
    await markAutoBackupDirty("review-coach-quiz-abandon");
    return result;
  }, [refresh]);

  const deleteDecisionBlockFeedback = useCallback(async (feedbackId: string) => {
    const deleted = await reviewCoachRepository.deleteFeedback(feedbackId, nowISO());
    await refresh();
    await markAutoBackupDirty("decision-block-feedback-delete");
    return deleted;
  }, [refresh]);

  const confirmFeedbackInterpretation = useCallback(async (
    feedbackId: string,
    patch?: Partial<Pick<FeedbackInterpretation, "actionability" | "difficultyType" | "stuckAt" | "userHypothesis" | "preferredPractice" | "missingInformation" | "confidence">>,
  ) => {
    const updated = await reviewCoachOrchestrator.confirmFeedbackInterpretation(feedbackId, patch);
    await refresh();
    await markAutoBackupDirty("feedback-interpretation-confirm");
    return updated;
  }, [refresh]);

  const retryFeedbackInterpretation = useCallback(async (feedbackId: string) => {
    await runFeedbackInterpretations([feedbackId], true);
    return reviewCoachRepository.getFormalSnapshot();
  }, [runFeedbackInterpretations]);

  const transitionAnalysisQueueItem = useCallback(async (queueItemId: string, status: Extract<AnalysisQueueStatus, "eligible" | "excluded">) => {
    const updated = await reviewCoachRepository.transitionQueueItem(queueItemId, status, nowISO());
    await refresh();
    await markAutoBackupDirty("analysis-queue-update");
    return updated;
  }, [refresh]);

  const updateAnalysisQueueItemNote = useCallback(async (queueItemId: string, analysisNote: string) => {
    const updated = await reviewCoachRepository.updateQueueItemAnalysisNote(queueItemId, analysisNote, nowISO());
    await refresh();
    await markAutoBackupDirty("analysis-queue-note");
    return updated;
  }, [refresh]);

  const linkLegacyReviewFeedback = useCallback(async (input: {
    recordId: string;
    reviewLogId: string;
    decisionBlockId: string;
    contentVersion: number;
    comment: string;
    includeInAnalysis: boolean;
  }) => {
    const feedback = await reviewCoachOrchestrator.recordFeedback({
      ...input,
      source: "legacy-manual-link",
      operationId: `legacy-link:${input.reviewLogId}:${input.decisionBlockId}:${input.contentVersion}`,
    });
    await refresh();
    await markAutoBackupDirty("legacy-review-feedback-link");
    return feedback;
  }, [refresh]);

  const undoRecordReview = useCallback(
    async (token: RecordReviewUndoToken) => {
      const restored = await storage.undoRecordReview(token);
      if (!restored) {
        throw new Error("这次评分已发生变化，无法撤回");
      }
      await refresh();
      await markAutoBackupDirty("record-review-undo");
      return restored;
    },
    [refresh],
  );

  const resetRecordReview = useCallback(
    async (recordId: string) => {
      const saved = await storage.resetRecordReview(recordId);
      await refresh();
      if (saved) {
        await markAutoBackupDirty("record-review-reset");
      }
      return saved;
    },
    [refresh],
  );

  const removeRecordFromReview = useCallback(
    async (recordId: string) => {
      const saved = await storage.removeRecordFromReview(recordId);
      await refresh();
      if (saved) {
        await markAutoBackupDirty("record-review-remove");
      }
      return saved;
    },
    [refresh],
  );

  const ensureRecordReviewDay = useCallback(
    async (date: string, dueCountAtFirstOpen: number): Promise<RecordReviewDayStat> => {
      const stat = await storage.ensureRecordReviewDay(date, dueCountAtFirstOpen);
      await refresh();
      return stat;
    },
    [refresh],
  );

  const createRecordBlock = useCallback(
    async (date = todayISO(), subject?: Subject, contentHtml = "<p></p>") => {
      const dayBlocks = await storage.listBlocks(date);
      const currentSettings = await storage.getSettings();
      const normalizedSubject = normalizeSubject(subject ?? fallbackSubjectName(currentSettings));
      const created = createBaseEntity();
      const initialContentHtml = renewDecisionBlockIdentitiesInHtml(contentHtml, created.createdAt);
      const subjectCount = dayBlocks.filter(
        (block) => block.type === "record" && block.subject === normalizedSubject,
      ).length;
      const record: RecordBlock = {
        ...created,
        type: "record",
        date,
        order: dayBlocks.length,
        subject: normalizedSubject,
        tags: [],
        title: nextRecordTitle(normalizedSubject, subjectCount),
        contentHtml: initialContentHtml,
        assets: [],
        formulas: [],
        mistakeRefs: [],
        favorite: false,
      };
      await storage.saveBlock(record);
      if (extractDecisionBlocks(record.contentHtml).length > 0) {
        await storage.addRecordToReview(record.id);
      }
      await refresh();
      await markAutoBackupDirty("record-create");
      return record;
    },
    [refresh],
  );

  const createContentTemplate = useCallback(
    async (title = "未命名模板", contentHtml = "<p></p>") => {
      const saved = await storage.saveTemplate({ ...createBaseEntity(), title, contentHtml });
      await refresh();
      await markAutoBackupDirty("template-create");
      return saved;
    },
    [refresh],
  );

  const saveContentTemplate = useCallback(
    async (template: ContentTemplate) => {
      const saved = await storage.saveTemplate(template);
      await refresh();
      await markAutoBackupDirty("template-save");
      return saved;
    },
    [refresh],
  );

  const deleteContentTemplate = useCallback(
    async (templateId: string) => {
      await storage.deleteTemplate(templateId);
      await refresh();
      await markAutoBackupDirty("template-delete");
    },
    [refresh],
  );

  const addRichTextBlock = useCallback(
    async (date = todayISO(), content = "<p></p>") => createRecordBlock(date, undefined, content),
    [createRecordBlock],
  );

  const addTemplate = useCallback(
    async (date = todayISO()) => {
      await storage.getOrCreateEntry(date);
      const existing = await storage.listBlocks(date);
      const templateBlocks = createTemplateBlocks(date, existing.length);
      for (const block of templateBlocks) {
        await storage.saveBlock(block);
      }
      await refresh();
      await markAutoBackupDirty("template");
    },
    [refresh],
  );

  const addTodoBlock = useCallback(
    async (date = todayISO()) => {
      await createRecordBlock(date, undefined, "<h2>待办清单</h2><ul><li>[ ] 写下下一步要做的事</li></ul>");
    },
    [createRecordBlock],
  );

  const addStudySessionBlock = useCallback(
    async (date = todayISO(), subject?: Subject, minutes = 60) => {
      await createRecordBlock(date, normalizeSubject(subject), `<p>学习时长：${minutes} 分钟</p>`);
    },
    [createRecordBlock],
  );

  const addFormulaBlock = useCallback(
    async (date = todayISO()) => {
      const record = await createRecordBlock(date, "数学");
      await storage.saveBlock({
        ...record,
        formulas: [{ id: `${record.id}-formula`, title: "公式", latex: "T(n)=O(n\\log n)" }],
      });
      await refresh();
    },
    [createRecordBlock, refresh],
  );

  const addCodeBlock = useCallback(
    async (date = todayISO()) => {
      await createRecordBlock(date, undefined, "<pre><code>int main() {\n  return 0;\n}</code></pre>");
    },
    [createRecordBlock],
  );

  const addQuoteBlock = useCallback(
    async (date = todayISO()) => {
      await createRecordBlock(date, "政治", "<blockquote>把今天能做清楚的事做清楚。</blockquote>");
    },
    [createRecordBlock],
  );

  const addAssetToRecord = useCallback(
    async (record: RecordBlock, file: File, kind: Asset["kind"], title = file.name) => {
      const asset = await storage.saveAsset(file, kind, title);
      await storage.saveBlock({
        ...record,
        assets: [...record.assets, { id: asset.id, title, kind }],
      });
      setAssetsVersion((version) => version + 1);
      await refresh();
      await markAutoBackupDirty("record-asset");
      return asset;
    },
    [refresh],
  );

  const saveAssetFile = useCallback(async (file: File, kind: Asset["kind"], title = file.name) => {
    const asset = await storage.saveAsset(file, kind, title);
    setAssetsVersion((version) => version + 1);
    await markAutoBackupDirty("asset");
    return asset;
  }, []);

  const renameAssetTitle = useCallback(
    async (assetId: string, title: string) => {
      const nextTitle = title.trim();
      if (!nextTitle) {
        return;
      }
      await storage.renameAssetTitle(assetId, nextTitle);
      setAssetsVersion((version) => version + 1);
      await refresh();
      await markAutoBackupDirty("asset-rename");
    },
    [refresh],
  );

  const updateAssetDuration = useCallback(async (assetId: string, durationSeconds: number) => {
    const roundedDuration = Math.max(0, Math.round(durationSeconds));
    const saved = await storage.patchAsset(assetId, { durationSeconds: roundedDuration });
    if (!saved) {
      return;
    }
    setAssets((current) =>
      current.map((asset) =>
        asset.id === assetId
          ? { ...asset, durationSeconds: roundedDuration, updatedAt: saved.updatedAt }
          : asset,
      ),
    );
    setAssetsVersion((version) => version + 1);
  }, []);

  const addAssetBlock = useCallback(
    async (file: File, kind: Asset["kind"], date = todayISO()) => {
      const record = await createRecordBlock(date);
      await addAssetToRecord(record, file, kind);
    },
    [addAssetToRecord, createRecordBlock],
  );

  const addFormulaToRecord = useCallback(
    async (record: RecordBlock, latex: string, title = "公式") => {
      await storage.saveBlock({
        ...record,
        formulas: [...record.formulas, { id: crypto.randomUUID(), latex, title }],
      });
      await refresh();
      await markAutoBackupDirty("settings");
    },
    [refresh],
  );

  const persistSettings = useCallback(
    async (nextSettings: AppSettings) => {
      await storage.saveSettings(nextSettings);
      await refresh();
      await markAutoBackupDirty("record-formula");
    },
    [refresh],
  );

  const saveSubjects = useCallback(
    async (nextSubjects: SubjectConfig[]) => {
      await storage.saveSubjects(nextSubjects);
      await refresh();
      await markAutoBackupDirty("subjects");
    },
    [refresh],
  );

  const addSubject = useCallback(
    async (name: string) => {
      const currentSettings = await storage.getSettings();
      const currentSubjects = getAllSubjects(currentSettings, recordBlocks);
      const validation = validateSubjectName(name, currentSubjects);
      if (validation) {
        throw new Error(validation);
      }
      await storage.saveSubjects([...currentSubjects, createSubjectConfig(name, currentSubjects.length)]);
      await refresh();
      await markAutoBackupDirty("subject-add");
    },
    [recordBlocks, refresh],
  );

  const renameSubject = useCallback(
    async (oldName: Subject, newName: Subject) => {
      const currentSettings = await storage.getSettings();
      const currentSubjects = getAllSubjects(currentSettings, recordBlocks);
      const validation = validateSubjectName(newName, currentSubjects, oldName);
      if (validation) {
        throw new Error(validation);
      }
      await storage.renameSubject(oldName, newName);
      await refresh();
      await markAutoBackupDirty("subject-rename");
    },
    [recordBlocks, refresh],
  );

  const saveKnowledgePodcast = useCallback(async (podcast: KnowledgePodcast) => {
    const saved = await storage.saveKnowledgePodcast?.(podcast);
    await refresh();
    return saved ?? podcast;
  }, [refresh]);

  useEffect(() => subscribeKnowledgePodcastJobs(() => {
    void refresh();
  }), [refresh]);

  useEffect(() => {
    const syncOnVisible = () => {
      if (document.visibilityState === "visible") {
        void syncNativeKnowledgePodcastTtsJobs();
        const user = getCurrentCloudUser();
        if (user) void cleanupCloudRecoverySnapshotsIfDue(user.uid);
      }
    };
    if (document.visibilityState === "visible") {
      const user = getCurrentCloudUser();
      if (user) void cleanupCloudRecoverySnapshotsIfDue(user.uid);
    }
    document.addEventListener("visibilitychange", syncOnVisible);
    return () => document.removeEventListener("visibilitychange", syncOnVisible);
  }, []);

  const deleteKnowledgePodcast = useCallback(async (id: string) => {
    cancelAllKnowledgePodcastJobs(id);
    await storage.deleteKnowledgePodcast?.(id);
    await refresh();
  }, [refresh]);

  return {
    initialized,
    entries,
    blocks,
    assets,
    templates,
    settings,
    autoBackupState,
    podcasts,
    deletedRecords,
    recordReviews,
    dueRecordReviews,
    recordReviewLogs,
    recordReviewStats,
    reviewCoachSnapshot,
    analysisPlanningBlocks,
    subjects,
    activeSubjects,
    todayEntry,
    todayBlocks,
    recordBlocks,
    assetsVersion,
    refresh,
    ensureEntry,
    saveEntry,
    saveBlock,
    deleteBlock,
    restoreBlock,
    permanentlyDeleteBlock,
    purgeExpiredDeletedBlocks,
    toggleRecordFavorite,
    getRecordDraft,
    saveRecordDraft,
    deleteRecordDraft,
    addRecordToReview,
    addRecordsToReview,
    setRecordReviewKind,
    rateRecordReview,
    undoRecordReview,
    deleteDecisionBlockFeedback,
    confirmFeedbackInterpretation,
    retryFeedbackInterpretation,
    runDeepAnalysis,
    resumeDeepAnalysis,
    switchAdaptiveTask,
    deferAdaptiveTask,
    generateAdaptiveQuizTurn,
    requestAdaptiveQuizHint,
    submitAdaptiveQuizAnswer,
    skipAdaptiveQuizTurn,
    reportAdaptiveQuizInvalid,
    finishAdaptiveQuizTask,
    finishDelayedVerification,
    abandonAdaptiveQuizTask,
    transitionAnalysisQueueItem,
    updateAnalysisQueueItemNote,
    linkLegacyReviewFeedback,
    resetRecordReview,
    removeRecordFromReview,
    ensureRecordReviewDay,
    addRichTextBlock,
    createRecordBlock,
    createContentTemplate,
    saveContentTemplate,
    deleteContentTemplate,
    addTemplate,
    addTodoBlock,
    addStudySessionBlock,
    addFormulaBlock,
    addCodeBlock,
    addQuoteBlock,
    addAssetBlock,
    addAssetToRecord,
    saveAssetFile,
    renameAssetTitle,
    updateAssetDuration,
    addFormulaToRecord,
    persistSettings,
    saveSubjects,
    addSubject,
    renameSubject,
    saveKnowledgePodcast,
    deleteKnowledgePodcast,
  };
};
