import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { App as CapacitorApp } from "@capacitor/app";
import { Capacitor, SystemBars, SystemBarsStyle } from "@capacitor/core";
import {
  ArrowLeft,
  CalendarDays,
  CalendarCheck,
  BookOpenText,
  ClipboardCheck,
  Home,
  Layers,
  Mic2,
  MoreHorizontal,
  Plus,
  Settings,
} from "lucide-react";

import { useAppData } from "./hooks/useAppData";
import { TodayPage } from "./pages/TodayPage";
import { AdaptiveReviewPage } from "./features/reviewCoach/AdaptiveReviewPage";
import { JournalPage } from "./pages/JournalPage";
import { CategoriesPage } from "./pages/CategoriesPage";
import { SearchPage } from "./pages/SearchPage";
import { RecordingsPage } from "./pages/RecordingsPage";
import { ReviewPage } from "./pages/ReviewPage";
import { VoiceRecallWorkspace } from "./features/voiceRecall/VoiceRecallWorkspace";
import { MockAsrStreamAdapter, MockLlmStreamAdapter, MockTtsStreamAdapter } from "./features/voiceRecall/mockProviders";
import { VoiceRecallPipeline } from "./features/voiceRecall/pipeline";
import type { ProductionVoiceSession } from "./features/voiceRecall/productionPipeline";
import { StatsPage } from "./pages/StatsPage";
import { SettingsPage } from "./pages/SettingsPage";
import { RecordEditorPage } from "./pages/RecordEditorPage";
import { MorePage } from "./pages/MorePage";
import { BackupPage } from "./pages/BackupPage";
import { AiToolsPage } from "./pages/AiToolsPage";
import { AiExportPage } from "./pages/AiExportPage";
import { AiChatPage } from "./pages/AiChatPage";
import { KnowledgePodcastPage } from "./pages/KnowledgePodcastPage";
import { OcrSettingsPage } from "./pages/OcrSettingsPage";
import { TtsSettingsPage } from "./pages/TtsSettingsPage";
import { PodcastTemplatesPage } from "./pages/PodcastTemplatesPage";
import { FavoritesPage } from "./pages/FavoritesPage";
import { TrashPage } from "./pages/TrashPage";
import { UsageGuidePage } from "./pages/UsageGuidePage";
import { TemplateLibraryPage } from "./pages/TemplateLibraryPage";
import { PageTransition, type NavigationMotionIntent } from "./components/PageTransition";
import { CloudSyncButton } from "./components/CloudSyncButton";
import { CloudSyncConflictDialog } from "./components/CloudSyncConflictDialog";
import { CloudSyncStatusToast } from "./components/CloudSyncStatusToast";
import { MotionPresence, ViewportOverlayProvider } from "./components/MotionPresence";
import { PlaybackProvider } from "./components/PlaybackProvider";
import type { AiKnowledgeScope, RecordBlock, Subject } from "./types";
import { buildAiKnowledgeContextPackAsync, type AiRecordReviewContext } from "./services/aiContextService";
import { createAiSessionForScope } from "./services/aiSessionService";
import { createEmptyPodcast } from "./services/knowledgePodcastService";
import { exportRecordTransferPackage } from "./services/recordTransferService";
import { storage } from "./services/storageAdapter";
import { getFavoriteRecords } from "./lib/journalSelectors";
import { todayISO } from "./lib/date";
import { createReviewSessionRuntime } from "./features/reviewSession/runtime";
import { isDesktopPlatform } from "./lib/platform";
import { isKeyboardViewportVisible, nextKeyboardBaselineHeight, resolveViewportHeight } from "./lib/viewport";
import { getCurrentAiProvider } from "./lib/aiProviders";
import { onAppBackgroundAutoBackup } from "./services/autoBackupService";
import { flushDesktopPendingChanges } from "./services/desktopLifecycleService";
import {
  buildTabPageKey,
  createInitialTabMemory,
  getRecordState,
  getTabDepth,
  MAX_RECORD_REFERENCE_DEPTH,
  popTabDepth,
  recordReferenceOpenError,
  reviewQueueReferenceOpenError,
  type AiWorkspaceScreen,
  type MoreSubRoute,
  type RecordingPlayerQueueSource,
  type TabKey,
  type TabMemory,
  type VoiceRecallNavigationRoute,
} from "./lib/tabNavigation";
import {
  createWebNavigationSessionId,
  createWebNavigationSnapshot,
  isCurrentWebNavigationSession,
  restoreWebNavigationSnapshot,
} from "./lib/webNavigationHistory";
import { reviewCoachRepository } from "./features/reviewCoach/repository";
import { voiceRecallRuntime } from "./features/voiceRecall/runtimeController";
import { voiceRecallRepository } from "./features/voiceRecall/repository";
import { readVisualTheme, writeVisualTheme, type VisualTheme } from "./lib/visualTheme";

const sameIds = (left: string[], right: string[]) =>
  left.length === right.length && left.every((id, index) => id === right[index]);

const DESKTOP_MIGRATION_SEEN_KEY = "study-journal-desktop-migration-seen";

/** More sub-routes whose page renders its own back control. The global web back
 * row must be suppressed for these, otherwise two competing back affordances
 * appear (one of them an unlabelled icon). */
const MORE_SUB_ROUTES_WITH_OWN_BACK: readonly Exclude<MoreSubRoute, null>[] = [
  "recordings",
  "ai",
  "podcasts",
  "aiTools",
  "aiExport",
  "templates",
];

const voiceRecallPreviewName = () => typeof window === "undefined" ? null : new URLSearchParams(window.location.search).get("preview");

const isVoiceRecallProductionPreview = () => typeof window !== "undefined"
  && !Capacitor.isNativePlatform()
  && !isDesktopPlatform()
  && (window.location.hostname === "127.0.0.1" || window.location.hostname === "localhost")
  && ["voice-recall-production", "voice-recall-policy"].includes(voiceRecallPreviewName() ?? "");

const isVoiceRecallPolicyPreview = () => isVoiceRecallProductionPreview() && voiceRecallPreviewName() === "voice-recall-policy";

const createVoiceRecallPolicyPreviewSession = async (): Promise<ProductionVoiceSession> => ({
  pipeline: new VoiceRecallPipeline(
    new MockAsrStreamAdapter(),
    new MockLlmStreamAdapter(undefined, ["核心概念", "运行机制", "实际应用"]),
    new MockTtsStreamAdapter(),
  ),
  provider: { templateId: "voice-policy-preview", configurationIdentity: "voice-policy-preview@1" },
  asrFormat: { encoding: "pcm-s16le", sampleRate: 16_000, channelCount: 1 },
  ttsVoice: "mock-teacher",
  ttsEncoding: "pcm-s16le",
  ttsSampleRate: 16_000,
  summary: { asr: "Mock ASR", llm: "Mock LLM", tts: "Mock TTS" },
});

const isEditableElement = (target: EventTarget | Element | null) => {
  if (!(target instanceof Element)) {
    return false;
  }
  return Boolean(target.closest("input, textarea, select, [contenteditable='true'], [contenteditable='']"));
};

const useKeyboardVisible = () => {
  const [keyboardVisible, setKeyboardVisible] = useState(false);

  useEffect(() => {
    const visualViewport = window.visualViewport;
    const native = Capacitor.isNativePlatform();
    const readViewportHeight = () => resolveViewportHeight({
      native,
      innerHeight: window.innerHeight,
      visualViewportHeight: visualViewport?.height,
    });
    let restingHeight = readViewportHeight();
    let focusTimer: number | null = null;

    const update = () => {
      const activeEditable = isEditableElement(document.activeElement);
      const aiWorkspaceActive = Boolean(document.querySelector(".app-shell.ai-chat-active, .app-shell.ai-scope-active"));
      const activeAiInput = document.activeElement instanceof Element
        && Boolean(document.activeElement.closest(".ai-chat-page, .ai-scope-page"));
      const keyboardEditable = activeEditable && (!aiWorkspaceActive || activeAiInput);
      const currentHeight = readViewportHeight();
      restingHeight = nextKeyboardBaselineHeight(restingHeight, currentHeight, keyboardEditable);
      const mobileViewport = window.matchMedia("(max-width: 920px)").matches;
      setKeyboardVisible(mobileViewport && isKeyboardViewportVisible(keyboardEditable, restingHeight, currentHeight));
    };

    const updateAfterFocus = () => {
      if (focusTimer) {
        window.clearTimeout(focusTimer);
      }
      focusTimer = window.setTimeout(update, 80);
    };

    const handleFocusOut = () => {
      if (focusTimer) {
        window.clearTimeout(focusTimer);
      }
      focusTimer = window.setTimeout(update, 120);
    };

    const handleOrientationChange = () => {
      restingHeight = 0;
      setKeyboardVisible(false);
      updateAfterFocus();
    };

    update();
    window.addEventListener("focusin", updateAfterFocus);
    window.addEventListener("focusout", handleFocusOut);
    visualViewport?.addEventListener("resize", update);
    visualViewport?.addEventListener("scroll", update);
    window.addEventListener("resize", update);
    window.addEventListener("orientationchange", handleOrientationChange);

    return () => {
      if (focusTimer) {
        window.clearTimeout(focusTimer);
      }
      window.removeEventListener("focusin", updateAfterFocus);
      window.removeEventListener("focusout", handleFocusOut);
      visualViewport?.removeEventListener("resize", update);
      visualViewport?.removeEventListener("scroll", update);
      window.removeEventListener("resize", update);
      window.removeEventListener("orientationchange", handleOrientationChange);
    };
  }, []);

  return keyboardVisible;
};

const navItems: Array<{ tab: TabKey; subRoute?: Exclude<MoreSubRoute, null>; label: string; icon: typeof Home }> = [
  { tab: "today", label: "今天", icon: Home },
  { tab: "journal", label: "日志", icon: CalendarDays },
  { tab: "review", label: "复习", icon: CalendarCheck },
  { tab: "more", subRoute: "recordings", label: "录音", icon: Mic2 },
  { tab: "more", label: "更多", icon: MoreHorizontal },
];

const bottomNavItems: Array<{ tab: TabKey; label: string; icon: typeof Home }> = [
  { tab: "today", label: "今天", icon: Home },
  { tab: "journal", label: "日志", icon: CalendarDays },
  { tab: "review", label: "复习", icon: CalendarCheck },
  { tab: "more", label: "更多", icon: MoreHorizontal },
];

type NavigationState = {
  activeTab: TabKey;
  tabMemory: TabMemory;
  activeAiSessionId: string | null;
};

type NavigationCommitOptions = {
  history?: "push" | "replace" | "none";
  scrollToTop?: boolean;
  motion?: NavigationMotionIntent;
};

const navigationMotionBetween = (current: NavigationState, next: NavigationState): NavigationMotionIntent => {
  if (current.activeTab !== next.activeTab) return "tab";
  const currentDepth = getTabDepth(current.activeTab, current.tabMemory);
  const nextDepth = getTabDepth(next.activeTab, next.tabMemory);
  if (nextDepth > currentDepth) return "forward";
  if (nextDepth < currentDepth) return "back";
  return buildTabPageKey(current.activeTab, current.tabMemory, current.activeAiSessionId)
    === buildTabPageKey(next.activeTab, next.tabMemory, next.activeAiSessionId)
    ? "none"
    : "replace";
};

export const App = () => {
  const [activeTab, setActiveTab] = useState<TabKey>(() => isVoiceRecallProductionPreview() ? "review" : "today");
  const [tabMemory, setTabMemory] = useState<TabMemory>(() => {
    const memory = createInitialTabMemory();
    if (isVoiceRecallProductionPreview()) {
      memory.review.voiceRecall = { screen: "start", returnTab: "review", sourceKind: "review-home", recordIds: [] };
    }
    return memory;
  });
  const [activeAiSessionId, setActiveAiSessionId] = useState<string | null>(null);
  const [aiReturnTab, setAiReturnTab] = useState<TabKey | null>(null);
  const [backToast, setBackToast] = useState("");
  const [reviewToast, setReviewToast] = useState("");
  const [reviewCoachOpen, setReviewCoachOpen] = useState(false);
  const [reviewRuntime, setReviewRuntime] = useState(() => createReviewSessionRuntime(todayISO()));
  const [desktopMigrationOpen, setDesktopMigrationOpen] = useState(false);
  const [visualTheme, setVisualTheme] = useState<VisualTheme>(() => readVisualTheme());
  const [navigationMotion, setNavigationMotion] = useState<NavigationMotionIntent>("none");
  const [viewportOverlayHost, setViewportOverlayHost] = useState<HTMLDivElement | null>(null);
  const lastBackPressRef = useRef(0);
  const backToastTimerRef = useRef<number | null>(null);
  const navigationStateRef = useRef<NavigationState>({ activeTab, tabMemory, activeAiSessionId });
  const webNavigationSessionRef = useRef<string | null>(null);
  const webNavigationIndexRef = useRef(0);
  const historyScrollRestoreRef = useRef(0);
  const newlyCreatedRecordIdsRef = useRef(new Set<string>());
  const app = useAppData();
  const keyboardVisible = useKeyboardVisible();

  navigationStateRef.current = { activeTab, tabMemory, activeAiSessionId };

  const clearBackHint = useCallback(() => {
    lastBackPressRef.current = 0;
    if (backToastTimerRef.current) {
      window.clearTimeout(backToastTimerRef.current);
      backToastTimerRef.current = null;
    }
    setBackToast("");
  }, []);

  const commitNavigation = useCallback((next: NavigationState, options: NavigationCommitOptions = {}) => {
    const current = navigationStateRef.current;
    const historyMode = options.history ?? "push";
    const sessionId = webNavigationSessionRef.current;
    const webNavigationEnabled = !Capacitor.isNativePlatform() && !isDesktopPlatform() && Boolean(sessionId);
    const nextScrollY = options.scrollToTop ? 0 : window.scrollY;
    const motion = options.motion ?? navigationMotionBetween(current, next);
    let nextNavigationIndex = webNavigationIndexRef.current;

    if (webNavigationEnabled && sessionId && historyMode !== "none") {
      const currentSnapshot = createWebNavigationSnapshot(
        sessionId,
        current.activeTab,
        current.tabMemory,
        current.activeAiSessionId,
        window.scrollY,
        webNavigationIndexRef.current,
      );
      if (historyMode === "push") nextNavigationIndex += 1;
      const nextSnapshot = createWebNavigationSnapshot(
        sessionId,
        next.activeTab,
        next.tabMemory,
        next.activeAiSessionId,
        nextScrollY,
        nextNavigationIndex,
      );
      if (historyMode === "push") {
        window.history.replaceState(currentSnapshot, "");
        window.history.pushState(nextSnapshot, "");
      } else {
        window.history.replaceState(nextSnapshot, "");
      }
    }

    webNavigationIndexRef.current = nextNavigationIndex;
    navigationStateRef.current = next;
    setNavigationMotion(motion);
    setActiveTab(next.activeTab);
    setTabMemory(next.tabMemory);
    setActiveAiSessionId(next.activeAiSessionId);
    if (options.scrollToTop) {
      window.scrollTo(0, 0);
    }
  }, []);

  const updateNavigationState = useCallback((update: (current: NavigationState) => NavigationState, history: "replace" | "none" = "replace") => {
    const current = navigationStateRef.current;
    commitNavigation(update(current), { history });
  }, [commitNavigation]);

  const switchTab = useCallback(
    (tab: TabKey, motion: NavigationMotionIntent = "tab") => {
      clearBackHint();
      const current = navigationStateRef.current;
      if (current.activeTab === tab) {
        return;
      }
      commitNavigation({ ...current, activeTab: tab }, { motion });
    },
    [clearBackHint, commitNavigation],
  );

  const openMoreRoot = useCallback(() => {
    clearBackHint();
    const current = navigationStateRef.current;
    commitNavigation({
      ...current,
      activeTab: "more",
      tabMemory: {
        ...current.tabMemory,
        more: {
          ...current.tabMemory.more,
          subRoute: null,
          recordId: undefined,
          highlightAssetId: undefined,
          recordEditing: undefined,
          referenceStack: [],
          restoreScrollY: undefined,
          recordingsState: { query: "", searchOpen: false },
          podcastId: undefined,
          podcastScreen: "editor",
        },
      },
    }, { motion: current.activeTab === "more" && current.tabMemory.more.subRoute ? "back" : "tab" });
  }, [clearBackHint, commitNavigation]);

  const openMoreSubRoute = useCallback(
    (subRoute: MoreSubRoute, motion?: NavigationMotionIntent) => {
      clearBackHint();
      const current = navigationStateRef.current;
      if (current.activeTab === "more" && current.tabMemory.more.subRoute === subRoute && !current.tabMemory.more.recordId) {
        return;
      }
      const nextMemory: TabMemory = {
        ...current.tabMemory,
        more: {
          ...current.tabMemory.more,
          subRoute,
          aiScreen: subRoute === "ai" ? "chat" : current.tabMemory.more.aiScreen,
          recordId: undefined,
          highlightAssetId: undefined,
          recordEditing: undefined,
          referenceStack: [],
          restoreScrollY: undefined,
          podcastId: (subRoute === "podcasts" || subRoute === "ttsSettings" || subRoute === "podcastTemplates") ? current.tabMemory.more.podcastId : undefined,
          podcastScreen: (subRoute === "podcasts" || subRoute === "ttsSettings" || subRoute === "podcastTemplates") ? current.tabMemory.more.podcastScreen : "editor",
        },
      };
      commitNavigation(
        { ...current, activeTab: "more", tabMemory: nextMemory },
        { motion: motion ?? (current.activeTab === "more" ? "forward" : "tab") },
      );
    },
    [clearBackHint, commitNavigation],
  );

  const setAiWorkspaceScreen = useCallback(
    (aiScreen: AiWorkspaceScreen) => {
      const current = navigationStateRef.current;
      if (current.activeTab !== "more" || current.tabMemory.more.subRoute !== "ai" || current.tabMemory.more.aiScreen === aiScreen) {
        return;
      }
      commitNavigation({
        ...current,
        tabMemory: {
          ...current.tabMemory,
          more: { ...current.tabMemory.more, aiScreen },
        },
      }, { motion: aiScreen === "scope" ? "forward" : "back" });
    },
    [commitNavigation],
  );

  const dismissDesktopMigration = useCallback(() => {
    localStorage.setItem(DESKTOP_MIGRATION_SEEN_KEY, "1");
    setDesktopMigrationOpen(false);
  }, []);

  const openDesktopMigration = useCallback(() => {
    dismissDesktopMigration();
    openMoreSubRoute("backup");
  }, [dismissDesktopMigration, openMoreSubRoute]);

  const openRecordInTab = useCallback(
    (record: RecordBlock, tab: TabKey, assetId?: string, editing = false, sourceScrollY?: number) => {
      clearBackHint();
      const current = navigationStateRef.current;
      const nextMemory: TabMemory = {
        ...current.tabMemory,
        [tab]: {
          ...current.tabMemory[tab],
          recordId: record.id,
          highlightAssetId: assetId,
          recordEditing: editing,
          referenceStack: [],
          restoreScrollY: undefined,
          ...(tab === "journal" && sourceScrollY !== undefined ? { listScrollY: sourceScrollY } : {}),
        },
      };
      commitNavigation(
        { ...current, activeTab: tab, tabMemory: nextMemory },
        { scrollToTop: sourceScrollY !== undefined, motion: "forward" },
      );
    },
    [clearBackHint, commitNavigation],
  );

  const popCurrentTabDepth = useCallback(() => {
    const current = navigationStateRef.current;
    const voiceRoute = current.activeTab === "review" ? current.tabMemory.review.voiceRecall : undefined;
    if (voiceRoute) {
      commitNavigation({
        ...current,
        activeTab: voiceRoute.returnTab,
        tabMemory: { ...current.tabMemory, review: { ...current.tabMemory.review, voiceRecall: undefined } },
      }, { motion: "back" });
      return;
    }
    const nextMemory = popTabDepth(current.tabMemory, current.activeTab);
    if (nextMemory === current.tabMemory) {
      return;
    }
    const sessionId = webNavigationSessionRef.current;
    const webNavigationEnabled = !Capacitor.isNativePlatform()
      && !isDesktopPlatform()
      && Boolean(sessionId)
      && isCurrentWebNavigationSession(window.history.state, sessionId!);
    commitNavigation({ ...current, tabMemory: nextMemory }, { history: webNavigationEnabled ? "replace" : "none", motion: "back" });
  }, [commitNavigation]);

  const aiWorkspaceOnBack = useCallback(() => {
    if (aiReturnTab) {
      setAiReturnTab(null);
      switchTab(aiReturnTab, "back");
    } else {
      popCurrentTabDepth();
    }
  }, [aiReturnTab, popCurrentTabDepth, switchTab]);

  const closeRecordInCurrentTab = popCurrentTabDepth;

  const leaveReviewSession = useCallback(() => {
    clearBackHint();
    updateNavigationState((current) => (
      current.tabMemory.review.mode === "manage"
        ? current
        : { ...current, tabMemory: { ...current.tabMemory, review: { ...current.tabMemory.review, mode: "manage" } } }
    ));
  }, [clearBackHint, updateNavigationState]);

  const openAdaptiveTask = useCallback((taskId: string) => {
    const current = navigationStateRef.current;
    setReviewCoachOpen(true);
    commitNavigation({
      ...current,
      activeTab: "today",
      tabMemory: { ...current.tabMemory, today: { ...current.tabMemory.today, recordId: undefined, adaptiveTaskId: taskId } },
    }, { motion: "forward" });
  }, [commitNavigation]);

  const closeAdaptiveTask = useCallback(() => {
    const current = navigationStateRef.current;
    commitNavigation({
      ...current,
      activeTab: "review",
      tabMemory: { ...current.tabMemory, today: { ...current.tabMemory.today, adaptiveTaskId: undefined } },
    }, { motion: "back" });
  }, [commitNavigation]);

  const openVoiceRecall = useCallback((record?: RecordBlock, sourceKind: "record" | "review-card" = "review-card") => {
    const current = navigationStateRef.current;
    const route: VoiceRecallNavigationRoute = {
      screen: "start",
      returnTab: current.activeTab,
      sourceKind: record ? sourceKind : "review-home",
      recordIds: record ? [record.id] : [],
      learningGoal: record ? `闭卷复述《${record.title}》并发现理解缺口` : undefined,
    };
    commitNavigation({
      ...current,
      activeTab: "review",
      tabMemory: { ...current.tabMemory, review: { ...current.tabMemory.review, voiceRecall: route } },
    }, { scrollToTop: true, motion: "forward" });
  }, [commitNavigation]);

  const updateVoiceRecallRoute = useCallback((route: VoiceRecallNavigationRoute) => {
    updateNavigationState((current) => ({
      ...current,
      activeTab: "review",
      tabMemory: { ...current.tabMemory, review: { ...current.tabMemory.review, voiceRecall: route } },
    }));
  }, [updateNavigationState]);

  const closeVoiceRecall = useCallback(() => {
    const current = navigationStateRef.current;
    const returnTab = current.tabMemory.review.voiceRecall?.returnTab ?? "review";
    commitNavigation({
      ...current,
      activeTab: returnTab,
      tabMemory: { ...current.tabMemory, review: { ...current.tabMemory.review, voiceRecall: undefined } },
    }, { motion: "back" });
  }, [commitNavigation]);

  const createJournalFromVoiceRecall = useCallback(async (subject: string, contentHtml: string) => {
    const created = await app.createRecordBlock(todayISO(), subject, contentHtml);
    newlyCreatedRecordIdsRef.current.add(created.id);
    const current = navigationStateRef.current;
    const targetTab = current.tabMemory.review.voiceRecall?.returnTab ?? "review";
    const nextMemory: TabMemory = {
      ...current.tabMemory,
      review: { ...current.tabMemory.review, voiceRecall: undefined },
      [targetTab]: {
        ...current.tabMemory[targetTab],
        recordId: created.id,
        highlightAssetId: undefined,
        recordEditing: true,
        referenceStack: [],
        restoreScrollY: undefined,
      },
    };
    commitNavigation({ ...current, activeTab: targetTab, tabMemory: nextMemory }, { scrollToTop: true, motion: "forward" });
  }, [app.createRecordBlock, commitNavigation]);

  const createRecordFromGlobalAction = useCallback(async () => {
    const subject = app.activeSubjects[0]?.name;
    if (!subject) {
      switchTab("today");
      return;
    }
    const created = await app.createRecordBlock(todayISO(), subject);
    newlyCreatedRecordIdsRef.current.add(created.id);
    openRecordInTab(created, activeTab, undefined, true);
  }, [activeTab, app.activeSubjects, app.createRecordBlock, openRecordInTab, switchTab]);

  const setCurrentRecordEditing = useCallback((recordEditing: boolean) => {
    updateNavigationState((current) => ({
      ...current,
      tabMemory: {
        ...current.tabMemory,
        [current.activeTab]: {
          ...current.tabMemory[current.activeTab],
        recordEditing,
      },
      },
    }));
  }, [updateNavigationState]);

  useEffect(() => {
    if (!app.settings) {
      return;
    }
    document.documentElement.style.setProperty("--font-scale", String(app.settings.fontScale));
    document.documentElement.style.setProperty("--editor-font-scale", String(app.settings.editorFontScale ?? 1));
    document.documentElement.style.setProperty("--reading-line-height", String(app.settings.lineHeight));
    document.documentElement.dataset.theme = app.settings.theme;
  }, [app.settings]);

  useEffect(() => {
    document.documentElement.dataset.visualTheme = visualTheme;
    writeVisualTheme(visualTheme);
    if (Capacitor.isNativePlatform()) void SystemBars.setStyle({ style: app.settings?.theme === "dark" ? SystemBarsStyle.Light : SystemBarsStyle.Dark }).catch(() => undefined);
  }, [visualTheme, app.settings?.theme]);

  useEffect(() => {
    if (!app.initialized) {
      return;
    }
    // Voice-recall maintenance: repair sessions interrupted by a crash and drop
    // transient sessions past the documented retention window.
    void voiceRecallRuntime.initialize().catch(() => undefined);
    void voiceRecallRepository.cleanupCompleted().catch(() => undefined);
  }, [app.initialized]);

  useEffect(() => {
    if (!app.initialized || !isDesktopPlatform() || localStorage.getItem(DESKTOP_MIGRATION_SEEN_KEY)) {
      return;
    }
    const hasActiveRecord = app.blocks.some((block) => block.type === "record" && !block.deletedAt);
    if (!hasActiveRecord) {
      setDesktopMigrationOpen(true);
    }
  }, [app.blocks, app.initialized]);

  useEffect(() => {
    if (!app.initialized || Capacitor.isNativePlatform() || isDesktopPlatform()) {
      return undefined;
    }

    const sessionId = createWebNavigationSessionId();
    webNavigationSessionRef.current = sessionId;
    const previousScrollRestoration = window.history.scrollRestoration;
    window.history.scrollRestoration = "manual";
    const initial = navigationStateRef.current;
    window.history.replaceState(
      createWebNavigationSnapshot(sessionId, initial.activeTab, initial.tabMemory, initial.activeAiSessionId, window.scrollY),
      "",
    );

    const onPopState = (event: PopStateEvent) => {
      const snapshot = restoreWebNavigationSnapshot(event.state);
      if (!snapshot || snapshot.sessionId !== sessionId) {
        return;
      }

      clearBackHint();
      const motion: NavigationMotionIntent = snapshot.navigationIndex > webNavigationIndexRef.current
        ? "forward"
        : snapshot.navigationIndex < webNavigationIndexRef.current ? "back" : "replace";
      webNavigationIndexRef.current = snapshot.navigationIndex;
      navigationStateRef.current = {
        activeTab: snapshot.activeTab,
        tabMemory: snapshot.tabMemory,
        activeAiSessionId: snapshot.activeAiSessionId,
      };
      setNavigationMotion(motion);
      setActiveTab(snapshot.activeTab);
      setTabMemory(snapshot.tabMemory);
      setActiveAiSessionId(snapshot.activeAiSessionId);

      if (historyScrollRestoreRef.current) {
        window.cancelAnimationFrame(historyScrollRestoreRef.current);
      }
      historyScrollRestoreRef.current = window.requestAnimationFrame(() => {
        historyScrollRestoreRef.current = window.requestAnimationFrame(() => {
          window.scrollTo(0, snapshot.scrollY);
          historyScrollRestoreRef.current = 0;
        });
      });
    };

    window.addEventListener("popstate", onPopState);
    return () => {
      window.removeEventListener("popstate", onPopState);
      if (historyScrollRestoreRef.current) {
        window.cancelAnimationFrame(historyScrollRestoreRef.current);
        historyScrollRestoreRef.current = 0;
      }
      window.history.scrollRestoration = previousScrollRestoration;
      webNavigationSessionRef.current = null;
    };
  }, [app.initialized, clearBackHint]);

  useEffect(() => {
    if (!app.initialized || !isDesktopPlatform()) {
      return undefined;
    }
    return window.studyJournalDesktop?.onBackupFlushRequested(async () => {
      await flushDesktopPendingChanges();
      await onAppBackgroundAutoBackup();
      await app.refresh();
    });
  }, [app.initialized, app.refresh]);

  useEffect(() => {
    if (!app.initialized || app.dueRecordReviews.length === 0) {
      return;
    }
    const key = "study-journal-review-toast-date";
    const today = todayISO();
    if (localStorage.getItem(key) === today) {
      return;
    }
    localStorage.setItem(key, today);
    setReviewToast(`今天有 ${app.dueRecordReviews.length} 条笔记待复习`);
    const timer = window.setTimeout(() => setReviewToast(""), 4200);
    return () => window.clearTimeout(timer);
  }, [app.dueRecordReviews.length, app.initialized]);

  useEffect(() => {
    if (!Capacitor.isNativePlatform()) {
      return undefined;
    }

    let remove: (() => Promise<void>) | undefined;
    let cancelled = false;

    const showExitHint = () => {
      setBackToast("再次点击退出");
      if (backToastTimerRef.current) {
        window.clearTimeout(backToastTimerRef.current);
      }
      backToastTimerRef.current = window.setTimeout(() => {
        setBackToast("");
        backToastTimerRef.current = null;
      }, 2000);
    };

    void CapacitorApp.addListener("backButton", () => {
      if (document.querySelector(".image-lightbox")) {
        return;
      }

      // Immersive sessions report depth 0, but Back should leave the session
      // rather than dump the user on 今天 with no explanation.
      if (activeTab === "today" && tabMemory.today.adaptiveTaskId) {
        clearBackHint();
        closeAdaptiveTask();
        return;
      }
      if (activeTab === "review" && tabMemory.review.mode === "queue" && tabMemory.review.currentRecordId) {
        leaveReviewSession();
        return;
      }

      if (getTabDepth(activeTab, tabMemory) > 0) {
        clearBackHint();
        popCurrentTabDepth();
        return;
      }

      if (activeTab !== "today") {
        switchTab("today");
        return;
      }

      const now = Date.now();
      if (now - lastBackPressRef.current <= 2000) {
        if (backToastTimerRef.current) {
          window.clearTimeout(backToastTimerRef.current);
          backToastTimerRef.current = null;
        }
        setBackToast("");
        void CapacitorApp.exitApp();
        return;
      }

      lastBackPressRef.current = now;
      showExitHint();
    }).then((handle) => {
      remove = handle.remove;
      if (cancelled) {
        void handle.remove();
      }
    });

    return () => {
      cancelled = true;
      if (remove) {
        void remove();
      }
    };
  }, [activeTab, clearBackHint, closeAdaptiveTask, leaveReviewSession, popCurrentTabDepth, switchTab, tabMemory, updateNavigationState]);

  const favoriteRecords = useMemo(
    () => getFavoriteRecords(app.blocks.filter((block): block is RecordBlock => block.type === "record")),
    [app.blocks],
  );
  const referenceRecords = useMemo(
    () => app.blocks.filter((block): block is RecordBlock => block.type === "record" && !block.deletedAt),
    [app.blocks],
  );
  const recordReviewsByRecord = useMemo(
    () => Object.fromEntries(app.recordReviews.map((review) => [review.recordId, review])),
    [app.recordReviews],
  );
  const reviewLogsByRecord = useMemo(() => {
    const grouped: Record<string, typeof app.recordReviewLogs> = {};
    for (const log of app.recordReviewLogs) {
      grouped[log.recordId] = [...(grouped[log.recordId] ?? []), log];
    }
    return grouped;
  }, [app.recordReviewLogs]);
  const recordTitlesById = useMemo(
    () => Object.fromEntries(app.blocks.filter((block): block is RecordBlock => block.type === "record").map((record) => [record.id, record.title])),
    [app.blocks],
  );
  const aiRecordContexts = useMemo(() => Object.fromEntries(
    referenceRecords.map((record) => {
      const reviewState = app.recordReviews.find((item) => item.recordId === record.id);
      const reviewLogs = reviewLogsByRecord[record.id] ?? [];
      const feedback = app.reviewCoachSnapshot.decisionBlockFeedback
        .filter((item) => item.recordId === record.id && !item.deletedAt && item.comment.trim())
        .map((item) => {
          const interpretation = app.reviewCoachSnapshot.feedbackInterpretations.find(
            (candidate) => candidate.feedbackId === item.id && !candidate.deletedAt && candidate.status === "succeeded",
          );
          return {
            comment: item.comment,
            occurredAt: item.occurredAt,
            actionability: interpretation?.actionability,
            difficultyType: interpretation?.difficultyType,
            preferredPractice: interpretation?.preferredPractice ?? undefined,
          };
        });
      const knowledgePoints = app.reviewCoachSnapshot.legacyRecordKnowledgePointLinks
        .filter((link) => link.recordId === record.id && !link.deletedAt)
        .flatMap((link) => {
          const point = app.reviewCoachSnapshot.legacyKnowledgePoints.find(
            (candidate) => candidate.id === link.knowledgePointId && !candidate.deletedAt,
          );
          return point ? [{ name: point.name, role: link.role, status: point.status }] : [];
        });
      return [record.id, { reviewState, reviewLogs, feedback, knowledgePoints } satisfies AiRecordReviewContext];
    }),
  ), [app.recordReviews, app.reviewCoachSnapshot, referenceRecords, reviewLogsByRecord]);

  if (!app.initialized || !app.settings) {
    return (
      <div className="loading-screen">
        <ClipboardCheck size={28} />
        <span>正在打开你的本地学习日志...</span>
      </div>
    );
  }

  const settings = app.settings;
  const currentRecordState = getRecordState(activeTab, tabMemory);
  const currentRecord = currentRecordState.recordId
    ? app.blocks.find((block): block is RecordBlock => block.type === "record" && block.id === currentRecordState.recordId)
    : undefined;

  const openRecordReference = (recordId: string) => {
    const target = referenceRecords.find((record) => record.id === recordId);
    if (!target) {
      setBackToast("该日志已删除，无法打开预览");
      return;
    }

    const current = navigationStateRef.current;
    const state = getRecordState(current.activeTab, current.tabMemory);
    const openError = recordReferenceOpenError(state, recordId);
    if (openError === "cycle") {
      setBackToast("检测到循环引用，已停止打开");
      return;
    }
    if (openError === "depth") {
      setBackToast(`引用层级最多 ${MAX_RECORD_REFERENCE_DEPTH} 层`);
      return;
    }
    if (openError) {
      return;
    }

    clearBackHint();
    const scrollY = window.scrollY;
    const currentStack = state.referenceStack ?? [];
    const nextMemory: TabMemory = {
      ...current.tabMemory,
      [current.activeTab]: {
        ...state,
        recordId,
        highlightAssetId: undefined,
        recordEditing: false,
        referenceStack: [
          ...currentStack,
          {
            kind: "record",
            recordId: state.recordId,
            highlightAssetId: state.highlightAssetId,
            recordEditing: state.recordEditing,
            scrollY,
          },
        ],
        restoreScrollY: undefined,
      },
    };
    commitNavigation({ ...current, tabMemory: nextMemory }, { scrollToTop: true });
  };

  const openReviewQueueRecordReference = (sourceRecordId: string, recordId: string) => {
    const target = referenceRecords.find((record) => record.id === recordId);
    if (!target) {
      setBackToast("该日志已删除，无法打开预览");
      return;
    }

    const current = navigationStateRef.current;
    const openError = reviewQueueReferenceOpenError(current.tabMemory.review, sourceRecordId, recordId);
    if (openError === "cycle") {
      setBackToast("检测到循环引用，已停止打开");
      return;
    }
    if (openError === "depth") {
      setBackToast(`引用层级最多 ${MAX_RECORD_REFERENCE_DEPTH} 层`);
      return;
    }
    if (openError) {
      return;
    }

    clearBackHint();
    const scrollY = window.scrollY;
    const currentReview = current.tabMemory.review;
    const nextMemory: TabMemory = {
      ...current.tabMemory,
      review: {
        ...currentReview,
        recordId,
        highlightAssetId: undefined,
        recordEditing: false,
        referenceStack: [
          ...(currentReview.referenceStack ?? []),
          { kind: "review-queue", sourceRecordId, scrollY },
        ],
        restoreScrollY: undefined,
      },
    };
    commitNavigation({ ...current, tabMemory: nextMemory }, { scrollToTop: true });
  };

  const openAiForScope = async (scope: AiKnowledgeScope) => {
    setAiReturnTab(null);
    const attachment = await buildAiKnowledgeContextPackAsync(scope, app.blocks, app.assets);
    const session = await createAiSessionForScope(scope, attachment);
    if (session) {
      updateNavigationState((current) => ({ ...current, activeAiSessionId: session.id }));
      openMoreSubRoute("ai");
    }
  };

  const openAiForDate = async (date: string) => openAiForScope({ kind: "date", date });

  const openAiForRecord = async (record: RecordBlock) => {
    const originTab = navigationStateRef.current.activeTab;
    const scope: AiKnowledgeScope = { kind: "records", recordIds: [record.id] };
    const recordContext = aiRecordContexts[record.id];
    const attachment = await buildAiKnowledgeContextPackAsync(
      scope,
      app.blocks,
      app.assets,
      "",
      undefined,
      { recordContexts: { [record.id]: recordContext } },
    );
    const sessions = await storage.listAiSessions();
    const existing = sessions
      .filter((s) => !s.deletedAt && s.scope?.kind === "records" && s.scope.recordIds.length === 1 && s.scope.recordIds[0] === record.id)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
    if (existing && existing.lastContextHash === attachment.contextHash) {
      updateNavigationState((current) => ({ ...current, activeAiSessionId: existing.id }));
      setAiReturnTab(originTab !== "more" ? originTab : null);
      openMoreSubRoute("ai");
    } else {
      const session = await createAiSessionForScope(scope, attachment);
      if (session) {
        updateNavigationState((current) => ({ ...current, activeAiSessionId: session.id }));
        setAiReturnTab(originTab !== "more" ? originTab : null);
        openMoreSubRoute("ai");
      }
    }
  };

  const renderRecordPage = (record: RecordBlock, highlightedAssetId?: string) => (
    <RecordEditorPage
      record={record}
      initialEditing={Boolean(currentRecordState.recordEditing)}
      onEditingChange={setCurrentRecordEditing}
      onBack={closeRecordInCurrentTab}
      onSave={async (nextRecord, options) => {
        await app.saveBlock(nextRecord, options);
        newlyCreatedRecordIdsRef.current.delete(nextRecord.id);
      }}
      onDelete={async (recordId) => {
        await app.deleteBlock(recordId);
        closeRecordInCurrentTab();
      }}
      onToggleFavorite={(record, favorite) => app.toggleRecordFavorite(record.id, favorite)}
      onAddAsset={app.saveAssetFile}
      onAssetTitleChange={app.renameAssetTitle}
      onAssetChanged={app.refresh}
      highlightedAssetId={highlightedAssetId}
      subjects={app.subjects}
      templates={app.templates}
      referenceRecords={referenceRecords}
      onOpenRecordReference={openRecordReference}
      restoreScrollY={currentRecordState.restoreScrollY}
      onGetDraft={app.getRecordDraft}
      onSaveDraft={app.saveRecordDraft}
      onDeleteDraft={app.deleteRecordDraft}
      reviewState={recordReviewsByRecord[record.id]}
      reviewLogs={reviewLogsByRecord[record.id] ?? []}
      onAddToReview={async (recordId) => {
        await app.addRecordToReview(recordId);
      }}
      onSetReviewKind={async (recordId, kind) => {
        await app.setRecordReviewKind(recordId, kind);
      }}
      onResetReview={async (recordId) => {
        await app.resetRecordReview(recordId);
      }}
      onRemoveReview={async (recordId) => {
        await app.removeRecordFromReview(recordId);
      }}
      onExportRecord={(recordId) => exportRecordTransferPackage(storage, [recordId])}
      onOpenVoiceRecall={(sourceRecord) => openVoiceRecall(sourceRecord, "record")}
      isNewRecord={newlyCreatedRecordIdsRef.current.has(record.id)}
      onListDecisionBlockArchives={(recordId) => reviewCoachRepository.listRestorableDecisionBlockArchives(recordId)}
    />
  );

  const renderMorePage = () => {
    if (currentRecord) {
      return renderRecordPage(currentRecord, tabMemory.more.highlightAssetId);
    }

    switch (tabMemory.more.subRoute) {
      case "templates":
        return (
          <TemplateLibraryPage
            templates={app.templates}
            onBack={popCurrentTabDepth}
            onSaveTemplate={app.saveContentTemplate}
            onDeleteTemplate={app.deleteContentTemplate}
            onSaveAsset={app.saveAssetFile}
            onRenameAsset={app.renameAssetTitle}
            onAssetChanged={app.refresh}
          />
        );
      case "stats":
        return <StatsPage blocks={app.blocks} assets={app.assets} subjects={app.subjects} reviewStats={app.recordReviewStats} />;
      case "recordings":
        return (
          <RecordingsPage
            blocks={app.blocks}
            assets={app.assets}
            podcasts={app.podcasts}
            subjects={app.subjects}
            selectedFolderId={tabMemory.more.recordingsState.selectedFolderId}
            playerAssetId={tabMemory.more.recordingsState.playerAssetId}
            playerQueueSource={tabMemory.more.recordingsState.playerQueueSource}
            query={tabMemory.more.recordingsState.query}
            searchOpen={tabMemory.more.recordingsState.searchOpen}
            onSelectedFolderChange={(selectedFolderId) => {
              const current = navigationStateRef.current;
              if (!selectedFolderId && current.tabMemory.more.recordingsState.selectedFolderId) {
                popCurrentTabDepth();
                return;
              }
              if (current.tabMemory.more.recordingsState.selectedFolderId === selectedFolderId) {
                return;
              }
              commitNavigation({
                ...current,
                tabMemory: {
                  ...current.tabMemory,
                  more: {
                    ...current.tabMemory.more,
                    recordingsState: { ...current.tabMemory.more.recordingsState, selectedFolderId },
                  },
                },
              });
            }}
            onPlayerChange={(playerAssetId, playerQueueSource?: RecordingPlayerQueueSource) => {
              const current = navigationStateRef.current;
              if (!playerAssetId && current.tabMemory.more.recordingsState.playerAssetId) {
                popCurrentTabDepth();
                return;
              }
              if (
                current.tabMemory.more.recordingsState.playerAssetId === playerAssetId
                && current.tabMemory.more.recordingsState.playerQueueSource?.kind === playerQueueSource?.kind
                && (playerQueueSource?.kind !== "folder" || current.tabMemory.more.recordingsState.playerQueueSource?.kind !== "folder" || current.tabMemory.more.recordingsState.playerQueueSource.folderId === playerQueueSource.folderId)
                && (playerQueueSource?.kind !== "search" || current.tabMemory.more.recordingsState.playerQueueSource?.kind !== "search" || current.tabMemory.more.recordingsState.playerQueueSource.query === playerQueueSource.query)
              ) {
                return;
              }
              commitNavigation({
                ...current,
                tabMemory: {
                  ...current.tabMemory,
                  more: {
                    ...current.tabMemory.more,
                    recordingsState: { ...current.tabMemory.more.recordingsState, playerAssetId, playerQueueSource },
                  },
                },
              });
            }}
            onQueryChange={(query) =>
              updateNavigationState((current) => ({
                ...current,
                tabMemory: {
                  ...current.tabMemory,
                  more: {
                    ...current.tabMemory.more,
                    recordingsState: { ...current.tabMemory.more.recordingsState, query },
                  },
                },
              }))
            }
            onSearchOpenChange={(searchOpen) => {
              const current = navigationStateRef.current;
              if (!searchOpen && current.tabMemory.more.recordingsState.searchOpen) {
                popCurrentTabDepth();
                return;
              }
              if (current.tabMemory.more.recordingsState.searchOpen === searchOpen) {
                return;
              }
              commitNavigation({
                ...current,
                tabMemory: {
                  ...current.tabMemory,
                  more: {
                    ...current.tabMemory.more,
                    recordingsState: { ...current.tabMemory.more.recordingsState, searchOpen },
                  },
                },
              });
            }}
            onBack={popCurrentTabDepth}
            onRenameAudio={app.renameAssetTitle}
            onDurationKnown={app.updateAssetDuration}
          />
        );
      case "settings":
        return (
          <SettingsPage
            settings={settings}
            onSaveSettings={(nextSettings) => void app.persistSettings(nextSettings)}
            visualTheme={visualTheme}
            onVisualThemeChange={setVisualTheme}
          />
        );
      case "favorites":
        return (
          <FavoritesPage
            records={favoriteRecords}
            onOpenRecord={(record) => openRecordInTab(record, "more")}
            onAskAi={(date) => void openAiForDate(date)}
            onToggleFavorite={(record, favorite) => void app.toggleRecordFavorite(record.id, favorite)}
            reviewStatesByRecord={recordReviewsByRecord}
            reviewLogsByRecord={reviewLogsByRecord}
            onAddToReview={(recordId) => void app.addRecordToReview(recordId)}
          />
        );
      case "trash":
        return (
          <TrashPage
            records={app.deletedRecords}
            onRestore={(record) => app.restoreBlock(record.id)}
            onPermanentDelete={async (record) => {
              const ok = window.confirm(`永久删除“${record.title}”吗？\n\n这一步无法恢复。`);
              if (ok) {
                await app.permanentlyDeleteBlock(record.id);
              }
            }}
            onClearTrash={async () => {
              const ok = window.confirm("确定清空回收站吗？\n\n所有回收站记录都会被永久删除，无法恢复。");
              if (!ok) {
                return;
              }
              for (const record of app.deletedRecords) {
                await app.permanentlyDeleteBlock(record.id);
              }
            }}
            onPurgeExpired={async () => {
              await app.purgeExpiredDeletedBlocks(30);
            }}
          />
        );
      case "backup":
        return <BackupPage settings={settings} autoBackupState={app.autoBackupState ?? { enabled: false, debounceMs: 600_000 }} onRestored={app.refresh} />;
      case "aiExport":
        return <AiExportPage onBack={popCurrentTabDepth} />;
      case "aiTools":
        return (
          <AiToolsPage
            settings={settings}
            onChanged={app.refresh}
            onBack={popCurrentTabDepth}
          />
        );
      case "podcasts":
        return (
          <KnowledgePodcastPage
            settings={settings}
            podcasts={app.podcasts}
            blocks={app.blocks}
            assets={app.assets}
            podcastId={tabMemory.more.podcastId}
            screen={tabMemory.more.podcastScreen}
            onBack={popCurrentTabDepth}
            onOpenScope={() => {
              const current = navigationStateRef.current;
              if (!current.tabMemory.more.podcastId) return;
              commitNavigation({
                ...current,
                tabMemory: { ...current.tabMemory, more: { ...current.tabMemory.more, podcastScreen: "scope" } },
              });
            }}
            onOpenPodcast={(podcastId) => {
              const current = navigationStateRef.current;
              commitNavigation({
                ...current,
                tabMemory: { ...current.tabMemory, more: { ...current.tabMemory.more, subRoute: "podcasts", podcastId, podcastScreen: "editor" } },
              });
            }}
            onSavePodcast={app.saveKnowledgePodcast}
            onDeletePodcast={app.deleteKnowledgePodcast}
            onOpenRecord={(record) => openRecordInTab(record, "more")}
            onOpenSettings={() => openMoreSubRoute("ttsSettings")}
            onOpenTemplates={() => openMoreSubRoute("podcastTemplates")}
          />
        );
      case "ocrSettings":
        return <OcrSettingsPage onChanged={app.refresh} />;
      case "ttsSettings":
        return <TtsSettingsPage settings={settings} onChanged={app.refresh} />;
      case "podcastTemplates":
        return <PodcastTemplatesPage settings={settings} onChanged={app.refresh} />;
      case "guide":
        return <UsageGuidePage />;
      case "ai":
        return (
          <AiChatPage
            sessionId={activeAiSessionId}
            scopeScreenOpen={tabMemory.more.aiScreen === "scope"}
            settings={settings}
            blocks={app.blocks}
            assets={app.assets}
            recordContexts={aiRecordContexts}
            onBack={aiWorkspaceOnBack}
            onOpenSession={(sessionId) => {
              updateNavigationState((current) => ({
                ...current,
                activeAiSessionId: sessionId,
                tabMemory: {
                  ...current.tabMemory,
                  more: { ...current.tabMemory.more, subRoute: "ai", aiScreen: "chat" },
                },
              }));
            }}
            onDeletedSession={() => {
              updateNavigationState((current) => ({
                ...current,
                activeAiSessionId: null,
                tabMemory: {
                  ...current.tabMemory,
                  more: { ...current.tabMemory.more, subRoute: "ai", aiScreen: "chat" },
                },
              }));
            }}
            onOpenSettings={() => openMoreSubRoute("aiTools")}
            onOpenAiExport={() => openMoreSubRoute("aiExport")}
            onOpenScopeScreen={() => setAiWorkspaceScreen("scope")}
            onBackFromScopeScreen={popCurrentTabDepth}
            onOpenPodcastForScope={(scope) => {
              void app.saveKnowledgePodcast(createEmptyPodcast(scope)).then((saved) => {
                const current = navigationStateRef.current;
                commitNavigation({
                  ...current,
                  tabMemory: { ...current.tabMemory, more: { ...current.tabMemory.more, subRoute: "podcasts", podcastId: saved.id, podcastScreen: "editor", aiScreen: "chat" } },
                });
              });
            }}
          />
        );
      case null:
        return (
          <MorePage
            onOpenBackup={() => openMoreSubRoute("backup")}
            onOpenAi={() => openMoreSubRoute("ai")}
            onOpenOcrSettings={() => openMoreSubRoute("ocrSettings")}
            onOpenPodcasts={() => openMoreSubRoute("podcasts")}
            onOpenStats={() => openMoreSubRoute("stats")}
            onOpenSettings={() => openMoreSubRoute("settings")}
            onOpenTrash={() => openMoreSubRoute("trash")}
            onOpenRecordings={() => openMoreSubRoute("recordings")}
            onOpenTemplates={() => openMoreSubRoute("templates")}
            onOpenCategories={() => switchTab("categories")}
            onOpenGuide={() => openMoreSubRoute("guide")}
            settings={settings}
            autoBackupState={app.autoBackupState ?? undefined}
          />
        );
    }
  };

  const renderCurrentTab = () => {
    switch (activeTab) {
      case "today":
        return tabMemory.today.adaptiveTaskId ? (
          <AdaptiveReviewPage
            taskId={tabMemory.today.adaptiveTaskId}
            snapshot={app.reviewCoachSnapshot}
            records={app.recordBlocks}
            onBack={closeAdaptiveTask}
            onGenerateTurn={app.generateAdaptiveQuizTurn}
            onRequestHint={app.requestAdaptiveQuizHint}
            onSubmitAnswer={app.submitAdaptiveQuizAnswer}
            onSkipTurn={app.skipAdaptiveQuizTurn}
            onReportInvalid={app.reportAdaptiveQuizInvalid}
            onFinish={app.finishAdaptiveQuizTask}
            onFinishVerification={app.finishDelayedVerification}
            onDefer={app.deferAdaptiveTask}
            onAbandon={app.abandonAdaptiveQuizTask}
          />
        ) : currentRecord ? (
          renderRecordPage(currentRecord, tabMemory.today.highlightAssetId)
        ) : (
          <TodayPage
            entry={app.todayEntry}
            blocks={app.todayBlocks}
            examDate={settings.examDate}
            subjects={app.activeSubjects}
            templates={app.templates}
            onSaveEntry={(entry) => void app.saveEntry(entry)}
            onCreateRecord={async (date: string, subject: Subject, contentHtml?: string) => {
              const created = await app.createRecordBlock(date, subject, contentHtml);
              newlyCreatedRecordIdsRef.current.add(created.id);
              return created;
            }}
            onOpenFavorites={() => openMoreSubRoute("favorites")}
            onOpenRecord={(record) => openRecordInTab(record, "today")}
            onOpenReview={() => switchTab("review")}
            onAskAi={(date) => void openAiForDate(date)}
            onToggleFavorite={(record, favorite) => void app.toggleRecordFavorite(record.id, favorite)}
            reviewStatesByRecord={recordReviewsByRecord}
            reviewLogsByRecord={reviewLogsByRecord}
            dueReviewStates={app.dueRecordReviews}
            reviewStats={app.recordReviewStats}
            reviewTitlesByRecord={recordTitlesById}
            onAddToReview={(recordId) => void app.addRecordToReview(recordId)}
            onOpenCloudSyncSettings={() => openMoreSubRoute("backup")}
            onCloudSyncRestored={app.refresh}
          />
        );
      case "journal":
        return currentRecord ? (
          renderRecordPage(currentRecord, tabMemory.journal.highlightAssetId)
        ) : tabMemory.journal.searchOpen ? (
          <SearchPage
            entries={app.entries}
            blocks={app.blocks}
            assets={app.assets}
            query={tabMemory.journal.searchQuery}
            onQueryChange={(searchQuery) =>
              updateNavigationState((current) => ({
                ...current,
                tabMemory: { ...current.tabMemory, journal: { ...current.tabMemory.journal, searchQuery } },
              }))
            }
            onBack={popCurrentTabDepth}
            onOpenRecord={(recordId, assetId) => {
              const record = app.blocks.find((block): block is RecordBlock => block.type === "record" && block.id === recordId);
              if (record) {
                openRecordInTab(record, "journal", assetId);
              }
            }}
          />
        ) : (
          <JournalPage
            blocks={app.blocks}
            subjects={app.subjects}
            month={tabMemory.journal.month}
            selectedDate={tabMemory.journal.selectedDate}
            selectedSubject={tabMemory.journal.selectedSubject}
            browseMode={tabMemory.journal.browseMode}
            subjectFilter={tabMemory.journal.subjectFilter}
            visibleRecordCount={tabMemory.journal.visibleRecordCount}
            restoreListScrollY={tabMemory.journal.listScrollY}
            onMonthChange={(month) =>
              updateNavigationState((current) => ({
                ...current,
                tabMemory: { ...current.tabMemory, journal: { ...current.tabMemory.journal, month } },
              }))
            }
            onSelectedDateChange={(selectedDate) => {
              const current = navigationStateRef.current;
              if (!selectedDate && current.tabMemory.journal.selectedDate) {
                popCurrentTabDepth();
                return;
              }
              if (current.tabMemory.journal.selectedDate === selectedDate) {
                return;
              }
              commitNavigation({
                ...current,
                tabMemory: {
                  ...current.tabMemory,
                  journal: { ...current.tabMemory.journal, selectedDate, selectedSubject: undefined },
                },
              });
            }}
            onSelectedSubjectChange={(selectedSubject) => {
              const current = navigationStateRef.current;
              if (!selectedSubject && current.tabMemory.journal.selectedSubject) {
                popCurrentTabDepth();
                return;
              }
              if (current.tabMemory.journal.selectedSubject === selectedSubject) {
                return;
              }
              commitNavigation({
                ...current,
                tabMemory: {
                  ...current.tabMemory,
                  journal: { ...current.tabMemory.journal, selectedSubject },
                },
              });
            }}
            onBrowseModeChange={(browseMode) => updateNavigationState((current) => ({
              ...current,
              tabMemory: { ...current.tabMemory, journal: { ...current.tabMemory.journal, browseMode } },
            }))}
            onSubjectFilterChange={(subjectFilter) => updateNavigationState((current) => ({
              ...current,
              tabMemory: { ...current.tabMemory, journal: { ...current.tabMemory.journal, subjectFilter, visibleRecordCount: 20 } },
            }))}
            onVisibleRecordCountChange={(visibleRecordCount) => updateNavigationState((current) => ({
              ...current,
              tabMemory: { ...current.tabMemory, journal: { ...current.tabMemory.journal, visibleRecordCount } },
            }))}
            onOpenRecord={(record) => openRecordInTab(record, "journal", undefined, false, window.scrollY)}
            onOpenSearch={() => {
              const current = navigationStateRef.current;
              if (!current.tabMemory.journal.searchOpen) {
                commitNavigation({
                  ...current,
                  tabMemory: { ...current.tabMemory, journal: { ...current.tabMemory.journal, searchOpen: true } },
                });
              }
            }}
            onAskAi={(date) => void openAiForDate(date)}
            onToggleFavorite={(record, favorite) => void app.toggleRecordFavorite(record.id, favorite)}
            reviewStatesByRecord={recordReviewsByRecord}
            reviewLogsByRecord={reviewLogsByRecord}
            onAddToReview={(recordId) => void app.addRecordToReview(recordId)}
            onAddManyToReview={async (recordIds) => {
              const result = await app.addRecordsToReview(recordIds);
              return `成功加入 ${result.added} 条，重置 ${result.reset} 条，跳过 ${result.skippedActive} 条已在复习中的记录。`;
            }}
            onExportRecords={(recordIds) => exportRecordTransferPackage(storage, recordIds)}
          />
        );
      case "categories":
        return currentRecord ? (
          renderRecordPage(currentRecord, tabMemory.categories.highlightAssetId)
        ) : (
          <CategoriesPage
            blocks={app.blocks}
            subjects={app.subjects}
            activeSubject={tabMemory.categories.activeSubject}
            managing={tabMemory.categories.managing}
            onActiveSubjectChange={(activeSubject) => {
              const current = navigationStateRef.current;
              if (!activeSubject && current.tabMemory.categories.activeSubject) {
                popCurrentTabDepth();
                return;
              }
              if (current.tabMemory.categories.activeSubject === activeSubject) {
                return;
              }
              commitNavigation({
                ...current,
                tabMemory: { ...current.tabMemory, categories: { ...current.tabMemory.categories, activeSubject } },
              });
            }}
            onManagingChange={(managing) => {
              const current = navigationStateRef.current;
              if (!managing && current.tabMemory.categories.managing) {
                popCurrentTabDepth();
                return;
              }
              if (current.tabMemory.categories.managing === managing) {
                return;
              }
              commitNavigation({
                ...current,
                tabMemory: { ...current.tabMemory, categories: { ...current.tabMemory.categories, managing } },
              });
            }}
            onOpenRecord={(record) => openRecordInTab(record, "categories")}
            onAskAi={(date) => void openAiForDate(date)}
            onAskAiScope={(scope) => void openAiForScope(scope)}
            onAddSubject={app.addSubject}
            onRenameSubject={app.renameSubject}
            onSaveSubjects={app.saveSubjects}
            onToggleFavorite={(record, favorite) => void app.toggleRecordFavorite(record.id, favorite)}
            reviewStatesByRecord={recordReviewsByRecord}
            reviewLogsByRecord={reviewLogsByRecord}
            onAddToReview={(recordId) => void app.addRecordToReview(recordId)}
          />
        );
      case "review":
        return tabMemory.review.voiceRecall ? (
          <VoiceRecallWorkspace
            route={tabMemory.review.voiceRecall}
            blocks={app.blocks}
            assets={app.assets}
            subjects={app.subjects}
            templates={app.templates}
            settings={settings}
            onRouteChange={updateVoiceRecallRoute}
            onBack={closeVoiceRecall}
            onCreateJournal={createJournalFromVoiceRecall}
            visualTheme={visualTheme}
            sessionFactory={isVoiceRecallPolicyPreview() ? createVoiceRecallPolicyPreviewSession : undefined}
            playbackSinkFactory={isVoiceRecallPolicyPreview() ? () => ({ play: async () => undefined, stop: () => undefined }) : undefined}
          />
        ) : currentRecord ? (
          renderRecordPage(currentRecord, tabMemory.review.highlightAssetId)
        ) : (
          <ReviewPage
            records={app.blocks.filter((block): block is RecordBlock => block.type === "record" && !block.deletedAt)}
            dueReviews={app.dueRecordReviews}
            reviewStates={app.recordReviews}
            reviewLogsByRecord={reviewLogsByRecord}
            decisionBlockFeedback={app.reviewCoachSnapshot.decisionBlockFeedback}
            feedbackInterpretations={app.reviewCoachSnapshot.feedbackInterpretations}
            analysisQueueItems={app.reviewCoachSnapshot.analysisQueueItems}
            stats={app.recordReviewStats}
            mode={tabMemory.review.mode}
            queueIds={tabMemory.review.queueIds}
            currentRecordId={tabMemory.review.currentRecordId}
            reviewProgress={tabMemory.review.reviewProgress}
            libraryState={tabMemory.review.library}
            viewportOverlayHost={viewportOverlayHost}
            onModeChange={(mode) =>
              updateNavigationState((current) =>
                current.tabMemory.review.mode === mode
                  ? current
                  : {
                    ...current,
                    tabMemory: { ...current.tabMemory, review: { ...current.tabMemory.review, mode } },
                  },
              )
            }
            onExitReviewSession={leaveReviewSession}
            onQueueChange={(queueIds) =>
              updateNavigationState((current) =>
                sameIds(current.tabMemory.review.queueIds, queueIds)
                  ? current
                  : {
                    ...current,
                    tabMemory: { ...current.tabMemory, review: { ...current.tabMemory.review, queueIds } },
                  },
              )
            }
            onCurrentRecordChange={(currentRecordId) =>
              updateNavigationState((current) =>
                current.tabMemory.review.currentRecordId === currentRecordId
                  ? current
                  : {
                    ...current,
                    tabMemory: { ...current.tabMemory, review: { ...current.tabMemory.review, currentRecordId } },
                  },
              )
            }
            onReviewProgressChange={(reviewProgress) =>
              updateNavigationState((current) => {
                const currentProgress = current.tabMemory.review.reviewProgress;
                if (
                  currentProgress?.total === reviewProgress?.total &&
                  currentProgress?.completed === reviewProgress?.completed
                ) {
                  return current;
                }
                return {
                  ...current,
                  tabMemory: { ...current.tabMemory, review: { ...current.tabMemory.review, reviewProgress } },
                };
              })
            }
            onLibraryStateChange={(library) =>
              updateNavigationState((current) => ({
                ...current,
                tabMemory: { ...current.tabMemory, review: { ...current.tabMemory.review, library } },
              }))
            }
            onEnsureDay={app.ensureRecordReviewDay}
            referenceRecords={referenceRecords}
            referenceSubjects={app.subjects}
            onOpenRecordReference={openReviewQueueRecordReference}
            restoreScrollY={tabMemory.review.restoreScrollY}
            onRate={async (recordId, rating, feedback) => {
              const result = await app.rateRecordReview(recordId, rating, feedback);
              return result?.undoToken;
            }}
            onUndo={async (token) => {
              await app.undoRecordReview(token);
            }}
            reviewRuntime={reviewRuntime}
            onReviewRuntimeChange={setReviewRuntime}
            onDeleteDecisionBlockFeedback={app.deleteDecisionBlockFeedback}
            onConfirmFeedbackInterpretation={app.confirmFeedbackInterpretation}
            onRetryFeedbackInterpretation={app.retryFeedbackInterpretation}
            onTransitionAnalysisQueueItem={app.transitionAnalysisQueueItem}
            onUpdateAnalysisQueueItemNote={app.updateAnalysisQueueItemNote}
            onLinkLegacyReviewFeedback={app.linkLegacyReviewFeedback}
            onRefresh={app.refresh}
            onOpenStats={() => openMoreSubRoute("stats")}
            onOpenRecord={(record) => openRecordInTab(record, "review")}
            onEditRecord={(record) => openRecordInTab(record, "review", undefined, true)}
            onAskAiRecord={openAiForRecord}
            onOpenVoiceRecall={(record) => openVoiceRecall(record, "review-card")}
            onAddToReview={async (recordId) => {
              await app.addRecordToReview(recordId);
            }}
            onRemoveReview={async (recordId) => {
              await app.removeRecordFromReview(recordId);
            }}
            onResetReview={async (recordId) => {
              await app.resetRecordReview(recordId);
            }}
            reviewCoachPlanningBlocks={app.analysisPlanningBlocks}
            reviewCoachSnapshot={app.reviewCoachSnapshot}
            reviewCoachRecords={app.recordBlocks}
            reviewCoachProvider={getCurrentAiProvider(settings.ai)}
            onRunDeepAnalysis={app.runDeepAnalysis}
            onResumeDeepAnalysis={app.resumeDeepAnalysis}
            onSwitchAdaptiveTask={app.switchAdaptiveTask}
            onDeferAdaptiveTask={app.deferAdaptiveTask}
            onOpenAdaptiveTask={openAdaptiveTask}
            coachOpen={reviewCoachOpen}
            onCoachOpenChange={setReviewCoachOpen}
          />
        );
      case "more":
        return renderMorePage();
    }
  };

  const pageKey = buildTabPageKey(activeTab, tabMemory, activeAiSessionId);
  const aiWorkspaceActive = activeTab === "more" && tabMemory.more.subRoute === "ai";
  const podcastScopeActive = activeTab === "more"
    && tabMemory.more.subRoute === "podcasts"
    && tabMemory.more.podcastScreen === "scope";
  const reviewScopePickerActive = activeTab === "review"
    && tabMemory.review.voiceRecall?.screen === "scope";
  const immersiveTaskActive = Boolean(
    (currentRecord && currentRecordState.recordEditing)
    || (activeTab === "review" && tabMemory.review.mode === "queue" && tabMemory.review.currentRecordId)
    || (activeTab === "today" && tabMemory.today.adaptiveTaskId)
    || (activeTab === "review" && Boolean(tabMemory.review.voiceRecall)),
  );

  const shellClassName = [
    "app-shell",
    isDesktopPlatform() ? "desktop-app" : "",
    keyboardVisible ? "keyboard-open" : "",
    aiWorkspaceActive ? "ai-chat-active" : "",
    podcastScopeActive || reviewScopePickerActive ? "ai-scope-active" : "",
    immersiveTaskActive ? "immersive-task-active" : "",
    activeTab === "review" && tabMemory.review.mode === "queue" && tabMemory.review.currentRecordId ? "review-session-active" : "",
  ].filter(Boolean).join(" ");
  const showWebNavigationBack = !Capacitor.isNativePlatform()
    && getTabDepth(activeTab, tabMemory) > 0
    && !immersiveTaskActive
    && !currentRecord
    && !(activeTab === "today" && tabMemory.today.adaptiveTaskId)
    && !(activeTab === "journal" && tabMemory.journal.searchOpen)
    && !(activeTab === "journal" && tabMemory.journal.selectedSubject)
    && !(activeTab === "categories" && (tabMemory.categories.activeSubject || tabMemory.categories.managing))
    && !(activeTab === "more" && tabMemory.more.subRoute !== null && MORE_SUB_ROUTES_WITH_OWN_BACK.includes(tabMemory.more.subRoute));

  return (
    <PlaybackProvider>
    <ViewportOverlayProvider host={viewportOverlayHost}>
    <div className={shellClassName}>
      <aside className="sidebar">
        <div className="brand">
          <span className="brand-mark" aria-hidden="true"><BookOpenText size={21} strokeWidth={1.8} /></span>
          <div className="brand-copy">
            <strong>学习日志</strong>
          </div>
          <CloudSyncButton
            className="sidebar-sync-button"
            onSignedOut={() => openMoreSubRoute("backup")}
            onRestored={app.refresh}
          />
        </div>
        <nav>
          {navItems.map((item) => {
            const Icon = item.icon;
            const active = item.subRoute
              ? activeTab === "more" && tabMemory.more.subRoute === item.subRoute
              : activeTab === item.tab;
            return (
              <button
                key={`${item.tab}-${item.subRoute ?? "root"}`}
                type="button"
                className={active ? "active" : ""}
                onClick={() => item.subRoute ? openMoreSubRoute(item.subRoute) : item.tab === "more" ? openMoreRoot() : switchTab(item.tab)}
              >
                <Icon size={19} />
                <span>{item.label}</span>
              </button>
            );
          })}
        </nav>
        <section className="pinned-panel">
          <p className="eyebrow">置顶日志</p>
          {favoriteRecords.length === 0 ? (
            <small>收藏的日志会出现在这里。</small>
          ) : (
            favoriteRecords.slice(0, 5).map((record) => (
              <button
                key={record.id}
                type="button"
                className="pinned-record-link"
                title={record.title || "未命名日志"}
                aria-label={`打开置顶日志 ${record.title || "未命名日志"}`}
                onClick={() => openRecordInTab(record, activeTab)}
              >
                <span>{record.title || "未命名日志"}</span>
              </button>
            ))
          )}
        </section>
        <div className="sidebar-utility-nav">
          <button type="button" onClick={() => switchTab("categories")}><Layers size={18} /><span>分类管理</span></button>
          <button type="button" onClick={() => openMoreSubRoute("settings")}><Settings size={18} /><span>设置</span></button>
        </div>
      </aside>
      <div className="content-area">
        {showWebNavigationBack && (
          <div className="web-navigation-back-row">
            <button type="button" className="secondary-button web-navigation-back" onClick={popCurrentTabDepth}>
              <ArrowLeft size={18} />
              返回
            </button>
          </div>
        )}
        <PageTransition pageKey={pageKey} motion={navigationMotion}>{renderCurrentTab()}</PageTransition>
      </div>
      {backToast && (
        <div className="app-toast" role="status" aria-live="polite">
          {backToast}
        </div>
      )}
      {reviewToast && (
        <div className="app-toast review-toast" role="status" aria-live="polite">
          {reviewToast}
        </div>
      )}
      <MotionPresence present={desktopMigrationOpen} variant="modal" className="desktop-migration-backdrop" role="presentation">
          <section className="desktop-migration-dialog" role="dialog" aria-modal="true" aria-labelledby="desktop-migration-title">
            <p className="eyebrow">Desktop Migration</p>
            <h2 id="desktop-migration-title">从 Web 端迁移日志</h2>
            <p>桌面版拥有独立本地数据库。请先在原 Web 地址导出完整备份或日志互通包，再在这里导入。</p>
            <div className="desktop-migration-actions">
              <button type="button" className="primary-button" onClick={openDesktopMigration}>打开导入页面</button>
              <button type="button" className="secondary-button" onClick={dismissDesktopMigration}>稍后处理</button>
            </div>
          </section>
      </MotionPresence>
      <CloudSyncConflictDialog onRestored={app.refresh} />
      <CloudSyncStatusToast />
      <nav className="bottom-nav">
        {bottomNavItems.map((item, index) => {
          const Icon = item.icon;
          const active = activeTab === item.tab;
          const itemButton = (
            <button
              key={item.tab}
              type="button"
              className={active ? "active" : ""}
              onClick={() => item.tab === "more" ? openMoreRoot() : switchTab(item.tab)}
            >
              <Icon size={20} />
              <span>{item.label}</span>
              {item.tab === "review" && app.dueRecordReviews.length > 0 && (
                <b className="bottom-nav-badge">{app.dueRecordReviews.length}</b>
              )}
            </button>
          );
          return index === 2 ? (
            <div className="bottom-nav-pair" key={item.tab}>
              <button type="button" className="bottom-nav-create" onClick={() => void createRecordFromGlobalAction()} aria-label="新建学习日志" title="新建学习日志"><Plus size={25} /></button>
              {itemButton}
            </div>
          ) : itemButton;
        })}
      </nav>
      <div ref={setViewportOverlayHost} className="app-viewport-overlay" />
    </div>
    </ViewportOverlayProvider>
    </PlaybackProvider>
  );
};
