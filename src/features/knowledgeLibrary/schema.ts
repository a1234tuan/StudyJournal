import type { KnowledgeCandidate, KnowledgeCommand, KnowledgeDraft, KnowledgeEntity, KnowledgeGroup, KnowledgeReceipt, KnowledgeRevision, KnowledgeState } from "./domain";

export const KNOWLEDGE_SCHEMA_VERSION = 26;
export const KNOWLEDGE_SCHEMA_25_STORES = {
  knowledgeLibraries: "id, ownerScope, [ownerScope+cloudLibraryId], [ownerScope+restoreSessionId]",
  knowledgeWorkspaces: "[libraryId+id], libraryId",
  knowledgeNodes: "[libraryId+id], libraryId, [libraryId+workspaceId]",
  knowledgeReferences: "[libraryId+id], libraryId, [libraryId+nodeId], [libraryId+recordId]",
  knowledgeRevisions: "[libraryId+id], libraryId, [libraryId+entityId]",
  knowledgeConflicts: "[libraryId+id], libraryId, [libraryId+kind]",
  knowledgeRemoteEntities: "[libraryId+id], libraryId",
  knowledgeCommands: "[libraryId+id], libraryId, [libraryId+status]",
  knowledgeSyncState: "libraryId",
  knowledgeDrafts: "[libraryId+id], libraryId",
  knowledgeBackupScopes: "ownerScope",
} as const;
export const KNOWLEDGE_SCHEMA_26_STORES = {
  ...KNOWLEDGE_SCHEMA_25_STORES,
  knowledgeImportSessions: "[libraryId+id], libraryId",
  knowledgeImportSteps: "[libraryId+sessionId+ordinal], libraryId, [libraryId+sessionId]",
} as const;
export type StoredKnowledgeEntity = KnowledgeEntity & { libraryId: string };
export type StoredKnowledgeRevision = KnowledgeRevision & { libraryId: string };
export type StoredKnowledgeDraft = KnowledgeDraft;
export type StoredKnowledgeConflict = { libraryId: string; id: string } & (
  { kind: "candidateProjection"; value: KnowledgeCandidate } |
  { kind: "groupState"; value: KnowledgeGroup } |
  { kind: "receipt"; value: KnowledgeReceipt }
);
export interface StoredKnowledgeRemote { libraryId: string; id: string; collection: keyof Omit<KnowledgeState, "sequence">; value: unknown }
export interface StoredKnowledgeCommand { libraryId: string; id: string; command: KnowledgeCommand; hash: string; status: "pending" | "unknown" | "confirmed" | "blocked"; blockedReason?: "stale" | "missing" | "invalid"; recoveryLibraryId?: string; localSequence: number }
