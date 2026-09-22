import { describe, expect, it } from "vitest";
import type { KnowledgeBackupScope, KnowledgeLibrary, KnowledgeOwner } from "./domain";
import { acknowledgeKnowledgeBackup, captureKnowledgeBackupScope, emptyDetachedLibrary, registerDefaultLibrary } from "./scope";

const library = (id: string, ownerScope: KnowledgeOwner, detached = false): KnowledgeLibrary => ({ id, ownerScope, detached, title: id, cloudLibraryId: detached ? null : id, restoreSessionId: null, archiveLibraryId: null });
const scope = (ownerScope: KnowledgeOwner): KnowledgeBackupScope => ({ ownerScope, scopeEpoch: 1, membershipGeneration: 1, destinationId: "opaque-" + (ownerScope === "account:A" ? "one" : "two"), consented: true, capturedGenerations: {} });

describe("knowledge binding, restore and ownership contracts", () => {
  it("BIND-01: a serialized first-registration race selects one default without replacing the winner", () => {
    const winner = registerDefaultLibrary(null, "phone", "request-phone");
    expect(registerDefaultLibrary(winner, "desktop", "request-desktop")).toBe(winner);
    expect(registerDefaultLibrary(winner, "phone", "request-phone")).toBe(winner);
    expect(() => registerDefaultLibrary({ ...winner, protocolVersion: 2 as 1 }, "new", "new-request")).toThrow();
  });
  it("EMPTY-01: explicit empty restore creates an owner-scoped detached copy, not a command clearing the original", () => {
    const original = library("cloud-with-100-nodes", "account:A");
    const restored = emptyDetachedLibrary("session-1", "account:A");
    expect(restored.cloudLibraryId).toBeNull();
    expect(restored.detached).toBe(true);
    expect(restored.id).not.toBe(original.id);
    expect(emptyDetachedLibrary("session-1", "account:A")).toEqual(restored);
    expect(emptyDetachedLibrary("session-2", "account:A").id).not.toBe(restored.id);
    expect(original).toEqual(library("cloud-with-100-nodes", "account:A"));
  });
  it("SCOPE-01/03: captures all and only the current owners libraries independent of the viewed library", () => {
    const libraries = [library("A-cloud", "account:A"), library("A-copy", "account:A", true), library("B-cloud", "account:B"), library("guest", "deviceGuest")];
    const token = captureKnowledgeBackupScope(scope("account:A"), libraries, { "A-cloud": 3, "A-copy": 5 });
    expect(token.selectedLibraryIds).toEqual(["A-cloud", "A-copy"]);
    expect(token.capturedDirtyGenerations).toEqual({ "A-cloud": 3, "A-copy": 5 });
    const acknowledged = acknowledgeKnowledgeBackup(scope("account:A"), token, token.destinationId);
    expect(acknowledged.capturedGenerations["A-copy"]).toBe(5);
    expect(acknowledged.capturedGenerations["A-copy"]).toBeLessThan(6);
    expect(token.selectedLibraryIds).not.toContain("new-copy-created-after-capture");
  });
  it("SCOPE-02/04: refuses destination/account substitution and requires explicit consent", () => {
    const original = scope("account:A");
    const token = captureKnowledgeBackupScope(original, [library("A-cloud", "account:A")], { "A-cloud": 3 });
    expect(() => acknowledgeKnowledgeBackup(scope("account:B"), token, token.destinationId)).toThrow();
    expect(() => acknowledgeKnowledgeBackup(original, token, "new-destination")).toThrow();
    expect(() => captureKnowledgeBackupScope({ ...original, consented: false }, [], {})).toThrow();
    expect(() => acknowledgeKnowledgeBackup({ ...original, consented: false }, token, token.destinationId)).toThrow();
    expect(acknowledgeKnowledgeBackup({ ...original, scopeEpoch: 2 }, token, token.destinationId).ownerScope).toBe("account:A");
  });
});
