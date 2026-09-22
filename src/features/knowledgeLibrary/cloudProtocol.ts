import { canonicalKnowledge, knowledgeBytes, knowledgeHash, revisionIdentity } from "./canonical";
import { KNOWLEDGE_LIMITS, KnowledgeError, type KnowledgeCommand, type KnowledgeState } from "./domain";
import { knowledgeWrites, validateKnowledgeState, type KnowledgeWrite } from "./protocol";

export type KnowledgeCloudKind = "entities" | "revisions" | "candidates" | "groups";
export type KnowledgeCloudCollection = "entities" | "revisions" | "conflicts";
export interface KnowledgeCloudSlot { collection: KnowledgeCloudCollection; kind: KnowledgeCloudKind; id: string; hash: string; bytes: number; payload: string }
export interface KnowledgeCloudRow { protocolVersion: 1; sequence: number; commandId: string; slot: number; payload: string; hash: string; kind: KnowledgeCloudKind }
export interface KnowledgeCloudCommit { protocolVersion: 1; sequence: number; commandId: string; commandHash: string; slots: KnowledgeCloudSlot[]; budget: number }
export interface KnowledgeCloudReceipt { protocolVersion: 1; sequence: number; commandId: string; commandHash: string; registration: boolean }
export interface KnowledgeCloudHead { protocolVersion: 1; sequence: number; commandId: string }
export interface KnowledgeCloudPacket { head: KnowledgeCloudHead; commit: KnowledgeCloudCommit; receipt: KnowledgeCloudReceipt; rows: Array<{ collection: string; id: string; data: KnowledgeCloudRow }> }
const wireObject = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
export const normalizeKnowledgeCloudSlot = (input: unknown): KnowledgeCloudSlot => {
  if (!wireObject(input)) throw new KnowledgeError("invalid", "知识提交槽位无效");
  const legacy = !Object.hasOwn(input, "kind");
  if (Object.keys(input).sort().join(",") !== (legacy ? "bytes,collection,hash,id,payload" : "bytes,collection,hash,id,kind,payload") || typeof input.id !== "string" || !/^[A-Za-z0-9_:@.-]{1,200}$/.test(input.id) || ["__proto__", "prototype", "constructor"].includes(input.id) || typeof input.hash !== "string" || !/^[a-f0-9]{64}$/.test(input.hash) || !Number.isSafeInteger(input.bytes) || (input.bytes as number) < 0 || typeof input.payload !== "string") throw new KnowledgeError("invalid", "知识提交槽位字段无效");
  let kind = input.kind;
  if (legacy) {
    if (input.collection === "entities" || input.collection === "revisions") kind = input.collection;
    else if (input.collection === "conflicts") {
      let payload: unknown;
      try { payload = JSON.parse(input.payload); } catch { throw new KnowledgeError("invalid", "旧知识提交正文无效，已停止同步并保留本地内容"); }
      if (!wireObject(payload) || payload.id !== input.id) throw new KnowledgeError("invalid", "旧知识提交身份无效，已停止同步并保留本地内容");
      const keys = Object.keys(payload).sort().join(",");
      if (keys === "consumedBy,groupId,id,revisionId") kind = "candidates";
      else if (keys === "currentRevisionId,generation,id,setToken,unresolvedCount") kind = "groups";
    }
  }
  if (!["entities", "revisions", "candidates", "groups"].includes(kind as string) || (kind === "groups" || kind === "candidates" ? "conflicts" : kind) !== input.collection || (input.collection === "revisions" && input.payload !== "")) throw new KnowledgeError("invalid", "知识提交类型缺失或存在歧义，已停止同步并保留本地内容");
  return { ...input, kind } as unknown as KnowledgeCloudSlot;
};
export const knowledgeCloudPacket = (before: KnowledgeState, after: KnowledgeState, command: KnowledgeCommand): KnowledgeCloudPacket => {
  if (after.sequence !== before.sequence + 1) throw new KnowledgeError("invalid", "云提交必须是一个连续命令");
  const writes = knowledgeWrites(before, after).filter((write): write is KnowledgeWrite & { collection: "entities" | "revisions" | "candidates" | "groups" } => write.collection !== "receipts");
  const slots: KnowledgeCloudSlot[] = writes.map(write => {
    const payload = canonicalKnowledge(write.value);
    return { collection: write.collection === "groups" || write.collection === "candidates" ? "conflicts" : write.collection, kind: write.collection, id: write.id, hash: knowledgeHash(write.value), bytes: new TextEncoder().encode(payload).byteLength, payload: write.collection === "revisions" ? "" : payload };
  });
  const budget = 16384 + slots.reduce((total, slot) => total + slot.bytes * (slot.collection === "revisions" ? 2 : 4), 0);
  const head: KnowledgeCloudHead = { protocolVersion: 1, sequence: after.sequence, commandId: command.id };
  const commit: KnowledgeCloudCommit = { ...head, commandHash: knowledgeHash(command), slots, budget };
  const receipt: KnowledgeCloudReceipt = { ...head, commandHash: commit.commandHash, registration: false };
  const rows = writes.map((write, slot) => ({ collection: slots[slot].collection, id: write.id, data: { ...head, slot, payload: canonicalKnowledge(write.value), hash: slots[slot].hash, kind: write.collection } }));
  const packet = { head, commit, receipt, rows };
  if (writes.length > 15 || writes.length + 3 > KNOWLEDGE_LIMITS.writes || budget > KNOWLEDGE_LIMITS.commandBytes || knowledgeBytes(packet) > KNOWLEDGE_LIMITS.commandBytes) throw new KnowledgeError("budget", "云事务超过可验证的安全预算");
  return packet;
};
export const applyKnowledgeCloudPacket = (before: KnowledgeState, packet: KnowledgeCloudPacket): KnowledgeState => {
  if (!packet || !wireObject(packet.head) || !wireObject(packet.commit) || !wireObject(packet.receipt) || !Array.isArray(packet.commit.slots) || !Array.isArray(packet.rows)) throw new KnowledgeError("invalid", "知识提交结构无效");
  const slots = packet.commit.slots.map(normalizeKnowledgeCloudSlot);
  if (!Number.isSafeInteger(packet.commit.sequence) || packet.commit.sequence < 1 || typeof packet.commit.commandId !== "string" || !/^[A-Za-z0-9_:@.-]{1,180}$/.test(packet.commit.commandId) || ["__proto__", "prototype", "constructor"].includes(packet.commit.commandId) || typeof packet.commit.commandHash !== "string" || !/^[a-f0-9]{64}$/.test(packet.commit.commandHash) || packet.rows.some(row => !wireObject(row) || !wireObject(row.data))) throw new KnowledgeError("invalid", "知识提交身份或版本无效");
  if (packet.head.protocolVersion !== 1 || packet.commit.sequence !== before.sequence + 1 || packet.head.sequence !== packet.commit.sequence || packet.receipt.sequence !== packet.commit.sequence || packet.receipt.commandHash !== packet.commit.commandHash || packet.head.commandId !== packet.commit.commandId || packet.receipt.commandId !== packet.commit.commandId || packet.commit.slots.length !== packet.rows.length || packet.commit.slots.length > 15 || packet.commit.budget > KNOWLEDGE_LIMITS.commandBytes) throw new KnowledgeError("invalid", "知识提交不完整或不连续");
  const expectedBudget = 16384 + packet.commit.slots.reduce((total, slot) => total + slot.bytes * (slot.collection === "revisions" ? 2 : 4), 0);
  if (packet.commit.protocolVersion !== 1 || packet.receipt.protocolVersion !== 1 || packet.receipt.registration !== false || packet.commit.budget !== expectedBudget || knowledgeBytes(packet) > KNOWLEDGE_LIMITS.commandBytes || new Set(packet.rows.map(row => row.collection + ":" + row.id)).size !== packet.rows.length) throw new KnowledgeError("invalid", "知识提交预算、回执或槽位无效");
  const state = structuredClone(before);
  for (let index = 0; index < packet.rows.length; index += 1) {
    const row = packet.rows[index];
    const slot = slots[index];
    if (Object.keys(row.data).sort().join(",") !== "commandId,hash,kind,payload,protocolVersion,sequence,slot" || typeof row.data.payload !== "string") throw new KnowledgeError("invalid", "知识提交行字段无效");
    let value: { id: string };
    try { value = JSON.parse(row.data.payload) as { id: string }; } catch { throw new KnowledgeError("invalid", "知识提交正文不是有效 JSON"); }
    if (!wireObject(value)) throw new KnowledgeError("invalid", "知识提交正文必须是对象");
    const collection = slot.kind;
    if (slot.id !== row.id || value.id !== row.id || slot.collection !== row.collection || row.data.kind !== slot.kind || slot.hash !== knowledgeHash(value) || slot.hash !== row.data.hash || row.data.sequence !== packet.commit.sequence || row.data.commandId !== packet.commit.commandId || row.data.slot !== index || row.data.protocolVersion !== 1 || !Number.isSafeInteger(slot.bytes) || slot.bytes < 0 || new TextEncoder().encode(row.data.payload).byteLength !== slot.bytes || (slot.collection !== "revisions" && slot.payload !== row.data.payload) || (slot.collection === "revisions" && slot.payload !== "") || canonicalKnowledge(value) !== row.data.payload) throw new KnowledgeError("invalid", "知识提交正文或哈希不一致");
    if ((collection === "groups" || collection === "candidates" ? "conflicts" : collection) !== row.collection) throw new KnowledgeError("invalid", "知识提交存储类型不一致");
    const store = state[collection] as Record<string, unknown>;
    if (collection === "entities" && store[row.id] && canonicalKnowledge({ ...(store[row.id] as Record<string, unknown>), units: {} }) !== canonicalKnowledge({ ...value, units: {} })) throw new KnowledgeError("invalid", "知识实体身份不可修改");
    if (collection === "revisions" && store[row.id] && canonicalKnowledge(store[row.id]) !== row.data.payload) throw new KnowledgeError("invalid", "不可变版本遭到修改");
    store[row.id] = value;
  }
  state.sequence = packet.commit.sequence;
  state.receipts[packet.receipt.commandId] = { id: packet.receipt.commandId, hash: packet.receipt.commandHash, sequence: packet.receipt.sequence };
  validateKnowledgeState(state);
  for (const group of Object.values(state.groups)) {
    const previous = before.groups[group.id];
    if (previous && canonicalKnowledge(previous) === canonicalKnowledge(group)) continue;
    const current = state.revisions[group.currentRevisionId];
    const revisionId = revisionIdentity(packet.commit.commandId, current.unit);
    const revision = state.revisions[revisionId];
    if (!revision || before.revisions[revisionId] || revision.entityId !== current.entityId || group.generation !== (previous?.generation ?? 0) + 1) throw new KnowledgeError("invalid", "知识冲突组代次与命令不一致");
    const conflict = state.candidates[revisionId]?.groupId === group.id;
    const consumed = revision.parents.filter(parent => state.candidates[parent]?.consumedBy === revisionId);
    if (group.setToken !== knowledgeHash({ previous: previous?.setToken ?? null, generation: group.generation, revisionId, conflict, consumed })) throw new KnowledgeError("invalid", "知识冲突组集合令牌不一致");
  }
  for (const candidate of Object.values(before.candidates)) {
    const next = state.candidates[candidate.id];
    if (!next || candidate.groupId !== next.groupId || candidate.revisionId !== next.revisionId || (candidate.consumedBy !== null && candidate.consumedBy !== next.consumedBy)) throw new KnowledgeError("invalid", "知识候选证据不可重写");
  }
  return state;
};
