import { knowledgeHash, referenceIdentity } from "./canonical";
import { createKnowledgeEntity, editKnowledgeEntity } from "./commands";
import { emptyKnowledgeState, KnowledgeError, ROOT_NODE, type KnowledgeCommand, type KnowledgeContext, type KnowledgeEntity, type KnowledgePosition, type KnowledgeState } from "./domain";
import { applyKnowledgeCommand, revisionValue, valueOf } from "./protocol";
import { KnowledgeRepository, knowledgeTables, readKnowledgeState } from "./repository";

export const prepareKnowledgeImport = async (repository: KnowledgeRepository, sourceLibraryId: string, target: KnowledgeContext, sessionId: string): Promise<void> => {
  const database = repository.database;
  await database.transaction("rw", knowledgeTables(database), async () => {
    const { library, sync } = await repository.assertContext(target);
    if (sourceLibraryId === target.libraryId) throw new KnowledgeError("invalid", "不能把知识库另存到自身");
    if (sync.importSessions?.[sessionId]) return;
    const source = await database.knowledgeLibraries.get(sourceLibraryId);
    const sourceSync = await database.knowledgeSyncState.get(sourceLibraryId);
    if (!source || !sourceSync || ![target.ownerScope, "deviceGuest"].includes(source.ownerScope)) throw new KnowledgeError("scope", "另存来源不属于当前身份或未认领访客");
    const sourceState = await readKnowledgeState(database, sourceLibraryId);
    const scope = library.cloudLibraryId ?? library.id;
    const remap = new Map<string, string>();
    const commands: KnowledgeCommand[] = [];
    let projected = emptyKnowledgeState();
    const append = (command: KnowledgeCommand) => { projected = applyKnowledgeCommand(projected, command); commands.push(command); };
    const ordered: KnowledgeEntity[] = Object.values(sourceState.entities).filter(entity => entity.kind === "workspace");
    const waiting = Object.values(sourceState.entities).filter(entity => entity.kind === "node");
    const included = new Set(ordered.map(entity => entity.id));
    while (waiting.length) {
      const next = waiting.findIndex(entity => { const parent = (valueOf(sourceState, entity, "position") as KnowledgePosition).parentNodeId; return parent === ROOT_NODE || included.has(parent); });
      if (next < 0) throw new KnowledgeError("cycle", "来源分支不完整或有环");
      const entity = waiting.splice(next, 1)[0]; ordered.push(entity); included.add(entity.id);
    }
    ordered.push(...Object.values(sourceState.entities).filter(entity => entity.kind === "reference"));
    for (const entity of ordered) {
      const id = "copy-" + knowledgeHash({ sessionId, sourceId: entity.id });
      remap.set(entity.id, entity.kind === "reference" ? referenceIdentity(remap.get(entity.nodeId)!, entity.recordId) : id);
      const position = entity.kind === "node" ? valueOf(sourceState, entity, "position") as KnowledgePosition : undefined;
      const command = createKnowledgeEntity(scope, entity.kind, entity.kind === "reference" ? "" : String(valueOf(sourceState, entity, "title")), remap.get(entity.workspaceId), position?.parentNodeId === ROOT_NODE ? ROOT_NODE : remap.get(position?.parentNodeId ?? "") ?? ROOT_NODE, entity.recordId, entity.kind === "reference" ? remap.get(entity.nodeId)! : "");
      command.id = "import-" + knowledgeHash({ sessionId, entityId: entity.id, step: "create" });
      command.entity.id = remap.get(entity.id)!;
      command.entity.workspaceId = remap.get(entity.workspaceId)!;
      if (position) command.changes.position = { parentNodeId: position.parentNodeId === ROOT_NODE ? ROOT_NODE : remap.get(position.parentNodeId)!, orderKey: position.orderKey };
      append(command);
      const textUnit = entity.kind === "reference" ? "remark" : "note";
      const currentText = String(valueOf(sourceState, entity, textUnit) ?? "");
      if (currentText) { const edit = editKnowledgeEntity(scope, projected, projected.entities[command.entity.id], textUnit, currentText); edit.id = "import-" + knowledgeHash({ sessionId, entityId: entity.id, step: "text" }); append(edit); }
    }
    for (const entity of ordered) {
      for (const candidate of Object.values(sourceState.candidates).filter(item => item.consumedBy === null && sourceState.revisions[item.revisionId].entityId === entity.id)) {
        const revision = sourceState.revisions[candidate.revisionId];
        const candidateValue = revisionValue(sourceState, revision.id)!;
        const value = revision.unit === "position" ? { ...(candidateValue as KnowledgePosition), parentNodeId: (candidateValue as KnowledgePosition).parentNodeId === ROOT_NODE ? ROOT_NODE : remap.get((candidateValue as KnowledgePosition).parentNodeId)! } : candidateValue;
        const edit = editKnowledgeEntity(scope, projected, projected.entities[remap.get(entity.id)!], revision.unit, value);
        edit.id = "import-" + knowledgeHash({ sessionId, candidateId: candidate.id });
        edit.expected[revision.unit] = null;
        append(edit);
      }
    }
    for (const entity of ordered) {
      const targetEntity = projected.entities[remap.get(entity.id)!];
      for (const unit of ["archived", "deleted"] as const) {
        if (valueOf(sourceState, entity, unit) !== true) continue;
        const lifecycle = editKnowledgeEntity(scope, projected, targetEntity, unit, true);
        lifecycle.id = "import-" + knowledgeHash({ sessionId, entityId: entity.id, step: unit }); append(lifecycle);
      }
    }
    await database.knowledgeSyncState.put({ ...sync, importSessions: { ...sync.importSessions, [sessionId]: { id: sessionId, sourceLibraryId, sourceGeneration: sourceSync.dataGeneration, sourceHash: knowledgeHash(sourceState), next: 0, commands } } });
  });
};
export const resumeKnowledgeImport = async (repository: KnowledgeRepository, context: KnowledgeContext, sessionId: string, onProgress?: (completed: number, total: number) => void): Promise<void> => {
  while (true) {
    const { sync } = await repository.assertContext(context);
    const session = sync.importSessions?.[sessionId];
    if (!session) throw new KnowledgeError("missing", "另存会话不存在");
    onProgress?.(session.next, session.commands.length);
    if (session.next >= session.commands.length) return;
    await repository.execute(context, session.commands[session.next], undefined, sessionId);
  }
};
