import {
  ArrowLeft,
  BookOpen,
  Captions,
  Check,
  ChevronRight,
  CircleStop,
  Headphones,
  History,
  Keyboard,
  LayoutGrid,
  Mic,
  MicOff,
  MoreHorizontal,
  Pause,
  Play,
  RotateCcw,
  Sparkles,
  Trash2,
  Volume2,
  Wifi,
  WifiOff,
  X,
  type LucideIcon,
} from "lucide-react";
import type { CSSProperties, ReactNode } from "react";

import type { VoiceRecallInputMode, VoiceRecallState } from "./domain";
import type { VoiceRecallLocalHistory } from "./localTypes";
import type { VoiceProviderEditableConfig, VoiceProviderTemplate } from "./providerProfiles";
import "./voiceRecallPresentation.css";

export type VoiceRecallVisualTheme = "reading" | "modern";
export type VoiceRecallKnowledgeMode = "material" | "topic";

export interface VoiceRecallProviderSetup {
  templates: readonly VoiceProviderTemplate[];
  selectedTemplateId: string;
  summaries: Readonly<Record<string, { statusLabel: string; asr: string; llm: string; tts: string }>>;
  onTemplateChange: (templateId: string) => void;
  config: VoiceProviderEditableConfig;
  onConfigChange: (config: VoiceProviderEditableConfig) => void;
}

export const voiceRecallModeOptions: Array<{ id: VoiceRecallInputMode; label: string; note: string }> = [
  { id: "auto-half-duplex", label: "自动轮次", note: "停顿后发送" },
  { id: "push-to-talk", label: "按住讲话", note: "松开后发送" },
  { id: "tap-to-record", label: "点击录音", note: "再次点击结束" },
];

export const voiceRecallStatusCopy: Record<VoiceRecallState["status"], string> = {
  idle: "准备开始",
  preflight: "通话前检查",
  connecting: "正在连接",
  listening: "正在听",
  "finalizing-asr": "正在整理",
  thinking: "正在思考",
  speaking: "正在回答",
  paused: "已暂停",
  reconnecting: "正在重连",
  ending: "正在结束",
  failed: "连接中断",
  ended: "本次复述已结束",
};

const Waveform = ({ active, reduced }: { active: boolean; reduced: boolean }) => (
  <div className={`vr-wave ${active ? "is-active" : ""} ${reduced ? "is-reduced" : ""}`} aria-hidden="true">
    {Array.from({ length: 19 }, (_, index) => <i key={index} style={{ "--bar": index } as CSSProperties} />)}
  </div>
);


export interface VoiceRecallStartViewProps {
  theme: VoiceRecallVisualTheme;
  knowledgeMode: VoiceRecallKnowledgeMode;
  selectedTitle: string;
  selectedDetail: string;
  topic: string;
  learningGoal: string;
  inputMode: VoiceRecallInputMode;
  busy: boolean;
  canStart: boolean;
  preflightOpen: boolean;
  disclosureConfirmed: boolean;
  message?: string;
  children?: ReactNode;
  onBack: () => void;
  onOpenHistory: () => void;
  onKnowledgeModeChange: (mode: VoiceRecallKnowledgeMode) => void;
  onAdjustScope: () => void;
  onInputModeChange: (mode: VoiceRecallInputMode) => void;
  onStart: () => void;
  onDisclosureChange: (confirmed: boolean) => void;
  providerSetup?: VoiceRecallProviderSetup;
}

export const VoiceRecallStartView = ({
  theme,
  knowledgeMode,
  selectedTitle,
  selectedDetail,
  topic,
  learningGoal,
  inputMode,
  busy,
  canStart,
  preflightOpen,
  disclosureConfirmed,
  message,
  children,
  onBack,
  onOpenHistory,
  onKnowledgeModeChange,
  onAdjustScope,
  onInputModeChange,
  onStart,
  onDisclosureChange,
  providerSetup,
}: VoiceRecallStartViewProps) => (
  <main className="vr-shell vr-start" data-visual-theme={theme}>
    <header className="vr-start-header">
      <button className="vr-icon-button" type="button" aria-label="返回复习" onClick={onBack}><ArrowLeft /></button>
      <strong>语音复述</strong>
      <div className="vr-start-actions">
        <button className="vr-icon-button" type="button" aria-label="本机历史" onClick={onOpenHistory}><Headphones /></button>
      </div>
    </header>

    <section className="vr-start-band" aria-labelledby="vr-start-title">
      <div className="vr-start-copy">
        <p className="vr-eyebrow"><Sparkles />主动回忆</p>
        <h1 id="vr-start-title">把刚学过的内容讲出来</h1>
        <p>AI 一次问一个问题，练习不评分，也不改写原笔记。</p>
      </div>
      <div className="vr-kind-switch" role="tablist" aria-label="复述来源">
        <button type="button" role="tab" aria-selected={knowledgeMode === "material"} onClick={() => onKnowledgeModeChange("material")}>从学习资料开始</button>
        <button type="button" role="tab" aria-selected={knowledgeMode === "topic"} onClick={() => onKnowledgeModeChange("topic")}>自由主题</button>
      </div>
    </section>

    <section className="vr-setup-band" aria-label="通话设置">
      <span className="vr-setup-icon" aria-hidden="true"><BookOpen /></span>
      <div className="vr-setup-copy">
        <span>{knowledgeMode === "material" ? "已选学习资料" : "自由主题"}</span>
        <h2>{knowledgeMode === "material" ? selectedTitle : topic.trim() || "还没有填写主题"}</h2>
        <p>{knowledgeMode === "material" ? selectedDetail : learningGoal.trim() || "围绕一个主题进行主动回忆"}</p>
      </div>
      {knowledgeMode === "material" && <button className="vr-row-action" type="button" onClick={onAdjustScope}>调整范围 <ChevronRight /></button>}
    </section>

    <details className="vr-advanced-details">
      <summary><span>更多设置</span><small>当前：{voiceRecallModeOptions.find((mode) => mode.id === inputMode)?.label ?? "自动轮次"}</small></summary>
      <section className="vr-mode-band" aria-labelledby="vr-mode-title">
        <div><span className="vr-section-label">输入方式</span><h2 id="vr-mode-title">需要时再调整说话方式</h2></div>
        <div className="vr-mode-grid">
          {voiceRecallModeOptions.map((mode) => (
            <button type="button" key={mode.id} className={inputMode === mode.id ? "is-selected" : ""} aria-pressed={inputMode === mode.id} onClick={() => onInputModeChange(mode.id)}>
              <span>{mode.label}{inputMode === mode.id && <Check />}</span>
              <small>{mode.note}</small>
            </button>
          ))}
        </div>
      </section>
    </details>

    {providerSetup && <details className="vr-provider-details">
      <summary><span>语音服务</span><small>{providerSetup.summaries[providerSetup.selectedTemplateId]?.statusLabel ?? "本机配置"}</small></summary>
      <div className="vr-provider-body">
        <label><span>预置链路</span><select value={providerSetup.selectedTemplateId} onChange={(event) => providerSetup.onTemplateChange(event.target.value)}>{providerSetup.templates.map((template) => <option key={template.templateId} value={template.templateId}>{template.templateId}@{template.version}</option>)}</select></label>
        {providerSetup.summaries[providerSetup.selectedTemplateId] && <dl><div><dt>ASR</dt><dd>{providerSetup.summaries[providerSetup.selectedTemplateId].asr}</dd></div><div><dt>LLM</dt><dd>{providerSetup.summaries[providerSetup.selectedTemplateId].llm}</dd></div><div><dt>TTS</dt><dd>{providerSetup.summaries[providerSetup.selectedTemplateId].tts}</dd></div></dl>}
        <div className="vr-provider-edit-grid">
          <label><span>ASR Endpoint</span><input value={providerSetup.config.asrEndpoint} onChange={(event) => providerSetup.onConfigChange({ ...providerSetup.config, asrEndpoint: event.target.value })} /></label>
          <label><span>ASR 模型</span><input value={providerSetup.config.asrModel} onChange={(event) => providerSetup.onConfigChange({ ...providerSetup.config, asrModel: event.target.value })} placeholder="可留空" /></label>
          <label><span>Resource ID</span><input value={providerSetup.config.asrResourceId} onChange={(event) => providerSetup.onConfigChange({ ...providerSetup.config, asrResourceId: event.target.value })} placeholder="豆包 ASR 可选" /></label>
          <label><span>LLM Base URL</span><input value={providerSetup.config.llmBaseUrl} onChange={(event) => providerSetup.onConfigChange({ ...providerSetup.config, llmBaseUrl: event.target.value })} /></label>
          <label><span>LLM 模型</span><input value={providerSetup.config.llmModel} onChange={(event) => providerSetup.onConfigChange({ ...providerSetup.config, llmModel: event.target.value })} /></label>
          <label><span>TTS Endpoint</span><input value={providerSetup.config.ttsEndpoint} onChange={(event) => providerSetup.onConfigChange({ ...providerSetup.config, ttsEndpoint: event.target.value })} /></label>
          <label><span>TTS 模型</span><input value={providerSetup.config.ttsModel} onChange={(event) => providerSetup.onConfigChange({ ...providerSetup.config, ttsModel: event.target.value })} /></label>
          <label><span>音色 ID</span><input value={providerSetup.config.ttsVoice} onChange={(event) => providerSetup.onConfigChange({ ...providerSetup.config, ttsVoice: event.target.value })} /></label>
        </div>
        <p>字段覆盖仅保存在当前设备；API Key 请在现有 AI/TTS 设置中管理，不会写入语音路由、备份或云同步。候选 Provider 仍需真实账号与设备验收。</p>
      </div>
    </details>}

    {children}

    <footer className="vr-start-footer">
      <div><span>{providerSetup ? `${providerSetup.summaries[providerSetup.selectedTemplateId]?.asr ?? "语音识别"} · ${providerSetup.summaries[providerSetup.selectedTemplateId]?.llm ?? "内容理解"}` : "语音链路"}</span><small>{providerSetup?.summaries[providerSetup.selectedTemplateId]?.statusLabel ?? "通话前会检查服务状态"}</small></div>
      <button className="vr-primary" type="button" disabled={busy || !canStart || (preflightOpen && !disclosureConfirmed)} onClick={onStart}>{preflightOpen ? <Headphones /> : <Mic />}{preflightOpen ? "确认并连接" : "开始语音复述"}</button>
    </footer>
    {message && <p className="status-message" role="status">{message}</p>}
  </main>
);

export interface VoiceRecallCallViewProps {
  state: VoiceRecallState;
  theme: VoiceRecallVisualTheme;
  callPalette: "bright" | "dark";
  reduceMotion: boolean;
  captionsVisible: boolean;
  transcriptEditorOpen: boolean;
  active: boolean;
  elapsed: string;
  selectedModeLabel: string;
  title: string;
  contextLabel: string;
  questionLabel: string;
  interactionHint: string;
  mainControl: { label: string; icon: LucideIcon };
  message?: string;
  transcript: string;
  onBack: () => void;
  onMainClick: () => void;
  onPressStart: () => void;
  onPressEnd: () => void;
  onMute: () => void;
  onToggleCaptions: () => void;
  onToggleTranscriptEditor: () => void;
  onOpenDetails: () => void;
  onEnd: () => void;
  onRetry: () => void;
  onResume: () => void;
  onTranscriptChange: (value: string) => void;
  onSubmitTranscript: () => void;
}

export interface VoiceRecallHistoryViewProps {
  theme: VoiceRecallVisualTheme;
  history: readonly VoiceRecallLocalHistory[];
  onBack: () => void;
  onDelete: (id: string) => void;
}

export const VoiceRecallHistoryView = ({ theme, history, onBack, onDelete }: VoiceRecallHistoryViewProps) => (
  <main className="vr-shell vr-history" data-visual-theme={theme}>
    <header className="vr-start-header"><button className="vr-icon-button" type="button" aria-label="返回语音复述" onClick={onBack}><ArrowLeft /></button><h1>本机通话历史</h1><span className="vr-header-spacer" aria-hidden="true" /></header>
    <section className="vr-history-intro"><span className="vr-eyebrow"><Headphones />仅此设备</span><h1>你的复述轨迹</h1><p>摘要不会进入云同步。需要跨设备保留时，请整理为正式日志。</p></section>
    <section className="vr-history-list" aria-label="本机通话历史">{history.length === 0 ? <div className="vr-empty-state"><Headphones /><strong>还没有保留的摘要</strong><span>结束一次复述后，可在摘要页选择保留。</span></div> : history.map((item) => <article className="vr-history-item" key={item.id}><div><small>{new Date(item.savedAt).toLocaleString()}</small><h2>{item.title}</h2></div><p>{item.summary}</p><button type="button" className="vr-icon-button" aria-label={`删除 ${item.title}`} onClick={() => onDelete(item.id)}><Trash2 /></button></article>)}</section>
  </main>
);

export interface VoiceRecallSummaryViewProps {
  theme: VoiceRecallVisualTheme;
  summary: string;
  turnCount: number;
  historySaved: boolean;
  onBack: () => void;
  onSaveHistory: () => void;
  onCreateJournal: () => void;
}

export const VoiceRecallSummaryView = ({ theme, summary, turnCount, historySaved, onBack, onSaveHistory, onCreateJournal }: VoiceRecallSummaryViewProps) => (
  <main className="vr-shell vr-summary" data-visual-theme={theme}>
    <header className="vr-start-header"><button className="vr-icon-button" type="button" aria-label="返回来源" onClick={onBack}><X /></button><h1>本次复述摘要</h1><span className="vr-header-spacer" aria-hidden="true" /></header>
    <section className="vr-summary-hero"><span className="vr-eyebrow"><Sparkles />主动回忆完成</span><h1>{turnCount ? `完成 ${turnCount} 轮复述` : "这次没有形成正式回答"}</h1><p>先确认内容，再决定是否保留为本机历史或整理为正式日志。</p></section>
    <section className="vr-summary-sheet"><pre>{summary || "本次没有形成可保留的正式转写。"}</pre></section>
    <div className="vr-summary-actions"><button type="button" className="vr-primary-button" disabled={historySaved || !turnCount} onClick={onSaveHistory}><History />{historySaved ? "已保留在本机" : "保留为本机历史"}</button><button type="button" disabled={!turnCount} onClick={onCreateJournal}><BookOpen />整理为日志</button><button type="button" onClick={onBack}>不保留并返回</button></div>
  </main>
);

export const VoiceRecallCallView = ({
  state,
  theme,
  callPalette,
  reduceMotion,
  captionsVisible,
  transcriptEditorOpen,
  active,
  elapsed,
  selectedModeLabel,
  title,
  contextLabel,
  questionLabel,
  interactionHint,
  mainControl,
  message,
  transcript,
  onBack,
  onMainClick,
  onPressStart,
  onPressEnd,
  onMute,
  onToggleCaptions,
  onToggleTranscriptEditor,
  onOpenDetails,
  onEnd,
  onRetry,
  onResume,
  onTranscriptChange,
  onSubmitTranscript,
}: VoiceRecallCallViewProps) => {
  const MainControlIcon = mainControl.icon;
  return (
    <main className="vr-shell vr-call" data-visual-theme={theme} data-call-palette={callPalette}>
      <header className="vr-call-header">
        <button className="vr-icon-button" type="button" aria-label="返回" onClick={onBack}><ArrowLeft /></button>
        <div className="vr-scene-pill"><LayoutGrid /><span><strong>学习复述</strong><small>{elapsed} · {selectedModeLabel}</small></span></div>
        <div className="vr-header-actions"><span className={`vr-connection ${state.status === "failed" ? "is-error" : ""}`}>{state.status === "failed" ? <WifiOff /> : <Wifi />}{state.status === "failed" ? "已断开" : "已连接"}</span><button className="vr-icon-button" type="button" aria-label="更多通话选项" onClick={onOpenDetails}><MoreHorizontal /></button></div>
      </header>

      <section className="vr-conversation" aria-live="polite">
        <div className="vr-call-context"><span><BookOpen />{contextLabel}</span><span>{questionLabel}</span></div>
        <div className="vr-dialogue">
          {captionsVisible && <p className="vr-user-turn"><span>{state.transcript ? "你" : "提示"}</span>{state.transcript || (active ? "正在识别你的回答…" : "先不看笔记，直接从记忆里回答。")}</p>}
          <div className="vr-assistant-turn"><span>学习助教</span><h1>{state.status === "ended" ? "这次复述到这里" : title}</h1></div>
        </div>
        {state.userMuted && <p className="vr-gate-message"><MicOff />你已静音，系统不会自动解除</p>}
        {!state.userMuted && state.systemCaptureGate && <p className="vr-gate-message"><Volume2 />教师播放中，麦克风暂时关闭</p>}
        {state.status === "failed" && <p className="vr-error-message">网络连接已中断。已确认的文本仍保留在本机。</p>}
        {message && <p className="vr-error-message">{message}</p>}
      </section>

      {transcriptEditorOpen && <section className="vr-transcript-confirm"><label htmlFor="voice-transcript">本轮转写校对</label><textarea id="voice-transcript" rows={2} value={transcript} onChange={(event) => onTranscriptChange(event.target.value)} placeholder="输入或校对本轮回答" /><button type="button" disabled={!transcript.trim()} onClick={onSubmitTranscript}><Check />确认并发送</button></section>}
      <section className="vr-turn-cue" aria-label="当前通话状态"><div className={`vr-voice-field is-${state.status} ${active ? "is-active" : ""}`} aria-hidden="true"><Waveform active={active || state.status === "speaking"} reduced={reduceMotion} /></div><strong>{voiceRecallStatusCopy[state.status]}</strong><span>{interactionHint}</span></section>

      <footer className="vr-controls">
        {state.status === "failed" ? <button className="vr-retry" type="button" onClick={onRetry}><RotateCcw />重新连接</button>
          : state.status === "paused" ? <button className="vr-retry" type="button" onClick={onResume}><Play />继续通话</button>
            : state.status === "ended" ? <button className="vr-retry" type="button" onClick={onBack}><Check />返回复习</button>
              : <>
                <button className={`vr-control-secondary ${state.userMuted ? "is-active" : ""}`} type="button" aria-pressed={state.userMuted} onClick={onMute}>{state.userMuted ? <MicOff /> : <Mic />}<span>{state.userMuted ? "已静音" : "静音"}</span></button>
                <button className={`vr-control-secondary ${captionsVisible ? "is-active" : ""}`} type="button" aria-pressed={captionsVisible} aria-label="切换字幕显示" onClick={onToggleCaptions}><Captions /><span>{captionsVisible ? "隐藏字幕" : "字幕"}</span></button>
                <button className={`vr-control-secondary ${transcriptEditorOpen ? "is-active" : ""}`} type="button" aria-pressed={transcriptEditorOpen} aria-label="键盘输入校对" onClick={onToggleTranscriptEditor}><Keyboard /><span>{transcriptEditorOpen ? "收起输入" : "键盘输入"}</span></button>
                <div className="vr-main-control-wrap"><button className={`vr-main-control ${active ? "is-capturing" : ""}`} type="button" aria-label={mainControl.label} disabled={["connecting", "reconnecting", "ending", "ended", "failed", "paused"].includes(state.status)} onClick={onMainClick} onPointerDown={onPressStart} onPointerUp={onPressEnd} onPointerCancel={onPressEnd}><MainControlIcon /></button><span>{mainControl.label}</span></div>
                <button className="vr-control-secondary vr-control-end" type="button" aria-label="结束并查看摘要" onClick={onEnd}><X /><span>结束</span></button>
              </>}
      </footer>
    </main>
  );
};

export const VoiceRecallExitSheet = ({ onPause, onEnd, onContinue }: { onPause: () => void; onEnd: () => void; onContinue: () => void }) => (
  <div className="vr-sheet-backdrop" role="presentation">
    <section className="vr-sheet" role="dialog" aria-modal="true" aria-labelledby="vr-back-title">
      <header><div><span className="vr-section-label">离开语音复述</span><h2 id="vr-back-title">要暂停还是结束本次通话？</h2></div><button className="vr-icon-button" type="button" aria-label="关闭" onClick={onContinue}><X /></button></header>
      <button type="button" onClick={onPause}><Pause /><span><strong>暂停并离开</strong><small>停止麦克风和播放，保留本机检查点</small></span></button>
      <button type="button" onClick={onEnd}><CircleStop /><span><strong>结束通话</strong><small>释放连接并进入本次摘要</small></span></button>
      <button type="button" onClick={onContinue}><Play /><span><strong>继续通话</strong><small>关闭面板，不改变当前状态</small></span></button>
    </section>
  </div>
);
