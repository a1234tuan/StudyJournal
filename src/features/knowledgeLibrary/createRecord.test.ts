import Dexie from "dexie";
import { indexedDB, IDBKeyRange } from "fake-indexeddb";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { StudyJournalDatabase } from "../../db/database";
import type { RecordBlock } from "../../types";
import { createKnowledgeEntity, editKnowledgeEntity } from "./commands";
import { createKnowledgeRecordAttempt, type KnowledgeRecordTarget } from "./createRecord";
import type { KnowledgeOwner } from "./domain";
import { KnowledgeRepository } from "./repository";

Dexie.dependencies.indexedDB = indexedDB;
Dexie.dependencies.IDBKeyRange = IDBKeyRange;
let database: StudyJournalDatabase;
let repository: KnowledgeRepository;
let target: KnowledgeRecordTarget;
let owner: KnowledgeOwner;
const record = { id: "new-log", type: "record", subject: "数学", contentHtml: "<p></p>", title: "数学 1" } as RecordBlock;
beforeEach(async () => {
  owner = "deviceGuest";
  database = new StudyJournalDatabase("knowledge-create-" + crypto.randomUUID());
  await database.open();
  repository = new KnowledgeRepository(database, () => owner);
  await repository.createLibrary("测试库", "library");
  const opened = await repository.open("library");
  const workspace = createKnowledgeEntity("library", "workspace", "专题");
  await repository.execute(opened.context, workspace);
  const node = createKnowledgeEntity("library", "node", "节点", workspace.entity.id);
  await repository.execute(opened.context, node);
  target = { context: opened.context, workspaceId: workspace.entity.id, nodeId: node.entity.id };
});
afterEach(async () => { vi.restoreAllMocks(); await database.delete(); });

const deleteTarget = async () => {
  const opened = await repository.open("library");
  await repository.execute(opened.context, editKnowledgeEntity("library", opened.state, opened.state.entities[target.nodeId], "deleted", true));
};

describe("create a normal journal linked to a captured knowledge node", () => {
  it("creates a blank normal journal once and one deterministic reference", async () => {
    const create = vi.fn(async () => { await database.blocks.put(record); return record; });
    const attempt = createKnowledgeRecordAttempt(repository, target, create);
    const [first, second] = await Promise.all([attempt.create("数学"), attempt.create("数学")]);
    expect(first).toEqual(second);
    expect(create).toHaveBeenCalledTimes(1);
    expect(create).toHaveBeenCalledWith("数学");
    expect(await database.knowledgeReferences.toArray()).toEqual([expect.objectContaining({ nodeId: target.nodeId, recordId: record.id })]);
    expect(await database.blocks.get(record.id)).toEqual(record);
  });
  it("retries association without creating another journal", async () => {
    const create = vi.fn(async () => record);
    const attempt = createKnowledgeRecordAttempt(repository, target, create);
    vi.spyOn(repository, "execute").mockRejectedValueOnce(new Error("storage unavailable"));
    await expect(attempt.create("数学")).rejects.toThrow("storage unavailable");
    expect(attempt.record).toEqual(record);
    await attempt.create("英语");
    expect(create).toHaveBeenCalledTimes(1);
    expect(await database.knowledgeReferences.count()).toBe(1);
  });
  it("creates nothing if the target was deleted before subject selection", async () => {
    const create = vi.fn(async () => record);
    await deleteTarget();
    await expect(createKnowledgeRecordAttempt(repository, target, create).create("数学")).rejects.toThrow();
    expect(create).not.toHaveBeenCalled();
  });
  it("preserves the created journal if the node disappears during creation", async () => {
    const attempt = createKnowledgeRecordAttempt(repository, target, async () => {
      await database.blocks.put(record); await deleteTarget(); return record;
    });
    await expect(attempt.create("数学")).rejects.toThrow();
    expect(await database.blocks.get(record.id)).toEqual(record);
    expect(await database.knowledgeReferences.count()).toBe(0);
  });
  it("revalidates the node inside the final reference transaction", async () => {
    const execute = repository.execute.bind(repository);
    vi.spyOn(repository, "execute").mockImplementationOnce(async (...args) => {
      await deleteTarget();
      return execute(...args);
    });
    const attempt = createKnowledgeRecordAttempt(repository, target, async () => record);
    await expect(attempt.create("数学")).rejects.toThrow();
    expect(attempt.record).toEqual(record);
    expect(await database.knowledgeReferences.count()).toBe(0);
  });
  it("rejects an owner switch before creating a journal", async () => {
    const create = vi.fn(async () => record);
    owner = "account:other";
    await expect(createKnowledgeRecordAttempt(repository, target, create).create("数学")).rejects.toThrow();
    expect(create).not.toHaveBeenCalled();
  });
  it("never links into another owner after creation", async () => {
    const attempt = createKnowledgeRecordAttempt(repository, target, async () => { owner = "account:other"; return record; });
    await expect(attempt.create("数学")).rejects.toThrow();
    expect(await database.knowledgeReferences.count()).toBe(0);
    expect(attempt.record).toEqual(record);
  });
  it("rejects stale data generations", async () => {
    const create = vi.fn(async () => record);
    target.context.dataGeneration -= 1;
    await expect(createKnowledgeRecordAttempt(repository, target, create).create("数学")).rejects.toThrow();
    expect(create).not.toHaveBeenCalled();
  });
  it("does not create journals in a preserved migration source", async () => {
    await database.knowledgeLibraryMigrations.put({ ownerScope: owner, sourceLibraryId: "library", targetLibraryId: "target", cloudLibraryId: "cloud", sessionId: "migration", sourceHash: "hash", sourceGeneration: 0, sourceEpoch: 0, phase: "confirmed" });
    const create = vi.fn(async () => record);
    await expect(createKnowledgeRecordAttempt(repository, target, create).create("数学")).rejects.toThrow();
    expect(create).not.toHaveBeenCalled();
  });
  it("can retry a creation failure without leaving a reference", async () => {
    const create = vi.fn().mockRejectedValueOnce(new Error("disk full")).mockResolvedValue(record);
    const attempt = createKnowledgeRecordAttempt(repository, target, create);
    await expect(attempt.create("数学")).rejects.toThrow("disk full");
    expect(attempt.record).toBeUndefined();
    expect(await database.knowledgeReferences.count()).toBe(0);
    await attempt.create("数学");
    expect(await database.knowledgeReferences.count()).toBe(1);
  });
});
