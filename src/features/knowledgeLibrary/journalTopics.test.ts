import Dexie from "dexie";
import { indexedDB, IDBKeyRange } from "fake-indexeddb";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { StudyJournalDatabase } from "../../db/database";
import { createKnowledgeEntity, editKnowledgeEntity } from "./commands";
import type { KnowledgeOwner } from "./domain";
import { KnowledgeRepository } from "./repository";
import { loadJournalTopics } from "./journalTopics";

Dexie.dependencies.indexedDB = indexedDB;
Dexie.dependencies.IDBKeyRange = IDBKeyRange;
let database: StudyJournalDatabase;
let repository: KnowledgeRepository;
let owner: KnowledgeOwner;
beforeEach(async () => {
  owner = "deviceGuest";
  database = new StudyJournalDatabase("journal-topics-" + crypto.randomUUID());
  await database.open();
  repository = new KnowledgeRepository(database, () => owner);
});
afterEach(async () => { vi.restoreAllMocks(); await database.delete(); });

const seed = async (id: string, detached = false) => {
  await repository.createLibrary(id, id, detached);
  const { context } = await repository.open(id);
  const topic = createKnowledgeEntity(id, "workspace", "专题");
  await repository.execute(context, topic);
  const node = createKnowledgeEntity(id, "node", "节点", topic.entity.id);
  await repository.execute(context, node);
  await repository.execute(context, createKnowledgeEntity(id, "reference", "", topic.entity.id, "@root", "record", node.entity.id));
  return { context, topic, node };
};

it("deduplicates references, hides archived ancestors and tracks topic rename", async () => {
  const { context, topic, node } = await seed("ordinary");
  const second = createKnowledgeEntity("ordinary", "node", "另一个节点", topic.entity.id);
  await repository.execute(context, second);
  await repository.execute(context, createKnowledgeEntity("ordinary", "reference", "", topic.entity.id, "@root", "record", second.entity.id));
  expect([...(await loadJournalTopics(repository))[0].recordIds]).toEqual(["record"]);
  let { state } = await repository.open("ordinary");
  await repository.execute(context, editKnowledgeEntity("ordinary", state, state.entities[node.entity.id], "deleted", true));
  expect((await loadJournalTopics(repository))[0].recordIds.size).toBe(1);
  state = (await repository.open("ordinary")).state;
  await repository.execute(context, editKnowledgeEntity("ordinary", state, state.entities[topic.entity.id], "title", "重命名"));
  expect((await loadJournalTopics(repository))[0].title).toBe("重命名");
  state = (await repository.open("ordinary")).state;
  await repository.execute(context, editKnowledgeEntity("ordinary", state, state.entities[topic.entity.id], "archived", true));
  expect(await loadJournalTopics(repository)).toEqual([]);
});

it("isolates owners and excludes detached and protected recovery libraries", async () => {
  await seed("ordinary");
  await seed("detached", true);
  await seed("protected");
  const sync = (await database.knowledgeSyncState.get("ordinary"))!;
  await database.knowledgeSyncState.put({ ...sync, failure: { code: "invalid", cursor: 0, sequence: 0, fingerprint: "failure", attempts: 1, recoveryLibraryId: "protected" } });
  expect((await loadJournalTopics(repository)).map(topic => topic.libraryId)).toEqual(["ordinary"]);
  owner = "account:other";
  expect(await loadJournalTopics(repository)).toEqual([]);
});

it("uses complete sources during copying and only the target after copying", async () => {
  await seed("source");
  await seed("target");
  await database.knowledgeLibraryMigrations.put({ ownerScope: owner, sourceLibraryId: "source", targetLibraryId: "target", cloudLibraryId: "cloud", sessionId: "session", sourceHash: "hash", sourceGeneration: 0, sourceEpoch: 0, phase: "local-copying" });
  expect((await loadJournalTopics(repository)).map(topic => topic.libraryId)).toEqual(["source"]);
  await database.knowledgeLibraryMigrations.update([owner, "source"], { phase: "awaiting-cloud" });
  expect((await loadJournalTopics(repository)).map(topic => topic.libraryId)).toEqual(["target"]);
});

it("rejects an owner switch during an asynchronous read", async () => {
  await seed("ordinary");
  const open = repository.open.bind(repository);
  vi.spyOn(repository, "open").mockImplementation(async id => { const result = await open(id); owner = "account:other"; return result; });
  await expect(loadJournalTopics(repository)).rejects.toThrow("账号已变化");
});
