import { knowledgeHash } from "./canonical";
import { KnowledgeError, type KnowledgeBackupScope, type KnowledgeLibrary, type KnowledgeOwner } from "./domain";

export interface KnowledgeRegistry { protocolVersion: 1; cloudLibraryId: string; registrationRevision: string }
export const registerDefaultLibrary = (existing: KnowledgeRegistry | null, proposedId: string, requestId: string): KnowledgeRegistry => {
  if (existing) {
    if (existing.protocolVersion !== 1 || !existing.cloudLibraryId || !existing.registrationRevision) throw new KnowledgeError("invalid", "账号知识库版本不兼容");
    return existing;
  }
  if (!proposedId || !requestId) throw new KnowledgeError("invalid", "注册知识库缺少稳定身份");
  return { protocolVersion: 1, cloudLibraryId: proposedId, registrationRevision: requestId };
};
export interface KnowledgeBackupToken {
  ownerScope: KnowledgeOwner;
  scopeEpoch: number;
  membershipGeneration: number;
  selectedLibraryIds: string[];
  capturedDirtyGenerations: Record<string, number>;
  destinationId: string;
}
export const captureKnowledgeBackupScope = (scope: KnowledgeBackupScope, libraries: KnowledgeLibrary[], dirty: Record<string, number>): KnowledgeBackupToken => {
  if (!scope.consented || !scope.destinationId) throw new KnowledgeError("scope", "请先确认当前身份的备份范围与目的地；普通日志仍是设备本地集合");
  const selectedLibraryIds = libraries.filter(library => library.ownerScope === scope.ownerScope).map(library => library.id).sort();
  const capturedDirtyGenerations: Record<string, number> = {};
  for (const id of selectedLibraryIds) {
    if (!Number.isSafeInteger(dirty[id]) || dirty[id] < 0) throw new KnowledgeError("invalid", "备份库代际缺失");
    capturedDirtyGenerations[id] = dirty[id];
  }
  return { ownerScope: scope.ownerScope, scopeEpoch: scope.scopeEpoch, membershipGeneration: scope.membershipGeneration, selectedLibraryIds, capturedDirtyGenerations, destinationId: scope.destinationId };
};
export const acknowledgeKnowledgeBackup = (scope: KnowledgeBackupScope, token: KnowledgeBackupToken, verifiedDestinationId: string): KnowledgeBackupScope => {
  if (scope.ownerScope !== token.ownerScope || token.destinationId !== verifiedDestinationId || scope.destinationId !== token.destinationId || !scope.consented) throw new KnowledgeError("scope", "备份任务身份或授权目的地已变化");
  const capturedGenerations = { ...scope.capturedGenerations };
  for (const id of token.selectedLibraryIds) capturedGenerations[id] = Math.max(capturedGenerations[id] ?? 0, token.capturedDirtyGenerations[id]);
  return { ...scope, capturedGenerations };
};
export const detachedLibraryIdentity = (restoreSessionId: string, archiveLibraryId: string): string => "restore-" + knowledgeHash({ restoreSessionId, archiveLibraryId });
export const emptyDetachedLibrary = (restoreSessionId: string, ownerScope: KnowledgeOwner): KnowledgeLibrary => ({
  id: detachedLibraryIdentity(restoreSessionId, "@empty-envelope"), ownerScope, title: "空知识库恢复副本", cloudLibraryId: null, detached: true, restoreSessionId, archiveLibraryId: "@empty-envelope",
});
