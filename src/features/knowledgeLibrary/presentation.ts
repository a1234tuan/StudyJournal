import { ROOT_NODE, type KnowledgePosition, type KnowledgeState } from "./domain";
import { isKnowledgeVisible, valueOf } from "./protocol";
import { knowledgeChildren, knowledgeLabel, layoutKnowledgeTree } from "./query";

export interface MapNode { id: string; parentId: string; x: number; y: number; width: number; height: number; side: -1 | 0 | 1; branch: number; depth: number; count: number; hasChildren: boolean }
export interface MapDrop { targetId: string; parentId: string; beforeId?: string; mode: "child" | "before" | "after" | "invalid" }
export type MapDirection = "ArrowUp" | "ArrowDown" | "ArrowLeft" | "ArrowRight";
export function mapDropPreview(nodes: MapNode[], sourceId: string, drop: MapDrop) {
  const source = nodes.find(node => node.id === sourceId);
  const target = nodes.find(node => node.id === drop.targetId);
  const parent = nodes.find(node => node.id === drop.parentId);
  if (!source || !target || !parent) return undefined;
  const side = target.side || source.side || 1;
  const parents = new Map(nodes.map(node => [node.id, node.parentId]));
  const descendsFrom = (id: string, ancestor: string) => {
    const visited = new Set<string>();
    while (id && !visited.has(id)) {
      if (id === ancestor) return true;
      visited.add(id); id = parents.get(id) ?? "";
    }
    return false;
  };
  const descendants = nodes.filter(node => node.id !== target.id && descendsFrom(node.id, target.id) && !descendsFrom(node.id, sourceId));
  const childTop = descendants.length ? Math.max(...descendants.map(node => node.y + node.height)) + 20 : target.y + (target.height - source.height) / 2;
  const slot: MapNode = { ...source, side, x: drop.mode === "child" || drop.mode === "invalid" ? side === 1 ? target.x + target.width + 64 : target.x - 64 - source.width : target.x, y: drop.mode === "before" ? target.y - source.height - 20 : drop.mode === "after" ? target.y + target.height + 20 : childTop };
  return { slot, path: knowledgeMapPath(parent, slot), x: side === 1 ? slot.x : slot.x + slot.width, y: slot.y + slot.height / 2 };
}
export interface OutlineRow { id: string; nodeId: string; depth: number; kind: "node" | "reference"; count: number; expandable: boolean }

export function mapNeighbor(nodes: MapNode[], selectedId: string | undefined, direction: MapDirection): string | undefined {
  if (!selectedId) return undefined;
  const source = nodes.find(node => node.id === selectedId);
  if (!source) return undefined;
  const sourceCenter = { x: source.x + source.width / 2, y: source.y + source.height / 2 };
  const candidates = nodes
    .filter(node => node.id !== ROOT_NODE && node.id !== selectedId)
    .map(node => {
      const center = { x: node.x + node.width / 2, y: node.y + node.height / 2 };
      const dx = center.x - sourceCenter.x;
      const dy = center.y - sourceCenter.y;
      const horizontal = direction === "ArrowLeft" || direction === "ArrowRight";
      const primary = horizontal ? Math.abs(dx) : Math.abs(dy);
      const secondary = horizontal ? Math.abs(dy) : Math.abs(dx);
      const forward = direction === "ArrowLeft" ? dx < 0 : direction === "ArrowRight" ? dx > 0 : direction === "ArrowUp" ? dy < 0 : dy > 0;
      if (!forward) return undefined;
      const sourceStart = horizontal ? source.y : source.x;
      const sourceEnd = horizontal ? source.y + source.height : source.x + source.width;
      const candidateStart = horizontal ? node.y : node.x;
      const candidateEnd = horizontal ? node.y + node.height : node.x + node.width;
      const aligned = candidateStart < sourceEnd && candidateEnd > sourceStart;
      return { id: node.id, primary, secondary, aligned };
    })
    .filter((candidate): candidate is { id: string; primary: number; secondary: number; aligned: boolean } => Boolean(candidate));
  const horizontal = direction === "ArrowLeft" || direction === "ArrowRight";
  const relatives = horizontal ? candidates.filter(candidate => candidate.id === source.parentId || nodes.find(node => node.id === candidate.id)?.parentId === source.id) : [];
  const choices = relatives.length ? relatives : candidates;
  choices.sort((left, right) => {
    if (left.aligned !== right.aligned) return left.aligned ? -1 : 1;
    return left.primary - right.primary || left.secondary - right.secondary || left.id.localeCompare(right.id);
  });
  return choices[0]?.id;
}
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
const dimensions = (title: string, count = 0, center = false, measure?: (title: string) => number) => {
  const textWidth = measure ? measure(title) * (center ? 1.125 : 1) : Array.from(title).reduce((sum, character) => sum + (/[^\x00-\xff]/.test(character) ? 16 : 9), 0);
  const reserve = count ? 86 + Math.max(0, String(count).length - 2) * 9 : 28;
  const width = Math.min(center ? 264 : 240, Math.max(center ? 176 : 108, textWidth + reserve));
  const height = Math.max(center ? 60 : 44, Math.ceil(textWidth / (width - reserve)) * 24 + 20);
  return { width, height };
};
export function layoutKnowledgeMap(state: KnowledgeState, workspaceId: string, collapsed: ReadonlySet<string>, preferredSides: Record<string, number> = {}, draft?: { id: string; parentId: string; afterId?: string }, measure?: (title: string) => number) {
  const rows = layoutKnowledgeTree(state, workspaceId, draft ? new Set([...collapsed].filter(id => id !== draft.parentId)) : collapsed);
  if (draft && !rows.some(row => row.id === draft.id)) {
    const parent = rows.find(row => row.id === draft.parentId);
    if (draft.parentId === ROOT_NODE || parent) {
      const anchor = draft.afterId ? rows.findIndex(row => row.id === draft.afterId) : parent ? rows.indexOf(parent) : -1;
      let insert = anchor < 0 ? rows.length : anchor + 1;
      if (anchor >= 0) while (insert < rows.length && rows[insert].depth > rows[anchor].depth) insert += 1;
      rows.splice(insert, 0, { id: draft.id, parentNodeId: draft.parentId, depth: parent ? parent.depth + 1 : 0, x: 0, y: 0 });
    }
  }
  const references = knowledgeReferenceIndex(state);
  const children = new Map<string, string[]>();
  const allParents = new Set(Object.values(state.entities).filter(entity => entity.kind === "node" && entity.workspaceId === workspaceId && isKnowledgeVisible(state, entity)).map(entity => (valueOf(state, entity, "position") as KnowledgePosition).parentNodeId));
  const nodes = new Map<string, MapNode>();
  const centerSize = dimensions(knowledgeLabel(state, state.entities[workspaceId]), 0, true, measure);
  const center: MapNode = { id: ROOT_NODE, parentId: "", x: -centerSize.width / 2, y: -centerSize.height / 2, ...centerSize, side: 0, branch: 0, depth: -1, count: 0, hasChildren: false };
  for (const row of rows) {
    const siblings = children.get(row.parentNodeId) ?? [];
    siblings.push(row.id); children.set(row.parentNodeId, siblings);
    const count = references.get(row.id)?.length ?? 0;
    nodes.set(row.id, { id: row.id, parentId: row.parentNodeId, x: 0, y: 0, ...(row.id === draft?.id ? { width: 300, height: 48 } : dimensions(knowledgeLabel(state, state.entities[row.id]), count, false, measure)), side: 1, branch: 0, depth: row.depth, count, hasChildren: allParents.has(row.id) });
  }
  const spans = new Map<string, number>();
  for (const row of [...rows].reverse()) {
    const descendants = children.get(row.id) ?? [];
    spans.set(row.id, Math.max(nodes.get(row.id)!.height, descendants.reduce((sum, id) => sum + spans.get(id)!, 0) + Math.max(0, descendants.length - 1) * 20));
  }
  const sides: Record<string, number> = {};
  let leftHeight = 0; let rightHeight = 0;
  for (const id of children.get(ROOT_NODE) ?? []) {
    const preferred = id === draft?.id && draft.afterId ? sides[draft.afterId] : preferredSides[id];
    const side = preferred === -1 ? -1 : preferred === 1 ? 1 : rightHeight <= leftHeight ? 1 : -1;
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
