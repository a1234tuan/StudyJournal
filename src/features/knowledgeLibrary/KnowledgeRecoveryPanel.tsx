import { useEffect, useState } from "react";
import { liveQuery } from "dexie";
import { db } from "../../db/database";
import type { KnowledgeDraft, KnowledgeLibrary } from "./domain";
import { knowledgeUiError } from "./uiError";

export const KnowledgeRecoveryPanel = ({ libraries, onOpen }: { libraries: KnowledgeLibrary[]; onOpen: (id: string) => void }) => {
  const [drafts, setDrafts] = useState<KnowledgeDraft[]>([]);
  const [message, setMessage] = useState("");
  useEffect(() => {
    if (!libraries.length) { setDrafts([]); return; }
    const subscription = liveQuery(() => db.knowledgeDrafts.where("libraryId").anyOf(libraries.map(library => library.id)).toArray()).subscribe({ next: setDrafts, error: error => setMessage(knowledgeUiError(error, "读取保留草稿").message) });
    return () => subscription.unsubscribe();
  }, [libraries]);
  if (!libraries.length) return null;
  return <details className="knowledge-recovery"><summary>恢复管理 · {libraries.length} 份保留内容</summary>
    <p>这里保留旧内容和恢复副本，不会重复上传。日常编辑请使用默认知识库。</p>
    {libraries.map(library => <div key={library.id}>
      <button type="button" onClick={() => onOpen(library.id)}>查看保留内容：{library.title}</button>
      {drafts.filter(draft => draft.libraryId === library.id).map(draft => <details key={draft.id}><summary>未提交草稿</summary><textarea aria-label="保留的草稿" readOnly value={draft.text} rows={4} /><button type="button" onClick={() => { void Promise.resolve().then(() => navigator.clipboard.writeText(draft.text)).then(() => setMessage("草稿已复制，可回到知识库粘贴并保存。"), () => setMessage("请在文本框内选择并复制草稿。")); }}>复制草稿</button></details>)}
    </div>)}
    {message && <p role="status">{message}</p>}
  </details>;
};
