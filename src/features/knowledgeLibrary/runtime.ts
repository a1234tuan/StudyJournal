import { formatUiError } from "../../lib/uiError";
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
export const synchronizeBoundKnowledge = async (): Promise<string> => {
  const synchronizer = knowledgeSynchronizer();
  if (!synchronizer) return "知识库：尚未登录。";
  const libraries = (await knowledgeRepository.listLibraries()).filter(library => library.cloudLibraryId);
  if (!libraries.length) return "知识库：未启用，仍仅本机保存。";
  try {
    let pending = 0;
    for (const library of libraries) {
      const opened = await knowledgeRepository.open(library.id);
      const result = await synchronizer.synchronize(opened.context);
      pending += result.pending;
    }
    return pending ? "知识库：仍有 " + pending + " 项待同步或重新确认。" : "知识库：同步完成。";
  } catch (error) { return "知识库：同步未完成，本机内容保留。" + formatUiError(error, "cloud-sync"); }
};
export const startKnowledgeRuntime = (): (() => void) => {
  const unsubscribe = onAuthStateChanged(firebaseAuth, user => {
    const previous = currentKnowledgeOwner();
    const next = user ? ("account:" + user.uid) as KnowledgeOwner : "deviceGuest";
    if (previous === next) return;
    changeKnowledgeOwner(next);
    void knowledgeRepository.invalidateOwner(previous).then(() => { window.dispatchEvent(new Event("knowledge-owner-changed")); }).catch(() => { window.dispatchEvent(new Event("knowledge-owner-changed")); });
  });
  const dirty = liveQuery(async () => {
    const scope = await db.knowledgeBackupScopes.get(currentKnowledgeOwner());
    if (!scope?.consented || !scope.autoBackupState?.enabled) return false;
    const libraries = await db.knowledgeLibraries.where("ownerScope").equals(currentKnowledgeOwner()).toArray();
    for (const library of libraries) {
      const state = await db.knowledgeSyncState.get(library.id);
      if (state && state.dirtyGeneration > (scope.capturedGenerations[library.id] ?? 0)) return true;
    }
    return false;
  }).subscribe({ next: pending => { if (pending) void markAutoBackupDirty("knowledge"); }, error: () => undefined });
  return () => { unsubscribe(); dirty.unsubscribe(); };
};
