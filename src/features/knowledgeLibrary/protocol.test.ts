import { describe, expect, it } from "vitest";
import { canonicalKnowledge, groupIdentity, knowledgeHash, referenceIdentity } from "./canonical";
import { emptyKnowledgeState, ROOT_NODE, type KnowledgeCommand, type KnowledgeEntity, type KnowledgeState, type KnowledgeUnit, type KnowledgeValue } from "./domain";
import { applyKnowledgeCommand, assertKnowledgeTree, isKnowledgeVisible, isRevisionAncestor, knowledgeWrites, restorationToken, valueOf } from "./protocol";
import { isOrderKey, orderBetween } from "./orderKey";

const identity = (id: string, kind: KnowledgeEntity["kind"] = "node"): KnowledgeCommand["entity"] => ({ id, kind, workspaceId: kind === "workspace" ? id : "topic", nodeId: "", recordId: "" });
const create = (id: string, kind: KnowledgeEntity["kind"] = "node", parentNodeId = ROOT_NODE): KnowledgeCommand => {
  const changes = kind === "workspace" ? { title: id, note: "", archived: false, deleted: false } : { title: id, note: "", position: { parentNodeId, orderKey: "V" }, deleted: false };
  return { protocolVersion: 1, id: "create-" + id, libraryId: "library", operation: "create", entity: identity(id, kind), expected: Object.fromEntries(Object.keys(changes).map(unit => [unit, null])), changes };
};
const base = (): KnowledgeState => [create("topic", "workspace"), create("parent"), create("child")].reduce((state, command) => applyKnowledgeCommand(state, command), emptyKnowledgeState());
const edit = (state: KnowledgeState, id: string, entityId: string, unit: KnowledgeUnit, value: KnowledgeValue): KnowledgeCommand => ({ protocolVersion: 1, id, libraryId: "library", operation: "edit", entity: { ...identity(entityId), kind: state.entities[entityId].kind, nodeId: state.entities[entityId].nodeId, recordId: state.entities[entityId].recordId }, expected: { [unit]: state.entities[entityId].units[unit] ?? null }, changes: { [unit]: value } });
const ref = (id: string, remark: string): KnowledgeCommand => ({ protocolVersion: 1, id, libraryId: "library", operation: "create", entity: { id: referenceIdentity("parent", "record"), kind: "reference", workspaceId: "topic", nodeId: "parent", recordId: "record" }, expected: { remark: null, deleted: null }, changes: { remark, deleted: false } });
const lifecycle = (state: KnowledgeState, id: string, entityId: string, deleted: boolean): KnowledgeCommand => ({ ...edit(state, id, entityId, "deleted", deleted), operation: deleted ? "delete" : "restore", ...(!deleted ? { restoreToken: restorationToken(state, state.entities[entityId]) } : {}) });
const resolve = (state: KnowledgeState, id: string, entityId: string, selected: string[], value = "合并后的说明"): KnowledgeCommand => {
  const group = state.groups[groupIdentity(entityId, "note")];
  return { ...edit(state, id, entityId, "note", value), operation: "resolve", resolution: { unit: "note", generation: group.generation, setToken: group.setToken, candidates: selected } };
};

describe("knowledge canonical identities and order", () => {
  it("preserves text and null/absence, rejects non-JSON values and fixes key order", () => {
    expect(knowledgeHash({ second: 2, first: "汉字\r\n" })).toBe(knowledgeHash({ first: "汉字\r\n", second: 2 }));
    expect(knowledgeHash({})).not.toBe(knowledgeHash({ field: null }));
    for (const invalid of [NaN, Infinity, undefined, new Date(), { field: undefined }]) expect(() => canonicalKnowledge(invalid)).toThrow();
    expect(referenceIdentity("node", "record")).not.toBe(referenceIdentity("record", "node"));
  });
  it("keeps 10000 seeded insertions strictly within bounds with stable concurrent identities", () => {
    const keys: string[] = [];
    let seed = 92381;
    let longest = 0;
    for (let index = 0; index < 10000; index += 1) {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      const slot = index % 3 === 0 ? 0 : seed % (keys.length + 1);
      const lower = keys[slot - 1] ?? null;
      const upper = keys[slot] ?? null;
      const key = orderBetween(lower, upper, "insert-" + index);
      expect(isOrderKey(key)).toBe(true);
      expect(lower === null || key > lower).toBe(true);
      expect(upper === null || key < upper).toBe(true);
      expect(orderBetween(lower, upper, "insert-" + index)).toBe(key);
      expect(orderBetween(lower, upper, "peer-" + index)).not.toBe(key);
      longest = Math.max(longest, key.length);
      keys.splice(slot, 0, key);
    }
    expect(longest).toBeLessThan(4096);
    for (const [lower, upper] of [["V", "V1"], ["001", "01"], ["V0V", "VV"]]) {
      const result = orderBetween(lower, upper, "prefix");
      expect(result > lower && result < upper).toBe(true);
    }
    expect(() => orderBetween("V", "V", "equal")).toThrow();
    expect(() => orderBetween("V0", null, "invalid")).toThrow();
    expect(() => orderBetween(null, "0".repeat(4050) + "1", "budget")).toThrow();
  });
});

describe("knowledge committed-history reducer", () => {
  it("merges different units while retaining all same-unit candidates and receipts", () => {
    const initial = base();
    const commands = [edit(initial, "one", "parent", "note", "A"), edit(initial, "two", "parent", "note", "B"), edit(initial, "three", "parent", "note", "C"), edit(initial, "title", "parent", "title", "独立标题")];
    const result = commands.reduce((state, command) => applyKnowledgeCommand(state, command), initial);
    expect(valueOf(result, result.entities.parent, "note")).toBe("A");
    expect(valueOf(result, result.entities.parent, "title")).toBe("独立标题");
    expect(Object.values(result.candidates)).toHaveLength(2);
    expect(commands.reduce((state, command) => applyKnowledgeCommand(state, command), result)).toBe(result);
    expect(() => applyKnowledgeCommand(result, { ...commands[0], changes: { note: "different intent" } })).toThrow();
    expect(initial.sequence).toBe(3);
    expect(() => applyKnowledgeCommand(result, commands[1], true)).not.toThrow();
    expect(() => applyKnowledgeCommand(result, { ...commands[1], id: "stale-local" }, true)).toThrow();
  });
  it("retains an invalid concurrent move as a candidate without materializing a cycle", () => {
    const initial = base();
    const left = edit(initial, "left", "parent", "position", { parentNodeId: "child", orderKey: "V" });
    const right = edit(initial, "right", "child", "position", { parentNodeId: "parent", orderKey: "V" });
    for (const commands of [[left, right], [right, left]]) {
      const result = commands.reduce((state, command) => applyKnowledgeCommand(state, command), initial);
      expect(() => assertKnowledgeTree(result)).not.toThrow();
      expect(Object.values(result.candidates)).toHaveLength(1);
      expect(() => applyKnowledgeCommand(applyKnowledgeCommand(initial, commands[0]), commands[1], true)).toThrow();
    }
  });
  it("REF-01/02: identifies duplicate refs and removes visibility in either commit order without dropping notes", () => {
    const first = ref("phone", "先看队列");
    const second = ref("desktop", "注意最短路");
    const initial = applyKnowledgeCommand(base(), first);
    const deletion = lifecycle(initial, "delete", first.entity.id, true);
    for (const commands of [[second, deletion], [deletion, second]]) {
      const result = commands.reduce((state, command) => applyKnowledgeCommand(state, command), initial);
      expect(Object.values(result.entities).filter(entity => entity.kind === "reference")).toHaveLength(1);
      expect(isKnowledgeVisible(result, result.entities[first.entity.id])).toBe(false);
      expect(Object.values(result.revisions).some(revision => revision.value === "注意最短路")).toBe(true);
      expect(Object.values(result.revisions).some(revision => revision.value === "先看队列")).toBe(true);
    }
  });
  it("REF-03: requires explicit restore, retains candidates and lets unseen deletes win", () => {
    const first = ref("ref-first", "first note");
    const live = applyKnowledgeCommand(base(), first);
    const deleted = applyKnowledgeCommand(live, lifecycle(live, "remove-first", first.entity.id, true));
    const restore = lifecycle(deleted, "restore-first", first.entity.id, false);
    const concurrentRestore = { ...restore, id: "restore-peer" };
    const restored = applyKnowledgeCommand(deleted, restore);
    const equivalent = applyKnowledgeCommand(restored, concurrentRestore);
    expect(isKnowledgeVisible(equivalent, equivalent.entities[first.entity.id])).toBe(true);
    const unseenDelete = lifecycle(live, "remove-peer", first.entity.id, true);
    for (const commands of [[restore, unseenDelete], [unseenDelete, restore]]) {
      let state = deleted;
      for (const command of commands) {
        try { state = applyKnowledgeCommand(state, command); } catch (error) { expect(command.operation).toBe("restore"); }
      }
      expect(isKnowledgeVisible(state, state.entities[first.entity.id])).toBe(false);
    }
    const incoming = applyKnowledgeCommand(deleted, ref("late-note", "preserved hidden note"));
    expect(() => applyKnowledgeCommand(incoming, restore)).toThrow();
    const refreshed = applyKnowledgeCommand(incoming, lifecycle(incoming, "restore-refreshed", first.entity.id, false));
    expect(Object.values(refreshed.candidates)).toHaveLength(1);
    expect(isKnowledgeVisible(refreshed, refreshed.entities[first.entity.id])).toBe(true);
  });
  it("merges equal concurrent revisions causally and keeps nonempty initial remarks in either order", () => {
    const initial = base();
    const first = edit(initial, "equal-one", "parent", "note", "same");
    const second = edit(initial, "equal-two", "parent", "note", "same");
    const merged = applyKnowledgeCommand(applyKnowledgeCommand(initial, first), second);
    expect(Object.values(merged.candidates)).toHaveLength(0);
    expect(isRevisionAncestor(merged, "equal-one:note", merged.entities.parent.units.note!)).toBe(true);
    expect(isRevisionAncestor(merged, "equal-two:note", merged.entities.parent.units.note!)).toBe(true);
    for (const commands of [[ref("empty", ""), ref("nonempty", "内容")], [ref("nonempty", "内容"), ref("empty", "")]]) {
      const result = commands.reduce((state, command) => applyKnowledgeCommand(state, command), initial);
      expect(valueOf(result, result.entities[commands[0].entity.id], "remark")).toBe("内容");
      expect(Object.values(result.candidates)).toHaveLength(0);
    }
  });
  it("hides descendants without editing their contents or positions", () => {
    let initial = base();
    initial = applyKnowledgeCommand(initial, edit(initial, "move-child", "child", "position", { parentNodeId: "parent", orderKey: "V" }));
    const deleted = applyKnowledgeCommand(initial, lifecycle(initial, "delete-parent", "parent", true));
    expect(isKnowledgeVisible(deleted, deleted.entities.child)).toBe(false);
    expect(deleted.entities.child).toEqual(initial.entities.child);
    const restored = applyKnowledgeCommand(deleted, lifecycle(deleted, "restore-parent", "parent", false));
    expect(isKnowledgeVisible(restored, restored.entities.child)).toBe(true);
  });
  it("GROUP-01/02: resolves only selected candidates, invalidates old group tokens and preserves causal evidence", () => {
    const initial = base();
    let state = initial;
    for (let index = 0; index <= 10; index += 1) state = applyKnowledgeCommand(state, edit(initial, "candidate-" + index, "parent", "note", "版本" + index));
    const selected = Object.keys(state.candidates).slice(0, 3);
    const resolution = resolve(state, "resolve-three", "parent", selected);
    const result = applyKnowledgeCommand(state, resolution);
    expect(result.groups[groupIdentity("parent", "note")].unresolvedCount).toBe(7);
    for (const candidate of Object.values(result.candidates)) expect(candidate.consumedBy !== null).toBe(selected.includes(candidate.id));
    for (const candidate of selected) expect(isRevisionAncestor(result, candidate, result.entities.parent.units.note!)).toBe(true);
    expect(() => applyKnowledgeCommand(result, { ...resolution, id: "other-resolver" })).toThrow();
    const incoming = applyKnowledgeCommand(state, edit(initial, "late", "parent", "note", "新候选"));
    expect(() => applyKnowledgeCommand(incoming, resolution)).toThrow();
    expect(applyKnowledgeCommand(result, edit(initial, "candidate-1", "parent", "note", "版本1"))).toBe(result);
    const derived = applyKnowledgeCommand(result, edit(state, "new-derived", "parent", "note", "旧基线新编辑"));
    expect(derived.groups[groupIdentity("parent", "note")].unresolvedCount).toBe(8);
  });
  it("keeps maximum-size text once in immutable revisions and rejects oversized commands", () => {
    const initial = base();
    const result = applyKnowledgeCommand(initial, edit(initial, "maximum", "parent", "note", "a".repeat(16384)));
    const writes = knowledgeWrites(initial, result);
    expect(writes.filter(write => JSON.stringify(write.value).includes("a".repeat(16384)))).toHaveLength(1);
    expect(() => applyKnowledgeCommand(initial, edit(initial, "too-large", "parent", "note", "汉".repeat(6000)))).toThrow();
    const invalid = ref("mismatch", "备注");
    invalid.entity.recordId = "another-record";
    expect(() => applyKnowledgeCommand(initial, invalid)).toThrow();
  });
});
