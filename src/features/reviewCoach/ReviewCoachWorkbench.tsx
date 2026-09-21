import { BrainCircuit, Clock3, Play, RefreshCw } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import type { AiProviderProfile, RecordBlock } from "../../types";
import type { AdaptiveReviewTask, ReviewCoachFormalSnapshot } from "./domain";
import { maxAnalysisInputTokensForProvider, planAnalysisBatches, type AnalysisPlanningBlock } from "./analysisPlanner";
import { listDecayedBlocksNeedingReplan } from "./replay";
import { rankWaitingTasks } from "./orchestrator";
import { formatActionableError } from "../../lib/uiError";
import { useInteractionTrace } from "../../hooks/useInteractionTrace";
import { structuredOutputModeForProvider } from "../../lib/aiProviders";
import { DecisionBlockRichPreview } from "./DecisionBlockRichPreview";

interface ReviewCoachWorkbenchProps {
  planningBlocks: readonly AnalysisPlanningBlock[];
  snapshot: ReviewCoachFormalSnapshot;
  records: readonly RecordBlock[];
  provider?: AiProviderProfile;
  sessionId?: string;
  onAnalyze: (decisionBlockIds: readonly string[], allowCrossBlockSupport: boolean) => Promise<unknown>;
  onResume: (batchId: string) => Promise<unknown>;
  onSwitchTask: (taskId: string) => Promise<unknown>;
  onDeferTask: (taskId: string) => Promise<unknown>;
  onOpenTask?: (taskId: string) => void;
  /**
   * B-3 (F-03): records the user's own note for a block whose delayed verification decayed and
   * which nothing has addressed since. The note becomes ordinary user-authored feedback, so the
   * block re-enters the normal analysis queue — no system-authored formal facts are created.
   */
  onReplanDecayedBlock?: (input: {
    decisionBlockId: string;
    recordId: string;
    contentVersion: number;
  }) => Promise<unknown>;
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
  sessionId,
  onAnalyze,
  onResume,
  onSwitchTask,
  onDeferTask,
  onOpenTask,
  onReplanDecayedBlock,
}: ReviewCoachWorkbenchProps) => {
  const [busyAction, setBusyAction] = useState<string>();
  const [message, setMessage] = useState<string>();

  // The workbench no longer selects a subset of blocks to analyse: the user's
  // own feedback already decided what needs attention. A single action analyses
  // everything pending and produces the first task.
  const maxInputTokens = provider ? maxAnalysisInputTokensForProvider(provider) : 57_536;
  const plan = useMemo(() => planAnalysisBatches(planningBlocks, maxInputTokens), [maxInputTokens, planningBlocks]);
  const pausedBatches = snapshot.analysisBatches.filter((item) => ["confirmed", "running"].includes(item.status) && !item.deletedAt);
  const terminalBatches = snapshot.analysisBatches.filter((item) => ["succeeded", "partial", "failed"].includes(item.status) && !item.deletedAt);
  const latestBatch = [...terminalBatches].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))[0];
  const now = new Date().toISOString();
  const currentTask = snapshot.adaptiveReviewTasks.find(
    (item) => (item.status === "current" || item.status === "in-progress") && !item.deletedAt,
  );
  const alternatives = rankWaitingTasks(snapshot.adaptiveReviewTasks.filter((item) => !item.deletedAt), now);
  const blueprintById = new Map(snapshot.sessionBlueprints.map((item) => [item.id, item]));
  const verificationByTaskId = new Map(snapshot.delayedVerifications.filter((item) => item.taskId).map((item) => [item.taskId!, item]));
  const recordById = new Map(records.map((item) => [item.id, item]));
  const currentTaskRecord = currentTask ? recordById.get(currentTask.recordId) : undefined;
  const currentTaskVerification = currentTask ? verificationByTaskId.get(currentTask.id) : undefined;
  /**
   * One sentence saying why this task is the one to do.
   *
   * The plan asks for "一句具体原因" instead of a status label. A due delayed
   * verification is stated as such because that is a fact about the evidence,
   * not a model's opinion; an already-started task says to continue; anything
   * else states what the user's own feedback asked to work on.
   */
  const currentTaskReason = (() => {
    if (!currentTask) return "";
    if (currentTaskVerification && ["scheduled", "eligible", "missed", "queued", "in-progress"].includes(currentTaskVerification.status)) {
      return "上次以为自己记住了，现在还没验证过 —— 先证明一次。";
    }
    if (currentTask.status === "in-progress") return "这次训练还没做完，接着上次继续。";
    const blueprint = blueprintById.get(currentTask.blueprintId);
    return blueprint?.objective ? `你自己写下要解决的问题：${blueprint.objective}` : "这条记录你标记过需要再练一次。";
  })();
  // B-3 (F-03): blocks whose decay is still the newest word on them. Derived, never written.
  const replanBlocks = useMemo(() => listDecayedBlocksNeedingReplan(snapshot), [snapshot]);
  const hasContent = planningBlocks.length > 0 || pausedBatches.length > 0 || Boolean(currentTask) || alternatives.length > 0 || Boolean(latestBatch) || replanBlocks.length > 0;

  /**
   * Entry friction is the M0 measurement that justifies this whole screen.
   *
   * The workbench is exactly where "time before any retrieval happens" is spent,
   * so it has to record its own operation time; without it the report would
   * attribute workbench time to nothing. The hooks are called before the early
   * return so the call order stays stable across renders.
   */
  const trace = useInteractionTrace();
  useEffect(() => {
    trace.enter({ screen: "workbench", category: "operation", phase: "workbench", sessionId });
  }, [sessionId, trace]);

  if (!hasContent) return null;

  const run = async (action: string, work: () => Promise<unknown>, success: string) => {
    setBusyAction(action);
    setMessage(undefined);
    try {
      await work();
      setMessage(success);
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
      </header>

      {planningBlocks.length > 0 && !currentTask && (
        <div className="review-coach-analysis">
          <div className="review-coach-analysis-list">
            {planningBlocks.map((block) => (
              <div key={block.decisionBlockId} className="review-coach-analysis-item">
                <div className="review-coach-analysis-copy">
                  <span><strong>{block.recordTitle}</strong></span>
                  <DecisionBlockRichPreview
                    record={recordById.get(block.recordId)}
                    decisionBlockId={block.decisionBlockId}
                    referenceRecords={records}
                    className="review-coach-block-preview"
                    ariaLabel={`${block.recordTitle} 的复习重点预览`}
                  />
                  <span className="review-coach-feedback-quote">“{block.feedback.at(-1)!.comment}”</span>
                </div>
              </div>
            ))}
          </div>

          {plan.oversized.length > 0 && (
            <p className="review-coach-error">{plan.oversized.map((item) => item.recordTitle).join("、")} 超过模型上下文上限，请缩小或拆分决策块。</p>
          )}

          <p className="review-coach-provider-note">
            {provider
              ? `当前模型：${provider.providerName} / ${provider.model}。结构化输出：${structuredOutputModeForProvider(provider) === "json-object" ? "接口 JSON object" : "仅提示词 + 本机 Schema 校验"}。`
              : "尚未选择模型。请先在“更多 -> AI 设置”中配置供应商、模型和 API Key。"}
          </p>

          {/*
            M5: one action, no batch confirmation. The entry point should lead
            straight to the first retrieval. Selecting blocks, sizing
            sub-batches and re-confirming the same set was configuration work
            that produced no retrieval; the user's own feedback already decided
            what to analyse.
          */}
          <button
            type="button"
            className="primary-button"
            disabled={plan.oversized.length > 0 || Boolean(busyAction)}
            onClick={() => void run("analysis", () => onAnalyze(planningBlocks.map((item) => item.decisionBlockId), false), "分析完成，已生成复习任务。")}
            aria-busy={busyAction === "analysis"}
          >
            <BrainCircuit size={17} />{busyAction === "analysis" ? "正在分析并出题…" : "开始分析并出题"}
          </button>
          {busyAction === "analysis" && (
            <p className="review-coach-provider-note" role="status" aria-live="polite">
              已提交当前复习重点，正在等待模型返回结构化任务。请保持应用在前台，不要重复点击。
            </p>
          )}
        </div>
      )}

      {pausedBatches.map((batch) => (
        <div className="review-coach-resume" key={batch.id}>
          <span><strong>分析已暂停</strong><small>还有内容尚未分析完成</small></span>
          <button type="button" disabled={Boolean(busyAction)} onClick={() => void run(`resume:${batch.id}`, () => onResume(batch.id), "分析已继续完成。") }>
            <RefreshCw size={16} />继续分析
          </button>
        </div>
      ))}

      {latestBatch && (
        <div className="review-coach-latest-batch">
          <span>最近分析：{latestBatch.status === "succeeded" ? "全部完成" : latestBatch.status === "partial" ? "部分完成" : "失败"}</span>
        </div>
      )}

      {/*
        M5: one current action, not a queue of them.

        The plan asks the screen to show "一个当前任务、一句具体原因和
        开始/换一个/今天跳过", and to keep the multi-task list from competing
        on the same screen (section 5, M5 交付). The previous version rendered
        every active task with its own controls and made switching a two-step
        "设为当前 -> 确认切换" flow, so the learner was asked to configure which
        task to do instead of being told what to do next.

        Now: exactly one task is shown with one reason, "换一个" is a single tap
        that hands the choice to the next candidate, and the remaining tasks are
        a count. Nothing else on this screen offers a second primary action.
      */}
      {currentTask && (
        <div className="review-coach-current-task">
          <div>
            <span>{currentTaskVerification ? "延迟验证" : taskStatusLabel[currentTask.status]}</span>
            <strong>{currentTaskRecord?.title ?? "已删除的日志"}</strong>
            <p>{currentTaskReason}</p>
          </div>
          <div className="review-coach-task-actions">
            {onOpenTask && (
              <button
                type="button"
                className="primary-button"
                onClick={() => onOpenTask(currentTask.id)}
              >
                <Play size={15} />{currentTask.status === "in-progress" ? "继续训练" : "开始训练"}
              </button>
            )}
            {alternatives.length > 0 && (
              <button
                type="button"
                disabled={Boolean(busyAction)}
                onClick={() => void run("switch", () => onSwitchTask(alternatives[0].id), "已换成下一个任务。")}
              >
                <RefreshCw size={15} />换一个
              </button>
            )}
            <button
              type="button"
              disabled={Boolean(busyAction)}
              onClick={() => void run("defer", () => onDeferTask(currentTask.id), "今天已跳过，明天再提醒。")}
            >
              <Clock3 size={15} />今天跳过
            </button>
          </div>
        </div>
      )}

      {currentTask && alternatives.length > 0 && (
        <p className="review-coach-task-remaining">
          另有 {alternatives.length} 个任务在后面等着，做完这个再安排。
        </p>
      )}

      {replanBlocks.length > 0 && (
        <div className="review-coach-verification-list review-coach-replan-list">
          <h3>需要重新规划</h3>
          {replanBlocks.slice(0, 3).map((item) => (
            <div key={item.decisionBlockId}>
              <strong>{recordById.get(item.recordId)?.title ?? "已删除的日志"}</strong>
              <small>延迟验证出现衰退 · {formatDateTime(item.decayedAt)}</small>
              {onReplanDecayedBlock && (
                <span className="review-coach-replan-actions">
                  <button
                    type="button"
                    disabled={Boolean(busyAction)}
                    onClick={() => void run(
                      `replan:${item.decisionBlockId}`,
                      () => onReplanDecayedBlock({
                        decisionBlockId: item.decisionBlockId,
                        recordId: item.recordId,
                        contentVersion: item.contentVersion,
                      }),
                      "已使用你之前的反馈重新加入分析。",
                    )}
                  >
                    <RefreshCw size={15} />重新加入分析
                  </button>
                </span>
              )}
            </div>
          ))}
        </div>
      )}

      {message && <p className="review-coach-message" role="status">{message}</p>}
    </section>
  );
};
