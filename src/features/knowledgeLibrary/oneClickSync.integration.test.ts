import Dexie from "dexie";
import { indexedDB, IDBKeyRange } from "fake-indexeddb";
import { afterEach, describe, expect, it } from "vitest";
import { StudyJournalDatabase } from "../../db/database";
import { KnowledgeError, type KnowledgeOwner } from "./domain";
import { KnowledgeRepository, readKnowledgeState } from "./repository";
import { KnowledgeSync, type KnowledgeTransport } from "./sync";
import { synchronizeKnowledge } from "./oneClickSync";
import { getDefaultKnowledgeLibrary } from "./defaultLibrary";
import { createKnowledgeEntity, editKnowledgeEntity } from "./commands";
import { valueOf } from "./protocol";
import { knowledgeHash } from "./canonical";
import { registerDefaultLibrary, type KnowledgeRegistry } from "./scope";
import { capturePortableKnowledge } from "./backup";
import { prepareKnowledgeImport, resumeKnowledgeImport } from "./import";
import { KNOWLEDGE_SYNC_LEASE_MS } from "./migration";
import type { KnowledgeCloudPacket } from "./cloudProtocol";

Dexie.dependencies.indexedDB = indexedDB;
Dexie.dependencies.IDBKeyRange = IDBKeyRange;
const databases: StudyJournalDatabase[] = [];
afterEach(async () => { for (const database of databases.splice(0)) await database.delete(); });
const device = async (owner: KnowledgeOwner = "account:owner") => {
  const database = new StudyJournalDatabase("one-click-" + crypto.randomUUID());
  databases.push(database); await database.open();
  return new KnowledgeRepository(database, () => owner);
};
class Cloud implements KnowledgeTransport {
  registry: KnowledgeRegistry | null = null;
  packets: KnowledgeCloudPacket[] = [];
  loseResponse = false;
  denied = false;
  corrupt = false;
  beforePublish?: () => void;
  async discover() { if (this.denied) throw { code: "permission-denied" }; return this.registry; }
  async register(libraryId: string, requestId: string) { this.registry = registerDefaultLibrary(this.registry, libraryId, requestId); return this.registry; }
  async head() { if (this.corrupt) throw new KnowledgeError("missing", "head missing"); return this.packets.length; }
  async commits(_libraryId: string, after: number, through: number) { return structuredClone(this.packets.slice(after, Math.min(through, after + 20))); }
  async receipt(_libraryId: string, commandId: string) { return this.packets.find(packet => packet.receipt.commandId === commandId)?.receipt ?? null; }
  async publish(libraryId: string, head: number, packet: KnowledgeCloudPacket) {
    this.beforePublish?.();
    const receipt = await this.receipt(libraryId, packet.receipt.commandId);
    if (receipt) { if (receipt.commandHash !== packet.receipt.commandHash) throw new KnowledgeError("receipt", "hash mismatch"); return receipt; }
    if (head !== this.packets.length) throw new KnowledgeError("stale", "head changed");
    this.packets.push(structuredClone(packet));
    if (this.loseResponse) { this.loseResponse = false; throw { code: "unavailable" }; }
    return packet.receipt;
  }
}
const sync = (repository: KnowledgeRepository, cloud: Cloud, options = {}) => synchronizeKnowledge(new KnowledgeSync(repository, cloud), options);
const local = async (repository: KnowledgeRepository, id = "local", title = "高等数学", detached = false) => {
  const library = await repository.createLibrary(title, id, detached);
  const opened = await repository.open(library.id);
  const topic = createKnowledgeEntity(id, "workspace", title);
  await repository.execute(opened.context, topic);
  const node = createKnowledgeEntity(id, "node", "多元函数微分", topic.entity.id);
  await repository.execute(opened.context, node);
  await repository.execute(opened.context, createKnowledgeEntity(id, "reference", "", topic.entity.id, undefined, "journal-record", node.entity.id));
  return opened.context;
};
const working = async (repository: KnowledgeRepository) => {
  const library = await getDefaultKnowledgeLibrary(repository.database, repository.currentOwner());
  return repository.open(library!.id);
};
const titles = (state: Awaited<ReturnType<typeof working>>["state"]) => Object.values(state.entities).filter(entity => entity.kind !== "reference").map(entity => valueOf(state, entity, "title"));

describe("one-click desktop and Android workflow", () => {
  it("MIG-07: resumes frozen explicit import steps even after the original source was deleted", async () => {
    const desktop = await device(); const cloud = new Cloud(); const source = await local(desktop);
    const target = await desktop.open((await new KnowledgeSync(desktop, cloud).connect()).library.id);
    await prepareKnowledgeImport(desktop, "local", target.context, "orphan-session");
    await desktop.deleteLibrary(source);
    expect(await sync(desktop, cloud)).toMatchObject({ status: "success", pending: 0 });
    expect(Object.keys((await working(desktop)).state.entities)).toHaveLength(3);
    expect(await desktop.database.knowledgeImportSessions.get([target.library.id, "orphan-session"])).toMatchObject({ status: "completed" });
  });
  it("NET-03: stops starting new commits after an operation is invalidated, and retries by receipt", async () => {
    const desktop = await device(); const cloud = new Cloud(); await local(desktop);
    let active = true;
    cloud.beforePublish = () => { active = false; };
    expect(await sync(desktop, cloud, { isCurrent: () => active })).toMatchObject({ status: "pending", error: { category: "cancelled" } });
    expect(cloud.packets).toHaveLength(1);
    cloud.beforePublish = undefined;
    expect(await sync(desktop, cloud)).toMatchObject({ status: "success" });
    expect(cloud.packets).toHaveLength(3);
  });
  it("NET-01: competing first registrations converge without losing either offline source", async () => {
    const desktop = await device(); const phone = await device(); const cloud = new Cloud();
    await local(desktop, "desktop-source", "电脑来源"); await local(phone, "phone-source", "手机来源");
    await Promise.all([sync(desktop, cloud), sync(phone, cloud)]);
    await sync(desktop, cloud); await sync(phone, cloud); await sync(desktop, cloud);
    expect((await working(desktop)).library.cloudLibraryId).toBe((await working(phone)).library.cloudLibraryId);
    expect(titles((await working(phone)).state)).toEqual(expect.arrayContaining(["电脑来源", "手机来源"]));
    expect((await working(phone)).state.entities).toEqual((await working(desktop)).state.entities);
  });
  it("FLOW-04: title, note, delete and restore converge without touching referenced journal rows", async () => {
    const desktop = await device(); const phone = await device(); const cloud = new Cloud(); await local(desktop);
    await desktop.database.blocks.put({ id: "journal-record", title: "原日志不变" } as never);
    await sync(desktop, cloud); await sync(phone, cloud);
    for (const [unit, value] of [["title", "改名"], ["note", "笔记"], ["deleted", true], ["deleted", false]] as const) {
      const opened = await working(desktop); const node = Object.values(opened.state.entities).find(entity => entity.kind === "node")!;
      await desktop.execute(opened.context, editKnowledgeEntity(opened.library.cloudLibraryId!, opened.state, node, unit, value));
      expect((await sync(desktop, cloud)).status).toBe("success");
      await sync(phone, cloud);
      expect((await working(phone)).state.entities).toEqual((await working(desktop)).state.entities);
    }
    expect(await desktop.database.blocks.get("journal-record")).toMatchObject({ title: "原日志不变" });
  });
  it("MIG-03: a stale executor cannot continue a local copy or release another executor's lease", async () => {
    const desktop = await device(); const cloud = new Cloud(); await local(desktop);
    let stolen = false;
    const original = desktop.execute.bind(desktop);
    desktop.execute = async (...args) => {
      if (!stolen && args[3]) {
        stolen = true;
        await desktop.database.knowledgeSyncBindings.update("account:owner", { leaseId: "replacement", leaseUntil: Date.now() + KNOWLEDGE_SYNC_LEASE_MS });
      }
      return original(...args);
    };
    expect(await sync(desktop, cloud)).toMatchObject({ status: "pending", error: { category: "cancelled" } });
    expect((await desktop.database.knowledgeSyncBindings.get("account:owner"))?.leaseId).toBe("replacement");
    expect((await desktop.database.knowledgeImportSessions.toArray())[0].next).toBe(0);
    expect(cloud.packets).toHaveLength(0);
  });
  it("MIG-04: a source added while uploads run is reported pending, never silently excluded as success", async () => {
    const desktop = await device(); const cloud = new Cloud(); await local(desktop);
    const publish = cloud.publish.bind(cloud); let added = false;
    cloud.publish = async (...args) => {
      if (!added) { added = true; await local(desktop, "late-source", "同步期间新增"); }
      return publish(...args);
    };
    expect(await sync(desktop, cloud)).toMatchObject({ status: "pending", message: expect.stringContaining("同步期间新增") });
    expect(await sync(desktop, cloud)).toMatchObject({ status: "success" });
    expect(titles((await working(desktop)).state)).toContain("同步期间新增");
  });
  it("FLOW-01/02/03/05: uploads local content, pulls on an empty phone and keeps later edits in the same default", async () => {
    const cloud = new Cloud(); const desktop = await device(); const phone = await device();
    const old = await local(desktop);
    expect(await sync(desktop, cloud)).toMatchObject({ status: "success", pending: 0, migrated: 1 });
    const first = await working(desktop);
    expect(first.library.id).not.toBe(old.libraryId);
    expect(titles(first.state)).toContain("多元函数微分");
    expect(await desktop.database.knowledgeLibraries.get(old.libraryId)).toBeDefined();
    expect(await desktop.database.knowledgeLibraryMigrations.get(["account:owner", old.libraryId])).toMatchObject({ phase: "confirmed" });
    const head = cloud.packets.length;
    expect(await sync(phone, cloud)).toMatchObject({ status: "success", uploaded: 0, downloaded: head });
    expect(cloud.packets).toHaveLength(head);
    expect((await working(phone)).state.entities).toEqual(first.state.entities);
    await desktop.createTopic("新增专题", { id: "later-topic", ownerScope: "account:owner", sessionGeneration: 0 });
    expect((await readKnowledgeState(desktop.database, old.libraryId)).entities["topic-later-topic"]).toBeUndefined();
    expect(await sync(desktop, cloud)).toMatchObject({ status: "success", uploaded: 1 });
    expect(await sync(phone, cloud)).toMatchObject({ status: "success", uploaded: 0 });
    expect((await working(phone)).state.entities).toEqual((await working(desktop)).state.entities);
    const finalHead = cloud.packets.length;
    expect(await sync(desktop, cloud)).toMatchObject({ status: "no-change" });
    expect(await sync(phone, cloud)).toMatchObject({ status: "no-change" });
    expect(cloud.packets).toHaveLength(finalHead);
    desktop.database.close(); await desktop.database.open();
    expect((await working(desktop)).library.id).toBe(first.library.id);
  });
  it("FLOW-06/MIG-01: fills an existing empty account library and includes all ordinary libraries, not recovery or other accounts", async () => {
    const cloud = new Cloud(); const desktop = await device();
    await new KnowledgeSync(desktop, cloud).connect();
    await local(desktop, "first", "甲"); await local(desktop, "second", "乙");
    await local(desktop, "recovery", "不上传恢复内容", true);
    await local(new KnowledgeRepository(desktop.database, () => "account:other"), "other", "不上传他人内容");
    expect(await sync(desktop, cloud)).toMatchObject({ status: "success", migrated: 2 });
    const state = (await working(desktop)).state;
    expect(titles(state)).toEqual(expect.arrayContaining(["甲", "乙"]));
    expect(JSON.stringify(cloud.packets)).not.toContain("不上传");
    expect(await desktop.database.knowledgeLibraries.get("recovery")).toBeDefined();
  });
  it("MIG-08: claims guest sources once and preserves backup membership", async () => {
    const desktop = await device(); const guest = new KnowledgeRepository(desktop.database, () => "deviceGuest");
    await local(guest, "guest");
    expect(await sync(desktop, new Cloud())).toMatchObject({ status: "success" });
    expect(await desktop.database.knowledgeLibraries.get("guest")).toMatchObject({ ownerScope: "account:owner" });
    expect(await desktop.database.knowledgeBackupScopes.get("deviceGuest")).toMatchObject({ membershipGeneration: 2 });
    const other = new KnowledgeRepository(desktop.database, () => "account:other"); const cloud = new Cloud();
    await sync(other, cloud);
    expect(cloud.packets).toHaveLength(0);
  });
  it("MIG-02/NET-02: resumes an upload whose response was lost without duplicating entities", async () => {
    const desktop = await device(); const cloud = new Cloud(); await local(desktop);
    cloud.loseResponse = true;
    expect(await sync(desktop, cloud)).toMatchObject({ status: "error", error: { category: "unavailable" } });
    expect(cloud.packets).toHaveLength(1);
    expect((await working(desktop)).library.cloudLibraryId).toBe(cloud.registry!.cloudLibraryId);
    desktop.database.close(); await desktop.database.open();
    expect(await sync(desktop, cloud)).toMatchObject({ status: "success", pending: 0 });
    expect(cloud.packets).toHaveLength(3);
    expect(Object.keys((await working(desktop)).state.entities)).toHaveLength(3);
    expect(await sync(desktop, cloud)).toMatchObject({ status: "no-change" });
  });
  it("MIG-02: persists a frozen copy and resumes after cancellation during local steps", async () => {
    const desktop = await device(); const cloud = new Cloud(); await local(desktop);
    let active = true;
    const interrupted = await sync(desktop, cloud, { isCurrent: () => active, onProgress: (message: string) => { if (message.includes("1 / 3")) active = false; } });
    expect(interrupted).toMatchObject({ status: "pending", error: { category: "cancelled" } });
    expect(cloud.packets).toHaveLength(0);
    expect(await desktop.database.knowledgeImportSessions.toArray()).toEqual([expect.objectContaining({ next: 1, total: 3 })]);
    expect(await sync(desktop, cloud)).toMatchObject({ status: "success", pending: 0 });
    expect(cloud.packets).toHaveLength(3);
    expect(await desktop.database.knowledgeImportSteps.count()).toBe(0);
  });
  it("MIG-04: fences old writes but preserves their original facts and drafts", async () => {
    const desktop = await device(); const cloud = new Cloud(); const old = await local(desktop);
    const before = await desktop.open(old.libraryId); const entity = Object.values(before.state.entities).find(item => item.kind === "node")!;
    await desktop.saveDraft(old, { ...old, id: entity.id + ":note", entityId: entity.id, unit: "note", text: "未提交草稿", expectedRevision: entity.units.note! });
    await sync(desktop, cloud);
    await expect(desktop.execute(old, editKnowledgeEntity(old.libraryId, before.state, entity, "title", "旧页写入"))).rejects.toMatchObject({ code: "stale" });
    const reopened = await desktop.open(old.libraryId);
    await expect(desktop.execute(reopened.context, editKnowledgeEntity(old.libraryId, reopened.state, entity, "title", "新上下文写入"))).rejects.toMatchObject({ code: "migration" });
    expect(await desktop.database.knowledgeDrafts.get([old.libraryId, entity.id + ":note"])).toMatchObject({ text: "未提交草稿" });
    expect(JSON.stringify(cloud.packets)).not.toContain("未提交草稿");
    const envelope = await capturePortableKnowledge(desktop.database, "account:owner");
    expect(envelope.libraries).toHaveLength(2);
    expect(JSON.stringify(envelope)).not.toMatch(/leaseId|sourceHash|ownerScope|localLibraryId/);
  });
  it("MIG-03: rejects another active local executor and can recover an expired lease", async () => {
    const desktop = await device(); const cloud = new Cloud(); await local(desktop);
    await desktop.database.knowledgeSyncBindings.put({ ownerScope: "account:owner", localLibraryId: null, cloudLibraryId: null, policyVersion: 1, generation: 0, leaseId: "other", leaseUntil: Date.now() + KNOWLEDGE_SYNC_LEASE_MS });
    expect(await sync(desktop, cloud)).toMatchObject({ status: "pending", error: { category: "busy" } });
    expect(cloud.registry).toBeNull();
    await desktop.database.knowledgeSyncBindings.update("account:owner", { leaseUntil: 0 });
    expect(await sync(desktop, cloud)).toMatchObject({ status: "success" });
  });
  it("MIG-05: identical source snapshots on two devices reuse command identities and cloud receipts", async () => {
    const desktop = await device(); const phone = await device(); const cloud = new Cloud(); await local(desktop);
    for (const table of desktop.database.tables.filter(table => table.name.startsWith("knowledge") && !["knowledgeSyncBindings", "knowledgeLibraryMigrations"].includes(table.name))) {
      const rows = await table.toArray(); if (rows.length) await phone.database.table(table.name).bulkPut(rows);
    }
    expect(await sync(desktop, cloud)).toMatchObject({ status: "success" });
    const head = cloud.packets.length;
    expect(await sync(phone, cloud)).toMatchObject({ status: "success", uploaded: 0 });
    expect(cloud.packets).toHaveLength(head);
    expect((await working(phone)).state.entities).toEqual((await working(desktop)).state.entities);
  });
  it("MIG-07: reuses an already completed explicit copy instead of importing it twice", async () => {
    const desktop = await device(); const cloud = new Cloud(); await local(desktop);
    const target = await desktop.open((await new KnowledgeSync(desktop, cloud).connect()).library.id);
    await prepareKnowledgeImport(desktop, "local", target.context, "old-copy");
    await resumeKnowledgeImport(desktop, target.context, "old-copy");
    expect(await sync(desktop, cloud)).toMatchObject({ status: "success" });
    expect(Object.keys((await working(desktop)).state.entities)).toHaveLength(3);
    expect(await desktop.database.knowledgeImportSessions.count()).toBe(1);
  });
  it("MIG-07: refuses to silently lose edits made after an earlier explicit copy", async () => {
    const desktop = await device(); const cloud = new Cloud(); const source = await local(desktop);
    const target = await desktop.open((await new KnowledgeSync(desktop, cloud).connect()).library.id);
    await prepareKnowledgeImport(desktop, "local", target.context, "old-copy"); await resumeKnowledgeImport(desktop, target.context, "old-copy");
    await desktop.execute(source, createKnowledgeEntity("local", "workspace", "复制后的新内容"));
    expect(await sync(desktop, cloud)).toMatchObject({ status: "needs-attention", error: { category: "migration" } });
    expect(titles((await desktop.open("local")).state)).toContain("复制后的新内容");
    expect(await desktop.database.knowledgeLibraryMigrations.count()).toBe(0);
  });
  it("AUTH-01/MIG-10: permission or missing head failures never freeze or erase local content", async () => {
    const desktop = await device(); const cloud = new Cloud(); const context = await local(desktop);
    const before = knowledgeHash((await desktop.open("local")).state);
    cloud.denied = true;
    expect(await sync(desktop, cloud)).toMatchObject({ status: "error", error: { category: "permission-denied" } });
    cloud.denied = false; cloud.corrupt = true;
    expect(await sync(desktop, cloud)).toMatchObject({ status: "error", error: { category: "missing" } });
    expect(await desktop.database.knowledgeLibraryMigrations.count()).toBe(0);
    expect(knowledgeHash((await desktop.open("local")).state)).toBe(before);
    await expect(desktop.assertContext(context)).resolves.toBeDefined();
  });
  it("NET-04: preserves offline same-field edits on both devices instead of claiming all is resolved", async () => {
    const desktop = await device(); const phone = await device(); const cloud = new Cloud(); await local(desktop);
    await sync(desktop, cloud); await sync(phone, cloud);
    for (const [repository, text] of [[desktop, "电脑版本"], [phone, "手机版本"]] as const) {
      const opened = await working(repository); const node = Object.values(opened.state.entities).find(entity => entity.kind === "node")!;
      await repository.execute(opened.context, editKnowledgeEntity(opened.library.cloudLibraryId!, opened.state, node, "title", text));
    }
    await sync(desktop, cloud);
    expect(await sync(phone, cloud)).toMatchObject({ status: "needs-attention", pending: 0 });
    expect(await sync(desktop, cloud)).toMatchObject({ status: "needs-attention", pending: 0 });
    const text = JSON.stringify((await working(desktop)).state);
    expect(text).toContain("电脑版本"); expect(text).toContain("手机版本");
  });
});
