import type { Asset, RecordBlock, RecordReviewLog, RecordReviewState } from "../types";
import { db } from "../db/database";
import { storage } from "../services/storageAdapter";
import { addDaysISO, nowISO, todayISO } from "../lib/date";
import { createBaseEntity } from "../lib/entity";
import { isDesktopPlatform, isNativePlatform } from "../lib/platform";
import type { AdaptiveQuizTurn, AdaptiveReviewTask, AnalysisBatch, AnalysisInputRef, AnalysisQueueItem, DecisionBlockFeedback, DelayedVerification, SessionBlueprint, TaskOutcomeEvent } from "../features/reviewCoach/domain";
import { reviewCoachRepository } from "../features/reviewCoach/repository";

const PREVIEW_RECORD_ID = "stage3-preview-record";
const PREVIEW_DECISION_BLOCK_ID = "stage3-preview-decision-block";
const PREVIEW_SUBJECT = "数据结构";

const yesterdayDateTime = (): string => `${addDaysISO(todayISO(), -1)}T09:00:00.000Z`;

const previewRecord = (): RecordBlock => {
  const stamp = nowISO();
  return {
    id: PREVIEW_RECORD_ID,
    createdAt: stamp,
    updatedAt: stamp,
    type: "record",
    date: todayISO(),
    order: 0,
    subject: PREVIEW_SUBJECT,
    title: "BFS Stage3 Preview",
    favorite: true,
    contentHtml: `<p>Record context</p><record-decision-block data-decision-block-id="${PREVIEW_DECISION_BLOCK_ID}" data-content-version="1" data-created-at="${stamp}" data-updated-at="${stamp}"><p>BFS queue insertion and visited marking</p></record-decision-block><p>After block</p>`,
    assets: [],
    formulas: [],
    mistakeRefs: [],
    tags: ["stage3"],
  };
};

/** Seeds only the local browser preview requested for Stage 3 UI acceptance. */
export const seedStage3Preview = async (): Promise<void> => {
  await storage.initialize();
  await storage.getOrCreateEntry(todayISO());

  const existing = await db.blocks.get(PREVIEW_RECORD_ID);
  if (!existing || existing.type !== "record") {
    await storage.saveBlock(previewRecord());
  } else if (!existing.favorite) {
    await storage.saveBlock({ ...existing, favorite: true });
  }

  let review = await storage.getRecordReview(PREVIEW_RECORD_ID);
  if (!review) {
    await storage.addRecordToReview(PREVIEW_RECORD_ID);
    review = await storage.getRecordReview(PREVIEW_RECORD_ID);
  }

  const ratingLogs = await storage.listRecordReviewLogs(PREVIEW_RECORD_ID);
  if (!ratingLogs.some((log) => log.eventType === "rating")) {
    const reviewedAt = yesterdayDateTime();
    const log: RecordReviewLog = {
      ...createBaseEntity(),
      recordId: PREVIEW_RECORD_ID,
      rating: "forgot",
      eventType: "rating",
      normalizedRating: "forgot",
      reviewKind: "overview",
      scheduler: "overview-v1",
      evaluationText: "Old evaluation context",
      reviewedAt,
      previousEaseFactor: 2.5,
      nextEaseFactor: 2.3,
      previousRepetition: 0,
      nextRepetition: 0,
      previousIntervalDays: 1,
      nextIntervalDays: 1,
      nextReviewDate: todayISO(),
      previousConsecutiveRemembered: 0,
      previousTotalReviews: 0,
      updatedAt: reviewedAt,
    };
    await db.recordReviewLogs.put(log);
    try {
      await db.decisionBlockFeedback.put({
        ...createBaseEntity(),
        id: "stage3-preview-feedback",
        decisionBlockId: PREVIEW_DECISION_BLOCK_ID,
        recordId: PREVIEW_RECORD_ID,
        contentVersion: 1,
        reviewLogId: log.id,
        comment: "I mark visited too late",
        includeInAnalysis: true,
        source: "review",
        occurredAt: reviewedAt,
        idempotencyKey: "feedback:stage3-preview-feedback",
      });
      await db.analysisQueueItems.put({
        ...createBaseEntity(),
        id: "stage3-preview-queue-item",
        decisionBlockId: PREVIEW_DECISION_BLOCK_ID,
        recordId: PREVIEW_RECORD_ID,
        contentVersion: 1,
        feedbackId: "stage3-preview-feedback",
        status: "eligible",
        eligibilityReason: "user-feedback",
      });
    } catch (error) {
      console.error("Stage 3 preview feedback initialization failed", error);
    }
  }

  const seededReview: RecordReviewState = {
    ...(await db.recordReviews.get(PREVIEW_RECORD_ID) ?? review ?? {
      id: PREVIEW_RECORD_ID,
      recordId: PREVIEW_RECORD_ID,
      createdAt: nowISO(),
      updatedAt: nowISO(),
      easeFactor: 2.5,
      repetition: 0,
      intervalDays: 1,
      consecutiveRemembered: 0,
      totalReviews: 0,
    }),
    status: "active",
    reviewKind: "overview",
    scheduler: "overview-v1",
    lastReviewDate: undefined,
    lastReviewedAt: undefined,
    nextReviewDate: addDaysISO(todayISO(), -1),
    updatedAt: nowISO(),
  };
  await db.recordReviews.put({
    ...seededReview,
    nextReviewDate: addDaysISO(todayISO(), -1),
    fsrsCard: seededReview.fsrsCard
      ? { ...seededReview.fsrsCard, dueDate: todayISO() }
      : undefined,
  });
  const projectionLogs = await db.recordReviewLogs.where("recordId").equals(PREVIEW_RECORD_ID).toArray();
  for (const log of projectionLogs) {
    if (!log.stateAfter) continue;
    await db.recordReviewLogs.put({ ...log, stateAfter: seededReview });
  }
};

/** Seeds a realistic large journal without exposing the helper in native builds. */
export const seedJournalPerformancePreview = async (): Promise<void> => {
  await seedStage3Preview();
  const stamp = nowISO();
  const records: RecordBlock[] = Array.from({ length: 91 }, (_, index) => ({
    id: `journal-performance-record-${index + 1}`,
    createdAt: stamp,
    updatedAt: stamp,
    type: "record",
    date: addDaysISO(todayISO(), -(index + 1)),
    order: index + 1,
    subject: PREVIEW_SUBJECT,
    title: `日志性能回归 ${String(index + 2).padStart(2, "0")}`,
    contentHtml: `<p>${"这是一段用于验证长日志列表性能的真实长度正文。".repeat(80)}</p>`,
    assets: [],
    formulas: [],
    mistakeRefs: [],
    tags: ["性能回归"],
  }));
  await db.blocks.bulkPut(records);
};

/** Adds a deterministic completed interpretation without contacting an AI provider. */
export const seedStage4Preview = async (): Promise<void> => {
  await seedStage3Preview();
  const feedback = await db.decisionBlockFeedback.get("stage3-preview-feedback");
  if (!feedback) return;
  const stamp = nowISO();
  await db.feedbackInterpretations.put({
    id: "stage4-preview-interpretation",
    feedbackId: feedback.id,
    decisionBlockId: feedback.decisionBlockId,
    contentVersion: feedback.contentVersion,
    status: "succeeded",
    actionability: "needs_training",
    difficultyType: "procedure",
    stuckAt: "访问标记时机",
    userHypothesis: "可能把出队处理和首次发现节点混在了一起",
    preferredPractice: "variation",
    missingInformation: [],
    confidence: 0.86,
    aiGenerated: true,
    model: "quick-model-preview",
    provider: "deterministic-preview",
    promptVersion: "feedback-interpretation-v1",
    policyVersion: "review-coach-policy-v1",
    schemaVersion: 1,
    promptTokens: 128,
    completionTokens: 42,
    totalTokens: 170,
    requestId: "stage4-preview-request",
    attemptCount: 1,
    createdAt: stamp,
    updatedAt: stamp,
  });
};

const stage5Record = (
  id: string,
  decisionBlockId: string,
  title: string,
  subject: string,
  content: string,
  assetId?: string,
): RecordBlock => {
  const stamp = nowISO();
  const asset = assetId ? `<record-asset data-asset-id="${assetId}" data-kind="image" data-title="待识别板书"></record-asset>` : "";
  return {
    id,
    createdAt: stamp,
    updatedAt: stamp,
    type: "record",
    date: todayISO(),
    order: 0,
    subject,
    title,
    contentHtml: `<p>复习上下文</p><record-decision-block data-decision-block-id="${decisionBlockId}" data-content-version="1" data-created-at="${stamp}" data-updated-at="${stamp}"><p>${content}</p>${asset}</record-decision-block>`,
    assets: assetId ? [{ id: assetId, title: "待识别板书", kind: "image" }] : [],
    formulas: [],
    mistakeRefs: [],
    tags: ["stage5"],
  };
};

/** Seeds the Stage 5 workbench with deterministic formal facts and never calls an AI provider. */
export const seedStage5Preview = async (): Promise<void> => {
  await seedStage4Preview();
  const stamp = nowISO();
  const records = [
    stage5Record("stage5-waiting-record", "stage5-waiting-block", "二分查找边界", "算法", "循环不变量决定右边界是否减一。"),
    stage5Record("stage5-deferred-record", "stage5-deferred-block", "事务隔离级别", "数据库", "可重复读与幻读需要分别判断。"),
    stage5Record("stage5-ocr-record", "stage5-ocr-block", "B+ 树分裂", "数据库", "叶子结点分裂后需要维护链表和父索引。", "stage5-ocr-asset"),
    stage5Record("stage5-plain-record", "stage5-plain-block", "TCP 拥塞窗口", "计算机网络", "拥塞避免阶段按 RTT 线性增长窗口。"),
  ];
  for (const record of records) await storage.saveBlock(record);

  const previewAsset: Asset = {
    id: "stage5-ocr-asset",
    fileName: "stage5-board.png",
    title: "待识别板书",
    mimeType: "image/png",
    size: 0,
    kind: "image",
    data: new Blob([], { type: "image/png" }),
    ocrStatus: "idle",
    createdAt: stamp,
    updatedAt: stamp,
  };
  await db.assets.put(previewAsset);

  const specs = [
    { blockId: PREVIEW_DECISION_BLOCK_ID, recordId: PREVIEW_RECORD_ID, feedbackId: "stage3-preview-feedback", queueId: "stage3-preview-queue-item", comment: "I mark visited too late" },
    { blockId: "stage5-waiting-block", recordId: "stage5-waiting-record", feedbackId: "stage5-waiting-feedback", queueId: "stage5-waiting-queue", comment: "我总在左右闭区间之间混用更新规则" },
    { blockId: "stage5-deferred-block", recordId: "stage5-deferred-record", feedbackId: "stage5-deferred-feedback", queueId: "stage5-deferred-queue", comment: "隔离级别对应的现象容易记反" },
    { blockId: "stage5-ocr-block", recordId: "stage5-ocr-record", feedbackId: "stage5-ocr-feedback", queueId: "stage5-ocr-queue", comment: "分裂之后父结点更新步骤不确定" },
    { blockId: "stage5-plain-block", recordId: "stage5-plain-record", feedbackId: "stage5-plain-feedback", queueId: "stage5-plain-queue", comment: "慢启动和拥塞避免的增长速度会混淆" },
  ] as const;
  const feedback = specs.slice(1).map((item): DecisionBlockFeedback => ({
    id: item.feedbackId,
    decisionBlockId: item.blockId,
    recordId: item.recordId,
    contentVersion: 1,
    comment: item.comment,
    includeInAnalysis: true,
    source: "review",
    occurredAt: stamp,
    idempotencyKey: `feedback:${item.feedbackId}`,
    createdAt: stamp,
    updatedAt: stamp,
  }));
  await db.decisionBlockFeedback.bulkPut(feedback);

  const refs = specs.map((item): AnalysisInputRef => ({
    queueItemId: item.queueId,
    feedbackId: item.feedbackId,
    interpretationId: item.feedbackId === "stage3-preview-feedback" ? "stage4-preview-interpretation" : undefined,
    decisionBlockId: item.blockId,
    recordId: item.recordId,
    contentVersion: 1,
  }));
  const batchId = "stage5-preview-batch";
  const queueItems = specs.map((item, index): AnalysisQueueItem => ({
    id: item.queueId,
    feedbackId: item.feedbackId,
    decisionBlockId: item.blockId,
    recordId: item.recordId,
    contentVersion: 1,
    status: index < 3 ? "consumed" : "eligible",
    eligibilityReason: "user-feedback",
    batchId: index < 4 ? batchId : undefined,
    consumedAt: index < 3 ? stamp : undefined,
    createdAt: stamp,
    updatedAt: stamp,
  }));
  await db.analysisQueueItems.bulkPut(queueItems);

  const batch: AnalysisBatch = {
    id: batchId,
    status: "partial",
    inputRefs: refs.slice(0, 4),
    subBatches: [
      { id: "stage5-preview-sub-batch-1", inputRefs: refs.slice(0, 3), status: "succeeded", estimatedTokens: 2450, totalTokens: 3180, requestId: "stage5-preview-request-1", attemptCount: 1 },
      { id: "stage5-preview-sub-batch-2", inputRefs: refs.slice(3, 4), status: "failed", estimatedTokens: 940, attemptCount: 2, errorCode: "deterministic-preview-timeout" },
    ],
    requestedAt: stamp,
    completedAt: stamp,
    finalSummary: "已为三个重点生成复习任务；一个子批次可重新分析。",
    model: "deep-model-preview",
    provider: "deterministic-preview",
    promptVersion: "session-blueprint-v1",
    policyVersion: "review-coach-policy-v1",
    schemaVersion: 1,
    inputFingerprint: "stage5-preview-fingerprint",
    idempotencyKey: "analysis:stage5-preview",
    estimatedTokens: 3390,
    totalTokens: 3180,
    allowCrossBlockSupport: false,
    createdAt: stamp,
    updatedAt: stamp,
  };
  await db.analysisBatches.put(batch);

  const blueprintFor = (index: number, objective: string): SessionBlueprint => {
    const item = specs[index];
    return {
      id: `stage5-preview-blueprint-${index + 1}`,
      batchId,
      decisionBlockId: item.blockId,
      recordId: item.recordId,
      contentVersion: 1,
      status: "accepted",
      supportingDecisionBlockIds: [],
      feedbackIds: [item.feedbackId],
      interpretationIds: index === 0 ? ["stage4-preview-interpretation"] : [],
      problemHypothesis: "关键步骤之间的条件映射尚未稳定。",
      hypothesisConfidence: 0.84,
      objective,
      completionCriteria: ["能独立说明规则并应用到一个变式"],
      initialPracticeType: "variation",
      initialDifficulty: 2,
      expectedKeyPoints: ["条件", "步骤", "边界"],
      branches: [
        { when: "correct", nextStrategy: "finish" },
        { when: "partial", nextStrategy: "hint" },
        { when: "incorrect", nextStrategy: "explain" },
        { when: "skipped", nextStrategy: "prerequisite-check" },
      ],
      allowedStrategies: ["finish", "hint", "explain", "prerequisite-check"],
      forbiddenScope: ["未提供来源的扩展知识"],
      evidence: [{ decisionBlockId: item.blockId, recordId: item.recordId, contentVersion: 1, excerptHash: `stage5-preview-hash-${index + 1}`, purpose: "主来源" }],
      maxTurns: 4,
      maxRetriesPerTurn: 1,
      maxEstimatedTokens: 4000,
      model: batch.model,
      provider: batch.provider,
      promptVersion: batch.promptVersion,
      policyVersion: batch.policyVersion,
      schemaVersion: batch.schemaVersion,
      idempotencyKey: `blueprint:${batchId}:${item.blockId}:1`,
      createdAt: stamp,
      updatedAt: stamp,
    };
  };
  const blueprints = [
    blueprintFor(0, "稳定说明 BFS 首次发现节点时的标记顺序"),
    blueprintFor(1, "用循环不变量选择一致的二分查找边界"),
    blueprintFor(2, "区分隔离级别与并发现象的对应关系"),
  ];
  await db.sessionBlueprints.bulkPut(blueprints);

  const taskFor = (index: number, status: AdaptiveReviewTask["status"]): AdaptiveReviewTask => ({
    id: `stage5-preview-task-${index + 1}`,
    blueprintId: blueprints[index].id,
    decisionBlockId: blueprints[index].decisionBlockId,
    recordId: blueprints[index].recordId,
    contentVersion: 1,
    status,
    priorityTier: index === 0 ? "repeated-difficulty" : "first-difficulty",
    queuedAt: addDaysISO(todayISO(), -(index + 1)) + "T08:00:00.000Z",
    notBeforeAt: status === "deferred" ? addDaysISO(todayISO(), 1) + "T08:00:00.000Z" : undefined,
    startedAt: status === "current" ? stamp : undefined,
    activeSlotKey: status === "current" ? "global-current" : undefined,
    openTargetKey: `${blueprints[index].decisionBlockId}:1`,
    idempotencyKey: `task:${blueprints[index].id}`,
    createdAt: stamp,
    updatedAt: stamp,
  });
  const tasks = [taskFor(0, "current"), taskFor(1, "waiting"), taskFor(2, "deferred")];
  await db.adaptiveReviewTasks.bulkPut(tasks);
  const deferredOutcome: TaskOutcomeEvent = {
    id: "stage5-preview-deferred-outcome",
    taskId: tasks[2].id,
    decisionBlockId: tasks[2].decisionBlockId,
    recordId: tasks[2].recordId,
    contentVersion: 1,
    kind: "task-disposition",
    disposition: "deferred",
    occurredAt: stamp,
    idempotencyKey: "task-deferred:stage5-preview",
    createdAt: stamp,
    updatedAt: stamp,
  };
  await db.taskOutcomeEvents.put(deferredOutcome);
};

/** Seeds one formally displayed, quality-checked turn for Stage 6 UI acceptance. */
export const seedStage6Preview = async (): Promise<void> => {
  await seedStage5Preview();
  // Localhost-only preview credential. It enables browser interception without
  // exposing a real key — and must never clobber a real one the developer has stored.
  const existingSecret = await storage.getAiSecret?.("default");
  if (!existingSecret?.apiKey?.trim()) {
    await storage.saveAiSecret("stage9-preview-placeholder", "default");
  }
  const stamp = nowISO();
  const task = await db.adaptiveReviewTasks.get("stage5-preview-task-1");
  const blueprint = await db.sessionBlueprints.get("stage5-preview-blueprint-1");
  if (!task || !blueprint) return;
  await db.adaptiveReviewTasks.put({ ...task, status: "in-progress", activeSlotKey: "global-current", startedAt: task.startedAt ?? stamp, updatedAt: stamp });
  await db.adaptiveQuizTurns.put({
    id: "stage6-preview-turn-1",
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
    qualityModel: "quick-model-preview",
    generationModel: "quick-model-preview",
    promptVersion: "quiz-turn-v1",
    policyVersion: "review-coach-policy-v1",
    idempotencyKey: "quiz-turn:stage6-preview:1",
    createdAt: stamp,
    updatedAt: stamp,
  });
};

/** Seeds Stage 7 delayed verification and effect projections without contacting an AI provider. */
export const seedStage7Preview = async (): Promise<void> => {
  await seedStage6Preview();
  const stamp = nowISO();
  const blueprints = await db.sessionBlueprints.where("id").anyOf([
    "stage5-preview-blueprint-1",
    "stage5-preview-blueprint-2",
    "stage5-preview-blueprint-3",
  ]).toArray();
  const blueprintById = new Map(blueprints.map((blueprint) => [blueprint.id, blueprint]));
  const sourceTasks = (await Promise.all([1, 2, 3].map((index) => db.adaptiveReviewTasks.get(`stage5-preview-task-${index}`))))
    .filter((task): task is AdaptiveReviewTask => Boolean(task));
  if (sourceTasks.length !== 3) return;

  const sourceCompletedAt = `${addDaysISO(todayISO(), -4)}T09:00:00.000Z`;
  const verificationCompletedAt = `${addDaysISO(todayISO(), -1)}T09:00:00.000Z`;
  const turns: AdaptiveQuizTurn[] = [];
  const outcomes: TaskOutcomeEvent[] = [];
  const verifications: DelayedVerification[] = [];
  const verificationTasks: AdaptiveReviewTask[] = [];

  for (const [offset, sourceTask] of sourceTasks.entries()) {
    const index = offset + 1;
    const blueprint = blueprintById.get(sourceTask.blueprintId);
    if (!blueprint) return;
    const sourceTurnId = `stage7-source-turn-${index}`;
    const sourceSelfId = `stage7-source-self-${index}`;
    const verificationTaskId = `stage7-verification-task-${index}`;
    const verificationTurnId = `stage7-verification-turn-${index}`;
    const completedVerification = index > 1;
    const retained = index === 2;

    await db.adaptiveReviewTasks.put({
      ...sourceTask,
      status: "completed",
      activeSlotKey: undefined,
      openTargetKey: undefined,
      startedAt: sourceTask.startedAt ?? sourceCompletedAt,
      endedAt: sourceCompletedAt,
      updatedAt: sourceCompletedAt,
    });
    turns.push({
      id: sourceTurnId,
      taskId: sourceTask.id,
      decisionBlockId: sourceTask.decisionBlockId,
      recordId: sourceTask.recordId,
      contentVersion: sourceTask.contentVersion,
      sequence: 1,
      status: "answered",
      practiceType: blueprint.initialPracticeType,
      answerMode: "open",
      question: `阶段 7 即时训练题 ${index}`,
      displayedAt: sourceCompletedAt,
      sourceEvidence: blueprint.evidence,
      answerCriteria: blueprint.completionCriteria,
      hintsUsed: [],
      answerText: "能够依据来源独立说明。",
      answeredAt: sourceCompletedAt,
      assessment: "correct",
      assessmentRationale: "符合蓝图完成标准。",
      qualityChecked: false,
      generationModel: "deterministic-preview",
      promptVersion: "quiz-turn-v1",
      policyVersion: "review-coach-policy-v1",
      idempotencyKey: `stage7-source-turn:${index}`,
      createdAt: sourceCompletedAt,
      updatedAt: sourceCompletedAt,
    });
    outcomes.push(
      { id: `stage7-source-answer-${index}`, taskId: sourceTask.id, turnId: sourceTurnId, decisionBlockId: sourceTask.decisionBlockId, recordId: sourceTask.recordId, contentVersion: sourceTask.contentVersion, kind: "answer-assessment", answerAssessment: "correct", occurredAt: sourceCompletedAt, idempotencyKey: `stage7-source-answer:${index}`, createdAt: sourceCompletedAt, updatedAt: sourceCompletedAt },
      { id: sourceSelfId, taskId: sourceTask.id, decisionBlockId: sourceTask.decisionBlockId, recordId: sourceTask.recordId, contentVersion: sourceTask.contentVersion, kind: "self-assessment", subjectiveOutcome: "mastered", occurredAt: sourceCompletedAt, idempotencyKey: `stage7-source-self:${index}`, createdAt: sourceCompletedAt, updatedAt: sourceCompletedAt },
      { id: `stage7-source-disposition-${index}`, taskId: sourceTask.id, decisionBlockId: sourceTask.decisionBlockId, recordId: sourceTask.recordId, contentVersion: sourceTask.contentVersion, kind: "task-disposition", disposition: "completed", occurredAt: sourceCompletedAt, idempotencyKey: `stage7-source-disposition:${index}`, createdAt: sourceCompletedAt, updatedAt: sourceCompletedAt },
    );
    verificationTasks.push({
      id: verificationTaskId,
      blueprintId: sourceTask.blueprintId,
      decisionBlockId: sourceTask.decisionBlockId,
      recordId: sourceTask.recordId,
      contentVersion: sourceTask.contentVersion,
      status: completedVerification ? (retained ? "completed" : "not-achieved") : "in-progress",
      priorityTier: "due-verification",
      queuedAt: `${addDaysISO(todayISO(), -1)}T08:00:00.000Z`,
      startedAt: `${addDaysISO(todayISO(), -1)}T08:30:00.000Z`,
      endedAt: completedVerification ? verificationCompletedAt : undefined,
      activeSlotKey: completedVerification ? undefined : "global-current",
      openTargetKey: completedVerification ? undefined : `${sourceTask.decisionBlockId}:${sourceTask.contentVersion}`,
      idempotencyKey: `stage7-verification-task:${index}`,
      createdAt: sourceCompletedAt,
      updatedAt: completedVerification ? verificationCompletedAt : stamp,
    });
    turns.push({
      id: verificationTurnId,
      taskId: verificationTaskId,
      decisionBlockId: sourceTask.decisionBlockId,
      recordId: sourceTask.recordId,
      contentVersion: sourceTask.contentVersion,
      sequence: 1,
      status: "answered",
      practiceType: blueprint.initialPracticeType,
      answerMode: "open",
      question: index === 1 ? "若两个前驱同时发现同一节点，如何安排 visited 与入队顺序，为什么？" : `阶段 7 间隔验证题 ${index}`,
      displayedAt: verificationCompletedAt,
      sourceEvidence: blueprint.evidence,
      answerCriteria: blueprint.completionCriteria,
      hintsUsed: [],
      answerText: retained || index === 1 ? "仍能独立完成。" : "间隔后无法完整回忆。",
      answeredAt: verificationCompletedAt,
      assessment: retained || index === 1 ? "correct" : "incorrect",
      assessmentRationale: retained || index === 1 ? "保持稳定。" : "关键步骤已经遗忘。",
      qualityChecked: false,
      generationModel: "deterministic-preview",
      promptVersion: "quiz-turn-v1",
      policyVersion: "review-coach-policy-v1",
      idempotencyKey: `stage7-verification-turn:${index}`,
      createdAt: verificationCompletedAt,
      updatedAt: verificationCompletedAt,
    });
    outcomes.push({ id: `stage7-verification-answer-${index}`, taskId: verificationTaskId, turnId: verificationTurnId, decisionBlockId: sourceTask.decisionBlockId, recordId: sourceTask.recordId, contentVersion: sourceTask.contentVersion, kind: "answer-assessment", answerAssessment: retained || index === 1 ? "correct" : "incorrect", occurredAt: verificationCompletedAt, idempotencyKey: `stage7-verification-answer:${index}`, createdAt: verificationCompletedAt, updatedAt: verificationCompletedAt });
    if (completedVerification) outcomes.push(
      { id: `stage7-verification-self-${index}`, taskId: verificationTaskId, decisionBlockId: sourceTask.decisionBlockId, recordId: sourceTask.recordId, contentVersion: sourceTask.contentVersion, kind: "self-assessment", subjectiveOutcome: retained ? "mastered" : "not-mastered", occurredAt: verificationCompletedAt, idempotencyKey: `stage7-verification-self:${index}`, createdAt: verificationCompletedAt, updatedAt: verificationCompletedAt },
      { id: `stage7-verification-disposition-${index}`, taskId: verificationTaskId, decisionBlockId: sourceTask.decisionBlockId, recordId: sourceTask.recordId, contentVersion: sourceTask.contentVersion, kind: "task-disposition", disposition: "completed", occurredAt: verificationCompletedAt, idempotencyKey: `stage7-verification-disposition:${index}`, createdAt: verificationCompletedAt, updatedAt: verificationCompletedAt },
    );
    verifications.push({
      id: `stage7-verification-${index}`,
      sourceOutcomeEventId: sourceSelfId,
      taskId: verificationTaskId,
      decisionBlockId: sourceTask.decisionBlockId,
      recordId: sourceTask.recordId,
      contentVersion: sourceTask.contentVersion,
      status: completedVerification ? "completed" : "in-progress",
      verificationEligibleAt: `${addDaysISO(todayISO(), -2)}T09:00:00.000Z`,
      verificationDueAt: `${addDaysISO(todayISO(), -1)}T08:00:00.000Z`,
      lastVerifiedAt: completedVerification ? verificationCompletedAt : undefined,
      verificationOutcome: completedVerification ? (retained ? "retained" : "decayed") : undefined,
      strategyVersion: "delayed-verification-v1",
      idempotencyKey: `stage7-verification:${index}`,
      createdAt: sourceCompletedAt,
      updatedAt: completedVerification ? verificationCompletedAt : stamp,
    });
  }

  await db.adaptiveQuizTurns.delete("stage6-preview-turn-1");
  await db.adaptiveQuizTurns.bulkPut(turns);
  await db.taskOutcomeEvents.bulkPut(outcomes);
  await db.adaptiveReviewTasks.bulkPut(verificationTasks);
  await db.delayedVerifications.bulkPut(verifications);
  await reviewCoachRepository.rebuildProjections();
};

export const isStage3PreviewRequest = (): boolean => {
  if (typeof window === "undefined") return false;
  if (isNativePlatform() || isDesktopPlatform()) return false;
  const host = window.location.hostname;
  return (host === "127.0.0.1" || host === "localhost")
    && new URLSearchParams(window.location.search).get("preview") === "stage3";
};

export const isJournalPerformancePreviewRequest = (): boolean => {
  if (typeof window === "undefined") return false;
  if (isNativePlatform() || isDesktopPlatform()) return false;
  const host = window.location.hostname;
  return (host === "127.0.0.1" || host === "localhost")
    && new URLSearchParams(window.location.search).get("preview") === "journal-performance";
};

export const isStage4PreviewRequest = (): boolean => {
  if (typeof window === "undefined") return false;
  if (isNativePlatform() || isDesktopPlatform()) return false;
  const host = window.location.hostname;
  return (host === "127.0.0.1" || host === "localhost")
    && new URLSearchParams(window.location.search).get("preview") === "stage4";
};

export const isStage5PreviewRequest = (): boolean => {
  if (typeof window === "undefined") return false;
  if (isNativePlatform() || isDesktopPlatform()) return false;
  const host = window.location.hostname;
  return (host === "127.0.0.1" || host === "localhost")
    && new URLSearchParams(window.location.search).get("preview") === "stage5";
};

export const isStage6PreviewRequest = (): boolean => {
  if (typeof window === "undefined") return false;
  if (isNativePlatform() || isDesktopPlatform()) return false;
  const host = window.location.hostname;
  return (host === "127.0.0.1" || host === "localhost")
    && new URLSearchParams(window.location.search).get("preview") === "stage6";
};

export const isStage7PreviewRequest = (): boolean => {
  if (typeof window === "undefined") return false;
  if (isNativePlatform() || isDesktopPlatform()) return false;
  const host = window.location.hostname;
  return (host === "127.0.0.1" || host === "localhost")
    && new URLSearchParams(window.location.search).get("preview") === "stage7";
};

export const isReviewCoachPreviewRequest = (): boolean => {
  if (typeof window === "undefined") return false;
  if (isNativePlatform() || isDesktopPlatform()) return false;
  const host = window.location.hostname;
  return (host === "127.0.0.1" || host === "localhost")
    && new URLSearchParams(window.location.search).get("preview") === "coach";
};
