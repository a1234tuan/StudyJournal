import { ROOT_NODE, type KnowledgePosition, type KnowledgeState } from "./domain";
import { isKnowledgeVisible, valueOf } from "./protocol";
import { knowledgeChildren, knowledgeLabel, layoutKnowledgeTree } from "./query";

export interface MapNode { id: string; parentId: string; x: number; y: number; width: number; height: number; side: -1 | 0 | 1; branch: number; depth: number; count: number; hasChildren: boolean }
export interface MapDrop { targetId: string; parentId: string; beforeId?: string; mode: "child" | "before" | "after" | "invalid" }
export interface OutlineRow { id: string; nodeId: string; depth: number; kind: "node" | "reference"; count: number; expandable: boolean }
export function knowledgeReferenceIndex(state: KnowledgeState) {
  const index = new Map<string, string[]>();
  for (const entity of Object.values(state.entities)) if (entity.kind === "reference" && isKnowledgeVisible(state, entity)) {
    const references = index.get(entity.nodeId) ?? [];
    references.push(entity.id); index.set(entity.nodeId, references);
  }
  for (const references of index.values()) references.sort();
  return index;
}
export function flattenKnowledgeOutline(state: KnowledgeState, workspaceId: string, collapsed: ReadonlySet<string>): OutlineRow[] {
  const layout = layoutKnowledgeTree(state, workspaceId, collapsed);
  const references = knowledgeReferenceIndex(state);
  const parents = new Set(Object.values(state.entities).filter(entity => entity.kind === "node" && isKnowledgeVisible(state, entity)).map(entity => (valueOf(state, entity, "position") as KnowledgePosition).parentNodeId));
  const rows: OutlineRow[] = [];
  for (const node of layout) {
    const items = references.get(node.id) ?? [];
    rows.push({ id: node.id, nodeId: node.id, depth: node.depth, kind: "node", count: items.length, expandable: items.length > 0 || parents.has(node.id) });
    if (!collapsed.has(node.id)) for (const id of items) rows.push({ id, nodeId: node.id, depth: node.depth + 1, kind: "reference", count: 0, expandable: false });
  }
  return rows;
}
const dimensions = (title: string, count = 0, center = false) => {
  const textWidth = Array.from(title).reduce((sum, character) => sum + (/[^\x00-\xff]/.test(character) ? 15 : 9), 0);
  const reserve = count ? 54 : 28;
  const width = Math.min(center ? 224 : 200, Math.max(center ? 144 : 88, textWidth + reserve));
  const height = Math.max(center ? 52 : 40, Math.ceil(textWidth / (width - reserve)) * 20 + 20);
  return { width, height };
};
export function layoutKnowledgeMap(state: KnowledgeState, workspaceId: string, collapsed: ReadonlySet<string>, preferredSides: Record<string, number> = {}) {
  const rows = layoutKnowledgeTree(state, workspaceId, collapsed);
  const references = knowledgeReferenceIndex(state);
  const children = new Map<string, string[]>();
  const allParents = new Set(Object.values(state.entities).filter(entity => entity.kind === "node" && entity.workspaceId === workspaceId && isKnowledgeVisible(state, entity)).map(entity => (valueOf(state, entity, "position") as KnowledgePosition).parentNodeId));
  const nodes = new Map<string, MapNode>();
  const centerSize = dimensions(knowledgeLabel(state, state.entities[workspaceId]), 0, true);
  const center: MapNode = { id: ROOT_NODE, parentId: "", x: -centerSize.width / 2, y: -centerSize.height / 2, ...centerSize, side: 0, branch: 0, depth: -1, count: 0, hasChildren: false };
  for (const row of rows) {
    const siblings = children.get(row.parentNodeId) ?? [];
    siblings.push(row.id); children.set(row.parentNodeId, siblings);
    const count = references.get(row.id)?.length ?? 0;
    nodes.set(row.id, { id: row.id, parentId: row.parentNodeId, x: 0, y: 0, ...dimensions(knowledgeLabel(state, state.entities[row.id]), count), side: 1, branch: 0, depth: row.depth, count, hasChildren: allParents.has(row.id) });
  }
  const spans = new Map<string, number>();
  for (const row of [...rows].reverse()) {
    const descendants = children.get(row.id) ?? [];
    spans.set(row.id, Math.max(nodes.get(row.id)!.height, descendants.reduce((sum, id) => sum + spans.get(id)!, 0) + Math.max(0, descendants.length - 1) * 20));
  }
  const sides: Record<string, number> = {};
  let leftHeight = 0; let rightHeight = 0;
  for (const id of children.get(ROOT_NODE) ?? []) {
    const side = preferredSides[id] === -1 ? -1 : preferredSides[id] === 1 ? 1 : rightHeight <= leftHeight ? 1 : -1;
    sides[id] = side;
    if (side === -1) leftHeight += spans.get(id)! + 28; else rightHeight += spans.get(id)! + 28;
  }
  for (const side of [-1, 1] as const) {
    const roots = (children.get(ROOT_NODE) ?? []).filter(id => sides[id] === side);
    let cursor = -(roots.reduce((sum, id) => sum + spans.get(id)!, 0) + Math.max(0, roots.length - 1) * 28) / 2;
    const pending: Array<{ id: string; parent: MapNode; top: number; branch: number }> = [];
    for (const id of roots) {
      const branch = Array.from(id).reduce((sum, character) => sum + character.charCodeAt(0), 0) % 3;
      pending.push({ id, parent: center, top: cursor, branch }); cursor += spans.get(id)! + 28;
    }
    while (pending.length) {
      const current = pending.pop()!;
      const node = nodes.get(current.id)!;
      node.side = side; node.branch = current.branch;
      node.x = side === 1 ? current.parent.x + current.parent.width + 64 : current.parent.x - 64 - node.width;
      node.y = current.top + spans.get(node.id)! / 2 - node.height / 2;
      const descendants = children.get(node.id) ?? [];
      const total = descendants.reduce((sum, id) => sum + spans.get(id)!, 0) + Math.max(0, descendants.length - 1) * 20;
      let childTop = node.y + node.height / 2 - total / 2;
      for (const id of descendants) { pending.push({ id, parent: node, top: childTop, branch: node.branch }); childTop += spans.get(id)! + 20; }
    }
  }
  return { nodes: [center, ...rows.map(row => nodes.get(row.id)!)], sides };
}
export function knowledgeMapPath(parent: MapNode, child: MapNode) {
  const startX = child.side === 1 ? parent.x + parent.width : parent.x;
  const endX = child.side === 1 ? child.x : child.x + child.width;
  const middle = (startX + endX) / 2;
  return "M " + startX + " " + (parent.y + parent.height / 2) + " C " + middle + " " + (parent.y + parent.height / 2) + ", " + middle + " " + (child.y + child.height / 2) + ", " + endX + " " + (child.y + child.height / 2);
}
export function knowledgeMapDrop(state: KnowledgeState, workspaceId: string, nodes: MapNode[], sourceId: string, point: { x: number; y: number }): MapDrop | undefined {
  const target = nodes.find(node => point.x >= node.x - 12 && point.x <= node.x + node.width + 12 && point.y >= node.y - 8 && point.y <= node.y + node.height + 8);
  if (!target) return undefined;
  let ancestor = target.id;
  while (ancestor !== ROOT_NODE) {
    if (ancestor === sourceId) return { targetId: target.id, parentId: target.id, mode: "invalid" };
    const entity = state.entities[ancestor];
    if (!entity) return undefined;
    ancestor = (valueOf(state, entity, "position") as KnowledgePosition).parentNodeId;
  }
  const fraction = (point.y - target.y) / target.height;
  const mode = target.id === ROOT_NODE || (fraction > .25 && fraction < .75) ? "child" : fraction <= .25 ? "before" : "after";
  if (mode === "child") return { targetId: target.id, parentId: target.id, mode };
  const siblings = knowledgeChildren(state, workspaceId, target.parentId).filter(entity => entity.id !== sourceId);
  const beforeId = mode === "before" ? target.id : siblings[siblings.findIndex(entity => entity.id === target.id) + 1]?.id;
  return { targetId: target.id, parentId: target.parentId, beforeId, mode };
}
