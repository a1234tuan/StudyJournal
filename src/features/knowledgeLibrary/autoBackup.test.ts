import "fake-indexeddb/auto";
import Dexie from "dexie";
import { indexedDB, IDBKeyRange } from "fake-indexeddb";
import { beforeEach, afterEach, describe, expect, it } from "vitest";
import { db } from "../../db/database";
import { storage } from "../../services/storageAdapter";
import { KnowledgeRepository } from "./repository";
import { changeKnowledgeOwner, currentKnowledgeOwner, knowledgeContextGeneration } from "./context";
import { authorizeKnowledgeBackup, freezeKnowledgeBackup, completeKnowledgeBackup } from "./autoBackup";
import type { AutoBackupAdapter } from "../../services/autoBackupAdapter";
import { flushAutoBackupNow } from "../../services/autoBackupService";
import { knowledgeHash } from "./canonical";
import { isKnowledgeBackupPending } from "./runtime";

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

  describe("backup concurrency against membership and write timing", () => {
    const enableKnowledgeAutoBackup = async (owner: string) => {
      const scope = await db.knowledgeBackupScopes.get(owner);
      if (!scope) throw new Error("missing scope");
      await db.knowledgeBackupScopes.put({
        ...scope,
        autoBackupState: { enabled: true, debounceMs: 600_000 },
      });
    };

    it("P5-T1 keeps a library created during the write pending, and acknowledges it only in the next round", async () => {
      const repository = new KnowledgeRepository(db, currentKnowledgeOwner, knowledgeContextGeneration);
      changeKnowledgeOwner("account:A");
      await repository.createLibrary("first", "first");
      await authorizeKnowledgeBackup();
      await enableKnowledgeAutoBackup("account:A");

      // Round 0 archives the library set as it stands, so the baseline is clean.
      await completeKnowledgeBackup(await freezeKnowledgeBackup());
      expect(await isKnowledgeBackupPending()).toBe(false);

      // Round 1: capture, then the library set changes while the archive is being written.
      const firstCapture = await freezeKnowledgeBackup();
      await repository.createLibrary("added-mid-write", "added");
      expect(await isKnowledgeBackupPending()).toBe(true);

      await completeKnowledgeBackup(firstCapture);

      // The library created during the write had no captured generation, so it stays pending rather
      // than being silently covered by an archive that never contained it.
      expect((await db.knowledgeBackupScopes.get("account:A"))?.capturedGenerations).toEqual({ first: 1 });
      expect(await isKnowledgeBackupPending()).toBe(true);

      // Round 2 archives the current set and only then is everything acknowledged.
      const secondCapture = await freezeKnowledgeBackup();
      expect(secondCapture.selectedLibraryIds.sort()).toEqual(["added", "first"]);
      await completeKnowledgeBackup(secondCapture);
      expect(await isKnowledgeBackupPending()).toBe(false);
    });

    it("P5-T2 keeps a library that changed after the capture pending", async () => {
      const repository = new KnowledgeRepository(db, currentKnowledgeOwner, knowledgeContextGeneration);
      changeKnowledgeOwner("account:A");
      const created = await repository.createLibrary("edited", "edited");
      await authorizeKnowledgeBackup();
      await enableKnowledgeAutoBackup("account:A");

      const capture = await freezeKnowledgeBackup();
      // Same library, new content: the archive captured generation 1, disk moves on to 2.
      const opened = await repository.open(created.id);
      await repository.renameLibrary(opened.context, "edited again");
      await completeKnowledgeBackup(capture);

      expect(await isKnowledgeBackupPending()).toBe(true);
      const retry = await freezeKnowledgeBackup();
      await completeKnowledgeBackup(retry);
      expect(await isKnowledgeBackupPending()).toBe(false);
    });

    it("P5-T3 leaves the acknowledgement unchanged when the completion receipt fails, and allows a retry", async () => {
      const repository = new KnowledgeRepository(db, currentKnowledgeOwner, knowledgeContextGeneration);
      changeKnowledgeOwner("account:A");
      await repository.createLibrary("kept", "kept");
      await authorizeKnowledgeBackup();
      await enableKnowledgeAutoBackup("account:A");

      const capture = await freezeKnowledgeBackup();
      // The destination is rebound between the write and the receipt, so the receipt is refused.
      await authorizeKnowledgeBackup();

      await expect(completeKnowledgeBackup(capture)).rejects.toThrow();
      expect((await db.knowledgeBackupScopes.get("account:A"))?.capturedGenerations).toEqual({});

      const retry = await freezeKnowledgeBackup();
      await completeKnowledgeBackup(retry);
      expect((await db.knowledgeBackupScopes.get("account:A"))?.capturedGenerations).toEqual({ kept: 1 });
      expect(await isKnowledgeBackupPending()).toBe(false);
    });

    it("P5-T4 refuses a completion whose owner changed while the write was running", async () => {
      const repository = new KnowledgeRepository(db, currentKnowledgeOwner, knowledgeContextGeneration);
      changeKnowledgeOwner("account:A");
      await repository.createLibrary("a-only", "a-only");
      await authorizeKnowledgeBackup();

      const capture = await freezeKnowledgeBackup();
      changeKnowledgeOwner("account:B");
      await authorizeKnowledgeBackup();

      await expect(completeKnowledgeBackup(capture)).rejects.toThrow();
      expect((await db.knowledgeBackupScopes.get("account:A"))?.capturedGenerations).toEqual({});
      expect((await db.knowledgeBackupScopes.get("account:B"))?.capturedGenerations).toEqual({});
    });

    it("P5-T4b refuses the completion receipt after a pure owner switch that never re-authorizes", async () => {
      const repository = new KnowledgeRepository(db, currentKnowledgeOwner, knowledgeContextGeneration);
      changeKnowledgeOwner("account:A");
      await repository.createLibrary("a-only", "a-only");
      await authorizeKnowledgeBackup();
      await enableKnowledgeAutoBackup("account:A");

      // P5-T4 re-authorizes as B, so its rejection comes from the consent-revoke branch. This case
      // isolates the owner-drift branch the four-condition acknowledgement guard cannot see:
      // nothing rebinds the destination, only the owner changes while the archive is being written.
      let wroteDuringSwitch = false;
      const adapter: AutoBackupAdapter = {
        isAvailable: () => true,
        bindFolder: async () => ({ folderName: "backup" }),
        isBound: async () => ({ bound: true, folderName: "backup" }),
        writeLatest: async () => {
          changeKnowledgeOwner("account:B");
          wroteDuringSwitch = true;
          return { size: 1024 };
        },
      };
      const next = await flushAutoBackupNow("manual", adapter, storage);
      expect(wroteDuringSwitch).toBe(true);
      // The owner changed mid-write, so the catch path returns the pre-read state without saving.
      expect(next.enabled).toBe(true);
      expect(next.lastError).toBeUndefined();
      // Without the pre-receipt owner assertion, this receipt would have committed to A's row.
      expect((await db.knowledgeBackupScopes.get("account:A"))?.capturedGenerations).toEqual({});
      expect(await isKnowledgeBackupPending("account:A")).toBe(true);
    });

    it("P5-T5 keeps the archive pending when a captured library is deleted after the capture", async () => {
      const repository = new KnowledgeRepository(db, currentKnowledgeOwner, knowledgeContextGeneration);
      changeKnowledgeOwner("account:A");
      const kept = await repository.createLibrary("kept", "kept");
      const doomed = await repository.createLibrary("doomed", "doomed");
      await authorizeKnowledgeBackup();
      await enableKnowledgeAutoBackup("account:A");

      const capture = await freezeKnowledgeBackup();
      expect(capture.selectedLibraryIds.sort()).toEqual(["doomed", "kept"]);
      await completeKnowledgeBackup(capture);
      expect(await isKnowledgeBackupPending()).toBe(false);

      const opened = await repository.open(doomed.id);
      await repository.deleteLibrary(opened.context);

      // The acknowledged set no longer matches the live set, so the archive is stale again.
      expect(await isKnowledgeBackupPending()).toBe(true);
      const retry = await freezeKnowledgeBackup();
      await completeKnowledgeBackup(retry);
      expect((await db.knowledgeBackupScopes.get("account:A"))?.capturedGenerations["doomed"]).toBeUndefined();
      expect((await db.knowledgeBackupScopes.get("account:A"))?.capturedGenerations).toHaveProperty("kept");
      expect(await isKnowledgeBackupPending()).toBe(false);
    });
  });
});
