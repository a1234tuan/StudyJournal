import {
  ArrowLeft,
  BookOpenCheck,
  Check,
  Clock3,
  History,
  Mic,
  MicOff,
  Pause,
  Play,
  Send,
  Sparkles,
  Trash2,
  X,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { AiKnowledgeScopePicker } from "../../components/AiKnowledgeScopePicker";
import { getAiKnowledgeScopeRecords } from "../../services/aiContextService";
import { getCurrentAiProvider } from "../../lib/aiProviders";
import { recordToPlainText } from "../../lib/recordContent";
import type { AppSettings, Asset, Block, ContentTemplate, RecordBlock, SubjectConfig } from "../../types";
import type { VoiceRecallNavigationRoute } from "../../lib/tabNavigation";
import type { VisualTheme } from "../../lib/visualTheme";
import { formatUiError } from "../../lib/uiError";
import { createAsyncQueue, type AsyncQueue } from "./asyncQueue";
import { createVoicePlaybackSink } from "./audioPlaybackSink";
import type { VoiceAudioFrame, VoiceTeacherMessage } from "./contracts";
import { createVoiceRecallState, type VoiceRecallInputMode } from "./domain";
import type { VoiceRecallLocalHistory, VoiceRecallTurnLocal } from "./localTypes";
import { canUseNativeVoiceCapture, NativeVoiceCaptureAdapter } from "./nativeVoiceCapture";
import type { VoicePlaybackSink } from "./playbackQueue";
import {
  createProductionVoiceSession,
  describeVoiceError,
  type CreateProductionVoiceSessionInput,
  type ProductionVoiceSession,
} from "./productionPipeline";
import { VoiceRecallRepository, voiceRecallRepository } from "./repository";
import { VoiceRecallRuntimeController, voiceRecallRuntime } from "./runtimeController";
import { buildVoiceTeacherMessages } from "./teacherPrompt";
import { WebVoiceCaptureAdapter } from "./webVoiceCapture";
import {
  VoiceRecallCallView,
  VoiceRecallExitSheet,
  VoiceRecallHistoryView,
  VoiceRecallSummaryView,
  VoiceRecallStartView,
  type VoiceRecallKnowledgeMode,
  voiceRecallModeOptions,
  voiceRecallStatusCopy,
} from "./VoiceRecallPresentation";
import {
  BUILT_IN_VOICE_TEMPLATES,
  BUILT_IN_ASR_PROFILES,
  BUILT_IN_VOICE_TTS_PROFILES,
  USER_VOICE_TEMPLATES,
  getVoiceProviderTemplateSummary,
  readVoiceProviderTemplateId,
  readVoiceProviderConfig,
  writeVoiceProviderConfig,
  writeVoiceProviderTemplateId,
  type VoiceProviderEditableConfig,
} from "./providerProfiles";
import "./voiceRecallWorkspace.css";

const INPUT_MODES = voiceRecallModeOptions.map((mode) => ({ ...mode, detail: mode.note }));

const emptyUsage = {
  capturedSeconds: 0,
  asrSentSeconds: 0,
  llmInputTokens: 0,
  llmOutputTokens: 0,
  ttsCharacters: 0,
};

const escapeHtml = (value: string) => value
  .replace(/&/g, "&amp;")
  .replace(/</g, "&lt;")
  .replace(/>/g, "&gt;")
  .replace(/"/g, "&quot;");

const summaryHtml = (summary: string, template?: ContentTemplate) => {
  const paragraphs = summary.split(/\n+/).map((line) => line.trim()).filter(Boolean);
  const body = paragraphs.map((line) => `<p>${escapeHtml(line)}</p>`).join("");
  return `${template?.contentHtml ?? ""}<h2>语音复述摘要</h2>${body || "<p></p>"}`;
};

const createSummary = (turns: readonly VoiceRecallTurnLocal[], route: VoiceRecallNavigationRoute) => {
  const heading = route.topic?.trim() || route.learningGoal?.trim() || "本次主动回忆";
  const answers = turns.map((turn, index) => `${index + 1}. ${turn.confirmedText ?? turn.cleanText ?? ""}`).filter((line) => !line.endsWith(". "));
  return [`主题：${heading}`, ...answers].join("\n");
};

interface VoiceRecallWorkspaceProps {
  route: VoiceRecallNavigationRoute;
  blocks: Block[];
  assets: Asset[];
  subjects: SubjectConfig[];
  templates: readonly ContentTemplate[];
  settings: AppSettings;
  onRouteChange: (route: VoiceRecallNavigationRoute) => void;
  onBack: () => void;
  onCreateJournal: (subject: string, contentHtml: string) => Promise<void>;
  visualTheme?: VisualTheme;
  repository?: VoiceRecallRepository;
  runtime?: VoiceRecallRuntimeController;
  /** Test seams: production callers use the real provider pipeline and Web Audio. */
  sessionFactory?: (input: CreateProductionVoiceSessionInput) => Promise<ProductionVoiceSession>;
  playbackSinkFactory?: (session: ProductionVoiceSession) => VoicePlaybackSink;
}

export const VoiceRecallWorkspace = ({
  route,
  blocks,
  assets,
  subjects,
  templates,
  settings,
  onRouteChange,
  onBack,
  onCreateJournal,
  visualTheme = "reading",
  repository = voiceRecallRepository,
  runtime = voiceRecallRuntime,
  sessionFactory = createProductionVoiceSession,
  playbackSinkFactory = (session) => createVoicePlaybackSink({
    encoding: session.ttsEncoding,
    sampleRate: session.ttsSampleRate,
  }),
}: VoiceRecallWorkspaceProps) => {
  const [inputMode, setInputMode] = useState<VoiceRecallInputMode>("auto-half-duplex");
  const [topic, setTopic] = useState(route.topic ?? "");
  const [learningGoal, setLearningGoal] = useState(route.learningGoal ?? "复述并发现理解缺口");
  const [knowledgeBoundary, setKnowledgeBoundary] = useState<"supplement" | "strict">("supplement");
  const [disclosureConfirmed, setDisclosureConfirmed] = useState(false);
  const [turns, setTurns] = useState<VoiceRecallTurnLocal[]>([]);
  const [history, setHistory] = useState<VoiceRecallLocalHistory[]>([]);
  const [transcript, setTranscript] = useState("");
  const [teacherDraft, setTeacherDraft] = useState("");
  const [capturing, setCapturing] = useState(false);
  const [transcribing, setTranscribing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [historySaved, setHistorySaved] = useState(false);
  const [journalOpen, setJournalOpen] = useState(false);
  const [journalSubject, setJournalSubject] = useState(() => subjects.find((item) => !item.archivedAt)?.name ?? "");
  const [journalTemplateId, setJournalTemplateId] = useState("");
  const [runtimeState, setRuntimeState] = useState(runtime.snapshot);
  const [knowledgeMode, setKnowledgeMode] = useState<VoiceRecallKnowledgeMode>(route.sourceKind === "free-topic" ? "topic" : "material");
  const [callPalette] = useState<"bright" | "dark">("bright");
  const [captionsVisible, setCaptionsVisible] = useState(true);
  const [transcriptEditorOpen, setTranscriptEditorOpen] = useState(false);
  const [reduceMotion] = useState(false);
  const [backOpen, setBackOpen] = useState(false);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [preflightOpen, setPreflightOpen] = useState(false);
  const [providerTemplateId, setProviderTemplateId] = useState(() => readVoiceProviderTemplateId());
  const [providerConfig, setProviderConfig] = useState<VoiceProviderEditableConfig | undefined>(() => readVoiceProviderConfig());
  const [providerSummary, setProviderSummary] = useState<{ asr: string; llm: string; tts: string } | undefined>();
  const disclosureStorageKey = useMemo(() => `study-journal.voice-recall.disclosure.${providerTemplateId}`, [providerTemplateId]);
  const framesRef = useRef(0);
  const sessionRef = useRef<ProductionVoiceSession | undefined>(undefined);
  const frameQueueRef = useRef<AsyncQueue<VoiceAudioFrame> | undefined>(undefined);
  const asrFinalRef = useRef<string | undefined>(undefined);

  const activeSubjects = useMemo(() => subjects.filter((item) => !item.archivedAt).sort((a, b) => a.order - b.order), [subjects]);
  const selectedRecords = useMemo(
    () => blocks.filter((block): block is RecordBlock => block.type === "record" && route.recordIds.includes(block.id)),
    [blocks, route.recordIds],
  );
  const summary = useMemo(() => createSummary(turns, route), [route, turns]);

  useEffect(() => {
    setDisclosureConfirmed(typeof window !== "undefined" && window.localStorage.getItem(disclosureStorageKey) === "accepted");
    setPreflightOpen(false);
  }, [disclosureStorageKey]);

  const reloadHistory = useCallback(async () => setHistory(await repository.listHistory()), [repository]);
  const reloadTurns = useCallback(async () => {
    if (!route.sessionId) return setTurns([]);
    setTurns(await repository.listTurns(route.sessionId));
  }, [repository, route.sessionId]);

  useEffect(() => {
    const unsubscribe = runtime.subscribe(setRuntimeState);
    return () => { unsubscribe(); };
  }, [runtime]);
  useEffect(() => { void reloadHistory(); }, [reloadHistory]);
  useEffect(() => { void reloadTurns(); }, [reloadTurns]);
  useEffect(() => {
    if (route.screen !== "call" || !route.sessionId || runtime.activeSessionId === route.sessionId) return;
    void runtime.restoreSession(route.sessionId).catch((error) => setMessage(describeVoiceError(error)));
  }, [route.screen, route.sessionId, runtime]);
  useEffect(() => () => { void runtime.disposeView(); }, [runtime]);

  const startSession = async (nextRoute: VoiceRecallNavigationRoute, mode: "scope-practice" | "free-topic") => {
    if (!disclosureConfirmed || busy) return;
    setBusy(true);
    setMessage("");
    try {
      // Each session starts clean: a previous session's transcript, reply draft
      // and "history saved" flag must not leak into this one.
      setTranscript("");
      setTeacherDraft("");
      setHistorySaved(false);
      setMessage("");
      framesRef.current = 0;
      asrFinalRef.current = undefined;
      const session = await sessionFactory({
        settings,
        templateId: providerTemplateId,
        config: providerConfig,
      });
      sessionRef.current = session;
      setProviderSummary(session.summary);
      runtime.setPlaybackSink(playbackSinkFactory(session));
      const sessionId = await runtime.createSession({
        mode,
        inputMode,
        source: {
          kind: nextRoute.sourceKind,
          recordIds: nextRoute.recordIds,
          taskId: nextRoute.taskId,
          returnIdentity: nextRoute.returnTab,
        },
      });
      await runtime.updateMemory({ learningGoal: nextRoute.learningGoal ?? learningGoal });
      runtime.dispatch({ type: "OPEN_PREFLIGHT" });
      runtime.dispatch({ type: "CONFIRM_DISCLOSURE", confirmed: true });
      runtime.dispatch({ type: "CONNECT" });
      runtime.dispatch({ type: "CONNECTED" });
      onRouteChange({ ...nextRoute, screen: "call", sessionId });
    } catch (error) {
      setMessage(describeVoiceError(error));
    } finally {
      setBusy(false);
    }
  };

  const startScope = async (scope: import("../../types").AiKnowledgeScope) => {
    const records = getAiKnowledgeScopeRecords(scope, blocks, new Date().toISOString().slice(0, 10));
    if (!records.length) {
      setMessage("当前资料范围没有可用日志，请重新选择。");
      return;
    }
    onRouteChange({
      ...route,
      screen: "start",
      scope,
      sourceKind: "review-home",
      recordIds: records.map((record) => record.id),
      learningGoal,
    });
  };

  const resume = () => {
    if (runtime.snapshot?.status !== "paused") return;
    runtime.dispatch({ type: "RESUME" });
    runtime.dispatch({ type: "CONNECTED" });
  };

  const startCapture = async () => {
    if (capturing || busy) return;
    const session = sessionRef.current;
    if (!session) {
      setMessage("语音服务未就绪，请返回开始页重新连接。");
      return;
    }
    setMessage("");
    framesRef.current = 0;
    try {
      if (runtime.snapshot?.status === "paused") resume();
      if (runtime.snapshot?.status === "listening" && !runtime.snapshot.captureRequested) {
        runtime.dispatch({ type: "SET_CAPTURE_REQUESTED", requested: true });
      }
      const queue = createAsyncQueue<VoiceAudioFrame>();
      frameQueueRef.current = queue;
      const adapter = canUseNativeVoiceCapture() ? new NativeVoiceCaptureAdapter() : new WebVoiceCaptureAdapter();
      await runtime.startCapture(adapter, {
        inputMode,
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
        preferredFormat: session.asrFormat,
      }, (frame) => {
        framesRef.current += 1;
        queue.push(frame);
      }, (error) => {
        queue.close();
        frameQueueRef.current = undefined;
        setCapturing(false);
        setMessage(describeVoiceError(error));
      });
      setCapturing(true);
    } catch (error) {
      frameQueueRef.current = undefined;
      setMessage(describeVoiceError(error));
    }
  };

  const stopCapture = async () => {
    if (!capturing) return;
    const queue = frameQueueRef.current;
    const session = sessionRef.current;
    frameQueueRef.current = undefined;
    await runtime.stopCapture();
    setCapturing(false);
    queue?.close();
    if (runtime.snapshot?.status === "listening") {
      if (!runtime.snapshot.captureRequested) runtime.dispatch({ type: "SET_CAPTURE_REQUESTED", requested: true });
      runtime.dispatch({ type: "SUBMIT_CAPTURE" });
    }
    if (!session || !queue) {
      setMessage("语音服务未就绪，请返回开始页重新连接。");
      return;
    }
    if (framesRef.current === 0) {
      setMessage("没有采集到音频，请重新按住或点击主按钮说话。");
      if (runtime.snapshot?.status === "finalizing-asr") runtime.dispatch({ type: "CANCEL_TURN" });
      return;
    }
    setTranscribing(true);
    setMessage("正在识别你的回答…");
    try {
      const result = await runtime.transcribeTurn({
        pipeline: session.pipeline,
        frames: queue,
        format: session.asrFormat,
        onEvent: (event) => {
          if (event.type === "partial" || event.type === "final") setTranscript(event.text);
        },
      });
      asrFinalRef.current = result.transcript;
      setTranscript(result.transcript);
      setTranscriptEditorOpen(true);
      setMessage("转写已就绪，请校对后点击“确认并发送”。");
    } catch (error) {
      asrFinalRef.current = undefined;
      setMessage(describeVoiceError(error));
      if (runtime.snapshot?.status === "finalizing-asr") runtime.dispatch({ type: "CANCEL_TURN" });
    } finally {
      setTranscribing(false);
    }
  };

  const ensureListening = () => {
    if (runtime.snapshot?.status === "paused") resume();
    if (runtime.snapshot?.status === "failed") {
      runtime.dispatch({ type: "RETRY" });
      runtime.dispatch({ type: "CONNECTED" });
    }
  };

  const submitTurn = async () => {
    const confirmedText = transcript.trim();
    if (!route.sessionId || !confirmedText || busy || capturing || transcribing) return;
    const session = sessionRef.current;
    if (!session) {
      setMessage("语音服务未就绪，请返回开始页重新连接。");
      return;
    }
    setBusy(true);
    setMessage("");
    try {
      ensureListening();
      const stored = await repository.getSession(route.sessionId);
      if (!stored) throw new Error("语音复述会话不存在");
      const current = runtime.snapshot;
      if (current?.status === "listening") {
        if (!current.captureRequested) runtime.dispatch({ type: "SET_CAPTURE_REQUESTED", requested: true });
        runtime.dispatch({ type: "SUBMIT_CAPTURE" });
      }
      runtime.dispatch({ type: "ASR_FINALIZED", transcript: confirmedText });

      const messages: VoiceTeacherMessage[] = buildVoiceTeacherMessages({
        learningGoal: route.learningGoal ?? learningGoal,
        knowledgeBoundary,
        materials: selectedRecords.map((record) => ({ title: record.title, text: recordToPlainText(record, assets) })),
        turns: turns.map((turn) => ({ confirmedText: turn.confirmedText, teacherText: turn.teacherText })),
      });

      let replyStarted = false;
      setTeacherDraft("");
      const result = await runtime.respondTurn({
        pipeline: session.pipeline,
        messages,
        voice: session.ttsVoice,
        events: {
          onTeacherToken: (token) => {
            if (!replyStarted) {
              replyStarted = true;
              runtime.dispatch({ type: "LLM_REPLIED", teacherText: token });
            }
            setTeacherDraft((draft) => draft + token);
          },
          onAudio: (chunk) => { runtime.enqueueAudio(chunk); },
        },
      });
      if (!replyStarted) runtime.dispatch({ type: "LLM_REPLIED", teacherText: result.teacherText });
      await runtime.waitForPlayback();
      runtime.dispatch({ type: "PLAYBACK_FINISHED" });

      const now = new Date().toISOString();
      const asrFinal = asrFinalRef.current;
      const turn: VoiceRecallTurnLocal = {
        id: crypto.randomUUID(),
        sessionId: route.sessionId,
        sequence: stored.checkpoint.nextSequence,
        operationId: crypto.randomUUID(),
        status: "completed",
        teacherText: result.teacherText,
        providerFinalText: asrFinal,
        cleanText: confirmedText,
        confirmedText,
        transcriptEdited: Boolean(asrFinal && asrFinal !== confirmedText),
        playedCharacterCount: result.usage.ttsCharacters,
        createdAt: now,
        updatedAt: now,
      };
      await runtime.commitTurn(turn);
      setTranscript("");
      setTeacherDraft("");
      asrFinalRef.current = undefined;
      await reloadTurns();
    } catch (error) {
      setMessage(describeVoiceError(error));
      if (runtime.snapshot?.status === "thinking" || runtime.snapshot?.status === "finalizing-asr") {
        runtime.dispatch({ type: "CANCEL_TURN" });
      }
    } finally {
      setBusy(false);
    }
  };

  const finish = async () => {
    if (!route.sessionId || busy) return;
    setBusy(true);
    try {
      if (capturing) await stopCapture();
      await runtime.end();
      onRouteChange({ ...route, screen: "summary" });
    } catch (error) {
      setMessage(describeVoiceError(error));
    } finally {
      setBusy(false);
    }
  };

  const saveHistory = async () => {
    if (!route.sessionId || !summary.trim()) return;
    const now = new Date().toISOString();
    await repository.saveHistory({
      id: crypto.randomUUID(),
      sessionId: route.sessionId,
      sourceKind: route.sourceKind,
      source: { kind: route.sourceKind, recordIds: route.recordIds, taskId: route.taskId, returnIdentity: route.returnTab },
      title: route.topic?.trim() || route.learningGoal?.trim() || "语音主动回忆",
      summary,
      usage: emptyUsage,
      savedAt: now,
    });
    setHistorySaved(true);
    await reloadHistory();
  };

  const selectedMode = INPUT_MODES.find((mode) => mode.id === inputMode) ?? INPUT_MODES[0];
  const state = runtimeState ?? createVoiceRecallState();
  // The disclosure must name the model that will actually run: the template's
  // LLM id is aspirational, the configured AI provider is what gets called.
  const llmLabel = useMemo(() => {
    const provider = getCurrentAiProvider(settings.ai);
    return provider ? `${provider.providerName} · ${provider.model}` : "未配置的 AI 供应商";
  }, [settings.ai]);
  const providerSummaries = useMemo(() => Object.fromEntries(USER_VOICE_TEMPLATES.map((template) => [
    template.templateId,
    { ...getVoiceProviderTemplateSummary(template), llm: llmLabel },
  ])), [llmLabel]);
  const providerSetup = useMemo(() => ({
    templates: USER_VOICE_TEMPLATES,
    selectedTemplateId: USER_VOICE_TEMPLATES.some((template) => template.templateId === providerTemplateId) ? providerTemplateId : USER_VOICE_TEMPLATES[0].templateId,
    summaries: providerSummaries,
    onTemplateChange: (templateId: string) => { setProviderTemplateId(templateId); setProviderConfig((current) => current?.templateId === templateId ? current : undefined); writeVoiceProviderTemplateId(templateId); },
    config: providerConfig?.templateId === providerTemplateId ? providerConfig : (() => {
      const template = USER_VOICE_TEMPLATES.find((item) => item.templateId === providerTemplateId) ?? USER_VOICE_TEMPLATES[0];
      const asr = BUILT_IN_ASR_PROFILES.find((item) => item.id === template.asrProfileId);
      const tts = BUILT_IN_VOICE_TTS_PROFILES.find((item) => item.id === template.ttsProfileId);
      return { templateId: template.templateId, asrEndpoint: asr?.endpoint ?? "", asrModel: asr?.model ?? "", asrResourceId: asr?.resourceId ?? "", llmBaseUrl: "https://api.deepseek.com", llmModel: template.llmProfileId, ttsEndpoint: tts?.endpoint ?? "", ttsModel: tts?.model ?? "", ttsVoice: tts?.voice ?? "" };
    })(),
    onConfigChange: (config: VoiceProviderEditableConfig) => { setProviderConfig(config); writeVoiceProviderConfig(config); },
  }), [providerConfig, providerSummaries, providerTemplateId]);
  // The waveform and "正在识别" caption must follow the real microphone, not a
  // state-machine flag, otherwise the UI claims to listen while capture is off.
  const active = capturing && !state.userMuted && !state.systemCaptureGate;
  const mainControl = useMemo(() => {
    if (state.status === "speaking") return { label: state.userMuted ? "取消静音并说话" : "打断并说话", icon: Mic };
    if (state.status === "finalizing-asr" || state.status === "thinking") return { label: "取消当前轮次", icon: X };
    if (state.status !== "listening") return { label: voiceRecallStatusCopy[state.status], icon: Mic };
    if (state.userMuted) return { label: "取消静音并说话", icon: MicOff };
    if (state.inputMode === "auto-half-duplex") return { label: capturing ? "立即发送" : "开始回答", icon: Mic };
    if (state.inputMode === "push-to-talk") return { label: "按住说话", icon: Mic };
    return { label: capturing ? "发送" : "开始说话", icon: Mic };
  }, [capturing, state]);

  const interactionHint = useMemo(() => {
    if (state.status === "speaking") return "说话，或点击打断";
    if (state.status === "listening") {
      if (state.userMuted) return "麦克风已静音";
      if (capturing) return state.inputMode === "push-to-talk" ? "松开按钮立即发送" : "说完后点击发送";
      if (state.inputMode === "push-to-talk") return "按住主按钮开始回答";
      return "点击主按钮开始说话";
    }
    if (state.status === "finalizing-asr") return transcribing ? "正在识别你的回答…" : "请校对转写后发送";
    if (state.status === "thinking") return "正在理解你的回答";
    if (state.status === "paused") return "通话和麦克风均已暂停";
    if (state.status === "failed") return "可以重新连接或结束通话";
    return voiceRecallStatusCopy[state.status];
  }, [capturing, state, transcribing]);

  const requestBack = () => {
    if (["connecting", "listening", "finalizing-asr", "thinking", "speaking", "reconnecting", "failed"].includes(state.status)) {
      setBackOpen(true);
      return;
    }
    if (state.status === "paused") {
      void runtime.end().then(onBack);
      return;
    }
    onBack();
  };

  const handleMainClick = () => {
    if (state.status === "speaking") {
      if (state.userMuted) runtime.dispatch({ type: "SET_USER_MUTED", muted: false });
      void runtime.interruptPlayback();
      runtime.dispatch({ type: "INTERRUPT_AND_LISTEN" });
      return;
    }
    if (state.status === "finalizing-asr" || state.status === "thinking") {
      runtime.dispatch({ type: "CANCEL_TURN" });
      return;
    }
    if (state.status !== "listening" || state.inputMode === "push-to-talk") return;
    if (capturing) {
      void stopCapture();
      return;
    }
    if (state.userMuted) {
      runtime.dispatch({ type: "SET_USER_MUTED", muted: false });
      runtime.dispatch({ type: "SET_CAPTURE_REQUESTED", requested: true });
      return;
    }
    if (transcript.trim()) void submitTurn();
    else void startCapture();
  };

  const handlePressStart = () => {
    if (state.status === "listening" && state.inputMode === "push-to-talk" && !state.userMuted && !capturing) {
      runtime.dispatch({ type: "SET_CAPTURE_REQUESTED", requested: true });
      void startCapture();
    }
  };

  const handlePressEnd = () => {
    if (state.status === "listening" && state.inputMode === "push-to-talk" && capturing) {
      void stopCapture();
    }
  };

  if (route.screen === "scope") {
    return <AiKnowledgeScopePicker
      blocks={blocks}
      assets={assets}
      initialScope={route.scope}
      includeDate
      eyebrow="语音复述"
      title="选择本次资料范围"
      confirmLabel="使用这些资料"
      minSelectedRecords={1}
      maxSelectedRecords={10}
      onBack={() => onRouteChange({ ...route, screen: "start" })}
      onConfirm={startScope}
    />;
  }

  if (route.screen === "history") {
    return <VoiceRecallHistoryView theme={visualTheme} history={history} onBack={() => onRouteChange({ ...route, screen: "start" })} onDelete={(id) => void repository.deleteHistory(id).then(reloadHistory)} />;
  }

  if (route.screen === "summary") {
    const selectedTemplate = templates.find((item) => item.id === journalTemplateId);
    return <>
      <VoiceRecallSummaryView theme={visualTheme} summary={summary} turnCount={turns.length} historySaved={historySaved} onBack={() => onRouteChange({ ...route, screen: "start", sessionId: undefined })} onSaveHistory={() => void saveHistory()} onCreateJournal={() => setJournalOpen(true)} />
      {journalOpen && <section className="voice-journal-confirm" role="dialog" aria-modal="true" aria-labelledby="voice-journal-title"><header><h2 id="voice-journal-title">确认创建正式日志</h2><button type="button" className="icon-button" onClick={() => setJournalOpen(false)} aria-label="关闭"><X size={18} /></button></header><label><span>学科</span><select value={journalSubject} onChange={(event) => setJournalSubject(event.target.value)}>{activeSubjects.map((subject) => <option key={subject.id} value={subject.name}>{subject.name}</option>)}</select></label><label><span>模板</span><select value={journalTemplateId} onChange={(event) => setJournalTemplateId(event.target.value)}><option value="">空白日志</option>{templates.map((template) => <option key={template.id} value={template.id}>{template.title}</option>)}</select></label><p>只有点击确认后才会创建记录；随后进入编辑器，由现有本机草稿保护未保存修改。</p><button type="button" className="primary-button" disabled={!journalSubject || busy} onClick={() => void onCreateJournal(journalSubject, summaryHtml(summary, selectedTemplate))}><Check size={17} />确认创建并编辑</button></section>}
    </>;
  }

  if (route.screen === "call") {
    return <>
      <VoiceRecallCallView
        state={state}
        theme={visualTheme}
        callPalette={callPalette}
        reduceMotion={reduceMotion}
        captionsVisible={captionsVisible}
        transcriptEditorOpen={transcriptEditorOpen}
        active={active}
        elapsed={state.status === "paused" ? "已暂停" : "进行中"}
        selectedModeLabel={selectedMode.label}
        title={teacherDraft || turns.at(-1)?.teacherText || "先闭卷复述你记得的核心内容。"}
        contextLabel={selectedRecords.length ? `${selectedRecords.length} 条学习资料` : "自由主题"}
        questionLabel={`第 ${turns.length + 1} 个问题`}
        interactionHint={interactionHint}
        mainControl={mainControl}
        message={message}
        transcript={transcript}
        onBack={requestBack}
        onMainClick={handleMainClick}
        onPressStart={handlePressStart}
        onPressEnd={handlePressEnd}
        onMute={() => runtime.dispatch({ type: "SET_USER_MUTED", muted: !state.userMuted })}
        onToggleCaptions={() => setCaptionsVisible((value) => !value)}
        onToggleTranscriptEditor={() => setTranscriptEditorOpen((value) => !value)}
        onEnd={() => setBackOpen(true)}
        onOpenDetails={() => setDetailsOpen(true)}
        onRetry={() => { runtime.dispatch({ type: "RETRY" }); runtime.dispatch({ type: "CONNECTED" }); }}
        onResume={resume}
        onTranscriptChange={setTranscript}
        onSubmitTranscript={() => void submitTurn()}
      />
      {detailsOpen && <aside className="vr-details" aria-label="通话详情"><header><strong>通话详情</strong><button className="vr-icon-button" type="button" aria-label="关闭详情" onClick={() => setDetailsOpen(false)}><X /></button></header><dl><div><dt>资料</dt><dd>{selectedRecords.length ? `${selectedRecords.length} 条日志` : "自由主题"}</dd></div><div><dt>输入方式</dt><dd>{selectedMode.label}</dd></div><div><dt>状态</dt><dd>{voiceRecallStatusCopy[state.status]}</dd></div></dl>{providerSummary && <p className="vr-details-note">{providerSummary.asr} · {providerSummary.llm} · {providerSummary.tts}</p>}</aside>}
      {backOpen && <VoiceRecallExitSheet onPause={() => { void runtime.pause().then(() => onRouteChange({ ...route, screen: "start", sessionId: undefined })); setBackOpen(false); }} onEnd={() => { void finish(); setBackOpen(false); }} onContinue={() => setBackOpen(false)} />}
    </>;
  }

  const selectedTitle = selectedRecords.length === 1 ? selectedRecords[0].title : selectedRecords.length ? `${selectedRecords.length} 条学习资料` : "尚未选择资料";
  const selectedDetail = selectedRecords.length ? `${selectedRecords.length} 条日志 · 资料为主，允许适度补充` : "选择一条或多条日志开始复述";
  return <VoiceRecallStartView
    theme={visualTheme}
    knowledgeMode={knowledgeMode}
    selectedTitle={selectedTitle}
    selectedDetail={selectedDetail}
    topic={topic}
    learningGoal={learningGoal}
    inputMode={inputMode}
    busy={busy}
    canStart={knowledgeMode === "topic" ? Boolean(topic.trim()) : selectedRecords.length > 0}
    preflightOpen={preflightOpen}
    disclosureConfirmed={disclosureConfirmed}
    message={message}
    onBack={onBack}
    onOpenHistory={() => onRouteChange({ ...route, screen: "history" })}
    onKnowledgeModeChange={(mode) => { setKnowledgeMode(mode); if (mode === "topic") setTopic(topic || ""); }}
    onAdjustScope={() => onRouteChange({ ...route, screen: "scope", sourceKind: "review-home" })}
    onInputModeChange={setInputMode}
    onStart={() => {
      if (!disclosureConfirmed && !preflightOpen) {
        setDisclosureConfirmed(false);
        setPreflightOpen(true);
        return;
      }
      void startSession({ ...route, sourceKind: knowledgeMode === "topic" ? "free-topic" : route.sourceKind, topic: topic.trim(), learningGoal: learningGoal.trim() }, knowledgeMode === "topic" ? "free-topic" : "scope-practice");
    }}
    onDisclosureChange={(confirmed) => {
      setDisclosureConfirmed(confirmed);
      if (confirmed && typeof window !== "undefined") window.localStorage.setItem(disclosureStorageKey, "accepted");
    }}
    providerSetup={providerSetup}
  >
    {knowledgeMode === "topic" && <section className="vr-topic-editor"><label><span>主题</span><input value={topic} onChange={(event) => setTopic(event.target.value)} placeholder="例如：解释事件循环" /></label><label><span>本次目标</span><input value={learningGoal} onChange={(event) => setLearningGoal(event.target.value)} /></label></section>}
    {preflightOpen && <section className="vr-disclosure vr-production-disclosure"><div className="vr-disclosure-heading"><div><span className="vr-section-label">首次使用确认</span><h2>本次会使用哪些服务？</h2></div></div><p className="vr-disclosure-summary">你的语音会交给 <strong>{providerSummaries[providerSetup.selectedTemplateId]?.asr ?? "语音识别服务"}</strong> 识别，所选资料会交给 <strong>{providerSummaries[providerSetup.selectedTemplateId]?.llm ?? "内容理解服务"}</strong> 生成追问，AI 回复会由 <strong>{providerSummaries[providerSetup.selectedTemplateId]?.tts ?? "语音播放服务"}</strong> 播放。</p><label className="vr-confirm-check"><input type="checkbox" checked={disclosureConfirmed} onChange={(event) => { const confirmed = event.target.checked; setDisclosureConfirmed(confirmed); if (confirmed && typeof window !== "undefined") window.localStorage.setItem(disclosureStorageKey, "accepted"); }} /><span>我了解本次发送范围，并记住这个选择</span></label></section>}
  </VoiceRecallStartView>;
};
