import { useEffect, useMemo, useReducer, useRef, useState } from "react";
import {
  ArrowLeft,
  BookOpen,
  Check,
  Captions,
  ChevronRight,
  CircleStop,
  Headphones,
  LayoutGrid,
  Mic,
  MicOff,
  Moon,
  MoreHorizontal,
  Pause,
  Play,
  RotateCcw,
  Sparkles,
  ShieldCheck,
  Sun,
  Volume2,
  Wifi,
  WifiOff,
  X,
} from "lucide-react";

import {
  createVoiceRecallState,
  isVoiceCaptureActive,
  transitionVoiceRecallState,
  type VoiceRecallAction,
  type VoiceRecallInputMode,
  type VoiceRecallState,
} from "../features/voiceRecall/domain";
import "./voiceRecallPrototype.css";

type VisualTheme = "reading" | "modern";

const canPreviewVoiceRecall = (): boolean =>
  typeof window !== "undefined"
  && (window.location.hostname === "127.0.0.1" || window.location.hostname === "localhost")
  && new URLSearchParams(window.location.search).get("preview") === "voice-recall";

export const isVoiceRecallPrototypeRequest = (): boolean => canPreviewVoiceRecall();

const modeOptions: Array<{ id: VoiceRecallInputMode; label: string; note: string }> = [
  { id: "auto-half-duplex", label: "自动轮次", note: "停顿后由系统判断，随时可立即发送" },
  { id: "push-to-talk", label: "长按说话", note: "按住采集，松开立即发送" },
  { id: "tap-to-record", label: "点击录音", note: "点击开始，再点一次发送" },
];

const statusCopy: Record<VoiceRecallState["status"], string> = {
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

const reducer = (state: VoiceRecallState, action: VoiceRecallAction): VoiceRecallState =>
  transitionVoiceRecallState(state, action);

const Waveform = ({ active, reduced }: { active: boolean; reduced: boolean }) => (
  <div className={`vr-wave ${active ? "is-active" : ""} ${reduced ? "is-reduced" : ""}`} aria-hidden="true">
    {Array.from({ length: 19 }, (_, index) => <i key={index} style={{ "--bar": index } as React.CSSProperties} />)}
  </div>
);

const ThemeToggle = ({ theme, onChange }: { theme: VisualTheme; onChange: (theme: VisualTheme) => void }) => (
  <div className="vr-theme-toggle" role="group" aria-label="视觉主题">
    <button type="button" aria-pressed={theme === "reading"} onClick={() => onChange("reading")}>温润阅读</button>
    <button type="button" aria-pressed={theme === "modern"} onClick={() => onChange("modern")}>清爽现代</button>
  </div>
);

export const VoiceRecallPrototypeApp = () => {
  const [state, dispatch] = useReducer(reducer, undefined, () => createVoiceRecallState());
  const [theme, setTheme] = useState<VisualTheme>("modern");
  const [knowledgeMode, setKnowledgeMode] = useState<"material" | "topic">("material");
  const [backOpen, setBackOpen] = useState(false);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [reduceMotion, setReduceMotion] = useState(false);
  const [callPalette, setCallPalette] = useState<"bright" | "dark">("bright");
  const [captionsVisible, setCaptionsVisible] = useState(true);
  const timerRef = useRef<number | undefined>();

  useEffect(() => () => window.clearTimeout(timerRef.current), []);

  useEffect(() => {
    window.clearTimeout(timerRef.current);
    if (state.status === "connecting" || state.status === "reconnecting") {
      timerRef.current = window.setTimeout(() => dispatch({ type: "CONNECTED" }), 420);
    } else if (state.status === "finalizing-asr") {
      timerRef.current = window.setTimeout(() => dispatch({
        type: "ASR_FINALIZED",
        transcript: "主动回忆要求我先从记忆里提取答案，而连续重读更容易产生熟悉感。",
      }), 620);
    } else if (state.status === "thinking") {
      timerRef.current = window.setTimeout(() => dispatch({
        type: "LLM_REPLIED",
        teacherText: "方向正确。再补充一点：间隔让提取变得更费力，这种适度困难会强化长期记忆。下一轮请举一个自己的例子。",
      }), 720);
    } else if (state.status === "ending") {
      timerRef.current = window.setTimeout(() => dispatch({ type: "END_COMPLETE" }), 260);
    }
    return () => window.clearTimeout(timerRef.current);
  }, [state.status]);

  const active = isVoiceCaptureActive(state);
  const selectedMode = modeOptions.find((mode) => mode.id === state.inputMode)!;
  const elapsed = state.status === "idle" || state.status === "preflight" ? "00:00" : "04:18";

  const mainControl = useMemo(() => {
    if (state.status === "speaking") {
      return { label: state.userMuted ? "取消静音并说话" : "打断并说话", icon: Mic };
    }
    if (state.status === "finalizing-asr" || state.status === "thinking") {
      return { label: "取消当前轮次", icon: X };
    }
    if (state.status !== "listening") {
      return { label: statusCopy[state.status], icon: Mic };
    }
    if (state.userMuted) return { label: "取消静音并说话", icon: MicOff };
    if (state.inputMode === "auto-half-duplex") return { label: "立即发送", icon: Mic };
    if (state.inputMode === "push-to-talk") return { label: "按住说话", icon: Mic };
    return { label: state.captureRequested ? "发送" : "开始说话", icon: Mic };
  }, [state]);
  const MainControlIcon = mainControl.icon;
  const interactionHint = useMemo(() => {
    if (state.status === "speaking") return "说话，或点击打断";
    if (state.status === "listening") {
      if (state.userMuted) return "麦克风已静音";
      if (state.inputMode === "push-to-talk") return "按住主按钮开始回答";
      if (state.inputMode === "tap-to-record" && !state.captureRequested) return "点击主按钮开始说话";
      return "说完后点击发送";
    }
    if (state.status === "thinking" || state.status === "finalizing-asr") return "正在理解你的回答";
    if (state.status === "paused") return "通话和麦克风均已暂停";
    if (state.status === "connecting") return "正在建立本机模拟连接";
    if (state.status === "reconnecting") return "正在恢复刚才的通话";
    if (state.status === "ending") return "正在整理本次复述";
    if (state.status === "failed") return "可以重新连接或结束通话";
    if (state.status === "ended") return "摘要已在本机生成";
    return statusCopy[state.status];
  }, [state]);

  const submitCapture = () => {
    if (!state.captureRequested) dispatch({ type: "SET_CAPTURE_REQUESTED", requested: true });
    queueMicrotask(() => dispatch({ type: "SUBMIT_CAPTURE" }));
  };

  const handleMainClick = () => {
    if (state.status === "speaking") {
      if (state.userMuted) dispatch({ type: "SET_USER_MUTED", muted: false });
      dispatch({ type: "INTERRUPT_AND_LISTEN" });
      return;
    }
    if (state.status === "finalizing-asr" || state.status === "thinking") {
      dispatch({ type: "CANCEL_TURN" });
      return;
    }
    if (state.status !== "listening" || state.inputMode === "push-to-talk") return;
    if (state.userMuted) {
      dispatch({ type: "SET_USER_MUTED", muted: false });
      dispatch({ type: "SET_CAPTURE_REQUESTED", requested: true });
      return;
    }
    if (state.inputMode === "tap-to-record" && !state.captureRequested) {
      dispatch({ type: "SET_CAPTURE_REQUESTED", requested: true });
      return;
    }
    submitCapture();
  };

  const handlePressStart = () => {
    if (state.status === "listening" && state.inputMode === "push-to-talk" && !state.userMuted) {
      dispatch({ type: "SET_CAPTURE_REQUESTED", requested: true });
    }
  };

  const handlePressEnd = () => {
    if (state.status === "listening" && state.inputMode === "push-to-talk" && state.captureRequested) {
      dispatch({ type: "SUBMIT_CAPTURE" });
    }
  };

  const requestBack = () => {
    if (["connecting", "listening", "finalizing-asr", "thinking", "speaking", "reconnecting", "failed"].includes(state.status)) {
      setBackOpen(true);
    } else if (state.status === "paused") {
      dispatch({ type: "END" });
    }
  };

  if (state.status === "idle" || state.status === "preflight") {
    return (
      <main className="vr-shell vr-start" data-visual-theme={theme}>
        <header className="vr-start-header">
          <button className="vr-icon-button" type="button" aria-label="返回复习"><ArrowLeft /></button>
          <strong>语音复述</strong>
          <ThemeToggle theme={theme} onChange={setTheme} />
        </header>

        <section className="vr-start-band" aria-labelledby="vr-start-title">
          <div className="vr-start-copy">
            <p className="vr-eyebrow"><Sparkles />主动回忆</p>
            <h1 id="vr-start-title">把刚学过的内容讲出来</h1>
            <p>AI 一次问一个问题，练习不评分，也不改写原笔记。</p>
          </div>
          <div className="vr-kind-switch" role="tablist" aria-label="复述来源">
            <button type="button" role="tab" aria-selected={knowledgeMode === "material"} onClick={() => setKnowledgeMode("material")}>从学习资料开始</button>
            <button type="button" role="tab" aria-selected={knowledgeMode === "topic"} onClick={() => setKnowledgeMode("topic")}>自由主题</button>
          </div>
        </section>

        <section className="vr-setup-band" aria-label="通话设置">
          <span className="vr-setup-icon" aria-hidden="true"><BookOpen /></span>
          <div className="vr-setup-copy">
            <span>{knowledgeMode === "material" ? "已选学习资料" : "自由主题"}</span>
            <h2>{knowledgeMode === "material" ? "间隔复习与主动回忆" : "如何建立稳定的学习习惯"}</h2>
            <p>{knowledgeMode === "material" ? "1 条日志 · 约 6 分钟 · 资料为主，允许教材补充" : "查漏模式 · 约 5 分钟"}</p>
          </div>
          <button className="vr-row-action" type="button">调整范围 <ChevronRight /></button>
        </section>

        <section className="vr-mode-band" aria-labelledby="vr-mode-title">
          <div>
            <span className="vr-section-label">输入方式</span>
            <h2 id="vr-mode-title">选择一种说话方式</h2>
          </div>
          <div className="vr-mode-grid">
            {modeOptions.map((mode) => (
              <button
                type="button"
                key={mode.id}
                className={state.inputMode === mode.id ? "is-selected" : ""}
                aria-pressed={state.inputMode === mode.id}
                onClick={() => dispatch({ type: "SET_INPUT_MODE", mode: mode.id })}
              >
                <span>{mode.label}{state.inputMode === mode.id && <Check />}</span>
                <small>{mode.note}</small>
              </button>
            ))}
          </div>
        </section>

        {state.status === "preflight" && (
          <section className="vr-disclosure" aria-labelledby="vr-disclosure-title">
            <div className="vr-disclosure-heading"><ShieldCheck /><div><span className="vr-section-label">内容外发清单</span><h2 id="vr-disclosure-title">开始前确认数据去向</h2></div></div>
            <ul>
              <li><strong>语音</strong><span>麦克风音频 → Mock ASR（原型不离开设备）</span></li>
              <li><strong>资料与转写</strong><span>选中日志片段 → Mock LLM</span></li>
              <li><strong>教师文本</strong><span>生成回答 → Mock TTS</span></li>
            </ul>
            <label className="vr-confirm-check">
              <input type="checkbox" checked={state.preflightConfirmed} onChange={(event) => dispatch({ type: "CONFIRM_DISCLOSURE", confirmed: event.target.checked })} />
              <span>我已了解本次发送范围</span>
            </label>
          </section>
        )}

        <footer className="vr-start-footer">
          <div><span>Mock 链路 · 麦克风待授权</span><small>当前为隔离原型，不访问真实服务</small></div>
          {state.status === "idle" ? (
            <button className="vr-primary" type="button" onClick={() => dispatch({ type: "OPEN_PREFLIGHT" })}><Mic />开始语音复述</button>
          ) : (
            <button className="vr-primary" type="button" disabled={!state.preflightConfirmed} onClick={() => dispatch({ type: "CONNECT" })}><Headphones />确认并连接</button>
          )}
        </footer>
      </main>
    );
  }

  return (
    <main className="vr-shell vr-call" data-visual-theme={theme} data-call-palette={callPalette}>
      <header className="vr-call-header">
        <button className="vr-icon-button" type="button" aria-label="返回" onClick={requestBack}><ArrowLeft /></button>
        <div className="vr-scene-pill"><LayoutGrid /><span><strong>学习复述</strong><small>{elapsed} · {selectedMode.label}</small></span></div>
        <div className="vr-header-actions">
          <span className={`vr-connection ${state.status === "failed" ? "is-error" : ""}`}>{state.status === "failed" ? <WifiOff /> : <Wifi />}{state.status === "failed" ? "已断开" : "Mock 已连接"}</span>
          <button className="vr-icon-button" type="button" aria-label="通话设置" onClick={() => setDetailsOpen((value) => !value)}><MoreHorizontal /></button>
        </div>
      </header>

      {detailsOpen && (
        <aside className="vr-details" aria-label="通话技术详情">
          <header><strong>通话详情</strong><button className="vr-icon-button" type="button" aria-label="关闭详情" onClick={() => setDetailsOpen(false)}><X /></button></header>
          <dl><div><dt>模板</dt><dd>voice-mock-cn@1</dd></div><div><dt>输入</dt><dd>16 kHz · 单声道 PCM</dd></div><div><dt>运行代际</dt><dd>{state.generation}</dd></div></dl>
          <label><input type="checkbox" checked={reduceMotion} onChange={(event) => setReduceMotion(event.target.checked)} />减少动态效果</label>
          <div className="vr-call-palette-toggle" role="group" aria-label="通话声场">
            <button type="button" aria-pressed={callPalette === "bright"} onClick={() => setCallPalette("bright")}><Sun />明亮声场</button>
            <button type="button" aria-pressed={callPalette === "dark"} onClick={() => setCallPalette("dark")}><Moon />深色声场</button>
          </div>
          <button type="button" onClick={() => dispatch({ type: "FAIL", code: "mock-network-lost" })} disabled={state.status === "failed" || state.status === "ended"}><WifiOff />模拟网络中断</button>
          <ThemeToggle theme={theme} onChange={setTheme} />
        </aside>
      )}

      <section className="vr-conversation" aria-live="polite">
        <div className="vr-call-context"><span><BookOpen />间隔复习与主动回忆</span><span>第 2 个问题</span></div>
        <div className="vr-dialogue">
          {captionsVisible && (
            <p className="vr-user-turn">
              <span>{state.transcript ? "你" : "提示"}</span>
              {state.transcript || (active ? "正在识别你的回答…" : "先不看笔记，直接从记忆里回答。")}
            </p>
          )}
          <div className="vr-assistant-turn">
            <span>学习助教</span>
            <h1>{state.status === "ended" ? "这次复述到这里" : state.teacherText}</h1>
          </div>
        </div>
        {state.userMuted && <p className="vr-gate-message"><MicOff />你已静音，系统不会自动解除</p>}
        {!state.userMuted && state.systemCaptureGate && <p className="vr-gate-message"><Volume2 />教师播放中，麦克风暂时关闭</p>}
        {state.status === "failed" && <p className="vr-error-message">网络连接已中断。已确认的文本仍保留在本机。</p>}
      </section>

      <section className="vr-turn-cue" aria-label="当前通话状态">
        <div className={`vr-voice-field is-${state.status} ${active ? "is-active" : ""}`} aria-hidden="true">
          <Waveform active={active || state.status === "speaking"} reduced={reduceMotion} />
        </div>
        <strong>{statusCopy[state.status]}</strong>
        <span>{interactionHint}</span>
      </section>

      <footer className="vr-controls">
        {state.status === "failed" ? (
          <button className="vr-retry" type="button" onClick={() => dispatch({ type: "RETRY" })}><RotateCcw />重新连接</button>
        ) : state.status === "paused" ? (
          <button className="vr-retry" type="button" onClick={() => dispatch({ type: "RESUME" })}><Play />继续通话</button>
        ) : state.status === "ended" ? (
          <button className="vr-retry" type="button"><Check />返回复习</button>
        ) : (
          <>
            <button className={`vr-control-secondary ${state.userMuted ? "is-active" : ""}`} type="button" aria-pressed={state.userMuted} onClick={() => dispatch({ type: "SET_USER_MUTED", muted: !state.userMuted })}>{state.userMuted ? <MicOff /> : <Mic />}<span>{state.userMuted ? "已静音" : "静音"}</span></button>
            <button className={`vr-control-secondary ${captionsVisible ? "is-active" : ""}`} type="button" aria-pressed={captionsVisible} onClick={() => setCaptionsVisible((value) => !value)}><Captions /><span>{captionsVisible ? "字幕开" : "字幕关"}</span></button>
            <div className="vr-main-control-wrap">
              <button
                className={`vr-main-control ${active ? "is-capturing" : ""}`}
                type="button"
                aria-label={mainControl.label}
                disabled={["connecting", "reconnecting", "ending", "ended", "failed", "paused"].includes(state.status)}
                onClick={handleMainClick}
                onPointerDown={handlePressStart}
                onPointerUp={handlePressEnd}
                onPointerCancel={handlePressEnd}
              >
                <MainControlIcon />
              </button>
              <span>{mainControl.label}</span>
            </div>
            <button className="vr-control-secondary vr-control-end" type="button" onClick={() => setBackOpen(true)}><X /><span>结束</span></button>
          </>
        )}
      </footer>

      {backOpen && (
        <div className="vr-sheet-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setBackOpen(false); }}>
          <section className="vr-sheet" role="dialog" aria-modal="true" aria-labelledby="vr-back-title">
            <header><div><span className="vr-section-label">离开语音复述</span><h2 id="vr-back-title">要暂停还是结束本次通话？</h2></div><button className="vr-icon-button" type="button" aria-label="关闭" onClick={() => setBackOpen(false)}><X /></button></header>
            <button type="button" onClick={() => { dispatch({ type: "PAUSE" }); setBackOpen(false); }}><Pause /><span><strong>暂停并离开</strong><small>停止麦克风和播放，保留本机检查点</small></span></button>
            <button type="button" onClick={() => { dispatch({ type: "END" }); setBackOpen(false); }}><CircleStop /><span><strong>结束通话</strong><small>释放连接并进入本次摘要</small></span></button>
            <button type="button" onClick={() => setBackOpen(false)}><Play /><span><strong>继续通话</strong><small>关闭面板，不改变当前状态</small></span></button>
          </section>
        </div>
      )}
    </main>
  );
};
