import { isISODate } from "../../lib/date";
import { isReviewDueOn } from "../../lib/reviewScheduler";
import type { RecordBlock, RecordReviewState } from "../../types";

export const REVIEW_CHECKPOINT_KEY = "studyjournal-ordinary-review-checkpoint-v1";

export interface ReviewCheckpoint {
  version: 1;
  day: string;
  recordIds: string[];
  currentRecordId?: string;
  selected: boolean;
}

export const readReviewCheckpoint = (day: string): ReviewCheckpoint | undefined => {
  const raw = localStorage.getItem(REVIEW_CHECKPOINT_KEY);
  if (!raw) return;
  try {
    const value = JSON.parse(raw) as ReviewCheckpoint;
    if (value?.version !== 1 || value.day !== day || !isISODate(value.day)
      || !Array.isArray(value.recordIds) || !value.recordIds.every(id => typeof id === "string" && id.length > 0)
      || new Set(value.recordIds).size !== value.recordIds.length || typeof value.selected !== "boolean"
      || (value.currentRecordId !== undefined && !value.recordIds.includes(value.currentRecordId))) return;
    return value;
  } catch {
    return;
  }
};

export const writeReviewCheckpoint = (checkpoint: ReviewCheckpoint): void => {
  localStorage.setItem(REVIEW_CHECKPOINT_KEY, JSON.stringify(checkpoint));
};

export const clearReviewCheckpoint = (): void => localStorage.removeItem(REVIEW_CHECKPOINT_KEY);

export const reconcileReviewCheckpoint = (
  checkpoint: ReviewCheckpoint,
  records: readonly RecordBlock[],
  reviews: readonly RecordReviewState[],
) => {
  const liveRecords = new Set(records.filter(record => !record.deletedAt).map(record => record.id));
  const states = new Map(reviews.map(review => [review.recordId, review]));
  const recordIds = checkpoint.recordIds.filter(id => {
    const review = states.get(id);
    return liveRecords.has(id) && review && !review.deletedAt && review.status === "active"
      && (review.lastReviewDate === checkpoint.day || isReviewDueOn(review, checkpoint.day));
  });
  const ratedRecordIds = recordIds.filter(id => states.get(id)?.lastReviewDate === checkpoint.day);
  const completed = new Set(ratedRecordIds);
  const queueIds = recordIds.filter(id => !completed.has(id));
  return {
    recordIds,
    ratedRecordIds,
    queueIds,
    currentRecordId: queueIds[0],
    progress: { total: recordIds.length, completed: ratedRecordIds.length },
  };
};
