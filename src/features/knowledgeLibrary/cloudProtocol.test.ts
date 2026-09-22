import { describe, expect, it } from "vitest";
import { groupIdentity } from "./canonical";
import { emptyKnowledgeState, type KnowledgeCommand } from "./domain";
import { applyKnowledgeCommand } from "./protocol";
import { applyKnowledgeCloudPacket, knowledgeCloudPacket } from "./cloudProtocol";

const create: KnowledgeCommand = { protocolVersion: 1, id: "create", libraryId: "library", operation: "create", entity: { id: "topic", kind: "workspace", workspaceId: "topic", nodeId: "", recordId: "" }, expected: { title: null, note: null, archived: null, deleted: null }, changes: { title: "专题", note: "说明", archived: false, deleted: false } };
describe("knowledge bounded cloud wire protocol", () => {
  it("rejects missing immutable revisions, corrupt text, skipped sequences and altered immutable evidence", () => {
    const before = emptyKnowledgeState();
    const next = applyKnowledgeCommand(before, create);
    const packet = knowledgeCloudPacket(before, next, create);
    expect(applyKnowledgeCloudPacket(before, packet)).toEqual(next);
    expect(() => applyKnowledgeCloudPacket(before, { ...packet, rows: packet.rows.slice(1) })).toThrow();
    expect(() => applyKnowledgeCloudPacket(next, packet)).toThrow();
    const tampered = structuredClone(packet);
    tampered.rows.find(row => row.collection === "revisions")!.data.payload = "{}";
    expect(() => applyKnowledgeCloudPacket(before, tampered)).toThrow();
    expect(before.sequence).toBe(0);
  });
  it.each([10, 100, 1000])("GROUP-01: %i candidates resolve in fixed-size batches without dropping the remainder", (count) => {
    const initial = applyKnowledgeCommand(emptyKnowledgeState(), create);
    let state = initial;
    for (let index = 0; index <= count; index += 1) state = applyKnowledgeCommand(state, { ...create, id: "candidate-" + index, operation: "edit", expected: { note: initial.entities.topic.units.note! }, changes: { note: "候选" + index } });
    const group = state.groups[groupIdentity("topic", "note")];
    const command: KnowledgeCommand = { ...create, id: "resolve", operation: "resolve", expected: { note: state.entities.topic.units.note! }, changes: { note: "本次合并" }, resolution: { unit: "note", setToken: group.setToken, generation: group.generation, candidates: Object.keys(state.candidates).slice(0, 3) } };
    const resolved = applyKnowledgeCommand(state, command);
    const packet = knowledgeCloudPacket(state, resolved, command);
    expect(packet.rows).toHaveLength(6);
    expect(JSON.stringify(packet).length).toBeLessThan(9000);
    expect(resolved.groups[group.id].unresolvedCount).toBe(count - 3);
    expect(applyKnowledgeCloudPacket(state, packet)).toEqual(resolved);
    for (const candidate of Object.values(state.candidates)) {
      expect(resolved.revisions[candidate.revisionId]).toEqual(state.revisions[candidate.revisionId]);
      if (!command.resolution!.candidates.includes(candidate.id)) expect(resolved.candidates[candidate.id]).toEqual(candidate);
    }
  }, 30000);
});
