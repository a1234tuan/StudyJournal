import { ROOT_NODE } from "./domain";
import type { MapNode } from "./presentation";
import type { MapAppearance } from "./appearance";

export function layoutDirectedMap(center: MapNode, nodes: Map<string, MapNode>, children: Map<string, string[]>, structure: MapAppearance["structure"], preferred: Record<string, number>) {
  const sides: Record<string, number> = {};
  const directions = structure === "logic" ? [1] : [1, -1, 2, -2];
  const totals = new Map(directions.map(direction => [direction, 0]));
  const spans = new Map<number, Map<string, number>>();
  for (const direction of directions) {
    const vertical = Math.abs(direction) === 2;
    const sizes = new Map<string, number>();
    for (const node of [...nodes.values()].reverse()) {
      const descendants = children.get(node.id) ?? [];
      sizes.set(node.id, Math.max(vertical ? node.width : node.height, descendants.reduce((sum, id) => sum + sizes.get(id)!, 0) + Math.max(0, descendants.length - 1) * 28));
    }
    spans.set(direction, sizes);
  }
  for (const id of children.get(ROOT_NODE) ?? []) {
    const direction = directions.includes(preferred[id]) ? preferred[id] : directions.reduce((best, candidate) => totals.get(candidate)! < totals.get(best)! ? candidate : best, directions[0]);
    sides[id] = direction;
    totals.set(direction, totals.get(direction)! + spans.get(direction)!.get(id)! + 36);
  }
  const groups = new Map<number, MapNode[]>();
  for (const direction of directions) {
    const vertical = Math.abs(direction) === 2;
    const positive = direction > 0;
    const sizes = spans.get(direction)!;
    const roots = (children.get(ROOT_NODE) ?? []).filter(id => sides[id] === direction);
    let cursor = -(roots.reduce((sum, id) => sum + sizes.get(id)!, 0) + Math.max(0, roots.length - 1) * 36) / 2;
    const pending = roots.map(id => { const entry = { id, parent: center, offset: cursor, branch: Array.from(id).reduce((sum, letter) => sum + letter.charCodeAt(0), 0) % 3 }; cursor += sizes.get(id)! + 36; return entry; });
    const group: MapNode[] = [];
    while (pending.length) {
      const current = pending.pop()!;
      const node = nodes.get(current.id)!;
      node.side = positive ? 1 : -1;
      node.direction = vertical ? positive ? "bottom" : "top" : positive ? "right" : "left";
      node.branch = current.branch;
      const across = current.offset + sizes.get(node.id)! / 2;
      if (vertical) { node.x = across - node.width / 2; node.y = positive ? current.parent.y + current.parent.height + 64 : current.parent.y - node.height - 64; }
      else { node.y = across - node.height / 2; node.x = positive ? current.parent.x + current.parent.width + 64 : current.parent.x - node.width - 64; }
      group.push(node);
      const descendants = children.get(node.id) ?? [];
      const total = descendants.reduce((sum, id) => sum + sizes.get(id)!, 0) + Math.max(0, descendants.length - 1) * 28;
      let offset = across - total / 2;
      for (const id of descendants) { pending.push({ id, parent: node, offset, branch: node.branch }); offset += sizes.get(id)! + 28; }
    }
    groups.set(direction, group);
  }
  const verticalNodes = [...groups.get(2) ?? [], ...groups.get(-2) ?? []];
  if (verticalNodes.length) {
    const leftEdge = Math.min(center.x, ...verticalNodes.map(node => node.x));
    const rightEdge = Math.max(center.x + center.width, ...verticalNodes.map(node => node.x + node.width));
    for (const direction of [-1, 1]) {
      const group = groups.get(direction) ?? [];
      if (!group.length) continue;
      const shift = direction === -1 ? Math.min(0, leftEdge - 64 - Math.max(...group.map(node => node.x + node.width))) : Math.max(0, rightEdge + 64 - Math.min(...group.map(node => node.x)));
      for (const node of group) node.x += shift;
    }
  }
  return { nodes: [center, ...nodes.values()], sides };
}
