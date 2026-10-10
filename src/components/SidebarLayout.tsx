import { createContext, useContext, useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { Pin } from "lucide-react";
import { effectiveSidebarWidth, readSidebarPreference, sidebarWidthLimit, writeSidebarPreference, SIDEBAR_BREAKPOINT, SIDEBAR_DEFAULT_WIDTH, SIDEBAR_MIN_WIDTH, type SidebarPreference } from "../lib/sidebarLayout";
import type { RecordBlock } from "../types";

const SidebarContext = createContext({ collapsed: false, navigationKey: "" });

export function SidebarLayout({ children, className, legacyCollapsed, navigationKey }: { children: ReactNode; className: string; legacyCollapsed?: boolean; navigationKey: string }) {
  const [preference, setPreference] = useState<SidebarPreference>(() => readSidebarPreference() ?? { collapsed: legacyCollapsed === true, width: SIDEBAR_DEFAULT_WIDTH });
  const [savedOnMount] = useState(() => readSidebarPreference() !== undefined);
  const migrated = useRef(savedOnMount);
  const [viewport, setViewport] = useState(() => window.innerWidth);
  const [availableWidth, setAvailableWidth] = useState(() => document.documentElement.getBoundingClientRect().width || window.innerWidth);
  const [draftWidth, setDraftWidth] = useState<number>();
  const [dragging, setDragging] = useState(false);
  const separator = useRef<HTMLDivElement>(null);
  const drag = useRef<{ pointerId: number; startX: number; startWidth: number; width: number }>();
  const frame = useRef<number>();
  const maximum = sidebarWidthLimit(availableWidth);
  const width = effectiveSidebarWidth({ ...preference, width: draftWidth ?? preference.width }, viewport, availableWidth);

  const save = (next: SidebarPreference) => {
    migrated.current = true;
    setPreference(next);
    writeSidebarPreference(next);
  };
  const endDrag = (commit: boolean) => {
    const current = drag.current;
    drag.current = undefined;
    if (frame.current !== undefined) cancelAnimationFrame(frame.current);
    frame.current = undefined;
    setDraftWidth(undefined);
    setDragging(false);
    if (current && separator.current?.hasPointerCapture(current.pointerId)) separator.current.releasePointerCapture(current.pointerId);
    if (commit && current && current.width !== current.startWidth) save({ ...preference, width: current.width });
  };

  useEffect(() => {
    if (!migrated.current && legacyCollapsed === true) {
      migrated.current = true;
      const next = { ...preference, collapsed: legacyCollapsed === true };
      setPreference(next);
      writeSidebarPreference(next);
    }
  }, [legacyCollapsed]);

  useLayoutEffect(() => {
    const update = () => {
      setViewport(window.innerWidth);
      setAvailableWidth(document.documentElement.getBoundingClientRect().width || window.innerWidth);
    };
    window.addEventListener("resize", update);
    const observer = typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(update);
    observer?.observe(document.documentElement);
    update();
    return () => { window.removeEventListener("resize", update); observer?.disconnect(); };
  }, []);

  useEffect(() => { endDrag(false); }, [viewport, availableWidth, navigationKey]);
  useEffect(() => {
    if (!dragging) return;
    const cancel = (event: KeyboardEvent) => { if (event.key === "Escape") { event.preventDefault(); endDrag(false); } };
    const blur = () => endDrag(false);
    window.addEventListener("keydown", cancel);
    window.addEventListener("blur", blur);
    return () => { window.removeEventListener("keydown", cancel); window.removeEventListener("blur", blur); };
  }, [dragging]);
  useEffect(() => () => { if (frame.current !== undefined) cancelAnimationFrame(frame.current); }, []);

  return <SidebarContext.Provider value={{ collapsed: preference.collapsed, navigationKey }}>
    <div className={className + (preference.collapsed ? " sidebar-rail" : "") + (dragging ? " sidebar-resizing" : "")} style={{ "--sidebar-width": width + "px" } as CSSProperties}>
      {children}
      <button type="button" className="sidebar-edge" aria-label={preference.collapsed ? "展开左侧导航" : "收起左侧导航"} title={preference.collapsed ? "展开左侧导航" : "收起左侧导航"} aria-expanded={!preference.collapsed} onClick={() => { endDrag(false); save({ ...preference, collapsed: !preference.collapsed }); }} />
      {!preference.collapsed && viewport > SIDEBAR_BREAKPOINT && <div ref={separator} className="sidebar-resize" role="separator" aria-label="调整导航栏宽度" aria-orientation="vertical" aria-valuemin={SIDEBAR_MIN_WIDTH} aria-valuemax={maximum} aria-valuenow={width} aria-valuetext={width + " 像素"} tabIndex={0}
        onDoubleClick={() => { endDrag(false); save({ ...preference, width: SIDEBAR_DEFAULT_WIDTH }); }}
        onKeyDown={event => {
          const next = event.key === "Home" ? SIDEBAR_MIN_WIDTH : event.key === "End" ? maximum : event.key === "ArrowLeft" ? width - 16 : event.key === "ArrowRight" ? width + 16 : undefined;
          if (next === undefined) return;
          event.preventDefault();
          save({ ...preference, width: Math.max(SIDEBAR_MIN_WIDTH, Math.min(maximum, next)) });
        }}
        onPointerDown={event => {
          if (event.button !== 0) return;
          event.preventDefault();
          event.currentTarget.focus();
          drag.current = { pointerId: event.pointerId, startX: event.clientX, startWidth: width, width };
          event.currentTarget.setPointerCapture(event.pointerId);
          setDragging(true);
        }}
        onPointerMove={event => {
          const current = drag.current;
          if (!current || current.pointerId !== event.pointerId) return;
          current.width = Math.round(Math.max(SIDEBAR_MIN_WIDTH, Math.min(maximum, current.startWidth + event.clientX - current.startX)));
          if (frame.current !== undefined) return;
          frame.current = requestAnimationFrame(() => { frame.current = undefined; if (drag.current) setDraftWidth(drag.current.width); });
        }}
        onPointerUp={() => endDrag(true)} onPointerCancel={() => endDrag(false)} onLostPointerCapture={() => { if (drag.current) endDrag(false); }} />}
    </div>
  </SidebarContext.Provider>;
}

export function SidebarPins({ records, onOpen }: { records: RecordBlock[]; onOpen: (record: RecordBlock) => void }) {
  const { collapsed, navigationKey } = useContext(SidebarContext);
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const container = useRef<HTMLElement>(null);
  const [top, setTop] = useState(0);
  const close = (restore: boolean) => { setOpen(false); if (restore) trigger.current?.focus(); };
  useEffect(() => { setOpen(false); }, [collapsed, navigationKey]);
  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => { if (!container.current?.contains(event.target as Node)) close(false); };
    const keyboard = (event: KeyboardEvent) => { if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); close(true); } };
    const resize = () => close(true);
    document.addEventListener("pointerdown", outside);
    document.addEventListener("keydown", keyboard, true);
    window.addEventListener("resize", resize);
    return () => { document.removeEventListener("pointerdown", outside); document.removeEventListener("keydown", keyboard, true); window.removeEventListener("resize", resize); };
  }, [open]);
  const list = <>{records.length === 0 ? <small>收藏的日志会出现在这里。</small> : records.slice(0, 5).map(record => <button key={record.id} type="button" className="pinned-record-link" title={record.title || "未命名日志"} aria-label={"打开置顶日志 " + (record.title || "未命名日志")} onClick={() => { close(false); onOpen(record); }}><span>{record.title || "未命名日志"}</span></button>)}</>;
  return <section ref={container} className="pinned-panel" onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget as Node)) setOpen(false); }}>
    {collapsed ? <>
      <button ref={trigger} type="button" className="sidebar-pins-trigger" aria-label="置顶日志" title="置顶日志" aria-expanded={open} aria-controls="sidebar-pinned-list" onClick={() => { setTop(Math.max(48, Math.min(trigger.current?.getBoundingClientRect().top ?? 120, window.innerHeight - 320))); setOpen(value => !value); }}><Pin size={19} /><span className="sidebar-label">置顶日志</span></button>
      {open && <div id="sidebar-pinned-list" className="sidebar-pins-popover" role="region" aria-label="置顶日志列表" style={{ top }}><strong>置顶日志</strong>{list}</div>}
    </> : <><p className="eyebrow">置顶日志</p>{list}</>}
  </section>;
}
