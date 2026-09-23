import { liveQuery } from "dexie";
import { BookPlus } from "lucide-react";
import { useEffect, useState } from "react";
import { formatUiError } from "../../lib/uiError";
import { knowledgeRepository } from "./runtime";
import { currentKnowledgeOwner } from "./context";
import { knowledgeBacklinks, knowledgeLabel } from "./query";

export interface KnowledgeRecordLocation { libraryId: string; workspaceId: string; selectedNodeId: string }
export const KnowledgeRecordLinks = ({ recordId, onOpen, menu = false }: { recordId: string; onOpen: (location?: KnowledgeRecordLocation) => void; menu?: boolean }) => {
  const [links, setLinks] = useState<Array<KnowledgeRecordLocation & { title: string }>>([]);
  const [error, setError] = useState("");
  const owner = currentKnowledgeOwner();
  useEffect(() => {
    const subscription = liveQuery(async () => {
      const result: Array<KnowledgeRecordLocation & { title: string }> = [];
      for (const library of await knowledgeRepository.listLibraries()) {
        const { state } = await knowledgeRepository.open(library.id);
        for (const reference of knowledgeBacklinks(state, recordId)) result.push({ libraryId: library.id, workspaceId: reference.workspaceId, selectedNodeId: reference.nodeId, title: knowledgeLabel(state, state.entities[reference.workspaceId]) + " / " + knowledgeLabel(state, state.entities[reference.nodeId]) });
      }
      return result;
    }).subscribe({ next: setLinks, error: failure => setError(formatUiError(failure, "generic")) });
    return () => subscription.unsubscribe();
  }, [recordId, owner]);
  if (menu) return <section className="record-knowledge-menu" aria-label="知识专题操作"><button type="button" onClick={() => onOpen()}><BookPlus size={16} />加入专题</button>{!!links.length && <details><summary>所属专题 · {links.length}</summary><div>{links.map(link => <button key={link.libraryId + ":" + link.selectedNodeId} type="button" onClick={() => onOpen(link)}>{link.title}</button>)}</div></details>}{error && <p className="record-knowledge-menu-error" role="status">{error}</p>}</section>;
  return <section aria-label="所属知识专题" className="record-knowledge-links"><button type="button" className="secondary-button" onClick={() => onOpen()}>加入专题</button>{links.map(link => <button key={link.libraryId + ":" + link.selectedNodeId} type="button" className="subtle-button" onClick={() => onOpen(link)}>{link.title}</button>)}{error && <p role="status">{error}</p>}</section>;
};
