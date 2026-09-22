import Dexie from "dexie";
import { indexedDB, IDBKeyRange } from "fake-indexeddb";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { StudyJournalDatabase } from "../../db/database";
import { knowledgeHash } from "./canonical";
import { capturePortableKnowledge, createKnowledgeEnvelope, restorePortableKnowledge, validateKnowledgeEnvelope } from "./backup";
import { KnowledgeRepository, knowledgeTables } from "./repository";
import { emptyKnowledgeState, type KnowledgeCommand } from "./domain";
import { applyKnowledgeCommand } from "./protocol";

Dexie.dependencies.indexedDB = indexedDB;
Dexie.dependencies.IDBKeyRange = IDBKeyRange;
let database: StudyJournalDatabase;
beforeEach(async () => { database = new StudyJournalDatabase("knowledge-backup-" + crypto.randomUUID()); await database.open(); });
afterEach(async () => { await database.delete(); });
const command: KnowledgeCommand = { protocolVersion: 1, id: "create", libraryId: "original", operation: "create", entity: { id: "topic", kind: "workspace", workspaceId: "topic", nodeId: "", recordId: "" }, expected: { title: null, note: null, archived: null, deleted: null }, changes: { title: "专题", note: "未上传说明", archived: false, deleted: false } };
describe("portable knowledge backups", () => {
  it("EMPTY-01/03: restores empty content to one retry-stable detached copy without touching the original", async () => {
    const repository = new KnowledgeRepository(database, () => "account:A");
    await repository.createLibrary("原云库", "original");
    const original = await repository.open("original");
    await repository.execute(original.context, command);
    const before = await repository.open("original");
    const restore = () => database.transaction("rw", knowledgeTables(database), () => restorePortableKnowledge(database, createKnowledgeEnvelope([]), "account:A", "session"));
    const first = await restore();
    expect(await restore()).toEqual(first);
    expect(await database.knowledgeLibraries.count()).toBe(2);
    expect((await repository.open("original")).state).toEqual(before.state);
    expect((await repository.open(first[0])).state.entities).toEqual({});
    expect((await database.knowledgeLibraries.get(first[0]))?.cloudLibraryId).toBeNull();
    await expect(database.transaction("rw", knowledgeTables(database), () => restorePortableKnowledge(database, createKnowledgeEnvelope([]), "account:B", "session"))).rejects.toThrow();
  });
  it("SCOPE-01/05: captures pending facts of all owner libraries and restores without credentials or old pending commands", async () => {
    const repository = new KnowledgeRepository(database, () => "account:A");
    await repository.createLibrary("原库", "original");
    const opened = await repository.open("original");
    await repository.execute(opened.context, command);
    await repository.createLibrary("恢复副本", "copy", true);
    await new KnowledgeRepository(database, () => "account:B").createLibrary("其他账号", "other");
    const envelope = await database.transaction("r", knowledgeTables(database), () => capturePortableKnowledge(database, "account:A"));
    expect(envelope.libraries).toHaveLength(2);
    expect(JSON.stringify(envelope)).not.toContain("account:A");
    expect(JSON.stringify(envelope)).not.toContain("account:B");
    expect(envelope.libraries.flatMap(library => library.revisions).some(revision => revision.value === "未上传说明")).toBe(true);
    const ids = await database.transaction("rw", knowledgeTables(database), () => restorePortableKnowledge(database, envelope, "account:A", "restore"));
    expect(ids).toHaveLength(2);
    for (const id of ids) {
      expect(await database.knowledgeCommands.where("libraryId").equals(id).count()).toBe(0);
      expect(await database.knowledgeRemoteEntities.where("libraryId").equals(id).count()).toBe(0);
    }
    expect(await database.knowledgeLibraries.count()).toBe(5);
  });
  it("EMPTY-02: rejects null, future versions, checksum corruption and malformed causal data before writes", async () => {
    for (const input of [null, {}, { ...createKnowledgeEnvelope([]), version: 2 }, { ...createKnowledgeEnvelope([]), checksum: "bad" }]) expect(() => validateKnowledgeEnvelope(input)).toThrow();
    const repository = new KnowledgeRepository(database, () => "deviceGuest");
    await repository.createLibrary("原库", "original");
    const opened = await repository.open("original");
    await repository.execute(opened.context, command);
    const envelope = await database.transaction("r", knowledgeTables(database), () => capturePortableKnowledge(database, "deviceGuest"));
    envelope.libraries[0].revisions[0].parents = [envelope.libraries[0].revisions[0].id];
    envelope.checksum = knowledgeHash({ version: envelope.version, scope: envelope.scope, libraries: envelope.libraries });
    await expect(database.transaction("rw", knowledgeTables(database), () => restorePortableKnowledge(database, envelope, "deviceGuest", "bad"))).rejects.toThrow();
    expect(await database.knowledgeLibraries.count()).toBe(1);
  });

  it("rejects a candidate whose revision belongs to another unit", () => {
    const initial = applyKnowledgeCommand(emptyKnowledgeState(), command);
    const current = applyKnowledgeCommand(initial, { ...command, id: "first-edit", operation: "edit", expected: { note: initial.entities.topic.units.note! }, changes: { note: "当前正文" } });
    const conflict = applyKnowledgeCommand(current, { ...command, id: "second-edit", operation: "edit", expected: { note: initial.entities.topic.units.note! }, changes: { note: "并发正文" } });
    const envelope = createKnowledgeEnvelope([{
      archiveLibraryId: "archive-library",
      title: "专题",
      entities: Object.values(conflict.entities),
      revisions: Object.values(conflict.revisions),
      candidates: Object.values(conflict.candidates),
      groups: Object.values(conflict.groups),
    }]);
    envelope.libraries[0].candidates[0].revisionId = initial.entities.topic.units.title!;
    envelope.checksum = knowledgeHash({ version: envelope.version, scope: envelope.scope, libraries: envelope.libraries });
    expect(() => validateKnowledgeEnvelope(envelope)).toThrow();
  });
});
