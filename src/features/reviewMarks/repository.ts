import { db, type StudyJournalDatabase } from "../../db/database";
import { newId } from "../../lib/entity";
import { nowISO } from "../../lib/date";
import { ActionableError } from "../../lib/uiError";
import { isRestoreInProgress } from "../../services/restoreLockService";
import { markAutoBackupDirty } from "../../services/autoBackupService";
import { projectReviewMarks, validateReviewMarkEvents, type ReviewMarkEvent, type ReviewMarkValue } from "./domain";

export class ReviewMarkRepository {
  constructor(private database: StudyJournalDatabase = db) {}
  async write(recordId: string, revision: string, value: ReviewMarkValue | null, markId = newId(), expectedParents: readonly string[] = [], operationId = newId()): Promise<ReviewMarkEvent> {
    const writable = () => { if (isRestoreInProgress()) throw new ActionableError("正在恢复数据，请稍后再试。"); };
    writable();
    const event = await this.database.transaction("rw", [this.database.blocks, this.database.reviewMarkEvents, this.database.cloudSyncMutation], async () => {
      writable();
      const record = await this.database.blocks.get(recordId);
      if (!record || record.type !== "record" || record.deletedAt || record.updatedAt !== revision) throw new ActionableError("日志内容已变化，请刷新后重新标记。");
      const previous = await this.database.reviewMarkEvents.get(operationId);
      if (previous) {
        if (previous.recordId !== recordId || previous.markId !== markId || JSON.stringify(previous.value) !== JSON.stringify(value) || JSON.stringify([...previous.parents].sort()) !== JSON.stringify([...expectedParents].sort())) throw new ActionableError("印记操作身份不一致。");
        return previous;
      }
      const events = await this.database.reviewMarkEvents.where("recordId").equals(recordId).toArray();
      const current = projectReviewMarks(events).find(mark => mark.markId === markId);
      const parents = current?.heads.map(head => head.id).sort() ?? [];
      if (JSON.stringify(parents) !== JSON.stringify([...expectedParents].sort())) throw new ActionableError("此印记已在其他操作中变化，请重新确认。");
      if (!current && value === null) throw new ActionableError("印记不存在。");
      const stamp = nowISO();
      const next: ReviewMarkEvent = { id: operationId, recordId, markId, parents, value, createdAt: stamp, updatedAt: stamp };
      validateReviewMarkEvents([...events, next]);
      await this.database.reviewMarkEvents.add(next);
      const mutation = await this.database.cloudSyncMutation.get("local");
      await this.database.cloudSyncMutation.put({ id: "local", epoch: (mutation?.epoch ?? 0) + 1 });
      return next;
    });
    await markAutoBackupDirty("review-mark");
    return event;
  }
}
export const reviewMarkRepository = new ReviewMarkRepository();
