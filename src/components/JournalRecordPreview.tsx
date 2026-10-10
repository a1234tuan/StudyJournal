import { useEffect, useRef } from "react";
import { ArrowLeft, ExternalLink, X } from "lucide-react";
import type { RecordBlock, SubjectConfig } from "../types";
import { RichTextEditor } from "./RichTextEditor";
import { RecordTagChips } from "./RecordTagChips";
import { normalizeRecordContent } from "../lib/recordContent";

interface Props {
  record?: RecordBlock;
  recordId: string;
  records: readonly RecordBlock[];
  subjects: readonly SubjectConfig[];
  scrollTop: number;
  onScroll: (recordId: string, scrollTop: number) => void;
  onClose: () => void;
  onOpenFull: (record: RecordBlock) => void;
}

export function JournalRecordPreview({ record, recordId, records, subjects, scrollTop, onScroll, onClose, onOpenFull }: Props) {
  const body = useRef<HTMLDivElement>(null);
  const close = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (body.current) body.current.scrollTop = scrollTop;
    close.current?.focus({ preventScroll: true });
  }, [recordId]);
  return <section className="journal-record-preview" aria-label="日志预览">
    <div className="journal-preview-toolbar">
      <span className="journal-preview-context">{record?.subject ?? "日志预览"}</span>
      <button type="button" className="workspace-icon-button journal-preview-full" title="打开完整日志" aria-label="打开完整日志" disabled={!record} onClick={() => record && onOpenFull(record)}><ExternalLink size={17} /></button>
      <button ref={close} type="button" className="workspace-icon-button journal-preview-close" title="返回列表" aria-label="返回列表" onClick={onClose}><X size={18} /><span className="journal-preview-return-label"><ArrowLeft size={16} />返回列表</span></button>
    </div>
    <div className="journal-preview-body" ref={body} onScroll={event => onScroll(recordId, event.currentTarget.scrollTop)}>
      {!record ? <p role="status">原日志暂不可用，可能已删除或尚未同步。可返回列表。</p> : <article>
        <header className="journal-preview-heading">
          <p>{record.date} · {record.subject}</p>
          <h2>{record.title || "未命名日志"}</h2>
          <RecordTagChips subject={record.subject} tags={record.tags} />
        </header>
        <RichTextEditor key={record.id} value={normalizeRecordContent(record)} onChange={() => undefined} placeholder="" readOnly currentRecordId={record.id} referenceRecords={records.filter(item => !item.deletedAt)} referenceSubjects={subjects} onOpenRecordReference={targetId => { const target = records.find(item => item.id === targetId && !item.deletedAt); if (target) onOpenFull(target); }} />
      </article>}
    </div>
  </section>;
}
