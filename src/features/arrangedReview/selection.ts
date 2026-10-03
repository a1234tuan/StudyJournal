import type { RecordBlock } from "../../types";
import { ROOT_NODE, type KnowledgePosition, type KnowledgeState } from "../knowledgeLibrary/domain";
import { isKnowledgeVisible, valueOf } from "../knowledgeLibrary/protocol";
import { knowledgeChildren, knowledgeLabel } from "../knowledgeLibrary/query";
import type { ArrangedReviewItem } from "./domain";
export interface ReviewSelectionNode { id: string; title: string; workspaceId: string; depth: number; items: ArrangedReviewItem[]; descendants: string[] }
export const reviewSelectionNodes = (state: KnowledgeState, records: readonly RecordBlock[]): ReviewSelectionNode[] => {
  const recordMap = new Map(records.filter(record => !record.deletedAt).map(record => [record.id, record]));
  const result: ReviewSelectionNode[] = [];
  const visit = (workspaceId: string, parent: string, depth: number, path: string, seen: Set<string>): string[] => {
    const ids: string[] = [];
    for (const node of knowledgeChildren(state, workspaceId, parent)) {
      if (seen.has(node.id) || !isKnowledgeVisible(state, node)) continue;
      const source = path + " / " + knowledgeLabel(state, node);
      const items = Object.values(state.entities).filter(entity => entity.kind === "reference" && entity.nodeId === node.id && isKnowledgeVisible(state, entity)).sort((left, right) => String((valueOf(state, left, "position") as KnowledgePosition | undefined)?.orderKey ?? "").localeCompare(String((valueOf(state, right, "position") as KnowledgePosition | undefined)?.orderKey ?? "")) || left.id.localeCompare(right.id)).flatMap(reference => { const record = recordMap.get(reference.recordId); return record ? [{ recordId: record.id, title: record.title, source, contentRevision: record.updatedAt }] : []; });
      const entry: ReviewSelectionNode = { id: node.id, title: knowledgeLabel(state, node), workspaceId, depth, items, descendants: [] }; result.push(entry);
      entry.descendants = visit(workspaceId, node.id, depth + 1, source, new Set(seen).add(node.id)); ids.push(node.id, ...entry.descendants);
    }
    return ids;
  };
  for (const workspace of Object.values(state.entities).filter(entity => entity.kind === "workspace" && isKnowledgeVisible(state, entity) && !valueOf(state, entity, "archived"))) visit(workspace.id, ROOT_NODE, 0, knowledgeLabel(state, workspace), new Set());
  return result;
};
export const selectedReviewItems = (nodes: readonly ReviewSelectionNode[], selected: readonly string[], descendants: boolean) => {
  const scope = new Set(selected.flatMap(id => { const node = nodes.find(item => item.id === id); return [id, ...(descendants ? node?.descendants ?? [] : [])]; }));
  return [...new Map(nodes.filter(node => scope.has(node.id)).flatMap(node => node.items).map(item => [item.recordId, item])).values()];
};
