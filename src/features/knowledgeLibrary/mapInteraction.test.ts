import { describe, expect, it } from "vitest";
import { mapNeighbor, mapDropPreview, type MapNode } from "./presentation";
import { initialKnowledgeNavigation, patchKnowledgeNavigation, restoreKnowledgeNavigation } from "./navigation";
const node = (id: string, x: number, y: number, parentId = "@root", side: -1 | 0 | 1 = 1): MapNode => ({ id, x, y, parentId, side, width: 80, height: 40, branch: 0, depth: 0, count: 0, hasChildren: false });
const nodes = [node("@root", -150, 100, "", 0), node("center", 100, 100), node("above", 100, 0), node("below", 100, 200), node("left", -50, 100), node("child", 250, 100, "center")];
describe("map keyboard and dock navigation", () => {
  it.each([["ArrowUp", "above"], ["ArrowDown", "below"], ["ArrowLeft", "left"], ["ArrowRight", "child"]] as const)("moves %s to %s", (direction, expected) => expect(mapNeighbor(nodes, "center", direction)).toBe(expected));
  it("ignores missing selections, hidden nodes and the display root", () => {
    expect(mapNeighbor(nodes, undefined, "ArrowRight")).toBeUndefined();
    expect(mapNeighbor(nodes.filter(item => item.id !== "child"), "center", "ArrowRight")).toBeUndefined();
    expect(mapNeighbor(nodes, "left", "ArrowLeft")).toBeUndefined();
  });
  it("prefers the actual parent over unrelated nearer nodes", () => expect(mapNeighbor([...nodes, node("near", 220, 100)], "child", "ArrowLeft")).toBe("center"));
  it.each(["child", "before", "after", "invalid"] as const)("previews %s without mutating layout", mode => {
    const before = JSON.stringify(nodes);
    const preview = mapDropPreview(nodes, "above", { targetId: "center", parentId: mode === "child" || mode === "invalid" ? "center" : "@root", mode });
    expect(preview?.path).toMatch(/^M /);
    expect(preview?.slot.id).toBe("above");
    if (mode === "before") expect(preview!.slot.y + preview!.slot.height).toBeLessThan(100);
    if (mode === "after") expect(preview!.slot.y).toBeGreaterThan(140);
    if (mode === "child") expect(preview!.slot.x).toBeGreaterThan(180);
    expect(JSON.stringify(nodes)).toBe(before);
  });
  it("appends child previews below the target subtree, excluding the moving branch", () => {
    const layout = [...nodes, node("grandchild", 400, 240, "child"), node("moving-child", 250, 600, "above")];
    const preview = mapDropPreview(layout, "above", { targetId: "center", parentId: "center", mode: "child" });
    expect(preview!.slot.y).toBe(300);
  });
  it("uses left-facing slots for left branches", () => {
    const preview = mapDropPreview([node("parent", -200, 0, "@root", -1), node("source", 0, 0)], "source", { targetId: "parent", parentId: "parent", mode: "child" });
    expect(preview!.slot.x + preview!.slot.width).toBeLessThan(-200);
  });
  it("clears previews on context changes but preserves layout preferences", () => {
    const current = { ...initialKnowledgeNavigation(), libraryId: "lib", workspaceId: "topic", selectedNodeId: "node", recordPreviewId: "log", recordPreviewScroll: 500, recordPaneWidth: 480, sidebarCollapsed: true };
    for (const patch of [{ workspaceId: "other" }, { libraryId: "other" }, { selectedNodeId: "other" }, { detailsOpen: false }]) {
      const next = patchKnowledgeNavigation(current, patch);
      expect(next.recordPreviewId).toBeUndefined(); expect(next.recordPreviewScroll).toBe(0); expect(next.recordPaneWidth).toBe(480); expect(next.sidebarCollapsed).toBe(true);
    }
    expect(patchKnowledgeNavigation(current, { panX: 30 }).recordPreviewId).toBe("log");
  });
  it("sanitizes local history widths and preserves preview return context", () => {
    expect(restoreKnowledgeNavigation({ recordPaneWidth: 10000, recordPreviewScroll: -50, recordPreviewId: "log", selectedNodeId: "node", detailsOpen: true, sidebarCollapsed: true })).toMatchObject({ recordPaneWidth: 560, recordPreviewScroll: 0, recordPreviewId: "log", selectedNodeId: "node", detailsOpen: true, sidebarCollapsed: true });
    expect(restoreKnowledgeNavigation({ recordPaneWidth: NaN }).recordPaneWidth).toBe(420);
  });
});
