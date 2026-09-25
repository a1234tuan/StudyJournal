export const KNOWLEDGE_PROTOCOL = 1 as const;
export const ROOT_NODE = "@root";
export const KNOWLEDGE_LIMITS = { title: 512, note: 16384, remark: 4096, order: 4096, commandBytes: 65536, writes: 20, resolution: 4 } as const;
export type KnowledgeOwner = "deviceGuest" | `account:${string}`;
export type KnowledgeKind = "workspace" | "node" | "reference";
export type KnowledgeUnit = "title" | "note" | "remark" | "position" | "archived" | "deleted";
export interface KnowledgePosition { parentNodeId: string; orderKey: string }
export type KnowledgeValue = string | boolean | KnowledgePosition;
export interface KnowledgeValueReference { revisionValueId: string }
export interface KnowledgeEntity {
  id: string;
  kind: KnowledgeKind;
  workspaceId: string;
  nodeId: string;
  recordId: string;
  units: Partial<Record<KnowledgeUnit, string>>;
}
export interface KnowledgeRevision {
  id: string;
  entityId: string;
  unit: KnowledgeUnit;
  value: KnowledgeValue | KnowledgeValueReference;
  parents: string[];
  commandId: string;
}
export interface KnowledgeCandidate {
  id: string;
  groupId: string;
  revisionId: string;
  consumedBy: string | null;
}
export interface KnowledgeGroup {
  id: string;
  generation: number;
  setToken: string;
  unresolvedCount: number;
  currentRevisionId: string;
}
export interface KnowledgeReceipt { id: string; hash: string; sequence: number }
export interface KnowledgeState {
  sequence: number;
  entities: Record<string, KnowledgeEntity>;
  revisions: Record<string, KnowledgeRevision>;
  candidates: Record<string, KnowledgeCandidate>;
  groups: Record<string, KnowledgeGroup>;
  receipts: Record<string, KnowledgeReceipt>;
}
export interface KnowledgeContext { libraryId: string; ownerScope: KnowledgeOwner; dataGeneration: number; sessionGeneration?: number }
export interface KnowledgeCommand {
  protocolVersion: 1;
  id: string;
  libraryId: string;
  operation: "create" | "edit" | "delete" | "restore" | "resolve";
  entity: Omit<KnowledgeEntity, "units">;
  expected: Partial<Record<KnowledgeUnit, string | null>>;
  changes: Partial<Record<KnowledgeUnit, KnowledgeValue>>;
  restoreToken?: string;
  resolution?: { unit: KnowledgeUnit; setToken: string; generation: number; candidates: string[] };
}
export interface KnowledgeLibrary {
  id: string;
  ownerScope: KnowledgeOwner;
  title: string;
  cloudLibraryId: string | null;
  detached: boolean;
  restoreSessionId: string | null;
  archiveLibraryId: string | null;
}
export interface KnowledgeImportSession {
  id: string; sourceLibraryId: string; sourceGeneration: number; sourceHash: string; next: number; commands: KnowledgeCommand[];
}
export interface KnowledgeImportProgress {
  libraryId: string; id: string; sourceLibraryId: string; sourceGeneration: number; sourceHash: string;
  next: number; total: number; status: "active" | "completed";
}
export interface KnowledgeImportStep { libraryId: string; sessionId: string; ordinal: number; command: KnowledgeCommand }
export interface KnowledgeSyncBinding {
  ownerScope: KnowledgeOwner;
  localLibraryId: string | null;
  cloudLibraryId: string | null;
  policyVersion: 1;
  generation: number;
  leaseId?: string;
  leaseUntil?: number;
}
export interface KnowledgeLibraryMigration {
  ownerScope: KnowledgeOwner;
  sourceLibraryId: string;
  targetLibraryId: string;
  cloudLibraryId: string;
  sessionId: string;
  sourceHash: string;
  sourceGeneration: number;
  sourceEpoch: number;
  phase: "local-copying" | "awaiting-cloud" | "confirmed";
}
export interface KnowledgeSyncFailure {
  code: "invalid" | "receipt" | "cycle"; cursor: number; sequence: number; fingerprint: string; attempts: number; recoveryLibraryId?: string;
}
export interface KnowledgeSyncState {
  failure?: KnowledgeSyncFailure;
  importSessions?: Record<string, KnowledgeImportSession>;
  libraryId: string;
  dataGeneration: number;
  epoch: number;
  dirtyGeneration: number;
  cursor: number;
}
export interface KnowledgePending { libraryId: string; id: string; command: KnowledgeCommand; hash: string; status: "pending" | "unknown" }
export interface KnowledgeDraft { libraryId: string; id: string; entityId: string; unit: KnowledgeUnit; text: string; expectedRevision: string | null; dataGeneration: number }
export interface KnowledgeBackupScope {
  autoBackupState?: import("../../types").AutoBackupSettings;
  ownerScope: KnowledgeOwner;
  scopeEpoch: number;
  membershipGeneration: number;
  destinationId: string | null;
  consented: boolean;
  capturedGenerations: Record<string, number>;
}
export class KnowledgeError extends Error {
  constructor(readonly code: "invalid" | "stale" | "budget" | "cycle" | "scope" | "missing" | "receipt" | "protected" | "corrupt" | "busy" | "migration" | "cancelled" | "timeout", message: string) {
    super(message);
    this.name = "KnowledgeError";
  }
}
export const emptyKnowledgeState = (): KnowledgeState => ({ sequence: 0, entities: {}, revisions: {}, candidates: {}, groups: {}, receipts: {} });
