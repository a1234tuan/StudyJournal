import { synchronizeKnowledge } from "./oneClickSync";
import { emptyKnowledgeSyncResult, type KnowledgeSyncOptions, type KnowledgeSyncResult } from "./syncResult";
import type { KnowledgeOwner } from "./domain";
import { liveQuery } from "dexie";
import { onAuthStateChanged } from "firebase/auth";
import { db } from "../../db/database";
import { firebaseAuth, firestore } from "../../services/firebase";
import { markAutoBackupDirty } from "../../services/autoBackupService";
import { changeKnowledgeOwner, currentKnowledgeOwner, knowledgeContextGeneration } from "./context";
import { KnowledgeRepository } from "./repository";
import { KnowledgeSync } from "./sync";
import { createKnowledgeTransport } from "./firestoreTransport";

export const knowledgeRepository = new KnowledgeRepository(db, currentKnowledgeOwner, knowledgeContextGeneration);
export const knowledgeSynchronizer = (): KnowledgeSync | undefined => {
  const user = firebaseAuth.currentUser;
  if (!user || currentKnowledgeOwner() !== "account:" + user.uid) return undefined;
  return new KnowledgeSync(knowledgeRepository, createKnowledgeTransport(firestore, user.uid));
};
export const synchronizeBoundKnowledge = async (options: KnowledgeSyncOptions = {}): Promise<KnowledgeSyncResult> => {
  const synchronizer = knowledgeSynchronizer();
  if (!synchronizer) return { ...emptyKnowledgeSyncResult(), status: "skipped", message: "知识库：尚未登录或登录状态正在切换，本次未同步。" };
  return synchronizeKnowledge(synchronizer, options);
};
/**
 * Whether the current owner still has knowledge libraries that the last verified backup did not cover.
 *
 * Exported (and kept free of `liveQuery`) so the decision can be asserted directly by the concurrency
 * regressions instead of being re-implemented in the test, which is what let a "library created while
 * the archive was being written" case go unnoticed.
 */
export const isKnowledgeBackupPending = async (owner: KnowledgeOwner = currentKnowledgeOwner()): Promise<boolean> => {
  const scope = await db.knowledgeBackupScopes.get(owner);
  if (!scope?.consented || !scope.autoBackupState?.enabled) return false;
  const libraries = await db.knowledgeLibraries.where("ownerScope").equals(owner).toArray();
  // A captured generation for a library that no longer exists means membership changed since the
  // last complete backup, so the archive no longer describes the current set.
  if (Object.keys(scope.capturedGenerations).some(id => !libraries.some(library => library.id === id))) return true;
  for (const library of libraries) {
    const state = await db.knowledgeSyncState.get(library.id);
    if (state && state.dirtyGeneration > (scope.capturedGenerations[library.id] ?? 0)) return true;
  }
  return false;
};
export const startKnowledgeRuntime = (): (() => void) => {
  const unsubscribe = onAuthStateChanged(firebaseAuth, user => {
    const previous = currentKnowledgeOwner();
    const next = user ? ("account:" + user.uid) as KnowledgeOwner : "deviceGuest";
    if (previous === next) return;
    changeKnowledgeOwner(next);
    void knowledgeRepository.invalidateOwner(previous).then(() => { window.dispatchEvent(new Event("knowledge-owner-changed")); }).catch(() => { window.dispatchEvent(new Event("knowledge-owner-changed")); });
  });
  const dirty = liveQuery(async () => isKnowledgeBackupPending()).subscribe({ next: pending => { if (pending) void markAutoBackupDirty("knowledge"); }, error: () => undefined });
  return () => { unsubscribe(); dirty.unsubscribe(); };
};
