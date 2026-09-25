import type { KnowledgeFailure } from "./uiError";

export type KnowledgeSyncStage = "discover" | "pull" | "prepare" | "copy" | "publish" | "confirm";
export interface KnowledgeSyncOptions {
  isCurrent?: () => boolean;
  onProgress?: (message: string) => void;
}
export interface KnowledgeSyncResult {
  status: "success" | "no-change" | "pending" | "needs-attention" | "error" | "skipped";
  stage: KnowledgeSyncStage;
  uploaded: number;
  downloaded: number;
  pending: number;
  unknown: number;
  blocked: number;
  conflicts: number;
  migrated: number;
  message: string;
  error?: KnowledgeFailure;
}
export const emptyKnowledgeSyncResult = (): KnowledgeSyncResult => ({ status: "no-change", stage: "discover", uploaded: 0, downloaded: 0, pending: 0, unknown: 0, blocked: 0, conflicts: 0, migrated: 0, message: "知识库：没有新变化。" });
