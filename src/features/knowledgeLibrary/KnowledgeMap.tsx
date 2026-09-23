import { useEffect, useMemo, useRef, useState } from "react";
import { FileText } from "lucide-react";
import { KnowledgeTitleInput, type KnowledgeTitleEditor } from "./KnowledgeOutline";
import { ROOT_NODE, type KnowledgeState } from "./domain";
import { knowledgeLabel } from "./query";
import { knowledgeMapDrop, knowledgeMapPath, layoutKnowledgeMap, type MapDrop } from "./presentation";
import type { KnowledgeNavigation } from "./navigation";

interface Props {
  state: KnowledgeState; workspaceId: string; navigation: KnowledgeNavigation; organizing: boolean; editor?: KnowledgeTitleEditor;
  onEdit: (id: string) => void; onNavigation: (patch: Partial<KnowledgeNavigation>) => void;
  onSelect: (id: string) => void; onClear: () => void; onToggle: (id: string) => void;
  onMove: (id: string, parentId: string, beforeId?: string) => void;
}
interface Gesture { x: number; y: number; panX: number; panY: number; nodeId?: string; ready: boolean; moved: boolean; touch: boolean; zoom: number; pinch?: number }
interface Drag { id: string; deltaX: number; deltaY: number; drop?: MapDrop }
export const KnowledgeMap = ({ state, workspaceId, navigation, organizing, editor, onEdit, onNavigation, onSelect, onClear, onToggle, onMove }: Props) => {
  const [view, setView] = useState({ zoom: navigation.zoom, panX: navigation.panX, panY: navigation.panY });
  const viewport = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  const sides = useRef(navigation.mapWorkspaceId === workspaceId ? navigation.mapSides ?? {} : {});
  const layout = useMemo(() => layoutKnowledgeMap(state, workspaceId, new Set(navigation.collapsed), sides.current), [state, workspaceId, navigation.collapsed]);
  const initialized = useRef(navigation.mapWorkspaceId === workspaceId);
  const latest = useRef({ view, onNavigation, layout });
  latest.current = { view, onNavigation, layout };
  const gesture = useRef<Gesture>();
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const holdTimer = useRef<number>();
  const selectTimer = useRef<number>();
  const [drag, setDrag] = useState<Drag>();
  const dragRef = useRef<Drag>();
  const updateDrag = (next?: Drag) => { dragRef.current = next; setDrag(next); };
  const frozen = useRef(layout.nodes);
  if (!gesture.current) frozen.current = layout.nodes;
  const nodes = gesture.current ? frozen.current : layout.nodes;
  const byId = new Map(nodes.map(node => [node.id, node]));
  const draggedIds = new Set<string>();
  if (drag) { draggedIds.add(drag.id); for (const node of nodes) if (draggedIds.has(node.parentId)) draggedIds.add(node.id); }
  const visible = nodes.filter(node => (node.x + node.width) * view.zoom + view.panX > -80 && node.x * view.zoom + view.panX < size.width + 80 && (node.y + node.height) * view.zoom + view.panY > -80 && node.y * view.zoom + view.panY < size.height + 80);
  const cancel = () => { window.clearTimeout(holdTimer.current); window.clearTimeout(selectTimer.current); gesture.current = undefined; pointers.current.clear(); updateDrag(); };
  const fit = (initial = false) => {
    const left = Math.min(...layout.nodes.map(node => node.x)) - 40;
    const right = Math.max(...layout.nodes.map(node => node.x + node.width)) + 40;
    const top = Math.min(...layout.nodes.map(node => node.y)) - 40;
    const bottom = Math.max(...layout.nodes.map(node => node.y + node.height)) + 40;
    const readableStart = initial && size.width < 600;
    const zoom = Math.max(readableStart ? .85 : .2, Math.min(1, size.width / (right - left), size.height / (bottom - top)));
    setView({ zoom, panX: size.width / 2 - (readableStart ? 0 : (left + right) / 2) * zoom, panY: size.height / 2 - (top + bottom) / 2 * zoom });
  };
  const zoomAt = (zoom: number, anchorX = size.width / 2, anchorY = size.height / 2) => setView(current => {
    const next = Math.min(2, Math.max(.2, zoom));
    return { zoom: next, panX: anchorX - (anchorX - current.panX) * next / current.zoom, panY: anchorY - (anchorY - current.panY) * next / current.zoom };
  });
  useEffect(() => {
    if (!viewport.current) return;
    const element = viewport.current;
    const preventBrowserZoom = (event: WheelEvent) => { if (event.ctrlKey || event.metaKey) event.preventDefault(); };
    element.addEventListener("wheel", preventBrowserZoom, { passive: false });
    const observer = new ResizeObserver(entries => setSize({ width: entries[0].contentRect.width, height: entries[0].contentRect.height }));
    observer.observe(element); return () => { observer.disconnect(); element.removeEventListener("wheel", preventBrowserZoom); };
  }, []);
  useEffect(() => { if (size.width && size.height && !initialized.current) { initialized.current = true; fit(true); } }, [size]);
  useEffect(() => {
    if (!navigation.detailsOpen || !navigation.selectedNodeId || !size.width) return;
    const selected = layout.nodes.find(node => node.id === navigation.selectedNodeId);
    if (!selected) return;
    const availableHeight = window.matchMedia("(max-width: 920px)").matches ? size.height * .48 : size.height;
    setView(current => {
      if (current.zoom < .85) {
        const zoom = .85;
        return { zoom, panX: size.width / 2 - (selected.x + selected.width / 2) * zoom, panY: availableHeight / 2 - (selected.y + selected.height / 2) * zoom };
      }
      const left = selected.x * current.zoom + current.panX;
      const top = selected.y * current.zoom + current.panY;
      const right = left + selected.width * current.zoom;
      const bottom = top + selected.height * current.zoom;
      const deltaX = left < 24 ? 24 - left : right > size.width - 24 ? size.width - 24 - right : 0;
      const deltaY = top < 24 ? 24 - top : bottom > availableHeight - 24 ? availableHeight - 24 - bottom : 0;
      return deltaX || deltaY ? { ...current, panX: current.panX + deltaX, panY: current.panY + deltaY } : current;
    });
  }, [navigation.selectedNodeId, navigation.detailsOpen, size]);
  useEffect(() => {
    sides.current = layout.sides;
    if (!initialized.current) return;
    const timer = window.setTimeout(() => onNavigation({ ...view, mapWorkspaceId: workspaceId, mapSides: layout.sides }), 180);
    return () => window.clearTimeout(timer);
  }, [view, layout]);
  useEffect(() => () => {
    window.clearTimeout(holdTimer.current); window.clearTimeout(selectTimer.current);
    if (initialized.current) latest.current.onNavigation({ ...latest.current.view, mapWorkspaceId: workspaceId, mapSides: latest.current.layout.sides });
  }, [workspaceId]);
  useEffect(() => {
    const back = (event: Event) => { if (gesture.current) { cancel(); event.preventDefault(); event.stopImmediatePropagation(); } };
    const keyboard = (event: KeyboardEvent) => { if (event.key === "Escape" && gesture.current) { cancel(); event.preventDefault(); event.stopImmediatePropagation(); } };
    window.addEventListener("knowledge-back", back, true); window.addEventListener("keydown", keyboard, true);
    return () => { window.removeEventListener("knowledge-back", back, true); window.removeEventListener("keydown", keyboard, true); };
  }, []);
  useEffect(() => { if (editor) { window.clearTimeout(selectTimer.current); } }, [editor]);
  const dropMessage = !drag ? "" : !drag.drop ? "拖到节点中间成为子节点，上下边缘调整顺序" : drag.drop.mode === "invalid" ? "不能移动到自身或下级分支" : drag.drop.mode === "child" ? drag.drop.parentId === ROOT_NODE ? "松开移至专题下" : "松开成为子节点" : drag.drop.mode === "before" ? "松开放在此节点之前" : "松开放在此节点之后";
  return <section className="knowledge-map-section" aria-label="专题导图">
    <div className="knowledge-map-controls"><button onClick={() => zoomAt(view.zoom / 1.2)} aria-label="缩小导图">−</button><output>{Math.round(view.zoom * 100)}%</output><button onClick={() => zoomAt(view.zoom * 1.2)} aria-label="放大导图">＋</button><button onClick={() => fit()}>查看全貌</button></div>
    {drag && <div className="knowledge-drop-message" role="status">{dropMessage}</div>}
    <div className="knowledge-map-viewport" ref={viewport} tabIndex={0} aria-label="可平移缩放的导图画布"
      onDoubleClick={event => { if (editor || (event.target as Element).closest("form, .knowledge-map-toggle")) return; const id = document.elementFromPoint(event.clientX, event.clientY)?.closest<HTMLElement>("[data-node-id]")?.dataset.nodeId; if (id) { window.clearTimeout(selectTimer.current); onEdit(id); } }}
      onWheel={event => { if (gesture.current) return; if (event.ctrlKey || event.metaKey) { const rect = event.currentTarget.getBoundingClientRect(); zoomAt(view.zoom * (event.deltaY > 0 ? .9 : 1.1), event.clientX - rect.left, event.clientY - rect.top); } else setView(current => ({ ...current, panX: current.panX - event.deltaX, panY: current.panY - event.deltaY })); }}
      onKeyDown={event => { if (event.target !== event.currentTarget) return; if (event.key.startsWith("Arrow")) { event.preventDefault(); setView(current => ({ ...current, panX: current.panX + (event.key === "ArrowLeft" ? 48 : event.key === "ArrowRight" ? -48 : 0), panY: current.panY + (event.key === "ArrowUp" ? 48 : event.key === "ArrowDown" ? -48 : 0) })); } }}
      onPointerDown={event => {
        if (event.button !== 0 || (event.target as Element).closest("form, input, .knowledge-map-toggle")) return;
        window.clearTimeout(selectTimer.current);
        pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
        event.currentTarget.setPointerCapture(event.pointerId);
        if (pointers.current.size > 1) {
          window.clearTimeout(holdTimer.current);
          const values = [...pointers.current.values()];
          gesture.current = { x: 0, y: 0, panX: view.panX, panY: view.panY, ready: false, moved: true, touch: true, zoom: view.zoom, pinch: Math.hypot(values[0].x - values[1].x, values[0].y - values[1].y) };
          updateDrag(); return;
        }
        const nodeId = (event.target as Element).closest<HTMLElement>("[data-node-id]")?.dataset.nodeId;
        const current: Gesture = { x: event.clientX, y: event.clientY, panX: view.panX, panY: view.panY, nodeId: organizing ? nodeId : undefined, ready: event.pointerType !== "touch", moved: false, touch: event.pointerType === "touch", zoom: view.zoom };
        gesture.current = current;
        if (current.touch && current.nodeId) holdTimer.current = window.setTimeout(() => { if (gesture.current === current && !current.moved) { current.ready = true; updateDrag({ id: current.nodeId!, deltaX: 0, deltaY: 0 }); } }, 350);
      }}
      onPointerMove={event => {
        const current = gesture.current;
        if (!current || !pointers.current.has(event.pointerId)) return;
        pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
        if (pointers.current.size > 1) {
          const values = [...pointers.current.values()];
          if (current.pinch) zoomAt(current.zoom * Math.hypot(values[0].x - values[1].x, values[0].y - values[1].y) / current.pinch);
          return;
        }
        if (current.pinch) return;
        const deltaX = event.clientX - current.x; const deltaY = event.clientY - current.y;
        if (!current.moved && Math.hypot(deltaX, deltaY) < (current.touch ? 10 : 6)) return;
        current.moved = true; window.clearTimeout(holdTimer.current);
        if (current.nodeId && current.ready) {
          const bounds = event.currentTarget.getBoundingClientRect();
          const drop = knowledgeMapDrop(state, workspaceId, frozen.current, current.nodeId, { x: (event.clientX - bounds.left - view.panX) / view.zoom, y: (event.clientY - bounds.top - view.panY) / view.zoom });
          updateDrag({ id: current.nodeId, deltaX: deltaX / view.zoom, deltaY: deltaY / view.zoom, drop });
        } else setView(previous => ({ ...previous, panX: current.panX + deltaX, panY: current.panY + deltaY }));
      }}
      onPointerUp={event => {
        const current = gesture.current; window.clearTimeout(holdTimer.current);
        pointers.current.delete(event.pointerId);
        if (current?.pinch) { if (!pointers.current.size) cancel(); return; }
        const finalDrag = dragRef.current;
        if (current?.moved && finalDrag?.drop && finalDrag.drop.mode !== "invalid") onMove(finalDrag.id, finalDrag.drop.parentId, finalDrag.drop.beforeId);
        else if (current && !current.moved && !editor) {
          const nodeId = current.nodeId;
          if (nodeId) selectTimer.current = window.setTimeout(() => onSelect(nodeId), current.touch ? 0 : 220);
          else onClear();
        }
        gesture.current = undefined; updateDrag();
      }}
      onPointerCancel={cancel}>
      <div className="knowledge-map-plane" style={{ transform: "translate(" + view.panX + "px," + view.panY + "px) scale(" + view.zoom + ")" }}>
        <svg aria-hidden="true" className="knowledge-map-lines" width="1" height="1">{nodes.filter(node => node.id !== ROOT_NODE && (visible.includes(node) || visible.includes(byId.get(node.parentId)!))).map(node => <path key={node.id} data-branch={node.branch} data-depth={node.depth} d={knowledgeMapPath(byId.get(node.parentId)!, node)} />)}</svg>
        {visible.map(node => <div key={node.id} data-node-id={node.id === ROOT_NODE ? undefined : node.id} data-map-root={node.id === ROOT_NODE || undefined} data-branch={node.branch} data-side={node.side} data-depth={node.depth} data-drop={drag?.drop?.targetId === node.id ? drag.drop.mode : undefined} className={"knowledge-map-node" + (node.id === ROOT_NODE ? " knowledge-map-center" : "") + (navigation.selectedNodeId === node.id ? " selected" : "") + (draggedIds.has(node.id) ? " dragging" : "")} style={{ left: node.x, top: node.y, width: node.width, minHeight: node.height }}>
          {node.id === ROOT_NODE ? <strong>{knowledgeLabel(state, state.entities[workspaceId])}</strong> : editor?.entityId === node.id ? <KnowledgeTitleInput editor={editor} /> : <><button className="knowledge-map-label" aria-pressed={navigation.selectedNodeId === node.id} onKeyDown={event => { if (event.key === "F2") { event.preventDefault(); window.clearTimeout(selectTimer.current); onEdit(node.id); } }} onClick={event => { if (event.detail === 0) onSelect(node.id); }}>{knowledgeLabel(state, state.entities[node.id])}</button>{node.count > 0 && <span className="knowledge-map-count" aria-label={node.count + " 条日志"}><FileText size={11} />{node.count}</span>}</>}
          {node.hasChildren && <button className="knowledge-map-toggle" aria-expanded={!navigation.collapsed.includes(node.id)} aria-label={navigation.collapsed.includes(node.id) ? "展开分支" : "折叠分支"} onPointerDown={event => event.stopPropagation()} onDoubleClick={event => event.stopPropagation()} onClick={() => onToggle(node.id)}><span>{navigation.collapsed.includes(node.id) ? "+" : "−"}</span></button>}
        </div>)}
        {drag && <div className="knowledge-map-ghost" aria-hidden="true" style={{ transform: "translate(" + drag.deltaX + "px," + drag.deltaY + "px)" }}><svg className="knowledge-map-lines" width="1" height="1">{nodes.filter(node => draggedIds.has(node.id) && draggedIds.has(node.parentId)).map(node => <path key={node.id} data-branch={node.branch} d={knowledgeMapPath(byId.get(node.parentId)!, node)} />)}</svg>{nodes.filter(node => draggedIds.has(node.id)).map(node => <div className="knowledge-map-node" data-branch={node.branch} key={node.id} style={{ left: node.x, top: node.y, width: node.width, minHeight: node.height }}><span className="knowledge-map-label">{knowledgeLabel(state, state.entities[node.id])}</span></div>)}</div>}
      </div>
    </div>
  </section>;
};
