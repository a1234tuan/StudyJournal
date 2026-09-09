export type ReviewAnnotationTool = "pen" | "highlighter" | "eraser" | "line" | "arrow" | "rectangle" | "ellipse" | "diamond" | "text" | "input" | "select";

export interface ReviewAnnotationPoint {
  x: number;
  y: number;
}

export interface ReviewAnnotationElement {
  id: string;
  kind: ReviewAnnotationTool;
  points: ReviewAnnotationPoint[];
  anchorIndex: number;
  anchorFingerprint?: string;
  color: string;
  width: number;
  opacity: number;
  value?: string;
  options?: string[];
  createdAt: string;
  updatedAt: string;
}

export interface ReviewAnnotationDraft {
  id: string;
  recordId: string;
  reviewOccurrenceKey: string;
  contentRevision: string;
  schemaVersion: 1;
  elements: ReviewAnnotationElement[];
  history: ReviewAnnotationElement[][];
  historyCursor: number;
  pendingClear?: boolean;
  writeGeneration?: number;
  updatedAt: string;
}

export const reviewOccurrenceKey = (review?: { lastReviewedAt?: string; nextReviewDate?: string; totalReviews: number }): string =>
  `${review?.lastReviewedAt ?? "never"}|${review?.nextReviewDate ?? "none"}|${review?.totalReviews ?? 0}`;
