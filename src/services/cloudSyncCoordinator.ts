import { knowledgeUiError } from "../features/knowledgeLibrary/uiError";
import type { KnowledgeSyncResult } from "../features/knowledgeLibrary/syncResult";
import type { KnowledgeSyncOptions } from "../features/knowledgeLibrary/syncResult";
import type { SyncOutcome } from "./cloudSyncStore";

export const completeCloudSync = async (journal: { uploaded: number; downloaded: number; pending?: number }, options: KnowledgeSyncOptions): Promise<SyncOutcome | undefined> => {
  if (options.isCurrent?.() === false) return undefined;
  let knowledge: Pick<KnowledgeSyncResult, "status" | "message">;
  try {
    const { synchronizeBoundKnowledge } = await import("../features/knowledgeLibrary/runtime");
    if (options.isCurrent?.() === false) return undefined;
    knowledge = await synchronizeBoundKnowledge(options);
  } catch (error) {
    knowledge = { status: "error", message: "知识库：同步未完成，本机内容保留。" + knowledgeUiError(error, "启动同步").message };
  }
  if (options.isCurrent?.() === false) return undefined;
  const journalMessage = journal.uploaded || journal.downloaded ? "普通日志：上传 " + journal.uploaded + " 项，下载 " + journal.downloaded + " 项。" : "普通日志：本机和云端均无新变化。";
  const pendingMessage = journal.pending ? "普通日志仍有 " + journal.pending + " 项待同步。" : "";
  const message = journalMessage + pendingMessage + " " + knowledge.message;
  if (knowledge.status === "error") return { status: "error", message };
  if (journal.pending || !["success", "no-change"].includes(knowledge.status)) return { status: "uncertain", message };
  return { status: journal.uploaded || journal.downloaded || knowledge.status === "success" ? "success" : "no-change", message };
};
