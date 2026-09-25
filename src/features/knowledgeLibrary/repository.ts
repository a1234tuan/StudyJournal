import { createKnowledgeEntity } from "./commands";
import type { StudyJournalDatabase } from "../../db/database";
import { knowledgeHash, revisionIdentity } from "./canonical";
import { emptyKnowledgeState, KnowledgeError, type KnowledgeBackupScope, type KnowledgeCommand, type KnowledgeContext, type KnowledgeDraft, type KnowledgeEntity, type KnowledgeLibrary, type KnowledgeOwner, type KnowledgePosition, type KnowledgeState, type KnowledgeSyncState, type KnowledgeUnit } from "./domain";
import { applyKnowledgeCommand, knowledgeWrites, revisionValue, validateKnowledgeState, valueOf } from "./protocol";
import { KNOWLEDGE_SCHEMA_27_STORES, type StoredKnowledgeConflict } from "./schema";
import { getDefaultKnowledgeLibrary } from "./defaultLibrary";

export const knowledgeTables = (database: StudyJournalDatabase) => Object.keys(KNOWLEDGE_SCHEMA_27_STORES).map(name => database.table(name));
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
  validateKnowledgeState(after);
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

  async createTopic(title: string, intent: { id: string; ownerScope: KnowledgeOwner; sessionGeneration: number; context?: KnowledgeContext }): Promise<{ libraryId: string; workspaceId: string }> {
    if (!title.trim() || new TextEncoder().encode(title.trim()).byteLength > 512) throw new KnowledgeError("invalid", "专题名称无效");
    return this.database.transaction("rw", knowledgeTables(this.database), async () => {
      if (intent.ownerScope !== this.currentOwner() || intent.sessionGeneration !== this.contextGeneration()) throw new KnowledgeError("scope", "账号已变化");
      const library = intent.context
        ? (await this.assertContext(intent.context)).library
        : await getDefaultKnowledgeLibrary(this.database, intent.ownerScope) ?? await this.createLibrary("我的知识库", "library-" + intent.id);
      const opened = await this.open(library.id);
      const command = createKnowledgeEntity(library.cloudLibraryId ?? library.id, "workspace", title.trim());
      command.id = intent.id;
      command.entity.id = "topic-" + intent.id;
      command.entity.workspaceId = command.entity.id;
      await this.execute(opened.context, command);
      return { libraryId: library.id, workspaceId: command.entity.id };
    });
  }

  async renameLibrary(context: KnowledgeContext, title: string): Promise<void> {
    const name = title.trim();
    if (!name || new TextEncoder().encode(name).byteLength > 512) throw new KnowledgeError("invalid", "知识库名称无效");
    await this.database.transaction("rw", knowledgeTables(this.database), async () => {
      const { library, sync } = await this.assertContext(context);
      await this.assertWritable(library.id);
      if (library.title === name) return;
      const available = await this.listLibraries();
      if (available.some(item => item.id !== library.id && item.title === name)) throw new KnowledgeError("invalid", "名称已存在");
      await this.database.knowledgeLibraries.put({ ...library, title: name });
      await this.database.knowledgeSyncState.put({ ...sync, dirtyGeneration: sync.dirtyGeneration + 1 });
    });
  }

  async createNamedLibrary(title: string, id: string, ownerScope: KnowledgeOwner, sessionGeneration: number): Promise<KnowledgeLibrary> {
    return this.database.transaction("rw", knowledgeTables(this.database), async () => {
      if (ownerScope !== this.currentOwner() || sessionGeneration !== this.contextGeneration()) throw new KnowledgeError("scope", "账号已变化");
      const name = title.trim();
      const available = await this.listLibraries();
      if (available.some(item => item.id !== id && item.title === name)) throw new KnowledgeError("invalid", "名称已存在");
      return this.createLibrary(name, id);
    });
  }

  async isRecoveryProtected(libraryId: string): Promise<boolean> {
    return !!await this.database.knowledgeCommands.filter(command => command.status === "blocked" && command.recoveryLibraryId === libraryId).first() || !!await this.database.knowledgeSyncState.filter(state => state.failure?.recoveryLibraryId === libraryId).first();
  }

  async assertWritable(libraryId: string, importSessionId?: string): Promise<void> {
    if (await this.database.knowledgeLibraryMigrations.where("sourceLibraryId").equals(libraryId).first()) throw new KnowledgeError("migration", "旧内容已经纳入同步，请回到知识库继续编辑；此处保留原内容");
    const copying = await this.database.knowledgeLibraryMigrations.where("targetLibraryId").equals(libraryId).filter(migration => migration.phase === "local-copying").toArray();
    if (copying.some(migration => migration.sessionId !== importSessionId)) throw new KnowledgeError("busy", "正在整理本机知识库，请稍后继续编辑");
    if (await this.isRecoveryProtected(libraryId)) throw new KnowledgeError("protected", "待确认恢复副本只读，请先另存副本或处理依赖操作");
  }

  async deleteLibrary(context: KnowledgeContext): Promise<void> {
    return this.database.transaction("rw", knowledgeTables(this.database), async () => {
      const { library } = await this.assertContext(context);
      if (library.cloudLibraryId) throw new KnowledgeError("invalid", "账号同步库不支持永久删除。请在专题菜单中删除内容，删除状态会随云同步保留。");
      await this.assertWritable(library.id);
      const scope = await this.database.knowledgeBackupScopes.get(library.ownerScope) ?? initialKnowledgeScope(library.ownerScope);
      for (const table of [
        this.database.knowledgeWorkspaces, this.database.knowledgeNodes, this.database.knowledgeReferences,
        this.database.knowledgeRevisions, this.database.knowledgeConflicts, this.database.knowledgeRemoteEntities,
        this.database.knowledgeCommands, this.database.knowledgeDrafts, this.database.knowledgeImportSessions, this.database.knowledgeImportSteps,
      ]) await table.where("libraryId").equals(library.id).delete();
      await this.database.knowledgeSyncState.delete(library.id);
      await this.database.knowledgeLibraries.delete(library.id);
      await this.database.knowledgeBackupScopes.put({ ...scope, membershipGeneration: scope.membershipGeneration + 1 });
    });
  }

  async purgeLocalTrash(context: KnowledgeContext): Promise<number> {
    return this.database.transaction("rw", knowledgeTables(this.database), async () => {
      const { library, sync } = await this.assertContext(context);
      if (library.cloudLibraryId) throw new KnowledgeError("invalid", "账号同步库的回收站会参与云同步，不能单方面清空。");
      await this.assertWritable(library.id);
      const before = await readKnowledgeState(this.database, library.id);
      const deletedIds = new Set(Object.values(before.entities).filter(entity => valueOf(before, entity, "deleted") === true).map(entity => entity.id));
      if (!deletedIds.size) return 0;
      const children = new Map<string, string[]>();
      for (const entity of Object.values(before.entities)) {
        const parentIds = entity.kind === "node"
          ? [entity.workspaceId, (valueOf(before, entity, "position") as KnowledgePosition).parentNodeId]
          : entity.kind === "reference" ? [entity.nodeId] : [];
        for (const parentId of parentIds) children.set(parentId, [...(children.get(parentId) ?? []), entity.id]);
      }
      const pending = [...deletedIds];
      while (pending.length) {
        for (const childId of children.get(pending.pop()!) ?? []) {
          if (!deletedIds.has(childId)) { deletedIds.add(childId); pending.push(childId); }
        }
      }
      const after = structuredClone(before);
      const commandIds = new Set(Object.values(before.revisions).filter(revision => deletedIds.has(revision.entityId)).map(revision => revision.commandId));
      for (const id of deletedIds) delete after.entities[id];
      for (const [id, revision] of Object.entries(after.revisions)) if (!after.entities[revision.entityId]) delete after.revisions[id];
      for (const [id, candidate] of Object.entries(after.candidates)) if (!after.revisions[candidate.revisionId]) delete after.candidates[id];
      for (const [id, group] of Object.entries(after.groups)) if (!after.revisions[group.currentRevisionId]) delete after.groups[id];
      for (const commandId of commandIds) delete after.receipts[commandId];
      await writeKnowledgeStateDelta(this.database, library.id, before, after);
      const commands = await this.database.knowledgeCommands.where("libraryId").equals(library.id).toArray();
      for (const command of commands) if (deletedIds.has(command.command.entity.id)) await this.database.knowledgeCommands.delete([library.id, command.id]);
      await this.database.knowledgeDrafts.where("libraryId").equals(library.id).filter(draft => deletedIds.has(draft.entityId)).delete();
      await this.database.knowledgeSyncState.put({ ...sync, epoch: sync.epoch + 1, dataGeneration: sync.dataGeneration + 1, dirtyGeneration: sync.dirtyGeneration + 1 });
      return deletedIds.size;
    });
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

  async execute(context: KnowledgeContext, command: KnowledgeCommand, clearDraftId?: string, importSessionId?: string, assertActive?: () => Promise<void>): Promise<KnowledgeState> {
    return this.database.transaction("rw", knowledgeTables(this.database), async () => {
      await assertActive?.();
      const { library, sync } = await this.assertContext(context);
      await this.assertWritable(library.id, importSessionId);
      if (command.libraryId !== (library.cloudLibraryId ?? library.id)) throw new KnowledgeError("scope", "命令属于其他知识库");
      const before = await readKnowledgeState(this.database, library.id);
      const importSession = importSessionId ? await this.database.knowledgeImportSessions.get([library.id, importSessionId]) : undefined;
      const step = importSession ? await this.database.knowledgeImportSteps.get([library.id, importSession.id, importSession.next]) : undefined;
      if (importSessionId && (!importSession || !step || importSession.status !== "active" || knowledgeHash(step.command) !== knowledgeHash(command))) throw new KnowledgeError("stale", "另存会话进度或命令已变化");
      const after = applyKnowledgeCommand(before, command, !importSessionId);
      if (after !== before) {
        await writeKnowledgeStateDelta(this.database, library.id, before, after);
        await this.database.knowledgeCommands.add({ libraryId: library.id, id: command.id, command, hash: knowledgeHash(command), status: "pending", localSequence: after.sequence });
        await this.database.knowledgeSyncState.put({ ...sync, epoch: after.sequence, dirtyGeneration: sync.dirtyGeneration + 1 });
      }
      if (importSessionId && importSession) {
        const next = importSession.next + 1;
        await this.database.knowledgeImportSessions.put({ ...importSession, next, status: next === importSession.total ? "completed" : "active" });
        await this.database.knowledgeImportSteps.delete([library.id, importSessionId, importSession.next]);
      }
      if (clearDraftId) await this.database.knowledgeDrafts.delete([library.id, clearDraftId]);
      return after;
    });
  }

  async recordSyncFailure(context: KnowledgeContext, code: "invalid" | "receipt" | "cycle", failed: { cursor: number; sequence: number; fingerprint: string }): Promise<void> {
    await this.database.transaction("rw", knowledgeTables(this.database), async () => {
      const { sync } = await this.assertContext(context);
      if (sync.cursor !== failed.cursor) throw new KnowledgeError("stale", "同步游标已被另一窗口更新");
      const fingerprint = failed.fingerprint;
      const previous = sync.failure;
      const failure = { code, cursor: sync.cursor, sequence: failed.sequence, fingerprint, attempts: previous?.fingerprint === fingerprint ? previous.attempts + 1 : 1, ...(previous?.recoveryLibraryId ? { recoveryLibraryId: previous.recoveryLibraryId } : {}) };
      await this.database.knowledgeSyncState.put({ ...sync, failure });
    });
  }

  async preserveSyncFailure(context: KnowledgeContext): Promise<string> {
    return this.database.transaction("rw", knowledgeTables(this.database), async () => {
      const { sync } = await this.assertContext(context);
      if (!sync.failure) throw new KnowledgeError("stale", "同步问题已变化，请刷新");
      if (sync.failure.recoveryLibraryId && await this.database.knowledgeLibraries.get(sync.failure.recoveryLibraryId)) return sync.failure.recoveryLibraryId;
      const id = "sync-recovery-" + knowledgeHash({ libraryId: context.libraryId, epoch: sync.epoch, fingerprint: sync.failure.fingerprint });
      await this.createLibrary("云历史校验失败保留副本", id, true);
      const preserved = await readKnowledgeState(this.database, context.libraryId);
      preserved.receipts = {};
      await writeKnowledgeStateDelta(this.database, id, emptyKnowledgeState(), preserved);
      await this.database.knowledgeSyncState.update(id, { epoch: preserved.sequence });
      const drafts = await this.database.knowledgeDrafts.where("libraryId").equals(context.libraryId).toArray();
      await this.database.knowledgeDrafts.bulkPut(drafts.map(draft => ({ ...draft, libraryId: id, dataGeneration: 0 })));
      await this.database.knowledgeSyncState.put({ ...sync, failure: { ...sync.failure, recoveryLibraryId: id } });
      return id;
    });
  }

  async listImportSessions(context: KnowledgeContext) {
    await this.assertContext(context);
    return this.database.knowledgeImportSessions.where("libraryId").equals(context.libraryId).toArray();
  }

  async saveDraft(context: KnowledgeContext, draft: KnowledgeDraft): Promise<void> {
    await this.database.transaction("rw", knowledgeTables(this.database), async () => {
      await this.assertContext(context);
      await this.assertWritable(context.libraryId);
      if (draft.libraryId !== context.libraryId || draft.dataGeneration !== context.dataGeneration) throw new KnowledgeError("scope", "草稿身份已变化");
      const existing = await this.database.knowledgeDrafts.get([context.libraryId, draft.id]);
      if (existing && (existing.entityId !== draft.entityId || existing.unit !== draft.unit || existing.expectedRevision !== draft.expectedRevision)) throw new KnowledgeError("stale", "草稿原始编辑基线不可重写");
      await this.database.knowledgeDrafts.put(draft);
    });
  }

  async discardDraft(context: KnowledgeContext, id: string, expectedRevision: string | null): Promise<void> {
    await this.database.transaction("rw", knowledgeTables(this.database), async () => {
      await this.assertContext(context);
      await this.assertWritable(context.libraryId);
      const draft = await this.database.knowledgeDrafts.get([context.libraryId, id]);
      if (draft && draft.expectedRevision !== expectedRevision) throw new KnowledgeError("stale", "草稿基线已变化，原稿保留");
      await this.database.knowledgeDrafts.delete([context.libraryId, id]);
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

  async abandonMissingRecovery(context: KnowledgeContext, id: string, hash: string): Promise<void> {
    await this.database.transaction("rw", knowledgeTables(this.database), async () => {
      const { sync } = await this.assertContext(context);
      const entry = await this.database.knowledgeCommands.get([context.libraryId, id]);
      if (!entry || entry.status !== "blocked" || entry.hash !== hash || !entry.recoveryLibraryId || await this.database.knowledgeLibraries.get(entry.recoveryLibraryId)) throw new KnowledgeError("stale", "待确认操作或副本状态已变化");
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
