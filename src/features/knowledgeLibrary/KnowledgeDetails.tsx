import { ChevronRight, FileText, MoreHorizontal, Plus, X } from "lucide-react";
import type { RecordBlock } from "../../types";
import type { KnowledgeEntity, KnowledgeState } from "./domain";
import { knowledgeLabel } from "./query";
import { valueOf } from "./protocol";

interface Props {
  state: KnowledgeState; node: KnowledgeEntity; references: KnowledgeEntity[]; records: ReadonlyMap<string, RecordBlock>;
  onClose: () => void; onAdd: () => void; onOpen: (record: RecordBlock) => void;
  onNote: () => void; onRemark: (reference: KnowledgeEntity) => void; onRemove: (reference: KnowledgeEntity) => void;
}
export function KnowledgeDetails({ state, node, references, records, onClose, onAdd, onOpen, onNote, onRemark, onRemove }: Props) {
  const note = String(valueOf(state, node, "note") || "");
  return <aside className="knowledge-detail" aria-label="节点详情">
    <div className="knowledge-panel-heading"><h2>{knowledgeLabel(state, node)}</h2><button className="knowledge-icon" aria-label="关闭节点详情" onClick={onClose}><X size={18} /></button></div>
    <div className="knowledge-detail-section-heading"><span>关联日志 · {references.length}</span><button onClick={onAdd}><Plus size={14} />添加日志</button></div>
    <div className="knowledge-reference-list">{references.map(reference => {
      const record = records.get(reference.recordId);
      const remark = String(valueOf(state, reference, "remark") || "");
      return <article className="knowledge-reference" key={reference.id}>
        <div className="knowledge-reference-heading"><button className="knowledge-reference-link" aria-label={record?.title || "原日志暂不可用"} disabled={!record || Boolean(record.deletedAt)} onClick={() => record && onOpen(record)}><FileText size={16} /><span><strong>{record?.title || "原日志暂不可用"}</strong><small>{!record ? "等待原日志同步" : record.deletedAt ? "原日志在回收站" : [record.subject, record.date].filter(Boolean).join(" · ")}</small></span><ChevronRight size={14} /></button>
          <details className="knowledge-reference-menu" onToggle={event => { const current = event.currentTarget; if (current.open) current.closest(".knowledge-reference-list")?.querySelectorAll<HTMLDetailsElement>(".knowledge-reference-menu[open]").forEach(menu => { if (menu !== current) menu.open = false; }); }}><summary aria-label={"引用操作：" + (record?.title || "暂不可用")}><MoreHorizontal size={17} /></summary><div><button onClick={event => { event.currentTarget.closest("details")!.open = false; onRemark(reference); }}>编辑备注</button><button className="knowledge-remove-reference" onClick={event => { event.currentTarget.closest("details")!.open = false; onRemove(reference); }}>移除引用</button></div></details>
        </div>
        {remark && <details className="knowledge-reference-remark"><summary>{remark.length > 60 ? remark.slice(0, 60) + "…" : remark}</summary><p>{remark}</p></details>}
      </article>;
    })}</div>
    {!references.length && <p className="knowledge-detail-empty">还没有关联日志</p>}
    <details className="knowledge-node-note" key={node.id}><summary>节点说明{!note && <small>未填写</small>}</summary>{note && <p>{note}</p>}<button onClick={onNote}>{note ? "编辑说明" : "添加说明"}</button></details>
  </aside>;
}
