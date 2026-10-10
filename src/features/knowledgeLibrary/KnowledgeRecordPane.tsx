import { useEffect, useRef, useState, type CSSProperties } from "react";
import { ArrowLeft, ExternalLink } from "lucide-react";
import type { RecordBlock, SubjectConfig } from "../../types";
import { RichTextEditor } from "../../components/RichTextEditor";
import { RecordTagChips } from "../../components/RecordTagChips";
import { normalizeRecordContent } from "../../lib/recordContent";

interface Props {
  record?: RecordBlock;
  records: readonly RecordBlock[];
  subjects: readonly SubjectConfig[];
  width?: number;
  scrollTop: number;
  onWidthChange: (width: number) => void;
  onScrollPosition: (position: number) => void;
  onClose: () => void;
  onOpenFull: (record: RecordBlock) => void;
  onOpenRecord: (record: RecordBlock) => void;
}

export function KnowledgeRecordPane({ record, records, subjects, width: savedWidth, scrollTop, onWidthChange, onScrollPosition, onClose, onOpenFull, onOpenRecord }: Props) {
  const body = useRef<HTMLDivElement>(null);
  const pane = useRef<HTMLElement>(null);
  const [defaultWidth, setDefaultWidth] = useState(420);
  const width = savedWidth ?? defaultWidth;
  useEffect(() => {
    const workspace = pane.current?.parentElement;
    if (!workspace || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => setDefaultWidth(workspace.clientWidth >= 1080 ? 480 : 420));
    observer.observe(workspace);
    return () => observer.disconnect();
  }, []);
  const resize = useRef<{ pointerId: number; start: number; width: number }>();
  const changeWidth = (next: number) => onWidthChange(Math.min(560, Math.max(360, next)));
  useEffect(() => { if (body.current) body.current.scrollTop = scrollTop; }, [record?.id]);
  return <aside ref={pane} className="knowledge-record-pane" aria-label="日志浏览" style={{ "--knowledge-record-width": width + "px" } as CSSProperties}>
    <div className="knowledge-pane-resize" role="separator" aria-label="调整日志浏览宽度" aria-orientation="vertical" aria-valuemin={360} aria-valuemax={560} aria-valuenow={width} tabIndex={0}
      onKeyDown={event => { if (event.key === "ArrowLeft" || event.key === "ArrowRight") { event.preventDefault(); changeWidth(width + (event.key === "ArrowLeft" ? 20 : -20)); } if (event.key === "Home" || event.key === "End") { event.preventDefault(); changeWidth(event.key === "Home" ? 360 : 560); } }}
      onPointerDown={event => { if (event.button !== 0) return; event.preventDefault(); resize.current = { pointerId: event.pointerId, start: event.clientX, width }; event.currentTarget.setPointerCapture(event.pointerId); }}
      onPointerMove={event => { if (resize.current?.pointerId === event.pointerId) changeWidth(resize.current.width + resize.current.start - event.clientX); }}
      onPointerUp={() => { resize.current = undefined; }} onPointerCancel={() => { resize.current = undefined; }} onLostPointerCapture={() => { resize.current = undefined; }} />
    <div className="knowledge-panel-heading">
      <button type="button" className="knowledge-icon" aria-label="返回节点说明" onClick={onClose}><ArrowLeft size={18} /></button>
      <strong>日志浏览</strong>
      <button type="button" className="knowledge-record-open-full" disabled={!record} onClick={() => record && onOpenFull(record)}><ExternalLink size={15} />打开完整日志</button>
    </div>
    <div className="knowledge-record-pane-body" ref={body} onScroll={event => onScrollPosition(event.currentTarget.scrollTop)}>
      {!record ? <p role="status">原日志暂不可用，可能已删除或尚未同步。可返回节点说明。</p> : <article>
        <header className="knowledge-record-pane-header">
          <p>{record.date}</p>
          <h2>{record.title || "未命名日志"}</h2>
          <span>{record.subject}</span>
          <RecordTagChips subject={record.subject} tags={record.tags} />
        </header>
        <RichTextEditor key={record.id}
          value={normalizeRecordContent(record)} onChange={() => undefined} placeholder="" readOnly
          currentRecordId={record.id} referenceRecords={records.filter(item => !item.deletedAt)} referenceSubjects={subjects}
          onOpenRecordReference={recordId => { const target = records.find(item => item.id === recordId && !item.deletedAt); if (target) onOpenRecord(target); }} />
      </article>}
    </div>
  </aside>;
}
