import { CheckCircle2, ChevronLeft, Circle, CircleDot, Layers, Plus, Trash2 } from "lucide-react";
import { useCallback, useMemo, useState } from "react";

import type {
  Asset,
  Block,
  DailyPlan,
  EntityId,
  ISODate,
  RecordBlock,
  RecordDraft,
  RecordReviewState,
  Subject,
  SubjectConfig,
} from "../types";
import { PageHeader } from "../components/ui";
import { SubjectPicker } from "../components/SubjectPicker";
import { formatChineseDate, formatChineseMonthDay, todayISO } from "../lib/date";
import {
  buildDailyPlanViews,
  groupPlansByDate,
  type DailyPlanView,
  type PlanContext,
} from "../lib/dailyPlan";
import { derivePlanStats } from "../lib/planStats";
import type { PlanView } from "../lib/tabNavigation";
import { formatUiError } from "../lib/uiError";

/**
 * The daily-plan workspace: create today's plans, fulfil them by writing the log
 * they stand for, and review the history.
 *
 * Two deliberate boundaries keep this page honest:
 *
 * 1. It is a **view**. Every derived value (outcome, tallies, streaks) comes from
 *    the pure functions in `lib/dailyPlan` / `lib/planStats`; nothing here writes
 *    a status anywhere, because there is no status column.
 * 2. It only reads the data the caller hands it (`dailyPlans` / `blocks` /
 *    `deletedRecords` / `subjects` / `assets` / `recordDrafts`), so it cannot
 *    grow a second source of truth. See the plan's D7 and §8.1.
 */

/** How many history day groups render before the rest collapse behind a button. */
const HISTORY_PAGE_SIZE = 30;

interface DailyPlanPageProps {
  /** Live plans only - the caller passes `listDailyPlans()` output. */
  plans: DailyPlan[];
  /** Live blocks of every type; records among them are the fulfilment evidence. */
  blocks: Block[];
  /**
   * Soft-deleted records. Needed so "linked to a log that was deleted" is
   * distinguishable from "never linked" - that difference is the whole of D8.
   */
  deletedRecords?: readonly RecordBlock[];
  recordDrafts?: readonly RecordDraft[];
  subjects: SubjectConfig[];
  assets?: readonly Asset[];
  reviewStates?: readonly RecordReviewState[];
  /**
   * Records whose draft flush has not landed yet. The editor commits navigation
   * synchronously and persists the draft asynchronously, so without this a
   * just-written log would flash "未完成" before flipping to "已完成".
   */
  inFlightDraftRecordIds?: ReadonlySet<EntityId>;
  today?: ISODate;
  defaultSubject?: Subject;
  view: PlanView;
  onViewChange: (view: PlanView) => void;
  onBack: () => void;
  onCreatePlan: (input: { date: ISODate; subject: Subject; title: string }) => Promise<DailyPlan | undefined>;
  onDeletePlan: (plan: DailyPlan) => Promise<void>;
  /** Opens the plan's log, creating it on first fulfilment. Reuse-first, see §5.4. */
  onOpenPlan: (plan: DailyPlan) => Promise<RecordBlock | undefined>;
  onOpenRecord: (record: RecordBlock) => void;
  onAddSubject?: (name: string) => Promise<void>;
}

interface PlanRowProps {
  view: DailyPlanView;
  entering?: boolean;
  opening?: boolean;
  onEntered?: () => void;
  onOpen: (plan: DailyPlan) => void;
  onDelete: (plan: DailyPlan) => void;
}

const PlanRow = ({ view, entering = false, opening = false, onEntered, onOpen, onDelete }: PlanRowProps) => {
  const { plan, outcome, record, linkedRecordDeleted } = view;
  const statusClassName = outcome === "done" ? "done" : outcome === "draft" ? "draft" : "pending";
  const statusIcon = outcome === "done"
    ? <CheckCircle2 size={18} aria-hidden="true" />
    : outcome === "draft"
      ? <CircleDot size={18} aria-hidden="true" />
      : <Circle size={18} aria-hidden="true" />;
  const statusLabel = outcome === "done"
    ? "已完成"
    : outcome === "draft"
      ? "未保存（上次输入已保留）"
      : "未完成";
  const divergedTitle = record && record.title !== plan.title ? record.title : undefined;
  /**
   * The row is a composite button, so the layout spans carry no readable
   * order of their own. Naming it explicitly keeps subject, title, state and
   * both hints in the announced label without coupling them to the visuals.
   */
  const openLabel = [
    `${plan.subject} ${plan.title}`,
    statusLabel,
    linkedRecordDeleted ? "日志已删除" : undefined,
    divergedTitle ? `来自日志「${divergedTitle}」` : undefined,
  ].filter(Boolean).join("，");

  return (
    <li
      className={`daily-plan-row${entering ? " entering" : ""}`}
      onAnimationEnd={entering ? onEntered : undefined}
    >
      <button
        type="button"
        className="daily-plan-row-main"
        onClick={() => onOpen(plan)}
        disabled={opening}
        aria-label={openLabel}
        title={outcome === "done" ? "打开这条计划对应的日志" : "写一条日志来兑现这条计划"}
      >
        <span className="daily-plan-row-heading">
          <span className="daily-plan-row-subject">{plan.subject}</span>
          <span className="daily-plan-row-title">{plan.title}</span>
        </span>
        <span className="daily-plan-row-status">
          <span className={`daily-plan-status daily-plan-status-${statusClassName}`}>
            {statusIcon}
            {statusLabel}
          </span>
          {linkedRecordDeleted && <span className="daily-plan-status-hint">日志已删除</span>}
          {divergedTitle && <span className="daily-plan-status-note">· 来自日志「{divergedTitle}」</span>}
        </span>
      </button>
      <button
        type="button"
        className="daily-plan-row-delete"
        onClick={() => onDelete(plan)}
        aria-label={`删除计划 ${plan.title}`}
        title="删除这条计划"
      >
        <Trash2 size={16} aria-hidden="true" />
      </button>
    </li>
  );
};

export const DailyPlanPage = ({
  plans,
  blocks,
  deletedRecords = [],
  recordDrafts = [],
  subjects,
  assets = [],
  reviewStates = [],
  inFlightDraftRecordIds,
  today,
  defaultSubject,
  view,
  onViewChange,
  onBack,
  onCreatePlan,
  onDeletePlan,
  onOpenPlan,
  onOpenRecord,
  onAddSubject,
}: DailyPlanPageProps) => {
  const todayDate = today ?? todayISO();
  const activeSubjects = useMemo(
    () => subjects.filter((subject) => !subject.archivedAt).sort((a, b) => a.order - b.order),
    [subjects],
  );
  const [subject, setSubject] = useState<Subject>(() => defaultSubject ?? activeSubjects[0]?.name ?? "");
  const [draftTitle, setDraftTitle] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [justAddedPlanId, setJustAddedPlanId] = useState<EntityId | undefined>(undefined);
  const [openingPlanIds, setOpeningPlanIds] = useState<ReadonlySet<EntityId>>(() => new Set());
  const [message, setMessage] = useState("");
  const [expandedHistory, setExpandedHistory] = useState(false);

  const ctx: PlanContext = useMemo(() => {
    // Live rows first, then deleted ones, so a live record always wins a tie -
    // the same precedence the reclaim job uses when it picks its survivor.
    const recordsById = new Map<EntityId, RecordBlock>();
    for (const block of deletedRecords) {
      if (block.type === "record") {
        recordsById.set(block.id, block);
      }
    }
    for (const block of blocks) {
      if (block.type === "record") {
        recordsById.set(block.id, block);
      }
    }
    return {
      recordsById,
      draftRecordIds: new Set(recordDrafts.map((draft) => draft.recordId)),
      inFlightDraftRecordIds: new Set(inFlightDraftRecordIds ?? []),
      reviewStatuses: new Map(reviewStates.map((state) => [state.recordId, state.status])),
      assets: [...assets],
    };
  }, [assets, blocks, deletedRecords, inFlightDraftRecordIds, recordDrafts, reviewStates]);

  const groups = useMemo(
    () => groupPlansByDate(buildDailyPlanViews(plans, ctx)),
    [ctx, plans],
  );
  const stats = useMemo(() => derivePlanStats(groups, todayDate), [groups, todayDate]);
  const todayGroup = useMemo(() => groups.find((group) => group.date === todayDate), [groups, todayDate]);
  const visibleGroups = expandedHistory ? groups : groups.slice(0, HISTORY_PAGE_SIZE);
  const remainingGroups = groups.length - visibleGroups.length;

  const submit = useCallback(async () => {
    const title = draftTitle.trim();
    if (!title || !subject || submitting) {
      return;
    }
    setSubmitting(true);
    setMessage("");
    try {
      const created = await onCreatePlan({ date: todayDate, subject, title });
      setDraftTitle("");
      setJustAddedPlanId(created?.id);
    } catch (error) {
      setMessage(formatUiError(error, "generic"));
    } finally {
      setSubmitting(false);
    }
  }, [draftTitle, onCreatePlan, subject, submitting, todayDate]);

  /**
   * In-page debounce, mandated by §5.4: navigation only starts once the record
   * write resolves, and the list stays clickable for that whole round trip.
   */
  const openPlan = useCallback(async (plan: DailyPlan) => {
    if (openingPlanIds.has(plan.id)) {
      return;
    }
    setOpeningPlanIds((current) => new Set(current).add(plan.id));
    setMessage("");
    try {
      const record = await onOpenPlan(plan);
      if (record) {
        onOpenRecord(record);
      }
    } catch (error) {
      setMessage(formatUiError(error, "generic"));
    } finally {
      setOpeningPlanIds((current) => {
        const next = new Set(current);
        next.delete(plan.id);
        return next;
      });
    }
  }, [onOpenPlan, onOpenRecord, openingPlanIds]);

  const removePlan = useCallback(async (plan: DailyPlan) => {
    if (!window.confirm("删除这条计划？已经写好的日志会保留，日志上的「来自计划」标识也会保留。")) {
      return;
    }
    setMessage("");
    try {
      await onDeletePlan(plan);
    } catch (error) {
      setMessage(formatUiError(error, "generic"));
    }
  }, [onDeletePlan]);

  const todaySummary = !todayGroup
    ? "列一条计划，做完顺手记下来。"
    : todayGroup.doneCount > 0
      ? `今天已经兑现 ${todayGroup.doneCount} 条计划。`
      : `还有 ${todayGroup.totalCount} 条计划没写日志。`;

  const summaryCard = (label: string, summary: { done: number; total: number; hasData: boolean }) => (
    <article className="stats-state-card">
      <div className="stats-card-heading"><span>{label}</span></div>
      <strong>{summary.hasData ? `${summary.done} / ${summary.total}` : "—"}</strong>
      <small>{summary.hasData ? `共 ${summary.total} 条计划` : "这几天没有计划"}</small>
    </article>
  );

  return (
    <main className="page daily-plan-page primary-workspace-page">
      <PageHeader
        eyebrow={view === "today" ? formatChineseDate(todayDate) : `累计 ${groups.length} 天有计划`}
        title={view === "today" ? "今日计划" : "计划历史"}
        density="compact"
        actions={view === "today" && todayGroup ? (
          <span className="counter-pill" title="今天的计划完成度">
            {todayGroup.doneCount} / {todayGroup.totalCount} 完成
          </span>
        ) : undefined}
      />

      {/*
        The view toggle used to sit in the header's `titleActions` slot, which is
        not where this app puts view switchers: the journal and review tabs both
        live in the content area. It shares a row with the back control instead,
        the same "back on the left, local controls on the right" bar the record
        editor uses, so the page title stays a title and the toggle reads as a
        control for the view below it.
      */}
      <div className="daily-plan-topbar">
        <button type="button" className="daily-plan-back" onClick={onBack} aria-label="返回今天">
          <ChevronLeft size={17} aria-hidden="true" />
          今天
        </button>
        <div className="daily-plan-view-toggle" role="tablist" aria-label="计划视图">
          <button
            type="button"
            role="tab"
            aria-selected={view === "today"}
            className={view === "today" ? "active" : ""}
            onClick={() => onViewChange("today")}
          >
            今日
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={view === "history"}
            className={view === "history" ? "active" : ""}
            onClick={() => onViewChange("history")}
          >
            历史
          </button>
        </div>
      </div>

      {message && <p className="daily-plan-message" role="status">{message}</p>}

      {view === "today" ? (
        <>
          <section className="daily-plan-compose" aria-label="新建计划">
            <div className="daily-plan-compose-subject">
              <SubjectPicker
                value={subject || undefined}
                subjects={subjects}
                onChange={setSubject}
                onAddSubject={onAddSubject}
                disabled={submitting}
              />
            </div>
            <div className="daily-plan-compose-row">
              <input
                value={draftTitle}
                onChange={(event) => setDraftTitle(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    event.preventDefault();
                    void submit();
                  }
                }}
                maxLength={40}
                placeholder="例如：三大计算 660 题第 50 到 60 题"
                aria-label="计划标题"
                disabled={submitting}
              />
              <button
                type="button"
                className="primary-button"
                onClick={() => void submit()}
                disabled={!draftTitle.trim() || !subject || submitting}
              >
                <Plus size={16} aria-hidden="true" />
                添加计划
              </button>
            </div>
            <p className="daily-plan-compose-hint">较长的计划可以拆成多条</p>
          </section>

          {todayGroup && todayGroup.totalCount > 0 && (
            <p className="daily-plan-today-summary">{todaySummary}</p>
          )}

          {!todayGroup || todayGroup.totalCount === 0 ? (
            <div className="empty-state daily-plan-empty">
              <Layers size={26} aria-hidden="true" />
              <h2>今天还没有计划。列一条，做完就能顺手记下来。</h2>
            </div>
          ) : (
            <ul className="daily-plan-list" aria-label="今天的计划">
              {todayGroup.views.map((planView) => (
                <PlanRow
                  key={planView.plan.id}
                  view={planView}
                  entering={planView.plan.id === justAddedPlanId}
                  opening={openingPlanIds.has(planView.plan.id)}
                  onEntered={() => setJustAddedPlanId(undefined)}
                  onOpen={(plan) => void openPlan(plan)}
                  onDelete={(plan) => void removePlan(plan)}
                />
              ))}
            </ul>
          )}
        </>
      ) : groups.length === 0 ? (
        <div className="empty-state daily-plan-empty">
          <Layers size={26} aria-hidden="true" />
          <h2>还没有计划历史。从今天开始列计划，这里会留下记录。</h2>
        </div>
      ) : (
        <>
          <section className="daily-plan-stats" aria-label="计划汇总">
            <h2 className="daily-plan-section-title">周期汇总</h2>
            <div className="stats-state-grid">
              {summaryCard("近 7 天已兑现", stats.last7)}
              {summaryCard("近 30 天已兑现", stats.last30)}
              <article className="stats-state-card">
                <div className="stats-card-heading"><span>连续完成</span><CheckCircle2 size={17} aria-hidden="true" /></div>
                <strong>{stats.streakDays} 天</strong>
                <small>仅计有计划的日子</small>
              </article>
            </div>
          </section>

          <section className="daily-plan-stats" aria-label="学科分布">
            <h2 className="daily-plan-section-title">学科分布</h2>
            {stats.subjects.length === 0 ? (
              <p className="daily-plan-muted">还没有学科数据。</p>
            ) : (
              <ul className="daily-plan-subjects">
                {stats.subjects.map((item) => (
                  <li key={item.subject}>
                    <span className="daily-plan-subject-name">{item.subject}</span>
                    <span className="daily-plan-subject-bar">
                      <span style={{ width: `${item.total > 0 ? Math.round((item.done / item.total) * 100) : 0}%` }} />
                    </span>
                    <span className="daily-plan-subject-count">{item.done} / {item.total}</span>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section className="daily-plan-history" aria-label="计划历史">
            <h2 className="daily-plan-section-title">按日期</h2>
            {visibleGroups.map((group) => (
              <div key={group.date} className="daily-plan-history-group">
                <div className="daily-plan-history-heading">
                  <time dateTime={group.date}>{formatChineseMonthDay(group.date)}</time>
                  <small>{group.doneCount}/{group.totalCount}</small>
                </div>
                <ul className="daily-plan-list">
                  {group.views.map((planView) => (
                    <PlanRow
                      key={planView.plan.id}
                      view={planView}
                      opening={openingPlanIds.has(planView.plan.id)}
                      onOpen={(plan) => void openPlan(plan)}
                      onDelete={(plan) => void removePlan(plan)}
                    />
                  ))}
                </ul>
              </div>
            ))}
            {remainingGroups > 0 && (
              <button
                type="button"
                className="link-button daily-plan-expand"
                onClick={() => setExpandedHistory(true)}
              >
                展开全部（还有 {remainingGroups} 天）
              </button>
            )}
          </section>
        </>
      )}
    </main>
  );
};
