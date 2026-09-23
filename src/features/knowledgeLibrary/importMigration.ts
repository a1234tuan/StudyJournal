import type { Transaction } from "dexie";
import type { KnowledgeSyncState } from "./domain";
export async function migrateKnowledgeImports(transaction: Transaction): Promise<void> {
  const states = await transaction.table<KnowledgeSyncState>("knowledgeSyncState").toArray();
  for (const state of states) {
    if (!state.importSessions) continue;
    for (const session of Object.values(state.importSessions)) {
      if (!Number.isSafeInteger(session.next) || session.next < 0 || session.next > session.commands.length) throw new Error("知识库复制进度无效，升级已回滚");
      const total = session.commands.length;
      await transaction.table("knowledgeImportSessions").put({ libraryId: state.libraryId, id: session.id, sourceLibraryId: session.sourceLibraryId, sourceGeneration: session.sourceGeneration, sourceHash: session.sourceHash, next: session.next, total, status: session.next === total ? "completed" : "active" });
      for (let ordinal = session.next; ordinal < total; ordinal += 1) {
        await transaction.table("knowledgeImportSteps").put({ libraryId: state.libraryId, sessionId: session.id, ordinal, command: session.commands[ordinal] });
      }
    }
    const { importSessions: _legacy, ...smallState } = state;
    await transaction.table("knowledgeSyncState").put(smallState);
  }
}
