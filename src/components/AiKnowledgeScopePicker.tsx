import { ArrowLeft, ChevronDown, RefreshCw, Search, Sparkles } from "lucide-react";
import type { ReactNode } from "react";
import { useEffect, useMemo, useRef, useState } from "react";

import { getSubjectRecordTags } from "../lib/recordTags";
import { isDesktopPlatform } from "../lib/platform";
import { searchRecordTitlesAsync } from "../lib/search";
import {
  aiKnowledgeScopeTitle,
  estimateAiTokens,
  getAiKnowledgeScopeRecords,
} from "../services/aiContextService";
import type { AiKnowledgeScope, Asset, Block, RecordBlock } from "../types";

const SCOPE_SEARCH_DEBOUNCE_MS = 300;
const RECORD_SEARCH_RESULT_LIMIT = 200;
const DEFAULT_MIN_SELECTED_SCOPE_RECORDS = 2;
const DEFAULT_MAX_SELECTED_SCOPE_RECORDS = 10;

interface ScopeAction {
  label: string;
  icon?: ReactNode;
  onClick: (scope: AiKnowledgeScope) => void | Promise<void>;
}

interface AiKnowledgeScopePickerProps {
  blocks: Block[];
  assets: Asset[];
  initialScope?: AiKnowledgeScope;
  includeDate?: boolean;
  eyebrow?: string;
  title: string;
  ariaLabel?: string;
  confirmLabel: string;
  confirmIcon?: ReactNode;
  secondaryAction?: ScopeAction;
  backLabel?: string;
  onBack: () => void;
  onCancel?: () => void;
  onScopeChange?: (scope: AiKnowledgeScope) => void;
  onConfirm: (scope: AiKnowledgeScope) => void | Promise<void>;
  minSelectedRecords?: number;
  maxSelectedRecords?: number;
}

const recordsOf = (blocks: Block[]): RecordBlock[] =>
  blocks.filter((block): block is RecordBlock => block.type === "record" && !block.deletedAt);

const initialKind = (scope: AiKnowledgeScope | undefined, includeDate: boolean): AiKnowledgeScope["kind"] => {
  if (scope?.kind === "date" && !includeDate) return "tag";
  return scope?.kind ?? "tag";
};

export const AiKnowledgeScopePicker = ({
  blocks,
  assets,
  initialScope,
  includeDate = false,
  eyebrow = "Knowledge Base",
  title,
  ariaLabel = title,
  confirmLabel,
  confirmIcon = <Sparkles size={18} />,
  secondaryAction,
  backLabel = "返回",
  onBack,
  onCancel = onBack,
  onScopeChange,
  onConfirm,
  minSelectedRecords = DEFAULT_MIN_SELECTED_SCOPE_RECORDS,
  maxSelectedRecords = DEFAULT_MAX_SELECTED_SCOPE_RECORDS,
}: AiKnowledgeScopePickerProps) => {
  const savedRecords = useMemo(() => recordsOf(blocks), [blocks]);
  const [scopeKind, setScopeKind] = useState<AiKnowledgeScope["kind"]>(() => initialKind(initialScope, includeDate));
  const [scopeSubject, setScopeSubject] = useState(initialScope?.kind === "tag" ? initialScope.subject : "");
  const [scopeTag, setScopeTag] = useState(initialScope?.kind === "tag" ? initialScope.tag : "");
  const [recentDays, setRecentDays] = useState<7 | 14 | 30>(initialScope?.kind === "recent" ? initialScope.days : 7);
  const [scopeDate, setScopeDate] = useState(initialScope?.kind === "date" ? initialScope.date : new Date().toISOString().slice(0, 10));
  const [selectedRecordIds, setSelectedRecordIds] = useState<string[]>(initialScope?.kind === "records" ? initialScope.recordIds : []);
  const [recordTitleQuery, setRecordTitleQuery] = useState("");
  const [recordSearchInput, setRecordSearchInput] = useState("");
  const [deferredRecordTitleQuery, setDeferredRecordTitleQuery] = useState("");
  const [rawRecordTitleResults, setRawRecordTitleResults] = useState<RecordBlock[]>([]);
  const [searchingRecordTitles, setSearchingRecordTitles] = useState(false);
  const [expandedRecordSubjects, setExpandedRecordSubjects] = useState<Set<string>>(() => new Set(
    initialScope?.kind === "records"
      ? savedRecords.filter((record) => initialScope.recordIds.includes(record.id)).map((record) => record.subject)
      : [],
  ));
  const [busyAction, setBusyAction] = useState<"primary" | "secondary">();
  const [error, setError] = useState("");
  const recordSearchComposingRef = useRef(false);
  const desktop = isDesktopPlatform();

  const scopeSubjects = useMemo(
    () => Array.from(new Set(savedRecords.map((record) => record.subject))).sort((left, right) => left.localeCompare(right, "zh-CN")),
    [savedRecords],
  );
  const scopeTags = useMemo(() => getSubjectRecordTags(savedRecords, scopeSubject), [savedRecords, scopeSubject]);
  const savedRecordIds = useMemo(() => new Set(savedRecords.map((record) => record.id)), [savedRecords]);
  const selectedRecordIdSet = useMemo(() => new Set(selectedRecordIds), [selectedRecordIds]);
  const visibleRecordTitleResults = rawRecordTitleResults.slice(0, RECORD_SEARCH_RESULT_LIMIT);
  const hasMoreRecordTitleResults = rawRecordTitleResults.length > RECORD_SEARCH_RESULT_LIMIT;
  const scopeRecordSource = recordTitleQuery.trim() ? visibleRecordTitleResults : savedRecords;
  const scopeRecordGroups = useMemo(() => {
    const grouped = new Map<string, RecordBlock[]>();
    for (const record of scopeRecordSource) {
      grouped.set(record.subject, [...(grouped.get(record.subject) ?? []), record]);
    }
    return [...grouped.entries()]
      .sort(([left], [right]) => left.localeCompare(right, "zh-CN"))
      .map(([subject, records]) => ({
        subject,
        records: [...records].sort((left, right) =>
          right.date.localeCompare(left.date) || right.order - left.order || right.createdAt.localeCompare(left.createdAt)),
      }));
  }, [scopeRecordSource]);

  useEffect(() => {
    if (!scopeSubjects.length) {
      if (scopeSubject) setScopeSubject("");
      return;
    }
    if (!scopeSubjects.includes(scopeSubject)) setScopeSubject(scopeSubjects[0]);
  }, [scopeSubject, scopeSubjects]);

  useEffect(() => {
    if (!scopeTags.includes(scopeTag)) setScopeTag(scopeTags[0] ?? "");
  }, [scopeTag, scopeTags]);

  useEffect(() => {
    setSelectedRecordIds((current) => {
      const next = current.filter((id) => savedRecordIds.has(id)).slice(0, maxSelectedRecords);
      return next.length === current.length && next.every((id, index) => id === current[index]) ? current : next;
    });
  }, [maxSelectedRecords, savedRecordIds]);

  useEffect(() => {
    if (!desktop || recordSearchComposingRef.current) return;
    setRecordSearchInput(recordTitleQuery);
  }, [desktop, recordTitleQuery]);

  useEffect(() => {
    if (scopeKind !== "records" || !recordTitleQuery.trim()) {
      setDeferredRecordTitleQuery("");
      return undefined;
    }
    const timer = window.setTimeout(() => setDeferredRecordTitleQuery(recordTitleQuery), SCOPE_SEARCH_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [recordTitleQuery, scopeKind]);

  useEffect(() => {
    const controller = new AbortController();
    if (scopeKind !== "records" || !deferredRecordTitleQuery.trim()) {
      setRawRecordTitleResults([]);
      setSearchingRecordTitles(false);
      return () => controller.abort();
    }
    setSearchingRecordTitles(true);
    void searchRecordTitlesAsync(
      deferredRecordTitleQuery,
      savedRecords,
      RECORD_SEARCH_RESULT_LIMIT + 1,
      controller.signal,
    ).then((results) => {
      if (!controller.signal.aborted) setRawRecordTitleResults(results);
    }).catch((searchError) => {
      if (!(searchError instanceof DOMException && searchError.name === "AbortError")) throw searchError;
    }).finally(() => {
      if (!controller.signal.aborted) setSearchingRecordTitles(false);
    });
    return () => controller.abort();
  }, [deferredRecordTitleQuery, savedRecords, scopeKind]);

  const pendingScope = useMemo<AiKnowledgeScope | undefined>(() => {
    if (scopeKind === "recent") return { kind: "recent", days: recentDays };
    if (scopeKind === "records") return { kind: "records", recordIds: selectedRecordIds };
    if (scopeKind === "date" && includeDate && scopeDate) return { kind: "date", date: scopeDate };
    if (scopeKind === "tag" && scopeSubject && scopeTag) return { kind: "tag", subject: scopeSubject, tag: scopeTag };
    return undefined;
  }, [includeDate, recentDays, scopeDate, scopeKind, scopeSubject, scopeTag, selectedRecordIds]);
  const pendingScopeRecords = useMemo(
    () => pendingScope ? getAiKnowledgeScopeRecords(pendingScope, blocks, new Date().toISOString().slice(0, 10)) : [],
    [blocks, pendingScope],
  );
  const pendingScopeOcrCount = useMemo(() => {
    const assetIds = new Set(pendingScopeRecords.flatMap((record) => record.assets.map((asset) => asset.id)));
    return assets.filter((asset) => assetIds.has(asset.id) && asset.kind === "image" && asset.ocrStatus === "done" && asset.ocrText?.trim()).length;
  }, [assets, pendingScopeRecords]);
  const pendingScopeEstimate = useMemo(
    () => estimateAiTokens(pendingScopeRecords.map((record) => `${record.title}\n${record.contentHtml}`).join("\n")),
    [pendingScopeRecords],
  );
  const selectedRecordCount = selectedRecordIds.length;
  const scopeUnavailableReason = (() => {
    if (scopeKind === "tag" && scopeSubjects.length === 0) return "没有可用学科，请先保存正式日志。";
    if (scopeKind === "tag" && scopeTags.length === 0) return "该学科没有已保存标签。";
    if (scopeKind === "records" && selectedRecordCount < minSelectedRecords) return `请至少选择 ${minSelectedRecords} 条日志。`;
    if (!pendingScope) return "请选择完整的知识范围。";
    if (pendingScopeRecords.length === 0) return "当前范围没有命中可用日志。";
    return "";
  })();
  const canUseScope = Boolean(pendingScope) && !scopeUnavailableReason;
  const busy = Boolean(busyAction);

  useEffect(() => {
    if (pendingScope) onScopeChange?.(pendingScope);
  }, [onScopeChange, pendingScope]);

  const toggleScopeRecord = (recordId: string) => {
    setSelectedRecordIds((current) => {
      if (current.includes(recordId)) return current.filter((id) => id !== recordId);
      if (current.length >= maxSelectedRecords) return current;
      return [...current, recordId];
    });
  };

  const toggleRecordSubject = (subject: string) => {
    setExpandedRecordSubjects((current) => {
      const next = new Set(current);
      if (next.has(subject)) next.delete(subject); else next.add(subject);
      return next;
    });
  };

  const runAction = async (kind: "primary" | "secondary", action: (scope: AiKnowledgeScope) => void | Promise<void>) => {
    if (!pendingScope || !canUseScope || busy) return;
    setBusyAction(kind);
    setError("");
    try {
      await action(pendingScope);
    } catch (actionError) {
      setError(actionError instanceof Error ? actionError.message : "知识范围操作失败。");
    } finally {
      setBusyAction(undefined);
    }
  };

  const renderRecordOption = (record: RecordBlock) => {
    const selected = selectedRecordIdSet.has(record.id);
    const selectionLimitReached = !selected && selectedRecordCount >= maxSelectedRecords;
    return (
      <label key={record.id} className={`ai-scope-record-option${selected ? " selected" : ""}${selectionLimitReached ? " disabled" : ""}`}>
        <input type="checkbox" checked={selected} onChange={() => toggleScopeRecord(record.id)} disabled={selectionLimitReached} aria-label={`选择日志 ${record.title || "未命名日志"}`} />
        <span><strong>{record.title || "未命名日志"}</strong><small>{record.date} · {record.subject}</small></span>
      </label>
    );
  };

  return (
    <main className="page ai-scope-page immersive page-section-transition" aria-label={ariaLabel}>
      <section className={`ai-scope-page-shell${scopeKind === "records" ? " ai-scope-page-records" : ""}`}>
        <header className="ai-scope-page-header">
          <button type="button" className="icon-button" onClick={onBack} disabled={busy} aria-label={backLabel} title={backLabel}><ArrowLeft size={18} /></button>
          <div><p className="eyebrow">{eyebrow}</p><h1>{title}</h1></div>
        </header>
        <div className={`ai-scope-mode-control${includeDate ? " four-options" : ""}`} role="tablist" aria-label="知识范围">
          <button type="button" role="tab" aria-selected={scopeKind === "tag"} className={scopeKind === "tag" ? "active" : ""} onClick={() => setScopeKind("tag")}>学科标签</button>
          <button type="button" role="tab" aria-selected={scopeKind === "recent"} className={scopeKind === "recent" ? "active" : ""} onClick={() => setScopeKind("recent")}>近期学习</button>
          {includeDate && <button type="button" role="tab" aria-selected={scopeKind === "date"} className={scopeKind === "date" ? "active" : ""} onClick={() => setScopeKind("date")}>按日期</button>}
          <button type="button" role="tab" aria-selected={scopeKind === "records"} className={scopeKind === "records" ? "active" : ""} onClick={() => setScopeKind("records")}>选择日志</button>
        </div>
        <div className="ai-scope-page-content">
          {scopeKind === "tag" ? (
            <div className="ai-scope-fields">
              <label>学科<select value={scopeSubject} onChange={(event) => setScopeSubject(event.target.value)} disabled={scopeSubjects.length === 0}>{scopeSubjects.length === 0 && <option value="">没有可用学科</option>}{scopeSubjects.map((subject) => <option key={subject} value={subject}>{subject}</option>)}</select></label>
              <label>标签<select value={scopeTag} onChange={(event) => setScopeTag(event.target.value)} disabled={scopeTags.length === 0}>{scopeTags.length === 0 && <option value="">该学科没有已保存标签</option>}{scopeTags.map((tag) => <option key={tag} value={tag}>#{tag}</option>)}</select></label>
            </div>
          ) : scopeKind === "recent" ? (
            <div className="ai-recent-range-control" role="tablist" aria-label="近期范围">{([7, 14, 30] as const).map((days) => <button key={days} type="button" role="tab" aria-selected={recentDays === days} className={recentDays === days ? "active" : ""} onClick={() => setRecentDays(days)}>{days} 天</button>)}</div>
          ) : scopeKind === "date" && includeDate ? (
            <div className="ai-scope-fields"><label>日期<input type="date" value={scopeDate} onChange={(event) => setScopeDate(event.target.value)} /></label></div>
          ) : (
            <div className="ai-scope-record-picker">
              <label className="search-box ai-scope-record-search"><Search size={18} /><input value={desktop ? recordSearchInput : recordTitleQuery} onCompositionStart={() => { if (desktop) recordSearchComposingRef.current = true; }} onCompositionEnd={(event) => { if (!desktop) return; recordSearchComposingRef.current = false; setRecordSearchInput(event.currentTarget.value); setRecordTitleQuery(event.currentTarget.value); }} onChange={(event) => { const value = event.target.value; if (!desktop) { setRecordTitleQuery(value); return; } setRecordSearchInput(value); if (!(event.nativeEvent as InputEvent).isComposing && !recordSearchComposingRef.current) setRecordTitleQuery(value); }} placeholder="按日志标题搜索" aria-label="按日志标题搜索" /></label>
              <div className="ai-scope-selection-status" role="status"><strong>已选 {selectedRecordCount}/{maxSelectedRecords} 条日志</strong><span>{selectedRecordCount < minSelectedRecords ? `还需选择 ${minSelectedRecords - selectedRecordCount} 条` : `可跨学科选择，最多 ${maxSelectedRecords} 条`}</span></div>
              <div className="ai-scope-record-list" aria-label="可选日志">
                {searchingRecordTitles && <p className="status-message">正在搜索标题…</p>}
                {hasMoreRecordTitleResults && <p className="status-message">结果较多，仅显示前 {RECORD_SEARCH_RESULT_LIMIT} 条，请缩小关键词。</p>}
                {recordTitleQuery.trim() ? scopeRecordGroups.map((group) => <section key={group.subject} className="ai-scope-record-search-group"><h3>{group.subject} <small>{group.records.length} 条</small></h3><div>{group.records.map(renderRecordOption)}</div></section>) : scopeRecordGroups.map((group) => { const expanded = expandedRecordSubjects.has(group.subject); return <section key={group.subject} className="ai-scope-record-subject"><button type="button" className="ai-scope-record-subject-trigger" onClick={() => toggleRecordSubject(group.subject)} aria-expanded={expanded}><span><strong>{group.subject}</strong><small>{group.records.length} 条日志</small></span><ChevronDown size={18} className={expanded ? "expanded" : ""} /></button>{expanded && <div className="ai-scope-record-options">{group.records.map(renderRecordOption)}</div>}</section>; })}
                {!searchingRecordTitles && recordTitleQuery.trim() && scopeRecordGroups.length === 0 && <p className="helper-text">没有匹配的日志标题。</p>}
                {!recordTitleQuery.trim() && scopeRecordGroups.length === 0 && <p className="helper-text">还没有可用的正式日志。</p>}
              </div>
            </div>
          )}
          <div className={`ai-scope-preview${scopeUnavailableReason ? " unavailable" : ""}`}>
            <strong>{pendingScope ? aiKnowledgeScopeTitle(pendingScope) : "请选择知识范围"}</strong>
            <span>命中 {pendingScopeRecords.length} 条日志</span><span>可用 OCR 图片 {pendingScopeOcrCount} 张</span>
            <span>原始内容约 {pendingScopeEstimate.toLocaleString()} token，发送时会按模型窗口检索并截取。</span>
            {scopeUnavailableReason && <span className="error-text">{scopeUnavailableReason}</span>}
          </div>
          {error && <p className="error-message">{error}</p>}
        </div>
        <footer className="ai-scope-page-actions">
          <button type="button" className="secondary-button" onClick={onCancel} disabled={busy}>取消本次选择</button>
          {secondaryAction && <button type="button" className="secondary-button" onClick={() => void runAction("secondary", secondaryAction.onClick)} disabled={!canUseScope || busy}>{busyAction === "secondary" ? <RefreshCw size={18} className="spin" /> : secondaryAction.icon}{secondaryAction.label}</button>}
          <button type="button" className="primary-button" onClick={() => void runAction("primary", onConfirm)} disabled={!canUseScope || busy}>{busyAction === "primary" ? <RefreshCw size={18} className="spin" /> : confirmIcon}{confirmLabel}</button>
        </footer>
      </section>
    </main>
  );
};
