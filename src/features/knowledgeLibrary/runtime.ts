import { knowledgeUiError } from "./uiError";
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
  try {
    const libraries = (await knowledgeRepository.listLibraries()).filter(library => library.cloudLibraryId);
    if (!libraries.length) libraries.push((await synchronizer.connect()).library);
    let pending = 0;
    for (const library of libraries) {
      const opened = await knowledgeRepository.open(library.id);
      const result = await synchronizer.synchronize(opened.context);
      pending += result.pending;
    }
    const offline = await db.knowledgeLibraries.where("ownerScope").anyOf([currentKnowledgeOwner(), "deviceGuest"]).filter(library => !library.cloudLibraryId).count();
    const offlineNotice = offline ? " 本机独立库未上传，可在备份与恢复的云同步设置中选择复制。" : "";
    return (pending ? "知识库：仍有 " + pending + " 项待同步或重新确认。" : "知识库：同步完成。") + offlineNotice;
  } catch (error) { return "知识库：同步未完成，本机内容保留。" + knowledgeUiError(error, "云同步").message; }
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
    if (Object.keys(scope.capturedGenerations).some(id => !libraries.some(library => library.id === id))) return true;
    for (const library of libraries) {
      const state = await db.knowledgeSyncState.get(library.id);
      if (state && state.dirtyGeneration > (scope.capturedGenerations[library.id] ?? 0)) return true;
    }
    return false;
  }).subscribe({ next: pending => { if (pending) void markAutoBackupDirty("knowledge"); }, error: () => undefined });
  return () => { unsubscribe(); dirty.unsubscribe(); };
};
