import { ActionableError } from "../../lib/uiError";
import { liveQuery } from "dexie";
import { useEffect, useState } from "react";
import { db, type StudyJournalDatabase } from "../../db/database";
import { newId } from "../../lib/entity";
import { nowISO } from "../../lib/date";
import { markAutoBackupDirty } from "../../services/autoBackupService";
import { isRestoreInProgress } from "../../services/restoreLockService";
import type { RecordReviewRating } from "../../types";
import { reviewEventHeads, type ArrangedReview, type ArrangedReviewEvent, type ArrangedReviewItem } from "./domain";

export class ArrangedReviewRepository {
  constructor(private database: StudyJournalDatabase = db) {}
  private async changed() {
    const state = await this.database.cloudSyncMutation.get("local");
    await this.database.cloudSyncMutation.put({ id: "local", epoch: (state?.epoch ?? 0) + 1 });
  }
  private assertWritable() { if (isRestoreInProgress()) throw new ActionableError("正在恢复数据，请稍后再试。"); }
  async create(title: string, items: readonly ArrangedReviewItem[], id = newId(), assertContext: () => void = () => undefined) {
    this.assertWritable();
    const round = await this.database.transaction("rw", [this.database.arrangedReviews, this.database.blocks, this.database.cloudSyncMutation], async () => {
      this.assertWritable();
      assertContext();
      const previous = await this.database.arrangedReviews.get(id);
      if (previous) { if (previous.deletedAt) throw new ActionableError("本轮已删除。"); return previous; }
      const unique = [...new Map(items.map(item => [item.recordId, item])).values()];
      if (!unique.length) throw new ActionableError("请先选择日志。");
      for (const item of unique) { const record = await this.database.blocks.get(item.recordId); if (!record || record.deletedAt || record.type !== "record") throw new ActionableError("所选日志已发生变化，请重新选择。"); }
      const stamp = nowISO();
      const created: ArrangedReview = { id, title: title.trim() || "已安排的复习", items: unique, createdAt: stamp, updatedAt: stamp };
      assertContext();
      await this.database.arrangedReviews.add(created); await this.changed(); return created;
    });
    await markAutoBackupDirty("arranged-review-create"); return round;
  }
  async rate(roundId: string, recordId: string, rating: RecordReviewRating | null, contentRevision: string, expectedParents: readonly string[], operationId = newId()) {
    this.assertWritable();
    const result = await this.database.transaction("rw", [this.database.arrangedReviews, this.database.arrangedReviewEvents, this.database.blocks, this.database.cloudSyncMutation], async () => {
      this.assertWritable();
      const existing = await this.database.arrangedReviewEvents.get(operationId);
      if (existing) { if (existing.roundId !== roundId || existing.recordId !== recordId || existing.rating !== rating) throw new ActionableError("重复操作内容不一致。"); return existing; }
      const round = await this.database.arrangedReviews.get(roundId);
      if (!round || round.deletedAt || round.endedAt || !round.items.some(item => item.recordId === recordId)) throw new ActionableError("本轮已结束或删除，请返回看板。");
      const record = await this.database.blocks.get(recordId);
      if (!record || record.deletedAt || record.updatedAt !== contentRevision) throw new ActionableError("日志内容已变化，请重新打开后评价。");
      const parents = reviewEventHeads(await this.database.arrangedReviewEvents.where("roundId").equals(roundId).toArray(), roundId, recordId).map(event => event.id).sort();
      if (JSON.stringify(parents) !== JSON.stringify([...expectedParents].sort())) throw new ActionableError("本条评价已变化，请返回看板确认。");
      const stamp = nowISO();
      const event: ArrangedReviewEvent = { id: operationId, roundId, recordId, rating, parents, contentRevision, createdAt: stamp, updatedAt: stamp };
      await this.database.arrangedReviewEvents.add(event); await this.changed(); return event;
    });
    await markAutoBackupDirty("arranged-review-rate"); return result;
  }
  async close(round: ArrangedReview, remove = false) {
    this.assertWritable();
    await this.database.transaction("rw", [this.database.arrangedReviews, this.database.arrangedReviewDrafts, this.database.cloudSyncMutation], async () => {
      this.assertWritable();
      const current = await this.database.arrangedReviews.get(round.id);
      if (!current || current.deletedAt) return;
      if (current.updatedAt !== round.updatedAt) throw new ActionableError("本轮已变化，请刷新后重试。");
      const stamp = nowISO();
      await this.database.arrangedReviews.put({ ...current, ...(remove ? { deletedAt: stamp } : { endedAt: stamp }), updatedAt: stamp });
      if (remove) await this.database.arrangedReviewDrafts.filter(draft => draft.id.startsWith(round.id + ":")).delete();
      await this.changed();
    });
    await markAutoBackupDirty("arranged-review-close");
  }
}
export const arrangedReviewRepository = new ArrangedReviewRepository();
export const useArrangedReviews = () => {
  const [data, setData] = useState<{ rounds: ArrangedReview[]; events: ArrangedReviewEvent[]; error?: string }>({ rounds: [], events: [] });
  useEffect(() => { const subscription = liveQuery(async () => ({ rounds: await db.arrangedReviews.toArray(), events: await db.arrangedReviewEvents.toArray() })).subscribe({ next: setData, error: error => setData(current => ({ ...current, error: String(error) })) }); return () => subscription.unsubscribe(); }, []);
  return data;
};
