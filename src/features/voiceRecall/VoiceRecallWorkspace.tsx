import {
  ArrowLeft,
  BookOpenCheck,
  Check,
  Clock3,
  History,
  Mic,
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
import type { Asset, Block, ContentTemplate, RecordBlock, SubjectConfig } from "../../types";
import type { VoiceRecallNavigationRoute } from "../../lib/tabNavigation";
import { formatUiError } from "../../lib/uiError";
import type { VoiceRecallInputMode } from "./domain";
import type { VoiceRecallLocalHistory, VoiceRecallTurnLocal } from "./localTypes";
import { canUseNativeVoiceCapture, NativeVoiceCaptureAdapter } from "./nativeVoiceCapture";
import { VoiceRecallRepository, voiceRecallRepository } from "./repository";
import { VoiceRecallRuntimeController, voiceRecallRuntime } from "./runtimeController";
import { WebVoiceCaptureAdapter } from "./webVoiceCapture";
import "./voiceRecallWorkspace.css";

const INPUT_MODES: Array<{ id: VoiceRecallInputMode; label: string; detail: string }> = [
  { id: "auto-half-duplex", label: "自动轮次", detail: "停顿后发送" },
  { id: "push-to-talk", label: "按住讲话", detail: "松开后发送" },
  { id: "tap-to-record", label: "点击录音", detail: "再次点击结束" },
];

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

const createTeacherReply = (answer: string, turnCount: number) => {
  const focus = answer.trim().replace(/\s+/g, " ").slice(0, 42);
  return turnCount === 0
    ? `我听到的核心是“${focus}”。请再说明它成立的条件，或者举一个反例。`
    : `这轮补充了“${focus}”。接下来请把它和前一轮结论连接起来。`;
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
  onRouteChange: (route: VoiceRecallNavigationRoute) => void;
  onBack: () => void;
  onCreateJournal: (subject: string, contentHtml: string) => Promise<void>;
  repository?: VoiceRecallRepository;
  runtime?: VoiceRecallRuntimeController;
}

export const VoiceRecallWorkspace = ({
  route,
  blocks,
  assets,
  subjects,
  templates,
  onRouteChange,
  onBack,
  onCreateJournal,
  repository = voiceRecallRepository,
  runtime = voiceRecallRuntime,
}: VoiceRecallWorkspaceProps) => {
  const [inputMode, setInputMode] = useState<VoiceRecallInputMode>("auto-half-duplex");
  const [topic, setTopic] = useState(route.topic ?? "");
  const [learningGoal, setLearningGoal] = useState(route.learningGoal ?? "复述并发现理解缺口");
  const [knowledgeBoundary, setKnowledgeBoundary] = useState<"supplement" | "strict">("supplement");
  const [durationMinutes, setDurationMinutes] = useState(10);
  const [disclosureConfirmed, setDisclosureConfirmed] = useState(false);
  const [turns, setTurns] = useState<VoiceRecallTurnLocal[]>([]);
  const [history, setHistory] = useState<VoiceRecallLocalHistory[]>([]);
  const [transcript, setTranscript] = useState("");
  const [mockAsrText, setMockAsrText] = useState("");
  const [capturing, setCapturing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [historySaved, setHistorySaved] = useState(false);
  const [journalOpen, setJournalOpen] = useState(false);
  const [journalSubject, setJournalSubject] = useState(() => subjects.find((item) => !item.archivedAt)?.name ?? "");
  const [journalTemplateId, setJournalTemplateId] = useState("");
  const [runtimeState, setRuntimeState] = useState(runtime.snapshot);
  const framesRef = useRef(0);

  const activeSubjects = useMemo(() => subjects.filter((item) => !item.archivedAt).sort((a, b) => a.order - b.order), [subjects]);
  const selectedRecords = useMemo(
    () => blocks.filter((block): block is RecordBlock => block.type === "record" && route.recordIds.includes(block.id)),
    [blocks, route.recordIds],
  );
  const summary = useMemo(() => createSummary(turns, route), [route, turns]);
  const contextualRecord = selectedRecords[0];

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
    void runtime.restoreSession(route.sessionId).catch((error) => setMessage(formatUiError(error, "voice-recall")));
  }, [route.screen, route.sessionId, runtime]);
  useEffect(() => () => { void runtime.disposeView(); }, [runtime]);

  const startSession = async (nextRoute: VoiceRecallNavigationRoute, mode: "scope-practice" | "free-topic") => {
    if (!disclosureConfirmed || busy) return;
    setBusy(true);
    setMessage("");
    try {
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
      setMessage(formatUiError(error, "voice-recall"));
    } finally {
      setBusy(false);
    }
  };

  const startScope = async (scope: import("../../types").AiKnowledgeScope) => {
    const records = getAiKnowledgeScopeRecords(scope, blocks, new Date().toISOString().slice(0, 10));
    await startSession({
      ...route,
      scope,
      sourceKind: "review-home",
      recordIds: records.map((record) => record.id),
      learningGoal,
    }, "scope-practice");
  };

  const resume = () => {
    if (runtime.snapshot?.status !== "paused") return;
    runtime.dispatch({ type: "RESUME" });
    runtime.dispatch({ type: "CONNECTED" });
  };

  const startCapture = async () => {
    if (capturing || busy) return;
    setMessage("");
    framesRef.current = 0;
    try {
      if (runtime.snapshot?.status === "paused") resume();
      const adapter = canUseNativeVoiceCapture() ? new NativeVoiceCaptureAdapter() : new WebVoiceCaptureAdapter();
      await runtime.startCapture(adapter, {
        inputMode,
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
        preferredFormat: { encoding: "pcm-s16le", sampleRate: 16_000, channelCount: 1 },
      }, () => { framesRef.current += 1; });
      setCapturing(true);
    } catch (error) {
      setMessage(formatUiError(error, "voice-recall"));
    }
  };

  const stopCapture = async () => {
    if (!capturing) return;
    await runtime.stopCapture();
    setCapturing(false);
    const sample = route.topic?.trim()
      ? `我对“${route.topic.trim()}”的理解是：这里需要补充真实转写。`
      : "本机采集已完成；真实 ASR 尚未验证，请在提交前把这段示例改成你的实际回答。";
    setMockAsrText(sample);
    setTranscript(sample);
    setMessage(`已采集 ${framesRef.current} 个 PCM 帧。当前使用 Mock ASR，必须人工校对后才能发送。`);
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
    if (!route.sessionId || !confirmedText || busy || capturing) return;
    setBusy(true);
    setMessage("");
    try {
      ensureListening();
      const session = await repository.getSession(route.sessionId);
      if (!session) throw new Error("语音复述会话不存在");
      if (runtime.snapshot?.status === "listening" && !runtime.snapshot.captureRequested) {
        runtime.dispatch({ type: "SET_CAPTURE_REQUESTED", requested: true });
      }
      runtime.dispatch({ type: "SUBMIT_CAPTURE" });
      runtime.dispatch({ type: "ASR_FINALIZED", transcript: confirmedText });
      const teacherText = createTeacherReply(confirmedText, turns.length);
      runtime.dispatch({ type: "LLM_REPLIED", teacherText });
      const now = new Date().toISOString();
      const turn: VoiceRecallTurnLocal = {
        id: crypto.randomUUID(),
        sessionId: route.sessionId,
        sequence: session.checkpoint.nextSequence,
        operationId: crypto.randomUUID(),
        status: "completed",
        teacherText,
        providerFinalText: mockAsrText || confirmedText,
        cleanText: confirmedText,
        confirmedText,
        transcriptEdited: Boolean(mockAsrText && mockAsrText !== confirmedText),
        playedCharacterCount: 0,
        createdAt: now,
        updatedAt: now,
      };
      await runtime.commitTurn(turn);
      runtime.dispatch({ type: "PLAYBACK_FINISHED" });
      setTranscript("");
      setMockAsrText("");
      await reloadTurns();
    } catch (error) {
      setMessage(formatUiError(error, "voice-recall"));
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
    return <main className="page voice-recall-workspace">
      <header className="voice-recall-topbar"><button type="button" className="icon-button" onClick={() => onRouteChange({ ...route, screen: "start" })} aria-label="返回语音复述"><ArrowLeft size={19} /></button><div><p className="eyebrow">仅此设备</p><h1>本机通话历史</h1></div></header>
      <p className="voice-recall-boundary-note">这些摘要不进入云同步或备份。卸载、清除数据或换机后无法恢复。</p>
      <section className="voice-history-list">
        {history.length === 0 && <div className="empty-state"><History size={28} /><h2>还没有保留的摘要</h2></div>}
        {history.map((item) => <article key={item.id} className="voice-history-item"><div><small>{new Date(item.savedAt).toLocaleString()}</small><h2>{item.title}</h2></div><p>{item.summary}</p><button type="button" className="icon-button danger" aria-label={`删除 ${item.title}`} onClick={() => void repository.deleteHistory(item.id).then(reloadHistory)}><Trash2 size={17} /></button></article>)}
      </section>
    </main>;
  }

  if (route.screen === "summary") {
    const selectedTemplate = templates.find((item) => item.id === journalTemplateId);
    return <main className="page voice-recall-workspace voice-recall-summary">
      <header className="voice-recall-topbar"><button type="button" className="icon-button" onClick={onBack} aria-label="返回来源"><X size={19} /></button><div><p className="eyebrow">Session complete</p><h1>本次复述摘要</h1></div></header>
      <section className="voice-summary-sheet"><pre>{summary || "本次没有形成可保留的正式转写。"}</pre></section>
      <div className="voice-summary-actions">
        <button type="button" className="primary-button" disabled={historySaved || !turns.length} onClick={() => void saveHistory()}><History size={17} />{historySaved ? "已保留在本机" : "保留为本机历史"}</button>
        <button type="button" disabled={!turns.length || !activeSubjects.length} onClick={() => setJournalOpen(true)}><BookOpenCheck size={17} />整理为日志</button>
        <button type="button" onClick={onBack}>不保留并返回</button>
      </div>
      {journalOpen && <section className="voice-journal-confirm" role="dialog" aria-modal="true" aria-labelledby="voice-journal-title"><header><h2 id="voice-journal-title">确认创建正式日志</h2><button type="button" className="icon-button" onClick={() => setJournalOpen(false)} aria-label="关闭"><X size={18} /></button></header><label><span>学科</span><select value={journalSubject} onChange={(event) => setJournalSubject(event.target.value)}>{activeSubjects.map((subject) => <option key={subject.id} value={subject.name}>{subject.name}</option>)}</select></label><label><span>模板</span><select value={journalTemplateId} onChange={(event) => setJournalTemplateId(event.target.value)}><option value="">空白日志</option>{templates.map((template) => <option key={template.id} value={template.id}>{template.title}</option>)}</select></label><p>只有点击确认后才会创建记录；随后进入编辑器，由现有本机草稿保护未保存修改。</p><button type="button" className="primary-button" disabled={!journalSubject || busy} onClick={() => void onCreateJournal(journalSubject, summaryHtml(summary, selectedTemplate))}><Check size={17} />确认创建并编辑</button></section>}
    </main>;
  }

  if (route.screen === "call") {
    const paused = runtimeState?.status === "paused";
    return <main className="page voice-recall-workspace voice-recall-call">
      <header className="voice-recall-topbar"><button type="button" className="icon-button" onClick={() => void runtime.disposeView().then(onBack)} aria-label="暂停并返回"><ArrowLeft size={19} /></button><div><p className="eyebrow">{selectedRecords.length ? `${selectedRecords.length} 条资料` : "自由主题"}</p><h1>{route.topic || route.learningGoal || "语音主动回忆"}</h1></div><span className={`voice-runtime-status ${paused ? "paused" : ""}`}>{paused ? "已暂停" : capturing ? "采集中" : "进行中"}</span></header>
      <p className="voice-recall-boundary-note warning">当前真实 Provider 尚未通过验收。麦克风可采集 PCM，但 ASR/教师回复使用明确标注的 Mock 链路，不会伪装成真实识别结果。</p>
      {paused && <button type="button" className="voice-resume-button" onClick={resume}><Play size={17} />继续会话</button>}
      <section className="voice-conversation" aria-live="polite">
        <article className="teacher"><small>学习教练</small><p>{turns.at(-1)?.teacherText ?? "先闭卷复述你记得的核心内容。"}</p></article>
        {turns.map((turn) => <article className="learner" key={turn.id}><small>我的确认回答 · 第 {turn.sequence + 1} 轮</small><p>{turn.confirmedText}</p></article>)}
      </section>
      <section className="voice-transcript-editor"><label htmlFor="voice-transcript">本轮转写校对</label><textarea id="voice-transcript" rows={4} value={transcript} onChange={(event) => setTranscript(event.target.value)} placeholder="可直接输入回答，或先试用本机采集；提交前必须确认文本。" /><div className="voice-capture-actions"><button type="button" className={capturing ? "active danger" : ""} onClick={() => void (capturing ? stopCapture() : startCapture())}>{capturing ? <Pause size={18} /> : <Mic size={18} />}{capturing ? "结束采集" : "试用本机采集"}</button><button type="button" className="primary-button" disabled={!transcript.trim() || busy || capturing || paused} onClick={() => void submitTurn()}><Send size={17} />确认并发送</button></div></section>
      <footer className="voice-call-footer"><div>{INPUT_MODES.map((item) => <button type="button" key={item.id} className={inputMode === item.id ? "active" : ""} aria-pressed={inputMode === item.id} disabled={turns.length > 0 || capturing} onClick={() => setInputMode(item.id)}><span>{item.label}</span><small>{item.detail}</small></button>)}</div><button type="button" className="voice-finish-button" disabled={busy} onClick={() => void finish()}><Check size={17} />结束并查看摘要</button></footer>
      {message && <p className="status-message" role="status">{message}</p>}
    </main>;
  }

  return <main className="page voice-recall-workspace voice-recall-start">
    <header className="voice-recall-topbar"><button type="button" className="icon-button" onClick={onBack} aria-label="返回复习"><ArrowLeft size={19} /></button><div><p className="eyebrow">Active recall</p><h1>语音复述</h1></div><button type="button" onClick={() => onRouteChange({ ...route, screen: "history" })}><History size={17} />本机历史</button></header>
    <section className="voice-start-intro"><Sparkles size={22} /><div><h2>先选择回忆范围，再开始说</h2><p>语音只是回答媒介，不会自动评分，也不会直接产生“已掌握”事实。</p></div></section>
    <div className="voice-start-grid">
      {contextualRecord && (route.sourceKind === "record" || route.sourceKind === "review-card") && (
        <section className="voice-start-panel voice-context-source">
          <h2>{route.sourceKind === "review-card" ? "复述当前卡片" : "复述当前日志"}</h2>
          <p>{contextualRecord.title}</p>
          <button type="button" className="primary-button" disabled={!disclosureConfirmed || busy} onClick={() => void startSession(route, "scope-practice")}>
            <Mic size={18} />开始闭卷复述
          </button>
        </section>
      )}
      <section className="voice-start-panel"><h2>基于学习资料</h2><p>选择一条或多条日志，围绕已有内容查漏与迁移。</p><button type="button" className="primary-button" onClick={() => onRouteChange({ ...route, screen: "scope", sourceKind: "review-home" })}><BookOpenCheck size={18} />选择资料范围</button></section>
      <section className="voice-start-panel"><h2>自由主题</h2><label><span>主题</span><input value={topic} onChange={(event) => setTopic(event.target.value)} placeholder="例如：解释事件循环" /></label><label><span>本次目标</span><input value={learningGoal} onChange={(event) => setLearningGoal(event.target.value)} /></label><button type="button" className="primary-button" disabled={!topic.trim() || !disclosureConfirmed || busy} onClick={() => void startSession({ ...route, sourceKind: "free-topic", recordIds: [], topic: topic.trim(), learningGoal: learningGoal.trim() }, "free-topic")}><Mic size={18} />开始自由复述</button></section>
    </div>
    <section className="voice-preflight"><div className="voice-preflight-row"><label><span>知识边界</span><select value={knowledgeBoundary} onChange={(event) => setKnowledgeBoundary(event.target.value as typeof knowledgeBoundary)}><option value="supplement">以日志为主，允许教材补充</option><option value="strict">严格依据日志</option></select></label><label><span>期望时长</span><select value={durationMinutes} onChange={(event) => setDurationMinutes(Number(event.target.value))}><option value={5}>5 分钟</option><option value={10}>10 分钟</option><option value={20}>20 分钟</option></select></label></div><div className="voice-input-mode" role="group" aria-label="语音输入模式">{INPUT_MODES.map((item) => <button type="button" key={item.id} className={inputMode === item.id ? "active" : ""} aria-pressed={inputMode === item.id} onClick={() => setInputMode(item.id)}><span>{item.label}</span><small>{item.detail}</small></button>)}</div><label className="voice-disclosure"><input type="checkbox" checked={disclosureConfirmed} onChange={(event) => setDisclosureConfirmed(event.target.checked)} /><span>我已了解：真实链路启用后，音频发送给 ASR、所选日志与转写发送给 LLM、教师文本发送给 TTS；本机历史不进入同步或备份。</span></label><small>{knowledgeBoundary === "strict" ? "教师不得扩展所选资料之外的事实。" : "补充内容必须与日志来源明确区分。"} · 预计 {durationMinutes} 分钟</small></section>
    {message && <p className="status-message" role="status">{message}</p>}
  </main>;
};
