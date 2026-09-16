import { BrainCircuit, ClipboardCheck, LayoutDashboard, ShieldCheck } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { AdaptiveReviewPage } from "../features/reviewCoach/AdaptiveReviewPage";
import { buildAnalysisPlanningBlocks, type AnalysisPlanningBlock } from "../features/reviewCoach/analysisPlanner";
import type { AdaptiveQuizTurn, ReviewCoachFormalSnapshot, SubjectiveOutcome } from "../features/reviewCoach/domain";
import { ReviewCoachWorkbench } from "../features/reviewCoach/ReviewCoachWorkbench";
import { reviewCoachRepository } from "../features/reviewCoach/repository";
import { nowISO } from "../lib/date";
import { storage } from "../services/storageAdapter";
import type { RecordBlock } from "../types";

type PreviewView = "dashboard" | "training" | "verification";

interface PreviewData {
  snapshot: ReviewCoachFormalSnapshot;
  records: RecordBlock[];
  planningBlocks: AnalysisPlanningBlock[];
}

const TRAINING_TASK_ID = "stage5-preview-task-1";
const VERIFICATION_TASK_ID = "stage7-verification-task-1";

const createTrainingTurn = (snapshot: ReviewCoachFormalSnapshot): AdaptiveQuizTurn | undefined => {
  const task = snapshot.adaptiveReviewTasks.find((item) => item.id === TRAINING_TASK_ID);
  const blueprint = snapshot.sessionBlueprints.find((item) => item.id === task?.blueprintId);
  if (!task || !blueprint) return undefined;
  const stamp = nowISO();
  return {
    id: "coach-preview-training-turn-1",
    taskId: task.id,
    decisionBlockId: task.decisionBlockId,
    recordId: task.recordId,
    contentVersion: task.contentVersion,
    sequence: 1,
    status: "displayed",
    practiceType: "variation",
    answerMode: "unique",
    question: "在 BFS 中首次发现一个尚未访问的相邻节点时，应当先标记 visited，还是先加入队列？请说明这样做避免了什么问题。",
    displayedAt: stamp,
    sourceEvidence: blueprint.evidence,
    answerCriteria: ["先标记 visited，再加入队列", "避免同一节点被重复加入队列"],
    hintsUsed: [],
    availableHints: ["考虑两个父节点同时发现同一个相邻节点。", "标记时机需要阻止第二次入队。"],
    qualityChecked: true,
    qualityModel: "deterministic-preview",
    generationModel: "deterministic-preview",
    promptVersion: "quiz-turn-v1",
    policyVersion: "review-coach-policy-v1",
    idempotencyKey: "coach-preview-training-turn:1",
    createdAt: stamp,
    updatedAt: stamp,
  };
};

export const ReviewCoachPreviewApp = () => {
  const [view, setView] = useState<PreviewView>("dashboard");
  const [data, setData] = useState<PreviewData>();
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("本地预览空间，不连接云端");
  const [trainingTurns, setTrainingTurns] = useState<AdaptiveQuizTurn[]>([]);

  useEffect(() => {
    let active = true;
    void Promise.all([
      reviewCoachRepository.getFormalSnapshot(),
      storage.listBlocks(),
      storage.listAssets(),
      storage.listRecordReviewLogs(),
    ]).then(([snapshot, blocks, assets, reviewLogs]) => {
      if (!active) return;
      const records = blocks.filter((block): block is RecordBlock => block.type === "record");
      const planningBlocks = buildAnalysisPlanningBlocks({ snapshot, records, assets, reviewLogs });
      setData({ snapshot, records, planningBlocks });
      const turn = createTrainingTurn(snapshot);
      if (turn) setTrainingTurns([turn]);
    }).catch((reason: unknown) => {
      if (active) setError(reason instanceof Error ? reason.message : "预览数据加载失败");
    });
    return () => { active = false; };
  }, []);

  const trainingSnapshot = useMemo(() => {
    if (!data) return undefined;
    return {
      ...data.snapshot,
      adaptiveReviewTasks: data.snapshot.adaptiveReviewTasks.map((task) => task.id === TRAINING_TASK_ID
        ? { ...task, status: "in-progress" as const, activeSlotKey: "global-current" as const, endedAt: undefined }
        : task),
      adaptiveQuizTurns: [
        ...data.snapshot.adaptiveQuizTurns.filter((turn) => turn.taskId !== TRAINING_TASK_ID),
        ...trainingTurns,
      ],
    };
  }, [data, trainingTurns]);

  if (error) {
    return <main className="coach-preview-error"><strong>AI 驾驶舱预览无法加载</strong><p>{error}</p></main>;
  }
  if (!data || !trainingSnapshot) {
    return <main className="coach-preview-loading"><BrainCircuit size={24} /><span>正在准备隔离预览...</span></main>;
  }

  const updateTask = (taskId: string, status: ReviewCoachFormalSnapshot["adaptiveReviewTasks"][number]["status"]) => {
    setData((current) => current ? {
      ...current,
      snapshot: {
        ...current.snapshot,
        adaptiveReviewTasks: current.snapshot.adaptiveReviewTasks.map((task) => task.id === taskId
          ? { ...task, status, activeSlotKey: status === "current" || status === "in-progress" ? "global-current" : undefined, updatedAt: nowISO() }
          : task),
      },
    } : current);
  };

  const finishPreview = async (_taskId: string, outcome: SubjectiveOutcome) => {
    setNotice(`演示结果已记录：${outcome === "mastered" ? "已掌握" : outcome === "needs-consolidation" ? "仍需巩固" : "未掌握"}`);
    setView("dashboard");
  };

  const handleGenerateTurn = async () => {
    const previous = trainingTurns.at(-1);
    if (!previous || previous.status !== "answered") return;
    const stamp = nowISO();
    setTrainingTurns((current) => [...current, {
      ...previous,
      id: `coach-preview-training-turn-${current.length + 1}`,
      sequence: current.length + 1,
      status: "displayed",
      question: "如果在节点出队时才设置 visited，同一层的两个节点都指向它，会发生什么？",
      answerMode: "open",
      hintsUsed: [],
      availableHints: ["关注该节点在首次出队之前可能被发现几次。"],
      answerText: undefined,
      answeredAt: undefined,
      assessment: undefined,
      assessmentRationale: undefined,
      displayedAt: stamp,
      createdAt: stamp,
      updatedAt: stamp,
      idempotencyKey: `coach-preview-training-turn:${current.length + 1}`,
    }]);
  };

  const updateCurrentTrainingTurn = (updater: (turn: AdaptiveQuizTurn) => AdaptiveQuizTurn) => {
    setTrainingTurns((current) => current.map((turn, index) => index === current.length - 1 ? updater(turn) : turn));
  };

  const tabs: Array<{ id: PreviewView; label: string; icon: typeof LayoutDashboard }> = [
    { id: "dashboard", label: "驾驶舱", icon: LayoutDashboard },
    { id: "training", label: "自适应训练", icon: ClipboardCheck },
    { id: "verification", label: "延迟验证", icon: ShieldCheck },
  ];

  return (
    <div className="coach-preview-shell">
      <header className="coach-preview-header">
        <div className="coach-preview-title">
          <span><BrainCircuit size={20} /></span>
          <div><p className="eyebrow">Review Coach</p><h1>AI 驾驶舱</h1></div>
        </div>
        <span className="coach-preview-safety"><ShieldCheck size={15} />隔离预览</span>
      </header>

      <nav className="coach-preview-tabs" aria-label="AI 驾驶舱预览视图">
        {tabs.map((tab) => {
          const Icon = tab.icon;
          return <button key={tab.id} type="button" className={view === tab.id ? "active" : ""} onClick={() => setView(tab.id)}><Icon size={16} />{tab.label}</button>;
        })}
      </nav>

      <div className="coach-preview-status" role="status"><span />{notice}</div>

      <div className="coach-preview-content">
        {view === "dashboard" && (
          <main className="page coach-preview-dashboard">
            <ReviewCoachWorkbench
              planningBlocks={data.planningBlocks}
              snapshot={data.snapshot}
              records={data.records}
              onAnalyze={async () => { setNotice("演示分析已完成：未调用 AI Provider"); }}
              onResume={async () => { setNotice("演示分析已恢复：未发送网络请求"); }}
              onSwitchTask={async (taskId) => { updateTask(taskId, "current"); setNotice("已在预览内切换当前任务"); }}
              onDeferTask={async (taskId) => { updateTask(taskId, "deferred"); setNotice("已在预览内延期任务"); }}
              onOpenTask={(taskId) => setView(taskId === VERIFICATION_TASK_ID ? "verification" : "training")}
            />
          </main>
        )}

        {view === "training" && (
          <AdaptiveReviewPage
            taskId={TRAINING_TASK_ID}
            snapshot={trainingSnapshot}
            records={data.records}
            onBack={() => setView("dashboard")}
            onGenerateTurn={handleGenerateTurn}
            onRequestHint={async (_turnId, level) => updateCurrentTrainingTurn((turn) => ({ ...turn, hintsUsed: [...turn.hintsUsed, { level, requestedAt: nowISO() }] }))}
            onSubmitAnswer={async (_turnId, answer) => updateCurrentTrainingTurn((turn) => ({ ...turn, status: "answered", answerText: answer, answeredAt: nowISO(), assessment: "correct", assessmentRationale: "回答抓住了标记时机与避免重复入队两个关键点。", updatedAt: nowISO() }))}
            onSkipTurn={async () => updateCurrentTrainingTurn((turn) => ({ ...turn, status: "answered", answeredAt: nowISO(), assessment: "unreliable", assessmentRationale: "本轮已跳过，不计为掌握证据。", updatedAt: nowISO() }))}
            onReportInvalid={async () => { setNotice("演示题目已标记为无效"); setView("dashboard"); }}
            onFinish={finishPreview}
            onFinishVerification={async () => undefined}
            onCompleteLoop={async () => { setNotice("演示闭环已完成"); setView("dashboard"); }}
            onCompleteV2Verification={async () => { setNotice("演示验证已按作答证据记录"); setView("dashboard"); }}
            onSelectIntervention={async (_taskId, path) => setNotice(`演示下一步：${path}`)}
            onDeferAttempt={async () => { setNotice("演示本次训练已延期，稍后继续同一目标"); setView("dashboard"); }}
            onDefer={async () => { setNotice("演示任务已延期一天"); setView("dashboard"); }}
            onAbandon={async () => { setNotice("演示任务已放弃"); setView("dashboard"); }}
          />
        )}

        {view === "verification" && (
          <AdaptiveReviewPage
            taskId={VERIFICATION_TASK_ID}
            snapshot={data.snapshot}
            records={data.records}
            onBack={() => setView("dashboard")}
            onGenerateTurn={async () => undefined}
            onRequestHint={async () => undefined}
            onSubmitAnswer={async () => undefined}
            onSkipTurn={async () => undefined}
            onReportInvalid={async () => { setNotice("演示验证题已标记为无效"); setView("dashboard"); }}
            onFinish={async () => undefined}
            onFinishVerification={async (taskId, outcome) => { updateTask(taskId, outcome === "retained" ? "completed" : "not-achieved"); setNotice(`延迟验证演示结果：${outcome === "retained" ? "仍然掌握" : "已经衰退"}`); setView("dashboard"); }}
            onCompleteLoop={async () => { setNotice("演示闭环已完成"); setView("dashboard"); }}
            onCompleteV2Verification={async () => { setNotice("演示验证已按作答证据记录"); setView("dashboard"); }}
            onSelectIntervention={async (_taskId, path) => setNotice(`演示下一步：${path}`)}
            onDeferAttempt={async () => { setNotice("演示验证已延期，稍后继续"); setView("dashboard"); }}
            onDefer={async () => { setNotice("演示验证已延期一天"); setView("dashboard"); }}
            onAbandon={async () => { setNotice("演示验证已放弃"); setView("dashboard"); }}
          />
        )}
      </div>
    </div>
  );
};
