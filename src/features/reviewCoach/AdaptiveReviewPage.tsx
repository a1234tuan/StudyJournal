import { AlertTriangle, ArrowLeft, Check, Clock3, Flag, Keyboard, Lightbulb, LoaderCircle, LogOut, Mic, Pause, Play, RotateCcw, Send } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

import type { RecordBlock } from "../../types";
import { formatUiError } from "../../lib/uiError";
import type { VoiceCaptureAdapter } from "../voiceRecall/contracts";
import { canUseNativeVoiceCapture, NativeVoiceCaptureAdapter } from "../voiceRecall/nativeVoiceCapture";
import { WebVoiceCaptureAdapter } from "../voiceRecall/webVoiceCapture";
import type { ReviewCoachFormalSnapshot, SubjectiveOutcome } from "./domain";

interface AdaptiveReviewPageProps {
  taskId: string;
  snapshot: ReviewCoachFormalSnapshot;
  records: readonly RecordBlock[];
  onBack: () => void;
  onGenerateTurn: (taskId: string) => Promise<unknown>;
  onRequestHint: (turnId: string, level: number) => Promise<unknown>;
  onSubmitAnswer: (turnId: string, answer: string) => Promise<unknown>;
  onSkipTurn: (turnId: string) => Promise<unknown>;
  onReportInvalid: (turnId: string, reason: string) => Promise<unknown>;
  onFinish: (taskId: string, outcome: SubjectiveOutcome, reason?: string, confirmedConflict?: boolean) => Promise<unknown>;
  onFinishVerification: (taskId: string, outcome: "retained" | "decayed", confirmedConflict?: boolean) => Promise<unknown>;
  onDefer: (taskId: string) => Promise<unknown>;
  onAbandon: (taskId: string, reason: string) => Promise<unknown>;
}

const assessmentLabel = { correct: "回答正确", partial: "部分正确", incorrect: "仍有错误", unreliable: "无法可靠判断" } as const;

const extractSourceText = (record: RecordBlock | undefined, decisionBlockId: string): string => {
  if (!record || typeof DOMParser === "undefined") return "来源记录不可用";
  const document = new DOMParser().parseFromString(record.contentHtml, "text/html");
  return document.querySelector(`record-decision-block[data-decision-block-id="${CSS.escape(decisionBlockId)}"]`)?.textContent?.replace(/\s+/g, " ").trim() || "来源片段不可用";
};

export const AdaptiveReviewPage = ({ taskId, snapshot, records, onBack, onGenerateTurn, onRequestHint, onSubmitAnswer, onSkipTurn, onReportInvalid, onFinish, onFinishVerification, onDefer, onAbandon }: AdaptiveReviewPageProps) => {
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
  const captureAdapterRef = useRef<VoiceCaptureAdapter>();
  const captureAbortRef = useRef<AbortController>();
  const capturedFramesRef = useRef(0);

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
        if (!controller.signal.aborted) setMessage(formatUiError(error, "adaptive-review"));
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
    setBusy(key);
    setMessage(undefined);
    try {
      await work();
      setAnswer("");
      setVoiceTranscriptConfirmed(false);
      if (success) setMessage(success);
      return true;
    } catch (error) {
      setMessage(formatUiError(error, "adaptive-review"));
      return false;
    } finally {
      setBusy(undefined);
    }
  };

  if (!task || !blueprint || !record) {
    return <main className="page adaptive-review-page"><button type="button" className="secondary-button" onClick={onBack}><ArrowLeft size={17} />返回</button><div className="empty-state"><h2>任务不可用</h2><p>对应记录或复习蓝图已经不存在。</p></div></main>;
  }

  const answered = currentTurn?.status === "answered";
  const lastIncorrect = answered && currentTurn.assessment === "incorrect";
  const canContinue = turns.length < blueprint.maxTurns;
  const requestedLevels = new Set(currentTurn?.hintsUsed.map((item) => item.level) ?? []);

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

  return (
    <main className="page adaptive-review-page">
      <header className="adaptive-review-header">
        <button type="button" className="icon-button" onClick={onBack} title="返回" aria-label="返回"><ArrowLeft size={19} /></button>
        <div><p className="eyebrow">{delayedVerification ? "Delayed Verification" : "Adaptive Review"}</p><h1>{record.title}</h1><small>{record.subject} · 目标版本 v{task.contentVersion}</small></div>
        <span>{turns.length}/{blueprint.maxTurns}</span>
      </header>

      <section className="adaptive-review-objective">
        <small>{delayedVerification ? "延迟验证目标" : "本次目标"}</small><strong>{blueprint.objective}</strong>
        <p>{blueprint.completionCriteria.join("；")}</p>
        {delayedVerification && <p className="adaptive-review-verification-note">使用新题检查间隔后的独立提取；结果不会改写整条日志的 FSRS 日期。</p>}
      </section>

      {!currentTurn && (
        <section className="adaptive-review-start">
          <h2>准备好后开始第一轮</h2>
          <p>题目会基于当前复习蓝图生成，来源和答案依据将在作答后显示。</p>
          <button type="button" className="primary-button" disabled={Boolean(busy)} onClick={() => void run("generate", () => onGenerateTurn(task.id))}>{busy === "generate" ? <LoaderCircle className="spin" size={18} /> : <Play size={18} />}开始训练</button>
        </section>
      )}

      {currentTurn && (
        <section className="adaptive-review-turn">
          <div className="adaptive-review-turn-meta"><span>第 {currentTurn.sequence} 轮</span><small>{currentTurn.practiceType}</small></div>
          <h2>{currentTurn.question}</h2>

          {!answered ? (
            <>
              {(currentTurn.availableHints?.length ?? 0) > 0 && (
                <div className="adaptive-review-hints">
                  {currentTurn.availableHints!.map((hint, index) => {
                    const level = index + 1;
                    const revealed = requestedLevels.has(level);
                    return revealed ? <p key={level}><Lightbulb size={15} />{hint}</p> : <button key={level} type="button" disabled={Boolean(busy) || (level > 1 && !requestedLevels.has(level - 1))} onClick={() => void run(`hint:${level}`, () => onRequestHint(currentTurn.id, level))}><Lightbulb size={15} />提示 {level}</button>;
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
                <button type="button" className="primary-button" disabled={!answer.trim() || Boolean(busy) || capturingVoice || (answerInputMode === "voice" && !voiceTranscriptConfirmed)} onClick={() => void run("answer", () => onSubmitAnswer(currentTurn.id, answer.trim()))}>{busy === "answer" ? <LoaderCircle className="spin" size={17} /> : <Send size={17} />}提交回答</button>
                <button type="button" disabled={Boolean(busy)} onClick={() => void run("skip", () => onSkipTurn(currentTurn.id))}>跳过本题</button>
                <button type="button" disabled={Boolean(busy)} onClick={() => setShowInvalid(true)}><Flag size={16} />题目有问题</button>
              </div>
            </>
          ) : (
            <div className={`adaptive-review-result ${currentTurn.assessment}`}>
              <strong>{assessmentLabel[currentTurn.assessment!]}</strong>
              <p>{currentTurn.assessmentRationale}</p>
              <div><small>你的回答</small><p>{currentTurn.answerText}</p></div>
              <div><small>答案依据</small><ul>{currentTurn.answerCriteria.map((item) => <li key={item}>{item}</li>)}</ul></div>
              <div className="adaptive-review-source"><small>来源片段 · {record.title}</small><p>{extractSourceText(record, task.decisionBlockId)}</p></div>
              {!finishing && <div className="adaptive-review-primary-actions">
                {canContinue && <button type="button" className="primary-button" disabled={Boolean(busy)} onClick={() => void run("generate", () => onGenerateTurn(task.id))}><RotateCcw size={17} />继续下一轮</button>}
                <button type="button" onClick={() => setFinishing(true)}><Check size={17} />结束本次训练</button>
              </div>}
            </div>
          )}
        </section>
      )}

      {finishing && answered && (
        <section className="adaptive-review-finish">
          <h2>{delayedVerification ? "间隔后还能独立完成吗" : "你现在的真实状态"}</h2>
          <p>{delayedVerification ? "验证结果与即时训练结果分开保存。" : "即时回答和主观判断会分别保存。"}</p>
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
