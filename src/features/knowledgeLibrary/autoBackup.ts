import { db } from "../../db/database";
import { assertKnowledgeOwner, currentKnowledgeOwner, knowledgeContextGeneration } from "./context";
import { KnowledgeError } from "./domain";
import { initialKnowledgeScope, knowledgeTables } from "./repository";
import { acknowledgeKnowledgeBackup, captureKnowledgeBackupScope, type KnowledgeBackupToken } from "./scope";

export const authorizeKnowledgeBackup = async (): Promise<void> => {
  const owner = currentKnowledgeOwner();
  const generation = knowledgeContextGeneration();
  await db.transaction("rw", knowledgeTables(db), async () => {
    assertKnowledgeOwner(owner, generation);
    const scope = await db.knowledgeBackupScopes.get(owner) ?? initialKnowledgeScope(owner);
    for (const other of await db.knowledgeBackupScopes.toArray()) {
      if (other.ownerScope !== owner && other.consented) await db.knowledgeBackupScopes.put({ ...other, consented: false, scopeEpoch: other.scopeEpoch + 1, autoBackupState: other.autoBackupState ? { ...other.autoBackupState, enabled: false } : undefined });
    }
    await db.knowledgeBackupScopes.put({ ...scope, consented: true, destinationId: crypto.randomUUID(), scopeEpoch: scope.scopeEpoch + 1 });
  });
};
export const freezeKnowledgeBackup = async (): Promise<KnowledgeBackupToken> => {
  const owner = currentKnowledgeOwner();
  const generation = knowledgeContextGeneration();
  return db.transaction("r", knowledgeTables(db), async () => {
    assertKnowledgeOwner(owner, generation);
    const scope = await db.knowledgeBackupScopes.get(owner) ?? initialKnowledgeScope(owner);
    const libraries = await db.knowledgeLibraries.where("ownerScope").equals(owner).toArray();
    const dirty: Record<string, number> = {};
    for (const library of libraries) dirty[library.id] = (await db.knowledgeSyncState.get(library.id))!.dirtyGeneration;
    return captureKnowledgeBackupScope(scope, libraries, dirty);
  });
};
export const completeKnowledgeBackup = async (token: KnowledgeBackupToken): Promise<void> => {
  await db.transaction("rw", db.knowledgeBackupScopes, async () => {
    const scope = await db.knowledgeBackupScopes.get(token.ownerScope);
    if (!scope) throw new KnowledgeError("scope", "备份授权已失效");
    await db.knowledgeBackupScopes.put(acknowledgeKnowledgeBackup(scope, token, token.destinationId));
  });
};
export const currentKnowledgeBackupDirectory = async (): Promise<string | undefined> => {
  const scope = await db.knowledgeBackupScopes.get(currentKnowledgeOwner());
  return scope?.consented && scope.destinationId ? "study-journal-backup-" + scope.destinationId : undefined;
};
