import type { BackupAssetMeta, RecordBlock } from "../../types";
import { recordToPlainText } from "../../lib/recordContent";
import { ROOT_NODE, type KnowledgeEntity, type KnowledgePosition, type KnowledgeState } from "./domain";
import { isKnowledgeVisible, valueOf } from "./protocol";
import { compareOrder } from "./orderKey";

export interface KnowledgeQuery { text: string; workspaceId?: string; subject?: string; tag?: string; from?: string; to?: string; unorganized?: boolean; includeBody?: boolean; includeHidden?: boolean }
export interface KnowledgeHit { recordId?: string; entityId: string; workspaceId: string; nodeId?: string; title: string; excerpt: string }
export const knowledgeLabel = (state: KnowledgeState, entity: KnowledgeEntity | undefined): string => entity ? String(valueOf(state, entity, "title") ?? valueOf(state, entity, "remark") ?? "日志引用") : "暂不可用";
const bodyCache = new WeakMap<RecordBlock, string>();
export const knowledgeChildren = (state: KnowledgeState, workspaceId: string, parentNodeId = ROOT_NODE): KnowledgeEntity[] => Object.values(state.entities).filter(entity => entity.kind === "node" && entity.workspaceId === workspaceId && (valueOf(state, entity, "position") as KnowledgePosition)?.parentNodeId === parentNodeId).sort((left, right) => compareOrder((valueOf(state, left, "position") as KnowledgePosition).orderKey, (valueOf(state, right, "position") as KnowledgePosition).orderKey) || compareOrder(left.id, right.id));
export const knowledgeBacklinks = (state: KnowledgeState, recordId: string): KnowledgeEntity[] => Object.values(state.entities).filter(entity => entity.kind === "reference" && entity.recordId === recordId && isKnowledgeVisible(state, entity));
export const searchKnowledge = (state: KnowledgeState, records: readonly RecordBlock[], query: KnowledgeQuery, assets: readonly BackupAssetMeta[] = []): KnowledgeHit[] => {
  const needle = query.text.trim().toLocaleLowerCase();
  const entities = Object.values(state.entities).filter(entity => (!query.workspaceId || entity.workspaceId === query.workspaceId) && (query.includeHidden || isKnowledgeVisible(state, entity)));
  const references = entities.filter(entity => entity.kind === "reference");
  const byRecord = new Map<string, KnowledgeEntity[]>();
  for (const reference of references) { const locations = byRecord.get(reference.recordId) ?? []; locations.push(reference); byRecord.set(reference.recordId, locations); }
  const assetMap = new Map(assets.map(asset => [asset.id, asset]));
  const organized = new Set(Object.values(state.entities).filter(entity => entity.kind === "reference" && isKnowledgeVisible(state, entity)).map(entity => entity.recordId));
  const hits: KnowledgeHit[] = [];
  if (!query.unorganized && !query.subject && !query.tag && !query.from && !query.to) {
    for (const entity of entities) {
      const text = [knowledgeLabel(state, entity), valueOf(state, entity, "note"), valueOf(state, entity, "remark")].filter(value => typeof value === "string").join("\n");
      if (needle && text.toLocaleLowerCase().includes(needle)) hits.push({ entityId: entity.id, workspaceId: entity.workspaceId, nodeId: entity.kind === "node" ? entity.id : entity.nodeId || undefined, title: knowledgeLabel(state, entity), excerpt: text.slice(0, 180) });
    }
  }
  for (const record of records) {
    if (record.deletedAt || (query.subject && record.subject !== query.subject) || (query.tag && !record.tags.includes(query.tag)) || (query.from && record.date < query.from) || (query.to && record.date > query.to) || (query.unorganized && organized.has(record.id))) continue;
    const locations = byRecord.get(record.id) ?? [];
    if (query.workspaceId && !locations.length) continue;
    if (query.includeBody && !bodyCache.has(record)) bodyCache.set(record, recordToPlainText(record));
    const ocr = query.includeBody ? record.assets.map(ref => assetMap.get(ref.id)?.ocrText ?? "").join("\n") : "";
    const text = [record.title, ...record.tags, query.includeBody ? bodyCache.get(record) : "", ocr].join("\n");
    if (needle && !text.toLocaleLowerCase().includes(needle)) continue;
    const reference = locations[0];
    hits.push({ recordId: record.id, entityId: reference?.id ?? record.id, workspaceId: reference?.workspaceId ?? "", nodeId: reference?.nodeId, title: record.title || "未命名日志", excerpt: text.slice(0, 180) });
  }
  return hits;
};
export interface KnowledgeLayoutNode { id: string; depth: number; x: number; y: number; parentNodeId: string }
export const layoutKnowledgeTree = (state: KnowledgeState, workspaceId: string, collapsed: ReadonlySet<string>): KnowledgeLayoutNode[] => {
  const result: KnowledgeLayoutNode[] = [];
  const children = new Map<string, KnowledgeEntity[]>();
  for (const entity of Object.values(state.entities)) {
    if (entity.kind !== "node" || entity.workspaceId !== workspaceId) continue;
    const parent = (valueOf(state, entity, "position") as KnowledgePosition).parentNodeId;
    const siblings = children.get(parent) ?? [];
    siblings.push(entity); children.set(parent, siblings);
  }
  for (const siblings of children.values()) siblings.sort((left, right) => compareOrder((valueOf(state, left, "position") as KnowledgePosition).orderKey, (valueOf(state, right, "position") as KnowledgePosition).orderKey) || compareOrder(left.id, right.id));
  const pending = [...(children.get(ROOT_NODE) ?? [])].reverse().map(entity => ({ entity, depth: 0 }));
  while (pending.length) {
    const { entity, depth } = pending.pop()!;
    if (!isKnowledgeVisible(state, entity)) continue;
    result.push({ id: entity.id, depth, x: 32 + depth * 252, y: 32 + result.length * 84, parentNodeId: (valueOf(state, entity, "position") as KnowledgePosition).parentNodeId });
    if (!collapsed.has(entity.id)) for (const child of [...(children.get(entity.id) ?? [])].reverse()) pending.push({ entity: child, depth: depth + 1 });
  }
  return result;
};
