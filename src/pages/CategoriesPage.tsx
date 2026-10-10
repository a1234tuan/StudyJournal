import { Archive, ArrowDown, ArrowUp, Bot, Check, Edit3, Plus, RotateCcw, SlidersHorizontal, Trash2, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import type { AiKnowledgeScope, Block, RecordBlock, RecordReviewLog, RecordReviewState, Subject, SubjectConfig } from "../types";
import { formatChineseDate, nowISO } from "../lib/date";
import {
  getRecordBlocks,
  getRecordsBySubject,
  getSubjectCounts,
} from "../lib/journalSelectors";
import { normalizeRecordTags, recordTagKey } from "../lib/recordTags";
import { formatUiError } from "../lib/uiError";
import { PageHeader, WorkspaceBackButton } from "../components/ui";
import { RecordCard } from "../components/RecordCard";
import { RecordTagChips } from "../components/RecordTagChips";

const MONTH_RECORD_STEP = 50;

interface CategoriesPageProps {
  blocks: Block[];
  subjects: SubjectConfig[];
  activeSubject: Subject | null;
  managing: boolean;
  onActiveSubjectChange: (subject: Subject | null) => void;
  onManagingChange: (managing: boolean) => void;
  onOpenRecord: (record: RecordBlock) => void;
  onAskAi?: (date: string) => void;
  onAskAiScope?: (scope: AiKnowledgeScope) => void;
  onAddSubject: (name: string) => Promise<void>;
  onRenameSubject: (oldName: Subject, newName: Subject) => Promise<void>;
  onSaveSubjects: (subjects: SubjectConfig[]) => Promise<void>;
  onToggleFavorite: (record: RecordBlock, favorite: boolean) => void;
  reviewStatesByRecord?: Record<string, RecordReviewState>;
  reviewLogsByRecord?: Record<string, RecordReviewLog[]>;
  onAddToReview?: (recordId: string) => void;
}

type MonthRecordGroup = {
  month: string;
  records: RecordBlock[];
};

type TagRecordGroup = {
  key: string;
  tag: string;
  records: RecordBlock[];
};

type DateRecordGroup = {
  date: string;
  records: RecordBlock[];
};

const groupRecordsByDate = (records: RecordBlock[]): DateRecordGroup[] => {
  const groups = new Map<string, RecordBlock[]>();
  for (const record of records) {
    groups.set(record.date, [...(groups.get(record.date) ?? []), record]);
  }
  return Array.from(groups, ([date, dateRecords]) => ({ date, records: dateRecords }))
    .sort((a, b) => b.date.localeCompare(a.date));
};

const monthKey = (date: string) => date.slice(0, 7);

const monthLabel = (month: string) => {
  const [year, monthNumber] = month.split("-");
  return `${year}年${monthNumber}月`;
};

const groupRecordsByMonth = (records: RecordBlock[]): MonthRecordGroup[] => {
  const groups = new Map<string, RecordBlock[]>();
  for (const record of records) {
    const key = monthKey(record.date);
    groups.set(key, [...(groups.get(key) ?? []), record]);
  }
  return Array.from(groups, ([month, monthRecords]) => ({ month, records: monthRecords }))
    .sort((a, b) => b.month.localeCompare(a.month));
};

const groupRecordsByTag = (records: RecordBlock[]): TagRecordGroup[] => {
  const groups = new Map<string, TagRecordGroup>();
  for (const record of records) {
    for (const tag of normalizeRecordTags(record.tags)) {
      const key = recordTagKey(tag);
      const group = groups.get(key);
      if (group) {
        group.records.push(record);
      } else {
        groups.set(key, { key, tag, records: [record] });
      }
    }
  }
  return Array.from(groups.values())
    .map((group) => ({
      ...group,
      records: [...group.records].sort((left, right) =>
        right.date.localeCompare(left.date) || right.updatedAt.localeCompare(left.updatedAt),
      ),
    }))
    .sort((left, right) => left.tag.localeCompare(right.tag, "zh-CN"));
};

export const CategoriesPage = ({
  blocks,
  subjects,
  activeSubject,
  managing,
  onActiveSubjectChange,
  onManagingChange,
  onOpenRecord,
  onAskAi,
  onAskAiScope,
  onAddSubject,
  onRenameSubject,
  onSaveSubjects,
  onToggleFavorite,
  reviewStatesByRecord = {},
  reviewLogsByRecord = {},
  onAddToReview = () => undefined,
}: CategoriesPageProps) => {
  const [newSubject, setNewSubject] = useState("");
  const [editingSubject, setEditingSubject] = useState<Subject | null>(null);
  const [editingName, setEditingName] = useState("");
  const [message, setMessage] = useState("");
  const [pendingDeleteSubjectId, setPendingDeleteSubjectId] = useState<string | null>(null);
  const [subjectRowMessage, setSubjectRowMessage] = useState<{ subjectId: string; message: string } | null>(null);
  const records = useMemo(() => getRecordBlocks(blocks), [blocks]);
  const subjectCounts = useMemo(() => getSubjectCounts(records, subjects), [records, subjects]);
  const activeRecords = useMemo(
    () => (activeSubject ? getRecordsBySubject(records, activeSubject) : []),
    [activeSubject, records],
  );
  const monthGroups = useMemo(() => groupRecordsByMonth(activeRecords), [activeRecords]);
  const tagGroups = useMemo(() => groupRecordsByTag(activeRecords), [activeRecords]);
  const [recordGrouping, setRecordGrouping] = useState<"month" | "tag">("month");
  const [expandedMonths, setExpandedMonths] = useState<Set<string>>(() => new Set());
  const [monthVisibleCounts, setMonthVisibleCounts] = useState<Record<string, number>>({});
  const [expandedTags, setExpandedTags] = useState<Set<string>>(() => new Set());
  const [tagVisibleCounts, setTagVisibleCounts] = useState<Record<string, number>>({});

  useEffect(() => {
    setExpandedMonths(monthGroups[0] ? new Set([monthGroups[0].month]) : new Set());
    setMonthVisibleCounts({});
  }, [activeSubject, monthGroups]);

  useEffect(() => {
    setExpandedTags(tagGroups[0] ? new Set([tagGroups[0].key]) : new Set());
    setTagVisibleCounts({});
  }, [activeSubject, tagGroups]);

  const addSubject = async () => {
    const name = newSubject.trim();
    if (!name) {
      return;
    }
    try {
      await onAddSubject(name);
      setNewSubject("");
      setPendingDeleteSubjectId(null);
      setSubjectRowMessage(null);
      setMessage("");
    } catch (error) {
      setMessage(formatUiError(error, "generic"));
    }
  };

  const rename = async (oldName: Subject) => {
    const name = editingName.trim();
    if (!name || name === oldName) {
      setEditingSubject(null);
      return;
    }
    try {
      await onRenameSubject(oldName, name);
      if (activeSubject === oldName) {
        onActiveSubjectChange(name);
      }
      setEditingSubject(null);
      setPendingDeleteSubjectId(null);
      setSubjectRowMessage(null);
      setMessage("");
    } catch (error) {
      setMessage(formatUiError(error, "generic"));
    }
  };

  const updateSubjects = async (nextSubjects: SubjectConfig[]) => {
    // Re-indexing/archiving/deleting one subject shouldn't bump updatedAt on every other untouched
    // subject — cloud sync hashes the whole settings payload, so an unnecessary bump here makes the
    // entire settings entity look "changed" on the next sync even though only one item actually is.
    await onSaveSubjects(nextSubjects.map((subject, index) => {
      const existing = subjects.find((item) => item.id === subject.id);
      const unchanged = existing
        && existing.order === index
        && existing.name === subject.name
        && existing.archivedAt === subject.archivedAt;
      return unchanged ? existing : { ...subject, order: index, updatedAt: nowISO() };
    }));
  };

  const moveSubject = async (index: number, direction: -1 | 1) => {
    const nextIndex = index + direction;
    if (nextIndex < 0 || nextIndex >= subjects.length) {
      return;
    }
    const next = [...subjects];
    const [item] = next.splice(index, 1);
    next.splice(nextIndex, 0, item);
    setPendingDeleteSubjectId(null);
    setSubjectRowMessage(null);
    await updateSubjects(next);
  };

  const toggleArchive = async (subject: SubjectConfig) => {
    setPendingDeleteSubjectId(null);
    setSubjectRowMessage(null);
    await updateSubjects(
      subjects.map((item) =>
        item.id === subject.id
          ? { ...item, archivedAt: item.archivedAt ? undefined : nowISO(), updatedAt: nowISO() }
          : item,
      ),
    );
  };

  const deleteSubject = async (subject: SubjectConfig) => {
    const count = subjectCounts.find((item) => item.subject === subject.name)?.count ?? 0;
    if (count > 0) {
      setPendingDeleteSubjectId(null);
      setSubjectRowMessage({
        subjectId: subject.id,
        message: "该学科已有学习记录，不能直接删除。可以先归档、改名，或把记录迁移到其他学科。",
      });
      setMessage("");
      return;
    }
    if (pendingDeleteSubjectId !== subject.id) {
      setPendingDeleteSubjectId(subject.id);
      setSubjectRowMessage({
        subjectId: subject.id,
        message: `确认删除“${subject.name}”？这只会删除学科配置，不会删除记录。`,
      });
      setMessage("");
      return;
    }
    await updateSubjects(subjects.filter((item) => item.id !== subject.id));
    if (activeSubject === subject.name) {
      onActiveSubjectChange(null);
    }
    if (editingSubject === subject.name) {
      setEditingSubject(null);
    }
    setPendingDeleteSubjectId(null);
    setSubjectRowMessage(null);
    setMessage("");
  };

  const cancelDeleteSubject = () => {
    setPendingDeleteSubjectId(null);
    setSubjectRowMessage(null);
  };

  const categoryList = subjectCounts.filter((item) => !item.config?.archivedAt || item.count > 0);

  const toggleMonth = (month: string) => {
    setExpandedMonths((current) => {
      const next = new Set(current);
      if (next.has(month)) {
        next.delete(month);
      } else {
        next.add(month);
      }
      return next;
    });
  };

  const showMoreMonthRecords = (month: string) => {
    setMonthVisibleCounts((current) => ({
      ...current,
      [month]: (current[month] ?? MONTH_RECORD_STEP) + MONTH_RECORD_STEP,
    }));
  };

  const toggleTag = (tag: string) => {
    setExpandedTags((current) => {
      const next = new Set(current);
      if (next.has(tag)) {
        next.delete(tag);
      } else {
        next.add(tag);
      }
      return next;
    });
  };

  const showMoreTagRecords = (tag: string) => {
    setTagVisibleCounts((current) => ({
      ...current,
      [tag]: (current[tag] ?? MONTH_RECORD_STEP) + MONTH_RECORD_STEP,
    }));
  };

  return (
    <main className="page categories-page primary-workspace-page">
      <PageHeader density="workspace" title={managing ? "学科管理" : activeSubject ?? "学科分类"}
        back={activeSubject ? <WorkspaceBackButton onClick={() => onActiveSubjectChange(null)}>返回分类</WorkspaceBackButton> : undefined}
        actions={!activeSubject && <button type="button" className="secondary-button" onClick={() => onManagingChange(!managing)}>{managing ? <X size={18} /> : <SlidersHorizontal size={18} />}{managing ? "完成" : "管理学科"}</button>}
      />
      <div className="workspace-content">

      {managing && !activeSubject ? (
        <section className="subject-manager">
          <div className="subject-add-row">
            <input
              value={newSubject}
              onChange={(event) => setNewSubject(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  void addSubject();
                }
              }}
              placeholder="新增学科，例如：物理、法考、读书"
              aria-label="新增学科"
            />
            <button type="button" className="primary-button" onClick={() => void addSubject()} disabled={!newSubject.trim()}>
              <Plus size={17} />
              添加
            </button>
          </div>
          <div className="subject-manager-list">
            {subjects.map((subject, index) => (
              <article key={subject.id} className="subject-manager-row">
                {editingSubject === subject.name ? (
                  <input
                    value={editingName}
                    onChange={(event) => setEditingName(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") {
                        event.preventDefault();
                        void rename(subject.name);
                      }
                    }}
                    aria-label="编辑学科名称"
                  />
                ) : (
                  <div>
                    <strong>{subject.name}</strong>
                    {subject.archivedAt && <small>已归档，不会出现在新建记录选择器中</small>}
                  </div>
                )}
                <div className="subject-manager-actions">
                  <button type="button" className="icon-button" onClick={() => void moveSubject(index, -1)} disabled={index === 0}>
                    <ArrowUp size={16} />
                  </button>
                  <button type="button" className="icon-button" onClick={() => void moveSubject(index, 1)} disabled={index === subjects.length - 1}>
                    <ArrowDown size={16} />
                  </button>
                  {editingSubject === subject.name ? (
                    <button type="button" className="icon-button" onClick={() => void rename(subject.name)}>
                      <Check size={16} />
                    </button>
                  ) : (
                    <button
                      type="button"
                      className="icon-button"
                      onClick={() => {
                        setPendingDeleteSubjectId(null);
                        setSubjectRowMessage(null);
                        setEditingSubject(subject.name);
                        setEditingName(subject.name);
                      }}
                    >
                      <Edit3 size={16} />
                    </button>
                  )}
                  <button type="button" className="icon-button" onClick={() => void toggleArchive(subject)}>
                    {subject.archivedAt ? <RotateCcw size={16} /> : <Archive size={16} />}
                  </button>
                  <button
                    type="button"
                    className={`icon-button danger${pendingDeleteSubjectId === subject.id ? " active" : ""}`}
                    onClick={() => void deleteSubject(subject)}
                    aria-label={`删除学科 ${subject.name}`}
                    title={pendingDeleteSubjectId === subject.id ? "确认删除学科" : "删除学科"}
                  >
                    <Trash2 size={16} />
                  </button>
                </div>
                {subjectRowMessage?.subjectId === subject.id && (
                  <div className="subject-manager-row-message" role="status">
                    <span>{subjectRowMessage.message}</span>
                    {pendingDeleteSubjectId === subject.id && (
                      <span className="subject-delete-confirm-actions">
                        <button type="button" className="danger" onClick={() => void deleteSubject(subject)}>
                          确认删除
                        </button>
                        <button type="button" onClick={cancelDeleteSubject}>
                          取消
                        </button>
                      </span>
                    )}
                  </div>
                )}
              </article>
            ))}
          </div>
          {message && <p className="status-message">{message}</p>}
        </section>
      ) : !activeSubject ? (
        <section className="category-grid page-section-transition">
          {categoryList.map(({ subject, count }) => (
            <button
              key={subject}
              type="button"
              className="category-card"
              onClick={() => onActiveSubjectChange(subject)}
            >
              <span>{subject}</span>
              <b>{count}</b>
            </button>
          ))}
        </section>
      ) : (
        <section className="record-list-panel page-section-transition">
          {activeRecords.length === 0 ? (
            <div className="empty-state">
              <h2>这个学科还没有记录。</h2>
              <p>从今天页新建一个记录块后，它会出现在这里。</p>
            </div>
          ) : (
            <>
              <div className="record-grouping-control" role="tablist" aria-label="记录分组方式">
                <button
                  type="button"
                  role="tab"
                  aria-selected={recordGrouping === "month"}
                  className={recordGrouping === "month" ? "active" : ""}
                  onClick={() => setRecordGrouping("month")}
                >
                  按月份
                </button>
                <button
                  type="button"
                  role="tab"
                  aria-selected={recordGrouping === "tag"}
                  className={recordGrouping === "tag" ? "active" : ""}
                  onClick={() => setRecordGrouping("tag")}
                >
                  按标签
                </button>
              </div>
              {recordGrouping === "month" ? (
            <div className="subject-record-timeline">
              {monthGroups.map((group) => {
                const expanded = expandedMonths.has(group.month);
                const visibleCount = monthVisibleCounts[group.month] ?? MONTH_RECORD_STEP;
                const visibleRecords = group.records.slice(0, visibleCount);
                const hiddenCount = group.records.length - visibleRecords.length;
                return (
                  <section key={group.month} className="subject-month-group">
                    <button
                      type="button"
                      className="subject-month-toggle"
                      onClick={() => toggleMonth(group.month)}
                      aria-expanded={expanded}
                    >
                      <span>{monthLabel(group.month)}</span>
                      <small>{group.records.length} 条</small>
                    </button>
                    {expanded && (
                      <div className="subject-month-records">
                        {groupRecordsByDate(visibleRecords).map(({ date, records: dateRecords }) => (
                          <div key={date} className="subject-date-group">
                            <small className="subject-date-label">{formatChineseDate(date)}</small>
                            {dateRecords.map((record) => (
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
                            ))}
                          </div>
                        ))}
                        {hiddenCount > 0 && (
                          <button
                            type="button"
                            className="secondary-button subject-month-more"
                            onClick={() => showMoreMonthRecords(group.month)}
                          >
                            显示更多（剩余 {hiddenCount} 条）
                          </button>
                        )}
                      </div>
                    )}
                  </section>
                );
              })}
            </div>
              ) : tagGroups.length === 0 ? (
                <div className="empty-state subject-tag-empty-state">
                  <h2>这个学科还没有标签。</h2>
                  <p>请在日志编辑页的标题下添加标签后，再按标签查看记录。</p>
                </div>
              ) : (
                <div className="subject-record-timeline">
                  {tagGroups.map((group) => {
                    const expanded = expandedTags.has(group.key);
                    const visibleCount = tagVisibleCounts[group.key] ?? MONTH_RECORD_STEP;
                    const visibleRecords = group.records.slice(0, visibleCount);
                    const hiddenCount = group.records.length - visibleRecords.length;
                    return (
                      <section key={group.key} className="subject-tag-group">
                        <div className="subject-tag-toggle">
                          <button
                            type="button"
                            className="subject-tag-toggle-main"
                            onClick={() => toggleTag(group.key)}
                            aria-expanded={expanded}
                          >
                            <RecordTagChips subject={activeSubject} tags={[group.tag]} className="subject-tag-title" />
                            <small>{group.records.length} 条</small>
                          </button>
                          {onAskAiScope && (
                            <button
                              type="button"
                              className="icon-button"
                              onClick={() => onAskAiScope({ kind: "tag", subject: activeSubject, tag: group.tag })}
                              aria-label={`针对标签 ${group.tag} 进行 AI 问答`}
                              title="针对这个标签问 AI"
                            >
                              <Bot size={17} />
                            </button>
                          )}
                        </div>
                        {expanded && (
                          <div className="subject-tag-records">
                            {groupRecordsByDate(visibleRecords).map(({ date, records: dateRecords }) => (
                              <div key={date} className="subject-date-group">
                                <small className="subject-date-label">{formatChineseDate(date)}</small>
                                {dateRecords.map((record) => (
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
                                ))}
                              </div>
                            ))}
                            {hiddenCount > 0 && (
                              <button
                                type="button"
                                className="secondary-button subject-month-more"
                                onClick={() => showMoreTagRecords(group.key)}
                              >
                                显示更多（剩余 {hiddenCount} 条）
                              </button>
                            )}
                          </div>
                        )}
                      </section>
                    );
                  })}
                </div>
              )}
            </>
          )}
        </section>
      )}
      </div>
    </main>
  );
};
