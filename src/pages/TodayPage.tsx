import { ArrowRight, CalendarCheck, CalendarClock, ChevronDown, Plus, Search } from "lucide-react";
import { useState } from "react";

import type { Block, ContentTemplate, DayEntry, RecordBlock, RecordReviewLog, RecordReviewState, RecordReviewStats, Subject, SubjectConfig } from "../types";
import { daysUntil, formatChineseDate, todayISO } from "../lib/date";
import { SubjectPicker } from "../components/SubjectPicker";
import { RecordCard } from "../components/RecordCard";
import { CloudSyncButton } from "../components/CloudSyncButton";
import { fallbackSubjectName } from "../lib/subjects";
import { PageHeader } from "../components/ui";

import { deriveLearningStats } from "../lib/learningStats";

interface TodayPageProps {
  entry: DayEntry | null;
  blocks: Block[];
  examDate: string;
  subjects: SubjectConfig[];
  templates?: readonly ContentTemplate[];
  onSaveEntry: (entry: DayEntry) => void;
  onCreateRecord: (date: string, subject: Subject, contentHtml?: string) => Promise<RecordBlock>;
  onOpenFavorites: () => void;
  onOpenJournal?: () => void;
  onOpenSearch?: () => void;
  onOpenRecord: (record: RecordBlock) => void;
  onOpenReview?: () => void;
  onOpenDailyPlan?: () => void;
  onAskAi?: (date: string) => void;
  onToggleFavorite: (record: RecordBlock, favorite: boolean) => void;
  reviewStatesByRecord?: Record<string, RecordReviewState>;
  reviewLogsByRecord?: Record<string, RecordReviewLog[]>;
  dueReviewStates?: RecordReviewState[];
  reviewStats?: RecordReviewStats | null;
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
  onOpenJournal,
  onOpenSearch,
  onOpenRecord,
  onOpenReview = () => undefined,
  onOpenDailyPlan = () => undefined,
  onAskAi,
  onToggleFavorite,
  reviewStatesByRecord = {},
  reviewLogsByRecord = {},
  dueReviewStates = [],
  reviewStats,
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
  const learningSummary = deriveLearningStats(reviewStats, today);

  return (
    <main className="page today-page primary-workspace-page content-first-home">
      <PageHeader title="今天" subtitle={formatChineseDate(today)} density="workspace"
        actions={<>
          {onOpenSearch && <button type="button" className="workspace-icon-button" aria-label="全局搜索" title="全局搜索" onClick={onOpenSearch}><Search size={18} /></button>}
          <CloudSyncButton showLabel onSignedOut={onOpenCloudSyncSettings} onRestored={onCloudSyncRestored} />
        </>}
      />
      <div className="today-content">
      <div className="today-home-actions">
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

      <div className="today-home-links">
        <button type="button" className="secondary-button" onClick={onOpenDailyPlan} aria-label="打开今日计划">今日计划</button>
        <button type="button" className="subtle-button" onClick={onOpenFavorites} aria-label="打开收藏夹">收藏夹</button>
      </div>
      </div>
      <div className="today-content-grid">
      <div className="today-journal-column">
      {entry && (
        <details className="entry-meta-panel">
          <summary>编辑今日日志标题</summary>
          <input
            value={entry.title}
            onChange={(event) => onSaveEntry({ ...entry, title: event.target.value })}
            aria-label="今日日志标题"
          />
        </details>
      )}

      <section className="today-recent-records">
        <div className="today-section-heading"><h2>今天的记录</h2><small>{records.length} 条</small>{onOpenJournal && <button type="button" className="subtle-button" onClick={onOpenJournal}>日志资料库<ArrowRight size={14} /></button>}</div>
        <div className="record-list">
        {records.length === 0 ? (
          <div className="empty-state">
            <h2>今天还很干净。</h2>
          </div>
        ) : (
          records.map((record) => (
            <RecordCard
              key={record.id}
              menuActions
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
      </div>
      <aside className="today-study-aside" aria-label="学习概览">
      <section className="today-review-summary">
        <h2><CalendarCheck size={16} />今日复习</h2>
        <p className="today-review-count"><strong>{dueReviewStates.length}</strong><span>条待复习</span></p>
      {dueReviewStates.length > 0 && (
        <section className="review-due-banner">
          <div>
            <span>
              <span>今日到期 {todayDue.length} 条</span>
              {overdue.length > 0 && <small>另有 {overdue.length} 条已过期</small>}
            </span>
          </div>
          {previewDue.length > 0 && <p>{previewDue.join("、")}</p>}
          <button type="button" className="secondary-button" onClick={onOpenReview}>
            开始复习<ArrowRight size={15} />
          </button>
        </section>
      )}

      {(reviewStats || dueReviewStates.length > 0) && (
        <section className="today-status-line" aria-label="今日状态">
          <span className="today-status-label">今日状态</span>
          <span>
            {learningSummary.progress !== null
              ? `已复习 ${learningSummary.reviewedToday} / ${learningSummary.dueAtFirstOpen} 条`
              : learningSummary.overdueCount > 0
                ? `有 ${learningSummary.overdueCount} 条逾期待处理`
                : learningSummary.dueTodayCount > 0
                  ? `还有 ${learningSummary.dueTodayCount} 条待复习`
                  : "今天没有待复习"}
          </span>
          {learningSummary.overdueCount > 0 && <small>逾期 {learningSummary.overdueCount} 条</small>}
        </section>
      )}

      </section>
      <section className="today-goal-summary">
        <h2><CalendarClock size={16} />目标日期</h2>
        <time dateTime={examDate}>{formatChineseDate(examDate)}</time>
        <small>{countdown >= 0 ? `还有 ${countdown} 天` : "目标日期已过"}</small>
      </section>
      </aside>
      </div>
      </div>
    </main>
  );
};
