import { useEffect, useMemo, useRef, useState } from "react";
import { CalendarDays, CheckSquare, Download, List, Search, Square, X } from "lucide-react";

import type { Block, RecordBlock, RecordReviewLog, RecordReviewState, Subject, SubjectConfig } from "../types";
import { MonthlyHeatmap } from "../components/MonthlyHeatmap";
import { DayLogCard } from "../components/DayLogCard";
import { RecordCard } from "../components/RecordCard";
import { getRecordBlocks, getRecordDatesForMonth, getRecordsForDateSubject } from "../lib/journalSelectors";
import { PageHeader } from "../components/ui";

interface JournalPageProps {
  blocks: Block[];
  subjects: SubjectConfig[];
  month: Date;
  selectedDate?: string;
  selectedSubject?: Subject;
  browseMode?: "library" | "calendar";
  subjectFilter?: Subject | "全部";
  visibleRecordCount?: number;
  restoreListScrollY?: number;
  onMonthChange: (month: Date) => void;
  onSelectedDateChange: (date: string | undefined) => void;
  onSelectedSubjectChange: (subject: Subject | undefined) => void;
  onBrowseModeChange?: (mode: "library" | "calendar") => void;
  onSubjectFilterChange?: (subject: Subject | "全部") => void;
  onVisibleRecordCountChange?: (count: number) => void;
  onOpenRecord: (record: RecordBlock) => void;
  onOpenSearch: () => void;
  onAskAi: (date: string) => void;
  onToggleFavorite: (record: RecordBlock, favorite: boolean) => void;
  reviewStatesByRecord?: Record<string, RecordReviewState>;
  reviewLogsByRecord?: Record<string, RecordReviewLog[]>;
  onAddToReview?: (recordId: string) => void;
  onAddManyToReview?: (recordIds: string[]) => Promise<string> | string;
  onExportRecords?: (recordIds: string[]) => Promise<string> | string;
}

export const JOURNAL_PAGE_SIZE = 20;

export const JournalPage = ({
  blocks,
  subjects,
  month,
  selectedDate,
  selectedSubject,
  browseMode = "library",
  subjectFilter = "全部",
  visibleRecordCount = JOURNAL_PAGE_SIZE,
  restoreListScrollY,
  onMonthChange,
  onSelectedDateChange,
  onSelectedSubjectChange,
  onBrowseModeChange = () => undefined,
  onSubjectFilterChange = () => undefined,
  onVisibleRecordCountChange = () => undefined,
  onOpenRecord,
  onOpenSearch,
  onAskAi,
  onToggleFavorite,
  reviewStatesByRecord = {},
  reviewLogsByRecord = {},
  onAddToReview = () => undefined,
  onAddManyToReview = () => "",
  onExportRecords = () => "",
}: JournalPageProps) => {
  const [selecting, setSelecting] = useState(false);
  const [selectedRecordIds, setSelectedRecordIds] = useState<string[]>([]);
  const [batchMessage, setBatchMessage] = useState("");
  const restoredListScrollRef = useRef<number | undefined>(undefined);
  const records = useMemo(() => getRecordBlocks(blocks), [blocks]);
  const dates = useMemo(() => getRecordDatesForMonth(records, month), [month, records]);
  const visibleRecords = useMemo(() => records
    .filter((record) => subjectFilter === "全部" || record.subject === subjectFilter)
    .sort((left, right) => right.date.localeCompare(left.date) || right.updatedAt.localeCompare(left.updatedAt)), [records, subjectFilter]);
  const renderedRecords = visibleRecords.slice(0, Math.max(JOURNAL_PAGE_SIZE, visibleRecordCount));
  const remainingRecordCount = visibleRecords.length - renderedRecords.length;

  useEffect(() => {
    if (
      restoreListScrollY === undefined
      || restoredListScrollRef.current === restoreListScrollY
      || selectedDate
      || selectedSubject
    ) return;
    const frame = window.requestAnimationFrame(() => {
      window.scrollTo({ top: restoreListScrollY });
      restoredListScrollRef.current = restoreListScrollY;
    });
    return () => window.cancelAnimationFrame(frame);
  }, [restoreListScrollY, renderedRecords.length, selectedDate, selectedSubject]);

  const subjectRecords = selectedDate && selectedSubject
    ? getRecordsForDateSubject(records, selectedDate, selectedSubject)
    : [];

  const toggleSelected = (recordId: string) => {
    setSelectedRecordIds((current) =>
      current.includes(recordId) ? current.filter((id) => id !== recordId) : [...current, recordId],
    );
  };

  const addSelected = async () => {
    const message = await onAddManyToReview(selectedRecordIds);
    setBatchMessage(message);
    setSelectedRecordIds([]);
    setSelecting(false);
  };

  const exportSelected = async () => {
    const message = await onExportRecords(selectedRecordIds);
    setBatchMessage(message);
    setSelectedRecordIds([]);
    setSelecting(false);
  };

  return (
    <main className="page journal-page primary-workspace-page">
      <PageHeader
        eyebrow="学习记录"
        title="日志资料库"
        subtitle="浏览、分类和回看所有学习日志。"
        density="compact"
        actions={(
          <button type="button" className="secondary-button journal-search-button" onClick={onOpenSearch} title="全局搜索" aria-label="全局搜索">
            <Search size={18} />
            <span>全局搜索</span>
          </button>
        )}
      />

      {selectedDate && selectedSubject ? (
        <section className="record-list-panel page-section-transition">
          <div className="record-list-panel-header">
            <button type="button" className="subtle-button" onClick={() => onSelectedSubjectChange(undefined)}>
              返回学科列表
            </button>
            <button
              type="button"
              className="secondary-button"
              onClick={() => {
                setSelecting(!selecting);
                setSelectedRecordIds([]);
              }}
            >
              {selecting ? <X size={17} /> : <CheckSquare size={17} />}
              {selecting ? "取消" : "选择"}
            </button>
          </div>
          <h2>{selectedDate} / {selectedSubject}</h2>
          {batchMessage && <p className="status-message">{batchMessage}</p>}
          <div className="record-list">
            {subjectRecords.map((record) => (
              <div key={record.id} className={`selectable-record-row ${selectedRecordIds.includes(record.id) ? "selected" : ""}`}>
                {selecting && (
                  <button type="button" className="record-select-button" onClick={() => toggleSelected(record.id)} aria-label="选择记录">
                    {selectedRecordIds.includes(record.id) ? <CheckSquare size={18} /> : <Square size={18} />}
                  </button>
                )}
                <RecordCard
                  record={record}
                  onOpen={selecting ? () => toggleSelected(record.id) : onOpenRecord}
                  onAskAi={selecting ? undefined : onAskAi}
                  onToggleFavorite={selecting ? undefined : (favorite) => onToggleFavorite(record, favorite)}
                  reviewState={reviewStatesByRecord[record.id]}
                  reviewLogs={reviewLogsByRecord[record.id]}
                  onAddReview={selecting ? undefined : () => onAddToReview(record.id)}
                />
              </div>
            ))}
          </div>
          {selecting && (
            <div className="batch-review-bar">
              <span>已选 {selectedRecordIds.length} 条</span>
              <button type="button" className="primary-button" onClick={() => void addSelected()} disabled={selectedRecordIds.length === 0}>
                加入复习
              </button>
              <button type="button" className="secondary-button" onClick={() => void exportSelected()} disabled={selectedRecordIds.length === 0}>
                <Download size={17} />
                导出选中日志
              </button>
            </div>
          )}
        </section>
      ) : (
        <>
          <div className="journal-view-tabs" role="tablist" aria-label="日志浏览方式">
            <button type="button" role="tab" aria-selected={browseMode === "library"} className={browseMode === "library" ? "active" : ""} onClick={() => onBrowseModeChange("library")}><List size={17} />全部日志</button>
            <button type="button" role="tab" aria-selected={browseMode === "calendar"} className={browseMode === "calendar" ? "active" : ""} onClick={() => onBrowseModeChange("calendar")}><CalendarDays size={17} />按日期</button>
          </div>
          {browseMode === "library" ? (
            <>
              <div className="journal-subject-strip" role="tablist" aria-label="按学科筛选">
                {["全部", ...subjects.filter((item) => !item.archivedAt).map((item) => item.name)].map((item) => <button type="button" role="tab" aria-selected={subjectFilter === item} className={subjectFilter === item ? "active" : ""} key={item} onClick={() => onSubjectFilterChange(item as Subject | "全部")}>{item}</button>)}
              </div>
              <div className="journal-result-meta"><span>{visibleRecords.length} 条日志</span><span>最近更新</span></div>
              <section className="record-list journal-library-records">
                {visibleRecords.length === 0 ? <div className="empty-state"><h2>这个范围还没有日志</h2></div> : renderedRecords.map((record) => <RecordCard key={record.id} record={record} onOpen={onOpenRecord} onAskAi={onAskAi} onToggleFavorite={(favorite) => onToggleFavorite(record, favorite)} reviewState={reviewStatesByRecord[record.id]} reviewLogs={reviewLogsByRecord[record.id]} onAddReview={() => onAddToReview(record.id)} />)}
              </section>
              {remainingRecordCount > 0 && (
                <div className="journal-load-more">
                  <span>已显示 {renderedRecords.length} / {visibleRecords.length}</span>
                  <button type="button" className="secondary-button" onClick={() => onVisibleRecordCountChange(renderedRecords.length + JOURNAL_PAGE_SIZE)}>
                    再显示 {Math.min(JOURNAL_PAGE_SIZE, remainingRecordCount)} 条
                  </button>
                </div>
              )}
            </>
          ) : (
            <>
              <section className="journal-day-summary"><div><p className="eyebrow">按月浏览</p><h2>本月有记录日期</h2></div><p>仅显示当前月份中有日志记录的日期；切换月份可以回看更早的学习现场。</p></section>
              <section className="day-log-list">
                {dates.length === 0 ? <div className="empty-state"><h2>本月还没有日志记录。</h2></div> : dates.map((date) => <DayLogCard key={date} date={date} records={records.filter((record) => record.date === date)} subjects={subjects} onAskAi={onAskAi} open={selectedDate === date && !selectedSubject} onOpenChange={(open) => onSelectedDateChange(open ? date : undefined)} onOpenSubject={(nextDate, subject) => { onSelectedDateChange(nextDate); onSelectedSubjectChange(subject); }} />)}
              </section>
              <MonthlyHeatmap month={month} blocks={blocks} selectedDate={selectedDate} onMonthChange={onMonthChange} onSelectDate={(date) => { onSelectedDateChange(date); onSelectedSubjectChange(undefined); }} />
            </>
          )}
        </>
      )}
    </main>
  );
};
