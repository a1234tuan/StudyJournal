import Dexie from "dexie";
import { indexedDB, IDBKeyRange } from "fake-indexeddb";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { StudyJournalDatabase } from "../../db/database";
import { DAILY_PLAN_SCHEMA_24_STORES } from "../../db/reviewCoachSchema";
import type { KnowledgeCommand, KnowledgeOwner } from "./domain";
import { createKnowledgeEntity, editKnowledgeEntity } from "./commands";
import { KnowledgeRepository } from "./repository";
import { capturePortableKnowledge } from "./backup";

Dexie.dependencies.indexedDB = indexedDB;
Dexie.dependencies.IDBKeyRange = IDBKeyRange;
let database: StudyJournalDatabase;
let peer: StudyJournalDatabase;
let owner: KnowledgeOwner;
let repository: KnowledgeRepository;
const topic = (libraryId: string, title = "知识专题"): KnowledgeCommand => ({ protocolVersion: 1, id: "create-topic", libraryId, operation: "create", entity: { id: "topic", kind: "workspace", workspaceId: "topic", nodeId: "", recordId: "" }, expected: { title: null, note: null, archived: null, deleted: null }, changes: { title, note: "", archived: false, deleted: false } });
beforeEach(async () => {
  owner = "account:A";
  const name = "knowledge-repository-" + crypto.randomUUID();
  database = new StudyJournalDatabase(name);
  peer = new StudyJournalDatabase(name);
  await database.open();
  await peer.open();
  repository = new KnowledgeRepository(database, () => owner);
});
afterEach(async () => { vi.restoreAllMocks(); peer.close(); await database.delete(); });

describe("knowledge repository transaction boundaries", () => {
  it("upgrades a schema24 database without changing ordinary rows and tolerates two concurrent opens", async () => {
    const name = "knowledge-migration-" + crypto.randomUUID();
    const old = new Dexie(name);
    old.version(24).stores(DAILY_PLAN_SCHEMA_24_STORES);
    await old.open();
    const record = { id: "old-record", type: "record", title: "原日志", contentHtml: "<p>保留正文</p>", planId: "plan" };
    const asset = { id: "blob", data: new Uint8Array([1, 2, 3]), title: "旧附件" };
    await old.table("blocks").put(record);
    await old.table("assets").put(asset);
    await old.table("dailyPlans").put({ id: "plan", date: "2026-09-22" });
    old.close();
    const upgraded = new StudyJournalDatabase(name);
    const second = new StudyJournalDatabase(name);
    try {
      await Promise.all([upgraded.open(), second.open()]);
      expect(upgraded.verno).toBe(27);
      expect(await upgraded.blocks.get("old-record")).toEqual(record);
      const restoredAsset = await upgraded.assets.get("blob");
      expect(restoredAsset).toMatchObject({ id: asset.id, title: asset.title });
      expect(Array.from(restoredAsset!.data as unknown as Uint8Array)).toEqual([1, 2, 3]);
      expect(await upgraded.dailyPlans.count()).toBe(1);
      expect(await upgraded.knowledgeLibraries.count()).toBe(0);
    } finally { second.close(); await upgraded.delete(); }
  });
  it("writes facts, command, epoch and dirty atomically without touching ordinary cloud mutations", async () => {
    await database.cloudSyncMutation.put({ id: "local", epoch: 42 });
    await repository.createLibrary("本机库", "library");
    const opened = await repository.open("library");
    const command = topic("library");
    await repository.execute(opened.context, command);
    expect(await database.knowledgeWorkspaces.count()).toBe(1);
    expect(await database.knowledgeCommands.count()).toBe(1);
    const first = await database.knowledgeSyncState.get("library");
    expect(first).toMatchObject({ epoch: 1, dirtyGeneration: 2 });
    await repository.execute(opened.context, command);
    expect(await database.knowledgeSyncState.get("library")).toEqual(first);
    expect(await database.cloudSyncMutation.get("local")).toEqual({ id: "local", epoch: 42 });
    expect(await database.blocks.count()).toBe(0);
  });
  it("rejects stale captured edits after a peer commit without replacing any newer field", async () => {
    await repository.createLibrary("本机库", "library");
    const opened = await repository.open("library");
    await repository.execute(opened.context, topic("library"));
    const baseline = await repository.open("library");
    const first: KnowledgeCommand = { ...topic("library"), id: "save-first", operation: "edit", expected: { note: baseline.state.entities.topic.units.note }, changes: { note: "最新正文" } };
    const second = { ...first, id: "save-stale", changes: { note: "陈旧页面" } };
    await new KnowledgeRepository(peer, () => owner).execute(baseline.context, first);
    const sync = await database.knowledgeSyncState.get("library");
    await expect(repository.execute(baseline.context, second)).rejects.toMatchObject({ code: "stale" });
    expect(await database.knowledgeSyncState.get("library")).toEqual(sync);
    expect((await repository.open("library")).state.revisions["save-first:note"].value).toBe("最新正文");
    expect(await database.knowledgeCommands.get(["library", "save-stale"])).toBeUndefined();
  });
  it("rolls back partial rows, pending and epoch while retaining drafts when a final write fails", async () => {
    await repository.createLibrary("本机库", "library");
    const opened = await repository.open("library");
    await repository.saveDraft(opened.context, { ...opened.context, id: "draft", entityId: "topic", unit: "title", text: "未丢失", expectedRevision: null });
    vi.spyOn(database.knowledgeSyncState, "put").mockRejectedValueOnce(new Error("injected write failure"));
    await expect(repository.execute(opened.context, topic("library"), "draft")).rejects.toThrow("injected");
    expect(await database.knowledgeWorkspaces.count()).toBe(0);
    expect(await database.knowledgeRevisions.count()).toBe(0);
    expect(await database.knowledgeCommands.count()).toBe(0);
    expect(await database.knowledgeSyncState.get("library")).toMatchObject({ epoch: 0, dirtyGeneration: 1 });
    expect((await database.knowledgeDrafts.get(["library", "draft"]))?.text).toBe("未丢失");
  });
  it("isolates identical IDs across libraries, rejects account changes and fences A-to-B-to-A callbacks", async () => {
    await repository.createLibrary("甲", "first");
    await repository.createLibrary("乙", "second");
    const first = await repository.open("first");
    const second = await repository.open("second");
    await repository.execute(first.context, topic("first", "甲专题"));
    await repository.execute(second.context, topic("second", "乙专题"));
    expect((await repository.open("first")).state.revisions["create-topic:title"].value).toBe("甲专题");
    expect((await repository.open("second")).state.revisions["create-topic:title"].value).toBe("乙专题");
    owner = "account:B";
    expect(await repository.listLibraries()).toEqual([]);
    await expect(repository.open("first")).rejects.toMatchObject({ code: "scope" });
    await repository.invalidateOwner("account:A");
    owner = "account:A";
    await expect(repository.execute(first.context, topic("first"))).rejects.toMatchObject({ code: "stale" });
    expect((await repository.listLibraries()).length).toBe(2);
  });
  it("keeps original draft baselines and refuses undo after an intervening edit", async () => {
    await repository.createLibrary("库", "library");
    const opened = await repository.open("library");
    await repository.execute(opened.context, topic("library"));
    const baseline = await repository.open("library");
    const command: KnowledgeCommand = { ...topic("library"), id: "edit", operation: "edit", expected: { title: baseline.state.entities.topic.units.title }, changes: { title: "新标题" } };
    const draft = { ...opened.context, id: "title-draft", entityId: "topic", unit: "title" as const, text: "正在编辑", expectedRevision: "create-topic:title" };
    await repository.saveDraft(opened.context, draft);
    await expect(repository.saveDraft(opened.context, { ...draft, expectedRevision: "edit:title" })).rejects.toMatchObject({ code: "stale" });
    await repository.execute(opened.context, command);
    await repository.undo(opened.context, command, "title", "undo");
    await expect(repository.undo(opened.context, command, "title", "undo-twice")).rejects.toMatchObject({ code: "stale" });
    expect((await repository.open("library")).state.revisions["undo:title"].value).toBe("知识专题");
  });
});


describe("knowledge library first-use and naming", () => {

  it("does not create two same-name libraries concurrently or cross an account generation", async () => {
    const results = await Promise.allSettled([
      repository.createNamedLibrary("命名库", "named-one", owner, 0),
      repository.createNamedLibrary("命名库", "named-two", owner, 0),
    ]);
    expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
    expect(await database.knowledgeLibraries.count()).toBe(1);
    await expect(repository.createNamedLibrary("其他", "named-three", owner, 1)).rejects.toMatchObject({ code: "scope" });
  });
  it("creates the first topic and its library atomically and retries the same intent without duplicates", async () => {
    const intent = { id: "first-use", ownerScope: owner, sessionGeneration: 0 };
    const first = await repository.createTopic("算法", intent);
    const again = await repository.createTopic("算法", intent);
    expect(again).toEqual(first);
    expect(await database.knowledgeLibraries.count()).toBe(1);
    expect(await database.knowledgeWorkspaces.count()).toBe(1);
    expect(await database.knowledgeCommands.count()).toBe(1);
    expect((await database.knowledgeLibraries.get(first.libraryId))?.title).toBe("我的知识库");
  });
  it("serializes simultaneous first topics into one library", async () => {
    const second = new KnowledgeRepository(peer, () => owner);
    const results = await Promise.all([
      repository.createTopic("数学", { id: "first", ownerScope: owner, sessionGeneration: 0 }),
      second.createTopic("算法", { id: "second", ownerScope: owner, sessionGeneration: 0 }),
    ]);
    expect(results[0].libraryId).toBe(results[1].libraryId);
    expect(await database.knowledgeLibraries.count()).toBe(1);
    expect(await database.knowledgeWorkspaces.count()).toBe(2);
  });
  it("rejects invalid titles and old identity without creating an empty library", async () => {
    const intent = { id: "cancelled", ownerScope: owner, sessionGeneration: 0 };
    await expect(repository.createTopic(" ", intent)).rejects.toMatchObject({ code: "invalid" });
    await expect(repository.createTopic("字".repeat(513), intent)).rejects.toMatchObject({ code: "invalid" });
    owner = "account:B";
    await expect(repository.createTopic("旧账号输入", intent)).rejects.toMatchObject({ code: "scope" });
    expect(await database.knowledgeLibraries.count()).toBe(0);
  });
  it("rolls back the default container if the topic write fails", async () => {
    vi.spyOn(repository, "execute").mockRejectedValueOnce(new Error("disk full"));
    await expect(repository.createTopic("算法", { id: "failure", ownerScope: owner, sessionGeneration: 0 })).rejects.toThrow("disk full");
    expect(await database.knowledgeLibraries.count()).toBe(0);
    expect(await database.knowledgeSyncState.count()).toBe(0);
    expect(await database.knowledgeBackupScopes.count()).toBe(0);
  });
  it("renames without merging duplicate libraries and marks backup dirty, not cloud facts", async () => {
    await repository.createLibrary("同名", "one");
    await repository.createLibrary("同名", "two");
    const opened = await repository.open("one");
    const before = await database.knowledgeSyncState.get("one");
    await repository.renameLibrary(opened.context, "考试复习");
    expect((await database.knowledgeLibraries.get("two"))?.title).toBe("同名");
    expect((await database.knowledgeSyncState.get("one"))?.dirtyGeneration).toBe(before!.dirtyGeneration + 1);
    await repository.renameLibrary(opened.context, "考试复习");
    expect((await database.knowledgeSyncState.get("one"))?.dirtyGeneration).toBe(before!.dirtyGeneration + 1);
    await expect(repository.renameLibrary(opened.context, "同名")).rejects.toMatchObject({ code: "invalid" });
    expect(await database.knowledgeLibraries.count()).toBe(2);
    expect(await database.knowledgeCommands.count()).toBe(0);
    expect(await database.cloudSyncMutation.count()).toBe(0);
  });

  it("deletes only a local library and preserves ordinary logs", async () => {
    await database.blocks.put({ id: "ordinary", type: "record", title: "原日志", subject: "学习", date: "2026-09-22", createdAt: "2026-09-22T00:00:00.000Z", updatedAt: "2026-09-22T00:00:00.000Z", order: 0, contentHtml: "<p>正文</p>", tags: [], assets: [], formulas: [], mistakeRefs: [] });
    await repository.createLibrary("待删除", "delete-me");
    await repository.createLibrary("保留库", "keep-me");
    const opened = await repository.open("delete-me");
    await repository.execute(opened.context, createKnowledgeEntity("delete-me", "workspace", "专题"));
    const membership = (await database.knowledgeBackupScopes.get(owner))!.membershipGeneration;
    await repository.deleteLibrary(opened.context);
    expect((await database.knowledgeBackupScopes.get(owner))!.membershipGeneration).toBe(membership + 1);
    expect(await database.knowledgeLibraries.get("delete-me")).toBeUndefined();
    expect(await database.knowledgeLibraries.get("keep-me")).toBeDefined();
    expect(await database.knowledgeWorkspaces.where("libraryId").equals("delete-me").count()).toBe(0);
    expect(await database.blocks.get("ordinary")).toMatchObject({ id: "ordinary", title: "原日志" });
  });
  it("purges local knowledge trash but blocks cloud-linked purge", async () => {
    await repository.createLibrary("本机库", "trash-local");
    const opened = await repository.open("trash-local");
    const command = createKnowledgeEntity("trash-local", "workspace", "待清空专题");
    await repository.execute(opened.context, command);
    const current = await repository.open("trash-local");
    await repository.execute(current.context, editKnowledgeEntity("trash-local", current.state, current.state.entities[command.entity.id], "deleted", true));
    expect(await repository.purgeLocalTrash(current.context)).toBe(1);
    expect((await repository.open("trash-local")).state.entities[command.entity.id]).toBeUndefined();
    await database.knowledgeLibraries.update("trash-local", { cloudLibraryId: "cloud-1" });
    const cloud = await repository.open("trash-local");
    await expect(repository.purgeLocalTrash(cloud.context)).rejects.toMatchObject({ code: "invalid" });
    await expect(repository.deleteLibrary(cloud.context)).rejects.toMatchObject({ code: "invalid" });
  });
  it("protects a recovery library while blocked commands still reference it", async () => {
    await repository.createLibrary("账号库", "account-library");
    await repository.createLibrary("恢复副本", "recovery-library", true);
    await database.knowledgeCommands.put({ libraryId: "account-library", id: "blocked-command", command: topic("account-library"), hash: "a".repeat(64), status: "blocked", blockedReason: "stale", recoveryLibraryId: "recovery-library", localSequence: 1 });
    const recovery = await repository.open("recovery-library");
    await expect(repository.deleteLibrary(recovery.context)).rejects.toMatchObject({ code: "protected" });
    await expect(repository.purgeLocalTrash(recovery.context)).rejects.toMatchObject({ code: "protected" });
    await expect(repository.execute(recovery.context, topic("recovery-library"))).rejects.toMatchObject({ code: "protected" });
    const origin = await repository.open("account-library");
    await expect(repository.abandonMissingRecovery(origin.context, "blocked-command", "a".repeat(64))).rejects.toMatchObject({ code: "stale" });
    expect(await database.knowledgeLibraries.get("recovery-library")).toBeDefined();
    await database.knowledgeCommands.delete(["account-library", "blocked-command"]);
    await expect(repository.deleteLibrary(recovery.context)).resolves.toBeUndefined();
    expect(await database.knowledgeLibraries.get("recovery-library")).toBeUndefined();
  });
  it("purges whole deleted branches, preserves archives and moved-out nodes, and invalidates captured drafts", async () => {
    await repository.createLibrary("本机库", "tree-trash");
    const baseline = await repository.open("tree-trash");
    const root = createKnowledgeEntity("tree-trash", "workspace", "保留专题");
    const archive = createKnowledgeEntity("tree-trash", "workspace", "归档专题");
    await repository.execute(baseline.context, root);
    await repository.execute(baseline.context, archive);
    const branch = createKnowledgeEntity("tree-trash", "node", "待删除分支", root.entity.id);
    const child = createKnowledgeEntity("tree-trash", "node", "子节点", root.entity.id, branch.entity.id);
    const survivor = createKnowledgeEntity("tree-trash", "node", "保留节点", root.entity.id);
    for (const command of [branch, child, survivor]) await repository.execute(baseline.context, command);
    await repository.execute(baseline.context, createKnowledgeEntity("tree-trash", "reference", "", root.entity.id, "@root", "ordinary", child.entity.id));
    let current = await repository.open("tree-trash");
    await repository.saveDraft(current.context, { libraryId: "tree-trash", id: "child-draft", entityId: child.entity.id, unit: "note", text: "草稿", expectedRevision: current.state.entities[child.entity.id].units.note!, dataGeneration: current.context.dataGeneration });
    await repository.execute(current.context, editKnowledgeEntity("tree-trash", current.state, current.state.entities[archive.entity.id], "archived", true));
    await repository.execute(current.context, editKnowledgeEntity("tree-trash", current.state, current.state.entities[branch.entity.id], "deleted", true));
    expect(await repository.purgeLocalTrash(current.context)).toBe(3);
    await expect(repository.assertContext(current.context)).rejects.toMatchObject({ code: "stale" });
    current = await repository.open("tree-trash");
    expect(Object.keys(current.state.entities).sort()).toEqual([root.entity.id, archive.entity.id, survivor.entity.id].sort());
    expect(await database.knowledgeDrafts.count()).toBe(0);
    expect((await database.knowledgeCommands.toArray()).every(entry => !!current.state.entities[entry.command.entity.id])).toBe(true);
    await expect(capturePortableKnowledge(database, owner)).resolves.toMatchObject({ version: 1 });
    expect(await repository.purgeLocalTrash(current.context)).toBe(0);
    await repository.execute(current.context, editKnowledgeEntity("tree-trash", current.state, current.state.entities[root.entity.id], "deleted", true));
    expect(await repository.purgeLocalTrash(current.context)).toBe(2);
    expect(Object.keys((await repository.open("tree-trash")).state.entities)).toEqual([archive.entity.id]);
    await expect(capturePortableKnowledge(database, owner)).resolves.toMatchObject({ version: 1 });
  });
  it("rolls back a partially cleared library when a delete fails", async () => {
    await repository.createLibrary("保留", "rollback-delete");
    const opened = await repository.open("rollback-delete");
    await repository.execute(opened.context, createKnowledgeEntity("rollback-delete", "workspace", "保留专题"));
    vi.spyOn(database.knowledgeLibraries, "delete").mockRejectedValueOnce(new Error("disk failure"));
    await expect(repository.deleteLibrary(opened.context)).rejects.toThrow("disk failure");
    expect(await database.knowledgeWorkspaces.count()).toBe(1);
    expect(await database.knowledgeLibraries.count()).toBe(1);
    expect(await database.knowledgeCommands.count()).toBe(1);
  });
});
