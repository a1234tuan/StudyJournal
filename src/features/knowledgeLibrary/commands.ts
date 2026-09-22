import { referenceIdentity } from "./canonical";
import { ROOT_NODE, type KnowledgeCommand, type KnowledgeEntity, type KnowledgeState, type KnowledgeUnit, type KnowledgeValue } from "./domain";
import { orderBetween } from "./orderKey";
import { restorationToken } from "./protocol";

export const createKnowledgeEntity = (libraryId: string, kind: KnowledgeEntity["kind"], title: string, workspaceId?: string, parentNodeId = ROOT_NODE, recordId = "", nodeId = ""): KnowledgeCommand => {
  const commandId = crypto.randomUUID();
  const id = kind === "reference" ? referenceIdentity(nodeId, recordId) : crypto.randomUUID();
  const changes = kind === "workspace" ? { title, note: "", archived: false, deleted: false } : kind === "node" ? { title, note: "", position: { parentNodeId, orderKey: orderBetween(null, null, commandId) }, deleted: false } : { remark: "", deleted: false };
  return { protocolVersion: 1, id: commandId, libraryId, operation: "create", entity: { id, kind, workspaceId: kind === "workspace" ? id : workspaceId!, nodeId, recordId }, changes, expected: Object.fromEntries(Object.keys(changes).map(unit => [unit, null])) };
};
export const editKnowledgeEntity = (libraryId: string, state: KnowledgeState, entity: KnowledgeEntity, unit: KnowledgeUnit, value: KnowledgeValue): KnowledgeCommand => {
  const { units, ...identity } = entity;
  const operation = unit === "deleted" ? value ? "delete" : "restore" : "edit";
  return { protocolVersion: 1, id: crypto.randomUUID(), libraryId, operation, entity: identity, expected: { [unit]: units[unit] ?? null }, changes: { [unit]: value }, ...(operation === "restore" ? { restoreToken: restorationToken(state, entity) } : {}) };
};
