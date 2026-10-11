import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { liveQuery } from "dexie";
import { Bookmark, ChevronLeft, ChevronRight, Undo2, X } from "lucide-react";
import { db } from "../../db/database";
import { formatUiError } from "../../lib/uiError";
import { usePageTransitionLayerState } from "../../components/PageTransition";
import { registerReviewNavigationCheck } from "../reviewSession/navigationGuard";
import { markColors, markKinds, projectReviewMarks, type MarkColor, type MarkKind, type ReviewMarkAnchor, type ReviewMarkEvent, type ReviewMarkValue } from "./domain";
import { captureMarkSelection, rectanglesForMark, resolveMarkAnchor, reviewTextBlocks } from "./anchors";
import { anchorForObject, markObjectSelector } from "./structuredAnchors";
import { reviewMarkRepository } from "./repository";
import "./reviewMarks.css";

interface Props { recordId: string; contentRevision: string; children: ReactNode; enabled: boolean; open: boolean; onOpenChange: (open: boolean) => void; entryHost?: HTMLElement | null; viewportOverlayHost?: HTMLElement | null }
interface Paint { markId: string; kind: MarkKind; color: MarkColor; left: number; top: number; width: number; height: number }
interface UndoEntry { markId: string; parents: string[]; value: ReviewMarkValue | null }
const kindLabels: Record<MarkKind, string> = { highlight: "高亮", underline: "下划线", outline: "框选", paragraph: "段落边标" };
const colorLabels: Record<MarkColor, string> = { amber: "琥珀", green: "青绿", blue: "蓝色", rose: "玫红" };

export function ReviewMarkSurface(props: Props) {
  return props.enabled ? <ActiveReviewMarks {...props} /> : <>{props.children}</>;
}

function ActiveReviewMarks({ recordId, contentRevision, children, open, onOpenChange, entryHost, viewportOverlayHost }: Props) {
  const content = useRef<HTMLDivElement>(null);
  const toolsRef = useRef<HTMLElement>(null);
  const [toolsHeight, setToolsHeight] = useState(0);
  const mounted = useRef(true);
  const pending = useRef<Promise<void> | null>(null);
  const pageState = usePageTransitionLayerState();
  const [objects, setObjects] = useState<HTMLElement[]>([]);
  const pointerStart = useRef<{ x: number; y: number } | null>(null);
  const [events, setEvents] = useState<ReviewMarkEvent[]>([]);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [selection, setSelection] = useState<ReviewMarkAnchor | null>(null);
  const [kind, setKind] = useState<MarkKind>("highlight");
  const [color, setColor] = useState<MarkColor>("amber");
  const [label, setLabel] = useState("重点");
  const [activeId, setActiveId] = useState<string | null>(null);
  const [focus, setFocus] = useState(false);
  const [paint, setPaint] = useState<Paint[]>([]);
  const [resolvedIds, setResolvedIds] = useState<string[]>([]);
  const [history, setHistory] = useState<UndoEntry[]>([]);
  const marks = useMemo(() => projectReviewMarks(events), [events]);
  const visible = marks.filter(mark => mark.value || mark.conflict);
  const active = visible.find(mark => mark.markId === activeId);
  const activeValue = active?.value ?? active?.heads.find(head => head.value)?.value;
  const count = marks.filter(mark => mark.value).length;

  useEffect(() => {
    mounted.current = true;
    const subscription = liveQuery(() => db.reviewMarkEvents.where("recordId").equals(recordId).toArray()).subscribe({ next: rows => { setEvents(rows); setReady(true); }, error: reason => { setError(formatUiError(reason, "review-marks")); setReady(false); } });
    return () => { mounted.current = false; subscription.unsubscribe(); };
  }, [recordId]);

  useEffect(() => {
    if (pageState === "exiting") return;
    return registerReviewNavigationCheck(() => pending.current ?? undefined);
  }, [pageState]);
  useEffect(() => {
    const warn = (event: BeforeUnloadEvent) => { if (pending.current) { event.preventDefault(); event.returnValue = ""; } };
    window.addEventListener("beforeunload", warn); return () => window.removeEventListener("beforeunload", warn);
  }, []);

  useEffect(() => { setSelection(null); setActiveId(null); setHistory([]); }, [contentRevision]);

  useEffect(() => {
    if (!open) { setSelection(null); setFocus(false); return; }
    const capture = () => {
      if (!content.current) return;
      try { const selected = window.getSelection(); if (selected && !selected.isCollapsed && selected.anchorNode && content.current.contains(selected.anchorNode)) { setSelection(captureMarkSelection(content.current, selected)); setError(""); } }
      catch (reason) { setSelection(null); setError(formatUiError(reason, "review-marks")); }
    };
    document.addEventListener("selectionchange", capture);
    return () => document.removeEventListener("selectionchange", capture);
  }, [open]);

  useEffect(() => {
    const root = content.current;
    if (!root) return;
    let frame = 0;
    const measure = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const origin = root.getBoundingClientRect();
        const available = Array.from(root.querySelectorAll<HTMLElement>(markObjectSelector));
        setObjects(current => current.length === available.length && current.every((item, index) => item === available[index]) ? current : available);
        const next: Paint[] = [];
        const blocks = reviewTextBlocks(root);
        const located: { markId: string; blockIndex: number; start: number }[] = [];
        for (const mark of marks) {
          if (!mark.value || mark.conflict) continue;
          const anchor = resolveMarkAnchor(root, mark.value.anchor);
          if (!anchor) continue;
          located.push({ markId: mark.markId, blockIndex: blocks.indexOf(anchor.block), start: anchor.start });
          const bounds = rectanglesForMark(root, anchor, mark.value.kind === "paragraph");
          for (const rect of bounds) {
            if (rect.width <= 0 || rect.height <= 0) continue;
            next.push({ markId: mark.markId, kind: mark.value.kind, color: mark.value.color, left: rect.left - origin.left, top: rect.top - origin.top, width: rect.width, height: rect.height });
          }
        }
        setPaint(next); setResolvedIds(located.sort((left, right) => left.blockIndex - right.blockIndex || left.start - right.start).map(item => item.markId));
      });
    };
    const resize = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure); resize?.observe(root);
    const editor = root.querySelector(".ProseMirror");
    const changes = new MutationObserver(measure);
    if (editor) { changes.observe(editor, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ["data-latex"] }); resize?.observe(editor); }
    let disposed = false;
    void document.fonts?.ready.then(() => { if (!disposed) measure(); });
    root.addEventListener("load", measure, true); root.addEventListener("scroll", measure, true); window.addEventListener("resize", measure);
    measure();
    return () => { disposed = true; cancelAnimationFrame(frame); resize?.disconnect(); changes.disconnect(); root.removeEventListener("load", measure, true); root.removeEventListener("scroll", measure, true); window.removeEventListener("resize", measure); };
  }, [marks, contentRevision, open, focus]);

  useEffect(() => {
    if (!open || !viewportOverlayHost || !toolsRef.current) return;
    const measure = () => setToolsHeight(toolsRef.current?.getBoundingClientRect().height ?? 0);
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
    observer?.observe(toolsRef.current); measure();
    return () => observer?.disconnect();
  }, [open, viewportOverlayHost]);

  const write = useCallback((value: ReviewMarkValue | null, markId?: string, parents: string[] = [], undo = false) => {
    if (pending.current || !ready) return;
    setBusy(true); setError("");
    const before = marks.find(mark => mark.markId === markId);
    const operation = reviewMarkRepository.write(recordId, contentRevision, value, markId, parents).then(event => {
      if (!mounted.current) return;
      setEvents(rows => rows.some(row => row.id === event.id) ? rows : [...rows, event]);
      setActiveId(value ? event.markId : null); setSelection(null);
      if (undo) setHistory(items => items.slice(0, -1).map(item => item.markId === event.markId ? { ...item, parents: [event.id] } : item));
      else if (before?.conflict) setHistory([]);
      else setHistory(items => [...items, { markId: event.markId, parents: [event.id], value: before?.value ?? null }].slice(-50));
    });
    pending.current = operation;
    void operation.catch(reason => { if (mounted.current) { setError(formatUiError(reason, "review-marks")); if (undo) setHistory([]); } }).finally(() => {
      if (pending.current === operation) pending.current = null;
      if (mounted.current) setBusy(false);
    });
  }, [ready, marks, recordId, contentRevision]);

  const undoLast = useCallback(() => {
    const last = history.at(-1);
    if (last) write(last.value, last.markId, last.parents, true);
  }, [history, write]);
  useEffect(() => {
    if (!open || pageState === "exiting") return;
    const shortcut = (event: KeyboardEvent) => {
      if (event.key.toLowerCase() !== "z" || !(event.ctrlKey || event.metaKey) || event.shiftKey || event.altKey || event.isComposing) return;
      if (event.target instanceof Element && event.target.closest("input, textarea, select, [contenteditable=true]")) return;
      event.preventDefault(); event.stopImmediatePropagation(); undoLast();
    };
    window.addEventListener("keydown", shortcut, true); return () => window.removeEventListener("keydown", shortcut, true);
  }, [open, pageState, undoLast]);

  const jump = (markId: string) => {
    setActiveId(markId); setSelection(null);
    const mark = marks.find(item => item.markId === markId);
    const value = mark?.value ?? mark?.heads.find(head => head.value)?.value;
    if (value) { setKind(value.kind); setColor(value.color); setLabel(value.label || "重点"); }
    if (!mark?.value || mark.conflict || !content.current) return;
    resolveMarkAnchor(content.current, mark.value.anchor)?.block.scrollIntoView({ block: "center", behavior: "auto" });
  };
  const step = (direction: number) => {
    const index = resolvedIds.indexOf(activeId ?? "");
    const target = resolvedIds[index < 0 ? direction > 0 ? 0 : resolvedIds.length - 1 : (index + direction + resolvedIds.length) % resolvedIds.length];
    if (target) jump(target);
  };
  const chooseObject = (element: HTMLElement) => {
    if (!content.current) return;
    try {
      const anchor = anchorForObject(content.current, element);
      if (!anchor) { setSelection(null); setError("此内容暂不能整体标记，请尝试选中文字。"); return; }
      window.getSelection()?.removeAllRanges(); setSelection(anchor); setError("");
    } catch (reason) { setSelection(null); setError(formatUiError(reason, "review-marks")); }
  };
  const parents = active?.heads.map(head => head.id) ?? [];
  const entry = <button type="button" className="review-mark-entry" aria-label="永久复习印记" aria-expanded={open} title="永久复习印记，仅在普通间隔复习显示" onClick={() => onOpenChange(!open)}><Bookmark size={17} /><span>印记{count > 0 ? " " + count : ""}</span></button>;

  const tools = <section ref={toolsRef} className={viewportOverlayHost ? "review-mark-tools review-mark-dock review-viewport-dock" : "review-mark-tools"} aria-label="印记工具">
      <div className="review-mark-tools-heading"><strong>永久印记</strong><span>仅复习可见 · 自动保存</span><button type="button" aria-label="关闭印记工具" onClick={() => onOpenChange(false)}><X size={17} /></button></div>
      <p className="review-mark-hint">选字或点选公式、代码块后标记。</p>
      <div className="review-mark-options">
        <label>样式<select aria-label="印记样式" value={kind} onChange={event => setKind(event.target.value as MarkKind)}>{markKinds.map(item => <option key={item} value={item}>{kindLabels[item]}</option>)}</select></label>
        <div className="review-mark-colors" role="group" aria-label="印记颜色">{markColors.map(item => <button type="button" key={item} data-color={item} aria-label={colorLabels[item] + "印记"} aria-pressed={color === item} onClick={() => setColor(item)}><span /></button>)}</div>
        <label>提示<select aria-label="印记提示" value={label} onChange={event => setLabel(event.target.value)}><option>重点</option><option>易混</option><option>已熟悉</option></select></label>
      </div>
      {objects.length > 0 && <label className="review-mark-object-picker">整体选择<select aria-label="选择公式或代码块" value="" onChange={event => { const element = objects[Number(event.target.value)]; if (element) chooseObject(element); }}><option value="" disabled>公式 / 代码块…</option>{objects.map((element, index) => <option key={index} value={index}>{index + 1}. {element.matches("pre") ? "代码块：" + (element.textContent ?? "").slice(0, 36) : "公式：" + (element.getAttribute("data-latex") ?? "").slice(0, 36)}</option>)}</select></label>}
      {selection && <p className="review-mark-selection">已选：{selection.quote.slice(0, 80)}{selection.quote.length > 80 ? "…" : ""}</p>}
      <div className="review-mark-actions">
        <button type="button" className="primary-button" disabled={!selection || busy || !ready} onClick={() => selection && write({ anchor: selection, kind, color, label })}>{selection?.structured ? "标记选中内容" : "标记选中文字"}</button>
        <button type="button" disabled={!history.length || busy} onClick={undoLast}><Undo2 size={15} />撤销印记</button>
        <button type="button" disabled={!resolvedIds.length} aria-label="上一处印记" onClick={() => step(-1)}><ChevronLeft size={16} /></button>
        <button type="button" disabled={!resolvedIds.length} aria-label="下一处印记" onClick={() => step(1)}><ChevronRight size={16} /></button>
        <button type="button" aria-pressed={focus} onClick={() => setFocus(value => !value)}>重点列表</button>
      </div>
      {focus && <div className="review-mark-list" aria-label="印记列表">
        {!visible.length && <p>还没有印记。选中文字后即可留下长期提示。</p>}
        {visible.map(mark => {
          const value = mark.value ?? mark.heads.find(head => head.value)?.value;
          return <button type="button" key={mark.markId} className="review-mark-list-item" aria-pressed={activeId === mark.markId} onClick={() => jump(mark.markId)}><span>{value?.label || "印记"} · {mark.conflict ? "存在并发修改，请确认" : resolvedIds.includes(mark.markId) ? "查看上下文" : "原文变化或重复，待重新定位"}</span><strong>{value?.anchor.quote ?? "已擦除"}</strong></button>;
        })}
      </div>}
      {focus && active && <div className="review-mark-edit" aria-label="编辑选中印记">
        {active.conflict && <p>其他设备也修改了此印记。选择一个版本确认保留，或确认擦除；不会自动覆盖。</p>}
        {active.conflict ? active.heads.filter(head => head.value).map((head, index) => <button type="button" key={head.id} disabled={busy} onClick={() => write(head.value, active.markId, parents)}>保留版本 {index + 1} · {head.value ? colorLabels[head.value.color] + kindLabels[head.value.kind] : ""}</button>) : <button type="button" disabled={!activeValue || busy} onClick={() => activeValue && write({ ...activeValue, kind, color, label }, active.markId, parents)}>更新印记样式</button>}
        <button type="button" disabled={!selection || busy} onClick={() => selection && write({ anchor: selection, kind, color, label }, active.markId, parents)}>移到所选文字</button>
        <button type="button" disabled={busy} onClick={() => write(null, active.markId, parents)}>{active.conflict ? "确认擦除此印记" : "擦除印记"}</button>
      </div>}
      <details className="review-mark-help"><summary>说明与同步</summary><p className="review-mark-hint">“已熟悉”只是阅读提示，不改变评分或复习间隔。印记参与云同步与备份；同步设备需全部升级。支持公式整体、代码片段/整块，以及同段文字夹公式；公式按源码定位。图片、跨段圈画和公式内部局部标记暂不支持。</p></details>
      {error && <p role="alert" className="review-mark-error">{error}</p>}
      {busy && <span className="review-mark-hint" role="status">正在保存印记…</span>}
    </section>;

  return <section className="review-marks" style={{ paddingBottom: open && viewportOverlayHost ? toolsHeight + 16 : undefined }} aria-label="永久复习印记区域">
    {entryHost ? createPortal(entry, entryHost) : entry}
    {open && pageState !== "exiting" && (viewportOverlayHost ? createPortal(tools, viewportOverlayHost) : tools)}
    {!open && error && <p role="alert" className="review-mark-error">{error}</p>}
    {!open && busy && <span className="review-mark-hint" role="status">正在保存印记…</span>}
    {!open && visible.some(mark => mark.conflict || (mark.value && !resolvedIds.includes(mark.markId))) && ready && <button type="button" className="review-mark-warning" onClick={() => { onOpenChange(true); setFocus(true); }}>部分印记需要确认定位或并发修改</button>}
    <div className={open ? "review-mark-content selecting-objects" : "review-mark-content"} ref={content}
      onPointerDownCapture={event => { pointerStart.current = { x: event.clientX, y: event.clientY }; }}
      onClickCapture={event => {
        if (!open || !(event.target instanceof Element)) return;
        const element = event.target.closest<HTMLElement>(markObjectSelector);
        if (!element || !content.current?.contains(element)) return;
        if (pointerStart.current && Math.hypot(event.clientX - pointerStart.current.x, event.clientY - pointerStart.current.y) > 6) return;
        const selected = window.getSelection();
        if (selected && !selected.isCollapsed && selected.rangeCount && selected.getRangeAt(0).intersectsNode(element)) {
          if (element.matches("pre") || !element.contains(selected.anchorNode) || !element.contains(selected.focusNode)) return;
        }
        event.preventDefault(); event.stopPropagation(); chooseObject(element);
      }}>
      {children}
      <div className="review-mark-paint" aria-hidden="true">{paint.map((rect, index) => <span key={rect.markId + ":" + index} data-mark-id={rect.markId} data-kind={rect.kind} data-color={rect.color} data-active={rect.markId === activeId || undefined} style={{ left: rect.left, top: rect.top, width: rect.width, height: rect.height }} />)}</div>
    </div>
  </section>;
}
