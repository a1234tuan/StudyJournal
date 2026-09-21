import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { ActionableError } from "../lib/uiError";

import type {
  AppSettings,
  AiChatAttachment,
  Asset,
  AutoBackupSettings,
  Block,
  ContentTemplate,
  DailyPlan,
  DayEntry,
  ISODate,
  KnowledgePodcast,
  RecordBlock,
  RecordDraft,
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
import { CLOSED_LOOP_V2_LOOP_VERSION } from "../features/reviewCoach/learningLoopPolicy";
import { reviewCoachRepository } from "../features/reviewCoach/repository";
import { voiceRecallRepository } from "../features/voiceRecall/repository";
import { createFeedbackInterpretationGateway, defaultFeedbackInterpretationMetadata } from "../features/reviewCoach/aiGateway";
import { processFeedbackInterpretationQueue } from "../features/reviewCoach/feedbackInterpretationWorker";
import { getCurrentAiProvider } from "../lib/aiProviders";
import { buildAnalysisPlanningBlocks, maxAnalysisInputTokensForProvider, type AnalysisPlanningBlock } from "../features/reviewCoach/analysisPlanner";
import { assertTurnContextBudget } from "../features/reviewCoach/contextBudget";
import { createSessionPlanningGateway, defaultSessionPlanningMetadata } from "../features/reviewCoach/sessionPlanningGateway";
import { createQuizExecutionGateway, defaultQuizExecutionMetadata } from "../features/reviewCoach/quizExecutionGateway";
import { actionableDirectAnalysisError, assertAnalysisBatchCompleted } from "../features/reviewCoach/analysisErrors";
import { buildDecisionBlockAiContextPack } from "../services/aiContextService";
import type { InterventionPath, SubjectiveOutcome } from "../features/reviewCoach/domain";

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
  const [dailyPlans, setDailyPlans] = useState<DailyPlan[]>([]);
  /**
   * Soft-deleted plans. Loaded for exactly one purpose: building the plan index
   * that lets a log keep showing its full "from plan" attribution after the plan
   * row was deleted (D9). Never render a list from this, never count it.
   */
  const [deletedDailyPlans, setDeletedDailyPlans] = useState<DailyPlan[]>([]);
  const [recordDrafts, setRecordDrafts] = useState<RecordDraft[]>([]);
  const [recordReviews, setRecordReviews] = useState<RecordReviewState[]>([]);
  const [dueRecordReviews, setDueRecordReviews] = useState<RecordReviewState[]>([]);
  const [recordReviewLogs, setRecordReviewLogs] = useState<RecordReviewLog[]>([]);
  const [recordReviewStats, setRecordReviewStats] = useState<RecordReviewStats | null>(null);
  const deepAnalysisInFlightRef = useRef<Promise<unknown> | null>(null);
  const [reviewCoachSnapshot, setReviewCoachSnapshot] = useState<ReviewCoachFormalSnapshot>(EMPTY_REVIEW_COACH_FORMAL_SNAPSHOT);
  const [assetsVersion, setAssetsVersion] = useState(0);
  const [interpretationRuntimeReady, setInterpretationRuntimeReady] = useState(
    () => typeof document === "undefined" || (document.visibilityState === "visible" && navigator.onLine),
  );
  const interpretationAbortControllersRef = useRef(new Set<AbortController>());
  const localInterpretationFeedbackIdsRef = useRef(new Set<string>());

  const refresh = useCallback(async () => {
    const [entryList, blockList, templateList, currentSettings, assetList, deletedList, reviewList, dueReviews, reviewLogs, reviewStats, podcastList, currentAutoBackupState, coachSnapshot, allInterpretations, planList, deletedPlanList, draftList] = await Promise.all([
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
      storage.listDailyPlans(),
      storage.listDeletedDailyPlans(),
      // Drafts are loaded so a plan row can report "edited but not saved" rather
      // than claiming the user wrote nothing.
      storage.listRecordDrafts(),
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
    setDailyPlans(planList);
    setDeletedDailyPlans(deletedPlanList);
    setRecordDrafts(draftList);
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
      const results = await processFeedbackInterpretationQueue(
        orchestrator,
        jobs.map((job) => ({ ...job, signal: abortController.signal })),
        { maxConcurrency: 1 },
      );
      for (const result of results) {
        if (result && ["succeeded", "insufficient-context", "failed"].includes(result.status)) {
          localInterpretationFeedbackIdsRef.current.delete(result.feedbackId);
        }
      }
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
    for (const feedbackId of localInterpretationFeedbackIdsRef.current) {
      if (["succeeded", "insufficient-context"].includes(interpretationsByFeedbackId.get(feedbackId)?.status ?? "")) {
        localInterpretationFeedbackIdsRef.current.delete(feedbackId);
      }
    }
    const pendingIds = reviewCoachSnapshot.analysisQueueItems
      .filter((item) => localInterpretationFeedbackIdsRef.current.has(item.feedbackId))
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

  const saveDailyPlan = useCallback(
    async (plan: DailyPlan) => {
      const saved = await storage.saveDailyPlan(plan);
      await refresh();
      await markAutoBackupDirty("daily-plan-save");
      return saved;
    },
    [refresh],
  );

  /**
   * Soft-delete a plan row. Logs are untouched and keep their attribution, by
   * design - deleting a plan never cascades into the log it was fulfilled by.
   */
  const deleteDailyPlan = useCallback(
    async (planId: string) => {
      await storage.deleteDailyPlan(planId);
      await refresh();
      await markAutoBackupDirty("daily-plan-delete");
    },
    [refresh],
  );

  /**
   * Append a plan to a day, ordering it after every plan already there.
   *
   * The order is computed here rather than in the page so the "max + 1" rule
   * lives next to the write it belongs to: the page only ever describes what
   * the user typed.
   */
  const createDailyPlan = useCallback(
    async (input: { date: ISODate; subject: Subject; title: string }) => {
      const existing = await storage.listDailyPlans(input.date);
      const order = existing.reduce((max, plan) => Math.max(max, plan.order), -1) + 1;
      return saveDailyPlan({ ...createBaseEntity(), ...input, order });
    },
    [saveDailyPlan],
  );

  /**
   * Reclaim plan-linked records the user opened but never wrote to.
   *
   * `skipRecordIds` must carry every record with a draft flush still in flight:
   * the editor commits navigation synchronously and persists the draft
   * asynchronously, so at this instant "no draft on disk" can simply mean
   * "not written yet". Skipping those is the difference between a tidy list and
   * silently deleting what the user just typed.
   */
  const reclaimPlanRecords = useCallback(
    async (options: { planIds?: string[]; skipRecordIds?: string[] } = {}) => {
      const reclaimed = await storage.reclaimEmptyPlanRecords(options);
      if (reclaimed.length > 0) {
        console.debug("[daily-plan] reclaimed empty plan records", reclaimed);
        await refresh();
        await markAutoBackupDirty("daily-plan-reclaim");
      }
      return reclaimed;
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

  /**
   * Draft writes are debounced and frequent, so they deliberately do not trigger
   * the full `refresh()` fan-out. `recordDrafts` still has to move, though: the
   * daily-plan workspace derives "未保存（上次输入已保留）" from it, and a stale
   * snapshot makes a plan the user just typed into read as untouched. Updating
   * the list in place keeps that derivation honest at O(drafts) cost.
   */
  const saveRecordDraft = useCallback(async (draft: Parameters<typeof storage.saveRecordDraft>[0]) => {
    const saved = await storage.saveRecordDraft(draft);
    setRecordDrafts((previous) => [...previous.filter((item) => item.recordId !== saved.recordId), saved]);
    await markAutoBackupDirty("record-draft");
    return saved;
  }, []);

  const deleteRecordDraft = useCallback(async (recordId: string) => {
    await storage.deleteRecordDraft(recordId);
    setRecordDrafts((previous) => previous.filter((item) => item.recordId !== recordId));
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
      const feedbackIds = result?.undoToken.decisionBlockFeedbackIds ?? [];
      feedbackIds.forEach((feedbackId) => localInterpretationFeedbackIdsRef.current.add(feedbackId));
      await refresh();
      if (result) {
        await markAutoBackupDirty("record-review-rate");
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
    if (planningBlocks.length === 0) throw new ActionableError("没有可分析的复习重点。请确认已保存复习重点和评价后再试。");
    if (typeof document !== "undefined" && (document.visibilityState !== "visible" || !navigator.onLine)) {
      throw new ActionableError("请让应用保持在前台并确认网络可用后再开始分析。");
    }
    const currentSettings = await storage.getSettings();
    const provider = getCurrentAiProvider(currentSettings.ai);
    const apiKey = provider ? (await storage.getAiSecret?.(provider.id))?.apiKey : undefined;
    if (!provider || !apiKey?.trim()) throw new ActionableError("请先在设置中配置当前 AI 供应商和 API Key。");
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
      assertAnalysisBatchCompleted(result.batch);
      return result;
    } catch (error) {
      throw actionableDirectAnalysisError(error, provider);
    } finally {
      interpretationAbortControllersRef.current.delete(controller);
      await refresh();
    }
  }, [refresh]);

  const runExclusiveDeepAnalysis = useCallback(<T,>(work: () => Promise<T>): Promise<T> => {
    if (deepAnalysisInFlightRef.current) return deepAnalysisInFlightRef.current as Promise<T>;
    const promise = work().finally(() => {
      if (deepAnalysisInFlightRef.current === promise) deepAnalysisInFlightRef.current = null;
    });
    deepAnalysisInFlightRef.current = promise;
    return promise;
  }, []);

  const runDeepAnalysis = useCallback((decisionBlockIds: readonly string[], allowCrossBlockSupport: boolean) => runExclusiveDeepAnalysis(async () => {
    const selected = new Set(decisionBlockIds);
    // The rating flow and cloud refresh can update formal queue rows between the
    // render and the click. Always plan from the repository's current snapshot
    // instead of submitting the React snapshot that produced the button.
    const freshSnapshot = await reviewCoachRepository.getFormalSnapshot();
    const freshBlocks = buildAnalysisPlanningBlocks({
      snapshot: freshSnapshot,
      records: recordBlocks,
      assets,
      reviewLogs: recordReviewLogs,
    }).filter((item) => selected.has(item.decisionBlockId));
    if (freshBlocks.length !== selected.size) {
      await refresh();
      throw new ActionableError("分析队列刚刚发生了变化，页面已刷新。请重新进入学习助教后再试；不会重复扣费或删除评价。");
    }
    return executeDeepAnalysis(freshBlocks, allowCrossBlockSupport, newId());
  }), [assets, executeDeepAnalysis, recordBlocks, recordReviewLogs, refresh, runExclusiveDeepAnalysis]);

  const resumeDeepAnalysis = useCallback((batchId: string) => runExclusiveDeepAnalysis(async () => {
    const freshSnapshot = await reviewCoachRepository.getFormalSnapshot();
    const batch = freshSnapshot.analysisBatches.find((item) => item.id === batchId && ["confirmed", "running"].includes(item.status));
    if (!batch) throw new Error("没有可继续的分析批次。");
    const queueIds = new Set(batch.inputRefs.map((item) => item.queueItemId));
    const blockIds = new Set(batch.inputRefs.map((item) => item.decisionBlockId));
    const planningBlocks = buildAnalysisPlanningBlocks({
      snapshot: freshSnapshot,
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
  }), [assets, executeDeepAnalysis, recordBlocks, recordReviewLogs, runExclusiveDeepAnalysis]);

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
    const snapshot = await reviewCoachRepository.getFormalSnapshot();
    const roles = ["turn-generator", "question-quality-reviewer", "answer-evaluator"] as const;
    const roleTimeouts: Partial<Record<typeof roles[number], number>> = {};
    for (const role of roles) {
      const existing = snapshot.aiRoleConfigs.find((item) => item.role === role && !item.deletedAt);
      roleTimeouts[role] = existing?.timeoutMs ?? 60_000;
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
  }, []);

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

  const submitAdaptiveQuizAnswer = useCallback(async (
    turnId: string,
    answerText: string,
    signal?: AbortSignal,
    options?: { imageInputMode: "vision" | "local-ocr"; imageAttachments: AiChatAttachment[] },
  ) => {
    const turn = reviewCoachSnapshot.adaptiveQuizTurns.find((item) => item.id === turnId);
    const task = turn ? reviewCoachSnapshot.adaptiveReviewTasks.find((item) => item.id === turn.taskId) : undefined;
    const record = task ? recordBlocks.find((item) => item.id === task.recordId) : undefined;
    if (!turn || !task || !record) throw new Error("当前题目对应的学习记录不存在。");
    const context = buildDecisionBlockAiContextPack(record, task.decisionBlockId, assets).markdown;
    const { provider, orchestrator } = await createQuizOrchestrator();
    // The evaluator now receives the full material, so a large block must be rejected here
    // rather than letting the provider fail with an opaque context-length error.
    assertTurnContextBudget(provider, context);
    try {
      return await orchestrator.submitQuizAnswer({
        turnId,
        answerText,
        decisionBlockContent: context,
        provider: provider.providerName,
        model: provider.model,
        promptVersion: defaultQuizExecutionMetadata.answerEvaluationPromptVersion,
        policyVersion: defaultQuizExecutionMetadata.policyVersion,
        operationId: newId(),
        signal,
        imageInputMode: options?.imageInputMode,
        imageAttachments: options?.imageAttachments,
      });
    } finally {
      await refresh();
      await markAutoBackupDirty("review-coach-quiz-answer");
    }
  }, [assets, createQuizOrchestrator, recordBlocks, refresh, reviewCoachSnapshot.adaptiveQuizTurns, reviewCoachSnapshot.adaptiveReviewTasks]);

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

  /**
   * v2 loop closure. Deliberately takes no outcome, no reason and no
   * confirmation flag: the loop closes because the evidence says it closed.
   */
  const completeAdaptiveQuizLoop = useCallback(async (taskId: string) => {
    const result = await reviewCoachOrchestrator.completeLearningLoop(taskId, newId());
    await refresh();
    await markAutoBackupDirty("review-coach-quiz-complete-loop");
    return result;
  }, [refresh]);

  /**
   * v2 action path. Records which action the learner asked for next - never a
   * diagnosis, a cause or a mastery claim.
   */
  const selectAdaptiveQuizIntervention = useCallback(async (taskId: string, path: InterventionPath, turnId?: string) => {
    const result = await reviewCoachOrchestrator.selectInterventionPath({ taskId, path, turnId, operationId: newId() });
    await refresh();
    await markAutoBackupDirty("review-coach-intervention");
    return result;
  }, [refresh]);

  /**
   * v2 defer-and-requeue. Used when the display budget or the time box ends
   * before the loop closed; never fabricates a result.
   */
  const deferAdaptiveQuizAttempt = useCallback(async (taskId: string) => {
    const result = await reviewCoachOrchestrator.deferAndRequeueV2Attempt({ taskId, operationId: newId() });
    await refresh();
    await markAutoBackupDirty("review-coach-quiz-defer-requeue");
    return result;
  }, [refresh]);

  /**
   * Submits a delayed-verification result.
   *
   * v1 asks the learner for a verdict; v2 does not, because the locked first
   * attempt already decided it. The caller stays the same so the page does not
   * need to know which regime it is in - the orchestrator routes on the
   * verification's own `loopVersion`.
   */
  const finishDelayedVerification = useCallback(async (taskId: string, outcome: "retained" | "decayed", confirmedConflict?: boolean) => {
    const snapshot = await reviewCoachRepository.getFormalSnapshot();
    const task = snapshot.adaptiveReviewTasks.find((item) => item.id === taskId);
    const verification = snapshot.delayedVerifications.find((item) => (
      item.taskId === taskId && ["in-progress", "queued", "eligible"].includes(item.status)
    ));
    const isV2 = task?.loopVersion === CLOSED_LOOP_V2_LOOP_VERSION
      || verification?.loopVersion === CLOSED_LOOP_V2_LOOP_VERSION;

    const result = isV2
      ? await reviewCoachOrchestrator.completeV2DelayedVerification(taskId)
      : await reviewCoachOrchestrator.completeDelayedVerification({ taskId, outcome, confirmedConflict, operationId: newId() });
    await refresh();
    await markAutoBackupDirty("review-coach-delayed-verification");
    return result;
  }, [refresh]);

  /**
   * v2 delayed verification. Takes no verdict: the locked first attempt is read
   * and its authority decides the conclusion (constitution art. 9).
   */
  const completeV2DelayedVerification = useCallback(async (taskId: string) => {
    const result = await reviewCoachOrchestrator.completeV2DelayedVerification(taskId);
    await refresh();
    await markAutoBackupDirty("review-coach-v2-delayed-verification");
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

  const replanDecayedDecisionBlock = useCallback(async (input: {
    decisionBlockId: string;
    recordId: string;
    contentVersion: number;
  }) => {
    const feedback = await reviewCoachOrchestrator.requeueDecayedBlock(input);
    await refresh();
    await markAutoBackupDirty("review-coach-replan-after-decay");
    return feedback;
  }, [refresh]);

  const ensureAdaptiveCurrentTask = useCallback(async () => {
    await reviewCoachOrchestrator.selectNextTask();
    await refresh();
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
    localInterpretationFeedbackIdsRef.current.add(feedbackId);
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
    async (
      date = todayISO(),
      subject?: Subject,
      contentHtml = "<p></p>",
      /**
       * `title` bypasses the automatic `nextRecordTitle` naming, and `planId`
       * declares the record's origin. Both are optional, so every existing call
       * site is unaffected.
       */
      options?: { title?: string; planId?: string },
    ) => {
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
        title: options?.title ?? nextRecordTitle(normalizedSubject, subjectCount),
        contentHtml: initialContentHtml,
        assets: [],
        formulas: [],
        mistakeRefs: [],
        favorite: false,
        planId: options?.planId,
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

  /**
   * Open the log a plan stands for, creating it on first fulfilment.
   *
   * The rule is deliberately "reuse a live record, otherwise create one and
   * overwrite the link" rather than "create once, reuse forever":
   *
   * - it makes double-tap harmless without any optimistic locking, because the
   *   second call finds the record the first one just made;
   * - it makes restoring a deleted log from trash snap the plan back to
   *   "done", since the link was never cleared;
   * - and it gives the user a way to genuinely redo a plan whose log they purged.
   *
   * Links are written after the record is saved, never in a shared transaction:
   * a failure in between just leaves an ordinary unlinked log, so no content is
   * ever lost to a partial write.
   */
  const openRecordFromPlan = useCallback(
    async (plan: DailyPlan): Promise<RecordBlock | undefined> => {
      const existing = plan.linkedRecordId
        ? (await storage.listBlocks()).find(
            (block): block is RecordBlock =>
              block.id === plan.linkedRecordId && block.type === "record" && !block.deletedAt,
          )
        : undefined;
      if (existing) {
        return existing;
      }
      const created = await createRecordBlock(plan.date, plan.subject, "", {
        title: plan.title,
        planId: plan.id,
      });
      await storage.linkPlanRecord(plan.id, created.id);
      await refresh();
      return created;
    },
    [createRecordBlock, refresh],
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
    dailyPlans,
    deletedDailyPlans,
    recordDrafts,
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
    replanDecayedDecisionBlock,
    ensureAdaptiveCurrentTask,
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
    completeAdaptiveQuizLoop,
    selectAdaptiveQuizIntervention,
    deferAdaptiveQuizAttempt,
    finishDelayedVerification,
    completeV2DelayedVerification,
    abandonAdaptiveQuizTask,
    transitionAnalysisQueueItem,
    updateAnalysisQueueItemNote,
    linkLegacyReviewFeedback,
    resetRecordReview,
    removeRecordFromReview,
    ensureRecordReviewDay,
    addRichTextBlock,
    createRecordBlock,
    saveDailyPlan,
    createDailyPlan,
    deleteDailyPlan,
    openRecordFromPlan,
    reclaimPlanRecords,
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
