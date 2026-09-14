import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { RecordBlock } from "../../types";
import { EMPTY_REVIEW_COACH_FORMAL_SNAPSHOT, type AdaptiveReviewTask, type SessionBlueprint } from "./domain";
import type { AnalysisPlanningBlock } from "./analysisPlanner";
import { ReviewCoachWorkbench } from "./ReviewCoachWorkbench";

const stamp = "2026-09-07T08:00:00.000Z";
const record: RecordBlock = { id: "record-1", type: "record", date: "2026-09-07", order: 0, subject: "数据结构", title: "BFS", contentHtml: "<p>BFS</p>", assets: [], formulas: [], mistakeRefs: [], tags: [], createdAt: stamp, updatedAt: stamp };
const planningBlock: AnalysisPlanningBlock = {
  decisionBlockId: "block-1", recordId: record.id, contentVersion: 1, recordTitle: record.title, subject: record.subject,
  contextMarkdown: "BFS queue", excerptHash: "hash-1", missingOcrAssetIds: [], estimatedTokens: 800,
  inputRefs: [{ queueItemId: "queue-1", feedbackId: "feedback-1", decisionBlockId: "block-1", recordId: record.id, contentVersion: 1 }],
  feedback: [{ id: "feedback-1", comment: "访问标记太晚", occurredAt: stamp }],
};

const baseProps = {
  planningBlocks: [planningBlock],
  snapshot: EMPTY_REVIEW_COACH_FORMAL_SNAPSHOT,
  records: [record],
  onAnalyze: vi.fn().mockResolvedValue(undefined),
  onResume: vi.fn().mockResolvedValue(undefined),
  onSwitchTask: vi.fn().mockResolvedValue(undefined),
  onDeferTask: vi.fn().mockResolvedValue(undefined),
};

describe("ReviewCoachWorkbench", () => {
  it("defaults to all eligible blocks and requires one final confirmation", async () => {
    const onAnalyze = vi.fn().mockResolvedValue(undefined);
    render(<ReviewCoachWorkbench {...baseProps} onAnalyze={onAnalyze} />);

    expect(screen.getByRole("checkbox")).toBeChecked();
    expect(screen.getByText("800 tokens")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "AI 分析" }));
    expect(onAnalyze).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "确认并开始" }));

    await waitFor(() => expect(onAnalyze).toHaveBeenCalledWith(["block-1"], false));
  });

  it("requires confirmation before switching the current task", async () => {
    const blueprint = {
      id: "blueprint-1", batchId: "batch-1", decisionBlockId: "block-1", recordId: record.id, contentVersion: 1, status: "accepted",
      supportingDecisionBlockIds: [], feedbackIds: ["feedback-1"], interpretationIds: [], problemHypothesis: "order", hypothesisConfidence: 0.8,
      objective: "稳定应用访问标记顺序", completionCriteria: ["correct"], initialPracticeType: "variation", initialDifficulty: 2,
      expectedKeyPoints: ["mark first"], branches: [{ when: "correct", nextStrategy: "finish" }, { when: "partial", nextStrategy: "hint" }, { when: "incorrect", nextStrategy: "explain" }, { when: "skipped", nextStrategy: "prerequisite-check" }],
      allowedStrategies: ["finish", "hint", "explain", "prerequisite-check"], forbiddenScope: [], evidence: [{ decisionBlockId: "block-1", recordId: record.id, contentVersion: 1, excerptHash: "hash-1", purpose: "source" }],
      maxTurns: 4, maxRetriesPerTurn: 1, maxEstimatedTokens: 4000, model: "deep", provider: "test", promptVersion: "p", policyVersion: "policy", schemaVersion: 1,
      idempotencyKey: "blueprint-1", createdAt: stamp, updatedAt: stamp,
    } satisfies SessionBlueprint;
    const task = (id: string, status: AdaptiveReviewTask["status"]): AdaptiveReviewTask => ({
      id, blueprintId: blueprint.id, decisionBlockId: "block-1", recordId: record.id, contentVersion: 1, status,
      priorityTier: "first-difficulty", queuedAt: stamp, idempotencyKey: id, createdAt: stamp, updatedAt: stamp,
    });
    const onSwitchTask = vi.fn().mockResolvedValue(undefined);
    render(<ReviewCoachWorkbench
      {...baseProps}
      planningBlocks={[]}
      snapshot={{ ...EMPTY_REVIEW_COACH_FORMAL_SNAPSHOT, sessionBlueprints: [blueprint], adaptiveReviewTasks: [task("current", "current"), task("waiting", "waiting")] }}
      onSwitchTask={onSwitchTask}
    />);

    fireEvent.click(screen.getByRole("button", { name: "设为当前" }));
    expect(onSwitchTask).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "确认切换" }));
    await waitFor(() => expect(onSwitchTask).toHaveBeenCalledWith("waiting"));
  });

  it("does not offer replanning when nothing has decayed", () => {
    render(<ReviewCoachWorkbench {...baseProps} />);

    expect(screen.queryByText("需要重新规划")).toBeNull();
  });

  it("surfaces a decayed block and records the user's own note before replanning", async () => {
    const onReplanDecayedBlock = vi.fn().mockResolvedValue(undefined);
    render(<ReviewCoachWorkbench
      {...baseProps}
      planningBlocks={[]}
      onReplanDecayedBlock={onReplanDecayedBlock}
      snapshot={{
        ...EMPTY_REVIEW_COACH_FORMAL_SNAPSHOT,
        decisionBlocks: [{ id: "block-1", recordId: record.id, contentVersion: 1, position: 0, contentUpdatedAt: stamp, createdAt: stamp, updatedAt: stamp }],
        delayedVerifications: [{
          id: "verification-1", sourceOutcomeEventId: "outcome-1", decisionBlockId: "block-1", recordId: record.id, contentVersion: 1,
          status: "completed", verificationEligibleAt: stamp, verificationDueAt: stamp, lastVerifiedAt: "2026-09-06T08:00:00.000Z",
          verificationOutcome: "decayed", strategyVersion: "verification-v1", idempotencyKey: "verification-1", createdAt: stamp, updatedAt: "2026-09-06T08:00:00.000Z",
        }],
      }}
    />);

    expect(screen.getByText("需要重新规划")).toBeInTheDocument();
    // An empty note must not be queueable: the button stays disabled until the user says something.
    const submit = screen.getByRole("button", { name: /补充说明并加入分析/ });
    expect(submit).toBeDisabled();

    fireEvent.change(screen.getByRole("textbox", { name: /重新规划说明/ }), { target: { value: "还是记不住标记顺序" } });
    fireEvent.click(submit);

    await waitFor(() => expect(onReplanDecayedBlock).toHaveBeenCalledWith({
      decisionBlockId: "block-1",
      recordId: record.id,
      contentVersion: 1,
      note: "还是记不住标记顺序",
    }));
  });
});
