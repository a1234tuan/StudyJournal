import type { RecordReviewUndoToken } from "../../types";
import type { ReviewSessionProgress } from "../../lib/tabNavigation";

export interface DecisionBlockFeedbackDraft {
  comment: string;
  includeInAnalysis: boolean;
}

export interface ReviewUndoEntry {
  token: RecordReviewUndoToken;
  queueIds: string[];
  currentRecordId: string;
  blockFeedbackDrafts: Record<string, DecisionBlockFeedbackDraft>;
  dailyLimitIds: string[];
  showAllDue: boolean;
  reviewProgress: ReviewSessionProgress;
  feedbackDraftKey?: string;
}

export interface ReviewSessionRuntimeState {
  day: string;
  ratedRecordIds: string[];
  undoHistory: ReviewUndoEntry[];
  feedbackDrafts?: Record<string, Record<string, DecisionBlockFeedbackDraft>>;
  showAllDue?: boolean;
  selectedQueueIds?: string[];
}

export const createReviewSessionRuntime = (day: string): ReviewSessionRuntimeState => ({
  day,
  ratedRecordIds: [],
  undoHistory: [],
});
