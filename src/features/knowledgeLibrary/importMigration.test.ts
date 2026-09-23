import Dexie from "dexie";
import { indexedDB, IDBKeyRange } from "fake-indexeddb";
import { expect, it } from "vitest";
import { StudyJournalDatabase } from "../../db/database";
import { KNOWLEDGE_SCHEMA_25_STORES } from "./schema";
import { DAILY_PLAN_SCHEMA_24_STORES } from "../../db/reviewCoachSchema";
import { createKnowledgeEntity } from "./commands";
Dexie.dependencies.indexedDB = indexedDB; Dexie.dependencies.IDBKeyRange = IDBKeyRange;
it("migrates active steps and shrinks completed sessions atomically from schema25", async () => {
  const name = "import-migration-" + crypto.randomUUID();
  const legacy = new Dexie(name);
  legacy.version(24).stores(DAILY_PLAN_SCHEMA_24_STORES);
  legacy.version(25).stores(KNOWLEDGE_SCHEMA_25_STORES);
  await legacy.open();
  const commands = [createKnowledgeEntity("target", "workspace", "first"), createKnowledgeEntity("target", "workspace", "second")];
  const session = { sourceLibraryId: "source", sourceGeneration: 0, sourceHash: "hash", commands };
  await legacy.table("knowledgeSyncState").put({ libraryId: "target", epoch: 0, cursor: 0, dirtyGeneration: 1, dataGeneration: 0, importSessions: { active: { ...session, id: "active", next: 1 }, done: { ...session, id: "done", next: 2 } } });
  legacy.close();
  const database = new StudyJournalDatabase(name);
  try {
    await database.open();
    expect(database.verno).toBe(26);
    expect(await database.knowledgeImportSteps.count()).toBe(1);
    expect(await database.knowledgeImportSteps.get(["target", "active", 1])).toMatchObject({ command: commands[1] });
    expect(await database.knowledgeImportSessions.get(["target", "done"])).toMatchObject({ next: 2, total: 2, status: "completed" });
    expect((await database.knowledgeSyncState.get("target"))?.importSessions).toBeUndefined();
    expect(JSON.stringify(await database.knowledgeImportSessions.toArray())).not.toContain('"commands"');
  } finally { await database.delete(); }
});
it("rolls back all migrated rows when a later legacy session is invalid", async () => {
  const name = "import-rollback-" + crypto.randomUUID();
  const legacy = new Dexie(name);
  legacy.version(24).stores(DAILY_PLAN_SCHEMA_24_STORES);
  legacy.version(25).stores(KNOWLEDGE_SCHEMA_25_STORES);
  await legacy.open();
  const commands = [createKnowledgeEntity("target", "workspace", "keep")];
  const session = { sourceLibraryId: "source", sourceGeneration: 0, sourceHash: "hash", commands };
  const original = { libraryId: "target", epoch: 0, cursor: 0, dirtyGeneration: 1, dataGeneration: 0, importSessions: { valid: { ...session, id: "valid", next: 0 }, invalid: { ...session, id: "invalid", next: 2 } } };
  await legacy.table("knowledgeSyncState").put(original);
  legacy.close();
  const upgraded = new StudyJournalDatabase(name);
  try {
    await expect(upgraded.open()).rejects.toThrow("升级已回滚");
    upgraded.close();
    await legacy.open();
    expect(legacy.verno).toBe(25);
    expect(await legacy.table("knowledgeSyncState").get("target")).toEqual(original);
    expect(legacy.tables.some(table => table.name === "knowledgeImportSteps")).toBe(false);
  } finally { upgraded.close(); await legacy.delete(); }
});
