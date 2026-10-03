import type { RecordBlock, Subject } from "../../types";
import { createKnowledgeEntity } from "./commands";
import { KnowledgeError, ROOT_NODE, type KnowledgeContext } from "./domain";
import { isKnowledgeVisible, valueOf } from "./protocol";
import type { KnowledgeRepository } from "./repository";

export interface KnowledgeRecordTarget {
  context: KnowledgeContext;
  workspaceId: string;
  nodeId: string;
}

export const createKnowledgeRecordAttempt = (
  repository: KnowledgeRepository,
  target: KnowledgeRecordTarget,
  createRecord: (subject: Subject) => Promise<RecordBlock>,
) => {
  let record: RecordBlock | undefined;
  let pending: Promise<RecordBlock> | undefined;
  const assertTarget = async () => {
    await repository.assertContext(target.context);
    await repository.assertWritable(target.context.libraryId);
    const opened = await repository.open(target.context.libraryId);
    const node = opened.state.entities[target.nodeId];
    const workspace = opened.state.entities[target.workspaceId];
    if (!node || node.kind !== "node" || node.workspaceId !== target.workspaceId
      || !isKnowledgeVisible(opened.state, node) || !workspace
      || !isKnowledgeVisible(opened.state, workspace) || valueOf(opened.state, workspace, "archived") === true) {
      throw new KnowledgeError("stale", "目标节点已不可用，请重新选择节点。");
    }
    return opened;
  };
  const create = (subject: Subject): Promise<RecordBlock> => {
    if (pending) return pending;
    pending = (async () => {
      await assertTarget();
      record ??= await createRecord(subject);
      const opened = await assertTarget();
      const command = createKnowledgeEntity(opened.library.cloudLibraryId ?? opened.library.id, "reference", "", target.workspaceId, ROOT_NODE, record.id, target.nodeId);
      await repository.execute(target.context, command, undefined, undefined, async () => { await assertTarget(); });
      return record;
    })().finally(() => { pending = undefined; });
    return pending;
  };
  return { create, get record() { return record; } };
};
