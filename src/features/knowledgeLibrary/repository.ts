import type { StudyJournalDatabase } from "../../db/database";
import { knowledgeHash, revisionIdentity } from "./canonical";
import { emptyKnowledgeState, KnowledgeError, type KnowledgeBackupScope, type KnowledgeCommand, type KnowledgeContext, type KnowledgeDraft, type KnowledgeEntity, type KnowledgeLibrary, type KnowledgeOwner, type KnowledgeState, type KnowledgeSyncState, type KnowledgeUnit } from "./domain";
import { applyKnowledgeCommand, knowledgeWrites, revisionValue } from "./protocol";
import { KNOWLEDGE_SCHEMA_25_STORES, type StoredKnowledgeConflict } from "./schema";

export const knowledgeTables = (database: StudyJournalDatabase) => Object.keys(KNOWLEDGE_SCHEMA_25_STORES).map(name => database.table(name));
const withoutLibrary = <Value extends { libraryId: string }>(row: Value): Omit<Value, "libraryId"> => { const { libraryId: _libraryId, ...value } = row; return value; };
export const knowledgeEntityTable = (database: StudyJournalDatabase, kind: KnowledgeEntity["kind"]) => kind === "workspace" ? database.knowledgeWorkspaces : kind === "node" ? database.knowledgeNodes : database.knowledgeReferences;
export const readKnowledgeState = async (database: StudyJournalDatabase, libraryId: string): Promise<KnowledgeState> => {
  const [workspaces, nodes, references, revisions, conflicts, sync] = await Promise.all([database.knowledgeWorkspaces.where("libraryId").equals(libraryId).toArray(), database.knowledgeNodes.where("libraryId").equals(libraryId).toArray(), database.knowledgeReferences.where("libraryId").equals(libraryId).toArray(), database.knowledgeRevisions.where("libraryId").equals(libraryId).toArray(), database.knowledgeConflicts.where("libraryId").equals(libraryId).toArray(), database.knowledgeSyncState.get(libraryId)]);
  const state = emptyKnowledgeState();
  state.sequence = sync?.epoch ?? 0;
  for (const entity of [...workspaces, ...nodes, ...references]) state.entities[entity.id] = withoutLibrary(entity);
  for (const revision of revisions) state.revisions[revision.id] = withoutLibrary(revision);
  for (const conflict of conflicts) {
    if (conflict.kind === "candidateProjection") state.candidates[conflict.value.id] = conflict.value;
    else if (conflict.kind === "groupState") state.groups[conflict.value.id] = conflict.value;
    else state.receipts[conflict.value.id] = conflict.value;
  }
  return state;
};
export const writeKnowledgeStateDelta = async (database: StudyJournalDatabase, libraryId: string, before: KnowledgeState, after: KnowledgeState): Promise<void> => {
  for (const entity of Object.values(before.entities)) {
    if (!after.entities[entity.id]) {
      await knowledgeEntityTable(database, entity.kind).delete([libraryId, entity.id]);
      await database.knowledgeRevisions.where("[libraryId+entityId]").equals([libraryId, entity.id]).delete();
    }
  }
  for (const collection of ["groups", "candidates", "receipts"] as const) {
    for (const id of Object.keys(before[collection])) {
      if (!Object.hasOwn(after[collection], id)) await database.knowledgeConflicts.delete([libraryId, collection === "receipts" ? "receipt:" + id : id]);
    }
  }
  for (const write of knowledgeWrites(before, after)) {
    if (write.collection === "entities") {
      const entity = after.entities[write.id];
      await knowledgeEntityTable(database, entity.kind).put({ ...entity, libraryId });
    } else if (write.collection === "revisions") {
      const existing = await database.knowledgeRevisions.get([libraryId, write.id]);
      if (existing && knowledgeHash(withoutLibrary(existing)) !== knowledgeHash(write.value)) throw new KnowledgeError("invalid", "不可变知识版本不能覆盖");
      await database.knowledgeRevisions.put({ ...after.revisions[write.id], libraryId });
    } else {
      const conflict: StoredKnowledgeConflict = write.collection === "groups" ? { libraryId, id: write.id, kind: "groupState", value: after.groups[write.id] } : write.collection === "candidates" ? { libraryId, id: write.id, kind: "candidateProjection", value: after.candidates[write.id] } : { libraryId, id: "receipt:" + write.id, kind: "receipt", value: after.receipts[write.id] };
      await database.knowledgeConflicts.put(conflict);
    }
  }
};
export const initialKnowledgeScope = (ownerScope: KnowledgeOwner): KnowledgeBackupScope => ({ ownerScope, scopeEpoch: 0, membershipGeneration: 0, destinationId: null, consented: false, capturedGenerations: {} });
export class KnowledgeRepository {
  constructor(readonly database: StudyJournalDatabase, readonly currentOwner: () => KnowledgeOwner, readonly contextGeneration: () => number = () => 0) {}

  async listLibraries(): Promise<KnowledgeLibrary[]> {
    const owner = this.currentOwner();
    const libraries = await this.database.knowledgeLibraries.where("ownerScope").equals(owner).toArray();
    if (owner !== this.currentOwner()) throw new KnowledgeError("scope", "账号已变化");
    return libraries;
  }

  async createLibrary(title: string, id: string = crypto.randomUUID(), detached = false): Promise<KnowledgeLibrary> {
    const ownerScope = this.currentOwner();
    const library: KnowledgeLibrary = { id, ownerScope, title, detached, cloudLibraryId: null, restoreSessionId: null, archiveLibraryId: null };
    if (!title.trim() || new TextEncoder().encode(title).byteLength > 512 || !/^[A-Za-z0-9_-]{1,180}$/.test(id)) throw new KnowledgeError("invalid", "本机库名称或身份无效");
    await this.database.transaction("rw", knowledgeTables(this.database), async () => {
      if (ownerScope !== this.currentOwner()) throw new KnowledgeError("scope", "创建期间账号已变化");
      const existing = await this.database.knowledgeLibraries.get(id);
      if (existing) {
        if (knowledgeHash(existing) !== knowledgeHash(library)) throw new KnowledgeError("invalid", "本机库身份已占用");
        return;
      }
      const scope = await this.database.knowledgeBackupScopes.get(ownerScope) ?? initialKnowledgeScope(ownerScope);
      await this.database.knowledgeLibraries.add(library);
      await this.database.knowledgeSyncState.add({ libraryId: id, dataGeneration: 0, epoch: 0, dirtyGeneration: 1, cursor: 0 });
      await this.database.knowledgeBackupScopes.put({ ...scope, membershipGeneration: scope.membershipGeneration + 1 });
    });
    return library;
  }

  async assertContext(context: KnowledgeContext): Promise<{ library: KnowledgeLibrary; sync: KnowledgeSyncState }> {
    if (context.ownerScope !== this.currentOwner() || (context.sessionGeneration !== undefined && context.sessionGeneration !== this.contextGeneration())) throw new KnowledgeError("scope", "账号已变化，请重新打开知识库");
    const library = await this.database.knowledgeLibraries.get(context.libraryId);
    const sync = await this.database.knowledgeSyncState.get(context.libraryId);
    if (!library || !sync || library.ownerScope !== context.ownerScope) throw new KnowledgeError("scope", "当前身份不能访问此知识库");
    if (sync.dataGeneration !== context.dataGeneration) throw new KnowledgeError("stale", "知识库数据代际已变化，请重新打开");
    return { library, sync };
  }

  async open(libraryId: string): Promise<{ context: KnowledgeContext; library: KnowledgeLibrary; state: KnowledgeState }> {
    const ownerScope = this.currentOwner();
    return this.database.transaction("r", knowledgeTables(this.database), async () => {
      const sync = await this.database.knowledgeSyncState.get(libraryId);
      const context = { libraryId, ownerScope, dataGeneration: sync?.dataGeneration ?? -1, sessionGeneration: this.contextGeneration() };
      const { library } = await this.assertContext(context);
      const state = await readKnowledgeState(this.database, libraryId);
      return { context, library, state };
    });
  }

  async execute(context: KnowledgeContext, command: KnowledgeCommand, clearDraftId?: string, importSessionId?: string): Promise<KnowledgeState> {
    return this.database.transaction("rw", knowledgeTables(this.database), async () => {
      const { library, sync } = await this.assertContext(context);
      if (command.libraryId !== (library.cloudLibraryId ?? library.id)) throw new KnowledgeError("scope", "命令属于其他知识库");
      const before = await readKnowledgeState(this.database, library.id);
      const importSession = importSessionId ? sync.importSessions?.[importSessionId] : undefined;
      if (importSessionId && (!importSession || knowledgeHash(importSession.commands[importSession.next]) !== knowledgeHash(command))) throw new KnowledgeError("stale", "另存会话进度或命令已变化");
      const after = applyKnowledgeCommand(before, command, !importSessionId);
      if (after !== before) {
        await writeKnowledgeStateDelta(this.database, library.id, before, after);
        await this.database.knowledgeCommands.add({ libraryId: library.id, id: command.id, command, hash: knowledgeHash(command), status: "pending", localSequence: after.sequence });
        await this.database.knowledgeSyncState.put({ ...sync, epoch: after.sequence, dirtyGeneration: sync.dirtyGeneration + 1 });
      }
      if (importSessionId && importSession) {
        const updated = await this.database.knowledgeSyncState.get(library.id);
        await this.database.knowledgeSyncState.put({ ...updated!, importSessions: { ...updated!.importSessions, [importSessionId]: { ...importSession, next: importSession.next + 1 } } });
      }
      if (clearDraftId) await this.database.knowledgeDrafts.delete([library.id, clearDraftId]);
      return after;
    });
  }

  async saveDraft(context: KnowledgeContext, draft: KnowledgeDraft): Promise<void> {
    await this.database.transaction("rw", knowledgeTables(this.database), async () => {
      await this.assertContext(context);
      if (draft.libraryId !== context.libraryId || draft.dataGeneration !== context.dataGeneration) throw new KnowledgeError("scope", "草稿身份已变化");
      const existing = await this.database.knowledgeDrafts.get([context.libraryId, draft.id]);
      if (existing && (existing.entityId !== draft.entityId || existing.unit !== draft.unit || existing.expectedRevision !== draft.expectedRevision)) throw new KnowledgeError("stale", "草稿原始编辑基线不可重写");
      await this.database.knowledgeDrafts.put(draft);
    });
  }

  async invalidateOwner(ownerScope: KnowledgeOwner): Promise<void> {
    await this.database.transaction("rw", knowledgeTables(this.database), async () => {
      const libraries = await this.database.knowledgeLibraries.where("ownerScope").equals(ownerScope).toArray();
      for (const library of libraries) {
        const state = await this.database.knowledgeSyncState.get(library.id);
        if (state) await this.database.knowledgeSyncState.put({ ...state, dataGeneration: state.dataGeneration + 1 });
      }
      const scope = await this.database.knowledgeBackupScopes.get(ownerScope) ?? initialKnowledgeScope(ownerScope);
      await this.database.knowledgeBackupScopes.put({ ...scope, scopeEpoch: scope.scopeEpoch + 1 });
    });
  }

  async acknowledgeBlocked(context: KnowledgeContext, id: string, hash: string): Promise<void> {
    await this.database.transaction("rw", knowledgeTables(this.database), async () => {
      const { sync } = await this.assertContext(context);
      const entry = await this.database.knowledgeCommands.get([context.libraryId, id]);
      if (!entry || entry.status !== "blocked" || entry.hash !== hash || !entry.recoveryLibraryId || !await this.database.knowledgeLibraries.get(entry.recoveryLibraryId)) throw new KnowledgeError("stale", "保留副本或待确认操作已变化");
      await this.database.knowledgeCommands.delete([context.libraryId, id]);
      await this.database.knowledgeSyncState.put({ ...sync, dirtyGeneration: sync.dirtyGeneration + 1 });
    });
  }

  async undo(context: KnowledgeContext, command: KnowledgeCommand, unit: KnowledgeUnit, undoCommandId: string): Promise<KnowledgeState> {
    const opened = await this.open(context.libraryId);
    const entity = opened.state.entities[command.entity.id];
    const previousId = command.expected[unit];
    if (!entity || entity.units[unit] !== revisionIdentity(command.id, unit) || !previousId || !opened.state.revisions[previousId] || unit === "deleted") throw new KnowledgeError("stale", "内容已变化或需显式恢复，无法撤销");
    return this.execute(context, { protocolVersion: 1, id: undoCommandId, libraryId: command.libraryId, operation: "edit", entity: command.entity, expected: { [unit]: entity.units[unit] }, changes: { [unit]: revisionValue(opened.state, previousId)! } });
  }
}
