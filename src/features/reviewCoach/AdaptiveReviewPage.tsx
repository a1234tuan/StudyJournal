import { AlertTriangle, ArrowLeft, Check, Clock3, Flag, Keyboard, Lightbulb, LoaderCircle, LogOut, Mic, Pause, Play, RotateCcw, Send } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

import { AiMarkdown } from "../../components/AiMarkdown";
import type { RecordBlock } from "../../types";
import { formatActionableError } from "../../lib/uiError";
import type { VoiceCaptureAdapter } from "../voiceRecall/contracts";
import { canUseNativeVoiceCapture, NativeVoiceCaptureAdapter } from "../voiceRecall/nativeVoiceCapture";
import { WebVoiceCaptureAdapter } from "../voiceRecall/webVoiceCapture";
import type { ReviewCoachFormalSnapshot, SubjectiveOutcome } from "./domain";
import { isLoopClosed } from "./evidencePolicy";
import { useInteractionTrace } from "../../hooks/useInteractionTrace";
import { CLOSED_LOOP_V2_LOOP_VERSION } from "./learningLoopPolicy";
import {
  MAX_CONSECUTIVE_EXECUTION_FAILED,
  interventionOptionsFor,
} from "./interventionPolicy";
import type { InterventionPath } from "./domain";

interface AdaptiveReviewPageProps {
  taskId: string;
  sessionId?: string;
  snapshot: ReviewCoachFormalSnapshot;
  records: readonly RecordBlock[];
  onBack: () => void;
  onGenerateTurn: (taskId: string, signal?: AbortSignal) => Promise<unknown>;
  onRequestHint: (turnId: string, level: number) => Promise<unknown>;
  onSubmitAnswer: (turnId: string, answer: string, signal?: AbortSignal) => Promise<unknown>;
  onSkipTurn: (turnId: string) => Promise<unknown>;
  onReportInvalid: (turnId: string, reason: string) => Promise<unknown>;
  /** v1 only. v2 never asks the learner to declare an outcome. */
  onFinish: (taskId: string, outcome: SubjectiveOutcome, reason?: string, confirmedConflict?: boolean) => Promise<unknown>;
  /** v1 only. v2 verification results are derived from the locked first answer. */
  onFinishVerification: (taskId: string, outcome: "retained" | "decayed", confirmedConflict?: boolean) => Promise<unknown>;
  /** v2: close the loop once the required retrievals exist. Takes no judgment. */
  onCompleteLoop: (taskId: string) => Promise<unknown>;
  /**
   * v2: settle a delayed verification from the locked first attempt.
   *
   * Separate from `onFinishVerification` on purpose: that one takes the
   * learner's verdict, this one takes nothing because the evidence already
   * answered the question.
   */
  onCompleteV2Verification: (taskId: string) => Promise<unknown>;
  /** v2: record the learner's chosen next action. Action only, never a diagnosis. */
  onSelectIntervention: (taskId: string, path: InterventionPath, turnId?: string) => Promise<unknown>;
  /** v2: park an unfinished attempt without declaring a result. */
  onDeferAttempt: (taskId: string) => Promise<unknown>;
  onDefer: (taskId: string) => Promise<unknown>;
  onAbandon: (taskId: string, reason: string) => Promise<unknown>;
}

const assessmentLabel = { correct: "回答正确", partial: "部分正确", incorrect: "仍有错误", unreliable: "无法可靠判断" } as const;

const extractSourceText = (record: RecordBlock | undefined, decisionBlockId: string): string => {
  if (!record || typeof DOMParser === "undefined") return "来源记录不可用";
  const document = new DOMParser().parseFromString(record.contentHtml, "text/html");
  return document.querySelector(`record-decision-block[data-decision-block-id="${CSS.escape(decisionBlockId)}"]`)?.textContent?.replace(/\s+/g, " ").trim() || "来源片段不可用";
};

export const AdaptiveReviewPage = ({ taskId, sessionId, snapshot, records, onBack, onGenerateTurn, onRequestHint, onSubmitAnswer, onSkipTurn, onReportInvalid, onFinish, onFinishVerification, onCompleteLoop, onCompleteV2Verification, onSelectIntervention, onDeferAttempt, onDefer, onAbandon }: AdaptiveReviewPageProps) => {
  const task = snapshot.adaptiveReviewTasks.find((item) => item.id === taskId);
  const blueprint = task ? snapshot.sessionBlueprints.find((item) => item.id === task.blueprintId) : undefined;
  const turns = useMemo(() => snapshot.adaptiveQuizTurns.filter((item) => item.taskId === taskId && item.status !== "invalid").sort((a, b) => a.sequence - b.sequence), [snapshot.adaptiveQuizTurns, taskId]);
  const currentTurn = turns.find((item) => item.status === "displayed") ?? turns.at(-1);
  const record = task ? records.find((item) => item.id === task.recordId) : undefined;
  const delayedVerification = task ? snapshot.delayedVerifications.find((item) => item.taskId === task.id) : undefined;
  const [answer, setAnswer] = useState("");
  const [answerInputMode, setAnswerInputMode] = useState<"text" | "voice">("text");
  const [voiceTranscriptConfirmed, setVoiceTranscriptConfirmed] = useState(false);
  const [capturingVoice, setCapturingVoice] = useState(false);
  const [busy, setBusy] = useState<string>();
  const [message, setMessage] = useState<string>();
  const [finishing, setFinishing] = useState(false);
  const [notMasteredReason, setNotMasteredReason] = useState("");
  const [invalidReason, setInvalidReason] = useState("");
  const [showInvalid, setShowInvalid] = useState(false);
  const [showExit, setShowExit] = useState(false);
  const [confirmMastered, setConfirmMastered] = useState(false);
  const [selectedPath, setSelectedPath] = useState<InterventionPath>();
  const captureAdapterRef = useRef<VoiceCaptureAdapter>();
  const captureAbortRef = useRef<AbortController>();
  const capturedFramesRef = useRef(0);
  // Leaving the page must cancel an in-flight paid generation, not just hide it.
  const requestAbortRef = useRef<AbortController>(new AbortController());
  useEffect(() => {
    const controller = new AbortController();
    requestAbortRef.current = controller;
    setBusy(undefined);
    return () => { controller.abort(); };
  }, [taskId]);

  const stopVoiceCapture = async () => {
    captureAbortRef.current?.abort();
    captureAbortRef.current = undefined;
    await captureAdapterRef.current?.stop().catch(() => undefined);
    captureAdapterRef.current = undefined;
    setCapturingVoice(false);
  };

  useEffect(() => () => { void stopVoiceCapture(); }, []);
  useEffect(() => {
    setAnswer("");
    setVoiceTranscriptConfirmed(false);
    void stopVoiceCapture();
  }, [currentTurn?.id]);

  const startVoiceCapture = () => {
    if (capturingVoice || busy) return;
    setMessage(undefined);
    setVoiceTranscriptConfirmed(false);
    capturedFramesRef.current = 0;
    const adapter = canUseNativeVoiceCapture() ? new NativeVoiceCaptureAdapter() : new WebVoiceCaptureAdapter();
    const controller = new AbortController();
    captureAdapterRef.current = adapter;
    captureAbortRef.current = controller;
    setCapturingVoice(true);
    void (async () => {
      try {
        for await (const _frame of adapter.start({
          inputMode: "tap-to-record",
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
          preferredFormat: { encoding: "pcm-s16le", sampleRate: 16_000, channelCount: 1 },
        }, controller.signal)) capturedFramesRef.current += 1;
      } catch (error) {
        if (!controller.signal.aborted) setMessage(formatActionableError(error, "adaptive-review"));
      } finally {
        if (captureAbortRef.current === controller) {
          captureAbortRef.current = undefined;
          captureAdapterRef.current = undefined;
          setCapturingVoice(false);
        }
      }
    })();
  };

  const finishVoiceCapture = async () => {
    await stopVoiceCapture();
    setMessage(`已采集 ${capturedFramesRef.current} 个 PCM 帧。真实 ASR 尚未验收，请手动填写或校对转写后再确认。`);
  };

  const run = async (key: string, work: () => Promise<unknown>, success?: string) => {
    const controller = requestAbortRef.current;
    setBusy(key);
    setMessage(undefined);
    try {
      await work();
      if (controller.signal.aborted) return false;
      setAnswer("");
      setVoiceTranscriptConfirmed(false);
      if (success) setMessage(success);
      return true;
    } catch (error) {
      if (controller.signal.aborted) return false;
      setMessage(formatActionableError(error, "adaptive-review"));
      return false;
    } finally {
      if (!controller.signal.aborted) setBusy(undefined);
    }
  };

  if (!task || !blueprint || !record) {
    return <main className="page adaptive-review-page"><button type="button" className="secondary-button" onClick={onBack}><ArrowLeft size={17} />返回</button><div className="empty-state"><h2>任务不可用</h2><p>对应记录或复习蓝图已经不存在。</p></div></main>;
  }

  const answered = currentTurn?.status === "answered";
  const lastIncorrect = answered && currentTurn.assessment === "incorrect";
  const canContinue = turns.length < blueprint.maxTurns;
  const requestedLevels = new Set(currentTurn?.hintsUsed.map((item) => item.level) ?? []);
  // v2 tasks derive their outcome from evidence. The learner never sees
  // 已掌握 / 仍需巩固 / 未掌握, because none of those is a fact they can report.
  const isClosedLoopV2 = task.loopVersion === CLOSED_LOOP_V2_LOOP_VERSION;
  // Scoped to this task: another task's post-judgment retrieval must never make
  // this page believe its own loop is closed.
  const v2LoopClosed = isClosedLoopV2
    && isLoopClosed({ turns, events: snapshot.taskOutcomeEvents, taskId: task.id });
  const v2QualifyingCount = turns.filter((item) => item.status === "answered" && item.assessment !== "unreliable").length;
  // The anti-self-esteem cap is computed from the task's own event log, so the
  // third "I could but did not produce it" can be shown as unavailable before
  // the learner picks it, rather than silently rewritten afterwards.
  const v2Options = isClosedLoopV2
    ? interventionOptionsFor(snapshot.taskOutcomeEvents.filter((event) => event.taskId === task.id))
    : [];
  const selectedOption = v2Options.find((option) => option.path === selectedPath);

  /**
   * Whether the learner must choose a next action before continuing.
   *
   * Only when the last retrieval was *not* correct. A correct answer still has
   * to be retrieved again after feedback (that is what closes the loop), but it
   * is not a shortfall, so there is no remedy to pick. Forcing a choice here
   * manufactured a false self-report - the learner had to claim something went
   * wrong to get to the next question.
   */
  const needsInterventionChoice = Boolean(
    currentTurn?.status === "answered" && currentTurn.assessment !== "correct",
  );

  /**
   * Device-local friction measurement (M5).
   *
   * The hook existed and was unit-tested but nothing in the product ever called
   * it, so no session ever produced a segment and the 15% operation budget could
   * never be evaluated on real data. It only ever records a phase label and a
   * duration - never answers, page text, prompts or provider output - and it is
   * excluded from backup, transfer and sync.
   *
   * Which phase is running is derived from what the learner is actually doing:
   * reading feedback after a judgment is feedback time, answering is cognitive
   * time, and waiting on a paid generation is operation time. Time the learner
   * is not looking at the page is never credited (the hook clips idle and
   * hidden windows).
   */
  const trace = useInteractionTrace();
  const traceCategory = busy ? "operation" : answered ? "feedback" : currentTurn?.status === "displayed" ? "cognitive" : "operation";
  const tracePhase = busy
    ? "waiting-for-ai"
    : answered
      ? "feedback"
      : currentTurn?.status === "displayed"
        ? (delayedVerification
          ? (currentTurn.phase === "delayed-remediation" ? "delayed-remediation" : "delayed-first")
          : (currentTurn.phase === "post-judgment" ? "post-judgment" : "initial-retrieval"))
        : "workbench";
  useEffect(() => {
    if (!task || !record) return;
    trace.enter({ screen: "task", category: traceCategory, phase: tracePhase, taskId: task.id, recordId: record.id, sessionId });
  }, [record, sessionId, task, trace, traceCategory, tracePhase]);

  /**
   * Records the action, then asks for the next retrieval.
   *
   * The two steps are one user action on purpose: choosing "I mixed it up" and
   * continuing are not separate decisions, and splitting them would add a
   * confirmation step the constitution forbids. If the action write fails the
   * retrieval is not requested, so the record never disagrees with what was
   * shown.
   */
  const chooseAndContinue = async () => {
    if (isClosedLoopV2 && !delayedVerification && !v2LoopClosed && needsInterventionChoice && selectedPath) {
      const path = selectedPath;
      const ok = await run("intervention", async () => {
        await onSelectIntervention(task.id, path, currentTurn?.id);
        await onGenerateTurn(task.id, requestAbortRef.current.signal);
      });
      if (ok) setSelectedPath(undefined);
      return;
    }
    await run("generate", () => onGenerateTurn(task.id, requestAbortRef.current.signal));
  };

  const finish = (outcome: SubjectiveOutcome) => {
    if (outcome === "mastered" && lastIncorrect && !confirmMastered) {
      setConfirmMastered(true);
      setMessage("最后一轮仍有错误。再次点击“确认已掌握”以保留你的判断。");
      return;
    }
    void run(`finish:${outcome}`, () => onFinish(task.id, outcome, outcome === "not-mastered" ? notMasteredReason : undefined, outcome === "mastered" ? confirmMastered : undefined), "本次训练结果已保存。").then((ok) => { if (ok) onBack(); });
  };

  const finishVerification = (outcome: "retained" | "decayed") => {
    if (outcome === "retained" && lastIncorrect && !confirmMastered) {
      setConfirmMastered(true);
      setMessage("最后一轮验证回答仍有错误。再次点击“确认仍然掌握”以保留你的判断。");
      return;
    }
    void run(`verify:${outcome}`, () => onFinishVerification(task.id, outcome, outcome === "retained" ? confirmMastered : undefined), "延迟验证结果已保存。").then((ok) => { if (ok) onBack(); });
  };

  const completeLoop = () => {
    void run("complete-loop", () => onCompleteLoop(task.id), "已完成反馈后的再次提取，本次闭环已记录。").then((ok) => { if (ok) onBack(); });
  };

  /**
   * v2 delayed verification. No outcome argument: the system reads the locked
   * first independent attempt and derives the conclusion from its authority.
   */
  const submitV2Verification = () => {
    void run("verify-v2", () => onCompleteV2Verification(task.id), "延迟验证结果已根据本次作答证据记录。").then((ok) => { if (ok) onBack(); });
  };

  return (
    <main className="page adaptive-review-page">
      <header className="adaptive-review-header">
        <button type="button" className="icon-button" onClick={onBack} title="返回" aria-label="返回"><ArrowLeft size={19} /></button>
        <div><p className="eyebrow">{delayedVerification ? "Delayed Verification" : "Adaptive Review"}</p><h1>{record.title}</h1><small>{record.subject} · 目标版本 v{task.contentVersion}</small></div>
        <span>{isClosedLoopV2 ? `提取 ${v2QualifyingCount}/2` : `${turns.length}/${blueprint.maxTurns}`}</span>
      </header>

      <section className="adaptive-review-objective">
        {!delayedVerification && <>
          <small>本次目标</small>
          <div className="ai-markdown adaptive-review-objective-title adaptive-review-markdown"><AiMarkdown content={blueprint.objective} /></div>
          <div className="ai-markdown adaptive-review-objective-criteria adaptive-review-markdown"><AiMarkdown content={blueprint.completionCriteria.join("；")} /></div>
        </>}
        {delayedVerification && <p className="adaptive-review-verification-note">使用新题检查间隔后的回忆；结果不会改写整条日志的 FSRS 日期。</p>}
      </section>

      {!currentTurn && (
        <section className="adaptive-review-start">
          <h2>准备好后开始第一轮</h2>
          <p>题目会基于当前复习蓝图生成，来源和答案依据将在作答后显示。</p>
          <button type="button" className="primary-button" disabled={Boolean(busy)} onClick={() => void run("generate", () => onGenerateTurn(task.id, requestAbortRef.current.signal))}>{busy === "generate" ? <LoaderCircle className="spin" size={18} /> : <Play size={18} />}开始训练</button>
        </section>
      )}

      {currentTurn && (
        <section className="adaptive-review-turn">
          <div className="adaptive-review-turn-meta"><span>第 {currentTurn.sequence} 轮</span><small>{currentTurn.practiceType}</small></div>
          <div className="ai-markdown adaptive-review-question adaptive-review-markdown" role="heading" aria-level={2}><AiMarkdown content={currentTurn.question} /></div>

          {!answered ? (
            <>
              {(currentTurn.availableHints?.length ?? 0) > 0 && (
                <div className="adaptive-review-hints">
                  {currentTurn.availableHints!.map((hint, index) => {
                    const level = index + 1;
                    const revealed = requestedLevels.has(level);
                    return revealed ? <div key={level} className="adaptive-review-hint"><Lightbulb size={15} /><div className="ai-markdown adaptive-review-markdown"><AiMarkdown content={hint} /></div></div> : <button key={level} type="button" disabled={Boolean(busy) || (level > 1 && !requestedLevels.has(level - 1))} onClick={() => void run(`hint:${level}`, () => onRequestHint(currentTurn.id, level))}><Lightbulb size={15} />提示 {level}</button>;
                  })}
                </div>
              )}
              <div className="adaptive-answer-mode" role="group" aria-label="回答输入方式">
                <button type="button" className={answerInputMode === "text" ? "active" : ""} aria-pressed={answerInputMode === "text"} onClick={() => { void stopVoiceCapture(); setAnswerInputMode("text"); setVoiceTranscriptConfirmed(false); }}><Keyboard size={16} />文本输入</button>
                <button type="button" className={answerInputMode === "voice" ? "active" : ""} aria-pressed={answerInputMode === "voice"} onClick={() => { setAnswerInputMode("voice"); setVoiceTranscriptConfirmed(false); }}><Mic size={16} />语音输入</button>
              </div>
              {answerInputMode === "voice" && <p className="adaptive-voice-boundary">麦克风仅采集本机 PCM。真实 ASR 尚未验收，转写必须由你校对并明确确认。</p>}
              <textarea
                value={answer}
                onChange={(event) => { setAnswer(event.target.value); setVoiceTranscriptConfirmed(false); }}
                placeholder={answerInputMode === "voice" ? "录音后在这里填写或校对转写..." : "写下你的回答..."}
                aria-label={answerInputMode === "voice" ? "语音回答转写" : "你的回答"}
                rows={6}
              />
              {answerInputMode === "voice" && <div className="adaptive-voice-actions">
                <button type="button" className={capturingVoice ? "active" : ""} disabled={Boolean(busy)} onClick={() => void (capturingVoice ? finishVoiceCapture() : startVoiceCapture())}>{capturingVoice ? <Pause size={16} /> : <Mic size={16} />}{capturingVoice ? "结束录音" : "开始录音"}</button>
                <button type="button" disabled={!answer.trim() || capturingVoice || Boolean(busy)} aria-pressed={voiceTranscriptConfirmed} className={voiceTranscriptConfirmed ? "active" : ""} onClick={() => { setVoiceTranscriptConfirmed(true); setMessage("转写已确认，可以提交本题回答。"); }}><Check size={16} />{voiceTranscriptConfirmed ? "转写已确认" : "确认转写"}</button>
              </div>}
              <div className="adaptive-review-primary-actions">
                <button type="button" className="primary-button" disabled={!answer.trim() || Boolean(busy) || capturingVoice || (answerInputMode === "voice" && !voiceTranscriptConfirmed)} onClick={() => void run("answer", () => onSubmitAnswer(currentTurn.id, answer.trim(), requestAbortRef.current.signal))}>{busy === "answer" ? <LoaderCircle className="spin" size={17} /> : <Send size={17} />}提交回答</button>
                <button type="button" disabled={Boolean(busy)} onClick={() => void run("skip", () => onSkipTurn(currentTurn.id))}>跳过本题</button>
                <button type="button" disabled={Boolean(busy)} onClick={() => setShowInvalid(true)}><Flag size={16} />题目有问题</button>
              </div>
            </>
          ) : (
            <div className={`adaptive-review-result ${currentTurn.assessment}`}>
              <strong>{assessmentLabel[currentTurn.assessment!]}</strong>
              <div className="ai-markdown adaptive-review-markdown"><AiMarkdown content={currentTurn.assessmentRationale ?? ""} /></div>
              <div><small>你的回答</small><p>{currentTurn.answerText}</p></div>
              <div><small>答案依据</small><ul>{currentTurn.answerCriteria.map((item) => <li key={item}><div className="ai-markdown adaptive-review-markdown"><AiMarkdown content={item} /></div></li>)}</ul></div>
              <div className="adaptive-review-source"><small>来源片段 · {record.title}</small><p>{extractSourceText(record, task.decisionBlockId)}</p></div>
              {isClosedLoopV2 && !delayedVerification && !v2LoopClosed && needsInterventionChoice && (
                // The learner says which action they need next. They are not
                // asked what went wrong, why, or whether they have mastered it.
                //
                // Only shown when the retrieval actually fell short. Asking a
                // learner who just answered correctly to pick a *remedy* forced
                // them to misdescribe their own performance, and the record then
                // said they had chosen "I could not form it" when they had not.
                <div className="adaptive-review-intervention">
                  <small>下一步做什么</small>
                  <div className="adaptive-review-outcomes">
                    {v2Options.map((option) => (
                      <button
                        key={option.path}
                        type="button"
                        disabled={Boolean(busy)}
                        aria-pressed={selectedPath === option.path}
                        className={selectedPath === option.path ? "active" : ""}
                        onClick={() => setSelectedPath(option.path)}
                      >
                        {option.label}
                      </button>
                    ))}
                  </div>
                  {selectedOption && <p className="adaptive-review-action-hint">{selectedOption.hint}</p>}
                  {selectedOption?.forced && (
                    <p className="adaptive-review-action-hint">
                      你已经连续 {MAX_CONSECUTIVE_EXECUTION_FAILED} 次选择“会但没写出来”。这一次改为回到材料重建，再重新提取。
                    </p>
                  )}
                </div>
              )}
              {!finishing && <div className="adaptive-review-primary-actions">
                {canContinue && <button type="button" className="primary-button" disabled={Boolean(busy) || (isClosedLoopV2 && !delayedVerification && !v2LoopClosed && needsInterventionChoice && !selectedPath)} onClick={() => void chooseAndContinue()}><RotateCcw size={17} />{isClosedLoopV2 && !delayedVerification && v2QualifyingCount === 1 ? "按这个方式再提取一次" : "继续下一轮"}</button>}
                {isClosedLoopV2
                  ? delayedVerification
                    // A v2 verification has exactly one forward action, and it is
                    // rendered once, in the dedicated `提交这次验证` section below
                    // that explains the rule. Repeating it here would give the
                    // same action two buttons with identical labels.
                    ? null
                    : <>
                      {v2LoopClosed && <button type="button" className="primary-button" disabled={Boolean(busy)} onClick={completeLoop}><Check size={17} />完成本次闭环</button>}
                      {!v2LoopClosed && <button type="button" disabled={Boolean(busy)} onClick={() => void run("defer-attempt", () => onDeferAttempt(task.id), "本次训练已延期，稍后继续同一目标。").then((ok) => { if (ok) onBack(); })}><Clock3 size={17} />稍后再练</button>}
                    </>
                  : <button type="button" onClick={() => setFinishing(true)}><Check size={17} />结束本次训练</button>}
              </div>}
            </div>
          )}
        </section>
      )}

      {finishing && answered && !isClosedLoopV2 && (
        <section className="adaptive-review-finish">
          <h2>{delayedVerification ? "间隔后还能独立完成吗" : "你现在的真实状态"}</h2>
          <p>{delayedVerification ? "验证结果与即时训练结果分开保存；这里记录的是你的自评，不等同于无提示独立作答结果。" : "即时回答和主观判断会分别保存。"}</p>
          {delayedVerification ? (
            <div className="adaptive-review-outcomes">
              <button type="button" disabled={Boolean(busy)} onClick={() => finishVerification("retained")}><Check size={17} />{lastIncorrect && confirmMastered ? "确认仍然掌握" : "仍然掌握"}</button>
              <button type="button" disabled={Boolean(busy)} onClick={() => finishVerification("decayed")}><AlertTriangle size={17} />已经衰退</button>
            </div>
          ) : <>
            <div className="adaptive-review-outcomes">
              <button type="button" disabled={Boolean(busy)} onClick={() => finish("mastered")}><Check size={17} />{lastIncorrect && confirmMastered ? "确认已掌握" : "已掌握"}</button>
              <button type="button" disabled={Boolean(busy)} onClick={() => finish("needs-consolidation")}><RotateCcw size={17} />仍需巩固</button>
              <button type="button" disabled={Boolean(busy) || !notMasteredReason.trim()} onClick={() => finish("not-mastered")}><AlertTriangle size={17} />未掌握</button>
            </div>
            <textarea rows={3} value={notMasteredReason} onChange={(event) => setNotMasteredReason(event.target.value)} placeholder="如果仍未掌握，请写下具体卡点，用于重新规划" aria-label="未掌握原因" />
          </>}
        </section>
      )}

      {isClosedLoopV2 && delayedVerification && answered && (
        // M4: a v2 verification is not a vote. The learner submits the attempt;
        // the system reads the locked first answer and derives the conclusion.
        // There is deliberately no "仍然掌握 / 已经衰退" choice here.
        <section className="adaptive-review-finish">
          <h2>提交这次验证</h2>
          <p>结果由这次独立作答的证据决定，不由自评决定。系统只读取本轮的第一份独立答案，之后的补救作答不会改写它。</p>
          <div className="adaptive-review-primary-actions">
            <button type="button" className="primary-button" disabled={Boolean(busy)} onClick={submitV2Verification}>
              <Check size={17} />提交验证结果
            </button>
          </div>
        </section>
      )}

      {showInvalid && currentTurn && (
        <section className="adaptive-review-inline-dialog">
          <strong>报告题目问题</strong><textarea rows={3} value={invalidReason} onChange={(event) => setInvalidReason(event.target.value)} placeholder="缺少条件、答案矛盾或偏离来源..." />
          <div><button type="button" onClick={() => setShowInvalid(false)}>取消</button><button type="button" disabled={Boolean(busy)} onClick={() => void run("invalid", () => onReportInvalid(currentTurn.id, invalidReason), "题目已标记无效。").then((ok) => { if (ok) onBack(); })}><Flag size={16} />确认报告</button></div>
        </section>
      )}

      <footer className="adaptive-review-secondary-actions">
        <button type="button" disabled={Boolean(busy)} onClick={() => void run("defer", () => onDefer(task.id), "任务已延期一天。").then((ok) => { if (ok) onBack(); })}><Clock3 size={16} />这次没时间</button>
        <button type="button" onClick={() => setShowExit((value) => !value)}><LogOut size={16} />放弃任务</button>
      </footer>
      {showExit && <div className="adaptive-review-abandon-confirm"><span>放弃只结束本任务，不代表未掌握。</span><button type="button" disabled={Boolean(busy)} onClick={() => void run("abandon", () => onAbandon(task.id, "用户主动放弃本次训练"), "任务已放弃。").then((ok) => { if (ok) onBack(); })}>确认放弃</button></div>}
      {message && <p className="adaptive-review-message" role="status">{message}</p>}
    </main>
  );
};
