import { useEffect, useMemo, useRef, useState } from "react";
import { liveQuery } from "dexie";
import { ArrowLeft, BookOpen, ChevronRight, FolderPlus, GitBranch, List, Plus, Search, X } from "lucide-react";
import type { BackupAssetMeta, RecordBlock } from "../../types";
import { PageHeader } from "../../components/ui";
import { formatUiError } from "../../lib/uiError";
import { db } from "../../db/database";
import { knowledgeRepository, knowledgeSynchronizer } from "./runtime";
import { currentKnowledgeOwner } from "./context";
import { prepareKnowledgeImport, resumeKnowledgeImport } from "./import";
import type { StoredKnowledgeCommand } from "./schema";
import { createKnowledgeEntity, editKnowledgeEntity } from "./commands";
import { emptyKnowledgeState, ROOT_NODE, KnowledgeError, type KnowledgeCommand, type KnowledgeContext, type KnowledgeEntity, type KnowledgeLibrary, type KnowledgePosition, type KnowledgeState, type KnowledgeUnit } from "./domain";
import { isKnowledgeVisible, revisionValue, valueOf } from "./protocol";
import { knowledgeLabel, knowledgeChildren, layoutKnowledgeTree, searchKnowledge } from "./query";
import type { KnowledgeNavigation } from "./navigation";
import { KnowledgeMap } from "./KnowledgeMap";
import { orderBetween } from "./orderKey";
import "./knowledgeLibrary.css";

interface Props { records: readonly RecordBlock[]; assets?: readonly BackupAssetMeta[]; navigation: KnowledgeNavigation; onNavigation: (patch: Partial<KnowledgeNavigation>, push?: boolean) => void; onBack: () => void; onOpenRecord: (record: RecordBlock) => void }
interface Editing { command: KnowledgeCommand; unit: KnowledgeUnit; text: string; context: KnowledgeContext; label: string; isNew: boolean }
export const KnowledgeLibraryPage = ({ records, assets = [], navigation, onNavigation, onBack, onOpenRecord }: Props) => {
  const [libraries, setLibraries] = useState<KnowledgeLibrary[]>([]);
  const [guestLibraries, setGuestLibraries] = useState<KnowledgeLibrary[]>([]);
  const [state, setState] = useState<KnowledgeState>(emptyKnowledgeState);
  const [context, setContext] = useState<KnowledgeContext>();
  const [library, setLibrary] = useState<KnowledgeLibrary>();
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const [blockedCommands, setBlockedCommands] = useState<StoredKnowledgeCommand[]>([]);
  const [resolutionBaseline, setResolutionBaseline] = useState<{ command: KnowledgeCommand; context: KnowledgeContext }>();
  const [copySource, setCopySource] = useState("");
  const [message, setMessage] = useState("");
  const [organizing, setOrganizing] = useState(false);
  const [editing, setEditing] = useState<Editing>();
  const [picker, setPicker] = useState(false);
  const [moveNode, setMoveNode] = useState<string>();
  const [moveTarget, setMoveTarget] = useState(ROOT_NODE);
  const [selectedRecords, setSelectedRecords] = useState<string[]>([]);
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchAll, setSearchAll] = useState(false);
  const [unorganized, setUnorganized] = useState(false);
  const [subject, setSubject] = useState("");
  const [tag, setTag] = useState("");
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [includeBody, setIncludeBody] = useState(false);
  const [searchQuery, setSearchQuery] = useState(navigation.query);
  useEffect(() => { const timer = window.setTimeout(() => setSearchQuery(navigation.query), 120); return () => window.clearTimeout(timer); }, [navigation.query]);
  const [includeHidden, setIncludeHidden] = useState(false);
  const [trash, setTrash] = useState(false);
  const [conflictsOpen, setConflictsOpen] = useState(false);
  const [candidatePage, setCandidatePage] = useState(0);
  const [selectedCandidates, setSelectedCandidates] = useState<string[]>([]);
  const [resolutionText, setResolutionText] = useState("");
  const [pendingCount, setPendingCount] = useState(0);
  const [outlineScroll, setOutlineScroll] = useState(navigation.scrollTop);
  const [rowHeight, setRowHeight] = useState(80);
  const searchRef = useRef<HTMLInputElement>(null);
  const outlineRef = useRef<HTMLDivElement>(null);
  const dialogRef = useRef<HTMLDialogElement>(null);
  const lastFocus = useRef<HTMLElement | null>(null);
  const owner = currentKnowledgeOwner();
  const scope = library?.cloudLibraryId ?? library?.id ?? "";
  const selected = navigation.selectedNodeId ? state.entities[navigation.selectedNodeId] : undefined;
  const workspace = navigation.workspaceId ? state.entities[navigation.workspaceId] : undefined;
  const collapsed = useMemo(() => new Set(navigation.collapsed), [navigation.collapsed]);
  const layout = useMemo(() => workspace ? layoutKnowledgeTree(state, workspace.id, collapsed) : [], [state, workspace, collapsed]);
  const recordMap = useMemo(() => new Map(records.map(record => [record.id, record])), [records]);
  const references = useMemo(() => Object.values(state.entities).filter(entity => entity.kind === "reference" && entity.nodeId === selected?.id && isKnowledgeVisible(state, entity)), [state, selected]);
  const conflicts = Object.values(state.groups).filter(group => group.unresolvedCount > 0);
  const candidates = Object.values(state.candidates).filter(candidate => candidate.consumedBy === null);
  const filtered = useMemo(() => searchKnowledge(state, records, { text: searchQuery, workspaceId: searchAll || unorganized ? undefined : workspace?.id, subject: subject || undefined, tag: tag || undefined, from: dateFrom || undefined, to: dateTo || undefined, unorganized, includeBody, includeHidden }, assets), [state, records, assets, searchQuery, workspace?.id, searchAll, unorganized, subject, tag, dateFrom, dateTo, includeBody, includeHidden]);
  const [resultLimit, setResultLimit] = useState(50);
  const errorText = (error: unknown) => error instanceof KnowledgeError ? ({ stale: "内容或候选已变化，输入仍保留。请刷新后比较，再重新提交。", scope: "账号或知识库已变化，请重新打开当前库。", budget: "本次内容超过安全提交预算，请减少所选候选或调整内容。", cycle: "不能把节点移入自己或后代。", invalid: "内容校验未通过，未写入。", missing: "数据尚未完整到达，或同步请求超时；请重试。", receipt: "提交身份不一致，已停止写入，请保留本机内容。" }[error.code] + " " + formatUiError(error, "generic")) : formatUiError(error, "generic");
  const run = async (task: () => Promise<void>, success?: string) => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true); setMessage("");
    try { await task(); if (success) setMessage(success); } catch (error) { setMessage(errorText(error)); } finally { busyRef.current = false; setBusy(false); }
  };
  useEffect(() => {
    setLoading(true); setState(emptyKnowledgeState()); setContext(undefined); setLibrary(undefined);
    const subscription = liveQuery(async () => {
      const available = await knowledgeRepository.listLibraries();
      const id = navigation.libraryId && available.some(item => item.id === navigation.libraryId) ? navigation.libraryId : available[0]?.id;
      return { available, guests: owner === "deviceGuest" ? [] : await db.knowledgeLibraries.where("ownerScope").equals("deviceGuest").toArray(), opened: id ? await knowledgeRepository.open(id) : undefined, pending: id ? await db.knowledgeCommands.where("libraryId").equals(id).count() : 0, blocked: id ? await db.knowledgeCommands.where("[libraryId+status]").equals([id, "blocked"]).toArray() : [] };
    }).subscribe({ next: result => { setGuestLibraries(result.guests); setBlockedCommands(result.blocked); setLibraries(result.available); setPendingCount(result.pending); setState(result.opened?.state ?? emptyKnowledgeState()); setContext(result.opened?.context); setLibrary(result.opened?.library); setLoading(false); }, error: error => { setLoading(false); setMessage(errorText(error)); } });
    return () => subscription.unsubscribe();
  }, [navigation.libraryId, owner]);
  useEffect(() => {
    if (outlineRef.current) outlineRef.current.scrollTop = navigation.scrollTop;
  }, [workspace?.id]);
  useEffect(() => {
    const element = outlineRef.current;
    if (!element) return;
    const measure = () => setRowHeight(Math.max(80, Math.ceil(parseFloat(getComputedStyle(element).fontSize) * 5)));
    const observer = new ResizeObserver(measure); observer.observe(element); measure();
    return () => observer.disconnect();
  }, [workspace?.id, navigation.view]);
  const referenceCounts = useMemo(() => { const counts = new Map<string, number>(); for (const entity of Object.values(state.entities)) if (entity.kind === "reference" && isKnowledgeVisible(state, entity)) counts.set(entity.nodeId, (counts.get(entity.nodeId) ?? 0) + 1); return counts; }, [state]);
  const modal = Boolean(editing || picker || moveNode);
  useEffect(() => {
    if (modal && !dialogRef.current?.open) { lastFocus.current = document.activeElement as HTMLElement; dialogRef.current?.showModal(); }
    if (!modal && dialogRef.current?.open) { dialogRef.current.close(); lastFocus.current?.focus(); }
  }, [modal]);
  const dismiss = () => {
    if (busyRef.current) return;
    if (editing) {
      if (editing.isNew) { if (!window.confirm("新建内容尚未保存，确定放弃并离开？")) return; }
      else {
        if (!window.confirm("尚有未保存编辑。保留本机草稿后离开？")) return;
        void run(async () => { await knowledgeRepository.saveDraft(editing.context, { ...editing.context, id: editing.command.entity.id + ":" + editing.unit, entityId: editing.command.entity.id, unit: editing.unit, text: editing.text, expectedRevision: editing.command.expected[editing.unit] ?? null }); setEditing(undefined); });
        return;
      }
    }
    setEditing(undefined); setPicker(false); setMoveNode(undefined);
  };
  useEffect(() => {
    const back = (event: Event) => {
      if (event.defaultPrevented) return;
      if (modal) { event.preventDefault(); dismiss(); }
      else if (selected) { event.preventDefault(); onNavigation({ selectedNodeId: undefined }); }
      else if (searchOpen) { event.preventDefault(); setSearchOpen(false); }
      else if (organizing) { event.preventDefault(); setOrganizing(false); }
    };
    const keyboard = (event: KeyboardEvent) => {
      if (event.isComposing) return;
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "f" && !modal) { event.preventDefault(); setSearchOpen(true); setTimeout(() => searchRef.current?.focus(), 0); }
      if (event.key === "Escape" && !modal) { const attempt = new Event("knowledge-back", { cancelable: true }); window.dispatchEvent(attempt); if (attempt.defaultPrevented) event.preventDefault(); }
    };
    const leave = (event: Event) => { if (modal || busyRef.current) { event.preventDefault(); if (!busyRef.current) dismiss(); } };
    const unload = (event: BeforeUnloadEvent) => { if (editing || busyRef.current) { event.preventDefault(); event.returnValue = ""; } };
    window.addEventListener("knowledge-back", back); window.addEventListener("keydown", keyboard); window.addEventListener("knowledge-navigation-leave", leave); window.addEventListener("beforeunload", unload);
    return () => { window.removeEventListener("knowledge-back", back); window.removeEventListener("keydown", keyboard); window.removeEventListener("knowledge-navigation-leave", leave); window.removeEventListener("beforeunload", unload); };
  }, [modal, selected, searchOpen, organizing, busy, editing]);
  useEffect(() => {
    if (!editing || editing.isNew) return;
    const timer = window.setTimeout(() => { void knowledgeRepository.saveDraft(editing.context, { ...editing.context, id: editing.command.entity.id + ":" + editing.unit, entityId: editing.command.entity.id, unit: editing.unit, text: editing.text, expectedRevision: editing.command.expected[editing.unit] ?? null }).catch(error => setMessage("本机草稿保存失败；请勿关闭编辑。" + formatUiError(error, "generic"))); }, 400);
    return () => window.clearTimeout(timer);
  }, [editing]);
  const beginCreate = (kind: "workspace" | "node", parent = ROOT_NODE) => {
    if (!context) return;
    const command = createKnowledgeEntity(scope, kind, "未命名", workspace?.id, parent);
    if (kind === "node" && workspace) { const last = knowledgeChildren(state, workspace.id, parent).at(-1); command.changes.position = { parentNodeId: parent, orderKey: orderBetween(last ? (valueOf(state, last, "position") as KnowledgePosition).orderKey : null, null, command.id) }; }
    setEditing({ command, unit: "title", text: "", context, label: kind === "workspace" ? "新建专题" : "新建节点", isNew: true });
  };
  const beginEdit = async (entity: KnowledgeEntity, unit: "title" | "note" | "remark") => {
    if (!context) return;
    const command = editKnowledgeEntity(scope, state, entity, unit, String(valueOf(state, entity, unit) ?? ""));
    const draft = await db.knowledgeDrafts.get([context.libraryId, entity.id + ":" + unit]);
    if (draft && window.confirm(draft.expectedRevision === command.expected[unit] ? "发现本机未提交草稿，是否继续编辑？" : "草稿基线已变化。是否打开原草稿比较？正式保存不会覆盖较新内容。")) setEditing({ command: { ...command, expected: { [unit]: draft.expectedRevision } }, unit, text: draft.text, context, label: "编辑" + (unit === "title" ? "标题" : unit === "note" ? "节点说明" : "引用备注"), isNew: false });
    else setEditing({ command, unit, text: String(valueOf(state, entity, unit) ?? ""), context, label: "编辑" + (unit === "title" ? "标题" : unit === "note" ? "节点说明" : "引用备注"), isNew: false });
  };
  const saveEditing = async () => {
    if (!editing) return;
    await knowledgeRepository.execute(editing.context, { ...editing.command, changes: { ...editing.command.changes, [editing.unit]: editing.text } }, editing.command.entity.id + ":" + editing.unit);
    if (editing.isNew) onNavigation({ workspaceId: editing.command.entity.workspaceId, selectedNodeId: editing.command.entity.kind === "node" ? editing.command.entity.id : undefined }, editing.command.entity.kind === "workspace");
    setEditing(undefined);
  };
  const changeLifecycle = (entity: KnowledgeEntity, deleted: boolean) => run(async () => {
    if (!context) return;
    if (deleted && !window.confirm(entity.kind === "reference" ? "移除此引用？原日志不删除，并发备注会保留。" : "将此分支移入回收站？后代保留，原日志不删除。")) return;
    await knowledgeRepository.execute(context, editKnowledgeEntity(scope, state, entity, "deleted", deleted));
    if (deleted) onNavigation({ selectedNodeId: undefined });
  }, "已保存到本机");
  const move = async (id: string, parentNodeId: string) => {
    if (!context || !organizing) return;
    const entity = state.entities[id];
    const last = knowledgeChildren(state, entity.workspaceId, parentNodeId).filter(sibling => sibling.id !== id).at(-1);
    const command = editKnowledgeEntity(scope, state, entity, "position", { parentNodeId, orderKey: orderBetween(last ? (valueOf(state, last, "position") as KnowledgePosition).orderKey : null, null, crypto.randomUUID()) });
    await knowledgeRepository.execute(context, command); setMoveNode(undefined);
  };
  const addReferences = async () => {
    if (!context || !selected || selected.kind !== "node") return;
    let completed = 0;
    const failures: string[] = [];
    for (const recordId of selectedRecords) {
      try {
        const command = createKnowledgeEntity(scope, "reference", "", selected.workspaceId, ROOT_NODE, recordId, selected.id);
        const existing = state.entities[command.entity.id];
        if (existing && valueOf(state, existing, "deleted") === true) {
          if (!window.confirm("此日志引用曾被移除，是否恢复并保留旧备注？")) continue;
          await knowledgeRepository.execute(context, editKnowledgeEntity(scope, state, existing, "deleted", false));
        } else await knowledgeRepository.execute(context, command);
        completed += 1;
      } catch (error) { failures.push(recordId); setMessage(errorText(error)); }
    }
    setSelectedRecords(failures); if (!failures.length) setPicker(false);
    setMessage("已处理 " + completed + " 条引用；" + failures.length + " 条失败。原日志未修改。");
  };
  const selectNode = (id: string) => onNavigation({ selectedNodeId: id });
  const toggle = (id: string) => onNavigation({ collapsed: collapsed.has(id) ? navigation.collapsed.filter(item => item !== id) : [...navigation.collapsed, id] });
  const openHit = (hit: typeof filtered[number]) => {
    if (hit.recordId) { const record = recordMap.get(hit.recordId); if (record) onOpenRecord(record); }
    else {
      onNavigation({ workspaceId: hit.workspaceId, selectedNodeId: hit.nodeId, collapsed: [], scrollTop: 0 }, true);
      setSearchOpen(false);
    }
  };
  const resolveSelected = async () => {
    if (!resolutionBaseline || !selectedCandidates.length) return;
    const command = structuredClone(resolutionBaseline.command);
    const unit = command.resolution!.unit;
    command.changes[unit] = unit === "position" || unit === "deleted" || unit === "archived" ? command.changes[unit] : resolutionText;
    command.resolution!.candidates = [...selectedCandidates];
    await knowledgeRepository.execute(resolutionBaseline.context, command);
    setSelectedCandidates([]); setResolutionBaseline(undefined); setResolutionText("");
  };
  return <main className="page knowledge-library" aria-busy={busy || loading}>
    <div className="knowledge-toolbar"><button className="subtle-button" onClick={() => { const attempt = new Event("knowledge-back", { cancelable: true }); window.dispatchEvent(attempt); if (!attempt.defaultPrevented) onBack(); }}><ArrowLeft size={18} />返回</button><span>组织不改变日志正文与复习记录</span></div>
    <PageHeader title={workspace ? knowledgeLabel(state, workspace) : "知识库"} eyebrow="Knowledge Library" subtitle={workspace ? "先浏览，再整理。说明与备注按需展开。" : "把零散的学习日志，整理成可回看的专题。"} density="compact" />
    <div className="knowledge-toolbar">
      <label>本机库 <select aria-label="选择知识库" value={library?.id ?? ""} onChange={event => { onNavigation({ libraryId: event.target.value, workspaceId: undefined, selectedNodeId: undefined }, true); setOrganizing(false); }}><option value="" disabled>请选择</option>{libraries.map(item => <option key={item.id} value={item.id}>{item.title}{item.detached ? " · 恢复副本" : item.cloudLibraryId ? " · 云同步" : " · 仅本机"}</option>)}</select></label>
      <button className="subtle-button" disabled={busy} onClick={() => void run(async () => { const created = await knowledgeRepository.createLibrary("本机知识库"); onNavigation({ libraryId: created.id, workspaceId: undefined }, true); })}>新建本机库</button>
      <button className="secondary-button" disabled={busy} onClick={() => void run(async () => {
        const sync = knowledgeSynchronizer(); if (!sync) { setMessage("请先在云同步设置中登录账号。"); return; }
        if (!library?.cloudLibraryId) {
          const result = await sync.connect(library?.id); onNavigation({ libraryId: result.library.id, workspaceId: undefined }, true);
          if (result.importSourceId) setMessage("已发现账号知识库。原本机库完整保留，未自动合并或上传。");
        } else if (context) { const result = await sync.synchronize(context); setMessage("知识库同步完成；仍待上传 " + result.pending + " 项。普通日志通过原同步入口同步。"); }
      })}>{library?.cloudLibraryId ? "同步知识库" : "启用并发现账号知识库"}</button>
      <span role="status">{loading ? "正在读取本机库…" : pendingCount ? "本机已保存 · 待同步 " + pendingCount + " 项" : library?.cloudLibraryId ? "已读取已确认内容" : "仅本机保存"}</span>
    </div>
    {message && <p className="knowledge-feedback" role="status">{message}</p>}
    {library?.cloudLibraryId && context && <details className="knowledge-panel"><summary>把本机库另存到账号库</summary><p>复制专题、现有内容及未处理候选；原库及其完整历史保留，不按名称合并。中断后可继续同一会话。</p><select aria-label="另存来源" value={copySource} onChange={event => setCopySource(event.target.value)}><option value="">选择来源本机库</option>{[...libraries, ...guestLibraries].filter(item => item.id !== library.id && !item.cloudLibraryId).map(item => <option key={item.id} value={item.id}>{item.title}</option>)}</select><button disabled={busy || !copySource} onClick={() => void run(async () => { const opened = await knowledgeRepository.assertContext(context); const active = Object.values(opened.sync.importSessions ?? {}).find(session => session.sourceLibraryId === copySource && session.next < session.commands.length); const sessionId = active?.id ?? crypto.randomUUID(); await prepareKnowledgeImport(knowledgeRepository, copySource, context, sessionId); await resumeKnowledgeImport(knowledgeRepository, context, sessionId, (completed, total) => setMessage("另存到本机账号库：" + completed + " / " + total)); }, "另存完成，原库保留；请同步上传。")}>另存 / 继续</button></details>}
    {!!blockedCommands.length && <section className="knowledge-panel"><h2>需要重新确认的本机操作</h2><p>同步基线已变化。这些操作未覆盖云端，原始意图与版本保留；其他条目仍可同步。</p>{blockedCommands.map(entry => <article key={entry.id}><p>{entry.command.operation} · {knowledgeLabel(state, state.entities[entry.command.entity.id])}</p><pre>{JSON.stringify(entry.command.changes)}</pre><button disabled={busy} onClick={() => { const entity = state.entities[entry.command.entity.id]; if (entity) { onNavigation({ workspaceId: entity.workspaceId, selectedNodeId: entity.kind === "node" ? entity.id : entity.nodeId || undefined }, true); setTrash(true); setConflictsOpen(true); setMessage("请基于当前内容重新确认恢复或冲突处理。旧意图保留，未自动重试。"); } }}>查看当前内容</button>{entry.recoveryLibraryId && <button disabled={busy} onClick={() => onNavigation({ libraryId: entry.recoveryLibraryId, workspaceId: undefined, selectedNodeId: undefined }, true)}>打开完整保留副本</button>}<button disabled={busy || !context} onClick={() => void run(async () => { if (context && window.confirm("确认不再自动重试此旧操作？完整本机内容仍在保留副本中，可另存回账号库。")) await knowledgeRepository.acknowledgeBlocked(context, entry.id, entry.hash); })}>确认保留副本并结束旧操作</button></article>)}</section>}
    {!loading && !library && <section className="knowledge-empty"><BookOpen size={32} /><h2>从一个专题开始</h2><p>创建本机库，或登录后发现已有账号库。日志仍保留在原来的资料库中。</p></section>}
    {library && <>
      <div className="knowledge-toolbar">
        {!workspace && <button className="primary-button" disabled={busy} onClick={() => beginCreate("workspace")}><FolderPlus size={17} />新建专题</button>}
        {workspace && <><button className="subtle-button" onClick={() => onNavigation({ workspaceId: undefined, selectedNodeId: undefined }, true)}>专题首页</button><div className="knowledge-view-switch" role="group" aria-label="专题视图"><button aria-pressed={navigation.view === "outline"} onClick={() => onNavigation({ view: "outline" })}><List size={16} />大纲</button><button aria-pressed={navigation.view === "map"} onClick={() => onNavigation({ view: "map" })}><GitBranch size={16} />导图</button></div><button className={organizing ? "primary-button" : "secondary-button"} onClick={() => setOrganizing(!organizing)}>{organizing ? "完成整理" : "整理"}</button>{organizing && <button className="secondary-button" onClick={() => beginCreate("node")}><Plus size={17} />添加分支</button>}</>}
        <button className="subtle-button" onClick={() => { setSearchOpen(!searchOpen); setUnorganized(false); }}><Search size={17} />查找</button>
        <button className="subtle-button" onClick={() => { setSearchOpen(true); setSearchAll(true); setUnorganized(true); }}>待整理</button>
        <button className="subtle-button" onClick={() => setTrash(!trash)}>回收站与归档</button>
        <button className="subtle-button" onClick={() => setConflictsOpen(!conflictsOpen)}>待处理 {conflicts.length || ""}</button>
      </div>
      {searchOpen && <section className="knowledge-search" aria-label="知识检索"><div className="knowledge-toolbar"><input ref={searchRef} aria-label="检索知识库" placeholder={unorganized ? "筛选待整理日志" : workspace ? "查找专题、说明、引用与日志" : "搜索知识库"} value={navigation.query} onChange={event => { onNavigation({ query: event.target.value }); setResultLimit(50); }} /><label><input type="checkbox" checked={searchAll} onChange={event => setSearchAll(event.target.checked)} />全库</label><label><input type="checkbox" checked={includeBody} onChange={event => setIncludeBody(event.target.checked)} />日志正文</label><label><input type="checkbox" checked={includeHidden} onChange={event => setIncludeHidden(event.target.checked)} />含隐藏内容</label></div><div className="knowledge-toolbar"><select aria-label="按学科筛选" value={subject} onChange={event => setSubject(event.target.value)}><option value="">全部学科</option>{[...new Set(records.map(record => record.subject))].map(item => <option key={item}>{item}</option>)}</select><input aria-label="按标签筛选" placeholder="标签" value={tag} onChange={event => setTag(event.target.value)} /><input aria-label="开始日期" type="date" value={dateFrom} onChange={event => setDateFrom(event.target.value)} /><input aria-label="结束日期" type="date" value={dateTo} onChange={event => setDateTo(event.target.value)} /></div><p>{unorganized ? "待整理" : "检索结果"}：{filtered.length} 项</p><div className="knowledge-results">{filtered.slice(0, resultLimit).map(hit => <button key={(hit.recordId ?? "entity") + ":" + hit.entityId} onClick={() => openHit(hit)}><strong>{hit.title}</strong><span>{hit.excerpt}</span></button>)}</div>{filtered.length > resultLimit && <button className="subtle-button" onClick={() => setResultLimit(resultLimit + 50)}>显示更多结果</button>}{!filtered.length && <p>当前范围没有匹配结果，可调整关键词或筛选。</p>}</section>}
      {trash && <section className="knowledge-panel"><h2>回收站与归档</h2><p>恢复组织不会恢复或修改原日志正文。隐藏后代的内容仍保留。</p>{Object.values(state.entities).filter(entity => valueOf(state, entity, "deleted") === true || valueOf(state, entity, "archived") === true).map(entity => <div className="knowledge-toolbar" key={entity.id}><span>{knowledgeLabel(state, entity)}</span>{valueOf(state, entity, "deleted") === true ? <button onClick={() => void changeLifecycle(entity, false)}>恢复条目</button> : <button onClick={() => void run(async () => { if (context) await knowledgeRepository.execute(context, editKnowledgeEntity(scope, state, entity, "archived", false)); })}>取消归档</button>}</div>)}</section>}
      {conflictsOpen && <section className="knowledge-panel"><h2>待处理版本</h2><p>每批最多选择同一字段的四个候选；未选版本不会被处理。结构冲突本批保留当前位置，另行显式移动。</p>{candidates.slice(candidatePage * 20, candidatePage * 20 + 20).map(candidate => { const revision = state.revisions[candidate.revisionId]; return <label className="knowledge-candidate" key={candidate.id}><input type="checkbox" checked={selectedCandidates.includes(candidate.id)} onChange={event => { if (event.target.checked) { if (selectedCandidates.length >= 4 || (selectedCandidates.length && state.candidates[selectedCandidates[0]]?.groupId !== candidate.groupId)) { setMessage("每批请选择同一字段的最多四份候选。"); return; } if (!selectedCandidates.length && context) { const group = state.groups[candidate.groupId]; const current = state.revisions[group.currentRevisionId]; const command = editKnowledgeEntity(scope, state, state.entities[current.entityId], current.unit, revisionValue(state, current.id)!); command.operation = "resolve"; command.resolution = { unit: current.unit, setToken: group.setToken, generation: group.generation, candidates: [] }; setResolutionBaseline({ command, context }); setResolutionText(String(revisionValue(state, current.id) ?? "")); } setSelectedCandidates([...selectedCandidates, candidate.id]); } else setSelectedCandidates(selectedCandidates.filter(id => id !== candidate.id)); }} /><span>{knowledgeLabel(state, state.entities[revision.entityId])} · {revision.unit}<pre>{typeof revision.value === "string" ? revision.value : JSON.stringify(revision.value)}</pre></span></label>; })}<textarea aria-label="冲突合并结果" placeholder="填写本批合并后的文字；可以保留原文或合并说明" value={resolutionText} onChange={event => setResolutionText(event.target.value)} /><div className="knowledge-toolbar"><button className="primary-button" disabled={busy || !selectedCandidates.length} onClick={() => void run(resolveSelected, "本批已处理；未选候选仍保留")}>处理所选候选</button><button disabled={candidatePage === 0} onClick={() => setCandidatePage(candidatePage - 1)}>上一页</button><button disabled={(candidatePage + 1) * 20 >= candidates.length} onClick={() => setCandidatePage(candidatePage + 1)}>下一页</button><span>剩余 {candidates.length} 份候选</span></div></section>}
      {!workspace && <div className="knowledge-topics">{Object.values(state.entities).filter(entity => entity.kind === "workspace" && isKnowledgeVisible(state, entity)).map(entity => <button className="knowledge-topic" key={entity.id} onClick={() => onNavigation({ workspaceId: entity.id, selectedNodeId: undefined, scrollTop: 0 }, true)}><BookOpen size={22} /><span><strong>{knowledgeLabel(state, entity)}</strong><small>{String(valueOf(state, entity, "note") || "打开大纲，整理日志引用")}</small></span><ChevronRight size={18} /></button>)}</div>}
      {workspace && <><div className="knowledge-toolbar"><details><summary>专题说明</summary><p className="knowledge-note">{String(valueOf(state, workspace, "note") || "尚无专题说明")}</p></details>{organizing && <><button onClick={() => void run(() => beginEdit(workspace, "title"))}>修改专题名</button><button onClick={() => void run(() => beginEdit(workspace, "note"))}>编辑说明</button><button onClick={() => void run(async () => { if (context) await knowledgeRepository.execute(context, editKnowledgeEntity(scope, state, workspace, "archived", true)); onNavigation({ workspaceId: undefined }); })}>归档专题</button><button onClick={() => void changeLifecycle(workspace, true)}>删除专题</button></>}</div><div className="knowledge-workspace">
        {navigation.view === "map" ? <KnowledgeMap state={state} workspaceId={workspace.id} navigation={navigation} organizing={organizing} onNavigation={onNavigation} onSelect={selectNode} onToggle={toggle} onMove={(id, parent) => void run(() => move(id, parent), "分支位置已保存")} /> : <div className="knowledge-outline" ref={outlineRef} role="tree" aria-label="专题大纲" onScroll={event => { setOutlineScroll(event.currentTarget.scrollTop); onNavigation({ scrollTop: event.currentTarget.scrollTop }); }}><div style={{ height: layout.length * rowHeight, position: "relative", minHeight: 100 }}>{layout.filter((_node, index) => index * rowHeight >= outlineScroll - 180 && index * rowHeight <= outlineScroll + 1000).map(node => { const index = layout.indexOf(node); const entity = state.entities[node.id]; const count = referenceCounts.get(entity.id) ?? 0; return <div className={"knowledge-outline-row" + (selected?.id === entity.id ? " selected" : "")} role="treeitem" aria-level={node.depth + 1} aria-expanded={!collapsed.has(entity.id)} aria-selected={selected?.id === entity.id} key={entity.id} style={{ position: "absolute", top: index * rowHeight, height: rowHeight, left: 0, right: 0, paddingLeft: Math.min(node.depth, 8) * 18 }}><button className="knowledge-collapse" aria-label={collapsed.has(entity.id) ? "展开分支" : "折叠分支"} onClick={() => toggle(entity.id)}>{collapsed.has(entity.id) ? "+" : "−"}</button><button className="knowledge-row-title" onClick={() => selectNode(entity.id)}><span>{knowledgeLabel(state, entity)}</span><small>{count ? count + " 条日志" : "文字节点"}{valueOf(state, entity, "note") ? " · 有说明" : ""}</small></button>{organizing && <button className="subtle-button" aria-label={"移动节点：" + knowledgeLabel(state, entity)} onClick={() => { setMoveNode(entity.id); setMoveTarget(ROOT_NODE); }}>移动到</button>}</div>; })}</div>{!layout.length && <div className="knowledge-empty">此专题还没有节点。进入整理后添加分支。</div>}</div>}
        {selected && <aside className="knowledge-detail" aria-label="节点详情"><div className="knowledge-toolbar"><h2>{knowledgeLabel(state, selected)}</h2><button className="subtle-button" aria-label="关闭节点详情" onClick={() => onNavigation({ selectedNodeId: undefined })}><X size={20} /></button></div><p className="knowledge-note">{String(valueOf(state, selected, "note") || "暂无说明")}</p>{references.map(reference => { const record = recordMap.get(reference.recordId); return <article className="knowledge-reference" key={reference.id}><button className="knowledge-reference-link" disabled={!record || Boolean(record.deletedAt)} onClick={() => record && onOpenRecord(record)}>{record?.title || "原日志暂不可用"}</button>{!record && <small>等待普通日志同步；引用仍保留。</small>}{record?.deletedAt && <small>原日志在回收站，需在日志回收站恢复。</small>}{valueOf(state, reference, "remark") && <details><summary>引用备注</summary><p className="knowledge-note">{String(valueOf(state, reference, "remark"))}</p></details>}{organizing && <div className="knowledge-toolbar"><button onClick={() => void run(() => beginEdit(reference, "remark"))}>编辑备注</button><button onClick={() => void changeLifecycle(reference, true)}>移除引用</button></div>}</article>; })}{organizing && <div className="knowledge-detail-actions"><button className="primary-button" onClick={() => { setPicker(true); setSelectedRecords(navigation.addRecordId ? [navigation.addRecordId] : []); }}>关联日志</button><button onClick={() => beginCreate("node", selected.id)}>添加子节点</button><button onClick={() => void run(() => beginEdit(selected, "title"))}>编辑标题</button><button onClick={() => void run(() => beginEdit(selected, "note"))}>编辑说明</button><button onClick={() => { setMoveNode(selected.id); setMoveTarget(ROOT_NODE); }}>移动到</button><button onClick={() => void changeLifecycle(selected, true)}>删除分支</button></div>}{!organizing && <p className="knowledge-muted">当前为只读浏览。需要修改时请点击“整理”。</p>}</aside>}
      </div></>}
    </>}
    <dialog className="knowledge-dialog knowledge-library" ref={dialogRef} onCancel={event => { event.preventDefault(); dismiss(); }} aria-label={editing?.label ?? (picker ? "关联日志" : "移动分支")}>
      <div className="knowledge-toolbar"><h2>{editing?.label ?? (picker ? "关联日志" : "移动分支")}</h2><button className="subtle-button" aria-label="关闭操作窗口" disabled={busy} onClick={dismiss}><X size={20} /></button></div>
      {editing && <form onSubmit={event => { event.preventDefault(); void run(saveEditing, "已保存到本机，等待同步"); }}><label>{editing.label}{editing.unit === "title" ? <input autoFocus value={editing.text} onChange={event => setEditing({ ...editing, command: { ...editing.command, id: crypto.randomUUID() }, text: event.target.value })} onKeyDown={event => { if (event.nativeEvent.isComposing && event.key === "Enter") event.preventDefault(); }} /> : <textarea autoFocus rows={12} value={editing.text} onChange={event => setEditing({ ...editing, command: { ...editing.command, id: crypto.randomUUID() }, text: event.target.value })} />}</label><p>显式保存才成为正式内容；批注不会写入原日志。</p><div className="knowledge-toolbar"><button className="primary-button" disabled={busy || (editing.unit === "title" && !editing.text.trim())}>{busy ? "保存中…" : "保存"}</button><button type="button" disabled={busy} onClick={dismiss}>取消</button><button type="button" disabled={busy} onClick={() => void run(async () => { await db.knowledgeDrafts.delete([editing.context.libraryId, editing.command.entity.id + ":" + editing.unit]); setEditing(undefined); })}>放弃草稿</button></div></form>}
      {picker && <><p>可多选。已关联的日志不会重复加入；重新加入已移除引用需要确认恢复。</p><input aria-label="查找要关联的日志" placeholder="搜索日志标题" value={navigation.query} onChange={event => onNavigation({ query: event.target.value })} /><div className="knowledge-picker-list">{records.filter(record => !record.deletedAt && record.title.toLocaleLowerCase().includes(navigation.query.toLocaleLowerCase())).map(record => <label key={record.id}><input type="checkbox" checked={selectedRecords.includes(record.id)} onChange={event => setSelectedRecords(event.target.checked ? [...selectedRecords, record.id] : selectedRecords.filter(id => id !== record.id))} /><span>{record.title || "未命名日志"}<small>{record.subject} · {record.date}</small></span></label>)}</div><button className="primary-button" disabled={busy || !selectedRecords.length} onClick={() => void run(addReferences)}>{busy ? "添加中…" : "加入所选 " + selectedRecords.length + " 条日志"}</button></>}
      {moveNode && <><p>节点只有一个正式父级。移动不复制子树，不改变日志正文。</p><label>目标父节点<select value={moveTarget} onChange={event => setMoveTarget(event.target.value)}><option value={ROOT_NODE}>专题根分支</option>{Object.values(state.entities).filter(entity => entity.kind === "node" && entity.workspaceId === workspace?.id && entity.id !== moveNode && isKnowledgeVisible(state, entity)).map(entity => <option key={entity.id} value={entity.id}>{knowledgeLabel(state, entity)}</option>)}</select></label><button className="primary-button" disabled={busy} onClick={() => void run(() => move(moveNode, moveTarget), "位置已保存")}>确认移动</button></>}
      {message && <p role="status">{message}</p>}
    </dialog>
  </main>;
};
