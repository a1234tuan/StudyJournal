import { BrainCircuit, Check, Clock3, Play, RefreshCw, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import type { AiProviderProfile, RecordBlock } from "../../types";
import type { AdaptiveReviewTask, AnalysisBatch, ReviewCoachFormalSnapshot } from "./domain";
import { maxAnalysisInputTokensForProvider, planAnalysisBatches, type AnalysisPlanningBlock } from "./analysisPlanner";
import { replayInterventionEffectSummaries } from "./replay";
import { formatActionableError } from "../../lib/uiError";

interface ReviewCoachWorkbenchProps {
  planningBlocks: readonly AnalysisPlanningBlock[];
  snapshot: ReviewCoachFormalSnapshot;
  records: readonly RecordBlock[];
  provider?: AiProviderProfile;
  onAnalyze: (decisionBlockIds: readonly string[], allowCrossBlockSupport: boolean) => Promise<unknown>;
  onResume: (batchId: string) => Promise<unknown>;
  onSwitchTask: (taskId: string) => Promise<unknown>;
  onDeferTask: (taskId: string) => Promise<unknown>;
  onOpenTask?: (taskId: string) => void;
}

const formatDateTime = (value?: string) => value
  ? new Intl.DateTimeFormat("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" }).format(new Date(value))
  : "暂无复习记录";

const taskStatusLabel: Record<AdaptiveReviewTask["status"], string> = {
  waiting: "等待中",
  current: "当前任务",
  "in-progress": "进行中",
  deferred: "已延期",
  completed: "已完成",
  "not-achieved": "未达成",
  invalid: "无效",
  abandoned: "已放弃",
  stale: "内容已更新",
  deleted: "已删除",
};

export const ReviewCoachWorkbench = ({
  planningBlocks,
  snapshot,
  records,
  provider,
  onAnalyze,
  onResume,
  onSwitchTask,
  onDeferTask,
  onOpenTask,
}: ReviewCoachWorkbenchProps) => {
  const candidateKey = planningBlocks.map((item) => item.decisionBlockId).join("|");
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set(planningBlocks.map((item) => item.decisionBlockId)));
  const [confirming, setConfirming] = useState(false);
  const [allowSupport, setAllowSupport] = useState(false);
  const [busyAction, setBusyAction] = useState<string>();
  const [message, setMessage] = useState<string>();
  const [switchTargetId, setSwitchTargetId] = useState<string>();
  const [deferTargetId, setDeferTargetId] = useState<string>();

  // Keyed on candidateKey only: planningBlocks is rebuilt on every snapshot
  // refresh, and re-seating on identity would silently re-check blocks the user
  // excluded — and then pay to analyse them.
  useEffect(() => {
    setSelectedIds(new Set(candidateKey ? candidateKey.split("|") : []));
    setConfirming(false);
  }, [candidateKey]);

  const selectedBlocks = useMemo(
    () => planningBlocks.filter((item) => selectedIds.has(item.decisionBlockId)),
    [planningBlocks, selectedIds],
  );
  const maxInputTokens = provider ? maxAnalysisInputTokensForProvider(provider) : 57_536;
  const plan = useMemo(() => planAnalysisBatches(selectedBlocks, maxInputTokens), [maxInputTokens, selectedBlocks]);
  const pausedBatches = snapshot.analysisBatches.filter((item) => ["confirmed", "running"].includes(item.status) && !item.deletedAt);
  const terminalBatches = snapshot.analysisBatches.filter((item) => ["succeeded", "partial", "failed"].includes(item.status) && !item.deletedAt);
  const latestBatch = [...terminalBatches].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))[0];
  const activeTasks = snapshot.adaptiveReviewTasks
    .filter((item) => ["current", "in-progress", "waiting", "deferred"].includes(item.status) && !item.deletedAt)
    .sort((left, right) => {
      const leftCurrent = left.status === "current" || left.status === "in-progress" ? 0 : 1;
      const rightCurrent = right.status === "current" || right.status === "in-progress" ? 0 : 1;
      return leftCurrent - rightCurrent || left.queuedAt.localeCompare(right.queuedAt);
    });
  const blueprintById = new Map(snapshot.sessionBlueprints.map((item) => [item.id, item]));
  const verificationByTaskId = new Map(snapshot.delayedVerifications.filter((item) => item.taskId).map((item) => [item.taskId!, item]));
  const recordById = new Map(records.map((item) => [item.id, item]));
  const interventionEffectSummaries = useMemo(() => replayInterventionEffectSummaries({
    interpretations: snapshot.feedbackInterpretations,
    blueprints: snapshot.sessionBlueprints,
    tasks: snapshot.adaptiveReviewTasks,
    turns: snapshot.adaptiveQuizTurns,
    outcomes: snapshot.taskOutcomeEvents,
    verifications: snapshot.delayedVerifications,
    replayedAt: new Date().toISOString(),
  }), [snapshot]);
  const hasContent = planningBlocks.length > 0 || pausedBatches.length > 0 || activeTasks.length > 0 || Boolean(latestBatch);
  if (!hasContent) return null;

  const run = async (action: string, work: () => Promise<unknown>, success: string) => {
    setBusyAction(action);
    setMessage(undefined);
    try {
      await work();
      setMessage(success);
      setConfirming(false);
      setSwitchTargetId(undefined);
      setDeferTargetId(undefined);
    } catch (error) {
      setMessage(formatActionableError(error, "adaptive-review"));
    } finally {
      setBusyAction(undefined);
    }
  };

  return (
    <section className="review-coach-workbench" aria-labelledby="review-coach-workbench-title">
      <header>
        <div>
          <span className="review-coach-workbench-icon"><BrainCircuit size={18} /></span>
          <div>
            <p className="eyebrow">Review Coach</p>
            <h2 id="review-coach-workbench-title">复习助教</h2>
          </div>
        </div>
        {planningBlocks.length > 0 && <strong>{planningBlocks.length} 个重点待分析</strong>}
      </header>

      {planningBlocks.length > 0 && (
        <div className="review-coach-analysis">
          <div className="review-coach-analysis-list">
            {planningBlocks.map((block) => {
              const latest = block.feedback.at(-1)!;
              const checked = selectedIds.has(block.decisionBlockId);
              return (
                <label key={block.decisionBlockId} className="review-coach-analysis-item">
                  <input
                    type="checkbox"
                    checked={checked}
                    disabled={Boolean(busyAction)}
                    onChange={(event) => setSelectedIds((current) => {
                      const next = new Set(current);
                      if (event.target.checked) next.add(block.decisionBlockId);
                      else next.delete(block.decisionBlockId);
                      return next;
                    })}
                  />
                  <span className="review-coach-analysis-copy">
                    <span><strong>{block.recordTitle}</strong><small>{block.subject} · v{block.contentVersion} · {formatDateTime(block.lastReviewedAt)}</small></span>
                    <span className="review-coach-block-preview">{block.contextMarkdown.replace(/\s+/g, " ").slice(0, 150)}</span>
                    <span className="review-coach-feedback-quote">“{latest.comment}”</span>
                    <span className="review-coach-analysis-meta">
                      {latest.interpretation?.status === "succeeded" ? "已整理" : latest.interpretation?.status === "insufficient-context" ? "背景不足" : "仅原始评论"}
                      <b>{block.estimatedTokens.toLocaleString()} tokens</b>
                      {block.missingOcrAssetIds.length > 0 && <em>{block.missingOcrAssetIds.length} 张图片缺少 OCR</em>}
                    </span>
                  </span>
                </label>
              );
            })}
          </div>

          <div className="review-coach-analysis-summary">
            <span><strong>{selectedBlocks.length}</strong><small>已选重点</small></span>
            <span><strong>{plan.subBatches.length}</strong><small>自动子批次</small></span>
            <span><strong>{plan.estimatedTokens.toLocaleString()}</strong><small>预计 tokens</small></span>
            <span><strong>{selectedBlocks.reduce((sum, item) => sum + item.missingOcrAssetIds.length, 0)}</strong><small>缺少 OCR</small></span>
          </div>
          <p className="review-coach-cost-note">
            {provider ? `${provider.providerName} · ${provider.model}` : "使用设置中的当前 AI 供应商"} · 费用以供应商账单为准
          </p>
          {plan.oversized.length > 0 && (
            <p className="review-coach-error">{plan.oversized.map((item) => item.recordTitle).join("、")} 超过模型上下文上限，请缩小或拆分决策块。</p>
          )}

          {!confirming ? (
            <button
              type="button"
              className="primary-button"
              disabled={selectedBlocks.length === 0 || plan.oversized.length > 0 || Boolean(busyAction)}
              onClick={() => setConfirming(true)}
            >
              <BrainCircuit size={17} /> AI 分析
            </button>
          ) : (
            <div className="review-coach-confirmation">
              <p>将按上方选择冻结输入并依次处理 {plan.subBatches.length} 个子批次。</p>
              {selectedBlocks.length > 1 && (
                <label>
                  <input type="checkbox" checked={allowSupport} onChange={(event) => setAllowSupport(event.target.checked)} />
                  允许模型将本批次其他已选重点作为辅助来源
                </label>
              )}
              <div>
                <button type="button" onClick={() => setConfirming(false)} disabled={Boolean(busyAction)}><X size={16} />取消</button>
                <button
                  type="button"
                  className="primary-button"
                  disabled={Boolean(busyAction)}
                  onClick={() => void run("analysis", () => onAnalyze([...selectedIds], allowSupport), "分析完成，已生成复习任务。")}
                >
                  <Check size={16} />确认并开始
                </button>
              </div>
            </div>
          )}
        </div>
      )}

      {pausedBatches.map((batch) => (
        <div className="review-coach-resume" key={batch.id}>
          <span><strong>分析已暂停</strong><small>{batch.subBatches.filter((item) => item.status === "succeeded").length}/{batch.subBatches.length} 个子批次完成</small></span>
          <button type="button" disabled={Boolean(busyAction)} onClick={() => void run(`resume:${batch.id}`, () => onResume(batch.id), "分析已继续完成。") }>
            <RefreshCw size={16} />继续分析
          </button>
        </div>
      ))}

      {latestBatch && (
        <div className="review-coach-latest-batch">
          <span>最近分析：{latestBatch.status === "succeeded" ? "全部完成" : latestBatch.status === "partial" ? "部分完成" : "失败"}</span>
          <small>{latestBatch.subBatches.filter((item) => item.status === "succeeded").length}/{latestBatch.subBatches.length} 子批次 · {latestBatch.totalTokens?.toLocaleString() ?? "未返回"} tokens</small>
        </div>
      )}

      {activeTasks.length > 0 && (
        <div className="review-coach-task-list">
          <h3>复习任务</h3>
          {activeTasks.map((task) => {
            const blueprint = blueprintById.get(task.blueprintId);
            const record = recordById.get(task.recordId);
            const isCurrent = task.status === "current" || task.status === "in-progress";
            const verification = verificationByTaskId.get(task.id);
            return (
              <article className={isCurrent ? "current" : ""} key={task.id}>
                <div>
                  <span>{verification ? `延迟验证 · ${taskStatusLabel[task.status]}` : taskStatusLabel[task.status]}</span>
                  <strong>{record?.title ?? "已删除的日志"}</strong>
                  <p>{blueprint?.objective ?? "复习目标待恢复"}</p>
                  <small>v{task.contentVersion} · 已等待 {Math.max(0, Math.floor((Date.now() - Date.parse(task.queuedAt)) / 86_400_000))} 天</small>
                </div>
                <div className="review-coach-task-actions">
                  {isCurrent ? (
                    deferTargetId === task.id ? (
                      <>
                        <button type="button" onClick={() => setDeferTargetId(undefined)}><X size={15} />取消</button>
                        <button type="button" disabled={Boolean(busyAction)} onClick={() => void run(`defer:${task.id}`, () => onDeferTask(task.id), "当前任务已延期一天。") }><Clock3 size={15} />确认延期</button>
                      </>
                    ) : <>
                      {onOpenTask && <button type="button" className="primary-button" onClick={() => onOpenTask(task.id)}><Play size={15} />{task.status === "in-progress" ? "继续训练" : "开始训练"}</button>}
                      <button type="button" onClick={() => setDeferTargetId(task.id)}><Clock3 size={15} />稍后再做</button>
                    </>
                  ) : switchTargetId === task.id ? (
                    <>
                      <button type="button" onClick={() => setSwitchTargetId(undefined)}><X size={15} />取消</button>
                      <button type="button" disabled={Boolean(busyAction)} onClick={() => void run(`switch:${task.id}`, () => onSwitchTask(task.id), "已切换当前任务。") }><Check size={15} />确认切换</button>
                    </>
                  ) : <button type="button" onClick={() => setSwitchTargetId(task.id)}><Play size={15} />设为当前</button>}
                </div>
              </article>
            );
          })}
        </div>
      )}

      {snapshot.delayedVerifications.some((item) => ["scheduled", "eligible", "missed"].includes(item.status)) && (
        <div className="review-coach-verification-list">
          <h3>延迟验证</h3>
          {snapshot.delayedVerifications.filter((item) => ["scheduled", "eligible", "missed"].includes(item.status)).sort((a, b) => a.verificationDueAt.localeCompare(b.verificationDueAt)).slice(0, 3).map((item) => (
            <div key={item.id}><strong>{recordById.get(item.recordId)?.title ?? "已删除的日志"}</strong><small>{item.status === "scheduled" ? "等待验证" : "已到验证窗口"} · {formatDateTime(item.verificationDueAt)}</small></div>
          ))}
        </div>
      )}

      {interventionEffectSummaries.length > 0 && (
        <div className="review-coach-effect-list">
          <h3>训练效果</h3>
          {interventionEffectSummaries.slice(0, 3).map((effect) => (
            <div key={effect.id}>
              <span><strong>{effect.problemType} · {effect.practiceType}</strong><small>{effect.sampleCount} 次样本 · 近 30 天 {effect.recentSampleCount} 次</small></span>
              <b>{effect.evidenceStatus === "insufficient" ? "证据不足" : `保持率 ${Math.round((effect.retentionRate ?? 0) * 100)}%`}</b>
            </div>
          ))}
        </div>
      )}

      {message && <p className="review-coach-message" role="status">{message}</p>}
    </section>
  );
};
