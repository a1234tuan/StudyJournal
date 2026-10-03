import { newId } from "../../lib/entity";
import { formatActionableError } from "../../lib/uiError";
import { useEffect, useMemo, useRef, useState } from "react";
import type { RecordBlock } from "../../types";
import type { KnowledgeState } from "../knowledgeLibrary/domain";
import { knowledgeLabel } from "../knowledgeLibrary/query";
import { reviewSelectionNodes, selectedReviewItems } from "./selection";
import type { ArrangedReviewItem } from "./domain";
import "./arrangedReview.css";
export function ReviewSelection({ state, records, initialNodeId, initialWorkspaceId, onClose, onCreate }: { state: KnowledgeState; records: readonly RecordBlock[]; initialNodeId?: string; initialWorkspaceId?: string; onClose: () => void; onCreate: (title: string, items: ArrangedReviewItem[], operationId: string) => Promise<void> }) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const operationId = useRef(newId());
  useEffect(() => { const dialog = dialogRef.current; dialog?.showModal(); return () => dialog?.close(); }, []);
  const nodes = useMemo(() => reviewSelectionNodes(state, records), [state, records]);
  const [selected, setSelected] = useState<string[]>(initialNodeId ? [initialNodeId] : []);
  const [workspaceId, setWorkspaceId] = useState(initialWorkspaceId ?? nodes[0]?.workspaceId ?? "");
  const [descendants, setDescendants] = useState(true);
  const [excluded, setExcluded] = useState<string[]>([]);
  const [extra, setExtra] = useState<ArrangedReviewItem[]>([]);
  const [query, setQuery] = useState("");
  const [title, setTitle] = useState(knowledgeLabel(state, state.entities[initialWorkspaceId ?? ""]) === "暂不可用" ? "已安排的复习" : knowledgeLabel(state, state.entities[initialWorkspaceId ?? ""]));
  const [busy, setBusy] = useState(false); const [error, setError] = useState("");
  const items = [...new Map([...selectedReviewItems(nodes, selected, descendants), ...extra].map(item => [item.recordId, item])).values()].filter(item => !excluded.includes(item.recordId));
  const visibleNodes = nodes.filter(node => node.workspaceId === workspaceId && (!query || node.title.includes(query) || node.items.some(item => item.title.includes(query))));
  const toggle = (id: string) => setSelected(current => current.includes(id) ? current.filter(value => value !== id) : [...current, id]);
  return <dialog ref={dialogRef} className="arranged-selection" aria-label="安排复习" onCancel={event => { event.preventDefault(); if (!busy) onClose(); }}>
    <header><button className="secondary-button" onClick={onClose} disabled={busy}>取消</button><h2>安排复习</h2><strong>已选 {items.length} 条</strong></header>
    <input aria-label="复习名称" value={title} onChange={event => setTitle(event.target.value)} maxLength={160} />
    <div className="arranged-filter"><select aria-label="选择知识库专题" value={workspaceId} onChange={event => setWorkspaceId(event.target.value)}>{[...new Set(nodes.map(node => node.workspaceId))].map(id => <option key={id} value={id}>{knowledgeLabel(state, state.entities[id])}</option>)}</select><label><input type="checkbox" checked={descendants} onChange={event => setDescendants(event.target.checked)} />包含子节点</label></div>
    <input aria-label="搜索节点或日志" placeholder="搜索节点或日志" value={query} onChange={event => setQuery(event.target.value)} />
    <div className="arranged-selection-content">{visibleNodes.length ? visibleNodes.map(node => <section key={node.id} className="arranged-selection-node" style={{ marginLeft: Math.min(node.depth, 4) * 12 }}><label><input type="checkbox" checked={selected.includes(node.id)} onChange={() => toggle(node.id)} /><strong>{node.title}</strong><small>{node.items.length}</small></label>{node.items.map(item => <label key={item.recordId}><input type="checkbox" checked={items.some(selectedItem => selectedItem.recordId === item.recordId)} onChange={event => { if (event.target.checked) { setExcluded(current => current.filter(id => id !== item.recordId)); setExtra(current => [...current.filter(value => value.recordId !== item.recordId), item]); } else { setExcluded(current => [...current, item.recordId]); setExtra(current => current.filter(value => value.recordId !== item.recordId)); } }} />{item.title}</label>)}</section>) : <p className="arranged-selection-empty">没有匹配的节点或日志</p>}</div>
    <details><summary>查看已选日志</summary>{items.map(item => <div className="arranged-selected-item" key={item.recordId}><span>{item.title}<small>{item.source}</small></span><button aria-label={"移除 " + item.title} onClick={() => setExcluded(current => [...current, item.recordId])}>移除</button></div>)}</details>
    {error && <p role="alert">{error}</p>}<footer><button className="primary-button" disabled={busy || !items.length} onClick={() => { setBusy(true); setError(""); void onCreate(title, items, operationId.current).catch(reason => setError(formatActionableError(reason, "review-feedback"))).finally(() => setBusy(false)); }}>{busy ? "创建中…" : "创建复习"}</button></footer>
  </dialog>;
}
