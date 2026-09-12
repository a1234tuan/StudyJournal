import {
  ArrowLeft,
  BarChart3,
  Bot,
  ChevronDown,
  Edit3,
  Eye,
  MessageSquare,
  Mic,
  MoreHorizontal,
  PauseCircle,
  PlusCircle,
  RefreshCw,
  RotateCcw,
  Search,
  SlidersHorizontal,
  Trash2,
  Undo2,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type Dispatch, type SetStateAction } from "react";
import { createPortal } from "react-dom";

import type {
  AiProviderProfile,
  RecordBlock,
  RecordReviewDecisionBlockFeedbackInput,
  RecordReviewLog,
  RecordReviewRating,
  RecordReviewState,
  RecordReviewStats,
  RecordReviewUndoToken,
  SubjectConfig,
} from "../types";
import { RichTextEditor } from "../components/RichTextEditor";
import { MotionPresence } from "../components/MotionPresence";
import { usePageTransitionLayerState } from "../components/PageTransition";
import { RecordTagChips } from "../components/RecordTagChips";
import { PageHeader } from "../components/ui";
import { normalizeRecordContent } from "../lib/recordContent";
import { formatUiError } from "../lib/uiError";
import { newId } from "../lib/entity";
import { isoDateTimeToLocalDate, todayISO } from "../lib/date";
import { normalizeRecordTags, recordTagKey } from "../lib/recordTags";
import {
  ACTIVE_REVIEW_RATINGS,
  REVIEW_DAILY_SUGGESTED_LIMIT,
  isReviewDueOn,
  previewReviewRatings,
  ratingLabel,
  reviewKindLabel,
} from "../lib/reviewScheduler";
import type { ReviewCardFilter, ReviewCardSort, ReviewDeckScope, ReviewLibraryState, ReviewMode, ReviewSessionProgress } from "../lib/tabNavigation";
import { decisionBlockPreview, extractDecisionBlocks } from "../features/reviewCoach/decisionBlockContent";
import type { AnalysisQueueItem, DecisionBlockFeedback, FeedbackInterpretation } from "../features/reviewCoach/domain";
import type { AnalysisPlanningBlock } from "../features/reviewCoach/analysisPlanner";
import type { ReviewCoachFormalSnapshot } from "../features/reviewCoach/domain";
import { ReviewCoachWorkbench } from "../features/reviewCoach/ReviewCoachWorkbench";
import type { ReviewSessionRuntimeState, ReviewUndoEntry, DecisionBlockFeedbackDraft } from "../features/reviewSession/runtime";
import { ReviewAnnotationSurface } from "../features/reviewAnnotations/ReviewAnnotationSurface";
import { reviewAnnotationRepository } from "../features/reviewAnnotations/repository";
import { reviewOccurrenceKey } from "../features/reviewAnnotations/domain";

interface ReviewPageProps {
  records: RecordBlock[];
  dueReviews: RecordReviewState[];
  reviewStates: RecordReviewState[];
  reviewLogsByRecord?: Record<string, RecordReviewLog[]>;
  decisionBlockFeedback?: readonly DecisionBlockFeedback[];
  feedbackInterpretations?: readonly FeedbackInterpretation[];
  analysisQueueItems?: readonly AnalysisQueueItem[];
  stats: RecordReviewStats | null;
  mode: ReviewMode;
  queueIds: string[];
  currentRecordId?: string;
  reviewProgress?: ReviewSessionProgress;
  libraryState: ReviewLibraryState;
  viewportOverlayHost?: HTMLElement | null;
  onModeChange: (mode: ReviewMode) => void;
  onExitReviewSession?: () => void;
  onQueueChange: (ids: string[]) => void;
  onCurrentRecordChange: (id?: string) => void;
  onReviewProgressChange?: (progress?: ReviewSessionProgress) => void;
  onLibraryStateChange: (state: ReviewLibraryState) => void;
  onEnsureDay: (date: string, dueCountAtFirstOpen: number) => Promise<unknown>;
  onRate: (
    recordId: string,
    rating: RecordReviewRating,
    decisionBlockFeedback?: readonly RecordReviewDecisionBlockFeedbackInput[],
  ) => Promise<RecordReviewUndoToken | undefined>;
  onUndo: (token: RecordReviewUndoToken) => Promise<void>;
  reviewRuntime?: ReviewSessionRuntimeState;
  onReviewRuntimeChange?: Dispatch<SetStateAction<ReviewSessionRuntimeState>>;
  onDeleteDecisionBlockFeedback?: (feedbackId: string) => Promise<unknown>;
  onConfirmFeedbackInterpretation?: (feedbackId: string, patch?: Partial<Pick<FeedbackInterpretation, "actionability" | "difficultyType" | "stuckAt" | "userHypothesis" | "preferredPractice" | "missingInformation" | "confidence">>) => Promise<unknown>;
  onRetryFeedbackInterpretation?: (feedbackId: string) => Promise<unknown>;
  onTransitionAnalysisQueueItem?: (queueItemId: string, status: "eligible" | "excluded") => Promise<unknown>;
  onUpdateAnalysisQueueItemNote?: (queueItemId: string, analysisNote: string) => Promise<unknown>;
  onLinkLegacyReviewFeedback?: (input: {
    recordId: string;
    reviewLogId: string;
    decisionBlockId: string;
    contentVersion: number;
    comment: string;
    includeInAnalysis: boolean;
  }) => Promise<unknown>;
  onRefresh: () => Promise<void>;
  onOpenStats?: () => void;
  onOpenRecord: (record: RecordBlock) => void;
  onEditRecord: (record: RecordBlock) => void;
  onAskAiRecord?: (record: RecordBlock) => void;
  onOpenVoiceRecall?: (record?: RecordBlock) => void;
  referenceRecords?: readonly RecordBlock[];
  referenceSubjects?: readonly SubjectConfig[];
  onOpenRecordReference?: (sourceRecordId: string, targetRecordId: string) => void;
  restoreScrollY?: number;
  onAddToReview: (recordId: string) => Promise<void> | void;
  onRemoveReview: (recordId: string) => Promise<void> | void;
  onResetReview: (recordId: string) => Promise<void> | void;
  reviewCoachPlanningBlocks?: readonly AnalysisPlanningBlock[];
  reviewCoachSnapshot?: ReviewCoachFormalSnapshot;
  reviewCoachRecords?: readonly RecordBlock[];
  reviewCoachProvider?: AiProviderProfile;
  onRunDeepAnalysis?: (decisionBlockIds: readonly string[], allowCrossBlockSupport: boolean) => Promise<unknown>;
  onResumeDeepAnalysis?: (batchId: string) => Promise<unknown>;
  onSwitchAdaptiveTask?: (taskId: string) => Promise<unknown>;
  onDeferAdaptiveTask?: (taskId: string) => Promise<unknown>;
  onOpenAdaptiveTask?: (taskId: string) => void;
  coachOpen?: boolean;
  onCoachOpenChange?: (open: boolean) => void;
}

type ReviewCardStatus = Exclude<ReviewCardFilter, "all">;

interface ReviewDeckSummary {
  total: number;
  due: number;
  newCards: number;
  learning: number;
}

interface ReviewDeckGroup {
  subject: string;
  records: RecordBlock[];
  tags: Array<{ tag: string; key: string; records: RecordBlock[] }>;
}

const ratingConfig: Array<{ rating: RecordReviewRating; label: string; className: string }> = [
  { rating: "forgot", label: "忘记了", className: "forgot" },
  { rating: "fuzzy", label: "模糊", className: "fuzzy" },
  { rating: "good", label: "良好", className: "good" },
  { rating: "easy", label: "轻松", className: "easy" },
];

const isDueReview = (review: RecordReviewState | undefined, today: string) => isReviewDueOn(review, today);

const reviewCardStatus = (review: RecordReviewState | undefined, today: string): ReviewCardStatus => {
  if (!review) return "unadded";
  if (review.status === "removed") return "suspended";
  if (review.status === "mastered") return "mastered";
  if (review.totalReviews === 0) return "new";
  if (isDueReview(review, today)) return "due";
  return "learning";
};

const reviewStatusLabel = (review: RecordReviewState | undefined, today: string) => {
  switch (reviewCardStatus(review, today)) {
    case "unadded":
      return "未加入";
    case "new":
      return "新卡";
    case "due":
      return review?.nextReviewDate && review.nextReviewDate < today ? "已过期" : "今日到期";
    case "learning":
      return "复习中";
    case "suspended":
      return "已搁置";
    case "mastered":
      return "已掌握";
  }
};

const reviewDueLabel = (review: RecordReviewState | undefined) => {
  if (!review) return "未加入复习";
  if (review.status === "removed") return "已搁置";
  if (review.status === "mastered") return "无到期日";
  return review.nextReviewDate ? `到期 ${review.nextReviewDate}` : "待排期";
};

const intervalLabel = (days: number) => days <= 1 ? "明天" : `${days}天后`;

const sameIds = (left: string[], right: string[]) =>
  left.length === right.length && left.every((id, index) => id === right[index]);

const normalizeReviewSessionProgress = (progress: ReviewSessionProgress | undefined): ReviewSessionProgress | undefined => {
  if (!progress || !Number.isInteger(progress.total) || !Number.isInteger(progress.completed)) {
    return undefined;
  }
  if (progress.total < 0 || progress.completed < 0 || progress.completed > progress.total) {
    return undefined;
  }
  return progress;
};

const EMPTY_REVIEW_LOGS: RecordReviewLog[] = [];
const EMPTY_DECISION_BLOCK_FEEDBACK: DecisionBlockFeedback[] = [];
const EMPTY_ANALYSIS_QUEUE_ITEMS: AnalysisQueueItem[] = [];
const interpretationActionabilityLabel: Record<NonNullable<FeedbackInterpretation["actionability"]>, string> = {
  needs_training: "需要训练",
  reflection_only: "仅作反思",
  unclear: "尚不明确",
};
const interpretationDifficultyLabel: Record<NonNullable<FeedbackInterpretation["difficultyType"]>, string> = {
  concept: "概念",
  procedure: "步骤",
  confusion: "混淆",
  calculation: "计算",
  application: "应用",
  expression: "表达",
  other: "其他",
};
const hasEvaluationText = (log: RecordReviewLog) => Boolean(log.evaluationText?.trim());

const suggestedDailyLimitIds = (reviews: RecordReviewState[], today: string) =>
  reviews
    .filter((review) => isReviewDueOn(review, today))
    .slice(0, REVIEW_DAILY_SUGGESTED_LIMIT)
    .map((review) => review.recordId);

const matchesFilter = (review: RecordReviewState | undefined, filter: ReviewCardFilter, today: string) => {
  if (filter === "all") return true;
  if (filter === "due") return isDueReview(review, today);
  return reviewCardStatus(review, today) === filter;
};

const reviewSortScore = (review: RecordReviewState | undefined, today: string) => {
  if (isDueReview(review, today)) return 0;
  if (review?.status === "active" && review.totalReviews === 0) return 1;
  if (!review) return 2;
  if (review.status === "active") return 3;
  if (review.status === "removed") return 4;
  return 5;
};

const matchesScope = (record: RecordBlock, scope: ReviewDeckScope) => {
  if (scope.kind === "all") return true;
  if (record.subject !== scope.subject) return false;
  if (scope.kind === "subject") return true;
  const scopeTagKey = recordTagKey(scope.tag);
  return normalizeRecordTags(record.tags).some((tag) => recordTagKey(tag) === scopeTagKey);
};

const reviewScopeLabel = (scope: ReviewDeckScope) =>
  scope.kind === "all" ? "全部卡片" : scope.kind === "subject" ? scope.subject : `${scope.subject} / ${scope.tag}`;

const reviewDeckSummary = (records: readonly RecordBlock[], reviewMap: ReadonlyMap<string, RecordReviewState>, today: string): ReviewDeckSummary => ({
  total: records.length,
  due: records.filter((record) => isDueReview(reviewMap.get(record.id), today)).length,
  newCards: records.filter((record) => {
    const review = reviewMap.get(record.id);
    return review?.status === "active" && review.totalReviews === 0;
  }).length,
  learning: records.filter((record) => {
    const review = reviewMap.get(record.id);
    return review?.status === "active" && review.totalReviews > 0 && !isDueReview(review, today);
  }).length,
});

export const ReviewPage = ({
  records,
  dueReviews,
  reviewStates,
  reviewLogsByRecord = {},
  decisionBlockFeedback = EMPTY_DECISION_BLOCK_FEEDBACK,
  feedbackInterpretations = [],
  analysisQueueItems = EMPTY_ANALYSIS_QUEUE_ITEMS,
  stats,
  mode,
  queueIds,
  currentRecordId,
  reviewProgress,
  libraryState,
  viewportOverlayHost,
  onModeChange,
  onExitReviewSession,
  onQueueChange,
  onCurrentRecordChange,
  onReviewProgressChange,
  onLibraryStateChange,
  onEnsureDay,
  onRate,
  onUndo,
  reviewRuntime: controlledReviewRuntime,
  onReviewRuntimeChange: controlledReviewRuntimeChange,
  onDeleteDecisionBlockFeedback,
  onConfirmFeedbackInterpretation,
  onRetryFeedbackInterpretation,
  onTransitionAnalysisQueueItem,
  onUpdateAnalysisQueueItemNote,
  onLinkLegacyReviewFeedback,
  onRefresh,
  onOpenStats,
  onOpenRecord,
  onEditRecord,
  onAskAiRecord,
  onOpenVoiceRecall,
  referenceRecords = [],
  referenceSubjects = [],
  onOpenRecordReference,
  restoreScrollY,
  onAddToReview,
  onRemoveReview,
  onResetReview,
  reviewCoachPlanningBlocks = [],
  reviewCoachSnapshot,
  reviewCoachRecords = [],
  reviewCoachProvider,
  onRunDeepAnalysis,
  onResumeDeepAnalysis,
  onSwitchAdaptiveTask,
  onDeferAdaptiveTask,
  onOpenAdaptiveTask,
  coachOpen: controlledCoachOpen,
  onCoachOpenChange,
}: ReviewPageProps) => {
  const pageLayerState = usePageTransitionLayerState();
  const touchStartYRef = useRef<number | null>(null);
  const headerMenuRef = useRef<HTMLDivElement | null>(null);
  const [pullReady, setPullReady] = useState(false);
  const [headerMenuOpen, setHeaderMenuOpen] = useState(false);
  const [openActionRecordId, setOpenActionRecordId] = useState<string>();
  const [localCoachOpen, setLocalCoachOpen] = useState(false);
  const coachOpen = controlledCoachOpen ?? localCoachOpen;
  const setCoachOpen = onCoachOpenChange ?? setLocalCoachOpen;
  const [localReviewRuntime, setLocalReviewRuntime] = useState<ReviewSessionRuntimeState>(() => ({ day: todayISO(), ratedRecordIds: [], undoHistory: [] }));
  const reviewRuntime = controlledReviewRuntime ?? localReviewRuntime;
  const onReviewRuntimeChange = controlledReviewRuntimeChange ?? setLocalReviewRuntime;
  const ratedRecordIds = useMemo(() => new Set(reviewRuntime.ratedRecordIds), [reviewRuntime.ratedRecordIds]);
  const [ratingRecordId, setRatingRecordId] = useState<string | null>(null);
  const undoHistory = reviewRuntime.undoHistory;
  const [pendingUndoRestore, setPendingUndoRestore] = useState<ReviewUndoEntry | null>(null);
  const [undoing, setUndoing] = useState(false);
  const [ratingError, setRatingError] = useState("");
  const [annotationOpen, setAnnotationOpen] = useState(false);
  const [showAllDue, setShowAllDue] = useState(false);
  const [libraryFiltersOpen, setLibraryFiltersOpen] = useState(false);
  const [blockFeedbackDrafts, setBlockFeedbackDrafts] = useState<Record<string, DecisionBlockFeedbackDraft>>({});
  const [queueNoteDrafts, setQueueNoteDrafts] = useState<Record<string, string>>({});
  const [interpretationDrafts, setInterpretationDrafts] = useState<Record<string, { stuckAt: string; preferredPractice: string }>>({});
  const [legacyLinkTargets, setLegacyLinkTargets] = useState<Record<string, string>>({});
  const [legacyIncludeInAnalysis, setLegacyIncludeInAnalysis] = useState<Record<string, boolean>>({});
  const [feedbackActionId, setFeedbackActionId] = useState<string>();
  const feedbackDraftRecordIdRef = useRef<string>();
  const today = todayISO();
  const [dailyLimitIds, setDailyLimitIds] = useState<string[]>(() => suggestedDailyLimitIds(dueReviews, today));
  const [sessionProgress, setSessionProgress] = useState<ReviewSessionProgress | undefined>(
    () => normalizeReviewSessionProgress(reviewProgress),
  );
  const sessionDayRef = useRef(today);
  const exitReviewSession = onExitReviewSession ?? (() => onModeChange("manage"));

  const updateSessionProgress = useCallback((next: ReviewSessionProgress | undefined) => {
    const normalized = normalizeReviewSessionProgress(next);
    setSessionProgress(normalized);
    onReviewProgressChange?.(normalized);
  }, [onReviewProgressChange]);

  useEffect(() => {
    setSessionProgress(normalizeReviewSessionProgress(reviewProgress));
  }, [reviewProgress?.completed, reviewProgress?.total]);

  useEffect(() => {
    if (!headerMenuOpen) {
      return undefined;
    }
    const handlePointerDown = (event: PointerEvent) => {
      if (headerMenuRef.current && !headerMenuRef.current.contains(event.target as Node)) {
        setHeaderMenuOpen(false);
      }
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setHeaderMenuOpen(false);
      }
    };
    document.addEventListener("pointerdown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [headerMenuOpen]);

  useEffect(() => {
    if (restoreScrollY === undefined) {
      return undefined;
    }
    const frame = window.requestAnimationFrame(() => window.scrollTo(0, restoreScrollY));
    return () => window.cancelAnimationFrame(frame);
  }, [restoreScrollY]);
  const reviewMap = useMemo(() => new Map(reviewStates.map((review) => [review.recordId, review])), [reviewStates]);
  const availableDueReviews = useMemo(
    () => dueReviews.filter((review) => !ratedRecordIds.has(review.recordId) && isReviewDueOn(review, today)),
    [dueReviews, ratedRecordIds, today],
  );
  const queuedDueReviews = useMemo(
    () => showAllDue ? availableDueReviews : availableDueReviews.filter((review) => dailyLimitIds.includes(review.recordId)),
    [availableDueReviews, dailyLimitIds, showAllDue],
  );
  const dueIds = useMemo(() => new Set(queuedDueReviews.map((review) => review.recordId)), [queuedDueReviews]);
  const recordMap = useMemo(() => new Map(records.map((record) => [record.id, record])), [records]);
  const effectiveQueue = useMemo(
    () => queueIds.filter((id) => dueIds.has(id) && recordMap.has(id)),
    [dueIds, queueIds, recordMap],
  );
  const currentId = currentRecordId && effectiveQueue.includes(currentRecordId) ? currentRecordId : effectiveQueue[0];
  const currentRecord = currentId ? recordMap.get(currentId) : undefined;
  const currentReview = currentId ? queuedDueReviews.find((review) => review.recordId === currentId) : undefined;
  const currentReviewLogs = currentId ? reviewLogsByRecord[currentId] ?? EMPTY_REVIEW_LOGS : EMPTY_REVIEW_LOGS;
  const currentEvaluationLogs = useMemo(
    () => currentReviewLogs.filter(hasEvaluationText),
    [currentReviewLogs],
  );
  useEffect(() => {
    setAnnotationOpen(false);
  }, [currentId]);
  const currentDecisionBlocks = useMemo(
    () => currentRecord ? extractDecisionBlocks(normalizeRecordContent(currentRecord), currentRecord.updatedAt) : [],
    [currentRecord],
  );
  const currentBlockFeedback = useMemo(
    () => currentId
      ? decisionBlockFeedback.filter((feedback) => feedback.recordId === currentId && !feedback.deletedAt)
      : [],
    [currentId, decisionBlockFeedback],
  );
  const queueByFeedbackId = useMemo(
    () => new Map(analysisQueueItems.map((item) => [item.feedbackId, item])),
    [analysisQueueItems],
  );
  const interpretationByFeedbackId = useMemo(
    () => new Map(feedbackInterpretations.filter((item) => !item.deletedAt).map((item) => [item.feedbackId, item])),
    [feedbackInterpretations],
  );
  const fallbackProgress: ReviewSessionProgress = {
    total: effectiveQueue.length + ratedRecordIds.size,
    completed: ratedRecordIds.size,
  };
  const activeSessionProgress = sessionProgress
    ? {
      ...sessionProgress,
      total: Math.max(sessionProgress.total, sessionProgress.completed + effectiveQueue.length),
    }
    : fallbackProgress;
  const completedReviewCount = activeSessionProgress.completed;
  const reviewTotal = Math.max(activeSessionProgress.total, completedReviewCount + effectiveQueue.length);
  const currentIndex = currentId ? Math.min(reviewTotal, completedReviewCount + 1) : 0;
  const progressPercent = reviewTotal > 0
    ? Math.min(100, Math.round((currentIndex / reviewTotal) * 100))
    : 0;
  const overdueCount = availableDueReviews.filter((review) => review.nextReviewDate && review.nextReviewDate < today).length;
  const todayCount = availableDueReviews.filter((review) => review.nextReviewDate === today).length;
  const hiddenDueCount = showAllDue ? 0 : availableDueReviews.filter((review) => !dailyLimitIds.includes(review.recordId)).length;
  const queueReady = showAllDue || availableDueReviews.length === 0 || dailyLimitIds.length > 0;
  const ratingPreviews = useMemo(
    () => currentReview ? new Map(previewReviewRatings(currentReview, today).map((preview) => [preview.rating, preview])) : new Map(),
    [currentReview, today],
  );
  const deckGroups = useMemo<ReviewDeckGroup[]>(() => {
    const groups = new Map<string, { subject: string; records: RecordBlock[]; tags: Map<string, { tag: string; key: string; records: RecordBlock[] }> }>();
    for (const record of records) {
      const group = groups.get(record.subject) ?? {
        subject: record.subject,
        records: [] as RecordBlock[],
        tags: new Map<string, { tag: string; key: string; records: RecordBlock[] }>(),
      };
      group.records.push(record);
      for (const tag of normalizeRecordTags(record.tags)) {
        const key = recordTagKey(tag);
        const tagGroup = group.tags.get(key) ?? { tag, key, records: [] };
        tagGroup.records.push(record);
        group.tags.set(key, tagGroup);
      }
      groups.set(record.subject, group);
    }
    return Array.from(groups.values())
      .sort((left, right) => left.subject.localeCompare(right.subject))
      .map((group) => ({
        subject: group.subject,
        records: group.records,
        tags: Array.from(group.tags.values()).sort((left, right) => left.tag.localeCompare(right.tag)),
      }));
  }, [records]);
  const selectedScopeRecords = useMemo(
    () => records.filter((record) => matchesScope(record, libraryState.scope)),
    [libraryState.scope, records],
  );
  const selectedScopeSummary = useMemo(
    () => reviewDeckSummary(selectedScopeRecords, reviewMap, today),
    [reviewMap, selectedScopeRecords, today],
  );
  const managedRecords = useMemo(() => {
    const normalizedQuery = libraryState.query.trim().toLocaleLowerCase();
    const filtered = selectedScopeRecords
      .filter((record) => matchesFilter(reviewMap.get(record.id), libraryState.filter, today))
      .filter((record) => libraryState.kindFilter === "all" || (reviewMap.get(record.id)?.reviewKind ?? "overview") === libraryState.kindFilter)
      .filter((record) =>
        !normalizedQuery ||
        record.title.toLocaleLowerCase().includes(normalizedQuery) ||
        record.subject.toLocaleLowerCase().includes(normalizedQuery) ||
        normalizeRecordTags(record.tags).some((tag) => tag.toLocaleLowerCase().includes(normalizedQuery)),
      );
    return filtered.sort((a, b) => {
      const leftReview = reviewMap.get(a.id);
      const rightReview = reviewMap.get(b.id);
      switch (libraryState.sort) {
        case "created":
          return b.date.localeCompare(a.date) || b.createdAt.localeCompare(a.createdAt);
        case "reviewed":
          return (rightReview?.lastReviewedAt ?? "").localeCompare(leftReview?.lastReviewedAt ?? "") || b.date.localeCompare(a.date);
        case "title":
          return a.title.localeCompare(b.title, "zh-Hans-CN") || b.date.localeCompare(a.date);
        case "due":
          return reviewSortScore(leftReview, today) - reviewSortScore(rightReview, today) ||
            (leftReview?.nextReviewDate ?? "9999").localeCompare(rightReview?.nextReviewDate ?? "9999") ||
            b.date.localeCompare(a.date);
      }
    });
  }, [libraryState.filter, libraryState.kindFilter, libraryState.query, libraryState.sort, reviewMap, selectedScopeRecords, today]);

  const updateLibraryState = useCallback((patch: Partial<ReviewLibraryState>) => {
    onLibraryStateChange({ ...libraryState, ...patch });
  }, [libraryState, onLibraryStateChange]);

  useEffect(() => {
    const scope = libraryState.scope;
    if (scope.kind === "all") {
      return;
    }
    const subjectGroup = deckGroups.find((group) => group.subject === scope.subject);
    if (!subjectGroup) {
      updateLibraryState({ scope: { kind: "all" } });
      return;
    }
    if (scope.kind === "tag") {
      const tagKey = recordTagKey(scope.tag);
      if (!subjectGroup.tags.some((tag) => tag.key === tagKey)) {
        updateLibraryState({ scope: { kind: "subject", subject: subjectGroup.subject } });
      }
    }
  }, [deckGroups, libraryState.scope, updateLibraryState]);

  useEffect(() => {
    void onEnsureDay(today, dueReviews.length);
  }, [onEnsureDay, today, dueReviews.length]);

  useEffect(() => {
    setShowAllDue(false);
    setDailyLimitIds([]);
  }, [today]);

  useEffect(() => {
    if (showAllDue || pendingUndoRestore) {
      return;
    }
    const nextDailyLimitIds = suggestedDailyLimitIds(dueReviews, today);
    if (!sameIds(dailyLimitIds, nextDailyLimitIds)) {
      setDailyLimitIds(nextDailyLimitIds);
    }
  }, [dailyLimitIds, dueReviews, pendingUndoRestore, showAllDue, today]);

  useEffect(() => {
    if (!queueReady || pendingUndoRestore) {
      return;
    }
    const nextQueue = effectiveQueue.length > 0 ? effectiveQueue : queuedDueReviews.map((review) => review.recordId).filter((id) => recordMap.has(id));
    if (nextQueue.length > 0 && !sessionProgress) {
      updateSessionProgress({ total: nextQueue.length, completed: 0 });
    }
    if (nextQueue.join("|") !== queueIds.join("|")) {
      onQueueChange(nextQueue);
    }
    if (nextQueue.length > 0 && (!currentRecordId || !nextQueue.includes(currentRecordId))) {
      onCurrentRecordChange(nextQueue[0]);
    }
    if (nextQueue.length === 0 && currentRecordId) {
      onCurrentRecordChange(undefined);
    }
  }, [currentRecordId, effectiveQueue, onCurrentRecordChange, onQueueChange, pendingUndoRestore, queueIds, queueReady, queuedDueReviews, recordMap, sessionProgress, updateSessionProgress]);

  useEffect(() => {
    onReviewRuntimeChange((current) => current.day === today ? current : {
      day: today,
      ratedRecordIds: [],
      undoHistory: [],
    });
    setPendingUndoRestore(null);
  }, [onReviewRuntimeChange, today]);

  useEffect(() => {
    if (sessionDayRef.current === today) {
      return;
    }
    sessionDayRef.current = today;
    updateSessionProgress(undefined);
  }, [today, updateSessionProgress]);

  useEffect(() => {
    if (feedbackDraftRecordIdRef.current === currentId) return;
    feedbackDraftRecordIdRef.current = currentId;
    setBlockFeedbackDrafts({});
    setLegacyLinkTargets({});
    setLegacyIncludeInAnalysis({});
  }, [currentId]);

  useEffect(() => {
    setQueueNoteDrafts((current) => {
      const next = { ...current };
      let changed = false;
      for (const item of analysisQueueItems) {
        if (next[item.id] === undefined) {
          next[item.id] = item.analysisNote ?? "";
          changed = true;
        }
      }
      return changed ? next : current;
    });
  }, [analysisQueueItems]);

  useEffect(() => {
    if (!pendingUndoRestore) {
      return;
    }
    const restoredCardIsDue = dueReviews.some(
      (review) => review.recordId === pendingUndoRestore.currentRecordId && isReviewDueOn(review, today),
    );
    const restoredDailyScopeIsReady =
      showAllDue === pendingUndoRestore.showAllDue &&
      (showAllDue || sameIds(dailyLimitIds, pendingUndoRestore.dailyLimitIds));
    if (restoredCardIsDue && !ratedRecordIds.has(pendingUndoRestore.currentRecordId) && restoredDailyScopeIsReady) {
      setPendingUndoRestore(null);
    }
  }, [dailyLimitIds, dueReviews, pendingUndoRestore, ratedRecordIds, showAllDue, today]);

  const rate = async (rating: RecordReviewRating) => {
    if (!currentId || ratingRecordId || undoing || pendingUndoRestore) {
      return;
    }
    const ratedId = currentId;
    const ratedOccurrenceKey = reviewOccurrenceKey(currentReview);
    const previousQueue = effectiveQueue;
    const previousCurrentId = currentId;
    const previousProgress = activeSessionProgress;
    const nextProgress: ReviewSessionProgress = {
      total: previousProgress.total,
      completed: Math.min(previousProgress.total, previousProgress.completed + 1),
    };
    const nextQueue = effectiveQueue.filter((id) => id !== currentId);
    const submittedDrafts = Object.fromEntries(
      Object.entries(blockFeedbackDrafts).map(([id, draft]) => [id, { ...draft }]),
    );
    const feedbackInputs: RecordReviewDecisionBlockFeedbackInput[] = currentDecisionBlocks.flatMap((block) => {
      const draft = submittedDrafts[block.decisionBlockId];
      const comment = draft?.comment.trim() ?? "";
      return comment ? [{
        decisionBlockId: block.decisionBlockId,
        contentVersion: block.contentVersion,
        comment,
        includeInAnalysis: draft.includeInAnalysis,
        operationId: newId(),
      }] : [];
    });
    setRatingError("");
    setRatingRecordId(ratedId);
    onReviewRuntimeChange((current) => ({
      ...current,
      ratedRecordIds: current.ratedRecordIds.includes(ratedId)
        ? current.ratedRecordIds
        : [...current.ratedRecordIds, ratedId],
    }));
    updateSessionProgress(nextProgress);
    onQueueChange(nextQueue);
    onCurrentRecordChange(nextQueue[0]);
    try {
      const token = feedbackInputs.length > 0
        ? await onRate(ratedId, rating, feedbackInputs)
        : await onRate(ratedId, rating);
      if (token) {
        onReviewRuntimeChange((current) => ({
          ...current,
          undoHistory: [...current.undoHistory, {
            token,
            queueIds: previousQueue,
            currentRecordId: previousCurrentId,
            blockFeedbackDrafts: submittedDrafts,
            dailyLimitIds,
            showAllDue,
            reviewProgress: previousProgress,
          }],
        }));
        try {
          await reviewAnnotationRepository.clearAfterRating(ratedId, ratedOccurrenceKey);
        } catch (error) {
          setRatingError(formatUiError(error, "review-annotation"));
        }
      }
    } catch (error) {
      onReviewRuntimeChange((current) => ({
        ...current,
        ratedRecordIds: current.ratedRecordIds.filter((id) => id !== ratedId),
      }));
      updateSessionProgress(previousProgress);
      feedbackDraftRecordIdRef.current = previousCurrentId;
      setBlockFeedbackDrafts(submittedDrafts);
      onQueueChange(previousQueue);
      onCurrentRecordChange(previousCurrentId);
      setRatingError(formatUiError(error, "review-rating"));
    } finally {
      setRatingRecordId(null);
    }
  };

  const undoLastRating = useCallback(async () => {
    const entry = undoHistory[undoHistory.length - 1];
    if (!entry || ratingRecordId || undoing || pendingUndoRestore) {
      return;
    }

    setRatingError("");
    setUndoing(true);
    setPendingUndoRestore(entry);
    try {
      await onUndo(entry.token);
      onReviewRuntimeChange((current) => ({
        ...current,
        undoHistory: current.undoHistory.at(-1)?.token.reviewLogId === entry.token.reviewLogId
          ? current.undoHistory.slice(0, -1)
          : current.undoHistory,
        ratedRecordIds: current.ratedRecordIds.filter((id) => id !== entry.currentRecordId),
      }));
      updateSessionProgress(entry.reviewProgress);
      feedbackDraftRecordIdRef.current = entry.currentRecordId;
      setBlockFeedbackDrafts(entry.blockFeedbackDrafts);
      setShowAllDue(entry.showAllDue);
      setDailyLimitIds(entry.dailyLimitIds);
      onModeChange("queue");
      onQueueChange(entry.queueIds);
      onCurrentRecordChange(entry.currentRecordId);
    } catch (error) {
      setPendingUndoRestore(null);
      setRatingError(formatUiError(error, "review-undo"));
    } finally {
      setUndoing(false);
    }
  }, [onCurrentRecordChange, onModeChange, onQueueChange, onReviewRuntimeChange, onUndo, pendingUndoRestore, ratingRecordId, undoHistory, undoing, updateSessionProgress]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      const target = event.target;
      const isEditable = target instanceof HTMLElement && (
        target.matches("input, textarea, [contenteditable='true']") ||
        Boolean(target.closest("[contenteditable='true']"))
      );
      if (
        event.key.toLowerCase() !== "z" ||
        (!event.ctrlKey && !event.metaKey) ||
        event.shiftKey ||
        isEditable ||
        undoHistory.length === 0 ||
        Boolean(ratingRecordId) ||
        undoing ||
        Boolean(pendingUndoRestore)
      ) {
        return;
      }
      event.preventDefault();
      void undoLastRating();
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [pendingUndoRestore, ratingRecordId, undoHistory.length, undoLastRating, undoing]);

  const runFeedbackAction = async (actionId: string, action: () => Promise<unknown>) => {
    if (feedbackActionId) return;
    setRatingError("");
    setFeedbackActionId(actionId);
    try {
      await action();
    } catch (error) {
      setRatingError(formatUiError(error, "review-feedback"));
    } finally {
      setFeedbackActionId(undefined);
    }
  };

  const continueRemainingDue = () => {
    const nextQueue = availableDueReviews.map((review) => review.recordId).filter((id) => recordMap.has(id));
    updateSessionProgress({
      total: Math.max(activeSessionProgress.total, activeSessionProgress.completed + nextQueue.length),
      completed: activeSessionProgress.completed,
    });
    setShowAllDue(true);
    onQueueChange(nextQueue);
    onCurrentRecordChange(nextQueue[0]);
  };

  const touchStart = (clientY: number) => {
    touchStartYRef.current = window.scrollY <= 0 ? clientY : null;
    setPullReady(false);
  };

  const touchMove = (clientY: number) => {
    if (touchStartYRef.current === null) {
      return;
    }
    setPullReady(clientY - touchStartYRef.current > 72);
  };

  const touchEnd = () => {
    const shouldRefresh = pullReady;
    touchStartYRef.current = null;
    setPullReady(false);
    if (shouldRefresh) {
      void onRefresh();
    }
  };

  return (
    <main
      className={`page review-page primary-workspace-page ${!coachOpen && mode === "queue" && currentRecord ? "review-page-session-active" : ""}`}
      onTouchStart={(event) => touchStart(event.touches[0]?.clientY ?? 0)}
      onTouchMove={(event) => touchMove(event.touches[0]?.clientY ?? 0)}
      onTouchEnd={touchEnd}
    >
      {(!currentRecord || mode !== "queue" || coachOpen) && <PageHeader
        title={coachOpen ? "学习助教" : "间隔复习"}
        subtitle={coachOpen ? "分析卡点、完成针对性训练，并在稍后验证是否真正掌握。" : `今日到期 ${todayCount} 条，已过期 ${overdueCount} 条`}
        density="compact"
        className="review-page-header"
        actions={(
          <div className="review-header-menu" ref={headerMenuRef}>
            {!coachOpen && mode === "queue" && currentRecord && (
              <button type="button" className="secondary-button review-direct-edit" onClick={() => onEditRecord(currentRecord)}>
                <Edit3 size={16} />编辑
              </button>
            )}
            <button
              type="button"
              className="review-header-menu-trigger"
              onClick={() => setHeaderMenuOpen((open) => !open)}
              aria-expanded={headerMenuOpen}
              aria-haspopup="menu"
              aria-label="打开复习更多菜单"
              title="更多复习操作"
            >
              <MoreHorizontal size={19} />
            </button>
            <MotionPresence present={headerMenuOpen} variant="popover" portal={false} className="review-header-menu-popover" role="menu" aria-label="复习操作">
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => { setHeaderMenuOpen(false); void undoLastRating(); }}
                  disabled={undoHistory.length === 0 || Boolean(ratingRecordId) || undoing || Boolean(pendingUndoRestore)}
                  aria-keyshortcuts="Control+Z Meta+Z"
                >
                  <Undo2 size={16} />
                  <span>撤回上次评分</span>
                  <small>Ctrl+Z</small>
                </button>
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => { setHeaderMenuOpen(false); void onRefresh(); }}
                >
                  <RefreshCw size={16} />
                  <span>刷新复习列表</span>
                </button>
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => { setHeaderMenuOpen(false); onOpenStats?.(); }}
                  disabled={!onOpenStats}
                >
                  <BarChart3 size={16} />
                  <span>学习统计</span>
                </button>
                {mode === "queue" && currentRecord && (
                  <>
                    <button
                      type="button"
                      role="menuitem"
                      onClick={() => { setHeaderMenuOpen(false); onEditRecord(currentRecord); }}
                    >
                      <Edit3 size={16} />
                      <span>编辑</span>
                    </button>
                    {onAskAiRecord && (
                      <button
                        type="button"
                        role="menuitem"
                        onClick={() => { setHeaderMenuOpen(false); onAskAiRecord(currentRecord); }}
                      >
                        <Bot size={16} />
                        <span>AI 问答</span>
                      </button>
                    )}
                    {onOpenVoiceRecall && (
                      <button
                        type="button"
                        role="menuitem"
                        onClick={() => { setHeaderMenuOpen(false); onOpenVoiceRecall(currentRecord); }}
                      >
                        <Mic size={16} />
                        <span>语音复述当前卡片</span>
                      </button>
                    )}
                  </>
                )}
            </MotionPresence>
          </div>
        )}
      />}
      {pullReady && <p className="status-message">松手刷新复习列表</p>}
      {ratingError && <p className="status-message">{ratingError}</p>}

      {(!currentRecord || mode !== "queue" || coachOpen) && <div className="review-mode-tabs" role="tablist" aria-label="复习视图">
        <button type="button" className={!coachOpen && mode === "queue" ? "active" : ""} onClick={() => { setCoachOpen(false); onModeChange("queue"); }}>
          日志复习
        </button>
        <button type="button" className={coachOpen ? "active" : ""} onClick={() => setCoachOpen(true)}>
          学习助教
        </button>
        <button type="button" className={!coachOpen && mode === "manage" ? "active" : ""} onClick={() => { setCoachOpen(false); onModeChange("manage"); }}>
          卡片库
        </button>
        {onOpenVoiceRecall && <button type="button" onClick={() => onOpenVoiceRecall()}>
          <Mic size={16} />语音复述
        </button>}
      </div>}

      {coachOpen && reviewCoachSnapshot && onRunDeepAnalysis && onResumeDeepAnalysis && onSwitchAdaptiveTask && onDeferAdaptiveTask && (
        <ReviewCoachWorkbench
          planningBlocks={reviewCoachPlanningBlocks}
          snapshot={reviewCoachSnapshot}
          records={reviewCoachRecords}
          provider={reviewCoachProvider}
          onAnalyze={onRunDeepAnalysis}
          onResume={onResumeDeepAnalysis}
          onSwitchTask={onSwitchAdaptiveTask}
          onDeferTask={onDeferAdaptiveTask}
          onOpenTask={onOpenAdaptiveTask}
        />
      )}

      {!coachOpen && (mode === "queue" ? (
        !currentRecord ? (
          <section className="empty-state review-empty-state">
            <h2>{hiddenDueCount > 0 ? "今日建议已完成" : "今天暂无待复习"}</h2>
            <p>
              {hiddenDueCount > 0
                ? `还有 ${hiddenDueCount} 条到期记录，已经超出今日建议量。`
                : ""}
            </p>
            <small>累计复习 {stats?.totalReviews ?? 0} 次</small>
            {hiddenDueCount > 0 && (
              <button type="button" className="primary-button" onClick={continueRemainingDue}>
                继续处理剩余
              </button>
            )}
          </section>
        ) : (
          <section className="review-session">
            <section className="review-session-chrome" aria-label="复习进度">
              <button
                type="button"
                className="review-session-exit"
                onClick={exitReviewSession}
              >
                <ArrowLeft size={18} />
                返回复习
              </button>
              <div className="review-progress-meta">
                <span>第 {currentIndex}/{reviewTotal} 条</span>
                <strong>{currentReview?.nextReviewDate && currentReview.nextReviewDate < today ? "已过期" : "今日到期"}</strong>
              </div>
              <div
                className="review-progress-track"
                role="progressbar"
                aria-valuemin={0}
                aria-valuemax={reviewTotal}
                aria-valuenow={currentIndex}
                aria-label={`复习进度，第 ${currentIndex} 条，共 ${reviewTotal} 条`}
              >
                <span style={{ width: `${progressPercent}%` }} />
              </div>
              <div className="review-header-menu review-session-menu" ref={headerMenuRef}>
                <button
                  type="button"
                  className="review-header-menu-trigger"
                  onClick={() => setHeaderMenuOpen((open) => !open)}
                  aria-expanded={headerMenuOpen}
                  aria-haspopup="menu"
                  aria-label="打开复习更多菜单"
                  title="更多复习操作"
                >
                  <MoreHorizontal size={19} />
                </button>
                <MotionPresence present={headerMenuOpen} variant="popover" portal={false} className="review-header-menu-popover" role="menu" aria-label="复习操作">
                  <button type="button" role="menuitem" onClick={() => { setHeaderMenuOpen(false); void undoLastRating(); }} disabled={undoHistory.length === 0 || Boolean(ratingRecordId) || undoing || Boolean(pendingUndoRestore)}>
                    <Undo2 size={16} /><span>撤回上次评分</span><small>Ctrl+Z</small>
                  </button>
                  <button type="button" role="menuitem" onClick={() => { setHeaderMenuOpen(false); void onRefresh(); }}><RefreshCw size={16} /><span>刷新复习列表</span></button>
                  <button type="button" role="menuitem" onClick={() => { setHeaderMenuOpen(false); onOpenStats?.(); }} disabled={!onOpenStats}><BarChart3 size={16} /><span>学习统计</span></button>
                  <button type="button" role="menuitem" onClick={() => { setHeaderMenuOpen(false); onEditRecord(currentRecord); }}><Edit3 size={16} /><span>编辑</span></button>
                  {onAskAiRecord && <button type="button" role="menuitem" onClick={() => { setHeaderMenuOpen(false); void onAskAiRecord(currentRecord); }}><Bot size={16} /><span>AI 问答</span></button>}
                  {onOpenVoiceRecall && <button type="button" role="menuitem" onClick={() => { setHeaderMenuOpen(false); onOpenVoiceRecall(currentRecord); }}><Mic size={16} /><span>语音复述当前卡片</span></button>}
                </MotionPresence>
              </div>
            </section>
            <article className={`review-record-card ${currentDecisionBlocks.length > 0 ? "has-decision-blocks" : ""}`}>
              <header className="record-view-header">
                <p className="eyebrow">{currentRecord.date}</p>
                <h1>{currentRecord.title}</h1>
                <RecordTagChips subject={currentRecord.subject} tags={currentRecord.tags} className="review-record-tags" />
                <span className="review-record-meta">{currentRecord.subject} · {reviewKindLabel(currentReview?.reviewKind)}</span>
              </header>
              <div className={`review-learning-layout ${currentDecisionBlocks.length > 0 ? "has-decision-blocks" : ""}`}>
                <ReviewAnnotationSurface
                  key={`${currentRecord.id}:${reviewOccurrenceKey(currentReview)}`}
                  recordId={currentRecord.id}
                  occurrenceKey={reviewOccurrenceKey(currentReview)}
                  contentRevision={currentRecord.updatedAt}
                  open={annotationOpen}
                  onOpenChange={setAnnotationOpen}
                  viewportOverlayHost={viewportOverlayHost}
                >
                  <RichTextEditor
                    value={normalizeRecordContent(currentRecord)}
                    onChange={() => undefined}
                    placeholder=""
                    readOnly
                    currentRecordId={currentRecord.id}
                    referenceRecords={referenceRecords}
                    referenceSubjects={referenceSubjects}
                    onOpenRecordReference={onOpenRecordReference ? (targetRecordId) => onOpenRecordReference(currentRecord.id, targetRecordId) : undefined}
                  />
                </ReviewAnnotationSurface>
                {currentDecisionBlocks.length > 0 && (
                  <section className="decision-block-reflection-list" aria-label="复习重点评论">
                    <header>
                      <MessageSquare size={17} />
                      <div>
                        <strong>针对复习重点写下真实卡点</strong>
                        <small>评论会和整卡评分一起保存</small>
                      </div>
                    </header>
                    {currentDecisionBlocks.map((block, index) => {
                      const draft = blockFeedbackDrafts[block.decisionBlockId] ?? { comment: "", includeInAnalysis: true };
                      const history = currentBlockFeedback
                        .filter((feedback) => feedback.decisionBlockId === block.decisionBlockId)
                        .sort((left, right) => right.occurredAt.localeCompare(left.occurredAt));
                      return (
                        <article className="decision-block-reflection" key={block.decisionBlockId}>
                          <div className="decision-block-reflection-heading">
                            <span>复习重点 {index + 1}</span>
                            <small>v{block.contentVersion}</small>
                          </div>
                          <p className="decision-block-reflection-preview">{decisionBlockPreview(block.contentHtml)}</p>
                          <textarea
                            value={draft.comment}
                            onChange={(event) => setBlockFeedbackDrafts((current) => ({
                              ...current,
                              [block.decisionBlockId]: { ...draft, comment: event.target.value },
                            }))}
                            disabled={Boolean(ratingRecordId) || undoing || Boolean(pendingUndoRestore)}
                            aria-label={`复习重点 ${index + 1} 本次评论`}
                            placeholder="具体哪里卡住、为什么容易错，或这次想验证什么？"
                          />
                          <label className="decision-block-analysis-toggle">
                            <input
                              type="checkbox"
                              checked={draft.includeInAnalysis}
                              onChange={(event) => setBlockFeedbackDrafts((current) => ({
                                ...current,
                                [block.decisionBlockId]: { ...draft, includeInAnalysis: event.target.checked },
                              }))}
                            />
                            <span>加入待分析</span>
                          </label>
                          {history.length > 0 && (
                            <details className="decision-block-feedback-history">
                              <summary>{history.length} 条历史评论</summary>
                              <div>
                                {history.map((feedback) => {
                                  const queueItem = queueByFeedbackId.get(feedback.id);
                                  const queueEditable = queueItem && ["eligible", "excluded", "batched"].includes(queueItem.status);
                                  return (
                                    <article key={feedback.id}>
                                      <div className="decision-block-feedback-meta">
                                        <strong>{isoDateTimeToLocalDate(feedback.occurredAt)}</strong>
                                        <small>{feedback.source === "legacy-manual-link" ? "旧评价手动关联" : `v${feedback.contentVersion}`}</small>
                                      </div>
                                      <p>{feedback.comment}</p>
                                      {(() => {
                                        const interpretation = interpretationByFeedbackId.get(feedback.id);
                                        if (!interpretation) return null;
                                        const statusLabel = interpretation.status === "succeeded"
                                          ? interpretation.aiGenerated ? "AI 已整理，待确认" : "已确认"
                                          : interpretation.status === "insufficient-context" ? "需要补充背景"
                                            : interpretation.status === "failed" ? "整理失败，可稍后重试" : "整理中";
                                        return (
                                          <div className="decision-block-feedback-interpretation">
                                            <small>快速模型：{statusLabel}</small>
                                            {interpretation.actionability && <span>{interpretationActionabilityLabel[interpretation.actionability]}</span>}
                                            {interpretation.difficultyType && <span>{interpretationDifficultyLabel[interpretation.difficultyType]}</span>}
                                            {interpretation.stuckAt && <p>卡点：{interpretation.stuckAt}</p>}
                                            {interpretation.userHypothesis && <p>原因猜测：{interpretation.userHypothesis}</p>}
                                            {interpretation.preferredPractice && <p>希望训练：{interpretation.preferredPractice}</p>}
                                            {interpretation.missingInformation.length > 0 && <p>缺少：{interpretation.missingInformation.join("、")}</p>}
                                            <p className="decision-block-feedback-diagnostic">
                                              {interpretation.provider} · {interpretation.model} · {interpretation.promptVersion}
                                              {interpretation.totalTokens !== undefined ? ` · ${interpretation.totalTokens} tokens` : ""}
                                              {interpretation.attemptCount !== undefined ? ` · ${interpretation.attemptCount} 次尝试` : ""}
                                              {" · 费用以供应商账单为准"}
                                            </p>
                                            {interpretation.aiGenerated && interpretation.status === "succeeded" && onConfirmFeedbackInterpretation && (
                                              <div className="decision-block-interpretation-confirm">
                                                <input
                                                  value={interpretationDrafts[feedback.id]?.stuckAt ?? interpretation.stuckAt ?? ""}
                                                  onChange={(event) => setInterpretationDrafts((current) => ({ ...current, [feedback.id]: { stuckAt: event.target.value, preferredPractice: current[feedback.id]?.preferredPractice ?? interpretation.preferredPractice ?? "" } }))}
                                                  placeholder="修正卡点（可选）"
                                                  aria-label={`评论 ${feedback.id} 的卡点修正`}
                                                />
                                                <input
                                                  value={interpretationDrafts[feedback.id]?.preferredPractice ?? interpretation.preferredPractice ?? ""}
                                                  onChange={(event) => setInterpretationDrafts((current) => ({ ...current, [feedback.id]: { stuckAt: current[feedback.id]?.stuckAt ?? interpretation.stuckAt ?? "", preferredPractice: event.target.value } }))}
                                                  placeholder="修正训练方式（可选）"
                                                  aria-label={`评论 ${feedback.id} 的训练方式修正`}
                                                />
                                                <button type="button" onClick={() => {
                                                  const draft = interpretationDrafts[feedback.id];
                                                  void runFeedbackAction(`${feedback.id}:interpretation`, () => onConfirmFeedbackInterpretation(feedback.id, {
                                                    stuckAt: draft?.stuckAt.trim() || null,
                                                    preferredPractice: draft?.preferredPractice.trim() || null,
                                                  }));
                                                }} disabled={Boolean(feedbackActionId)}>
                                                  保存并确认
                                                </button>
                                              </div>
                                            )}
                                            {interpretation.status === "failed" && onRetryFeedbackInterpretation && (
                                              <button type="button" onClick={() => void runFeedbackAction(`${feedback.id}:interpretation-retry`, () => onRetryFeedbackInterpretation(feedback.id))} disabled={Boolean(feedbackActionId)}>
                                                重试整理
                                              </button>
                                            )}
                                          </div>
                                        );
                                      })()}
                                      {queueEditable && (
                                        <div className="decision-block-queue-controls">
                                          <textarea
                                            value={queueNoteDrafts[queueItem.id] ?? queueItem.analysisNote ?? ""}
                                            onChange={(event) => setQueueNoteDrafts((current) => ({ ...current, [queueItem.id]: event.target.value }))}
                                            aria-label={`评论 ${feedback.id} 的本次分析说明`}
                                            placeholder="可选：只对本次分析补充背景"
                                          />
                                          <div>
                                            {onTransitionAnalysisQueueItem && queueItem.status !== "batched" && (
                                              <button
                                                type="button"
                                                onClick={() => void runFeedbackAction(queueItem.id, () => onTransitionAnalysisQueueItem(
                                                  queueItem.id,
                                                  queueItem.status === "excluded" ? "eligible" : "excluded",
                                                ))}
                                                disabled={Boolean(feedbackActionId)}
                                              >
                                                {queueItem.status === "excluded" ? "恢复分析" : "排除本次"}
                                              </button>
                                            )}
                                            {onUpdateAnalysisQueueItemNote && (
                                              <button
                                                type="button"
                                                onClick={() => void runFeedbackAction(`${queueItem.id}:note`, () => onUpdateAnalysisQueueItemNote(
                                                  queueItem.id,
                                                  queueNoteDrafts[queueItem.id] ?? queueItem.analysisNote ?? "",
                                                ))}
                                                disabled={Boolean(feedbackActionId)}
                                              >
                                                保存说明
                                              </button>
                                            )}
                                          </div>
                                        </div>
                                      )}
                                      {feedback.includeInAnalysis && !queueEditable && (
                                        <small className="decision-block-feedback-status">{queueItem?.status === "stale" ? "源内容已更新" : "已离开待分析队列"}</small>
                                      )}
                                      {!feedback.includeInAnalysis && <small className="decision-block-feedback-status">未加入分析</small>}
                                      {onDeleteDecisionBlockFeedback && (
                                        <button
                                          type="button"
                                          className="decision-block-feedback-delete"
                                          aria-label={`永久删除评论：${feedback.comment}`}
                                          title="永久删除评论"
                                          onClick={() => void runFeedbackAction(feedback.id, () => onDeleteDecisionBlockFeedback(feedback.id))}
                                          disabled={Boolean(feedbackActionId)}
                                        >
                                          <Trash2 size={14} />
                                        </button>
                                      )}
                                    </article>
                                  );
                                })}
                              </div>
                            </details>
                          )}
                        </article>
                      );
                    })}
                  </section>
                )}
              </div>
              {currentEvaluationLogs.length > 0 && (
                <details className="legacy-review-evaluation-history">
                  <summary>旧版整条日志评价（{currentEvaluationLogs.length}）</summary>
                  <div>
                    {currentEvaluationLogs.slice(0, 8).map((log) => {
                      const targetId = legacyLinkTargets[log.id] ?? "";
                      const target = currentDecisionBlocks.find((block) => block.decisionBlockId === targetId);
                      const alreadyLinked = Boolean(target && currentBlockFeedback.some((feedback) => (
                        feedback.source === "legacy-manual-link"
                        && feedback.reviewLogId === log.id
                        && feedback.decisionBlockId === target.decisionBlockId
                      )));
                      return (
                        <article key={log.id}>
                          <strong>{isoDateTimeToLocalDate(log.reviewedAt)} · {ratingLabel(log.rating)}</strong>
                          <p>{log.evaluationText}</p>
                          {currentDecisionBlocks.length > 0 && onLinkLegacyReviewFeedback && (
                            <div className="legacy-review-link-controls">
                              <select
                                value={targetId}
                                onChange={(event) => setLegacyLinkTargets((current) => ({ ...current, [log.id]: event.target.value }))}
                                aria-label={`为旧评价 ${log.id} 选择复习重点`}
                              >
                                <option value="">选择复习重点</option>
                                {currentDecisionBlocks.map((block, index) => (
                                  <option key={block.decisionBlockId} value={block.decisionBlockId}>复习重点 {index + 1}</option>
                                ))}
                              </select>
                              <label>
                                <input
                                  type="checkbox"
                                  checked={legacyIncludeInAnalysis[log.id] ?? true}
                                  onChange={(event) => setLegacyIncludeInAnalysis((current) => ({ ...current, [log.id]: event.target.checked }))}
                                />
                                <span>加入待分析</span>
                              </label>
                              <button
                                type="button"
                                disabled={!target || alreadyLinked || Boolean(feedbackActionId)}
                                onClick={() => target && void runFeedbackAction(`legacy:${log.id}`, () => onLinkLegacyReviewFeedback({
                                  recordId: currentRecord.id,
                                  reviewLogId: log.id,
                                  decisionBlockId: target.decisionBlockId,
                                  contentVersion: target.contentVersion,
                                  comment: log.evaluationText?.trim() ?? "",
                                  includeInAnalysis: legacyIncludeInAnalysis[log.id] ?? true,
                                }))}
                              >
                                {alreadyLinked ? "已关联" : "确认关联"}
                              </button>
                            </div>
                          )}
                        </article>
                      );
                    })}
                  </div>
                </details>
              )}
            </article>
            {(() => {
              const ratingControls = <section className={`review-viewport-dock review-bottom-controls ${currentDecisionBlocks.length > 0 ? "has-decision-blocks" : ""}`}>
              <section className="review-rating-bar">
                {ratingConfig.map((item) => {
                  const preview = ratingPreviews.get(item.rating as typeof ACTIVE_REVIEW_RATINGS[number]);
                  // Compute the label from the fuzzed nextReviewDate rather than the base
                  // intervalDays so users see the actual spread ("3天后" vs "11天后") instead
                  // of every card in a batch landing on the same ladder step.
                  const actualDays = preview?.nextReviewDate
                    ? Math.max(1, Math.round((new Date(preview.nextReviewDate).getTime() - new Date(today).getTime()) / 86_400_000))
                    : preview?.intervalDays;
                  const intervalText = actualDays !== undefined ? intervalLabel(actualDays) : undefined;
                  return (
                    <button
                      key={item.rating}
                      type="button"
                      className={item.className}
                      disabled={Boolean(ratingRecordId) || undoing || Boolean(pendingUndoRestore)}
                      onClick={() => void rate(item.rating)}
                      aria-label={intervalText ? `${item.label}，${intervalText}` : item.label}
                      title={intervalText ? `${item.label} · ${intervalText}` : item.label}
                    >
                      <span>{item.label}</span>
                      {intervalText && <small>{intervalText}</small>}
                    </button>
                  );
                })}
              </section>
              </section>;
              if (annotationOpen || pageLayerState === "exiting") return null;
              return viewportOverlayHost ? createPortal(ratingControls, viewportOverlayHost) : ratingControls;
            })()}
          </section>
        )
      ) : (
        <section className="review-library">
          <aside className="review-deck-sidebar">
            <details className="review-deck-panel">
              <summary>
                <span>牌组范围</span>
                <strong>{reviewScopeLabel(libraryState.scope)}</strong>
                <ChevronDown size={17} />
              </summary>
              <div className="review-deck-list">
                <button
                  type="button"
                  className={libraryState.scope.kind === "all" ? "active" : ""}
                  onClick={() => updateLibraryState({ scope: { kind: "all" } })}
                  aria-current={libraryState.scope.kind === "all" ? "true" : undefined}
                >
                  <span>全部卡片</span>
                  <small>{records.length}</small>
                </button>
                {deckGroups.map((group) => {
                  const groupSummary = reviewDeckSummary(group.records, reviewMap, today);
                  const subjectActive = libraryState.scope.kind !== "all" && libraryState.scope.subject === group.subject;
                  return (
                    <section key={group.subject} className="review-deck-group">
                      <button
                        type="button"
                        className={libraryState.scope.kind === "subject" && subjectActive ? "active" : ""}
                        onClick={() => updateLibraryState({ scope: { kind: "subject", subject: group.subject } })}
                        aria-current={libraryState.scope.kind === "subject" && subjectActive ? "true" : undefined}
                      >
                        <span>{group.subject}</span>
                        <small>{groupSummary.total}</small>
                      </button>
                      {group.tags.length > 0 && (
                        <div className="review-deck-tags">
                          {group.tags.map((tag) => {
                            const selected = libraryState.scope.kind === "tag" && subjectActive && recordTagKey(libraryState.scope.tag) === tag.key;
                            return (
                              <button
                                key={tag.key}
                                type="button"
                                className={selected ? "active" : ""}
                                onClick={() => updateLibraryState({ scope: { kind: "tag", subject: group.subject, tag: tag.tag } })}
                                aria-current={selected ? "true" : undefined}
                              >
                                <span>{tag.tag}</span>
                                <small>{tag.records.length}</small>
                              </button>
                            );
                          })}
                        </div>
                      )}
                    </section>
                  );
                })}
              </div>
            </details>
          </aside>

          <div className="review-library-content">
            <div className="review-library-toolbar">
              <label className="review-search-box">
                <Search size={16} />
                <input
                  value={libraryState.query}
                  onChange={(event) => updateLibraryState({ query: event.target.value })}
                  placeholder="搜索标题、学科、标签"
                  aria-label="搜索标题、学科、标签"
                />
              </label>
              <button type="button" className={`review-library-filter-trigger${libraryFiltersOpen ? " active" : ""}`} onClick={() => setLibraryFiltersOpen((value) => !value)} aria-expanded={libraryFiltersOpen} aria-controls="review-library-filters">
                <SlidersHorizontal size={16} />筛选{(libraryState.filter !== "all" ? 1 : 0) + (libraryState.kindFilter !== "all" ? 1 : 0) + (libraryState.sort !== "due" ? 1 : 0) > 0 && <small>{(libraryState.filter !== "all" ? 1 : 0) + (libraryState.kindFilter !== "all" ? 1 : 0) + (libraryState.sort !== "due" ? 1 : 0)}</small>}
              </button>
            </div>
            {libraryFiltersOpen && <div id="review-library-filters" className="review-library-filter-panel">
              <label>类型<select value={libraryState.kindFilter} onChange={(event) => updateLibraryState({ kindFilter: event.target.value as ReviewLibraryState["kindFilter"] })} aria-label="复习类型"><option value="all">全部类型</option><option value="overview">轻回看</option><option value="memory">记忆卡</option></select></label>
              <label>排序<select value={libraryState.sort} onChange={(event) => updateLibraryState({ sort: event.target.value as ReviewCardSort })} aria-label="排序方式"><option value="due">到期优先</option><option value="created">最近创建</option><option value="reviewed">最近复习</option><option value="title">标题</option></select></label>
              <div className="review-library-filter-group"><span>状态</span><div className="review-filter-chips" role="group" aria-label="卡片状态筛选">
                {([
                  ["all", "全部"],
                  ["unadded", "未加入"],
                  ["new", "新卡"],
                  ["due", "到期"],
                  ["learning", "复习中"],
                  ["suspended", "已搁置"],
                  ["mastered", "已掌握"],
                ] as const).map(([filter, label]) => (
                  <button
                    key={filter}
                    type="button"
                    className={libraryState.filter === filter ? "active" : ""}
                    onClick={() => updateLibraryState({ filter })}
                    aria-pressed={libraryState.filter === filter}
                  >
                    {label}
                  </button>
                ))}
              </div></div>
              {(libraryState.filter !== "all" || libraryState.kindFilter !== "all" || libraryState.query || libraryState.sort !== "due") && <button type="button" className="review-clear-filters" onClick={() => updateLibraryState({ filter: "all", kindFilter: "all", query: "", sort: "due" })}>清除全部</button>}
            </div>}
            {(libraryState.filter !== "all" || libraryState.kindFilter !== "all" || libraryState.sort !== "due") && <div className="review-library-active-filters" aria-label="当前筛选条件">
              {libraryState.kindFilter !== "all" && <button type="button" onClick={() => updateLibraryState({ kindFilter: "all" })}>{libraryState.kindFilter === "memory" ? "记忆卡" : "轻回看"} ×</button>}
              {libraryState.sort !== "due" && <button type="button" onClick={() => updateLibraryState({ sort: "due" })}>{libraryState.sort === "created" ? "最近创建" : libraryState.sort === "reviewed" ? "最近复习" : "标题"} ×</button>}
              {libraryState.filter !== "all" && <button type="button" onClick={() => updateLibraryState({ filter: "all" })}>{({ unadded: "未加入", new: "新卡", due: "到期", learning: "复习中", suspended: "已搁置", mastered: "已掌握" } as Record<string, string>)[libraryState.filter]} ×</button>}
            </div>}
            <div className="review-library-result-meta">
              <strong>{reviewScopeLabel(libraryState.scope)}</strong>
              <span>{managedRecords.length} / {selectedScopeSummary.total} 张卡片</span>
            </div>
            <div className="review-library-list">
              {managedRecords.length === 0 ? (
                <div className="empty-state">
                  <h2>没有匹配的卡片</h2>
                </div>
              ) : managedRecords.map((record) => {
                const review = reviewMap.get(record.id);
                const hasEvaluation = (reviewLogsByRecord[record.id] ?? EMPTY_REVIEW_LOGS).some(hasEvaluationText);
                const statusKind = reviewCardStatus(review, today);
                const status = reviewStatusLabel(review, today);
                const dueLabel = reviewDueLabel(review);
                const active = review?.status === "active";
                const actionsOpen = openActionRecordId === record.id;
                return (
                  <article key={record.id} className="review-library-card">
                    <div
                      className="review-library-card-main"
                      role="button"
                      tabIndex={0}
                      onClick={() => onOpenRecord(record)}
                      onKeyDown={(event) => {
                        if (event.key === "Enter" || event.key === " ") {
                          event.preventDefault();
                          onOpenRecord(record);
                        }
                      }}
                      aria-label={`预览 ${record.title}`}
                    >
                      <span className="record-subject-chip">{record.subject}</span>
                      <div>
                        <strong>{record.title}</strong>
                        <RecordTagChips subject={record.subject} tags={record.tags} />
                        <small>
                          {record.date} · {reviewKindLabel(review?.reviewKind)} · {dueLabel} · 累计 {review?.totalReviews ?? 0} 次
                          {hasEvaluation && (
                            <span className="review-evaluation-inline-indicator" title="有复习评价" aria-label="有复习评价">
                              <MessageSquare size={14} />
                            </span>
                          )}
                        </small>
                      </div>
                    </div>
                    <div className="review-library-card-trailing">
                      <span className={`review-status-pill ${statusKind}`}>
                        {status}
                      </span>
                      <div className="review-card-action-menu">
                        <button
                          type="button"
                          className="review-card-action-trigger"
                          onClick={() => setOpenActionRecordId(actionsOpen ? undefined : record.id)}
                          aria-expanded={actionsOpen}
                          aria-label={`打开 ${record.title} 的操作菜单`}
                          title="卡片操作"
                        >
                          <MoreHorizontal size={18} />
                        </button>
                        <MotionPresence present={actionsOpen} variant="popover" portal={false} className="review-card-action-popover" role="menu" aria-label={`${record.title} 的操作`}>
                            <button type="button" role="menuitem" onClick={() => { setOpenActionRecordId(undefined); onOpenRecord(record); }}>
                              <Eye size={16} />
                              <span>预览</span>
                            </button>
                            <button type="button" role="menuitem" onClick={() => { setOpenActionRecordId(undefined); onEditRecord(record); }}>
                              <Edit3 size={16} />
                              <span>编辑</span>
                            </button>
                            {!active && (
                              <button type="button" role="menuitem" onClick={() => { setOpenActionRecordId(undefined); void onAddToReview(record.id); }}>
                                <PlusCircle size={16} />
                                <span>加入复习</span>
                              </button>
                            )}
                            {review && (
                              <button type="button" role="menuitem" onClick={() => { setOpenActionRecordId(undefined); void onResetReview(record.id); }}>
                                <RotateCcw size={16} />
                                <span>忘记重排</span>
                              </button>
                            )}
                            {active && (
                              <button type="button" role="menuitem" className="danger" onClick={() => { setOpenActionRecordId(undefined); void onRemoveReview(record.id); }}>
                                <PauseCircle size={16} />
                                <span>搁置</span>
                              </button>
                            )}
                        </MotionPresence>
                      </div>
                    </div>
                  </article>
                );
              })}
            </div>
          </div>
        </section>
      ))}
    </main>
  );
};
