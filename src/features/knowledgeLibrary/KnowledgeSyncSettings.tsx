import { liveQuery } from "dexie";
import { useEffect, useRef, useState } from "react";
import { db } from "../../db/database";
import { currentKnowledgeOwner } from "./context";
import type { KnowledgeLibrary } from "./domain";
import { prepareKnowledgeImport, resumeKnowledgeImport } from "./import";
import { knowledgeRepository, knowledgeSynchronizer } from "./runtime";
import { knowledgeUiError } from "./uiError";
import "./knowledgeLibrary.css";

export default function KnowledgeSyncSettings({ uid, disabled }: { uid: string; disabled: boolean }) {
  const [libraries, setLibraries] = useState<KnowledgeLibrary[]>([]);
  const [sourceId, setSourceId] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const sources = libraries.filter(library => !library.cloudLibraryId);
  const connected = libraries.some(library => library.ownerScope === "account:" + uid && library.cloudLibraryId);
  useEffect(() => {
    const subscription = liveQuery(() => db.knowledgeLibraries.where("ownerScope").anyOf(["account:" + uid, "deviceGuest"]).toArray()).subscribe({
      next: setLibraries,
      error: error => setMessage(knowledgeUiError(error, "读取知识库").message),
    });
    return () => subscription.unsubscribe();
  }, [uid]);
  const copy = async () => {
    if (busyRef.current || disabled) return;
    const source = sources.find(library => library.id === sourceId);
    if (!source || !window.confirm("将“" + source.title + "”复制到当前账号知识库？下次云同步会上传这份副本；原本机库保留且不会自动合并后续编辑。")) return;
    busyRef.current = true; setBusy(true); setMessage("");
    try {
      const sync = knowledgeSynchronizer();
      if (!sync || currentKnowledgeOwner() !== "account:" + uid) { setMessage("账号已变化，请重新打开云同步设置。"); return; }
      const { library } = await sync.connect();
      const target = await knowledgeRepository.open(library.id);
      const sessions = (await knowledgeRepository.assertContext(target.context)).sync.importSessions;
      const active = Object.values(sessions ?? {}).find(session => session.sourceLibraryId === sourceId && session.next < session.commands.length);
      const sessionId = active?.id ?? crypto.randomUUID();
      await prepareKnowledgeImport(knowledgeRepository, sourceId, target.context, sessionId);
      await resumeKnowledgeImport(knowledgeRepository, target.context, sessionId);
      setMessage("副本已保存到账号知识库。点击本页的云同步即可上传，原本机库保持不变。");
    } catch (error) { setMessage(knowledgeUiError(error, "复制到账号知识库").message); }
    finally { busyRef.current = false; setBusy(false); }
  };
  return <div className="knowledge-library knowledge-cloud-settings">
    <p>{connected ? "账号知识库随本页和首页的云同步一起同步。" : "点击本页或首页的云同步，会自动连接账号知识库。"}</p>
    {!!sources.length && <><p>本机独立库不会擅自上传。需要同步时，选择一份复制到账号库。</p>
      <label>来源本机库<select aria-label="复制来源知识库" value={sourceId} disabled={busy || disabled} onChange={event => setSourceId(event.target.value)}><option value="">选择本机库</option>{sources.map(source => <option key={source.id} value={source.id}>{source.title} · {source.id.slice(-6)}{source.ownerScope === "deviceGuest" ? " · 未登录时创建" : ""}</option>)}</select></label>
      <button className="secondary-button" disabled={busy || disabled || !sourceId} onClick={() => void copy()}>{busy ? "正在复制…" : "复制 / 继续复制到账号库"}</button>
    </>}
    {message && <p role="status">{message}</p>}
  </div>;
}
