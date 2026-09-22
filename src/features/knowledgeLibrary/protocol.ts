import { canonicalKnowledge, groupIdentity, knowledgeBytes, knowledgeHash, referenceIdentity, revisionIdentity } from "./canonical";
import { KNOWLEDGE_LIMITS, KNOWLEDGE_PROTOCOL, KnowledgeError, ROOT_NODE, type KnowledgeCommand, type KnowledgeEntity, type KnowledgePosition, type KnowledgeRevision, type KnowledgeState, type KnowledgeUnit, type KnowledgeValue } from "./domain";
import { isOrderKey } from "./orderKey";

const allowedUnits = { workspace: ["title", "note", "archived", "deleted"], node: ["title", "note", "position", "deleted"], reference: ["remark", "deleted"] } as const;
const validId = (value: unknown): value is string => typeof value === "string" && /^[A-Za-z0-9_:@.-]{1,180}$/.test(value) && !["__proto__", "constructor", "prototype"].includes(value);
export const revisionValue = (state: KnowledgeState, revisionId: string): KnowledgeValue | undefined => {
  const seen = new Set<string>();
  let revision = state.revisions[revisionId];
  while (revision && typeof revision.value === "object" && "revisionValueId" in revision.value) {
    if (seen.has(revision.id)) throw new KnowledgeError("invalid", "知识内容引用存在环");
    seen.add(revision.id);
    revision = state.revisions[revision.value.revisionValueId];
  }
  return revision?.value as KnowledgeValue | undefined;
};
export const valueOf = (state: KnowledgeState, entity: KnowledgeEntity, unit: KnowledgeUnit): KnowledgeValue | undefined => {
  const revision = entity.units[unit];
  return revision ? revisionValue(state, revision) : undefined;
};
export const restorationToken = (state: KnowledgeState, entity: KnowledgeEntity): string => knowledgeHash(Object.keys(entity.units).sort().map(unit => ({ unit, revision: entity.units[unit as KnowledgeUnit], group: state.groups[groupIdentity(entity.id, unit)]?.setToken ?? null })));
export const isRevisionAncestor = (state: KnowledgeState, ancestor: string, descendant: string): boolean => {
  const visited = new Set<string>();
  const pending = [descendant];
  while (pending.length) {
    const current = pending.pop()!;
    if (current === ancestor) return true;
    if (visited.has(current)) continue;
    visited.add(current);
    pending.push(...(state.revisions[current]?.parents ?? []));
  }
  return false;
};
export const validateKnowledgeValue = (unit: KnowledgeUnit, value: KnowledgeValue): void => {
  if (unit === "deleted" || unit === "archived") {
    if (typeof value !== "boolean") throw new KnowledgeError("invalid", "生命周期字段无效");
  } else if (unit === "position") {
    const position = value as KnowledgePosition;
    if (!position || typeof position !== "object" || Object.keys(position).sort().join(",") !== "orderKey,parentNodeId" || !validId(position.parentNodeId) || typeof position.orderKey !== "string" || !isOrderKey(position.orderKey)) throw new KnowledgeError("invalid", "节点位置无效");
  } else if (typeof value !== "string" || (unit === "title" && !value.trim()) || new TextEncoder().encode(value).byteLength > KNOWLEDGE_LIMITS[unit]) {
    throw new KnowledgeError("invalid", "知识文字为空或超过长度限制");
  }
};
export const validateKnowledgeCommand = (command: KnowledgeCommand): void => {
  if (!command || command.protocolVersion !== KNOWLEDGE_PROTOCOL || !validId(command.id) || !validId(command.libraryId) || !command.entity || !validId(command.entity.id)) throw new KnowledgeError("invalid", "知识命令身份或版本无效");
  if (!Object.hasOwn(allowedUnits, command.entity.kind)) throw new KnowledgeError("invalid", "知识实体类型无效");
  const entity = command.entity;
  if (Object.keys(entity).sort().join(",") !== "id,kind,nodeId,recordId,workspaceId") throw new KnowledgeError("invalid", "知识实体包含未知身份字段");
  if (!validId(entity.workspaceId) || (entity.kind === "workspace" && entity.workspaceId !== entity.id) || (entity.kind !== "reference" && (entity.nodeId !== "" || entity.recordId !== ""))) throw new KnowledgeError("invalid", "专题身份无效");
  if (entity.kind === "reference" && (!validId(entity.nodeId) || !validId(entity.recordId) || entity.id !== referenceIdentity(entity.nodeId, entity.recordId))) throw new KnowledgeError("invalid", "引用身份与节点及日志不一致");
  const changes = Object.entries(command.changes);
  if (!changes.length || changes.length > 4 || !["create", "edit", "delete", "restore", "resolve"].includes(command.operation)) throw new KnowledgeError("invalid", "知识命令范围无效");
  for (const [unit, value] of changes) {
    if (!(allowedUnits[entity.kind] as readonly string[]).includes(unit)) throw new KnowledgeError("invalid", "知识命令包含不允许的字段");
    validateKnowledgeValue(unit as KnowledgeUnit, value);
  }
  for (const [unit, revision] of Object.entries(command.expected)) {
    if (!(allowedUnits[entity.kind] as readonly string[]).includes(unit) || (revision !== null && !validId(revision))) throw new KnowledgeError("invalid", "知识命令基线无效");
  }
  if (command.operation === "create") {
    const required = entity.kind === "reference" ? ["deleted", "remark"] : entity.kind === "node" ? ["deleted", "note", "position", "title"] : ["archived", "deleted", "note", "title"];
    if (Object.keys(command.changes).sort().join(",") !== required.join(",") || command.changes.deleted !== false || (entity.kind === "workspace" && command.changes.archived !== false)) throw new KnowledgeError("invalid", "新实体必须包含完整初始字段");
    if (changes.some(([unit]) => command.expected[unit as KnowledgeUnit] !== null)) throw new KnowledgeError("invalid", "创建命令不能冒用已有基线");
  } else {
    if (changes.length !== 1) throw new KnowledgeError("invalid", "一次命令只能改变一个原子单元");
    if (changes.some(([unit]) => !Object.hasOwn(command.expected, unit))) throw new KnowledgeError("invalid", "编辑缺少基线");
    if (command.operation === "delete" || command.operation === "restore") {
      if (changes[0][0] !== "deleted" || command.changes.deleted !== (command.operation === "delete")) throw new KnowledgeError("invalid", "生命周期操作无效");
    } else if (changes[0][0] === "deleted") throw new KnowledgeError("invalid", "删除或恢复必须使用专用命令");
  }
  if (command.operation === "restore" && (typeof command.restoreToken !== "string" || !/^[a-f0-9]{64}$/.test(command.restoreToken))) throw new KnowledgeError("invalid", "恢复缺少已确认候选集合");
  if (command.operation !== "restore" && command.restoreToken !== undefined) throw new KnowledgeError("invalid", "非恢复命令包含恢复基线");
  if (command.operation === "resolve") {
    const resolution = command.resolution;
    if (!resolution || resolution.unit !== changes[0][0] || !Number.isSafeInteger(resolution.generation) || resolution.generation < 1 || !/^[a-f0-9]{64}$/.test(resolution.setToken) || !Array.isArray(resolution.candidates) || !resolution.candidates.length || resolution.candidates.length > KNOWLEDGE_LIMITS.resolution || new Set(resolution.candidates).size !== resolution.candidates.length || resolution.candidates.some(candidate => !validId(candidate))) throw new KnowledgeError("invalid", "冲突解决批次无效");
  } else if (command.resolution) throw new KnowledgeError("invalid", "非解决操作不能消费候选");
  if (knowledgeBytes(command) > KNOWLEDGE_LIMITS.commandBytes) throw new KnowledgeError("budget", "知识命令超过安全预算");
};

export const assertKnowledgeTree = (state: KnowledgeState): void => {
  const nodes = Object.values(state.entities).filter(entity => entity.kind === "node");
  for (const node of nodes) {
    const workspace = state.entities[node.workspaceId];
    if (!workspace || workspace.kind !== "workspace") throw new KnowledgeError("missing", "节点专题不存在");
    const seen = new Set<string>([node.id]);
    let position = valueOf(state, node, "position") as KnowledgePosition;
    if (!position) throw new KnowledgeError("invalid", "节点缺少位置");
    while (position.parentNodeId !== ROOT_NODE) {
      if (seen.has(position.parentNodeId)) throw new KnowledgeError("cycle", "不能把分支移到自身或后代");
      seen.add(position.parentNodeId);
      const parent = state.entities[position.parentNodeId];
      if (!parent || parent.kind !== "node" || parent.workspaceId !== node.workspaceId) throw new KnowledgeError("missing", "父节点不存在或不属于当前专题");
      position = valueOf(state, parent, "position") as KnowledgePosition;
    }
  }
  for (const entity of Object.values(state.entities)) {
    if (entity.kind !== "reference") continue;
    const target = state.entities[entity.nodeId];
    if (!target || target.kind !== "node" || target.workspaceId !== entity.workspaceId) throw new KnowledgeError("missing", "引用节点不属于当前专题");
  }
};
export const isKnowledgeVisible = (state: KnowledgeState, entity: KnowledgeEntity): boolean => {
  const seen = new Set<string>();
  let current: KnowledgeEntity | undefined = entity;
  while (current) {
    if (seen.has(current.id) || valueOf(state, current, "deleted") === true || valueOf(state, current, "archived") === true) return false;
    seen.add(current.id);
    if (current.kind === "workspace") return true;
    if (current.kind === "reference") current = state.entities[current.nodeId];
    else {
      const position = valueOf(state, current, "position") as KnowledgePosition;
      current = state.entities[position.parentNodeId === ROOT_NODE ? current.workspaceId : position.parentNodeId];
    }
  }
  return false;
};

export interface KnowledgeWrite { collection: "entities" | "revisions" | "candidates" | "groups" | "receipts"; id: string; value: unknown }
export const knowledgeWrites = (before: KnowledgeState, after: KnowledgeState): KnowledgeWrite[] => {
  const writes: KnowledgeWrite[] = [];
  for (const collection of ["entities", "revisions", "candidates", "groups", "receipts"] as const) {
    for (const [id, value] of Object.entries(after[collection])) {
      if (!Object.hasOwn(before[collection], id) || canonicalKnowledge(before[collection][id]) !== canonicalKnowledge(value)) writes.push({ collection, id, value });
    }
  }
  return writes;
};
export const assertKnowledgeBudget = (writes: KnowledgeWrite[]): void => {
  const rows = writes.filter(write => write.collection !== "receipts");
  const wireBudget = 16384 + rows.reduce((total, write) => total + new TextEncoder().encode(canonicalKnowledge(write.value)).byteLength * (write.collection === "revisions" ? 2 : 4), 0);
  if (rows.length > 15 || wireBudget > KNOWLEDGE_LIMITS.commandBytes) throw new KnowledgeError("budget", "此次操作超出云端可验证预算");
  const commit = writes.map(write => ({ collection: write.collection, id: write.id, ...(write.collection === "revisions" ? { revisionId: write.id } : { value: write.value }) }));
  if (writes.length + 2 > KNOWLEDGE_LIMITS.writes || knowledgeBytes({ writes, commit, head: { sequence: Number.MAX_SAFE_INTEGER, commandId: "x".repeat(180) } }) > KNOWLEDGE_LIMITS.commandBytes) throw new KnowledgeError("budget", "此次操作超出同步安全预算，请减少本批候选");
};

export const applyKnowledgeCommand = (before: KnowledgeState, command: KnowledgeCommand, strict = false): KnowledgeState => {
  validateKnowledgeCommand(command);
  const hash = knowledgeHash(command);
  const receipt = before.receipts[command.id];
  if (receipt) {
    if (receipt.hash !== hash) throw new KnowledgeError("receipt", "相同命令身份不能改变原始内容");
    return before;
  }
  const original = before.entities[command.entity.id];
  if (original && canonicalKnowledge({ ...original, units: {} }) !== canonicalKnowledge({ ...command.entity, units: {} })) throw new KnowledgeError("invalid", "实体身份不可修改");
  if (!original && command.operation !== "create") throw new KnowledgeError("missing", "知识条目已不存在");
  if (original && command.operation === "create" && original.kind !== "reference") throw new KnowledgeError("invalid", "已存在的实体不能重复创建");
  if (original && command.operation === "create" && strict) return before;
  if (original && strict && !["restore", "delete"].includes(command.operation) && command.changes.archived !== false && !isKnowledgeVisible(before, original)) throw new KnowledgeError("stale", "条目或祖先已删除或归档，请先恢复");
  if (!original && strict && command.entity.kind !== "workspace") {
    const targetId = command.entity.kind === "reference" ? command.entity.nodeId : (command.changes.position as KnowledgePosition).parentNodeId;
    const parent = before.entities[targetId === ROOT_NODE ? command.entity.workspaceId : targetId];
    if (!parent || !isKnowledgeVisible(before, parent)) throw new KnowledgeError("stale", "目标节点或专题不可用");
  }
  const state: KnowledgeState = structuredClone(before);
  const entity = state.entities[command.entity.id] ?? { ...command.entity, units: {} };
  state.entities[entity.id] = entity;
  let changed = false;
  for (const [rawUnit, value] of Object.entries(command.changes)) {
    const unit = rawUnit as KnowledgeUnit;
    const currentId = entity.units[unit] ?? null;
    const current = currentId ? state.revisions[currentId] : undefined;
    const expected = command.expected[unit] ?? null;
    if (expected && (!state.revisions[expected] || state.revisions[expected].entityId !== entity.id || state.revisions[expected].unit !== unit)) throw new KnowledgeError("invalid", "命令基线版本不存在或属于其他字段");
    if (command.operation === "create" && original && (unit === "deleted" || value === "")) continue;
    const sameValue = !!current && canonicalKnowledge(revisionValue(state, current.id)) === canonicalKnowledge(value);
    if (command.operation !== "resolve" && sameValue && (strict || expected === currentId)) continue;
    if (strict && expected !== currentId) throw new KnowledgeError("stale", "内容已变化，请保留输入并重新读取");
    if (command.operation === "restore") {
      const equivalentRestore = sameValue && !!expected && revisionValue(state, expected) === true && !!currentId && isRevisionAncestor(state, expected, currentId);
      if (!equivalentRestore && (!current || revisionValue(state, current.id) !== true || currentId !== expected || command.restoreToken !== restorationToken(before, original!))) throw new KnowledgeError("stale", "删除版本或候选已变化，请重新确认恢复");
      const parent = entity.kind === "reference" ? state.entities[entity.nodeId] : entity.kind === "node" ? state.entities[(valueOf(state, entity, "position") as KnowledgePosition).parentNodeId] : undefined;
      const workspace = state.entities[entity.workspaceId];
      if ((parent && !isKnowledgeVisible(state, parent)) || (entity.kind !== "workspace" && workspace && !isKnowledgeVisible(state, workspace))) throw new KnowledgeError("stale", "请先恢复父节点或专题");
    }
    const groupId = groupIdentity(entity.id, unit);
    const previousGroup = state.groups[groupId];
    const parents = expected ? [expected] : [];
    let consumed: string[] = [];
    if (command.operation === "resolve") {
      const resolution = command.resolution!;
      if (!previousGroup || previousGroup.setToken !== resolution.setToken || previousGroup.generation !== resolution.generation || previousGroup.currentRevisionId !== expected) throw new KnowledgeError("stale", "冲突候选已变化，请刷新后重新选择");
      consumed = resolution.candidates;
      for (const candidateId of consumed) {
        const candidate = state.candidates[candidateId];
        if (!candidate || candidate.groupId !== groupId || candidate.consumedBy !== null) throw new KnowledgeError("stale", "候选已被其他操作处理");
        parents.push(candidate.revisionId);
      }
    }

    const revision: KnowledgeRevision = { id: revisionIdentity(command.id, unit), entityId: entity.id, unit, value, parents: [...new Set(parents)], commandId: command.id };
    if (state.revisions[revision.id]) throw new KnowledgeError("receipt", "版本身份重复");
    state.revisions[revision.id] = revision;
    const initialEmptyRemark = command.operation === "create" && unit === "remark" && current?.value === "" && current.parents.length === 0;
    let conflict = !!current && !sameValue && !initialEmptyRemark && expected !== currentId && !["delete", "resolve"].includes(command.operation);
    if (unit === "deleted") conflict = false;
    if (!conflict) {
      let effectiveRevision = revision.id;
      if (sameValue && currentId && currentId !== expected) {
        const joinParents = [currentId, revision.id];
        effectiveRevision = "join-" + knowledgeHash({ parents: joinParents });
        state.revisions[effectiveRevision] = { ...revision, id: effectiveRevision, parents: joinParents, value: { revisionValueId: revision.id } };
      }
      entity.units[unit] = effectiveRevision;
      try { if (unit === "position") assertKnowledgeTree(state); } catch (error) {
        if (strict || !original || unit !== "position" || !(error instanceof KnowledgeError)) throw error;
        entity.units[unit] = currentId!;
        conflict = true;
      }
    }
    if (conflict) {
      state.candidates[revision.id] = { id: revision.id, groupId, revisionId: revision.id, consumedBy: null };
    } else {
      for (const candidateId of consumed) state.candidates[candidateId].consumedBy = revision.id;
    }
    const generation = (previousGroup?.generation ?? 0) + 1;
    if (current || conflict || previousGroup) state.groups[groupId] = { id: groupId, generation, setToken: knowledgeHash({ previous: previousGroup?.setToken ?? null, generation, revisionId: revision.id, conflict, consumed }), unresolvedCount: (previousGroup?.unresolvedCount ?? 0) + Number(conflict) - (conflict ? 0 : consumed.length), currentRevisionId: entity.units[unit]! };
    changed = true;
  }
  if (!changed) return before;
  assertKnowledgeTree(state);
  state.sequence += 1;
  state.receipts[command.id] = { id: command.id, hash, sequence: state.sequence };
  assertKnowledgeBudget(knowledgeWrites(before, state));
  return state;
};
