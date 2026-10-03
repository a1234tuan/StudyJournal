import { ActionableError } from "../../lib/uiError";
import type { RecordBlock, RecordReviewDecisionBlockFeedbackInput } from "../../types";
import { db } from "../../db/database";
import { knowledgeHash } from "../knowledgeLibrary/canonical";
import { nowISO } from "../../lib/date";

import { isRestoreInProgress } from "../../services/restoreLockService";
import { markAutoBackupDirty } from "../../services/autoBackupService";
import { persistDecisionBlockFeedbackInTransaction, reviewCoachFormalTables } from "../reviewCoach/repository";
import type { DecisionBlockFeedback, AnalysisQueueItem } from "../reviewCoach/domain";
export const saveCardFeedback = async (record: RecordBlock, feedbacks: readonly RecordReviewDecisionBlockFeedbackInput[], scope: string, origin?: { id: string; title: string }) => {
  if (isRestoreInProgress()) throw new ActionableError("正在恢复数据。");
  const result = await db.transaction("rw", [db.blocks, db.recordReviewLogs, db.arrangedReviews, db.cloudSyncMutation, ...reviewCoachFormalTables(db)], async () => {
    if (isRestoreInProgress()) throw new ActionableError("正在恢复数据。");
    const current = await db.blocks.get(record.id);
    if (!current || current.deletedAt || current.updatedAt !== record.updatedAt) throw new ActionableError("日志内容已变化，请重新打开后分析。");
    if (origin) { const round = await db.arrangedReviews.get(origin.id); if (!round || round.deletedAt || !round.items.some(item => item.recordId === record.id)) throw new ActionableError("本轮已删除或日志不在本轮中。"); }
    const saved: DecisionBlockFeedback[] = []; let changed = false;
    for (const input of feedbacks.filter(item => item.comment.trim())) {
      const stamp = nowISO();
      const identity = knowledgeHash([scope, record.id, input.decisionBlockId, input.contentVersion, input.comment.trim(), input.includeInAnalysis]);
      const feedback: DecisionBlockFeedback = { id: "card-feedback-" + identity, createdAt: stamp, updatedAt: stamp, occurredAt: stamp, recordId: record.id, decisionBlockId: input.decisionBlockId, contentVersion: input.contentVersion, comment: input.comment.trim(), includeInAnalysis: input.includeInAnalysis, source: "manual", ...(origin ? { originRoundId: origin.id, originRoundTitle: origin.title } : {}), idempotencyKey: "card-feedback:" + identity };
      const queue: AnalysisQueueItem | undefined = input.includeInAnalysis ? { id: "card-queue-" + identity, createdAt: stamp, updatedAt: stamp, decisionBlockId: input.decisionBlockId, contentVersion: input.contentVersion, recordId: record.id, feedbackId: feedback.id, status: "eligible", eligibilityReason: "user-feedback" } : undefined;
      const result = await persistDecisionBlockFeedbackInTransaction(db, feedback, queue); saved.push(result.feedback); changed ||= result.created;
    }
    if (changed) { const mutation = await db.cloudSyncMutation.get("local"); await db.cloudSyncMutation.put({ id: "local", epoch: (mutation?.epoch ?? 0) + 1 }); }
    return saved;
  });
  await markAutoBackupDirty("card-feedback"); return result;
};
