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
  async upsertDraft(draft: ReviewAnnotationDraft) {
    validateDraft(draft);
    const existing = await this.getDraft(draft.recordId, draft.reviewOccurrenceKey);
    // A stale pendingClear row (app closed before its 750ms delete) must not
    // block future annotations; only an empty draft is suppressed.
    if (existing?.pendingClear && draft.elements.length === 0) return;
    await db.reviewAnnotationDrafts.put(draft);
  },
  async deleteDraft(recordId: string, occurrenceKey: string) {
    await db.reviewAnnotationDrafts.where("[recordId+reviewOccurrenceKey]").equals([recordId, occurrenceKey]).delete();
  },
  async clearAfterRating(recordId: string, occurrenceKey: string) {
    const existing = await this.getDraft(recordId, occurrenceKey);
    const now = new Date().toISOString();
    await db.reviewAnnotationDrafts.put(existing
      ? { ...existing, elements: [], history: [[]], historyCursor: 0, pendingClear: true, updatedAt: now }
      : { id: `${recordId}:${occurrenceKey}`, recordId, reviewOccurrenceKey: occurrenceKey, contentRevision: "rated", schemaVersion: 1, elements: [], history: [[]], historyCursor: 0, pendingClear: true, updatedAt: now });
    globalThis.setTimeout(() => { void this.deleteDraft(recordId, occurrenceKey); }, 750);
  },
};
