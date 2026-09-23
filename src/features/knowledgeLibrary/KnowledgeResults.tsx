import { useDeferredValue, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Search, SlidersHorizontal, X } from "lucide-react";
import type { BackupAssetMeta, RecordBlock } from "../../types";
import type { KnowledgeState } from "./domain";
import { searchKnowledge, type KnowledgeHit } from "./query";

export function KnowledgeVirtualList<Item>({ items, itemKey, renderItem, resetKey = "", label, rowHeight = 60 }: { items: readonly Item[]; itemKey: (item: Item) => string; renderItem: (item: Item) => ReactNode; resetKey?: string; label: string; rowHeight?: number }) {
  const viewport = useRef<HTMLDivElement>(null);
  const [scroll, setScroll] = useState(0);
  const [height, setHeight] = useState(480);
  useEffect(() => { setScroll(0); if (viewport.current) viewport.current.scrollTop = 0; }, [resetKey]);
  useEffect(() => {
    if (!viewport.current) return;
    const observer = new ResizeObserver(entries => setHeight(entries[0].contentRect.height));
    observer.observe(viewport.current);
    return () => observer.disconnect();
  }, []);
  const start = Math.max(0, Math.floor(scroll / rowHeight) - 4);
  const end = Math.min(items.length, start + Math.ceil(height / rowHeight) + 9);
  return <div className="knowledge-results" ref={viewport} aria-label={label} onScroll={event => setScroll(event.currentTarget.scrollTop)}>
    <div style={{ height: items.length * rowHeight, position: "relative" }}>
      {items.slice(start, end).map((item, index) => <div className="knowledge-result-row" key={itemKey(item)} style={{ position: "absolute", top: (start + index) * rowHeight, height: rowHeight, left: 0, right: 0 }}>{renderItem(item)}</div>)}
    </div>
  </div>;
}

interface Props {
  state: KnowledgeState;
  records: readonly RecordBlock[];
  assets: readonly BackupAssetMeta[];
  workspaceId?: string;
  mode: "search" | "unorganized" | "picker";
  selected: string[];
  onSelected: (ids: string[]) => void;
  onOpen: (hit: KnowledgeHit) => void;
  footer?: ReactNode;
}
export function KnowledgeResults({ state, records, assets, workspaceId, mode, selected, onSelected, onOpen, footer }: Props) {
  const [query, setQuery] = useState("");
  const deferredQuery = useDeferredValue(query);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [subject, setSubject] = useState("");
  const [tag, setTag] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [year, setYear] = useState("");
  const [body, setBody] = useState(false);
  const [all, setAll] = useState(!workspaceId || mode !== "search");
  const [hidden, setHidden] = useState(false);
  const options = useMemo(() => {
    const live = records.filter(record => !record.deletedAt);
    return { subjects: [...new Set(live.map(record => record.subject))].sort(), tags: [...new Set(live.flatMap(record => record.tags))].sort(), years: [...new Set(live.map(record => record.date.slice(0, 4)))].sort().reverse(), records: new Map(live.map(record => [record.id, record])) };
  }, [records]);
  const invalidDates = Boolean(from && to && from > to);
  const hits = useMemo(() => invalidDates ? [] : searchKnowledge(state, records, { text: deferredQuery, workspaceId: all ? undefined : workspaceId, subject: subject || undefined, tag: tag || undefined, from: from || undefined, to: to || undefined, includeBody: body, includeHidden: hidden, unorganized: mode === "unorganized" }, assets).filter(hit => mode === "search" || hit.recordId), [state, records, assets, deferredQuery, all, workspaceId, subject, tag, from, to, body, hidden, mode, invalidDates]);
  const chips = [subject && { text: subject, clear: () => setSubject("") }, tag && { text: tag, clear: () => setTag("") }, (from || to) && { text: year || (from || "不限") + " 至 " + (to || "不限"), clear: () => { setFrom(""); setTo(""); setYear(""); } }].filter((chip): chip is { text: string; clear: () => void } => Boolean(chip));
  const resetKey = [deferredQuery, subject, tag, from, to, body, all, hidden].join("|");
  return <section className="knowledge-search" aria-label={mode === "picker" ? "选择日志" : "知识检索"}>
    <div className="knowledge-search-bar"><Search size={18} aria-hidden="true" /><input autoFocus aria-label={mode === "picker" ? "查找要关联的日志" : "检索知识库"} placeholder={mode === "search" ? "搜索专题、节点或日志" : "搜索日志"} value={query} onChange={event => setQuery(event.target.value)} /><button type="button" className="subtle-button" aria-expanded={filtersOpen} onClick={() => setFiltersOpen(!filtersOpen)}><SlidersHorizontal size={17} />筛选{chips.length ? " · " + chips.length : ""}</button></div>
    {filtersOpen && <div className="knowledge-filters">
      <label>学科<select aria-label="按学科筛选" value={subject} onChange={event => setSubject(event.target.value)}><option value="">全部学科</option>{options.subjects.map(item => <option key={item}>{item}</option>)}</select></label>
      <label>标签<input aria-label="按标签筛选" list="knowledge-tag-options" placeholder="搜索或选择标签" value={tag} onChange={event => setTag(event.target.value)} /><datalist id="knowledge-tag-options">{options.tags.map(item => <option key={item} value={item} />)}</datalist></label>
      <label>年份<select aria-label="按年份筛选" value={year} onChange={event => { const next = event.target.value; setYear(next); setFrom(next ? next + "-01-01" : ""); setTo(next ? next + "-12-31" : ""); }}><option value="">全部年份</option>{options.years.map(item => <option key={item}>{item}</option>)}</select></label>
<details className="knowledge-date-range"><summary>自定义日期范围</summary><div><label>开始日期<input aria-label="开始日期" type="date" value={from} onChange={event => { setYear(""); setFrom(event.target.value); }} /></label>
      <label>结束日期<input aria-label="结束日期" type="date" value={to} onChange={event => { setYear(""); setTo(event.target.value); }} /></label></div></details>
      <div className="knowledge-filter-options"><label><input type="checkbox" checked={body} onChange={event => setBody(event.target.checked)} />搜索正文</label>{mode === "search" && <><label><input type="checkbox" checked={all} onChange={event => setAll(event.target.checked)} disabled={!workspaceId} />所有专题</label><label><input type="checkbox" checked={hidden} onChange={event => setHidden(event.target.checked)} />含隐藏内容</label></>}</div>
      {invalidDates && <p role="alert">开始日期不能晚于结束日期。</p>}
    </div>}
    {!filtersOpen && !!chips.length && <div className="knowledge-filter-chips">{chips.map(chip => <button key={chip.text} onClick={chip.clear}>{chip.text}<X size={13} /></button>)}<button onClick={() => { setSubject(""); setTag(""); setFrom(""); setTo(""); setYear(""); }}>清空条件</button></div>}
    <div className="knowledge-result-count" role="status">{hits.length} 项{mode === "unorganized" ? " · 当前库未引用" : ""}{selected.length ? " · 已选 " + selected.length : ""}{query !== deferredQuery ? " · 搜索中" : ""}</div>
    {hits.length ? <KnowledgeVirtualList items={hits} itemKey={hit => (hit.recordId ?? "entity") + ":" + hit.entityId} resetKey={resetKey} label="搜索结果" renderItem={hit => {
      const record = hit.recordId ? options.records.get(hit.recordId) : undefined;
      const text = <span className="knowledge-result-text"><strong>{hit.title}</strong><small>{record ? record.subject + " · " + record.date : "专题内容"}{deferredQuery && body && hit.excerpt !== hit.title ? " · " + hit.excerpt.replaceAll("\n", " ") : ""}</small></span>;
      return mode !== "search" && hit.recordId ? <label><input type="checkbox" aria-label={hit.title} checked={selected.includes(hit.recordId)} onChange={event => onSelected(event.target.checked ? [...selected, hit.recordId!] : selected.filter(id => id !== hit.recordId))} />{text}</label> : <button type="button" onClick={() => onOpen(hit)}>{text}</button>;
    }} /> : <div className="knowledge-results knowledge-result-empty">{invalidDates ? "请调整日期范围" : "没有匹配内容"}</div>}
    {footer && <div className="knowledge-results-footer">{footer}</div>}
  </section>;
}
