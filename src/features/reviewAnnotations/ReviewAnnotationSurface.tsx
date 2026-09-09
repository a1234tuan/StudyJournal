import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import { ArrowUpRight, Circle, Diamond, Eraser, Highlighter, ListFilter, MousePointer2, Pencil, Redo2, RectangleHorizontal, Slash, TextCursorInput, Trash2, Type, Undo2 } from "lucide-react";

import { newId } from "../../lib/entity";
import { formatUiError } from "../../lib/uiError";
import type { ReviewAnnotationDraft, ReviewAnnotationElement, ReviewAnnotationPoint, ReviewAnnotationTool } from "./domain";
import { reviewAnnotationRepository } from "./repository";

interface Props {
  recordId: string;
  occurrenceKey: string;
  contentRevision: string;
  children: ReactNode;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}

const colors = ["#d1495b", "#2364aa", "#2a9d8f", "#111827", "#f4b942"];
const drawable: ReviewAnnotationTool[] = ["pen", "highlighter", "line", "arrow", "rectangle", "ellipse", "diamond"];
const toolLabels: Record<ReviewAnnotationTool | "pointer", string> = {
  pointer: "浏览",
  pen: "画笔",
  highlighter: "荧光笔",
  eraser: "橡皮",
  line: "直线",
  arrow: "箭头",
  rectangle: "矩形",
  ellipse: "圆形",
  diamond: "菱形",
  text: "文本",
  input: "输入框",
  select: "下拉选择",
};

const emptyDraft = (recordId: string, occurrenceKey: string, contentRevision: string): ReviewAnnotationDraft => ({
  id: `${recordId}:${occurrenceKey}`,
  recordId,
  reviewOccurrenceKey: occurrenceKey,
  contentRevision,
  schemaVersion: 1,
  elements: [],
  history: [[]],
  historyCursor: 0,
  updatedAt: new Date().toISOString(),
});

export const ReviewAnnotationSurface = ({ recordId, occurrenceKey, contentRevision, children, open: controlledOpen, onOpenChange }: Props) => {
  const rootRef = useRef<HTMLDivElement>(null);
  const saveTimer = useRef<number>();
  const latestDraftRef = useRef<ReviewAnnotationDraft>();
  const [localOpen, setLocalOpen] = useState(false);
  const open = controlledOpen ?? localOpen;
  const setOpen = (next: boolean | ((current: boolean) => boolean)) => {
    const resolved = typeof next === "function" ? next(open) : next;
    setLocalOpen(resolved);
    onOpenChange?.(resolved);
  };
  const [tool, setTool] = useState<ReviewAnnotationTool | "pointer">("pointer");
  const [color, setColor] = useState(colors[0]);
  const [strokeWidth, setStrokeWidth] = useState(3);
  const [opacity, setOpacity] = useState(1);
  const [draft, setDraft] = useState(() => emptyDraft(recordId, occurrenceKey, contentRevision));
  const [drawing, setDrawing] = useState<ReviewAnnotationElement>();
  const [layoutVersion, setLayoutVersion] = useState(0);
  const [eraserSize, setEraserSize] = useState(28);
  const [eraserPointer, setEraserPointer] = useState<{ x: number; y: number }>();
  const [selectEditor, setSelectEditor] = useState<{ id: string; options: string[] }>();
  const [selectedElementIds, setSelectedElementIds] = useState<string[]>([]);
  const interactionRef = useRef<{ mode: "move" | "box" | "resize"; startX: number; startY: number; base: ReviewAnnotationElement[]; ids: string[]; bounds?: { left: number; top: number; right: number; bottom: number }; handle?: string; last?: ReviewAnnotationElement[] }>();
  const [selectionBox, setSelectionBox] = useState<{ left: number; top: number; width: number; height: number }>();
  const controlRefs = useRef(new Map<string, HTMLTextAreaElement>());
  const [error, setError] = useState("");

  useEffect(() => {
    let active = true;
    void reviewAnnotationRepository.getDraft(recordId, occurrenceKey).then((saved) => {
      if (active && saved && !saved.pendingClear && saved.contentRevision === contentRevision) setDraft(saved);
    }).catch((reason) => active && setError(formatUiError(reason, "review-annotation")));
    return () => { active = false; };
  }, [contentRevision, occurrenceKey, recordId]);

  useEffect(() => {
    const root = rootRef.current;
    if (!root || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => requestAnimationFrame(() => setLayoutVersion((value) => value + 1)));
    observer.observe(root);
    root.querySelectorAll(".ProseMirror > *").forEach((node) => observer.observe(node));
    return () => observer.disconnect();
  }, [recordId]);

  useEffect(() => {
    if (!open) return;
    return undefined;
  }, [open]);

  useEffect(() => {
    if (!open || !draft.elements.length) return;
    const latestText = [...draft.elements].reverse().find((element) => element.kind === "text" && !element.value);
    if (latestText) requestAnimationFrame(() => controlRefs.current.get(latestText.id)?.focus());
  }, [draft.elements, open]);

  const persist = useCallback((next: ReviewAnnotationDraft) => {
    latestDraftRef.current = next;
    window.clearTimeout(saveTimer.current);
    saveTimer.current = window.setTimeout(() => {
      void reviewAnnotationRepository.upsertDraft(next).catch((reason) => setError(formatUiError(reason, "review-annotation")));
    }, 250);
  }, []);

  useEffect(() => () => {
    window.clearTimeout(saveTimer.current);
    if (latestDraftRef.current) void reviewAnnotationRepository.upsertDraft(latestDraftRef.current);
  }, []);

  const commit = (elements: ReviewAnnotationElement[]) => setDraft((current) => {
    const history = [...current.history.slice(0, current.historyCursor + 1), elements].slice(-101);
    const next = { ...current, elements, history, historyCursor: history.length - 1, updatedAt: new Date().toISOString() };
    persist(next);
    return next;
  });

  const blocks = () => Array.from(rootRef.current?.querySelectorAll<HTMLElement>(".ProseMirror > *") ?? []);
  const fingerprint = (node: HTMLElement) => `${node.tagName}:${(node.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 160)}`;
  const nodeFor = (element: ReviewAnnotationElement) => {
    const nodes = blocks();
    const indexed = nodes[element.anchorIndex];
    if (!element.anchorFingerprint || (indexed && fingerprint(indexed) === element.anchorFingerprint)) return indexed ?? rootRef.current!;
    return nodes.find((node) => fingerprint(node) === element.anchorFingerprint) ?? indexed ?? rootRef.current!;
  };
  const anchorFor = (clientY: number) => {
    const nodes = blocks();
    const index = Math.max(0, nodes.findIndex((node) => { const rect = node.getBoundingClientRect(); return clientY >= rect.top && clientY <= rect.bottom; }));
    return { index, node: nodes[index] ?? rootRef.current! };
  };
  const pointIn = (clientX: number, clientY: number, node: HTMLElement): ReviewAnnotationPoint => {
    const rect = node.getBoundingClientRect();
    return { x: (clientX - rect.left) / Math.max(1, rect.width), y: (clientY - rect.top) / Math.max(1, rect.height) };
  };
  const screenBounds = (element: ReviewAnnotationElement) => {
    const root = rootRef.current?.getBoundingClientRect(); const node = nodeFor(element); const rect = node?.getBoundingClientRect();
    if (!root || !rect || !element.points.length) return undefined;
    const xs = element.points.map((point) => rect.left - root.left + point.x * rect.width);
    const ys = element.points.map((point) => rect.top - root.top + point.y * rect.height);
    return { left: Math.min(...xs), top: Math.min(...ys), right: Math.max(...xs), bottom: Math.max(...ys) };
  };
  const selectedBounds = (ids: readonly string[]) => {
    const items = draft.elements.filter((element) => ids.includes(element.id)).map(screenBounds).filter(Boolean) as Array<{ left: number; top: number; right: number; bottom: number }>;
    return items.length ? { left: Math.min(...items.map((item) => item.left)), top: Math.min(...items.map((item) => item.top)), right: Math.max(...items.map((item) => item.right)), bottom: Math.max(...items.map((item) => item.bottom)) } : undefined;
  };
  const hitElement = (x: number, y: number) => [...draft.elements].reverse().find((element) => { const bounds = screenBounds(element); return bounds && x >= bounds.left - 8 && x <= bounds.right + 8 && y >= bounds.top - 8 && y <= bounds.bottom + 8; });

  const pointerDown = (event: ReactPointerEvent) => {
    if (!open) return;
    if (tool === "pointer") {
      if ((event.target as Element).closest("textarea,select,input")) return;
      const root = rootRef.current?.getBoundingClientRect(); if (!root) return;
      const x = event.clientX - root.left; const y = event.clientY - root.top;
      const handle = (event.target as SVGElement).dataset?.selectionHandle;
      if (handle) {
        const bounds = selectedBounds(selectedElementIds);
        if (bounds) interactionRef.current = { mode: handle === "move" ? "move" : "resize", startX: x, startY: y, base: draft.elements, ids: selectedElementIds, bounds, handle };
        event.currentTarget.setPointerCapture(event.pointerId); return;
      }
      const hit = hitElement(x, y);
      if (hit) {
        const ids = event.shiftKey || event.ctrlKey ? (selectedElementIds.includes(hit.id) ? selectedElementIds.filter((id) => id !== hit.id) : [...selectedElementIds, hit.id]) : [hit.id];
        setSelectedElementIds(ids);
        if (!event.shiftKey && !event.ctrlKey) interactionRef.current = { mode: "move", startX: x, startY: y, base: draft.elements, ids };
      } else {
        setSelectedElementIds([]); setSelectionBox({ left: x, top: y, width: 0, height: 0 });
        interactionRef.current = { mode: "box", startX: x, startY: y, base: draft.elements, ids: [] };
      }
      event.currentTarget.setPointerCapture(event.pointerId); return;
    }
    const { index, node } = anchorFor(event.clientY);
    if (tool === "eraser") {
      const point = pointIn(event.clientX, event.clientY, node);
      setEraserPointer({ x: event.clientX, y: event.clientY });
      const threshold = eraserSize / Math.max(1, Math.min(node.getBoundingClientRect().width, node.getBoundingClientRect().height));
      const distanceToSegment = (a: ReviewAnnotationPoint, b: ReviewAnnotationPoint) => {
        const dx = b.x - a.x; const dy = b.y - a.y;
        const t = Math.max(0, Math.min(1, ((point.x - a.x) * dx + (point.y - a.y) * dy) / Math.max(1e-6, dx * dx + dy * dy)));
        return Math.hypot(point.x - (a.x + t * dx), point.y - (a.y + t * dy));
      };
      const candidate = [...draft.elements].reverse().find((element) => {
        if (element.anchorIndex !== index) return false;
        if (["text", "input", "select"].includes(element.kind)) {
          const first = element.points[0]; const last = element.points.at(-1) ?? first;
          return point.x >= Math.min(first.x, last.x) - threshold && point.x <= Math.max(first.x, last.x) + threshold && point.y >= Math.min(first.y, last.y) - threshold && point.y <= Math.max(first.y, last.y) + threshold;
        }
        return element.points.some((item, pointIndex) => Math.hypot(item.x - point.x, item.y - point.y) <= threshold || (pointIndex > 0 && distanceToSegment(element.points[pointIndex - 1], item) <= threshold));
      });
      if (candidate) commit(draft.elements.filter((element) => element.id !== candidate.id));
      return;
    }
    if (["text", "input", "select"].includes(tool)) {
      const start = pointIn(event.clientX, event.clientY, node);
      const now = new Date().toISOString();
      const width = tool === "select" ? 0.32 : 0.4;
      const newElement = {
        id: newId(), kind: tool, anchorIndex: index, anchorFingerprint: fingerprint(node),
        points: [start, { x: Math.min(0.98, start.x + width), y: Math.min(0.98, start.y + 0.12) }],
        color, width: 1, opacity: 1, value: "", options: tool === "select" ? ["选项 1", "选项 2", "选项 3"] : undefined,
        createdAt: now, updatedAt: now,
      } satisfies ReviewAnnotationElement;
      commit([...draft.elements, newElement]);
      if (tool === "select") setSelectEditor({ id: newElement.id, options: newElement.options ?? ["选项 1", "选项 2", "选项 3"] });
      setTool("pointer");
      return;
    }
    if (!drawable.includes(tool)) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    const now = new Date().toISOString();
    setDrawing({ id: newId(), kind: tool as ReviewAnnotationTool, anchorIndex: index, anchorFingerprint: fingerprint(node), points: [pointIn(event.clientX, event.clientY, node)], color, width: tool === "highlighter" ? Math.max(10, strokeWidth * 4) : strokeWidth, opacity: tool === "highlighter" ? Math.min(0.45, opacity) : opacity, createdAt: now, updatedAt: now });
  };
  const pointerMove = (event: ReactPointerEvent) => {
    if (tool === "pointer" && interactionRef.current) {
      const root = rootRef.current?.getBoundingClientRect(); if (!root) return;
      const interaction = interactionRef.current; const x = event.clientX - root.left; const y = event.clientY - root.top;
      if (interaction.mode === "box") {
        const box = { left: Math.min(x, interaction.startX), top: Math.min(y, interaction.startY), width: Math.abs(x - interaction.startX), height: Math.abs(y - interaction.startY) };
        setSelectionBox(box);
        setSelectedElementIds(draft.elements.filter((element) => { const bounds = screenBounds(element); return bounds && bounds.left <= box.left + box.width && bounds.right >= box.left && bounds.top <= box.top + box.height && bounds.bottom >= box.top; }).map((element) => element.id));
        return;
      }
      const dx = x - interaction.startX; const dy = y - interaction.startY; const idSet = new Set(interaction.ids);
      const transformed = interaction.base.map((element) => {
        if (!idSet.has(element.id)) return element;
        const nodeRect = nodeFor(element).getBoundingClientRect();
        if (interaction.mode === "move") return { ...element, points: element.points.map((point) => ({ x: Math.max(0, Math.min(1, point.x + dx / Math.max(1, nodeRect.width))), y: Math.max(0, Math.min(1, point.y + dy / Math.max(1, nodeRect.height))) })) };
        const bounds = interaction.bounds!; const handle = interaction.handle ?? "se";
        const fixedX = handle.includes("w") ? bounds.right : bounds.left; const fixedY = handle.includes("n") ? bounds.bottom : bounds.top;
        const initialX = handle.includes("w") ? bounds.left : bounds.right; const initialY = handle.includes("n") ? bounds.top : bounds.bottom;
        const scaleX = handle === "n" || handle === "s" ? 1 : Math.max(.05, Math.abs(x - fixedX) / Math.max(1, Math.abs(initialX - fixedX)));
        const scaleY = handle === "e" || handle === "w" ? 1 : Math.max(.05, Math.abs(y - fixedY) / Math.max(1, Math.abs(initialY - fixedY)));
        const rootLeft = root.left; const rootTop = root.top;
        return { ...element, points: element.points.map((point) => { const sx = nodeRect.left - rootLeft + point.x * nodeRect.width; const sy = nodeRect.top - rootTop + point.y * nodeRect.height; return { x: Math.max(0, Math.min(1, (fixedX + (sx - fixedX) * scaleX - (nodeRect.left - rootLeft)) / Math.max(1, nodeRect.width))), y: Math.max(0, Math.min(1, (fixedY + (sy - fixedY) * scaleY - (nodeRect.top - rootTop)) / Math.max(1, nodeRect.height))) }; }) };
      });
      interaction.last = transformed;
      setDraft((current) => ({ ...current, elements: transformed }));
      return;
    }
    if (tool === "eraser" && event.buttons) {
      pointerDown(event);
      return;
    }
    if (!drawing) return;
    const node = nodeFor(drawing);
    const point = pointIn(event.clientX, event.clientY, node);
    setDrawing((current) => current ? { ...current, points: current.kind === "pen" || current.kind === "highlighter" ? [...current.points, point] : [current.points[0], point] } : undefined);
  };
  const pointerUp = () => {
    if (tool === "pointer") {
      const interaction = interactionRef.current; interactionRef.current = undefined; setSelectionBox(undefined);
      if (interaction?.last) setDraft((current) => {
        const history = [...current.history.slice(0, current.historyCursor + 1).slice(0, -1), interaction.base, interaction.last!].slice(-101);
        const next = { ...current, elements: interaction.last!, history, historyCursor: history.length - 1, updatedAt: new Date().toISOString() };
        persist(next); return next;
      });
      return;
    }
    if (!drawing) { setEraserPointer(undefined); return; }
    commit([...draft.elements, drawing]);
    setDrawing(undefined);
    setEraserPointer(undefined);
  };

  const visible = drawing ? [...draft.elements, drawing] : draft.elements;
  const geometries = useMemo(() => visible.map((element) => {
    const node = nodeFor(element);
    const root = rootRef.current?.getBoundingClientRect();
    const rect = node?.getBoundingClientRect();
    if (!root || !rect) return undefined;
    return { element, left: rect.left - root.left, top: rect.top - root.top, width: rect.width, height: rect.height };
  }).filter(Boolean) as Array<{ element: ReviewAnnotationElement; left: number; top: number; width: number; height: number }>, [visible, layoutVersion]);

  const undo = () => setDraft((current) => {
    const cursor = Math.max(0, current.historyCursor - 1);
    const next = { ...current, elements: current.history[cursor] ?? [], historyCursor: cursor, updatedAt: new Date().toISOString() };
    persist(next); return next;
  });
  const redo = () => setDraft((current) => {
    const cursor = Math.min(current.history.length - 1, current.historyCursor + 1);
    const next = { ...current, elements: current.history[cursor] ?? current.elements, historyCursor: cursor, updatedAt: new Date().toISOString() };
    persist(next); return next;
  });

  const updateValue = (id: string, value: string) => setDraft((current) => {
    const next = { ...current, elements: current.elements.map((element) => element.id === id ? { ...element, value, updatedAt: new Date().toISOString() } : element), updatedAt: new Date().toISOString() };
    persist(next); return next;
  });

  return <div className="review-annotation-root" ref={rootRef}>
    {children}
    <button
      type="button"
      className={`review-annotation-entry ${open ? "active" : ""}`}
      aria-label={open ? "关闭批注工具" : "打开批注工具"}
      aria-pressed={open}
      title={open ? "关闭批注" : "打开批注"}
      onClick={() => setOpen((value) => !value)}
    ><Pencil size={18} /></button>
    {open && <div className="review-annotation-toolbar" role="toolbar" aria-label="批注工具栏">
      <span className="review-annotation-current" aria-live="polite">当前：<strong>{toolLabels[tool]}</strong></span>
      <button type="button" aria-label="浏览" aria-pressed={tool === "pointer"} className={tool === "pointer" ? "active" : ""} onClick={() => setTool("pointer")} title="浏览"><MousePointer2 size={17} /></button>
      <button type="button" aria-label="画笔" aria-pressed={tool === "pen"} className={tool === "pen" ? "active" : ""} onClick={() => setTool("pen")} title="画笔"><Pencil size={17} /></button>
      <button type="button" aria-label="荧光笔" aria-pressed={tool === "highlighter"} className={tool === "highlighter" ? "active" : ""} onClick={() => setTool("highlighter")} title="荧光笔"><Highlighter size={17} /></button>
      <button type="button" aria-label="橡皮" aria-pressed={tool === "eraser"} className={tool === "eraser" ? "active" : ""} onClick={() => setTool("eraser")} title="橡皮"><Eraser size={17} /></button>
      <button type="button" aria-label="直线" aria-pressed={tool === "line"} className={tool === "line" ? "active" : ""} onClick={() => setTool("line")} title="直线"><Slash size={17} /></button>
      <button type="button" aria-label="箭头" aria-pressed={tool === "arrow"} className={tool === "arrow" ? "active" : ""} onClick={() => setTool("arrow")} title="箭头"><ArrowUpRight size={17} /></button>
      <button type="button" aria-label="矩形" aria-pressed={tool === "rectangle"} className={tool === "rectangle" ? "active" : ""} onClick={() => setTool("rectangle")} title="矩形"><RectangleHorizontal size={17} /></button>
      <button type="button" aria-label="圆形" aria-pressed={tool === "ellipse"} className={tool === "ellipse" ? "active" : ""} onClick={() => setTool("ellipse")} title="圆形"><Circle size={17} /></button>
      <button type="button" aria-label="菱形" aria-pressed={tool === "diamond"} className={tool === "diamond" ? "active" : ""} onClick={() => setTool("diamond")} title="菱形"><Diamond size={17} /></button>
      <button type="button" aria-label="文本" aria-pressed={tool === "text"} className={tool === "text" ? "active" : ""} onClick={() => setTool("text")} title="文本"><Type size={17} /></button>
      <button type="button" aria-label="输入框" aria-pressed={tool === "input"} className={tool === "input" ? "active" : ""} onClick={() => setTool("input")} title="输入框"><TextCursorInput size={17} /></button>
      <button type="button" aria-label="下拉选择" aria-pressed={tool === "select"} className={tool === "select" ? "active" : ""} onClick={() => setTool("select")} title="下拉选择"><ListFilter size={17} /></button>
      <button type="button" aria-label="撤回批注" onClick={undo} disabled={draft.historyCursor <= 0} title="撤回批注"><Undo2 size={17} /></button>
      <button type="button" aria-label="重做批注" onClick={redo} disabled={draft.historyCursor >= draft.history.length - 1} title="重做批注"><Redo2 size={17} /></button>
      <button type="button" aria-label="清空批注" onClick={() => commit([])} title="清空批注"><Trash2 size={17} /></button>
      <div className="review-annotation-swatches">{colors.map((value) => <button type="button" key={value} className={color === value ? "active" : ""} style={{ background: value }} aria-label={`颜色 ${value}`} aria-pressed={color === value} onClick={() => setColor(value)} />)}</div>
      <label className="review-annotation-range" title="线宽"><span>线宽</span><input type="range" min="1" max="8" value={strokeWidth} onChange={(event) => setStrokeWidth(Number(event.target.value))} /></label>
      {tool === "eraser" && <label className="review-annotation-range" title="橡皮大小"><span>橡皮 {eraserSize}px</span><input type="range" min="8" max="64" value={eraserSize} onChange={(event) => setEraserSize(Number(event.target.value))} /></label>}
      <label className="review-annotation-range" title="透明度"><span>透明度</span><input type="range" min="0.2" max="1" step="0.1" value={opacity} onChange={(event) => setOpacity(Number(event.target.value))} /></label>
    </div>}
    <svg className={`review-annotation-svg ${open && tool !== "pointer" ? "drawing" : ""}`} onPointerDown={pointerDown} onPointerMove={(event) => { if (tool === "eraser") setEraserPointer({ x: event.clientX, y: event.clientY }); pointerMove(event); }} onPointerUp={pointerUp} onPointerCancel={() => { setDrawing(undefined); setEraserPointer(undefined); }}>
      {geometries.map(({ element, left, top, width, height }) => {
        const points = element.points.map((point) => `${left + point.x * width},${top + point.y * height}`);
        const first = element.points[0]; const last = element.points.at(-1) ?? first;
        const x1 = left + first.x * width; const y1 = top + first.y * height; const x2 = left + last.x * width; const y2 = top + last.y * height;
        const common = { stroke: element.color, strokeWidth: element.width, opacity: element.opacity, fill: "none" };
        if (element.kind === "pen" || element.kind === "highlighter") return <polyline key={element.id} points={points.join(" ")} {...common} strokeLinecap="round" strokeLinejoin="round" />;
        if (element.kind === "line" || element.kind === "arrow") { const dx = x2 - x1; const dy = y2 - y1; const length = Math.max(1, Math.hypot(dx, dy)); const ux = dx / length; const uy = dy / length; const px = -uy; const py = ux; const head = 11; const wing = 6; return <g key={element.id}><line x1={x1} y1={y1} x2={x2} y2={y2} {...common} />{element.kind === "arrow" && <polyline points={`${x2 - ux * head + px * wing},${y2 - uy * head + py * wing} ${x2},${y2} ${x2 - ux * head - px * wing},${y2 - uy * head - py * wing}`} {...common} />}</g>; }
        if (element.kind === "ellipse") return <ellipse key={element.id} cx={(x1+x2)/2} cy={(y1+y2)/2} rx={Math.abs(x2-x1)/2} ry={Math.abs(y2-y1)/2} {...common} />;
        if (element.kind === "diamond") return <polygon key={element.id} points={`${(x1+x2)/2},${y1} ${x2},${(y1+y2)/2} ${(x1+x2)/2},${y2} ${x1},${(y1+y2)/2}`} {...common} />;
        return <rect key={element.id} x={Math.min(x1,x2)} y={Math.min(y1,y2)} width={Math.abs(x2-x1)} height={Math.abs(y2-y1)} {...common} />;
      })}
      {selectedElementIds.length > 0 && (() => { const bounds = selectedBounds(selectedElementIds); if (!bounds) return null; const left = bounds.left - 6; const top = bounds.top - 6; const width = bounds.right - bounds.left + 12; const height = bounds.bottom - bounds.top + 12; const handles = [{ id: "nw", x: left, y: top }, { id: "n", x: left + width / 2, y: top }, { id: "ne", x: left + width, y: top }, { id: "e", x: left + width, y: top + height / 2 }, { id: "se", x: left + width, y: top + height }, { id: "s", x: left + width / 2, y: top + height }, { id: "sw", x: left, y: top + height }, { id: "w", x: left, y: top + height / 2 }]; return <g className="review-annotation-selection"><rect data-selection-handle="move" x={left} y={top} width={width} height={height} /><g>{handles.map((handle) => <circle key={handle.id} data-selection-handle={handle.id} cx={handle.x} cy={handle.y} r={5} />)}</g></g>; })()}
      {selectionBox && <rect className="review-annotation-selection-box" x={selectionBox.left} y={selectionBox.top} width={selectionBox.width} height={selectionBox.height} />}
    </svg>
    {geometries.filter(({ element }) => ["text", "input", "select"].includes(element.kind)).map(({ element, left, top, width, height }) => {
      const first = element.points[0]; const last = element.points.at(-1) ?? first;
      const style = { left: left + Math.min(first.x, last.x) * width, top: top + Math.min(first.y, last.y) * height, width: Math.max(120, Math.abs(last.x-first.x) * width), minHeight: Math.max(38, Math.abs(last.y-first.y) * height), color: element.color };
      if (element.kind === "select") return <select key={element.id} className="review-annotation-control" style={style} value={element.value} onChange={(event) => updateValue(element.id, event.target.value)}><option value="">请选择</option>{(element.options?.length ? element.options : ["选项 1", "选项 2", "选项 3"]).map((option) => <option key={option}>{option}</option>)}</select>;
      return <textarea key={element.id} ref={(node) => { if (node) controlRefs.current.set(element.id, node); else controlRefs.current.delete(element.id); }} className={`review-annotation-control ${element.kind}`} style={style} value={element.value} placeholder={element.kind === "text" ? "文本批注" : "输入内容"} onChange={(event) => updateValue(element.id, event.target.value)} />;
    })}
    {eraserPointer && tool === "eraser" && <span className="review-annotation-eraser-cursor" style={{ left: eraserPointer.x - eraserSize / 2, top: eraserPointer.y - eraserSize / 2, width: eraserSize, height: eraserSize }} aria-hidden="true" />}
    {selectEditor && <div className="review-annotation-select-editor" role="dialog" aria-label="编辑下拉选项"><strong>编辑下拉选项</strong>{selectEditor.options.map((option, index) => <input key={`${selectEditor.id}-${index}`} value={option} onChange={(event) => setSelectEditor((current) => current ? { ...current, options: current.options.map((item, itemIndex) => itemIndex === index ? event.target.value : item) } : current)} />)}<div><button type="button" onClick={() => setSelectEditor((current) => current ? { ...current, options: [...current.options, "新选项"] } : current)}>增加选项</button><button type="button" onClick={() => setSelectEditor(undefined)}>取消</button><button type="button" onClick={() => { const options = selectEditor.options.map((item) => item.trim()).filter(Boolean); commit(draft.elements.map((element) => element.id === selectEditor.id ? { ...element, options: options.length ? options : ["选项 1"] } : element)); setSelectEditor(undefined); }}>保存</button></div></div>}
    {error && <div className="review-annotation-error" role="alert">{error}</div>}
  </div>;
};
