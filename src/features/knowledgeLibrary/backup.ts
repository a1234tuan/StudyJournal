import type { StudyJournalDatabase } from "../../db/database";
import { canonicalKnowledge, knowledgeHash, referenceIdentity } from "./canonical";
import { emptyKnowledgeState, KnowledgeError, type KnowledgeCandidate, type KnowledgeEntity, type KnowledgeGroup, type KnowledgeLibrary, type KnowledgeOwner, type KnowledgeRevision, type KnowledgeState } from "./domain";
import { assertKnowledgeTree, revisionValue, validateKnowledgeValue } from "./protocol";
import { initialKnowledgeScope, readKnowledgeState, writeKnowledgeStateDelta } from "./repository";
import { detachedLibraryIdentity, emptyDetachedLibrary } from "./scope";

export interface PortableKnowledgeLibrary { archiveLibraryId: string; title: string; entities: KnowledgeEntity[]; revisions: KnowledgeRevision[]; candidates: KnowledgeCandidate[]; groups: KnowledgeGroup[] }
export interface KnowledgeEnvelope { version: 1; scope: "current-identity-local-libraries" | "selected-libraries"; libraries: PortableKnowledgeLibrary[]; checksum: string }
const validIdentifier = (value: unknown): value is string => typeof value === "string" && /^[A-Za-z0-9_:@.-]{1,200}$/.test(value) && !["__proto__", "prototype", "constructor"].includes(value);
const exactKeys = (value: unknown, keys: string[]) => {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).sort().join(",") !== keys.sort().join(",")) throw new KnowledgeError("invalid", "知识备份字段不完整或包含未知字段");
};
const uniqueRows = <Row extends { id: string }>(rows: Row[]): Record<string, Row> => {
  if (!Array.isArray(rows)) throw new KnowledgeError("invalid", "知识备份数组无效");
  const result: Record<string, Row> = {};
  for (const row of rows) {
    if (!row || !validIdentifier(row.id) || Object.hasOwn(result, row.id)) throw new KnowledgeError("invalid", "知识备份身份重复或无效");
    result[row.id] = row;
  }
  return result;
};
export const portableKnowledgeState = (library: PortableKnowledgeLibrary): KnowledgeState => {
  const state = emptyKnowledgeState();
  state.entities = uniqueRows(library.entities);
  state.revisions = uniqueRows(library.revisions);
  state.candidates = uniqueRows(library.candidates);
  state.groups = uniqueRows(library.groups);
  return state;
};
export const validateKnowledgeEnvelope = (input: unknown): KnowledgeEnvelope => {
  exactKeys(input, ["version", "scope", "libraries", "checksum"]);
  const envelope = input as KnowledgeEnvelope;
  if (envelope.version !== 1 || !["current-identity-local-libraries", "selected-libraries"].includes(envelope.scope) || !Array.isArray(envelope.libraries) || envelope.checksum !== knowledgeHash({ version: envelope.version, scope: envelope.scope, libraries: envelope.libraries })) throw new KnowledgeError("invalid", "知识备份版本、范围或校验和无效");
  const libraryIds = new Set<string>();
  for (const library of envelope.libraries) {
    exactKeys(library, ["archiveLibraryId", "title", "entities", "revisions", "candidates", "groups"]);
    if (!validIdentifier(library.archiveLibraryId) || libraryIds.has(library.archiveLibraryId)) throw new KnowledgeError("invalid", "知识备份库身份无效");
    libraryIds.add(library.archiveLibraryId);
    validateKnowledgeValue("title", library.title);
    const state = portableKnowledgeState(library);
    for (const entity of library.entities) {
      exactKeys(entity, ["id", "kind", "workspaceId", "nodeId", "recordId", "units"]);
      if (!["workspace", "node", "reference"].includes(entity.kind) || !validIdentifier(entity.workspaceId) || !entity.units || typeof entity.units !== "object" || Array.isArray(entity.units)) throw new KnowledgeError("invalid", "知识备份实体无效");
      if (entity.kind === "workspace" && entity.workspaceId !== entity.id) throw new KnowledgeError("invalid", "知识专题身份无效");
      if (entity.kind === "reference" && (!validIdentifier(entity.nodeId) || !validIdentifier(entity.recordId) || entity.id !== referenceIdentity(entity.nodeId, entity.recordId))) throw new KnowledgeError("invalid", "引用身份校验失败");
      const required = entity.kind === "workspace" ? ["archived", "deleted", "note", "title"] : entity.kind === "node" ? ["deleted", "note", "position", "title"] : ["deleted", "remark"];
      if (Object.keys(entity.units).sort().join(",") !== required.join(",")) throw new KnowledgeError("invalid", "知识实体缺少正式字段");
      for (const [unit, revisionId] of Object.entries(entity.units)) {
        const revision = state.revisions[revisionId];
        if (!revision || revision.entityId !== entity.id || revision.unit !== unit) throw new KnowledgeError("invalid", "知识正式版本引用无效");
      }
    }
    const visited = new Set<string>();
    const visiting = new Set<string>();
    for (const revision of library.revisions) {
      exactKeys(revision, ["id", "entityId", "unit", "value", "parents", "commandId"]);
      const entity = state.entities[revision.entityId];
      if (!entity || !Object.hasOwn(entity.units, revision.unit) || !validIdentifier(revision.commandId) || !Array.isArray(revision.parents) || revision.parents.length > 5 || new Set(revision.parents).size !== revision.parents.length) throw new KnowledgeError("invalid", "知识版本因果结构无效");
      if (typeof revision.value === "object" && "revisionValueId" in revision.value) {
        exactKeys(revision.value, ["revisionValueId"]);
        const source = state.revisions[revision.value.revisionValueId];
        if (!source || source.entityId !== revision.entityId || source.unit !== revision.unit || !revision.parents.includes(source.id)) throw new KnowledgeError("invalid", "因果合并版本的内容引用无效");
      }
      const value = revisionValue(state, revision.id);
      if (value === undefined) throw new KnowledgeError("invalid", "知识版本缺少正文");
      validateKnowledgeValue(revision.unit, value);
      for (const parent of revision.parents) {
        const parentRevision = state.revisions[parent];
        if (!parentRevision || parentRevision.entityId !== revision.entityId || parentRevision.unit !== revision.unit) throw new KnowledgeError("invalid", "知识备份缺失因果父版本");
      }
      const pending: Array<{ id: string; exit: boolean }> = [{ id: revision.id, exit: false }];
      while (pending.length) {
        const entry = pending.pop()!;
        if (entry.exit) { visiting.delete(entry.id); visited.add(entry.id); continue; }
        if (visited.has(entry.id)) continue;
        if (visiting.has(entry.id)) throw new KnowledgeError("invalid", "知识版本存在因果环");
        visiting.add(entry.id);
        pending.push({ id: entry.id, exit: true });
        for (const parent of state.revisions[entry.id].parents) pending.push({ id: parent, exit: false });
      }
    }
    for (const candidate of library.candidates) {
      exactKeys(candidate, ["id", "groupId", "revisionId", "consumedBy"]);
      if (!state.revisions[candidate.revisionId] || !state.groups[candidate.groupId] || (candidate.consumedBy !== null && !state.revisions[candidate.consumedBy])) throw new KnowledgeError("invalid", "知识候选证据不完整");
    }
    for (const group of library.groups) {
      exactKeys(group, ["id", "generation", "setToken", "unresolvedCount", "currentRevisionId"]);
      const current = state.revisions[group.currentRevisionId];
      if (!current || state.entities[current.entityId].units[current.unit] !== current.id || !Number.isSafeInteger(group.generation) || group.generation < 1 || !/^[a-f0-9]{64}$/.test(group.setToken) || group.unresolvedCount !== library.candidates.filter(candidate => candidate.groupId === group.id && candidate.consumedBy === null).length) throw new KnowledgeError("invalid", "知识冲突组状态不一致");
    }
    assertKnowledgeTree(state);
  }
  return envelope;
};
export const createKnowledgeEnvelope = (libraries: PortableKnowledgeLibrary[], scope: KnowledgeEnvelope["scope"] = "current-identity-local-libraries"): KnowledgeEnvelope => {
  const payload = { version: 1 as const, scope, libraries };
  return validateKnowledgeEnvelope({ ...payload, checksum: knowledgeHash(payload) });
};
export const capturePortableKnowledge = async (database: StudyJournalDatabase, ownerScope: KnowledgeOwner): Promise<KnowledgeEnvelope> => {
  const libraries = await database.knowledgeLibraries.where("ownerScope").equals(ownerScope).toArray();
  const portable: PortableKnowledgeLibrary[] = [];
  for (const library of libraries.sort((left, right) => left.id < right.id ? -1 : 1)) {
    const state = await readKnowledgeState(database, library.id);
    portable.push({ archiveLibraryId: "archive-" + knowledgeHash(library.id), title: library.title, entities: Object.values(state.entities), revisions: Object.values(state.revisions), candidates: Object.values(state.candidates), groups: Object.values(state.groups) });
  }
  return createKnowledgeEnvelope(portable);
};
export const restorePortableKnowledge = async (database: StudyJournalDatabase, envelope: KnowledgeEnvelope, ownerScope: KnowledgeOwner, restoreSessionId: string): Promise<string[]> => {
  validateKnowledgeEnvelope(envelope);
  if (!validIdentifier(restoreSessionId)) throw new KnowledgeError("invalid", "恢复会话身份无效");
  const sources = envelope.libraries.length ? envelope.libraries : [{ archiveLibraryId: "@empty-envelope", title: "空知识库恢复副本", entities: [], revisions: [], candidates: [], groups: [] }];
  const created: string[] = [];
  for (const source of sources) {
    const id = detachedLibraryIdentity(restoreSessionId, source.archiveLibraryId);
    const library: KnowledgeLibrary = { ...emptyDetachedLibrary(restoreSessionId, ownerScope), id, title: source.title, archiveLibraryId: source.archiveLibraryId };
    const existing = await database.knowledgeLibraries.get(id);
    if (existing) {
      if (canonicalKnowledge(existing) !== canonicalKnowledge(library)) throw new KnowledgeError("scope", "恢复会话归属已变化");
      created.push(id);
      continue;
    }
    const scope = await database.knowledgeBackupScopes.get(ownerScope) ?? initialKnowledgeScope(ownerScope);
    await database.knowledgeLibraries.add(library);
    await database.knowledgeSyncState.add({ libraryId: id, dataGeneration: 1, epoch: 0, cursor: 0, dirtyGeneration: 1 });
    await writeKnowledgeStateDelta(database, id, emptyKnowledgeState(), portableKnowledgeState(source));
    await database.knowledgeBackupScopes.put({ ...scope, membershipGeneration: scope.membershipGeneration + 1 });
    created.push(id);
  }
  return created;
};
