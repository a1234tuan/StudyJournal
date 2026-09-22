import { canonicalKnowledge, knowledgeBytes, knowledgeHash } from "./canonical";
import { KNOWLEDGE_LIMITS, KnowledgeError, type KnowledgeCommand, type KnowledgeState } from "./domain";
import { knowledgeWrites, assertKnowledgeTree } from "./protocol";

export interface KnowledgeCloudSlot { collection: string; id: string; hash: string; bytes: number; payload: string }
export interface KnowledgeCloudRow { protocolVersion: 1; sequence: number; commandId: string; slot: number; payload: string; hash: string; kind: string }
export interface KnowledgeCloudCommit { protocolVersion: 1; sequence: number; commandId: string; commandHash: string; slots: KnowledgeCloudSlot[]; budget: number }
export interface KnowledgeCloudReceipt { protocolVersion: 1; sequence: number; commandId: string; commandHash: string; registration: boolean }
export interface KnowledgeCloudHead { protocolVersion: 1; sequence: number; commandId: string }
export interface KnowledgeCloudPacket { head: KnowledgeCloudHead; commit: KnowledgeCloudCommit; receipt: KnowledgeCloudReceipt; rows: Array<{ collection: string; id: string; data: KnowledgeCloudRow }> }
export const knowledgeCloudPacket = (before: KnowledgeState, after: KnowledgeState, command: KnowledgeCommand): KnowledgeCloudPacket => {
  if (after.sequence !== before.sequence + 1) throw new KnowledgeError("invalid", "云提交必须是一个连续命令");
  const writes = knowledgeWrites(before, after).filter(write => write.collection !== "receipts");
  const slots: KnowledgeCloudSlot[] = writes.map(write => {
    const payload = canonicalKnowledge(write.value);
    return { collection: write.collection === "groups" || write.collection === "candidates" ? "conflicts" : write.collection, id: write.id, hash: knowledgeHash(write.value), bytes: new TextEncoder().encode(payload).byteLength, payload: write.collection === "revisions" ? "" : payload };
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
  if (packet.head.protocolVersion !== 1 || packet.commit.sequence !== before.sequence + 1 || packet.head.sequence !== packet.commit.sequence || packet.receipt.sequence !== packet.commit.sequence || packet.receipt.commandHash !== packet.commit.commandHash || packet.head.commandId !== packet.commit.commandId || packet.receipt.commandId !== packet.commit.commandId || packet.commit.slots.length !== packet.rows.length || packet.commit.slots.length > 15 || packet.commit.budget > KNOWLEDGE_LIMITS.commandBytes) throw new KnowledgeError("invalid", "知识提交不完整或不连续");
  const expectedBudget = 16384 + packet.commit.slots.reduce((total, slot) => total + slot.bytes * (slot.collection === "revisions" ? 2 : 4), 0);
  if (packet.commit.protocolVersion !== 1 || packet.receipt.protocolVersion !== 1 || packet.receipt.registration !== false || packet.commit.budget !== expectedBudget || knowledgeBytes(packet) > KNOWLEDGE_LIMITS.commandBytes || new Set(packet.rows.map(row => row.collection + ":" + row.id)).size !== packet.rows.length) throw new KnowledgeError("invalid", "知识提交预算、回执或槽位无效");
  const state = structuredClone(before);
  for (let index = 0; index < packet.rows.length; index += 1) {
    const row = packet.rows[index];
    const slot = packet.commit.slots[index];
    const value: { id: string } = JSON.parse(row.data.payload);
    if (slot.id !== row.id || value.id !== row.id || slot.collection !== row.collection || slot.hash !== knowledgeHash(value) || slot.hash !== row.data.hash || row.data.sequence !== packet.commit.sequence || row.data.commandId !== packet.commit.commandId || row.data.slot !== index || row.data.protocolVersion !== 1 || new TextEncoder().encode(row.data.payload).byteLength !== slot.bytes || (slot.collection !== "revisions" && slot.payload !== row.data.payload)) throw new KnowledgeError("invalid", "知识提交正文或哈希不一致");
    const collection = row.data.kind;
    if ((collection === "groups" || collection === "candidates" ? "conflicts" : collection) !== row.collection) throw new KnowledgeError("invalid", "知识提交存储类型不一致");
    if (!["entities", "revisions", "candidates", "groups"].includes(collection)) throw new KnowledgeError("invalid", "知识提交类型无效");
    const store = state[collection as "entities" | "revisions" | "candidates" | "groups"] as Record<string, unknown>;
    if (collection === "revisions" && store[row.id] && canonicalKnowledge(store[row.id]) !== row.data.payload) throw new KnowledgeError("invalid", "不可变版本遭到修改");
    store[row.id] = value;
  }
  assertKnowledgeTree(state);
  state.sequence = packet.commit.sequence;
  state.receipts[packet.receipt.commandId] = { id: packet.receipt.commandId, hash: packet.receipt.commandHash, sequence: packet.receipt.sequence };
  return state;
};
