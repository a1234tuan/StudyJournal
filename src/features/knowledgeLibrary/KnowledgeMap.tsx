import { useEffect, useMemo, useRef, useState } from "react";
import type { KnowledgeState } from "./domain";
import { knowledgeLabel, layoutKnowledgeTree } from "./query";
import type { KnowledgeNavigation } from "./navigation";

interface Props {
  state: KnowledgeState;
  workspaceId: string;
  navigation: KnowledgeNavigation;
  organizing: boolean;
  onNavigation: (patch: Partial<KnowledgeNavigation>) => void;
  onSelect: (id: string) => void;
  onToggle: (id: string) => void;
  onMove: (id: string, parentId: string) => void;
}
export const KnowledgeMap = ({ state, workspaceId, navigation, organizing, onNavigation, onSelect, onToggle, onMove }: Props) => {
  const viewport = useRef<HTMLDivElement>(null);
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const gesture = useRef<{ x: number; y: number; originX: number; originY: number; nodeId?: string; threshold: number; moved: boolean; pinch?: number; zoom: number }>();
  const [dragging, setDragging] = useState<string>();
  const [size, setSize] = useState({ width: 800, height: 560 });
  const layout = useMemo(() => layoutKnowledgeTree(state, workspaceId, new Set(navigation.collapsed)), [state, workspaceId, navigation.collapsed]);
  const frozenLayout = useRef(layout);
  if (!gesture.current) frozenLayout.current = layout;
  const positions = gesture.current ? frozenLayout.current : layout;
  const byId = useMemo(() => new Map(positions.map(node => [node.id, node])), [positions]);
  const visible = positions.filter(node => (node.x + 220) * navigation.zoom + navigation.panX > -100 && node.x * navigation.zoom + navigation.panX < size.width + 100 && (node.y + 64) * navigation.zoom + navigation.panY > -100 && node.y * navigation.zoom + navigation.panY < size.height + 100);
  useEffect(() => {
    const target = viewport.current;
    if (!target) return;
    const observer = new ResizeObserver(entries => setSize({ width: entries[0].contentRect.width, height: entries[0].contentRect.height }));
    observer.observe(target);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    const cancel = (event: Event) => {
      if (!gesture.current) return;
      gesture.current = undefined; pointers.current.clear(); setDragging(undefined); event.preventDefault(); event.stopImmediatePropagation();
    };
    window.addEventListener("knowledge-back", cancel, true);
    return () => window.removeEventListener("knowledge-back", cancel, true);
  }, []);
  const fit = () => {
    const width = Math.max(300, ...positions.map(node => node.x + 250));
    const height = Math.max(150, ...positions.map(node => node.y + 100));
    onNavigation({ zoom: Math.max(0.2, Math.min(1, size.width / width, size.height / height)), panX: 0, panY: 0 });
  };
  const updateZoom = (value: number) => onNavigation({ zoom: Math.min(2, Math.max(0.2, value)) });
  return <section className="knowledge-map-section" aria-label="专题导图">
    <div className="knowledge-toolbar">
      <button className="subtle-button" onClick={() => updateZoom(navigation.zoom / 1.2)} aria-label="缩小导图">−</button>
      <output>{Math.round(navigation.zoom * 100)}%</output>
      <button className="subtle-button" onClick={() => updateZoom(navigation.zoom * 1.2)} aria-label="放大导图">＋</button>
      <button className="subtle-button" onClick={fit}>查看全貌</button>
      <button className="subtle-button" onClick={() => onNavigation({ zoom: 1, panX: 0, panY: 0 })}>重置视图</button>
      <span>{organizing ? "拖动把手可移动分支；也可使用“移动到”" : "拖动浏览 · 双指缩放 · 点击只读"}</span>
    </div>
    <div className="knowledge-map-viewport" ref={viewport} tabIndex={0} aria-label="可平移缩放的导图画布"
      onWheel={event => { if (event.ctrlKey || event.metaKey) { event.preventDefault(); updateZoom(navigation.zoom * (event.deltaY > 0 ? 0.9 : 1.1)); } else onNavigation({ panX: navigation.panX - event.deltaX, panY: navigation.panY - event.deltaY }); }}
      onKeyDown={event => { if (event.target !== event.currentTarget) return; const step = 48; if (event.key.startsWith("Arrow")) { event.preventDefault(); onNavigation({ panX: navigation.panX + (event.key === "ArrowLeft" ? step : event.key === "ArrowRight" ? -step : 0), panY: navigation.panY + (event.key === "ArrowUp" ? step : event.key === "ArrowDown" ? -step : 0) }); } }}
      onPointerDown={event => {
        if (event.button !== 0) return;
        pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
        if (pointers.current.size > 1) {
          const values = [...pointers.current.values()];
          if (gesture.current) { gesture.current.nodeId = undefined; gesture.current.moved = true; gesture.current.pinch = Math.hypot(values[0].x - values[1].x, values[0].y - values[1].y); gesture.current.zoom = navigation.zoom; }
          setDragging(undefined);
          event.currentTarget.setPointerCapture(event.pointerId); return;
        }
        const handle = (event.target as Element).closest<HTMLElement>("[data-drag-node]");
        gesture.current = { x: event.clientX, y: event.clientY, originX: navigation.panX, originY: navigation.panY, nodeId: organizing ? handle?.dataset.dragNode : undefined, threshold: event.pointerType === "touch" ? 10 : 6, moved: false, zoom: navigation.zoom };
        if (handle) event.preventDefault();
        event.currentTarget.setPointerCapture(event.pointerId);
      }}
      onPointerMove={event => {
        const current = gesture.current;
        if (!current || !pointers.current.has(event.pointerId)) return;
        pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
        if (pointers.current.size > 1) {
          const values = [...pointers.current.values()];
          const distance = Math.hypot(values[0].x - values[1].x, values[0].y - values[1].y);
          if (current.pinch) updateZoom(current.zoom * distance / current.pinch);
          return;
        }
        const deltaX = event.clientX - current.x; const deltaY = event.clientY - current.y;
        if (Math.hypot(deltaX, deltaY) < current.threshold && !current.moved) return;
        current.moved = true;
        if (current.nodeId) setDragging(current.nodeId);
        else onNavigation({ panX: current.originX + deltaX, panY: current.originY + deltaY });
      }}
      onPointerUp={event => {
        const current = gesture.current;
        pointers.current.delete(event.pointerId);
        if (current?.nodeId && current.moved && !current.pinch) {
          const target = document.elementFromPoint(event.clientX, event.clientY)?.closest<HTMLElement>("[data-node-id]")?.dataset.nodeId;
          if (target && target !== current.nodeId) onMove(current.nodeId, target);
        } else if (current && !current.moved && !current.pinch) {
          const target = document.elementFromPoint(event.clientX, event.clientY)?.closest<HTMLElement>("[data-node-id]")?.dataset.nodeId;
          if (target) onSelect(target);
        }
        if (pointers.current.size === 0) { gesture.current = undefined; setDragging(undefined); }
      }}
      onPointerCancel={() => { gesture.current = undefined; pointers.current.clear(); setDragging(undefined); }}>
      <div className="knowledge-map-plane" style={{ transform: "translate(" + navigation.panX + "px," + navigation.panY + "px) scale(" + navigation.zoom + ")" }}>
        <svg aria-hidden="true" className="knowledge-map-lines" width={Math.max(size.width, ...positions.map(node => node.x + 260))} height={Math.max(size.height, ...positions.map(node => node.y + 100))}>
          {visible.map(node => { const parent = byId.get(node.parentNodeId); return parent ? <path key={node.id} d={"M " + (parent.x + 220) + " " + (parent.y + 30) + " C " + (parent.x + 240) + " " + (parent.y + 30) + ", " + (node.x - 20) + " " + (node.y + 30) + ", " + node.x + " " + (node.y + 30)} /> : null; })}
        </svg>
        {visible.map(node => <div key={node.id} data-node-id={node.id} className={"knowledge-map-node" + (navigation.selectedNodeId === node.id ? " selected" : "") + (dragging === node.id ? " dragging" : "")} style={{ left: node.x, top: node.y }}>
          {organizing && <button type="button" className="knowledge-drag-handle" data-drag-node={node.id} aria-label={"拖动分支：" + knowledgeLabel(state, state.entities[node.id])}>⠿</button>}
          <button type="button" className="knowledge-map-label" onClick={event => { if (event.detail === 0) onSelect(node.id); }}>{knowledgeLabel(state, state.entities[node.id])}</button>
          <button type="button" className="knowledge-collapse" onPointerDown={event => event.stopPropagation()} onClick={() => onToggle(node.id)} aria-label={navigation.collapsed.includes(node.id) ? "展开分支" : "折叠分支"}>{navigation.collapsed.includes(node.id) ? "+" : "−"}</button>
        </div>)}
      </div>
    </div>
  </section>;
};
