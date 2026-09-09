import { db } from "../../db/database";
import type { ReviewAnnotationDraft } from "./domain";

const MAX_ELEMENTS = 500;
const MAX_SERIALIZED_BYTES = 2 * 1024 * 1024;

const validateDraft = (draft: ReviewAnnotationDraft) => {
  if (!draft.recordId || !draft.reviewOccurrenceKey || draft.elements.length > MAX_ELEMENTS) {
    throw new Error("批注草稿无效或元素数量已达上限");
  }
  if (new Blob([JSON.stringify(draft)]).size > MAX_SERIALIZED_BYTES) {
    throw new Error("当前卡片的批注已达到 2 MiB 上限");
  }
};

export const reviewAnnotationRepository = {
  async getDraft(recordId: string, occurrenceKey: string) {
    return db.reviewAnnotationDrafts.where("[recordId+reviewOccurrenceKey]").equals([recordId, occurrenceKey]).first();
  },
  async openDraft(draft: ReviewAnnotationDraft) {
    return db.transaction("rw", db.reviewAnnotationDrafts, async () => {
      const existing = await this.getDraft(draft.recordId, draft.reviewOccurrenceKey);
      const opened = existing && !existing.pendingClear && existing.contentRevision === draft.contentRevision
        ? { ...existing, writeGeneration: existing.writeGeneration ?? 0 }
        : { ...draft, writeGeneration: existing && !existing.pendingClear ? (existing.writeGeneration ?? 0) + 1 : existing?.writeGeneration ?? 0, pendingClear: false };
      await db.reviewAnnotationDrafts.put(opened);
      return opened;
    });
  },
  async upsertDraft(draft: ReviewAnnotationDraft) {
    validateDraft(draft);
    return db.transaction("rw", db.reviewAnnotationDrafts, async () => {
      const existing = await this.getDraft(draft.recordId, draft.reviewOccurrenceKey);
      if (existing?.pendingClear || (existing?.writeGeneration ?? 0) !== (draft.writeGeneration ?? 0)) return false;
      await db.reviewAnnotationDrafts.put(draft);
      return true;
    });
  },
  async deleteDraft(recordId: string, occurrenceKey: string) {
    await this.clearAfterRating(recordId, occurrenceKey);
  },
  async clearAfterRating(recordId: string, occurrenceKey: string) {
    await db.transaction("rw", db.reviewAnnotationDrafts, async () => {
      const existing = await this.getDraft(recordId, occurrenceKey);
      await db.reviewAnnotationDrafts.put({
        ...(existing ?? { id: recordId + ":" + occurrenceKey, recordId, reviewOccurrenceKey: occurrenceKey, contentRevision: "rated", schemaVersion: 1 as const }),
        elements: [], history: [[]], historyCursor: 0, pendingClear: true,
        writeGeneration: (existing?.writeGeneration ?? 0) + 1,
        updatedAt: new Date().toISOString(),
      });
    });
  },
};
