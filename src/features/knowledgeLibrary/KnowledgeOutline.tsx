import { useEffect, useMemo, useRef, useState } from "react";
import { Check, ChevronDown, ChevronRight, X } from "lucide-react";
import { ROOT_NODE, type KnowledgeState } from "./domain";
import { knowledgeLabel, layoutKnowledgeTree } from "./query";
import { isKnowledgeVisible } from "./protocol";
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
  state: KnowledgeState;
  workspaceId: string;
  navigation: KnowledgeNavigation;
  editor?: KnowledgeTitleEditor;
  onSelect: (id: string) => void;
  onEdit: (id: string) => void;
  onCreate: (parentId: string) => void;
  onOutdent: (id: string) => void;
  onToggle: (id: string) => void;
  onScrollPosition: (position: number) => void;
}
export function KnowledgeOutline({ state, workspaceId, navigation, editor, onSelect, onEdit, onCreate, onOutdent, onToggle, onScrollPosition }: Props) {
  const layout = useMemo(() => layoutKnowledgeTree(state, workspaceId, new Set(navigation.collapsed)), [state, workspaceId, navigation.collapsed]);
  const counts = useMemo(() => { const result = new Map<string, number>(); for (const entity of Object.values(state.entities)) if (entity.kind === "reference" && isKnowledgeVisible(state, entity)) result.set(entity.nodeId, (result.get(entity.nodeId) ?? 0) + 1); return result; }, [state]);
  const viewport = useRef<HTMLDivElement>(null);
  const [scroll, setScroll] = useState(navigation.scrollTop);
  const [height, setHeight] = useState(700);
  const rowHeight = 52;
  const currentScroll = useRef(scroll);
  const saveScroll = useRef(onScrollPosition);
  saveScroll.current = onScrollPosition;
  useEffect(() => {
    if (!viewport.current) return;
    viewport.current.scrollTop = navigation.scrollTop;
    const observer = new ResizeObserver(entries => setHeight(entries[0].contentRect.height));
    observer.observe(viewport.current);
    return () => { observer.disconnect(); saveScroll.current(currentScroll.current); };
  }, [workspaceId]);
  useEffect(() => {
    if (!editor || editor.isNew) return;
    const index = layout.findIndex(node => node.id === editor.entityId);
    if (index >= 0 && viewport.current && (index * rowHeight < currentScroll.current || index * rowHeight > currentScroll.current + height - rowHeight)) viewport.current.scrollTop = index * rowHeight;
  }, [editor?.entityId, height, layout]);
  const start = Math.max(0, Math.floor(scroll / rowHeight) - 3);
  const end = Math.min(layout.length, start + Math.ceil(height / rowHeight) + 7);
  return <div className="knowledge-outline" ref={viewport} role="tree" aria-label="专题大纲" onScroll={event => { currentScroll.current = event.currentTarget.scrollTop; setScroll(currentScroll.current); }} onKeyDown={event => {
    if ((event.target as HTMLElement).closest("input, textarea, form") || event.nativeEvent.isComposing) return;
    const selected = layout.find(node => node.id === navigation.selectedNodeId);
    if (!selected) return;
    if (event.key === "F2") { event.preventDefault(); onEdit(selected.id); }
    if (event.key === "Enter") { event.preventDefault(); onCreate(selected.parentNodeId); }
    if (event.key === "Tab") { event.preventDefault(); if (event.shiftKey) onOutdent(selected.id); else onCreate(selected.id); }
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const index = layout.indexOf(selected) + (event.key === "ArrowDown" ? 1 : -1);
      if (layout[index]) { onSelect(layout[index].id); if (viewport.current) { if (index * rowHeight < scroll) viewport.current.scrollTop = index * rowHeight; if (index * rowHeight > scroll + height - rowHeight) viewport.current.scrollTop = (index + 1) * rowHeight - height; } }
    }
  }}>
    {editor?.isNew && <div className="knowledge-inline-new"><KnowledgeTitleInput editor={editor} label="新建节点" /></div>}
    <div style={{ height: layout.length * rowHeight, position: "relative" }}>
      {layout.slice(start, end).map((node, index) => <div role="treeitem" aria-level={node.depth + 1} aria-selected={navigation.selectedNodeId === node.id} aria-expanded={!navigation.collapsed.includes(node.id)} key={node.id} className={"knowledge-outline-row" + (navigation.selectedNodeId === node.id ? " selected" : "")} style={{ position: "absolute", top: (start + index) * rowHeight, height: rowHeight, left: 0, right: 0, paddingLeft: Math.min(node.depth, 6) * 16 }}>
        <button className="knowledge-collapse" aria-label={navigation.collapsed.includes(node.id) ? "展开分支" : "折叠分支"} onClick={() => onToggle(node.id)}>{navigation.collapsed.includes(node.id) ? <ChevronRight size={15} /> : <ChevronDown size={15} />}</button>
        {editor?.entityId === node.id ? <KnowledgeTitleInput editor={editor} /> : <button className="knowledge-row-title" onClick={() => { saveScroll.current(currentScroll.current); onSelect(node.id); }} onDoubleClick={() => onEdit(node.id)}><span>{knowledgeLabel(state, state.entities[node.id])}</span>{!!counts.get(node.id) && <small>{counts.get(node.id)} 条日志</small>}</button>}
      </div>)}
    </div>
    {!layout.length && !editor && <div className="knowledge-empty"><p>从第一个节点开始</p><button className="primary-button" onClick={() => onCreate(ROOT_NODE)}>添加节点</button></div>}
  </div>;
}
