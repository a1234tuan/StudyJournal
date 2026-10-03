import { describe, it, expect } from "vitest";
import { selectedReviewItems, type ReviewSelectionNode } from "./selection";
const item = (recordId: string) => ({ recordId, title: recordId, source: "算法", contentRevision: "v1" });
const nodes: ReviewSelectionNode[] = [{ id: "parent", title: "排序", workspaceId: "workspace", depth: 0, items: [item("first")], descendants: ["child"] }, { id: "child", title: "快排", workspaceId: "workspace", depth: 1, items: [item("first"), item("second")], descendants: [] }, { id: "other", title: "树", workspaceId: "other-workspace", depth: 0, items: [item("third")], descendants: [] }];
describe("knowledge selection union", () => {
  it("includes descendants and deduplicates parent-child overlap", () => { expect(selectedReviewItems(nodes, ["parent", "child"], true).map(item => item.recordId)).toEqual(["first", "second"]); });
  it("supports direct node only", () => { expect(selectedReviewItems(nodes, ["parent"], false).map(item => item.recordId)).toEqual(["first"]); });
  it("retains selections across workspaces in outline order", () => { expect(selectedReviewItems(nodes, ["other", "parent"], true).map(item => item.recordId)).toEqual(["first", "second", "third"]); });
});
