import Dexie from "dexie";
import { indexedDB, IDBKeyRange } from "fake-indexeddb";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { StudyJournalDatabase } from "../../db/database";
import { DAILY_PLAN_SCHEMA_24_STORES } from "../../db/reviewCoachSchema";
import type { KnowledgeCommand, KnowledgeOwner } from "./domain";
import { KnowledgeRepository } from "./repository";

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
      expect(upgraded.verno).toBe(25);
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
