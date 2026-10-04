import { useEffect, useMemo, useRef, useState } from "react";
import { FileText, Focus, Home, Minus, Plus, Maximize2, Pencil, PanelRightOpen } from "lucide-react";
import { pinchMap, wheelMapZoom, zoomMapAt, type MapPoint } from "./mapViewport";
import { useMapCamera, useMapLayoutMotion } from "./useMapMotion";
import { KnowledgeTitleInput, type KnowledgeTitleEditor } from "./KnowledgeOutline";
import { ROOT_NODE, type KnowledgeState } from "./domain";
import { knowledgeLabel } from "./query";
import { knowledgeMapDrop, knowledgeMapPath, layoutKnowledgeMap, mapNeighbor, mapDropPreview, type MapDirection, type MapDrop } from "./presentation";
import { valueOf } from "./protocol";
import type { KnowledgePosition } from "./domain";
import type { KnowledgeNavigation } from "./navigation";

interface Props {
  state: KnowledgeState; workspaceId: string; navigation: KnowledgeNavigation; organizing: boolean; editor?: KnowledgeTitleEditor;
  onDetails: (id: string) => void; onEdit: (id: string) => void; onNavigation: (patch: Partial<KnowledgeNavigation>) => void;
  onSelect: (id: string) => void; onClear: () => void; onToggle: (id: string) => void; onCreate: (parentId: string, afterId?: string) => void;
  onMove: (id: string, parentId: string, beforeId?: string) => void;
}
interface Gesture { x: number; y: number; panX: number; panY: number; nodeId?: string; ready: boolean; moved: boolean; touch: boolean; zoom: number; pinch?: number; midpoint?: MapPoint }
interface Drag { id: string; deltaX: number; deltaY: number; drop?: MapDrop }
export const KnowledgeMap = ({ state, workspaceId, navigation, organizing, editor, onDetails, onEdit, onNavigation, onSelect, onClear, onToggle, onCreate, onMove }: Props) => {
  const { view, setView, camera } = useMapCamera({ zoom: navigation.zoom, panX: navigation.panX, panY: navigation.panY });
  const viewport = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  const [fontVersion, setFontVersion] = useState(0);
  const measure = useMemo(() => {
    const canvas = document.createElement("canvas");
    const context = canvas.getContext("2d");
    if (!context) return undefined;
    const font = getComputedStyle(viewport.current ?? document.documentElement);
    context.font = "500 " + getComputedStyle(document.documentElement).fontSize + " " + font.fontFamily;
    const cache = new Map<string, number>();
    return (title: string) => { if (!cache.has(title)) cache.set(title, context.measureText(title).width); return cache.get(title)!; };
  }, [fontVersion]);
  useEffect(() => {
    let alive = true;
    void document.fonts?.ready.then(() => { if (alive) setFontVersion(version => version + 1); });
    const observer = new MutationObserver(() => setFontVersion(version => version + 1));
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["class", "style", "data-theme"] });
    return () => { alive = false; observer.disconnect(); };
  }, []);
  const sides = useRef(navigation.mapWorkspaceId === workspaceId ? navigation.mapSides ?? {} : {});
  const previousLayout = useRef<ReturnType<typeof layoutKnowledgeMap>>();
  const layout = useMemo(() => {
    const next = layoutKnowledgeMap(state, workspaceId, new Set(navigation.collapsed), sides.current, editor?.isNew ? { id: editor.entityId, parentId: editor.parentId ?? ROOT_NODE, afterId: editor.afterId } : undefined, measure);
    const anchorId = navigation.selectedNodeId ?? ROOT_NODE;
    const before = previousLayout.current?.nodes.find(node => node.id === anchorId);
    const after = next.nodes.find(node => node.id === anchorId);
    if (before && after) {
      const deltaX = before.x - after.x;
      const deltaY = before.y - after.y;
      next.nodes = next.nodes.map(node => ({ ...node, x: node.x + deltaX, y: node.y + deltaY }));
    }
    previousLayout.current = next;
    return next;
  }, [state, workspaceId, navigation.collapsed, editor?.isNew, editor?.entityId, editor?.parentId, editor?.afterId, measure]);
  const initialized = useRef(navigation.mapWorkspaceId === workspaceId);
  const latest = useRef({ view, onNavigation, layout });
  latest.current = { view: camera.current, onNavigation, layout };
  const gesture = useRef<Gesture>();
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const holdTimer = useRef<number>();
  const selectTimer = useRef<number>();
  const [drag, setDrag] = useState<Drag>();
  const dragRef = useRef<Drag>();
  const dragFrame = useRef<number>();
  const updateDrag = (next?: Drag) => {
    dragRef.current = next;
    if (!next) { if (dragFrame.current !== undefined) cancelAnimationFrame(dragFrame.current); dragFrame.current = undefined; setDrag(undefined); return; }
    if (dragFrame.current === undefined) dragFrame.current = requestAnimationFrame(() => { dragFrame.current = undefined; setDrag(dragRef.current); });
  };
  useEffect(() => () => { if (dragFrame.current !== undefined) cancelAnimationFrame(dragFrame.current); }, []);
  const animatedNodes = useMapLayoutMotion(layout.nodes);
  const frozen = useRef(layout.nodes);
  if (!gesture.current) frozen.current = animatedNodes;
  const nodes = gesture.current ? frozen.current : animatedNodes;
  const byId = useMemo(() => new Map(nodes.map(node => [node.id, node])), [nodes]);
  const draggedIds = new Set<string>();
  if (drag) { draggedIds.add(drag.id); for (const node of nodes) if (draggedIds.has(node.parentId)) draggedIds.add(node.id); }
  const visible = nodes.filter(node => node.id === editor?.entityId || node.id === navigation.selectedNodeId || (node.x + node.width) * view.zoom + view.panX > -80 && node.x * view.zoom + view.panX < size.width + 80 && (node.y + node.height) * view.zoom + view.panY > -80 && node.y * view.zoom + view.panY < size.height + 80);
  const visibleIds = new Set(visible.map(node => node.id));
  const lineVisible = (node: typeof nodes[number]) => {
    const parent = byId.get(node.parentId);
    if (!parent) return false;
    if (visibleIds.has(node.id) || visibleIds.has(parent.id)) return true;
    return Math.max(node.x + node.width, parent.x + parent.width) * view.zoom + view.panX >= 0 && Math.min(node.x, parent.x) * view.zoom + view.panX <= size.width && Math.max(node.y + node.height, parent.y + parent.height) * view.zoom + view.panY >= 0 && Math.min(node.y, parent.y) * view.zoom + view.panY <= size.height;
  };
  const cancel = () => { window.clearTimeout(holdTimer.current); window.clearTimeout(selectTimer.current); gesture.current = undefined; pointers.current.clear(); updateDrag(); };
  const [cameraSettling, setCameraSettling] = useState(false);
  const fit = (initial = false) => {
    setCameraSettling(true);
    const left = Math.min(...layout.nodes.map(node => node.x)) - 40;
    const right = Math.max(...layout.nodes.map(node => node.x + node.width)) + 40;
    const top = Math.min(...layout.nodes.map(node => node.y)) - 40;
    const bottom = Math.max(...layout.nodes.map(node => node.y + node.height)) + 40;
    const readableStart = initial && size.width < 600;
    const zoom = Math.max(readableStart ? .85 : .2, Math.min(1, size.width / (right - left), size.height / (bottom - top)));
    setView({ zoom, panX: size.width / 2 - (readableStart ? 0 : (left + right) / 2) * zoom, panY: size.height / 2 - (top + bottom) / 2 * zoom });
  };
  useEffect(() => { if (cameraSettling) { const frame = requestAnimationFrame(() => setCameraSettling(false)); return () => cancelAnimationFrame(frame); } }, [view, cameraSettling]);
  const zoomAt = (zoom: number, anchorX = size.width / 2, anchorY = size.height / 2) => setView(current => zoomMapAt(current, zoom, { x: anchorX, y: anchorY }));
  const focusNode = (id = navigation.selectedNodeId ?? ROOT_NODE) => {
    const selected = layout.nodes.find(node => node.id === id);
    if (selected) setView(current => ({ ...current, panX: size.width / 2 - (selected.x + selected.width / 2) * current.zoom, panY: size.height / 2 - (selected.y + selected.height / 2) * current.zoom }));
  };
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
    if ((!navigation.selectedNodeId && !editor?.isNew) || !size.width || gesture.current) return;
    const selected = layout.nodes.find(node => node.id === (editor?.isNew ? editor.entityId : navigation.selectedNodeId));
    if (!selected) return;
    const narrow = window.matchMedia("(max-width: 920px)").matches;
    const previewOverlay = navigation.recordPreviewId && (narrow || (viewport.current?.parentElement?.clientWidth ?? 0) < 720);
    const availableHeight = !editor && navigation.detailsOpen ? size.height * (previewOverlay ? .25 : narrow ? .48 : 1) : size.height;
    setView(current => {
      const left = selected.x * current.zoom + current.panX;
      const top = selected.y * current.zoom + current.panY;
      const right = left + selected.width * current.zoom;
      const bottom = top + selected.height * current.zoom;
      const deltaX = left < 24 ? 24 - left : right > size.width - 24 ? size.width - 24 - right : 0;
      const deltaY = top < 24 ? 24 - top : bottom > availableHeight - 24 ? availableHeight - 24 - bottom : 0;
      return deltaX || deltaY ? { ...current, panX: current.panX + deltaX, panY: current.panY + deltaY } : current;
    });
  }, [navigation.selectedNodeId, navigation.detailsOpen, navigation.recordPreviewId, size, layout, editor?.entityId, Boolean(editor)]);
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
  const focusedSelection = useRef<{ id: string; button: HTMLButtonElement }>();
  useEffect(() => {
    if (editor) { focusedSelection.current = undefined; return; }
    if (!navigation.selectedNodeId || (focusedSelection.current?.id === navigation.selectedNodeId && focusedSelection.current.button.isConnected)) return;
    const frame = window.requestAnimationFrame(() => {
      const button = viewport.current?.querySelector<HTMLButtonElement>('[data-node-id="' + CSS.escape(navigation.selectedNodeId!) + '"] .knowledge-map-label');
      if (button) { button.focus({ preventScroll: true }); focusedSelection.current = { id: navigation.selectedNodeId!, button }; }
    });
    return () => window.cancelAnimationFrame(frame);
  }, [Boolean(editor), navigation.selectedNodeId, layout, view, nodes]);
  const focusNeighbor = (direction: MapDirection) => {
    const nextId = mapNeighbor(layout.nodes, navigation.selectedNodeId, direction);
    if (!nextId) return false;
    onSelect(nextId);
    return true;
  };
  const handleKeyboard = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.defaultPrevented || editor || gesture.current || event.nativeEvent.isComposing || event.ctrlKey || event.metaKey || event.altKey || (event.target as Element).closest("form, input, textarea, [contenteditable=true], .knowledge-map-toggle")) return;
    if ((event.key === "Enter" || event.key === "Tab") && !organizing) return;
    if ((event.key === "Enter" || event.key === "Tab") && event.repeat) { event.preventDefault(); return; }
    const selected = navigation.selectedNodeId ? state.entities[navigation.selectedNodeId] : undefined;
    if (event.key === "Enter" && selected?.kind === "node") {
      event.preventDefault();
      const position = valueOf(state, selected, "position") as KnowledgePosition;
      onCreate(position.parentNodeId, selected.id);
      return;
    }
    if (event.key === "Tab" && selected?.kind === "node") {
      if (event.shiftKey) return;
      event.preventDefault();
      onCreate(selected.id);
      return;
    }
    if (event.key.startsWith("Arrow")) {
      if (navigation.selectedNodeId) { event.preventDefault(); focusNeighbor(event.key as MapDirection); }
      else if (!navigation.selectedNodeId) {
        event.preventDefault();
        setView(current => ({ ...current, panX: current.panX + (event.key === "ArrowLeft" ? 48 : event.key === "ArrowRight" ? -48 : 0), panY: current.panY + (event.key === "ArrowUp" ? 48 : event.key === "ArrowDown" ? -48 : 0) }));
      }
    }
  };
  const dropPreview = drag?.drop ? mapDropPreview(nodes, drag.id, drag.drop) : undefined;
  return <section className="knowledge-map-section" aria-label="专题导图">
    {editor?.isNew && !layout.nodes.some(node => node.id === editor.entityId) && <div className="knowledge-map-new"><KnowledgeTitleInput editor={editor} label="新建节点" /></div>}
    <div className="knowledge-map-context" aria-live="polite"><span>专题导图</span><small>{layout.nodes.length - 1} 个可见节点 · 单击选择，双击编辑</small></div>
    {navigation.selectedNodeId && !editor && <div className="knowledge-map-selection-tools" aria-label="选中节点操作"><button type="button" onClick={() => onDetails(navigation.selectedNodeId!)}><PanelRightOpen size={15} />查看详情</button><button type="button" onClick={() => focusNode()}><Focus size={15} />聚焦</button>{organizing && <button type="button" onClick={() => onEdit(navigation.selectedNodeId!)}><Pencil size={15} />改名</button>}</div>}
    <div className="knowledge-map-controls"><button type="button" onClick={() => zoomAt(camera.current.zoom / 1.2)} aria-label="缩小导图"><Minus size={16} /></button><output>{Math.round(view.zoom * 100)}%</output><button type="button" onClick={() => zoomAt(camera.current.zoom * 1.2)} aria-label="放大导图"><Plus size={16} /></button><span className="knowledge-map-control-divider" /><button type="button" onClick={() => focusNode(ROOT_NODE)} aria-label="回到中心"><Home size={16} /></button><button type="button" onClick={() => fit()}><Maximize2 size={15} /><span>查看全貌</span></button></div>
    {drag && <div className="knowledge-drop-message" role="status">{dropMessage}</div>}
    <div className="knowledge-map-viewport" ref={viewport} tabIndex={0} aria-label="可平移缩放的导图画布" aria-busy={cameraSettling}
      onDoubleClick={event => { if (editor || (event.target as Element).closest("form, .knowledge-map-toggle")) return; const id = document.elementFromPoint(event.clientX, event.clientY)?.closest<HTMLElement>("[data-node-id]")?.dataset.nodeId; if (id) { window.clearTimeout(selectTimer.current); onEdit(id); } }}
      onWheel={event => { if (gesture.current || (event.target as Element).closest("input, textarea, form")) return; if (event.ctrlKey || event.metaKey) { const rect = event.currentTarget.getBoundingClientRect(); zoomAt(wheelMapZoom(camera.current.zoom, event.deltaY, event.deltaMode, size.height), event.clientX - rect.left, event.clientY - rect.top); } else { const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? size.height : 1; setView(current => ({ ...current, panX: current.panX - event.deltaX * unit, panY: current.panY - event.deltaY * unit })); } }}
      onKeyDown={handleKeyboard}
      onPointerDown={event => {
        if (event.button !== 0 || (event.target as Element).closest("form, input, .knowledge-map-toggle, .knowledge-map-count")) return;
        window.clearTimeout(selectTimer.current);
        pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
        event.currentTarget.setPointerCapture(event.pointerId);
        if (pointers.current.size > 1) {
          window.clearTimeout(holdTimer.current);
          const values = [...pointers.current.values()];
          const bounds = event.currentTarget.getBoundingClientRect();
          gesture.current = { x: 0, y: 0, panX: camera.current.panX, panY: camera.current.panY, ready: false, moved: true, touch: true, zoom: camera.current.zoom, midpoint: { x: (values[0].x + values[1].x) / 2 - bounds.left, y: (values[0].y + values[1].y) / 2 - bounds.top }, pinch: Math.hypot(values[0].x - values[1].x, values[0].y - values[1].y) };
          updateDrag(); return;
        }
        const nodeId = (event.target as Element).closest<HTMLElement>("[data-node-id]")?.dataset.nodeId;
        const current: Gesture = { x: event.clientX, y: event.clientY, panX: view.panX, panY: view.panY, nodeId, ready: event.pointerType !== "touch", moved: false, touch: event.pointerType === "touch", zoom: view.zoom };
        gesture.current = current;
        if (organizing && current.touch && current.nodeId) holdTimer.current = window.setTimeout(() => { if (gesture.current === current && !current.moved) { current.ready = true; updateDrag({ id: current.nodeId!, deltaX: 0, deltaY: 0 }); } }, 350);
      }}
      onPointerMove={event => {
        const current = gesture.current;
        if (!current || !pointers.current.has(event.pointerId)) return;
        pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
        if (pointers.current.size > 1) {
          const values = [...pointers.current.values()];
          if (current.pinch && current.midpoint) {
            const bounds = event.currentTarget.getBoundingClientRect();
            setView(pinchMap(current, current.midpoint, { x: (values[0].x + values[1].x) / 2 - bounds.left, y: (values[0].y + values[1].y) / 2 - bounds.top }, Math.hypot(values[0].x - values[1].x, values[0].y - values[1].y) / current.pinch));
          }
          return;
        }
        if (current.pinch) return;
        const deltaX = event.clientX - current.x; const deltaY = event.clientY - current.y;
        if (!current.moved && Math.hypot(deltaX, deltaY) < (current.touch ? 10 : 6)) return;
        current.moved = true; window.clearTimeout(holdTimer.current);
        if (current.nodeId && current.ready && organizing) {
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
          if (nodeId) onSelect(nodeId);
          else onClear();
        }
        gesture.current = undefined; updateDrag();
      }}
      onPointerCancel={cancel}>
      <div className="knowledge-map-plane" style={{ transform: "translate(" + view.panX + "px," + view.panY + "px) scale(" + view.zoom + ")" }}>
        <svg aria-hidden="true" className="knowledge-map-lines" width="1" height="1">{nodes.filter(node => node.id !== ROOT_NODE && lineVisible(node)).map(node => <path key={node.id} data-branch={node.branch} data-depth={node.depth} d={knowledgeMapPath(byId.get(node.parentId)!, node)} />)}</svg>
         {dropPreview && <svg aria-hidden="true" className="knowledge-map-drop-preview" data-drop-preview-mode={drag?.drop?.mode} width="1" height="1"><path d={dropPreview.path} /><rect x={dropPreview.slot.x} y={dropPreview.slot.y} width={dropPreview.slot.width} height={dropPreview.slot.height} rx="6" /><circle cx={dropPreview.x} cy={dropPreview.y} r="4" /></svg>}
        {visible.map(node => <div key={node.id} data-node-id={node.id === ROOT_NODE ? undefined : node.id} data-map-root={node.id === ROOT_NODE || undefined} data-branch={node.branch} data-side={node.side} data-depth={node.depth} data-drop={drag?.drop?.targetId === node.id ? drag.drop.mode : undefined} className={"knowledge-map-node" + (node.id === ROOT_NODE ? " knowledge-map-center" : "") + (navigation.selectedNodeId === node.id ? " selected" : "") + (draggedIds.has(node.id) ? " dragging" : "")} style={{ left: node.x, top: node.y, width: node.width, minHeight: node.height }}>
          {node.id === ROOT_NODE ? <strong>{knowledgeLabel(state, state.entities[workspaceId])}</strong> : editor?.entityId === node.id ? <KnowledgeTitleInput editor={editor} label={editor.isNew ? "新建节点" : "节点标题"} /> : <><button className="knowledge-map-label" aria-pressed={navigation.selectedNodeId === node.id} onKeyDown={event => { if (event.key === "F2") { event.preventDefault(); window.clearTimeout(selectTimer.current); onEdit(node.id); } }} onClick={event => { if (event.detail === 0) onSelect(node.id); }}>{knowledgeLabel(state, state.entities[node.id])}</button>{node.count > 0 && <button type="button" className="knowledge-map-count" aria-label={"查看 " + node.count + " 条日志"} onDoubleClick={event => event.stopPropagation()} onClick={() => onDetails(node.id)}><FileText size={13} />{node.count}</button>}</>}
          {node.hasChildren && <button className="knowledge-map-toggle" aria-expanded={!navigation.collapsed.includes(node.id)} aria-label={navigation.collapsed.includes(node.id) ? "展开分支" : "折叠分支"} onPointerDown={event => event.stopPropagation()} onDoubleClick={event => event.stopPropagation()} onClick={() => onToggle(node.id)}><span>{navigation.collapsed.includes(node.id) ? "+" : "−"}</span></button>}
        </div>)}
        {drag && <div className="knowledge-map-ghost" aria-hidden="true" style={{ transform: "translate(" + drag.deltaX + "px," + drag.deltaY + "px)" }}><svg className="knowledge-map-lines" width="1" height="1">{nodes.filter(node => draggedIds.has(node.id) && draggedIds.has(node.parentId)).map(node => <path key={node.id} data-branch={node.branch} d={knowledgeMapPath(byId.get(node.parentId)!, node)} />)}</svg>{nodes.filter(node => draggedIds.has(node.id)).map(node => <div className="knowledge-map-node" data-branch={node.branch} key={node.id} style={{ left: node.x, top: node.y, width: node.width, minHeight: node.height }}><span className="knowledge-map-label">{knowledgeLabel(state, state.entities[node.id])}</span></div>)}</div>}
      </div>
    </div>
  </section>;
};
