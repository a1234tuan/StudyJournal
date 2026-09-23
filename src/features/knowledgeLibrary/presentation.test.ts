import { describe, expect, it } from "vitest";
import { emptyKnowledgeState, ROOT_NODE, type KnowledgeEntity, type KnowledgeState, type KnowledgeUnit, type KnowledgeValue } from "./domain";
import { flattenKnowledgeOutline, knowledgeMapDrop, knowledgeMapPath, layoutKnowledgeMap } from "./presentation";

function fixture() {
  const state = emptyKnowledgeState();
  const add = (id: string, kind: KnowledgeEntity["kind"], parent = ROOT_NODE, title = id) => {
    const entity: KnowledgeEntity = { id, kind, workspaceId: "topic", nodeId: kind === "reference" ? parent : "", recordId: kind === "reference" ? "log-" + id : "", units: {} };
    state.entities[id] = entity;
    const values: Partial<Record<KnowledgeUnit, KnowledgeValue>> = { title, deleted: false, ...(kind === "workspace" ? { archived: false } : kind === "node" ? { position: { parentNodeId: parent, orderKey: id } } : {}) };
    for (const [unit, value] of Object.entries(values)) {
      const revisionId = id + ":" + unit;
      entity.units[unit as KnowledgeUnit] = revisionId;
      state.revisions[revisionId] = { id: revisionId, entityId: id, unit: unit as KnowledgeUnit, value, parents: [], commandId: revisionId };
    }
    return entity;
  };
  add("topic", "workspace");
  add("alpha", "node"); add("beta", "node"); add("gamma", "node"); add("delta", "node");
  add("alpha-child-1", "node", "alpha"); add("alpha-child-2", "node", "alpha");
  add("deep", "node", "alpha-child-1");
  return { state, add };
}
const assertNoOverlap = (state: KnowledgeState) => {
  const nodes = layoutKnowledgeMap(state, "topic", new Set()).nodes;
  for (let first = 0; first < nodes.length; first += 1) for (let second = first + 1; second < nodes.length; second += 1) {
    const left = nodes[first]; const right = nodes[second];
    expect(left.x + left.width <= right.x || right.x + right.width <= left.x || left.y + left.height <= right.y || right.y + right.height <= left.y).toBe(true);
  }
};
describe("knowledge presentation model", () => {
  it("centers the topic and distributes branches across both sides without overlaps", () => {
    const { state } = fixture(); const layout = layoutKnowledgeMap(state, "topic", new Set());
    const center = layout.nodes[0]; expect(center.id).toBe(ROOT_NODE); expect(center.x + center.width / 2).toBe(0); expect(center.y + center.height / 2).toBe(0);
    const roots = layout.nodes.filter(node => node.parentId === ROOT_NODE);
    expect(roots.some(node => node.side === -1)).toBe(true); expect(roots.some(node => node.side === 1)).toBe(true);
    const parent = layout.nodes.find(node => node.id === "alpha")!;
    const children = layout.nodes.filter(node => node.parentId === "alpha");
    expect(parent.y + parent.height / 2).toBeCloseTo((Math.min(...children.map(node => node.y)) + Math.max(...children.map(node => node.y + node.height))) / 2);
    expect(knowledgeMapPath(center, roots[0])).toMatch(/^M .* C /); assertNoOverlap(state);
  });
  it("retains side assignments when branches are added or collapsed", () => {
    const { state, add } = fixture(); const original = layoutKnowledgeMap(state, "topic", new Set());
    add("new-root", "node");
    const next = layoutKnowledgeMap(state, "topic", new Set(["alpha"]), original.sides);
    for (const [id, side] of Object.entries(original.sides)) expect(next.sides[id]).toBe(side);
    expect(next.nodes.some(node => node.id === "deep")).toBe(false);
    expect(next.nodes.find(node => node.id === "alpha")?.hasChildren).toBe(true);
    expect(next.nodes.find(node => node.id === "beta")?.hasChildren).toBe(false);
  });
  it("sizes long titles without overlapping neighboring subtrees", () => {
    const { state, add } = fixture(); add("long", "node", "beta", "这是需要完整显示的中文节点标题".repeat(8));
    const long = layoutKnowledgeMap(state, "topic", new Set()).nodes.find(node => node.id === "long")!;
    expect(long.width).toBeLessThanOrEqual(200); expect(long.height).toBeGreaterThan(60); assertNoOverlap(state);
  });
  it("lists each node's logs before its subnodes and collapses both together", () => {
    const { state, add } = fixture(); add("ref-one", "reference", "alpha"); add("ref-two", "reference", "alpha"); add("ref-deep", "reference", "deep");
    const rows = flattenKnowledgeOutline(state, "topic", new Set());
    const index = rows.findIndex(row => row.id === "alpha");
    expect(rows.slice(index, index + 4).map(row => row.kind)).toEqual(["node", "reference", "reference", "node"]);
    expect(rows[index].count).toBe(2); expect(rows[index + 1].depth).toBe(rows[index].depth + 1);
    const collapsed = flattenKnowledgeOutline(state, "topic", new Set(["alpha"]));
    expect(collapsed.some(row => row.kind === "reference")).toBe(false);
    state.revisions["ref-one:deleted"].value = true;
    expect(flattenKnowledgeOutline(state, "topic", new Set()).some(row => row.id === "ref-one")).toBe(false);
  });
  it("distinguishes reparent, before, after, root and invalid descendant drops", () => {
    const { state } = fixture(); const nodes = layoutKnowledgeMap(state, "topic", new Set()).nodes;
    const beta = nodes.find(node => node.id === "beta")!;
    const point = { x: beta.x + beta.width / 2, y: beta.y + beta.height / 2 };
    expect(knowledgeMapDrop(state, "topic", nodes, "alpha", point)).toMatchObject({ parentId: "beta", mode: "child" });
    expect(knowledgeMapDrop(state, "topic", nodes, "alpha", { ...point, y: beta.y + 2 })).toMatchObject({ parentId: ROOT_NODE, beforeId: "beta", mode: "before" });
    expect(knowledgeMapDrop(state, "topic", nodes, "alpha", { ...point, y: beta.y + beta.height - 2 })).toMatchObject({ parentId: ROOT_NODE, mode: "after" });
    const deep = nodes.find(node => node.id === "deep")!;
    expect(knowledgeMapDrop(state, "topic", nodes, "alpha", { x: deep.x + 5, y: deep.y + 20 })).toMatchObject({ mode: "invalid" });
    expect(knowledgeMapDrop(state, "topic", nodes, "deep", { x: 0, y: 0 })).toMatchObject({ parentId: ROOT_NODE, mode: "child" });
    expect(knowledgeMapDrop(state, "topic", nodes, "deep", { x: 10000, y: 10000 })).toBeUndefined();
  });
  it("renders a centered topic without inventing persisted nodes in an empty workspace", () => {
    const { state } = fixture(); for (const entity of Object.values(state.entities)) if (entity.kind === "node") state.revisions[entity.id + ":deleted"].value = true;
    const before = JSON.stringify(state); const result = layoutKnowledgeMap(state, "topic", new Set());
    expect(result.nodes.map(node => node.id)).toEqual([ROOT_NODE]); expect(JSON.stringify(state)).toBe(before);
  });
});
