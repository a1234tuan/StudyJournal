import Dexie from "dexie";
import { indexedDB, IDBKeyRange } from "fake-indexeddb";
import { afterEach, describe, expect, it } from "vitest";
import { StudyJournalDatabase } from "../../db/database";
import { canonicalKnowledge, knowledgeHash } from "./canonical";
import { KnowledgeError, type KnowledgeCommand } from "./domain";
import { editKnowledgeEntity } from "./commands";
import { capturePortableKnowledge } from "./backup";
import { valueOf } from "./protocol";
import { KnowledgeRepository } from "./repository";
import { KnowledgeSync, type KnowledgeTransport } from "./sync";
import { registerDefaultLibrary, type KnowledgeRegistry } from "./scope";
import type { KnowledgeCloudPacket, KnowledgeCloudReceipt } from "./cloudProtocol";

Dexie.dependencies.indexedDB = indexedDB;
Dexie.dependencies.IDBKeyRange = IDBKeyRange;
const databases: StudyJournalDatabase[] = [];
afterEach(async () => { for (const database of databases.splice(0)) await database.delete(); });
const device = async () => { const database = new StudyJournalDatabase("knowledge-device-" + crypto.randomUUID()); databases.push(database); await database.open(); return new KnowledgeRepository(database, () => "account:owner"); };
class MemoryKnowledgeCloud implements KnowledgeTransport {
  registry: KnowledgeRegistry | null = null;
  packets: KnowledgeCloudPacket[] = [];
  writes = 0;
  loseNextResponse = false;
  async discover() { return this.registry; }
  async register(libraryId: string, requestId: string) { this.registry = registerDefaultLibrary(this.registry, libraryId, requestId); return this.registry; }
  async head() { return this.packets.length; }
  async commits(_libraryId: string, after: number, through: number) { return structuredClone(this.packets.slice(after, through)); }
  async receipt(_libraryId: string, commandId: string): Promise<KnowledgeCloudReceipt | null> { return this.packets.find(packet => packet.receipt.commandId === commandId)?.receipt ?? null; }
  async publish(_libraryId: string, expectedHead: number, packet: KnowledgeCloudPacket) {
    const existing = await this.receipt(_libraryId, packet.receipt.commandId);
    if (existing) { if (existing.commandHash !== packet.receipt.commandHash) throw new KnowledgeError("receipt", "different hash"); return existing; }
    if (expectedHead !== this.packets.length) throw new KnowledgeError("stale", "head changed");
    this.packets.push(structuredClone(packet)); this.writes += 1;
    if (this.loseNextResponse) { this.loseNextResponse = false; throw new Error("lost response"); }
    return packet.receipt;
  }
}
const topic = (libraryId: string): KnowledgeCommand => ({ protocolVersion: 1, id: "topic-create", libraryId, operation: "create", entity: { id: "topic", kind: "workspace", workspaceId: "topic", nodeId: "", recordId: "" }, expected: { title: null, note: null, archived: null, deleted: null }, changes: { title: "云专题", note: "原说明", archived: false, deleted: false } });

describe("knowledge independent-device sync", () => {
  it("persists corruption diagnostics, preserves pending work, and resumes only after trusted history repair", async () => {
    const cloud = new MemoryKnowledgeCloud();
    const writer = await device(); const reader = await device();
    const writerSync = new KnowledgeSync(writer, cloud); const readerSync = new KnowledgeSync(reader, cloud);
    const writerLibrary = (await writerSync.connect()).library;
    const readerLibrary = (await readerSync.connect()).library;
    const writerView = await writer.open(writerLibrary.id); const readerView = await reader.open(readerLibrary.id);
    const local = { ...topic(writerLibrary.cloudLibraryId!), id: "local-only", entity: { ...topic(writerLibrary.cloudLibraryId!).entity, id: "local-topic", workspaceId: "local-topic" } };
    await reader.execute(readerView.context, local);
    await writer.execute(writerView.context, topic(writerLibrary.cloudLibraryId!));
    await writerSync.synchronize(writerView.context);
    const valid = structuredClone(cloud.packets[0]);
    cloud.packets[0].commit.sequence = 8;
    await expect(readerSync.pull(readerView.context)).rejects.toMatchObject({ code: "corrupt" });
    expect((await reader.database.knowledgeSyncState.get(readerLibrary.id))?.failure).toMatchObject({ cursor: 0, attempts: 1 });
    const preservedId = await reader.preserveSyncFailure(readerView.context);
    await expect(readerSync.pull(readerView.context)).rejects.toMatchObject({ code: "corrupt" });
    expect(await reader.preserveSyncFailure(readerView.context)).toBe(preservedId);
    expect((await reader.open(preservedId)).state.entities["local-topic"]).toBeDefined();
    await expect(reader.deleteLibrary((await reader.open(preservedId)).context)).rejects.toMatchObject({ code: "protected" });
    expect(await reader.database.knowledgeCommands.where("libraryId").equals(readerLibrary.id).count()).toBe(1);
    cloud.packets[0] = valid;
    await readerSync.synchronize(readerView.context);
    expect((await reader.database.knowledgeSyncState.get(readerLibrary.id))?.failure).toBeUndefined();
    expect((await reader.open(readerLibrary.id)).state.entities["local-topic"]).toBeDefined();
    expect(await reader.database.knowledgeCommands.where("libraryId").equals(readerLibrary.id).count()).toBe(0);
  });

  it("rejects a semantically forged cloud packet without advancing the pull cursor", async () => {
    const cloud = new MemoryKnowledgeCloud();
    const phone = await device();
    await phone.createLibrary("手机", "phone-library");
    const sync = new KnowledgeSync(phone, cloud);
    await sync.connect("phone-library");
    const view = await phone.open("phone-library");
    await phone.execute(view.context, topic("phone-library"));
    await sync.synchronize(view.context);
    const forged = structuredClone(cloud.packets[0]);
    const row = forged.rows.find(candidate => candidate.collection === "entities")!;
    const slot = forged.commit.slots[row.data.slot];
    const entity = JSON.parse(row.data.payload) as Record<string, unknown>;
    (entity.units as Record<string, unknown>).title = 123;
    row.data.payload = canonicalKnowledge(entity);
    row.data.hash = knowledgeHash(entity);
    slot.payload = row.data.payload;
    slot.hash = row.data.hash;
    slot.bytes = new TextEncoder().encode(slot.payload).byteLength;
    forged.commit.budget = 16384 + forged.commit.slots.reduce((total, item) => total + item.bytes * (item.collection === "revisions" ? 2 : 4), 0);
    cloud.packets[0] = forged;
    await phone.database.knowledgeSyncState.update("phone-library", { cursor: 0 });
    await expect(sync.pull(view.context)).rejects.toThrow();
    expect((await phone.database.knowledgeSyncState.get("phone-library"))?.cursor).toBe(0);
  });

  it("retains a stale pending restore without blocking unrelated pull or upload", async () => {
    const cloud = new MemoryKnowledgeCloud();
    const phone = await device();
    await phone.createLibrary("手机", "phone-library");
    const phoneSync = new KnowledgeSync(phone, cloud);
    await phoneSync.connect("phone-library");
    const phoneView = await phone.open("phone-library");
    await phone.execute(phoneView.context, topic("phone-library"));
    let view = await phone.open("phone-library");
    await phone.execute(view.context, editKnowledgeEntity("phone-library", view.state, view.state.entities.topic, "deleted", true));
    await phoneSync.synchronize(view.context);
    const desktop = await device();
    const desktopSync = new KnowledgeSync(desktop, cloud);
    const connected = await desktopSync.connect();
    const desktopView = await desktop.open(connected.library.id);
    view = await phone.open("phone-library");
    const restore = editKnowledgeEntity("phone-library", view.state, view.state.entities.topic, "deleted", false);
    await phone.execute(view.context, restore);
    const remoteEdit: KnowledgeCommand = { ...topic("phone-library"), id: "remote-deleted-note", operation: "edit", expected: { note: "topic-create:note" }, changes: { note: "new hidden evidence" } };
    const { applyKnowledgeCommand } = await import("./protocol");
    const { knowledgeCloudPacket } = await import("./cloudProtocol");
    const { readKnowledgeRemote } = await import("./sync");
    const before = await readKnowledgeRemote(desktop.database, connected.library.id);
    await cloud.publish("phone-library", before.sequence, knowledgeCloudPacket(before, applyKnowledgeCommand(before, remoteEdit), remoteEdit));
    await phoneSync.pull(view.context);
    const after = await phone.open("phone-library");
    expect(valueOf(after.state, after.state.entities.topic, "deleted")).toBe(true);
    expect(valueOf(after.state, after.state.entities.topic, "note")).toBe("new hidden evidence");
    const blocked = await phone.database.knowledgeCommands.get(["phone-library", restore.id]);
    expect(blocked).toMatchObject({ status: "blocked" });
    const recovery = await phone.open(blocked!.recoveryLibraryId!);
    expect(valueOf(recovery.state, recovery.state.entities.topic, "deleted")).toBe(false);
    expect(recovery.library.cloudLibraryId).toBeNull();
    expect(after.state.revisions[restore.id + ":deleted"]).toBeDefined();
    await expect(capturePortableKnowledge(phone.database, "account:owner")).resolves.toBeDefined();
    await expect(phoneSync.synchronize(view.context)).resolves.toMatchObject({ uploaded: 0, pending: 1 });
    await desktopSync.pull(desktopView.context);
  });
  it("does not leave a consumed candidate projection behind after replay", async () => {
    const repository = await device();
    await repository.createLibrary("test", "local");
    const { knowledgeTables, readKnowledgeState, writeKnowledgeStateDelta } = await import("./repository");
    const { emptyKnowledgeState } = await import("./domain");
    const before = emptyKnowledgeState();
    before.candidates.stale = { id: "stale", groupId: "group", revisionId: "revision", consumedBy: null };
    await repository.database.knowledgeConflicts.put({ libraryId: "local", id: "stale", kind: "candidateProjection", value: before.candidates.stale });
    await repository.database.transaction("rw", knowledgeTables(repository.database), () => writeKnowledgeStateDelta(repository.database, "local", before, emptyKnowledgeState()));
    expect((await readKnowledgeState(repository.database, "local")).candidates).toEqual({});
  });

  it("BIND-02 and V1/V2: discovers one library, retains newer local pending edits and pure pulls never upload", async () => {
    const cloud = new MemoryKnowledgeCloud();
    const phone = await device();
    await phone.createLibrary("手机", "phone-library");
    const phoneSync = new KnowledgeSync(phone, cloud);
    await phoneSync.connect("phone-library");
    const phoneView = await phone.open("phone-library");
    await phone.execute(phoneView.context, topic("phone-library"));
    await phoneSync.synchronize(phoneView.context);
    const desktop = await device();
    const desktopSync = new KnowledgeSync(desktop, cloud);
    const connected = await desktopSync.connect();
    const desktopView = await desktop.open(connected.library.id);
    expect(desktopView.state.entities.topic).toBeDefined();
    expect(cloud.writes).toBe(1);
    const first: KnowledgeCommand = { ...topic("phone-library"), id: "phone-edit", operation: "edit", expected: { note: "topic-create:note" }, changes: { note: "phone first" } };
    const second: KnowledgeCommand = { ...first, id: "phone-second", expected: { note: "phone-edit:note" }, changes: { note: "phone second" } };
    await phone.execute(phoneView.context, first);
    await phone.execute(phoneView.context, second);
    const remote: KnowledgeCommand = { ...first, id: "desktop-edit", changes: { note: "desktop concurrent" } };
    await desktop.execute(desktopView.context, remote);
    await desktopSync.synchronize(desktopView.context);
    await phoneSync.synchronize(phoneView.context);
    await desktopSync.pull(desktopView.context);
    const phoneState = (await phone.open("phone-library")).state;
    const desktopState = (await desktop.open(connected.library.id)).state;
    expect(desktopState.entities).toEqual(phoneState.entities);
    expect(desktopState.candidates).toEqual(phoneState.candidates);
    expect(Object.values(phoneState.revisions).some(revision => revision.value === "phone second")).toBe(true);
    expect(await phone.database.knowledgeCommands.count()).toBe(0);
    const writes = cloud.writes;
    await phoneSync.pull(phoneView.context); await desktopSync.pull(desktopView.context);
    expect(cloud.writes).toBe(writes);
  });
  it("keeps concurrent delete and restore evidence immutable across local replay", async () => {
    const cloud = new MemoryKnowledgeCloud();
    const phone = await device();
    await phone.createLibrary("手机", "phone-library");
    const phoneSync = new KnowledgeSync(phone, cloud);
    await phoneSync.connect("phone-library");
    const phoneView = await phone.open("phone-library");
    await phone.execute(phoneView.context, topic("phone-library"));
    await phoneSync.synchronize(phoneView.context);
    const desktop = await device();
    const desktopSync = new KnowledgeSync(desktop, cloud);
    const connected = await desktopSync.connect();
    const desktopView = await desktop.open(connected.library.id);
    const deletion: KnowledgeCommand = { ...topic("phone-library"), id: "delete-phone", operation: "delete", expected: { deleted: "topic-create:deleted" }, changes: { deleted: true } };
    await phone.execute(phoneView.context, deletion);
    await desktop.execute(desktopView.context, { ...deletion, id: "delete-desktop" });
    await desktopSync.synchronize(desktopView.context);
    await phoneSync.synchronize(phoneView.context);
    await desktopSync.pull(desktopView.context);
    expect((await desktop.open(connected.library.id)).state.entities).toEqual((await phone.open("phone-library")).state.entities);
  });
  it("recovers unknown commits by receipt after restart without duplicate publish", async () => {
    const cloud = new MemoryKnowledgeCloud();
    const phone = await device();
    await phone.createLibrary("手机", "phone-library");
    const sync = new KnowledgeSync(phone, cloud);
    await sync.connect("phone-library");
    const view = await phone.open("phone-library");
    await phone.execute(view.context, topic("phone-library"));
    cloud.loseNextResponse = true;
    await expect(sync.synchronize(view.context)).rejects.toThrow("lost response");
    expect(await phone.database.knowledgeCommands.count()).toBe(1);
    await new KnowledgeSync(phone, cloud).synchronize(view.context);
    expect(await phone.database.knowledgeCommands.count()).toBe(0);
    expect(cloud.writes).toBe(1);
  });
  it("BIND-03: never merges nonempty offline libraries by name or deletes their source", async () => {
    const cloud = new MemoryKnowledgeCloud();
    await cloud.register("remote", "first");
    const desktop = await device();
    await desktop.createLibrary("数据结构", "offline");
    const before = await desktop.open("offline");
    await desktop.execute(before.context, topic("offline"));
    const connected = await new KnowledgeSync(desktop, cloud).connect("offline");
    expect(connected.importSourceId).toBe("offline");
    expect(connected.library.cloudLibraryId).toBe("remote");
    expect((await desktop.open("offline")).state.entities.topic).toBeDefined();
    expect((await desktop.open(connected.library.id)).state.entities).toEqual({});
    expect(cloud.writes).toBe(0);
  });
});
