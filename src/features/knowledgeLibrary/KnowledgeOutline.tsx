import { useEffect, useMemo, useRef, useState } from "react";
import { Check, ChevronDown, ChevronRight, FileText, X } from "lucide-react";
import { ROOT_NODE, type KnowledgePosition, type KnowledgeState } from "./domain";
import { valueOf } from "./protocol";
import { knowledgeLabel } from "./query";
import { flattenKnowledgeOutline } from "./presentation";
import type { RecordBlock } from "../../types";
import type { KnowledgeNavigation } from "./navigation";

export interface KnowledgeTitleEditor { entityId: string; text: string; isNew: boolean; busy: boolean; onChange: (text: string) => void; onSave: () => void; onCancel: () => void }
export function KnowledgeTitleInput({ editor, label = "节点标题" }: { editor: KnowledgeTitleEditor; label?: string }) {
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => { input.current?.focus(); input.current?.select(); }, [editor.entityId]);
  return <form className="knowledge-title-editor" onSubmit={event => { event.preventDefault(); if (!editor.busy && editor.text.trim()) editor.onSave(); }} onPointerDown={event => event.stopPropagation()} onKeyDown={event => { event.stopPropagation(); if (event.nativeEvent.isComposing) { if (event.key === "Enter") event.preventDefault(); return; } if (event.key === "Escape") { event.preventDefault(); editor.onCancel(); } }}>
    <input ref={input} aria-label={label} placeholder="输入节点标题" value={editor.text} disabled={editor.busy} onChange={event => editor.onChange(event.target.value)} />
    <button type="submit" aria-label="保存节点" disabled={editor.busy || !editor.text.trim()}><Check size={18} /></button>
    <button type="button" aria-label="取消编辑节点" disabled={editor.busy} onClick={editor.onCancel}><X size={18} /></button>
  </form>;
}
interface Props {
  state: KnowledgeState; workspaceId: string; navigation: KnowledgeNavigation; editor?: KnowledgeTitleEditor;
  records: ReadonlyMap<string, RecordBlock>; onOpenRecord: (record: RecordBlock) => void;
  onSelect: (id: string) => void; onEdit: (id: string) => void; onCreate: (parentId: string) => void;
  onOutdent: (id: string) => void; onToggle: (id: string) => void; onScrollPosition: (position: number) => void;
}
export function KnowledgeOutline({ state, workspaceId, navigation, editor, records, onOpenRecord, onSelect, onEdit, onCreate, onOutdent, onToggle, onScrollPosition }: Props) {
  const rows = useMemo(() => flattenKnowledgeOutline(state, workspaceId, new Set(navigation.collapsed)), [state, workspaceId, navigation.collapsed]);
  const viewport = useRef<HTMLDivElement>(null);
  const [scroll, setScroll] = useState(navigation.scrollTop);
  const [height, setHeight] = useState(700);
  const rowHeight = 48;
  const currentScroll = useRef(scroll);
  const saveScroll = useRef(onScrollPosition);
  const clickTimer = useRef<number>();
  saveScroll.current = onScrollPosition;
  useEffect(() => {
    if (!viewport.current) return;
    viewport.current.scrollTop = navigation.scrollTop;
    const observer = new ResizeObserver(entries => setHeight(entries[0].contentRect.height));
    observer.observe(viewport.current);
    return () => { observer.disconnect(); window.clearTimeout(clickTimer.current); saveScroll.current(currentScroll.current); };
  }, [workspaceId]);
  const reveal = (index: number) => {
    if (!viewport.current || index < 0) return;
    if (index * rowHeight < currentScroll.current) viewport.current.scrollTop = index * rowHeight;
    else if ((index + 1) * rowHeight > currentScroll.current + height) viewport.current.scrollTop = (index + 1) * rowHeight - height;
  };
  useEffect(() => { if (editor && !editor.isNew) reveal(rows.findIndex(row => row.id === editor.entityId)); }, [editor?.entityId, height, rows]);
  useEffect(() => {
    if (viewport.current && viewport.current.scrollTop > Math.max(0, rows.length * rowHeight - height)) viewport.current.scrollTop = Math.max(0, rows.length * rowHeight - height);
  }, [rows.length, height]);
  const start = Math.max(0, Math.floor(scroll / rowHeight) - 3);
  const end = Math.min(rows.length, start + Math.ceil(height / rowHeight) + 7);
  return <div className="knowledge-outline" ref={viewport} role="tree" aria-label="专题大纲" onScroll={event => { currentScroll.current = event.currentTarget.scrollTop; setScroll(currentScroll.current); }} onKeyDown={event => {
    if ((event.target as HTMLElement).closest("input, textarea, form") || event.nativeEvent.isComposing) return;
    const target = (event.target as HTMLElement).closest<HTMLElement>("[data-outline-id]");
    const selected = rows.find(row => row.id === target?.dataset.outlineId) ?? rows.find(row => row.id === navigation.selectedNodeId);
    if (!selected) return;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault(); const index = rows.indexOf(selected) + (event.key === "ArrowDown" ? 1 : -1);
      if (rows[index]) { reveal(index); requestAnimationFrame(() => viewport.current?.querySelector<HTMLElement>('[data-outline-id="' + CSS.escape(rows[index].id) + '"] .knowledge-row-title, [data-outline-id="' + CSS.escape(rows[index].id) + '"] .knowledge-outline-log')?.focus()); }
    }
    if (selected.kind !== "node") return;
    if (event.key === "F2") { event.preventDefault(); window.clearTimeout(clickTimer.current); onEdit(selected.id); }
    if (event.key === "Enter") { event.preventDefault(); onCreate((valueOf(state, state.entities[selected.id], "position") as KnowledgePosition).parentNodeId); }
    if (event.key === "Tab") { event.preventDefault(); if (event.shiftKey) onOutdent(selected.id); else onCreate(selected.id); }
    if (event.key === "ArrowLeft" && selected.expandable && !navigation.collapsed.includes(selected.id)) { event.preventDefault(); onToggle(selected.id); }
    if (event.key === "ArrowRight" && selected.expandable && navigation.collapsed.includes(selected.id)) { event.preventDefault(); onToggle(selected.id); }
  }}>
    {editor?.isNew && <div className="knowledge-inline-new"><KnowledgeTitleInput editor={editor} label="新建节点" /></div>}
    <div style={{ height: rows.length * rowHeight, position: "relative" }}>
      {rows.slice(start, end).map((row, index) => {
        const record = row.kind === "reference" ? records.get(state.entities[row.id].recordId) : undefined;
        return <div role="treeitem" aria-level={row.depth + 1} aria-selected={row.kind === "node" && navigation.selectedNodeId === row.id} aria-expanded={row.expandable ? !navigation.collapsed.includes(row.id) : undefined} key={row.id} data-outline-id={row.id} data-kind={row.kind} className={"knowledge-outline-row" + (row.kind === "node" && navigation.selectedNodeId === row.id ? " selected" : "")} style={{ position: "absolute", top: (start + index) * rowHeight, height: rowHeight, left: 0, right: 0, paddingLeft: 8 + Math.min(row.depth, 10) * 18 }}>
          {row.kind === "reference" ? <button className="knowledge-outline-log" aria-label={record?.title || "原日志暂不可用"} title={record?.title} disabled={!record || Boolean(record.deletedAt)} onClick={() => { saveScroll.current(currentScroll.current); if (record) onOpenRecord(record); }}><FileText size={15} /><span>{record?.title || "原日志暂不可用"}</span><small>{!record ? "等待同步" : record.deletedAt ? "在回收站" : record.subject}</small><ChevronRight size={14} /></button> : <>
            {row.expandable ? <button className="knowledge-collapse" aria-label={navigation.collapsed.includes(row.id) ? "展开分支" : "折叠分支"} onClick={() => onToggle(row.id)}>{navigation.collapsed.includes(row.id) ? <ChevronRight size={14} /> : <ChevronDown size={14} />}</button> : <span className="knowledge-outline-leaf" aria-hidden="true">·</span>}
            {editor?.entityId === row.id ? <KnowledgeTitleInput editor={editor} /> : <button className="knowledge-row-title" title={knowledgeLabel(state, state.entities[row.id])} onClick={event => { window.clearTimeout(clickTimer.current); saveScroll.current(currentScroll.current); if (event.detail === 0) onSelect(row.id); else clickTimer.current = window.setTimeout(() => onSelect(row.id), 220); }} onDoubleClick={() => { window.clearTimeout(clickTimer.current); onEdit(row.id); }}><span>{knowledgeLabel(state, state.entities[row.id])}</span>{row.count > 0 && <small>{row.count} 条日志</small>}</button>}
          </>}
        </div>;
      })}
    </div>
    {!rows.length && !editor && <div className="knowledge-empty"><p>从第一个节点开始</p><button className="primary-button" onClick={() => onCreate(ROOT_NODE)}>添加节点</button></div>}
  </div>;
}
