import {
  createInitialReviewLibraryState,
  createInitialTabMemory,
  type MoreSubRoute,
  type RecordReferenceNavigationEntry,
  type ReviewCardFilter,
  type ReviewCardSort,
  type ReviewDeckScope,
  type ReviewLibraryState,
  type ReviewSessionProgress,
  type TabKey,
  type TabMemory,
  type VoiceRecallNavigationRoute,
} from "./tabNavigation";
import type { AiKnowledgeScope } from "../types";

const HISTORY_KIND = "study-journal-web-navigation";
const HISTORY_VERSION = 1;

type SerializedTabMemory = Omit<TabMemory, "journal"> & {
  journal: Omit<TabMemory["journal"], "month"> & { month: string };
};

export type WebNavigationSnapshot = {
  kind: typeof HISTORY_KIND;
  version: typeof HISTORY_VERSION;
  sessionId: string;
  activeTab: TabKey;
  tabMemory: SerializedTabMemory;
  activeAiSessionId: string | null;
  scrollY: number;
};

export type RestoredWebNavigationSnapshot = Omit<WebNavigationSnapshot, "tabMemory"> & {
  tabMemory: TabMemory;
};

const TAB_KEYS: readonly TabKey[] = ["today", "journal", "categories", "review", "more"];
const MORE_SUB_ROUTES: readonly MoreSubRoute[] = [
  "stats",
  "settings",
  "ai",
  "favorites",
  "trash",
  "backup",
  "aiTools",
  "ocrSettings",
  "recordings",
  "podcasts",
  "guide",
  null,
];
const REVIEW_CARD_FILTERS: readonly ReviewCardFilter[] = ["all", "unadded", "new", "due", "learning", "suspended", "mastered"];
const REVIEW_CARD_SORTS: readonly ReviewCardSort[] = ["due", "created", "reviewed", "title"];
const REVIEW_KINDS = ["all", "overview", "memory"] as const;
const VOICE_RECALL_SCREENS = ["start", "scope", "call", "summary", "history"] as const;
const VOICE_RECALL_SOURCE_KINDS = ["review-home", "record", "review-card", "coach-task", "free-topic"] as const;

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const optionalString = (value: unknown): string | undefined =>
  typeof value === "string" ? value : undefined;

const optionalBoolean = (value: unknown): boolean | undefined =>
  typeof value === "boolean" ? value : undefined;

const optionalScrollY = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;

const restoreReviewSessionProgress = (value: unknown): ReviewSessionProgress | undefined => {
  if (!isObject(value)) {
    return undefined;
  }
  const total = value.total;
  const completed = value.completed;
  if (
    typeof total !== "number" ||
    typeof completed !== "number" ||
    !Number.isInteger(total) ||
    !Number.isInteger(completed) ||
    total < 0 ||
    completed < 0 ||
    completed > total
  ) {
    return undefined;
  }
  return { total, completed };
};

const restoreReviewDeckScope = (value: unknown, fallback: ReviewDeckScope): ReviewDeckScope => {
  if (!isObject(value)) {
    return fallback;
  }
  if (value.kind === "all") {
    return { kind: "all" };
  }
  if (value.kind === "subject" && typeof value.subject === "string") {
    return { kind: "subject", subject: value.subject };
  }
  if (value.kind === "tag" && typeof value.subject === "string" && typeof value.tag === "string" && value.tag.trim()) {
    return { kind: "tag", subject: value.subject, tag: value.tag };
  }
  return fallback;
};

const restoreReviewLibraryState = (value: unknown): ReviewLibraryState => {
  const fallback = createInitialReviewLibraryState();
  if (!isObject(value)) {
    return fallback;
  }
  const kindFilter = REVIEW_KINDS.includes(value.kindFilter as typeof REVIEW_KINDS[number])
    ? value.kindFilter as ReviewLibraryState["kindFilter"]
    : fallback.kindFilter;
  return {
    scope: restoreReviewDeckScope(value.scope, fallback.scope),
    filter: REVIEW_CARD_FILTERS.includes(value.filter as ReviewCardFilter)
      ? value.filter as ReviewCardFilter
      : fallback.filter,
    kindFilter,
    query: optionalString(value.query) ?? fallback.query,
    sort: REVIEW_CARD_SORTS.includes(value.sort as ReviewCardSort)
      ? value.sort as ReviewCardSort
      : fallback.sort,
  };
};

const restoreAiKnowledgeScope = (value: unknown): AiKnowledgeScope | undefined => {
  if (!isObject(value)) return undefined;
  if (value.kind === "recent" && [7, 14, 30].includes(value.days as number)) return { kind: "recent", days: value.days as 7 | 14 | 30 };
  if (value.kind === "date" && typeof value.date === "string") return { kind: "date", date: value.date };
  if (value.kind === "tag" && typeof value.subject === "string" && typeof value.tag === "string") return { kind: "tag", subject: value.subject, tag: value.tag };
  if (value.kind === "records" && Array.isArray(value.recordIds) && value.recordIds.every((id) => typeof id === "string")) {
    return { kind: "records", recordIds: [...value.recordIds] };
  }
  return undefined;
};

const restoreVoiceRecallRoute = (value: unknown): VoiceRecallNavigationRoute | undefined => {
  if (!isObject(value)
    || !VOICE_RECALL_SCREENS.includes(value.screen as VoiceRecallNavigationRoute["screen"])
    || !TAB_KEYS.includes(value.returnTab as TabKey)
    || !VOICE_RECALL_SOURCE_KINDS.includes(value.sourceKind as VoiceRecallNavigationRoute["sourceKind"])
    || !Array.isArray(value.recordIds)
    || value.recordIds.length > 10
    || !value.recordIds.every((id) => typeof id === "string")) return undefined;
  const scope = restoreAiKnowledgeScope(value.scope);
  if (value.scope !== undefined && !scope) return undefined;
  return {
    screen: value.screen as VoiceRecallNavigationRoute["screen"],
    returnTab: value.returnTab as TabKey,
    sourceKind: value.sourceKind as VoiceRecallNavigationRoute["sourceKind"],
    recordIds: [...value.recordIds],
    taskId: optionalString(value.taskId),
    sessionId: optionalString(value.sessionId),
    scope,
    topic: optionalString(value.topic)?.slice(0, 500),
    learningGoal: optionalString(value.learningGoal)?.slice(0, 500),
  };
};

const cloneReferenceStack = (value: unknown): RecordReferenceNavigationEntry[] | undefined => {
  if (value === undefined) {
    return undefined;
  }
  if (!Array.isArray(value)) {
    return undefined;
  }

  const entries: RecordReferenceNavigationEntry[] = [];
  for (const item of value) {
    if (!isObject(item) || typeof item.scrollY !== "number" || !Number.isFinite(item.scrollY) || item.scrollY < 0) {
      return undefined;
    }
    if (item.kind === "record" && typeof item.recordId === "string") {
      entries.push({
        kind: "record",
        recordId: item.recordId,
        highlightAssetId: optionalString(item.highlightAssetId),
        recordEditing: optionalBoolean(item.recordEditing),
        scrollY: item.scrollY,
      });
      continue;
    }
    if (item.kind === "review-queue" && typeof item.sourceRecordId === "string") {
      entries.push({ kind: "review-queue", sourceRecordId: item.sourceRecordId, scrollY: item.scrollY });
      continue;
    }
    return undefined;
  }
  return entries;
};

const restoreRecordState = <T extends TabMemory[TabKey]>(value: unknown, fallback: T): T | null => {
  if (!isObject(value)) {
    return null;
  }
  const referenceStack = cloneReferenceStack(value.referenceStack);
  if (value.referenceStack !== undefined && !referenceStack) {
    return null;
  }
  return {
    ...fallback,
    recordId: optionalString(value.recordId),
    highlightAssetId: optionalString(value.highlightAssetId),
    recordEditing: optionalBoolean(value.recordEditing),
    referenceStack,
    restoreScrollY: optionalScrollY(value.restoreScrollY),
  };
};

const serialiseTabMemory = (memory: TabMemory): SerializedTabMemory => ({
  ...memory,
  journal: {
    ...memory.journal,
    month: memory.journal.month.toISOString(),
  },
});

const restoreTabMemory = (value: unknown): TabMemory | null => {
  if (!isObject(value) || !isObject(value.journal) || !isObject(value.categories) || !isObject(value.review) || !isObject(value.more)) {
    return null;
  }

  const defaults = createInitialTabMemory();
  const todayBase = restoreRecordState(value.today ?? {}, defaults.today);
  const journalBase = restoreRecordState(value.journal, defaults.journal);
  const categoriesBase = restoreRecordState(value.categories, defaults.categories);
  const reviewBase = restoreRecordState(value.review, defaults.review);
  const moreBase = restoreRecordState(value.more, defaults.more);
  if (!todayBase || !journalBase || !categoriesBase || !reviewBase || !moreBase || typeof value.journal.month !== "string") {
    return null;
  }

  const month = new Date(value.journal.month);
  if (Number.isNaN(month.getTime())) {
    return null;
  }
  const reviewMode = value.review.mode === "manage" ? "manage" : value.review.mode === "queue" ? "queue" : null;
  const subRoute = MORE_SUB_ROUTES.includes(value.more.subRoute as MoreSubRoute) ? value.more.subRoute as MoreSubRoute : undefined;
  const recordings = value.more.recordingsState;
  if (!reviewMode || subRoute === undefined || !isObject(recordings)) {
    return null;
  }

  const queueIds = Array.isArray(value.review.queueIds) && value.review.queueIds.every((id) => typeof id === "string")
    ? [...value.review.queueIds]
    : null;
  if (!queueIds) {
    return null;
  }

  return {
    today: { ...todayBase, adaptiveTaskId: isObject(value.today) ? optionalString(value.today.adaptiveTaskId) : undefined },
    journal: {
      ...journalBase,
      month,
      selectedDate: optionalString(value.journal.selectedDate),
      selectedSubject: optionalString(value.journal.selectedSubject),
      searchOpen: optionalBoolean(value.journal.searchOpen) ?? false,
      searchQuery: optionalString(value.journal.searchQuery) ?? "",
    },
    categories: {
      ...categoriesBase,
      activeSubject: optionalString(value.categories.activeSubject) ?? null,
      managing: optionalBoolean(value.categories.managing) ?? false,
    },
    review: {
      ...reviewBase,
      mode: reviewMode,
      queueIds,
      currentRecordId: optionalString(value.review.currentRecordId),
      reviewProgress: restoreReviewSessionProgress(value.review.reviewProgress),
      library: restoreReviewLibraryState(value.review.library),
      voiceRecall: restoreVoiceRecallRoute(value.review.voiceRecall),
    },
    more: {
      ...moreBase,
      subRoute,
      aiScreen: value.more.aiScreen === "scope" ? "scope" : "chat",
      recordingsState: {
        selectedFolderId: optionalString(recordings.selectedFolderId)
          ?? (optionalString(recordings.selectedSubject) ? `subject:${optionalString(recordings.selectedSubject)}` : undefined),
        playerAssetId: optionalString(recordings.playerAssetId),
        playerQueueSource: recordings.playerQueueSource && isObject(recordings.playerQueueSource)
          ? recordings.playerQueueSource.kind === "folder" && typeof recordings.playerQueueSource.folderId === "string"
            ? { kind: "folder", folderId: recordings.playerQueueSource.folderId }
            : recordings.playerQueueSource.kind === "search" && typeof recordings.playerQueueSource.query === "string"
              ? { kind: "search", query: recordings.playerQueueSource.query }
              : undefined
          : undefined,
        query: optionalString(recordings.query) ?? "",
        searchOpen: optionalBoolean(recordings.searchOpen) ?? false,
      },
      podcastId: optionalString(value.more.podcastId),
      podcastScreen: value.more.podcastScreen === "scope" ? "scope" : "editor",
    },
  };
};

export const createWebNavigationSessionId = (): string =>
  typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : `web-navigation-${Date.now()}-${Math.random().toString(36).slice(2)}`;

export const createWebNavigationSnapshot = (
  sessionId: string,
  activeTab: TabKey,
  tabMemory: TabMemory,
  activeAiSessionId: string | null,
  scrollY: number,
): WebNavigationSnapshot => ({
  kind: HISTORY_KIND,
  version: HISTORY_VERSION,
  sessionId,
  activeTab,
  tabMemory: serialiseTabMemory(tabMemory),
  activeAiSessionId,
  scrollY: Number.isFinite(scrollY) && scrollY >= 0 ? scrollY : 0,
});

export const restoreWebNavigationSnapshot = (value: unknown): RestoredWebNavigationSnapshot | null => {
  if (!isObject(value) || value.kind !== HISTORY_KIND || value.version !== HISTORY_VERSION || typeof value.sessionId !== "string") {
    return null;
  }
  if (!TAB_KEYS.includes(value.activeTab as TabKey) || (value.activeAiSessionId !== null && typeof value.activeAiSessionId !== "string")) {
    return null;
  }
  const tabMemory = restoreTabMemory(value.tabMemory);
  const scrollY = optionalScrollY(value.scrollY);
  if (!tabMemory || scrollY === undefined) {
    return null;
  }
  return {
    kind: HISTORY_KIND,
    version: HISTORY_VERSION,
    sessionId: value.sessionId,
    activeTab: value.activeTab as TabKey,
    tabMemory,
    activeAiSessionId: value.activeAiSessionId,
    scrollY,
  };
};

export const isCurrentWebNavigationSession = (value: unknown, sessionId: string): boolean =>
  restoreWebNavigationSnapshot(value)?.sessionId === sessionId;
