import "fake-indexeddb/auto";
import Dexie from "dexie";
import { indexedDB, IDBKeyRange } from "fake-indexeddb";
import { beforeEach, afterEach, describe, expect, it } from "vitest";
import { db } from "../../db/database";
import { storage } from "../../services/storageAdapter";
import { KnowledgeRepository } from "./repository";
import { changeKnowledgeOwner, currentKnowledgeOwner, knowledgeContextGeneration } from "./context";
import { authorizeKnowledgeBackup, freezeKnowledgeBackup, completeKnowledgeBackup } from "./autoBackup";
import { knowledgeHash } from "./canonical";

Dexie.dependencies.indexedDB = indexedDB;
Dexie.dependencies.IDBKeyRange = IDBKeyRange;
beforeEach(async () => { await db.open(); changeKnowledgeOwner("deviceGuest"); });
afterEach(async () => { await db.delete(); changeKnowledgeOwner("deviceGuest"); });
describe("knowledge backup identity integration", () => {
  it("captures all and only the owner libraries with the snapshot in one transaction", async () => {
    const repository = new KnowledgeRepository(db, currentKnowledgeOwner, knowledgeContextGeneration);
    await repository.createLibrary("guest", "guest");
    changeKnowledgeOwner("account:A");
    await repository.createLibrary("cloud", "cloud");
    await repository.createLibrary("detached", "detached", true);
    await authorizeKnowledgeBackup();
    const captured = await db.transaction("r", db.tables, async () => ({ token: await freezeKnowledgeBackup(), snapshot: await storage.createSnapshot() }));
    expect(captured.token.selectedLibraryIds).toEqual(["cloud", "detached"]);
    expect(captured.snapshot.payload.knowledge?.libraries.map(library => library.archiveLibraryId).sort()).toEqual(["cloud", "detached"].map(id => "archive-" + knowledgeHash(id)).sort());
    await repository.createLibrary("new", "new");
    changeKnowledgeOwner("account:B");
    await completeKnowledgeBackup(captured.token);
    expect((await db.knowledgeBackupScopes.get("account:A"))?.capturedGenerations).toEqual({ cloud: 1, detached: 1 });
    expect(await db.knowledgeBackupScopes.get("account:B")).toBeUndefined();
  });
  it("requires renewed consent when the global folder is rebound and rejects old destination acknowledgments", async () => {
    changeKnowledgeOwner("account:A"); await authorizeKnowledgeBackup();
    const oldToken = await freezeKnowledgeBackup();
    changeKnowledgeOwner("account:B"); await authorizeKnowledgeBackup();
    expect((await db.knowledgeBackupScopes.get("account:A"))?.consented).toBe(false);
    await expect(completeKnowledgeBackup(oldToken)).rejects.toThrow();
    changeKnowledgeOwner("account:A"); await expect(freezeKnowledgeBackup()).rejects.toThrow();
    await authorizeKnowledgeBackup();
    expect((await freezeKnowledgeBackup()).destinationId).not.toBe(oldToken.destinationId);
  });
  it("rejects an A to B to A stale callback even before async owner invalidation", async () => {
    changeKnowledgeOwner("account:A");
    const repository = new KnowledgeRepository(db, currentKnowledgeOwner, knowledgeContextGeneration);
    await repository.createLibrary("A", "library");
    const opened = await repository.open("library");
    changeKnowledgeOwner("account:B"); changeKnowledgeOwner("account:A");
    await expect(repository.assertContext(opened.context)).rejects.toThrow();
    await expect(repository.open("library")).resolves.toBeDefined();
  });
});
