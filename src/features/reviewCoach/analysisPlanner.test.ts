import { describe, expect, it } from "vitest";

import { planAnalysisBatches, type AnalysisPlanningBlock } from "./analysisPlanner";

const block = (id: string, estimatedTokens: number): AnalysisPlanningBlock => ({
  decisionBlockId: id,
  recordId: `record-${id}`,
  contentVersion: 1,
  recordTitle: `Record ${id}`,
  subject: "test",
  contextMarkdown: `context ${id}`,
  excerptHash: `hash-${id}`,
  missingOcrAssetIds: [],
  inputRefs: [{ queueItemId: `queue-${id}`, feedbackId: `feedback-${id}`, decisionBlockId: id, recordId: `record-${id}`, contentVersion: 1 }],
  feedback: [{ id: `feedback-${id}`, comment: "stuck", occurredAt: "2026-09-07T00:00:00.000Z" }],
  estimatedTokens,
});

describe("analysis planner", () => {
  it("splits deterministically by three-block and token limits", () => {
    const plan = planAnalysisBatches([block("1", 400), block("2", 400), block("3", 400), block("4", 400)], 1_000);

    expect(plan.subBatches.map((item) => item.blocks.map((entry) => entry.decisionBlockId))).toEqual([["1", "2"], ["3", "4"]]);
    expect(plan.subBatches.map((item) => item.estimatedTokens)).toEqual([800, 800]);
    expect(plan.estimatedTokens).toBe(1_600);
  });

  it("rejects a single oversized block instead of truncating it", () => {
    const plan = planAnalysisBatches([block("small", 900), block("large", 1_001)], 1_000);

    expect(plan.subBatches).toHaveLength(1);
    expect(plan.oversized.map((item) => item.decisionBlockId)).toEqual(["large"]);
  });

  it("fingerprints only the decision-block inputs", () => {
    const blocks = [block("1", 400)];
    const plan = planAnalysisBatches(blocks, 1_000);

    // Same blocks always produce the same fingerprint ...
    expect(planAnalysisBatches(blocks, 1_000).inputFingerprint).toBe(plan.inputFingerprint);
    // ... and changing an identity field of a block changes it.
    expect(planAnalysisBatches([block("2", 400)], 1_000).inputFingerprint).not.toBe(plan.inputFingerprint);
    expect(planAnalysisBatches([{ ...block("1", 400), excerptHash: "hash-changed" }], 1_000).inputFingerprint)
      .not.toBe(plan.inputFingerprint);
  });

  it("no longer accepts intervention effect summaries at all (planning decontamination)", () => {
    // Removing the third parameter is the point: an AI-graded effect table must
    // not be able to influence which evidence a batch is planned against.
    expect(planAnalysisBatches.length).toBe(2);
  });
});
