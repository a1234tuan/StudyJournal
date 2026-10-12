import { useEffect, useRef, useState } from "react";
import { BookOpen, CalendarDays, Check, ChevronDown, List, Search, Tag } from "lucide-react";
import type { SubjectConfig } from "../types";
import { selectedJournalTopic, type JournalScope, type JournalTopic } from "../lib/journalFilters";

interface Props {
  scope: JournalScope;
  tags: Array<{ key: string; label: string }>;
  topics: readonly JournalTopic[];
  loading: boolean;
  error: string;
  onRetry: () => void;
  subjects: SubjectConfig[];
  subject: string;
  mobile: boolean;
  calendar: boolean;
  onScope: (scope: JournalScope) => void;
  onSubject: (subject: string) => void;
  onCalendar: () => void;
  onSearch: () => void;
}

export const JournalFilterBar = ({ scope, tags, topics, loading, error, onRetry, subjects, subject, mobile, calendar, onScope, onSubject, onCalendar, onSearch }: Props) => {
  const [panel, setPanel] = useState<"tag" | "topic">();
  const [query, setQuery] = useState("");
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement | null>(null);
  const search = useRef<HTMLInputElement>(null);
  const dismiss = (restoreFocus = false) => { setPanel(undefined); if (restoreFocus) trigger.current?.focus({ preventScroll: true }); };
  useEffect(() => {
    if (!panel) return;
    search.current?.focus({ preventScroll: true });
    const outside = (event: PointerEvent) => { if (!root.current?.contains(event.target as Node)) dismiss(); };
    const escape = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.isComposing || event.defaultPrevented) return;
      event.preventDefault(); event.stopPropagation(); dismiss(true);
    };
    document.addEventListener("pointerdown", outside);
    document.addEventListener("keydown", escape, true);
    return () => { document.removeEventListener("pointerdown", outside); document.removeEventListener("keydown", escape, true); };
  }, [panel]);
  const topic = selectedJournalTopic(topics, scope);
  const tagLabel = scope.kind === "tag" ? tags.find(tag => tag.key === scope.tag)?.label ?? scope.tag : "";
  const needle = query.trim().toLocaleLowerCase();
  const matchingTags = tags.filter(tag => tag.label.toLocaleLowerCase().includes(needle));
  const matchingTopics = topics.filter(topic => (topic.title + " " + topic.libraryTitle).toLocaleLowerCase().includes(needle));
  const choose = (next: JournalScope) => { onScope(next); dismiss(true); };
  const toggle = (next: "tag" | "topic", button: HTMLButtonElement) => { trigger.current = button; setQuery(""); setPanel(panel === next ? undefined : next); };
  return <div className="journal-toolbar">
    <div ref={root} className="journal-scope-control" onBlur={event => { if (event.relatedTarget && !event.currentTarget.contains(event.relatedTarget as Node)) dismiss(); }}>
      <div className="journal-view-tabs" role="tablist" aria-label="日志筛选范围">
        <button type="button" role="tab" aria-selected={!calendar && scope.kind === "all"} className={!calendar && scope.kind === "all" ? "active" : ""} onClick={() => choose({ kind: "all" })}><List size={16} />全部日志</button>
        {mobile && <button type="button" role="tab" aria-selected={calendar} className={calendar ? "active" : ""} onClick={() => { dismiss(); onCalendar(); }}><CalendarDays size={16} />按日期</button>}
      </div>
      <button type="button" className={"journal-scope-button" + (!calendar && scope.kind === "tag" ? " active" : "")} aria-label={tagLabel ? "标签：" + tagLabel : "按标签"} aria-expanded={panel === "tag"} aria-haspopup="dialog" title={tagLabel || "按标签筛选"} onClick={event => toggle("tag", event.currentTarget)}><Tag size={16} /><span>{mobile ? "标签" : tagLabel ? "标签：" + tagLabel : "按标签"}</span><ChevronDown size={14} /></button>
      <button type="button" className={"journal-scope-button" + (!calendar && scope.kind === "topic" ? " active" : "")} aria-label={scope.kind === "topic" ? "专题：" + (topic?.title ?? (loading ? "读取中" : "不可用")) : "按专题"} aria-expanded={panel === "topic"} aria-haspopup="dialog" title={topic?.title || "按专题筛选"} onClick={event => toggle("topic", event.currentTarget)}><BookOpen size={16} /><span>{mobile ? "专题" : scope.kind === "topic" ? "专题：" + (topic?.title ?? (loading ? "读取中" : "不可用")) : "按专题"}</span><ChevronDown size={14} /></button>
      {panel && <section className="journal-filter-popover" role="dialog" aria-label={panel === "tag" ? "选择标签" : "选择专题"}>
        <header><strong>{panel === "tag" ? "按标签筛选" : "按专题筛选"}</strong><button type="button" className="subtle-button" onClick={() => choose({ kind: "all" })}>清除范围</button></header>
        <input ref={search} type="search" aria-label={panel === "tag" ? "搜索标签" : "搜索专题"} placeholder={panel === "tag" ? "搜索标签" : "搜索专题或知识库"} value={query} onChange={event => setQuery(event.target.value)} />
        <div className={"journal-filter-options " + (panel === "tag" ? "journal-tag-options" : "journal-topic-options")}>
          {panel === "tag" ? matchingTags.length ? matchingTags.map(tag => <button type="button" key={tag.key} aria-pressed={scope.kind === "tag" && scope.tag === tag.key} onClick={() => choose({ kind: "tag", tag: tag.key })}>{tag.label}</button>) : <p role="status">{tags.length ? "没有匹配的标签" : "日志中还没有标签"}</p>
            : loading ? <p role="status">正在读取专题…</p> : error ? <div role="status"><p>{error}</p><button type="button" onClick={onRetry}>重试</button></div> : matchingTopics.length ? matchingTopics.map(item => <button type="button" key={item.libraryId + ":" + item.workspaceId} aria-pressed={topic === item} onClick={() => choose({ kind: "topic", owner: item.owner, libraryId: item.libraryId, workspaceId: item.workspaceId })}><span><strong>{item.title}</strong><small>{item.libraryTitle}</small></span>{topic === item && <Check size={16} />}</button>) : <p role="status">{topics.length ? "没有匹配的专题" : "当前身份还没有可用专题"}</p>}
        </div>
        <footer>{panel === "tag" ? "跨学科标签 · 中文按拼音排序" : "普通知识库中的可见专题"}</footer>
      </section>}
    </div>
    {!calendar && <label className="journal-subject-filter"><span>学科</span><select aria-label="按学科筛选" value={subject} onChange={event => onSubject(event.target.value)}>{Array.from(new Set(["全部", subject, ...subjects.filter(item => !item.archivedAt).map(item => item.name)])).map(item => <option key={item} value={item}>{item}</option>)}</select></label>}
    <div className="journal-tool-actions"><button type="button" className="secondary-button journal-search-button" onClick={onSearch} aria-label="全局搜索"><Search size={16} /><span>全局搜索</span></button></div>
  </div>;
};
