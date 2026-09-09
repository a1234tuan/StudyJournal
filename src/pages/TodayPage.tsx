import { CalendarCheck, CalendarClock, ChevronDown, Plus, Star } from "lucide-react";
import { useState } from "react";

import type { Block, ContentTemplate, DayEntry, RecordBlock, RecordReviewLog, RecordReviewState, Subject, SubjectConfig } from "../types";
import { daysUntil, formatChineseDate, todayISO } from "../lib/date";
import { SubjectPicker } from "../components/SubjectPicker";
import { RecordCard } from "../components/RecordCard";
import { CloudSyncButton } from "../components/CloudSyncButton";
import { fallbackSubjectName } from "../lib/subjects";
import { PageHeader } from "../components/ui";
import { getDailyMotto } from "../lib/dailyMotto";

interface TodayPageProps {
  entry: DayEntry | null;
  blocks: Block[];
  examDate: string;
  subjects: SubjectConfig[];
  templates?: readonly ContentTemplate[];
  onSaveEntry: (entry: DayEntry) => void;
  onCreateRecord: (date: string, subject: Subject, contentHtml?: string) => Promise<RecordBlock>;
  onOpenFavorites: () => void;
  onOpenRecord: (record: RecordBlock) => void;
  onOpenReview?: () => void;
  onAskAi?: (date: string) => void;
  onToggleFavorite: (record: RecordBlock, favorite: boolean) => void;
  reviewStatesByRecord?: Record<string, RecordReviewState>;
  reviewLogsByRecord?: Record<string, RecordReviewLog[]>;
  dueReviewStates?: RecordReviewState[];
  reviewTitlesByRecord?: Record<string, string>;
  onAddToReview?: (recordId: string) => void;
  onOpenCloudSyncSettings?: () => void;
  onCloudSyncRestored?: () => Promise<void> | void;
}

export const TodayPage = ({
  entry,
  blocks,
  examDate,
  subjects,
  templates = [],
  onSaveEntry,
  onCreateRecord,
  onOpenFavorites,
  onOpenRecord,
  onOpenReview = () => undefined,
  onAskAi,
  onToggleFavorite,
  reviewStatesByRecord = {},
  reviewLogsByRecord = {},
  dueReviewStates = [],
  reviewTitlesByRecord = {},
  onAddToReview = () => undefined,
  onOpenCloudSyncSettings = () => undefined,
  onCloudSyncRestored = () => undefined,
}: TodayPageProps) => {
  const [subject, setSubject] = useState<Subject>(() =>
    subjects.find((item) => !item.archivedAt)?.name ??
    fallbackSubjectName({ id: "settings", examDate, theme: "system", accentColor: "", backupReminderDays: 7, fontScale: 1, lineHeight: 1.7, subjects }),
  );
  const [templateId, setTemplateId] = useState("");
  const countdown = daysUntil(examDate);
  const today = todayISO();
  const records = blocks.filter((block): block is RecordBlock => block.type === "record");
  const todayDue = dueReviewStates.filter((review) => review.nextReviewDate === today);
  const overdue = dueReviewStates.filter((review) => review.nextReviewDate && review.nextReviewDate < today);
  const previewDue = dueReviewStates.slice(0, 3).map((review) => reviewTitlesByRecord[review.recordId]).filter(Boolean);
  const selectedTemplate = templates.find((template) => template.id === templateId);

  return (
    <main className="page today-page primary-workspace-page">
      <PageHeader
        eyebrow={formatChineseDate(today)}
        title="今天想记下什么？"
        subtitle={getDailyMotto(today)}
        density="compact"
        actions={(
          <>
            <div className="today-goal-pill" title="距离目标" aria-label={`距离目标 ${countdown >= 0 ? `${countdown} 天` : "已结束"}`}>
              <CalendarClock size={16} />
              <span>距离目标</span>
              <strong>{countdown >= 0 ? `${countdown} 天` : "已结束"}</strong>
            </div>
            <CloudSyncButton onSignedOut={onOpenCloudSyncSettings} onRestored={onCloudSyncRestored} />
            <button type="button" className="icon-button" onClick={onOpenFavorites} title="收藏夹" aria-label="打开收藏夹">
              <Star size={18} />
            </button>
          </>
        )}
      />

      <section className="today-compose-band" aria-label="新建学习日志">
        <button
          type="button"
          className="today-compose-main"
          onClick={async () => onOpenRecord(await onCreateRecord(today, subject, selectedTemplate?.contentHtml))}
        >
          <Plus size={20} />
          <span><strong>新建 {subject} 记录</strong></span>
        </button>
        <details className="today-create-options">
          <summary aria-label="选择学科或模板" title="选择学科或模板"><ChevronDown size={19} /></summary>
          <div>
            <label><span>学科</span><SubjectPicker value={subject} subjects={subjects} onChange={setSubject} /></label>
            <label><span>模板</span><select className="new-record-template-select" aria-label="新记录模板" value={templateId} onChange={(event) => setTemplateId(event.target.value)}><option value="">无模板</option>{templates.map((template) => <option key={template.id} value={template.id}>{template.title}</option>)}</select></label>
          </div>
        </details>
      </section>

      {dueReviewStates.length > 0 && (
        <section className="review-due-banner">
          <div>
            <CalendarCheck size={22} />
            <span>
              <strong>今天有 {todayDue.length} 条待复习</strong>
              {overdue.length > 0 && <small>另有 {overdue.length} 条已过期</small>}
            </span>
          </div>
          {previewDue.length > 0 && <p>{previewDue.join("、")}</p>}
          <button type="button" className="primary-button" onClick={onOpenReview}>
            开始复习
          </button>
        </section>
      )}

      {entry && (
        <section className="entry-meta-panel">
          <input
            value={entry.title}
            onChange={(event) => onSaveEntry({ ...entry, title: event.target.value })}
            aria-label="今日日志标题"
          />
        </section>
      )}

      <section className="today-recent-records">
        <div className="today-section-heading"><h2>最近日志</h2><small>{records.length} 条</small></div>
        <div className="record-list">
        {records.length === 0 ? (
          <div className="empty-state">
            <h2>今天还很干净。</h2>
          </div>
        ) : (
          records.map((record) => (
            <RecordCard
              key={record.id}
              record={record}
              onOpen={onOpenRecord}
              onAskAi={onAskAi}
              onToggleFavorite={(favorite) => onToggleFavorite(record, favorite)}
              reviewState={reviewStatesByRecord[record.id]}
              reviewLogs={reviewLogsByRecord[record.id]}
              onAddReview={() => onAddToReview(record.id)}
            />
          ))
        )}
        </div>
      </section>
    </main>
  );
};
