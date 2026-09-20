import { useEffect, useMemo, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent } from "react";
import { ChevronLeft, ChevronRight, List, Plus, X } from "lucide-react";

import type { Subject, SubjectConfig } from "../types";
import { formatUiError } from "../lib/uiError";
import { MotionPresence } from "./MotionPresence";

interface SubjectRadialPickerProps {
  open: boolean;
  subjects: readonly SubjectConfig[];
  onClose: () => void;
  onSelect: (subject: Subject) => Promise<void>;
  onManageSubjects: () => void;
}

const SLOT_COUNT = 5;
const SLOT_RADIUS = 126;
const SLOT_ANGLE_DEGREES = 29;
const SWIPE_SLOT_PX = 54;

const clampIndex = (index: number, length: number) => Math.max(0, Math.min(Math.max(0, length - 1), index));

export const subjectOrbitIndexAfterDrag = (index: number, deltaX: number, length: number): number =>
  clampIndex(index - Math.round(deltaX / SWIPE_SLOT_PX), length);

const shortLabel = (name: string, distance: number) => {
  const characters = Array.from(name);
  const limit = distance >= 2 ? 1 : distance === 1 ? 4 : 6;
  return characters.length > limit ? `${characters.slice(0, limit).join("")}…` : name;
};

export const SubjectRadialPicker = ({ open, subjects, onClose, onSelect, onManageSubjects }: SubjectRadialPickerProps) => {
  const activeSubjects = useMemo(
    () => subjects.filter((subject) => !subject.archivedAt).sort((a, b) => a.order - b.order),
    [subjects],
  );
  const [focusedIndex, setFocusedIndex] = useState(0);
  const [dragX, setDragX] = useState(0);
  const [allOpen, setAllOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const dragStartRef = useRef<number | null>(null);
  const movedRef = useRef(false);

  useEffect(() => {
    if (!open) return;
    setFocusedIndex((current) => clampIndex(current, activeSubjects.length));
    setDragX(0);
    setAllOpen(false);
    setError("");
  }, [activeSubjects.length, open]);

  useEffect(() => {
    if (!open) return undefined;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
      } else if (!allOpen && event.key === "ArrowLeft") {
        event.preventDefault();
        setFocusedIndex((current) => clampIndex(current - 1, activeSubjects.length));
      } else if (!allOpen && event.key === "ArrowRight") {
        event.preventDefault();
        setFocusedIndex((current) => clampIndex(current + 1, activeSubjects.length));
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [activeSubjects.length, allOpen, onClose, open]);

  const choose = async (subject: Subject) => {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      await onSelect(subject);
    } catch (caught) {
      setError(formatUiError(caught, "generic"));
    } finally {
      setBusy(false);
    }
  };

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (busy || activeSubjects.length <= 1) return;
    dragStartRef.current = event.clientX;
    movedRef.current = false;
    event.currentTarget.setPointerCapture?.(event.pointerId);
  };

  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (dragStartRef.current === null) return;
    const nextDragX = Math.max(-108, Math.min(108, event.clientX - dragStartRef.current));
    if (Math.abs(nextDragX) > 6) movedRef.current = true;
    setDragX(nextDragX);
  };

  const finishDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (dragStartRef.current === null) return;
    const deltaX = event.clientX - dragStartRef.current;
    setFocusedIndex((current) => subjectOrbitIndexAfterDrag(current, deltaX, activeSubjects.length));
    dragStartRef.current = null;
    setDragX(0);
  };

  const visibleSubjects = activeSubjects
    .map((subject, index) => ({ subject, index, distance: index - focusedIndex }))
    .filter(({ distance }) => Math.abs(distance) <= Math.floor(SLOT_COUNT / 2));
  const focusedSubject = activeSubjects[focusedIndex];

  return (
    <MotionPresence present={open} variant="popover" className="subject-orbit-overlay" role="presentation">
      <button type="button" className="subject-orbit-backdrop" onClick={onClose} aria-label="关闭学科选择" />
      <section className={`subject-orbit-dialog${allOpen ? " show-all" : ""}`} role="dialog" aria-modal="true" aria-labelledby="subject-orbit-title">
        {activeSubjects.length === 0 ? (
          <div className="subject-orbit-empty">
            <h2 id="subject-orbit-title">暂无可用学科</h2>
            <p>请先添加或恢复一门学科，再创建学习日志。</p>
            <button type="button" className="primary-button" onClick={onManageSubjects}>前往学科分类</button>
          </div>
        ) : allOpen ? (
          <div className="subject-orbit-all">
            <header>
              <button type="button" className="icon-button" onClick={() => setAllOpen(false)} aria-label="返回弧形选择"><ChevronLeft size={19} /></button>
              <div><p className="eyebrow">全部学科</p><h2 id="subject-orbit-title">选择后创建日志</h2></div>
              <button type="button" className="icon-button" onClick={onClose} aria-label="关闭学科选择"><X size={19} /></button>
            </header>
            <div className="subject-orbit-all-list" role="list">
              {activeSubjects.map((subject) => (
                <button key={subject.id} type="button" onClick={() => void choose(subject.name)} disabled={busy} title={subject.name}>
                  <span aria-hidden="true">{Array.from(subject.name)[0]}</span><strong>{subject.name}</strong><Plus size={17} />
                </button>
              ))}
            </div>
          </div>
        ) : (
          <>
            <div className="subject-orbit-heading">
              <p className="eyebrow">新建学习日志</p>
              <h2 id="subject-orbit-title" title={focusedSubject?.name}>{focusedSubject?.name}</h2>
              <p>{activeSubjects.length > SLOT_COUNT ? `左右滑动查看 · ${focusedIndex + 1} / ${activeSubjects.length}` : "选择学科后才会创建"}</p>
            </div>
            <div
              className={`subject-orbit-track${dragStartRef.current === null ? " settled" : " dragging"}`}
              onPointerDown={onPointerDown}
              onPointerMove={onPointerMove}
              onPointerUp={finishDrag}
              onPointerCancel={finishDrag}
              role="group"
              aria-label="沿圆弧滑动选择学科"
            >
              <div className="subject-orbit-arc" aria-hidden="true" />
              {visibleSubjects.map(({ subject, index, distance }) => {
                const dragProgress = dragX / SWIPE_SLOT_PX;
                const visualDistance = distance + dragProgress;
                const angle = visualDistance * SLOT_ANGLE_DEGREES * Math.PI / 180;
                const x = Math.sin(angle) * SLOT_RADIUS;
                const y = Math.cos(angle) * 82;
                const absoluteDistance = Math.abs(visualDistance);
                const scale = Math.max(0.72, 1 - absoluteDistance * 0.13);
                const opacity = Math.max(0.48, 1 - absoluteDistance * 0.22);
                const style = {
                  "--orbit-x": `${x}px`,
                  "--orbit-y": `${y}px`,
                  "--orbit-scale": scale,
                  "--orbit-opacity": opacity,
                  "--orbit-delay": `${Math.abs(distance) * 24}ms`,
                } as CSSProperties;
                const focused = index === focusedIndex;
                return (
                  <button
                    key={subject.id}
                    type="button"
                    className={`subject-orbit-item${focused ? " focused" : ""}`}
                    style={style}
                    onClick={() => {
                      if (movedRef.current) { movedRef.current = false; return; }
                      if (!focused) setFocusedIndex(index);
                      else void choose(subject.name);
                    }}
                    disabled={busy}
                    aria-current={focused ? "true" : undefined}
                    aria-label={focused ? `创建${subject.name}日志` : `聚焦学科${subject.name}`}
                    title={subject.name}
                  >
                    <span>{shortLabel(subject.name, Math.abs(distance))}</span>
                    {focused && <Plus size={15} aria-hidden="true" />}
                  </button>
                );
              })}
            </div>
            <div className="subject-orbit-controls">
              <button type="button" className="icon-button" onClick={() => setFocusedIndex((current) => clampIndex(current - 1, activeSubjects.length))} disabled={busy || focusedIndex === 0} aria-label="上一个学科"><ChevronLeft size={18} /></button>
              <button type="button" className="subject-orbit-all-button" onClick={() => setAllOpen(true)} disabled={busy}><List size={16} />全部学科</button>
              <button type="button" className="icon-button" onClick={() => setFocusedIndex((current) => clampIndex(current + 1, activeSubjects.length))} disabled={busy || focusedIndex === activeSubjects.length - 1} aria-label="下一个学科"><ChevronRight size={18} /></button>
            </div>
            {error && <p className="subject-orbit-error" role="alert">{error}</p>}
          </>
        )}
        <button type="button" className="subject-orbit-close" onClick={onClose} aria-label="关闭新建菜单" title="关闭新建菜单"><Plus size={25} /></button>
      </section>
    </MotionPresence>
  );
};
