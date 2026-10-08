import { liveQuery } from "dexie";
import { db } from "../../db/database";
import { getDefaultKnowledgeLibrary } from "../knowledgeLibrary/defaultLibrary";
import { currentKnowledgeOwner } from "../knowledgeLibrary/context";
import { knowledgeRepository } from "../knowledgeLibrary/runtime";
import { reviewSelectionNodes, type ReviewSelectionNode } from "./selection";
import { useEffect, useMemo, useState } from "react";
import type { RecordBlock, RecordReviewState } from "../../types";
import { isReviewDueOn } from "../../lib/reviewScheduler";
import { todayISO } from "../../lib/date";
import "./arrangedReview.css";
export function DueReviewBoard({ records, due, onStart }: { records: readonly RecordBlock[]; due: readonly RecordReviewState[]; onStart: (ids: string[]) => void }) {
  const [scope, setScope] = useState("");
  const [nodes, setNodes] = useState<ReviewSelectionNode[]>([]);
  useEffect(() => { const subscription = liveQuery(async () => { const library = await getDefaultKnowledgeLibrary(db, currentKnowledgeOwner()); return library ? reviewSelectionNodes((await knowledgeRepository.open(library.id)).state, records) : []; }).subscribe({ next: setNodes, error: () => setNodes([]) }); return () => subscription.unsubscribe(); }, [records]);
  const scopeNode = nodes.find(node => node.id === scope);
  const scopedIds = scope ? new Set(nodes.filter(node => node.id === scope || scopeNode?.descendants.includes(node.id) || node.workspaceId === scope).flatMap(node => node.items.map(item => item.recordId))) : undefined;
  const [query, setQuery] = useState(""); const [subject, setSubject] = useState(""); const [selected, setSelected] = useState<string[]>([]);
  const dueMap = useMemo(() => new Map(due.filter(item => isReviewDueOn(item, todayISO())).map(item => [item.recordId, item])), [due]);
  const items = records.filter(record => dueMap.has(record.id) && (!scopedIds || scopedIds.has(record.id)) && (!subject || record.subject === subject) && (!query || [record.title, record.subject, ...(record.tags ?? [])].join(" ").includes(query))).sort((left, right) => (dueMap.get(left.id)?.nextReviewDate ?? "").localeCompare(dueMap.get(right.id)?.nextReviewDate ?? "") || left.id.localeCompare(right.id));
  const availableSelected = selected.filter(id => records.some(record => record.id === id && dueMap.has(id)));
  const hiddenSelected = availableSelected.filter(id => !items.some(item => item.id === id)).length;
  return <section className="due-review-board" aria-label="待复习日志">
    <div className="review-board-search"><input aria-label="搜索待复习日志" placeholder="搜索标题或标签" value={query} onChange={event => setQuery(event.target.value)} /><details className="review-board-filters"><summary>筛选{scope || subject ? " · 已启用" : ""}</summary><div className="arranged-filter">
      <select aria-label="筛选知识库范围" value={scope} onChange={event => setScope(event.target.value)}><option value="">全部知识库范围</option>{[...new Set(nodes.map(node => node.workspaceId))].map(id => <optgroup key={id} label={nodes.find(node => node.workspaceId === id)?.items[0]?.source.split(" / ")[0] ?? "知识库专题"}><option value={id}>整个专题</option>{nodes.filter(node => node.workspaceId === id).map(node => <option key={node.id} value={node.id}>{"　".repeat(Math.min(node.depth, 4)) + node.title}</option>)}</optgroup>)}</select>
      <select aria-label="筛选科目" value={subject} onChange={event => setSubject(event.target.value)}><option value="">全部科目</option>{[...new Set(records.filter(record => dueMap.has(record.id)).map(record => record.subject))].map(value => <option key={value}>{value}</option>)}</select>
    </div></details></div>
    <div className="review-board-list-meta"><span>{items.length} 条待复习</span><button type="button" className="link-button" disabled={!items.length} onClick={() => setSelected(current => [...new Set([...current, ...items.map(item => item.id)])])}>全选当前列表</button></div>
    <div className="arranged-list review-board-scroll" tabIndex={0} aria-label="待复习日志列表">{items.map(item => <div className="arranged-row" key={item.id}>
      <input aria-label={"选择 " + item.title} type="checkbox" checked={availableSelected.includes(item.id)} onChange={event => setSelected(current => event.target.checked ? [...current, item.id] : current.filter(id => id !== item.id))} />
      <button className="review-board-record" onClick={() => onStart([item.id])}><strong>{item.title}</strong><small>{item.subject} · {dueMap.get(item.id)?.nextReviewDate}</small></button>
    </div>)}{!items.length && <p className="review-board-empty">{dueMap.size ? "没有符合筛选条件的日志" : "当前没有到期的日志"}</p>}</div>
    {availableSelected.length > 0 ? <footer className="review-board-selection"><span>已选 {availableSelected.length} 条{hiddenSelected > 0 && <small>含筛选外 {hiddenSelected} 条</small>}</span><button type="button" className="link-button" onClick={() => setSelected([])}>清空</button><button className="primary-button" onClick={() => onStart(availableSelected)}>开始所选复习</button></footer> : <p className="review-board-hint">点击日志开始复习，勾选可批量复习</p>}
  </section>;
}
