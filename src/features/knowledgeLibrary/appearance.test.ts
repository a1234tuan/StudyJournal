import Dexie from "dexie";
import { indexedDB, IDBKeyRange } from "fake-indexeddb";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { StudyJournalDatabase } from "../../db/database";
import { KnowledgeRepository, knowledgeTables } from "./repository";
import { createKnowledgeEntity, editKnowledgeEntity } from "./commands";
import { applyKnowledgeCommand, validateKnowledgeCommand, validateKnowledgeState, valueOf } from "./protocol";
import { applyKnowledgeCloudPacket, knowledgeCloudPacket } from "./cloudProtocol";
import { emptyKnowledgeState } from "./domain";
import { DEFAULT_NODE_APPEARANCE } from "./appearance";
import { buildKnowledgeImport } from "./import";
import { capturePortableKnowledge, portableKnowledgeState, validateKnowledgeEnvelope, restorePortableKnowledge } from "./backup";

Dexie.dependencies.indexedDB = indexedDB;
Dexie.dependencies.IDBKeyRange = IDBKeyRange;
let database: StudyJournalDatabase;
let repository: KnowledgeRepository;
beforeEach(async () => { database = new StudyJournalDatabase("map-appearance-" + crypto.randomUUID()); await database.open(); repository = new KnowledgeRepository(database, () => "deviceGuest"); });
afterEach(async () => { await database.delete(); });
const style = { ...DEFAULT_NODE_APPEARANCE, background: "yellow" as const, bold: true };
async function fixture() {
  const library = await repository.createLibrary("样式测试");
  const { context } = await repository.open(library.id);
  const topic = createKnowledgeEntity(library.id, "workspace", "专题");
  await repository.execute(context, topic);
  const node = createKnowledgeEntity(library.id, "node", "节点", topic.entity.id);
  const state = await repository.execute(context, node);
  return { library, context, topic, node, state };
}
describe("persistent map appearance", () => {
  it("reads legacy state without defaults or writes and validates bounded style values", async () => {
    const { state, node, library } = await fixture();
    validateKnowledgeState(state);
    expect(state.entities[node.entity.id].units.style).toBeUndefined();
    const command = editKnowledgeEntity(library.id, state, state.entities[node.entity.id], "style", style);
    expect(command.protocolVersion).toBe(2);
    expect(() => validateKnowledgeCommand({ ...command, protocolVersion: 1 })).toThrow();
    expect(() => validateKnowledgeCommand({ ...command, changes: { style: { ...style, background: "url(evil)" } as never } })).toThrow();
    expect(() => validateKnowledgeCommand({ ...command, changes: { style: { ...style, extra: true } as never } })).toThrow();
  });
  it("round trips v2 wire, rejects mixed versions and copies styles without rewriting titles", async () => {
    const { state, node, library, context } = await fixture();
    const command = editKnowledgeEntity(library.id, state, state.entities[node.entity.id], "style", style);
    const next = await repository.execute(context, command);
    const packet = knowledgeCloudPacket(state, next, command);
    expect(packet.head.protocolVersion).toBe(2);
    expect(applyKnowledgeCloudPacket(state, packet)).toEqual(next);
    expect(() => applyKnowledgeCloudPacket(state, { ...packet, head: { ...packet.head, protocolVersion: 1 } })).toThrow();
    const copied = buildKnowledgeImport(next, "copy", "session").reduce((result, step) => applyKnowledgeCommand(result, step), emptyKnowledgeState());
    const copiedNode = Object.values(copied.entities).find(entity => entity.kind === "node")!;
    expect(valueOf(copied, copiedNode, "style")).toEqual(style);
    expect(valueOf(copied, copiedNode, "title")).toBe("节点");
    const backup = await capturePortableKnowledge(database, "deviceGuest");
    expect(backup.version).toBe(2);
    const restored = portableKnowledgeState(validateKnowledgeEnvelope(backup).libraries[0]);
    expect(valueOf(restored, restored.entities[node.entity.id], "style")).toEqual(style);
    const restoredIds = await database.transaction("rw", knowledgeTables(database), () => restorePortableKnowledge(database, backup, "deviceGuest", "styled-restore"));
    const restoredState = (await repository.open(restoredIds[0])).state;
    expect(valueOf(restoredState, restoredState.entities[node.entity.id], "style")).toEqual(style);
  });
  it("saves and undoes title plus first style atomically, rejecting stale batches", async () => {
    const { state, node, library, context } = await fixture();
    const entity = state.entities[node.entity.id];
    const title = editKnowledgeEntity(library.id, state, entity, "title", "新标题");
    const appearance = editKnowledgeEntity(library.id, state, entity, "style", style);
    const invalid = { ...appearance, expected: { style: "missing" } };
    await expect(repository.executeBatch(context, [title, invalid])).rejects.toThrow();
    expect(valueOf((await repository.open(library.id)).state, entity, "title")).toBe("节点");
    await repository.executeBatch(context, [title, appearance]);
    await repository.undoBatch(context, [{ command: title, unit: "title" }, { command: appearance, unit: "style" }]);
    const restored = (await repository.open(library.id)).state;
    expect(valueOf(restored, restored.entities[entity.id], "title")).toBe("节点");
    expect(valueOf(restored, restored.entities[entity.id], "style")).toEqual(DEFAULT_NODE_APPEARANCE);
  });
  it("creates configured topics atomically and preserves map configuration in copies", async () => {
    const topic = await repository.createTopic("发散图", { id: "intent", ownerScope: "deviceGuest", sessionGeneration: 0 }, { structure: "radial", line: "elbow" });
    const { state } = await repository.open(topic.libraryId);
    expect(valueOf(state, state.entities[topic.workspaceId], "map")).toEqual({ structure: "radial", line: "elbow" });
    const copied = buildKnowledgeImport(state, "copy", "map-session").reduce((result, step) => applyKnowledgeCommand(result, step), emptyKnowledgeState());
    expect(valueOf(copied, Object.values(copied.entities).find(entity => entity.kind === "workspace")!, "map")).toEqual({ structure: "radial", line: "elbow" });
  });
});

it("style-only rename undo ignores a no-op title and rolls back a stale multi-unit undo", async () => {
  const { state, node, library, context } = await fixture();
  const entity = state.entities[node.entity.id];
  const title = editKnowledgeEntity(library.id, state, entity, "title", "节点");
  const appearance = editKnowledgeEntity(library.id, state, entity, "style", style);
  await repository.executeBatch(context, [title, appearance]);
  await repository.undoBatch(context, [{ command: title, unit: "title" }, { command: appearance, unit: "style" }]);
  const restored = (await repository.open(library.id)).state;
  expect(valueOf(restored, restored.entities[entity.id], "style")).toEqual(DEFAULT_NODE_APPEARANCE);
  const rename = editKnowledgeEntity(library.id, restored, restored.entities[entity.id], "title", "first");
  const color = editKnowledgeEntity(library.id, restored, restored.entities[entity.id], "style", style);
  await repository.executeBatch(context, [rename, color]);
  const changed = (await repository.open(library.id)).state;
  await repository.execute(context, editKnowledgeEntity(library.id, changed, changed.entities[entity.id], "title", "newer"));
  await expect(repository.undoBatch(context, [{ command: rename, unit: "title" }, { command: color, unit: "style" }])).rejects.toThrow();
  const current = (await repository.open(library.id)).state;
  expect(valueOf(current, current.entities[entity.id], "style")).toEqual(style);
  expect(valueOf(current, current.entities[entity.id], "title")).toBe("newer");
});
