import { useEffect, useMemo, useRef, useState } from "react";
import { liveQuery } from "dexie";
import { ArrowLeft, BookOpen, ChevronRight, GitBranch, List, MoreHorizontal, Plus, Search, X } from "lucide-react";
import type { BackupAssetMeta, RecordBlock } from "../../types";
import { db } from "../../db/database";
import { usePageTransitionLayerState } from "../../components/PageTransition";
import { knowledgeRepository } from "./runtime";
import { currentKnowledgeOwner, knowledgeContextGeneration } from "./context";
import type { StoredKnowledgeCommand } from "./schema";
import { createKnowledgeEntity, editKnowledgeEntity } from "./commands";
import { emptyKnowledgeState, ROOT_NODE, type KnowledgeCommand, type KnowledgeContext, type KnowledgeEntity, type KnowledgeLibrary, type KnowledgePosition, type KnowledgeState, type KnowledgeUnit } from "./domain";
import { isKnowledgeVisible, revisionValue, valueOf } from "./protocol";
import { knowledgeLabel, knowledgeChildren, type KnowledgeHit } from "./query";
import type { KnowledgeNavigation } from "./navigation";
import { KnowledgeMap } from "./KnowledgeMap";
import { KnowledgeDetails } from "./KnowledgeDetails";
import { KnowledgeOutline, KnowledgeTitleInput, type KnowledgeTitleEditor } from "./KnowledgeOutline";
import { KnowledgeResults } from "./KnowledgeResults";
import { knowledgeUiError, type KnowledgeFailure } from "./uiError";
import { orderBetween } from "./orderKey";
import "./knowledgeLibrary.css";
interface Props { records: readonly RecordBlock[]; assets?: readonly BackupAssetMeta[]; navigation: KnowledgeNavigation; onNavigation: (patch: Partial<KnowledgeNavigation>, push?: boolean) => void; onBack: () => void; onOpenRecord: (record: RecordBlock) => void }
interface Editing { command: KnowledgeCommand; unit: KnowledgeUnit; text: string; context: KnowledgeContext; label: string; isNew: boolean }
type Panel = "search" | "unorganized" | "manage" | "trash" | "conflicts" | "menu" | "node-menu";
export const KnowledgeLibraryPage = ({ records, assets = [], navigation, onNavigation, onBack, onOpenRecord }: Props) => {
  const layerState = usePageTransitionLayerState();
  const [libraries, setLibraries] = useState<KnowledgeLibrary[]>([]);
  const [state, setState] = useState<KnowledgeState>(emptyKnowledgeState);
  const [context, setContext] = useState<KnowledgeContext>();
  const [library, setLibrary] = useState<KnowledgeLibrary>();
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const [blockedCommands, setBlockedCommands] = useState<StoredKnowledgeCommand[]>([]);
  const [resolutionBaseline, setResolutionBaseline] = useState<{ command: KnowledgeCommand; context: KnowledgeContext }>();
  const [message, setMessage] = useState("");
  const [failure, setFailure] = useState<KnowledgeFailure>();
  const [editing, setEditing] = useState<Editing>();
  const [picker, setPicker] = useState(false);
  const [moveNode, setMoveNode] = useState<string>();
  const [moveTarget, setMoveTarget] = useState(ROOT_NODE);
  const [selectedRecords, setSelectedRecords] = useState<string[]>([]);
  const [panel, setPanel] = useState<Panel>();
  const detailOpen = navigation.detailsOpen ?? false;
  const setDetailOpen = (detailsOpen: boolean) => onNavigation({ detailsOpen });
  const [topicTitle, setTopicTitle] = useState<string>();
  const [nextAction, setNextAction] = useState<() => void>();
  const topicIntent = useRef<Parameters<typeof knowledgeRepository.createTopic>[1]>();
  const topicForSelection = useRef(false);
  const [libraryName, setLibraryName] = useState("");
  const [creatingLibrary, setCreatingLibrary] = useState(false);
  const libraryIntent = useRef(crypto.randomUUID());
  const libraryOwner = useRef({ owner: currentKnowledgeOwner(), generation: knowledgeContextGeneration() });
  const [targetWorkspace, setTargetWorkspace] = useState("");
  const [targetNode, setTargetNode] = useState("");
  const [candidatePage, setCandidatePage] = useState(0);
  const [selectedCandidates, setSelectedCandidates] = useState<string[]>([]);
  const [resolutionText, setResolutionText] = useState("");
  const [owner, setOwner] = useState(currentKnowledgeOwner);
  const dialogRef = useRef<HTMLDialogElement>(null);
  const topicInputRef = useRef<HTMLInputElement>(null);
  const lastFocus = useRef<HTMLElement | null>(null);
  const scope = library?.cloudLibraryId ?? library?.id ?? "";
  const selected = navigation.selectedNodeId ? state.entities[navigation.selectedNodeId] : undefined;
  const workspace = navigation.workspaceId ? state.entities[navigation.workspaceId] : undefined;
  const topics = useMemo(() => Object.values(state.entities).filter(entity => entity.kind === "workspace" && isKnowledgeVisible(state, entity)), [state]);
  const recordMap = useMemo(() => new Map(records.map(record => [record.id, record])), [records]);
  const references = useMemo(() => Object.values(state.entities).filter(entity => entity.kind === "reference" && entity.nodeId === selected?.id && isKnowledgeVisible(state, entity)), [state, selected]);
  const conflicts = Object.values(state.groups).filter(group => group.unresolvedCount > 0);
  const candidates = Object.values(state.candidates).filter(candidate => candidate.consumedBy === null);
  const inlineEditing = Boolean(editing && editing.unit === "title" && editing.command.entity.kind === "node");
  const modal = Boolean((editing && !inlineEditing) || picker || moveNode || panel || topicTitle !== undefined);
  const afterClose = (action: () => void) => { setPanel(undefined); setPicker(false); setMoveNode(undefined); setTopicTitle(undefined); setNextAction(() => action); };
  useEffect(() => { if (nextAction && !modal && !editing && !busy && layerState !== "exiting") { setNextAction(undefined); nextAction(); } }, [nextAction, modal, editing, busy, layerState]);
  const errorText = (error: unknown, stage?: string) => { const next = knowledgeUiError(error, stage); setFailure(next); return next.message; };
  const run = async (task: () => Promise<void>, success?: string, stage?: string) => {
    if (busyRef.current) return;
    busyRef.current = true; setBusy(true); setMessage(""); setFailure(undefined);
    try { await task(); if (success && !success.startsWith("已保存")) setMessage(success); }
    catch (error) { errorText(error, stage); }
    finally { busyRef.current = false; setBusy(false); }
  };
  useEffect(() => {
    const changed = () => { setOwner(currentKnowledgeOwner()); setPanel(undefined); setPicker(false); setEditing(undefined); setTopicTitle(undefined); setNextAction(undefined); setMoveNode(undefined); setSelectedRecords([]); setMessage("账号已变化，请在当前账号下重新打开知识库。"); };
    window.addEventListener("knowledge-owner-changed", changed);
    return () => window.removeEventListener("knowledge-owner-changed", changed);
  }, []);
  useEffect(() => {
    setLoading(true); setState(emptyKnowledgeState()); setContext(undefined); setLibrary(undefined);
    const subscription = liveQuery(async () => {
      const available = await knowledgeRepository.listLibraries();
      const id = navigation.libraryId && available.some(item => item.id === navigation.libraryId) ? navigation.libraryId : available[0]?.id;
      return { available, opened: id ? await knowledgeRepository.open(id) : undefined, blocked: id ? await db.knowledgeCommands.where("[libraryId+status]").equals([id, "blocked"]).toArray() : [] };
    }).subscribe({ next: result => { setBlockedCommands(result.blocked); setLibraries(result.available); setState(result.opened?.state ?? emptyKnowledgeState()); setContext(result.opened?.context); setLibrary(result.opened?.library); setLoading(false); }, error: error => { setLoading(false); errorText(error); } });
    return () => subscription.unsubscribe();
  }, [navigation.libraryId, owner]);
  useEffect(() => { setLibraryName(library?.title ?? ""); }, [library?.id, library?.title]);
  useEffect(() => {
    if (layerState === "exiting") { dialogRef.current?.close(); return; }
    if (modal && !dialogRef.current?.open) { lastFocus.current = document.activeElement as HTMLElement; dialogRef.current?.showModal(); }
    if (!modal && dialogRef.current?.open) { dialogRef.current.close(); if (lastFocus.current?.isConnected) lastFocus.current.focus(); }
    if (modal) dialogRef.current?.querySelector<HTMLInputElement | HTMLTextAreaElement>("input[autofocus], textarea[autofocus], input:not([type=checkbox]), textarea")?.focus();
  }, [modal, layerState]);
  useEffect(() => {
    const dialog = dialogRef.current;
    return () => dialog?.close();
  }, []);
  const creatingTopic = topicTitle !== undefined;
  useEffect(() => {
    if (!creatingTopic) return;
    const frame = window.requestAnimationFrame(() => topicInputRef.current?.focus());
    return () => window.cancelAnimationFrame(frame);
  }, [creatingTopic]);
  const dismiss = () => {
    if (busyRef.current) return;
    if (editing) {
      if (editing.isNew) { if (editing.text.trim() && !window.confirm("放弃尚未保存的新节点？")) return; setEditing(undefined); }
      else { void run(async () => { await knowledgeRepository.saveDraft(editing.context, { ...editing.context, id: editing.command.entity.id + ":" + editing.unit, entityId: editing.command.entity.id, unit: editing.unit, text: editing.text, expectedRevision: editing.command.expected[editing.unit] ?? null }); setEditing(undefined); }); return; }
    }
    if (topicTitle?.trim() && !window.confirm("放弃尚未创建的专题？")) return;
    setTopicTitle(undefined); setPanel(undefined); setPicker(false); setMoveNode(undefined); setSelectedRecords([]); setMessage(""); setFailure(undefined);
  };
  const openPanel = (next: Panel) => { if (editing || busyRef.current) return; setDetailOpen(false); setPanel(next); setMessage(""); setFailure(undefined); setSelectedRecords([]); setTargetWorkspace(workspace?.id ?? topics[0]?.id ?? ""); setTargetNode(selected?.id ?? ""); };
  const beginTopic = () => {
    if (editing || busyRef.current) return;
    topicForSelection.current = panel === "unorganized";
    topicIntent.current = { id: crypto.randomUUID(), ownerScope: owner, sessionGeneration: knowledgeContextGeneration(), context };
    setPanel(undefined); setTopicTitle(""); setFailure(undefined);
  };
  const createTopic = async () => {
    const title = topicTitle?.trim();
    const intent = topicIntent.current;
    if (!title || !intent) return;
    const result = await knowledgeRepository.createTopic(title, intent);
    const fromUnorganized = topicForSelection.current;
    topicForSelection.current = false;
    topicIntent.current = undefined;
    setTopicTitle(undefined);
    if (fromUnorganized) {
      setTargetWorkspace(result.workspaceId);
      setTargetNode("");
      setPanel("unorganized");
      setMessage("专题已创建，请选择目标节点后添加日志。");
    } else { afterClose(() => onNavigation({ libraryId: result.libraryId, workspaceId: result.workspaceId, selectedNodeId: undefined, scrollTop: 0, collapsed: [] }, true)); }
  };
  const goBack = () => {
    if (!modal && !editing && !busyRef.current && workspace) { onNavigation({ workspaceId: undefined, selectedNodeId: undefined, detailsOpen: false, scrollTop: 0 }, true); return; }
    const attempt = new Event("knowledge-back", { cancelable: true }); window.dispatchEvent(attempt);
    if (attempt.defaultPrevented) return;
    if (workspace) onNavigation({ workspaceId: undefined, selectedNodeId: undefined, scrollTop: 0 }, true);
    else onBack();
  };
  useEffect(() => {
    if (layerState === "exiting") return;
    const back = (event: Event) => {
      if (event.defaultPrevented) return;
      if (modal || editing || busyRef.current) { event.preventDefault(); dismiss(); }
      else if (detailOpen) { event.preventDefault(); setDetailOpen(false); }
      else if (selected) { event.preventDefault(); onNavigation({ selectedNodeId: undefined }); }
      else if (workspace) { event.preventDefault(); onNavigation({ workspaceId: undefined, selectedNodeId: undefined, scrollTop: 0 }); }
    };
    const keyboard = (event: KeyboardEvent) => {
      if (event.isComposing) return;
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "f" && !modal && !editing) { event.preventDefault(); openPanel("search"); }
      if (event.key === "Escape" && !modal) { const attempt = new Event("knowledge-back", { cancelable: true }); window.dispatchEvent(attempt); if (attempt.defaultPrevented) event.preventDefault(); }
    };
    const leave = (event: Event) => { if (editing || modal || busyRef.current) { event.preventDefault(); if (!busyRef.current) dismiss(); } };
    const unload = (event: BeforeUnloadEvent) => { if (editing || topicTitle || busyRef.current) { event.preventDefault(); event.returnValue = ""; } };
    window.addEventListener("knowledge-back", back); window.addEventListener("keydown", keyboard); window.addEventListener("knowledge-navigation-leave", leave); window.addEventListener("beforeunload", unload);
    return () => { window.removeEventListener("knowledge-back", back); window.removeEventListener("keydown", keyboard); window.removeEventListener("knowledge-navigation-leave", leave); window.removeEventListener("beforeunload", unload); };
  }, [modal, selected, editing, detailOpen, topicTitle, busy, workspace, layerState]);
  useEffect(() => {
    if (!editing || editing.isNew) return;
    const timer = window.setTimeout(() => { void knowledgeRepository.saveDraft(editing.context, { ...editing.context, id: editing.command.entity.id + ":" + editing.unit, entityId: editing.command.entity.id, unit: editing.unit, text: editing.text, expectedRevision: editing.command.expected[editing.unit] ?? null }).catch(error => errorText(error, "草稿保存")); }, 400);
    return () => window.clearTimeout(timer);
  }, [editing]);
  const beginCreate = (parent = ROOT_NODE) => {
    if (!context || !workspace || busyRef.current || editing) return;
    const command = createKnowledgeEntity(scope, "node", "", workspace.id, parent);
    const last = knowledgeChildren(state, workspace.id, parent).at(-1);
    command.changes.position = { parentNodeId: parent, orderKey: orderBetween(last ? (valueOf(state, last, "position") as KnowledgePosition).orderKey : null, null, command.id) };
    setPanel(undefined); setDetailOpen(false);
    setEditing({ command, unit: "title", text: "", context, label: "新建节点", isNew: true });
  };
  const beginEdit = async (entity: KnowledgeEntity, unit: "title" | "note" | "remark") => {
    if (!context) return;
    const command = editKnowledgeEntity(scope, state, entity, unit, String(valueOf(state, entity, unit) ?? ""));
    const draft = await db.knowledgeDrafts.get([context.libraryId, entity.id + ":" + unit]);
    setPanel(undefined);
    if (draft && window.confirm(draft.expectedRevision === command.expected[unit] ? "发现未提交草稿，是否继续编辑？" : "草稿基线已变化。是否打开原草稿比较？")) setEditing({ command: { ...command, expected: { [unit]: draft.expectedRevision } }, unit, text: draft.text, context, label: "编辑" + (unit === "title" ? "标题" : unit === "note" ? "节点说明" : "引用备注"), isNew: false });
    else setEditing({ command, unit, text: String(valueOf(state, entity, unit) ?? ""), context, label: "编辑" + (unit === "title" ? "标题" : unit === "note" ? "节点说明" : "引用备注"), isNew: false });
  };
  const saveEditing = async () => {
    if (!editing) return;
    await knowledgeRepository.execute(editing.context, { ...editing.command, changes: { ...editing.command.changes, [editing.unit]: editing.unit === "title" ? editing.text.trim() : editing.text } }, editing.command.entity.id + ":" + editing.unit);
    if (editing.command.entity.kind === "node") onNavigation({ selectedNodeId: editing.command.entity.id, collapsed: navigation.collapsed.filter(id => id !== (editing.command.changes.position as KnowledgePosition | undefined)?.parentNodeId) });
    setEditing(undefined);
  };
  const titleEditor: KnowledgeTitleEditor | undefined = inlineEditing && editing ? { entityId: editing.command.entity.id, text: editing.text, isNew: editing.isNew, busy, onChange: text => setEditing({ ...editing, command: { ...editing.command, id: crypto.randomUUID() }, text }), onSave: () => void run(saveEditing), onCancel: dismiss } : undefined;
  const changeLifecycle = (entity: KnowledgeEntity, deleted: boolean) => run(async () => {
    if (!context) return;
    if (deleted && !window.confirm(entity.kind === "reference" ? "移除引用？原日志不删除，备注保留。" : "将此分支移入回收站？原日志不会删除。")) return;
    await knowledgeRepository.execute(context, editKnowledgeEntity(scope, state, entity, "deleted", deleted));
    if (deleted) { setPanel(undefined); setDetailOpen(false); onNavigation({ selectedNodeId: undefined, ...(entity.kind === "workspace" ? { workspaceId: undefined } : {}) }); }
  });
  const trashEntities = useMemo(() => Object.values(state.entities).filter(entity => valueOf(state, entity, "deleted") === true), [state]);
  const archivedEntities = useMemo(() => Object.values(state.entities).filter(entity => valueOf(state, entity, "archived") === true && valueOf(state, entity, "deleted") !== true), [state]);
  const deleteCurrentLibrary = () => {
    if (!context || !library || library.cloudLibraryId) {
      setMessage("账号同步库不支持永久删除。可在专题菜单中删除内容，删除状态会随云同步保留。");
      return;
    }
    if (!window.confirm(`删除本机知识库“${library.title}”？专题和组织关系将永久删除，原日志不会删除。`)) return;
    const next = libraries.find(item => item.id !== library.id);
    void run(async () => {
      await knowledgeRepository.deleteLibrary(context);
      setCreatingLibrary(false);
      afterClose(() => onNavigation({ libraryId: next?.id, workspaceId: undefined, selectedNodeId: undefined, scrollTop: 0 }, true));
    }, "本机知识库已删除；原日志没有受影响。", "删除知识库");
  };
  const purgeTrash = () => {
    if (!context || !library || library.cloudLibraryId) {
      setMessage("账号同步库的回收站会参与云同步，不能单方面清空。");
      return;
    }
    if (!trashEntities.length || !window.confirm("永久清空已删除条目及其下级节点和引用？归档专题和原日志不会删除。")) return;
    void run(async () => {
      const count = await knowledgeRepository.purgeLocalTrash(context);
      setMessage(`已清空本机回收站（${count} 项）；原日志没有受影响。`);
    }, undefined, "清空知识库回收站");
  };
  const move = async (id: string, parentNodeId: string, beforeId?: string) => {
    if (!context) return;
    const entity = state.entities[id];
    if (!entity || !isKnowledgeVisible(state, entity)) return;
    const original = knowledgeChildren(state, entity.workspaceId, parentNodeId);
    const siblings = original.filter(sibling => sibling.id !== id);
    const insert = beforeId ? siblings.findIndex(sibling => sibling.id === beforeId) : siblings.length;
    if (insert < 0) return;
    const position = valueOf(state, entity, "position") as KnowledgePosition;
    if (position.parentNodeId === parentNodeId && original.indexOf(entity) === insert) { setMoveNode(undefined); return; }
    const previous = siblings[insert - 1]; const next = siblings[insert];
    await knowledgeRepository.execute(context, editKnowledgeEntity(scope, state, entity, "position", { parentNodeId, orderKey: orderBetween(previous ? (valueOf(state, previous, "position") as KnowledgePosition).orderKey : null, next ? (valueOf(state, next, "position") as KnowledgePosition).orderKey : null, crypto.randomUUID()) }));
    setMoveNode(undefined);
    onNavigation({ collapsed: navigation.collapsed.filter(nodeId => nodeId !== parentNodeId) });
  };
  const openPicker = () => { setDetailOpen(false); setPanel(undefined); setSelectedRecords(navigation.addRecordId ? [navigation.addRecordId] : []); setPicker(true); };
  const addReferences = async () => {
    if (!context) return;
    let destination = picker ? selected : state.entities[targetNode];
    if (!destination && targetWorkspace) {
      const command = createKnowledgeEntity(scope, "node", "收集的日志", targetWorkspace);
      await knowledgeRepository.execute(context, command);
      destination = { ...command.entity, units: {} };
      setTargetNode(destination.id);
    }
    if (!destination || destination.kind !== "node") return;
    const failures: string[] = [];
    for (const recordId of selectedRecords) {
      try {
        const command = createKnowledgeEntity(scope, "reference", "", destination.workspaceId, ROOT_NODE, recordId, destination.id);
        const existing = state.entities[command.entity.id];
        if (existing && valueOf(state, existing, "deleted") === true) {
          if (!window.confirm("恢复此日志引用并保留旧备注？")) { failures.push(recordId); continue; }
          await knowledgeRepository.execute(context, editKnowledgeEntity(scope, state, existing, "deleted", false));
        } else await knowledgeRepository.execute(context, command);
      } catch (error) { failures.push(recordId); errorText(error, "添加日志"); }
    }
    setSelectedRecords(failures);
    if (!failures.length) { setPicker(false); setPanel(undefined); setDetailOpen(true); onNavigation({ workspaceId: destination.workspaceId, selectedNodeId: destination.id, addRecordId: undefined, detailsOpen: true }); }
    else setMessage("还有 " + failures.length + " 条未添加，选择已保留。");
  };
  const openHit = (hit: KnowledgeHit) => {
    afterClose(() => {
      if (hit.recordId) { const record = recordMap.get(hit.recordId); if (record) onOpenRecord(record); }
      else onNavigation({ workspaceId: hit.workspaceId, selectedNodeId: hit.nodeId, collapsed: [], scrollTop: 0 }, true);
    });
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

  const panelTitle = topicTitle !== undefined ? "新建专题" : editing?.label ?? (picker ? "添加日志" : moveNode ? "移动分支" : ({ search: "搜索", unorganized: "未加入专题的日志", manage: "知识库管理", trash: "回收站与归档", conflicts: "需要处理", menu: "专题与知识库", "node-menu": "节点操作" }[panel ?? "menu"]));
  const feedback = <>{failure && <div className="knowledge-feedback" role="alert"><p>{failure.message}</p><details><summary>诊断信息</summary><pre>{failure.stage + " · " + failure.category + " · " + failure.diagnosticId}</pre></details></div>}{message && <p className="knowledge-message" role="status">{message}</p>}</>;
  const topicForm = topicTitle !== undefined && <form onSubmit={event => { event.preventDefault(); void run(createTopic, "专题已创建"); }}><label>专题名称<input ref={topicInputRef} aria-label="新建专题" onKeyDown={event => { if (event.nativeEvent.isComposing && event.key === "Enter") event.preventDefault(); }} value={topicTitle} onChange={event => setTopicTitle(event.target.value)} /></label><div className="knowledge-dialog-actions"><button className="primary-button" disabled={busy || !topicTitle.trim()}>创建专题</button><button type="button" disabled={busy} onClick={dismiss}>取消</button></div></form>;
  const editingForm = editing && !inlineEditing && <form onSubmit={event => { event.preventDefault(); void run(saveEditing); }}><label>{editing.label}{editing.unit === "title" ? <input autoFocus value={editing.text} onChange={event => setEditing({ ...editing, command: { ...editing.command, id: crypto.randomUUID() }, text: event.target.value })} onKeyDown={event => { if (event.nativeEvent.isComposing && event.key === "Enter") event.preventDefault(); }} /> : <textarea autoFocus rows={6} value={editing.text} onChange={event => setEditing({ ...editing, command: { ...editing.command, id: crypto.randomUUID() }, text: event.target.value })} />}</label><div className="knowledge-dialog-actions"><button className="primary-button" disabled={busy || (editing.unit === "title" && !editing.text.trim())}>保存</button><button type="button" disabled={busy} onClick={dismiss}>稍后继续</button><button type="button" disabled={busy} onClick={() => void run(async () => { await db.knowledgeDrafts.delete([editing.context.libraryId, editing.command.entity.id + ":" + editing.unit]); setEditing(undefined); })}>放弃草稿</button></div></form>;
  const targetControls = <div className="knowledge-add-target"><select aria-label="目标专题" value={targetWorkspace} onChange={event => { setTargetWorkspace(event.target.value); setTargetNode(""); }}><option value="">选择专题</option>{topics.map(topic => <option value={topic.id} key={topic.id}>{knowledgeLabel(state, topic)}</option>)}</select><select aria-label="目标节点" value={targetNode} onChange={event => setTargetNode(event.target.value)} disabled={!targetWorkspace}><option value="">新建收集节点</option>{Object.values(state.entities).filter(entity => entity.kind === "node" && entity.workspaceId === targetWorkspace && isKnowledgeVisible(state, entity)).map(entity => <option value={entity.id} key={entity.id}>{knowledgeLabel(state, entity)}</option>)}</select></div>;
  const resultFooter = picker ? <button className="primary-button" disabled={busy || !selectedRecords.length} onClick={() => void run(addReferences)}>{selectedRecords.length ? "添加所选 " + selectedRecords.length + " 条日志" : "选择日志后添加"}</button> : panel === "unorganized" ? <>{topics.length ? <>{targetControls}<button className="knowledge-new-target" onClick={beginTopic}>新建专题</button></> : <div className="knowledge-no-target"><p>还没有专题。先创建一个，再将所选日志加入。</p><button className="secondary-button" onClick={beginTopic}>新建专题</button></div>}<button className="primary-button" disabled={busy || !selectedRecords.length || !targetWorkspace || !topics.length} onClick={() => void run(addReferences)}>{selectedRecords.length ? "添加所选 " + selectedRecords.length + " 条日志" : "选择日志后添加"}</button></> : undefined;
  return <main className={"page knowledge-library knowledge-shell" + (workspace ? " knowledge-editor" : "")} aria-busy={busy || loading}>
    <header className="knowledge-header">
      <button className="knowledge-icon" aria-label="返回" onClick={goBack}><ArrowLeft size={20} /></button>
      <h1>{workspace ? knowledgeLabel(state, workspace) : "知识库"}</h1>
      {workspace && <div className="knowledge-view-switch" role="group" aria-label="专题视图"><button disabled={Boolean(editing)} aria-pressed={navigation.view === "outline"} onClick={() => onNavigation({ view: "outline" })}><List size={16} />大纲</button><button disabled={Boolean(editing)} aria-pressed={navigation.view === "map"} onClick={() => onNavigation({ view: "map" })}><GitBranch size={16} />导图</button></div>}
      <div className="knowledge-header-actions"><button className="knowledge-icon" disabled={Boolean(editing)} aria-label="查找" onClick={() => openPanel("search")}><Search size={20} /></button><button className="knowledge-icon" disabled={Boolean(editing)} aria-label="更多知识库操作" onClick={() => openPanel("menu")}><MoreHorizontal size={22} /></button></div>
    </header>
    {!modal && feedback}
    {loading ? <p role="status">正在读取…</p> : !workspace ? <section className="knowledge-home"><div className="knowledge-home-actions">{library && <button className="knowledge-library-switch" onClick={() => openPanel("manage")}><span>当前库：{library.title}</span><ChevronRight size={16} /></button>}{!!topics.length && <button className="primary-button" onClick={beginTopic}><Plus size={17} />新建专题</button>}</div>{!topics.length ? <div className="knowledge-empty"><BookOpen size={34} strokeWidth={1.4} /><h2>从一个专题开始</h2><button className="primary-button" onClick={beginTopic}>创建第一个专题</button></div> : <div className="knowledge-topics">{topics.map(topic => <button className="knowledge-topic" key={topic.id} onClick={() => onNavigation({ libraryId: library?.id, workspaceId: topic.id, selectedNodeId: undefined, scrollTop: 0, collapsed: [] }, true)}><BookOpen size={20} /><strong>{knowledgeLabel(state, topic)}</strong><ChevronRight size={17} /></button>)}</div>}</section> : <>
      <div className="knowledge-workspace">
        {navigation.view === "outline" ? <KnowledgeOutline records={recordMap} onOpenRecord={onOpenRecord} state={state} workspaceId={workspace.id} navigation={navigation} editor={titleEditor} onSelect={id => { if (!editing) onNavigation({ selectedNodeId: id, detailsOpen: true }); }} onEdit={id => { if (!editing) void run(() => beginEdit(state.entities[id], "title")); }} onCreate={beginCreate} onOutdent={id => { const position = valueOf(state, state.entities[id], "position") as KnowledgePosition; if (position.parentNodeId === ROOT_NODE) return; const parent = state.entities[position.parentNodeId]; void run(() => move(id, (valueOf(state, parent, "position") as KnowledgePosition).parentNodeId)); }} onToggle={id => onNavigation({ collapsed: navigation.collapsed.includes(id) ? navigation.collapsed.filter(item => item !== id) : [...navigation.collapsed, id] })} onScrollPosition={scrollTop => onNavigation({ scrollTop })} /> : <><KnowledgeMap key={workspace.id} onClear={() => { if (!editing) onNavigation({ selectedNodeId: undefined, detailsOpen: false }); }} state={state} workspaceId={workspace.id} navigation={navigation} organizing={!editing} editor={titleEditor} onEdit={id => { setDetailOpen(false); void run(() => beginEdit(state.entities[id], "title")); }} onNavigation={onNavigation} onSelect={id => { if (!editing) onNavigation({ selectedNodeId: id, detailsOpen: true }); }} onToggle={id => onNavigation({ collapsed: navigation.collapsed.includes(id) ? navigation.collapsed.filter(item => item !== id) : [...navigation.collapsed, id] })} onMove={(id, parent, beforeId) => void run(() => move(id, parent, beforeId))} />{titleEditor?.isNew && <div className="knowledge-map-new"><KnowledgeTitleInput editor={titleEditor} label="新建节点" /></div>}</>}
        {detailOpen && selected && !modal && !editing && <KnowledgeDetails state={state} node={selected} references={references} records={recordMap} onClose={() => setDetailOpen(false)} onAdd={openPicker} onOpen={onOpenRecord} onNote={() => void run(() => beginEdit(selected, "note"))} onRemark={reference => void run(() => beginEdit(reference, "remark"))} onRemove={reference => void changeLifecycle(reference, true)} />}
      </div>
      <footer className="knowledge-contextbar">{selected ? <><span className="knowledge-selection-title">{knowledgeLabel(state, selected)}</span><button disabled={Boolean(editing)} onClick={() => beginCreate(selected.id)}><Plus size={16} />子节点</button>{!detailOpen && <button disabled={Boolean(editing)} onClick={openPicker}>添加日志</button>}<button className="knowledge-icon" disabled={Boolean(editing)} aria-label="更多节点操作" onClick={() => openPanel("node-menu")}><MoreHorizontal size={20} /></button></> : <button disabled={Boolean(editing)} onClick={() => beginCreate()}><Plus size={17} />添加节点</button>}<span className="knowledge-save-state" role="status">{busy ? "保存中…" : library?.cloudLibraryId ? "账号同步库" : "本机保存"}</span></footer>
    </>}
    <dialog className={"knowledge-dialog knowledge-library" + ((panel === "search" || panel === "unorganized" || picker) ? " knowledge-search-dialog" : "")} ref={dialogRef} onCancel={event => { event.preventDefault(); dismiss(); }} aria-label={panelTitle}>
      <div className="knowledge-panel-heading"><h2>{panelTitle}</h2><button className="knowledge-icon" aria-label="关闭操作窗口" disabled={busy} onClick={dismiss}><X size={20} /></button></div>
      {modal && feedback}
      {topicForm}
      {editingForm}
      {(panel === "search" || panel === "unorganized" || picker) && <KnowledgeResults key={picker ? "picker" : panel} state={state} records={records} assets={assets} workspaceId={workspace?.id} mode={picker ? "picker" : panel === "unorganized" ? "unorganized" : "search"} selected={selectedRecords} onSelected={setSelectedRecords} onOpen={openHit} footer={resultFooter} />}
      {moveNode && <><label>移动到<select value={moveTarget} onChange={event => setMoveTarget(event.target.value)}><option value={ROOT_NODE}>专题根分支</option>{Object.values(state.entities).filter(entity => entity.kind === "node" && entity.workspaceId === workspace?.id && entity.id !== moveNode && isKnowledgeVisible(state, entity)).map(entity => <option key={entity.id} value={entity.id}>{knowledgeLabel(state, entity)}</option>)}</select></label><div className="knowledge-dialog-actions"><button className="primary-button" disabled={busy} onClick={() => void run(() => move(moveNode, moveTarget))}>确认移动</button></div></>}
      {panel === "menu" && <div className="knowledge-menu">{workspace && <><button onClick={() => { afterClose(() => onNavigation({ workspaceId: undefined, selectedNodeId: undefined, scrollTop: 0 }, true)); }}>全部专题</button><button onClick={() => void run(() => beginEdit(workspace, "title"))}>重命名专题</button><button onClick={() => void run(() => beginEdit(workspace, "note"))}>专题说明</button></>}<button onClick={() => openPanel("unorganized")}>未加入专题的日志</button><button onClick={() => openPanel("manage")}>知识库管理</button><button onClick={() => openPanel("trash")}>回收站与归档</button>{!!(conflicts.length + blockedCommands.length) && <button onClick={() => openPanel("conflicts")}>需要处理 · {conflicts.length + blockedCommands.length}</button>}{workspace && <details><summary>归档与删除</summary><button onClick={() => void run(async () => { if (context && window.confirm("归档此专题？可从归档列表恢复。")) { await knowledgeRepository.execute(context, editKnowledgeEntity(scope, state, workspace, "archived", true)); setPanel(undefined); onNavigation({ workspaceId: undefined, selectedNodeId: undefined }); } })}>归档专题</button><button onClick={() => void changeLifecycle(workspace, true)}>删除专题</button></details>}</div>}
      {panel === "node-menu" && selected && <div className="knowledge-menu"><button onClick={() => beginCreate((valueOf(state, selected, "position") as KnowledgePosition).parentNodeId)}>添加同级节点</button><button onClick={() => void run(() => beginEdit(selected, "title"))}>编辑标题</button><button onClick={() => void run(() => beginEdit(selected, "note"))}>编辑说明</button><button onClick={() => { setPanel(undefined); setMoveNode(selected.id); setMoveTarget(ROOT_NODE); }}>移动到</button><button onClick={() => void changeLifecycle(selected, true)}>删除分支</button></div>}
      {panel === "manage" && <section className="knowledge-panel knowledge-management"><p>各库独立保存。可切换查看，再重命名或删除。</p><div className="knowledge-library-list" aria-label="知识库列表">{libraries.map(item => <button key={item.id} className={item.id === library?.id ? "selected" : ""} aria-pressed={item.id === library?.id} onClick={() => { if (item.id !== library?.id) { afterClose(() => onNavigation({ libraryId: item.id, workspaceId: undefined, selectedNodeId: undefined }, true)); setCreatingLibrary(false); } }}><span><strong>{item.title}</strong><small>{item.detached ? "恢复副本" : item.cloudLibraryId ? "账号同步库" : "本机库"} · ID {item.id.slice(-6)}</small></span><ChevronRight size={16} /></button>)}</div><form onSubmit={event => { event.preventDefault(); const name = libraryName.trim(); if (!name) return; if (libraries.some(item => item.title === name && (creatingLibrary || item.id !== library?.id))) { setMessage("已有同名知识库，请换一个名称。"); return; } void run(async () => { if (creatingLibrary) { const created = await knowledgeRepository.createNamedLibrary(name, libraryIntent.current, libraryOwner.current.owner, libraryOwner.current.generation); setCreatingLibrary(false); afterClose(() => onNavigation({ libraryId: created.id, workspaceId: undefined, selectedNodeId: undefined }, true)); } else if (context) await knowledgeRepository.renameLibrary(context, name); }, "知识库名称已保存", "保存知识库"); }}><label>{creatingLibrary ? "新知识库名称" : "当前库名称"}<input value={libraryName} aria-label="知识库名称" onChange={event => setLibraryName(event.target.value)} autoFocus={creatingLibrary} /></label><div className="knowledge-dialog-actions"><button className="primary-button" disabled={busy || !libraryName.trim() || (!creatingLibrary && !library)}>{creatingLibrary ? "创建独立库" : "保存名称"}</button><button type="button" disabled={busy} onClick={() => { libraryIntent.current = crypto.randomUUID(); libraryOwner.current = { owner: currentKnowledgeOwner(), generation: knowledgeContextGeneration() }; setCreatingLibrary(true); setLibraryName(""); }}>新建独立知识库</button></div></form><div className="knowledge-management-actions"><button className="danger" type="button" disabled={busy || !library || Boolean(library?.cloudLibraryId)} onClick={deleteCurrentLibrary}>删除本机库</button><p>{library?.cloudLibraryId ? "账号同步库保留删除状态供其他设备同步，不支持在此永久删除。" : "删除仅影响本库的专题与引用，原日志保留。"}</p></div><p className="knowledge-management-note">云同步由应用顶部统一处理；本机库不会自动上传。</p></section>}
      {panel === "trash" && <section className="knowledge-panel knowledge-trash-panel"><p>{library?.cloudLibraryId ? "删除、恢复和归档状态会随全局云同步保留，因此账号同步库不支持单方面永久清空。" : "清空仅删除已删除条目及其下级节点和引用，不删除归档专题或原日志。"}</p><div className="knowledge-toolbar"><strong>已删除 · {trashEntities.length}</strong><button className="danger" type="button" disabled={busy || !trashEntities.length || Boolean(library?.cloudLibraryId)} onClick={purgeTrash}>清空本机回收站</button></div>{!trashEntities.length ? <p className="knowledge-muted">回收站为空。</p> : trashEntities.map(entity => <div className="knowledge-trash-row" key={entity.id}><span>{knowledgeLabel(state, entity)}</span><button disabled={busy} onClick={() => void changeLifecycle(entity, false)}>恢复条目</button></div>)}{!!archivedEntities.length && <><h3>已归档 · {archivedEntities.length}</h3>{archivedEntities.map(entity => <div className="knowledge-trash-row" key={entity.id}><span>{knowledgeLabel(state, entity)}</span><button disabled={busy} onClick={() => void run(async () => { if (context) await knowledgeRepository.execute(context, editKnowledgeEntity(scope, state, entity, "archived", false)); })}>取消归档</button></div>)}</>}</section>}
      {panel === "conflicts" && <><section className="knowledge-panel"><h2>待处理版本</h2><p>每批最多选择同一字段的四个候选；未选版本不会被处理。结构冲突本批保留当前位置，另行显式移动。</p>{candidates.slice(candidatePage * 20, candidatePage * 20 + 20).map(candidate => { const revision = state.revisions[candidate.revisionId]; return <label className="knowledge-candidate" key={candidate.id}><input type="checkbox" checked={selectedCandidates.includes(candidate.id)} onChange={event => { if (event.target.checked) { if (selectedCandidates.length >= 4 || (selectedCandidates.length && state.candidates[selectedCandidates[0]]?.groupId !== candidate.groupId)) { setMessage("每批请选择同一字段的最多四份候选。"); return; } if (!selectedCandidates.length && context) { const group = state.groups[candidate.groupId]; const current = state.revisions[group.currentRevisionId]; const command = editKnowledgeEntity(scope, state, state.entities[current.entityId], current.unit, revisionValue(state, current.id)!); command.operation = "resolve"; command.resolution = { unit: current.unit, setToken: group.setToken, generation: group.generation, candidates: [] }; setResolutionBaseline({ command, context }); setResolutionText(String(revisionValue(state, current.id) ?? "")); } setSelectedCandidates([...selectedCandidates, candidate.id]); } else setSelectedCandidates(selectedCandidates.filter(id => id !== candidate.id)); }} /><span>{knowledgeLabel(state, state.entities[revision.entityId])} · {revision.unit}<pre>{typeof revision.value === "string" ? revision.value : JSON.stringify(revision.value)}</pre></span></label>; })}<textarea aria-label="冲突合并结果" placeholder="填写本批合并后的文字；可以保留原文或合并说明" value={resolutionText} onChange={event => setResolutionText(event.target.value)} /><div className="knowledge-toolbar"><button className="primary-button" disabled={busy || !selectedCandidates.length} onClick={() => void run(resolveSelected, "本批已处理；未选候选仍保留")}>处理所选候选</button><button disabled={candidatePage === 0} onClick={() => setCandidatePage(candidatePage - 1)}>上一页</button><button disabled={(candidatePage + 1) * 20 >= candidates.length} onClick={() => setCandidatePage(candidatePage + 1)}>下一页</button><span>剩余 {candidates.length} 份候选</span></div></section>{!!blockedCommands.length && <section className="knowledge-panel"><h2>需要重新确认的本机操作</h2><p>同步基线已变化。这些操作未覆盖云端，原始意图与版本保留；其他条目仍可同步。</p>{blockedCommands.map(entry => <article key={entry.id}><p>{entry.command.operation} · {knowledgeLabel(state, state.entities[entry.command.entity.id])}</p><pre>{JSON.stringify(entry.command.changes)}</pre><button disabled={busy} onClick={() => { const entity = state.entities[entry.command.entity.id]; if (entity) { onNavigation({ workspaceId: entity.workspaceId, selectedNodeId: entity.kind === "node" ? entity.id : entity.nodeId || undefined }, true); setPanel("trash"); setMessage("请基于当前内容重新确认恢复或冲突处理。旧意图保留，未自动重试。"); } }}>查看当前内容</button>{entry.recoveryLibraryId && <button disabled={busy} onClick={() => onNavigation({ libraryId: entry.recoveryLibraryId, workspaceId: undefined, selectedNodeId: undefined }, true)}>打开完整保留副本</button>}<button disabled={busy || !context} onClick={() => void run(async () => { if (context && window.confirm("确认不再自动重试此旧操作？完整本机内容仍在保留副本中，可另存回账号库。")) await knowledgeRepository.acknowledgeBlocked(context, entry.id, entry.hash); })}>确认保留副本并结束旧操作</button></article>)}</section>}</>}
    </dialog>
  </main>;
};
