import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { RecordBlock } from "../../types";
import { EMPTY_REVIEW_COACH_FORMAL_SNAPSHOT, type AdaptiveReviewTask, type SessionBlueprint } from "./domain";
import type { AnalysisPlanningBlock } from "./analysisPlanner";
import { ReviewCoachWorkbench } from "./ReviewCoachWorkbench";
import * as traceModule from "../../hooks/useInteractionTrace";

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
  const traceEnter = vi.fn();
  beforeEach(() => {
    traceEnter.mockClear();
    vi.spyOn(traceModule, "useInteractionTrace").mockReturnValue({
      enter: traceEnter,
      touch: vi.fn(),
      flush: vi.fn(),
    } as never);
  });
  afterEach(() => vi.restoreAllMocks());

  it("measures its own time as operation friction, because that is what it is", () => {
    render(<ReviewCoachWorkbench {...baseProps} />);
    expect(traceEnter).toHaveBeenCalledWith({ screen: "workbench", category: "operation", phase: "workbench" });
  });

  it("analyses everything pending in one action, with no batch confirmation", async () => {
    const onAnalyze = vi.fn().mockResolvedValue(undefined);
    render(<ReviewCoachWorkbench {...baseProps} onAnalyze={onAnalyze} />);

    // M5: no checkboxes, no token/sub-batch summary, no two-step confirm. The
    // entry point goes straight to producing the first retrieval.
    expect(screen.queryByRole("checkbox")).toBeNull();
    expect(screen.queryByText("已选重点")).toBeNull();
    expect(screen.queryByText("预计 tokens")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: /开始分析并出题/ }));

    // One click is the whole interaction: it both analyses and queues.
    await waitFor(() => expect(onAnalyze).toHaveBeenCalledWith(["block-1"], false));
  });

  it("does not show a pseudo-precise pass rate while the only judge is the model", () => {
    render(<ReviewCoachWorkbench
      {...baseProps}
      planningBlocks={[]}
      snapshot={{
        ...EMPTY_REVIEW_COACH_FORMAL_SNAPSHOT,
        decisionBlockFeedback: [{
          id: "feedback-1", decisionBlockId: "block-1", recordId: record.id, contentVersion: 1,
          comment: "访问标记太晚", includeInAnalysis: true, source: "manual",
          occurredAt: stamp, idempotencyKey: "feedback-1", createdAt: stamp, updatedAt: stamp,
        }],
        feedbackInterpretations: [{
          id: "interpretation-1", feedbackId: "feedback-1", decisionBlockId: "block-1", contentVersion: 1,
          status: "succeeded", actionability: "needs_training", difficultyType: "procedure",
          missingInformation: [], aiGenerated: true, model: "m", provider: "p",
          promptVersion: "p", policyVersion: "policy", schemaVersion: 1,
          createdAt: stamp, updatedAt: stamp,
        }],
        sessionBlueprints: [{
          id: "blueprint-1", batchId: "batch-1", decisionBlockId: "block-1", recordId: record.id, contentVersion: 1,
          status: "accepted", supportingDecisionBlockIds: [], feedbackIds: ["feedback-1"], interpretationIds: ["interpretation-1"],
          problemHypothesis: "order", hypothesisConfidence: 0.8, objective: "稳定应用访问标记顺序", completionCriteria: ["correct"],
          initialPracticeType: "variation", initialDifficulty: 2, expectedKeyPoints: ["mark first"],
          branches: [], allowedStrategies: ["finish"], forbiddenScope: [],
          evidence: [{ decisionBlockId: "block-1", recordId: record.id, contentVersion: 1, excerptHash: "hash-1", purpose: "source" }],
          maxTurns: 4, maxRetriesPerTurn: 1, maxEstimatedTokens: 4000, model: "m", provider: "p",
          promptVersion: "p", policyVersion: "policy", schemaVersion: 1,
          idempotencyKey: "blueprint-1", createdAt: stamp, updatedAt: stamp,
        }],
        adaptiveReviewTasks: [{
          id: "task-1", blueprintId: "blueprint-1", decisionBlockId: "block-1", recordId: record.id, contentVersion: 1,
          status: "completed", priorityTier: "first-difficulty", queuedAt: stamp, endedAt: stamp,
          idempotencyKey: "task-1", createdAt: stamp, updatedAt: stamp,
        }],
        delayedVerifications: [{
          id: "verification-1", sourceOutcomeEventId: "outcome-1", taskId: "task-1",
          decisionBlockId: "block-1", recordId: record.id, contentVersion: 1,
          status: "completed", verificationEligibleAt: stamp, verificationDueAt: stamp,
          lastVerifiedAt: stamp, verificationOutcome: "retained",
          strategyVersion: "verification-v1", idempotencyKey: "verification-1", createdAt: stamp, updatedAt: stamp,
        }],
      }}
    />);

    // A percentage here would rest on the model grading its own questions, so
    // the workbench must not show one.
    expect(screen.queryByText(/%/)).toBeNull();
    expect(screen.queryByText(/保持率/)).toBeNull();
  });

  it("shows one current task and switches to the next in a single tap", async () => {
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

    // M5: the retired flow was "设为当前" then "确认切换" - the learner had to
    // configure which task to do. "换一个" is now one tap that hands the choice
    // straight to the next candidate.
    expect(screen.queryByRole("button", { name: "设为当前" })).toBeNull();
    expect(screen.queryByRole("button", { name: "确认切换" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: /换一个/ }));

    await waitFor(() => expect(onSwitchTask).toHaveBeenCalledWith("waiting"));
  });

  it("keeps exactly one primary action on the screen", () => {
    // The M5 Go condition is "同屏只有一个主动作". Several tasks must not each
    // offer their own start button, so the others collapse to a count.
    const task = (id: string, status: AdaptiveReviewTask["status"]): AdaptiveReviewTask => ({
      id, blueprintId: "blueprint-1", decisionBlockId: "block-1", recordId: record.id, contentVersion: 1, status,
      priorityTier: "first-difficulty", queuedAt: stamp, idempotencyKey: id, createdAt: stamp, updatedAt: stamp,
    });
    render(<ReviewCoachWorkbench
      {...baseProps}
      planningBlocks={[]}
      onOpenTask={vi.fn()}
      snapshot={{ ...EMPTY_REVIEW_COACH_FORMAL_SNAPSHOT, adaptiveReviewTasks: [task("a", "current"), task("b", "waiting"), task("c", "waiting")] }}
    />);

    expect(screen.getAllByRole("button", { name: /开始训练/ })).toHaveLength(1);
    expect(screen.getByRole("button", { name: /开始训练/ }).className).toContain("primary-button");
    // The other two are reported, not offered as parallel actions.
    expect(screen.getByText(/另有 2 个任务/)).toBeTruthy();
  });

  it.each([
    ["waiting-only", "waiting"],
    ["future-deferred-only", "deferred"],
  ] as const)("does not open a non-current %s task", (_label, status) => {
    const task: AdaptiveReviewTask = {
      id: "not-current", blueprintId: "blueprint-1", decisionBlockId: "block-1", recordId: record.id, contentVersion: 1, status,
      priorityTier: "first-difficulty", queuedAt: stamp, notBeforeAt: status === "deferred" ? "2099-09-15T08:00:00.000Z" : undefined,
      idempotencyKey: "not-current", createdAt: stamp, updatedAt: stamp,
    };
    render(<ReviewCoachWorkbench
      {...baseProps}
      planningBlocks={[]}
      onOpenTask={vi.fn()}
      snapshot={{ ...EMPTY_REVIEW_COACH_FORMAL_SNAPSHOT, adaptiveReviewTasks: [task] }}
    />);

    expect(screen.queryByRole("button", { name: /开始训练|继续训练/ })).toBeNull();
  });

  it("keeps the current retrieval as the only primary action when planning also exists", () => {
    const task: AdaptiveReviewTask = {
      id: "current", blueprintId: "blueprint-1", decisionBlockId: "block-1", recordId: record.id, contentVersion: 1, status: "current",
      priorityTier: "first-difficulty", queuedAt: stamp, idempotencyKey: "current", createdAt: stamp, updatedAt: stamp,
    };
    const { container } = render(<ReviewCoachWorkbench
      {...baseProps}
      onOpenTask={vi.fn()}
      snapshot={{ ...EMPTY_REVIEW_COACH_FORMAL_SNAPSHOT, adaptiveReviewTasks: [task] }}
    />);

    expect(container.querySelectorAll(".primary-button")).toHaveLength(1);
    expect(screen.getByRole("button", { name: /开始训练/ })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /开始分析并出题/ })).toBeNull();
  });

  it("does not offer a future deferred task as the switch candidate", () => {
    const task = (id: string, status: AdaptiveReviewTask["status"], notBeforeAt?: string): AdaptiveReviewTask => ({
      id, blueprintId: "blueprint-1", decisionBlockId: "block-1", recordId: record.id, contentVersion: 1, status,
      priorityTier: "first-difficulty", queuedAt: stamp, notBeforeAt, idempotencyKey: id, createdAt: stamp, updatedAt: stamp,
    });
    render(<ReviewCoachWorkbench
      {...baseProps}
      planningBlocks={[]}
      onOpenTask={vi.fn()}
      snapshot={{
        ...EMPTY_REVIEW_COACH_FORMAL_SNAPSHOT,
        adaptiveReviewTasks: [task("current", "current"), task("future", "deferred", "2099-09-15T08:00:00.000Z")],
      }}
    />);

    expect(screen.queryByRole("button", { name: /换一个/ })).toBeNull();
  });

  it("defers the current task in one tap without a confirmation step", async () => {
    const onDeferTask = vi.fn().mockResolvedValue(undefined);
    const task: AdaptiveReviewTask = {
      id: "only", blueprintId: "blueprint-1", decisionBlockId: "block-1", recordId: record.id, contentVersion: 1, status: "current",
      priorityTier: "first-difficulty", queuedAt: stamp, idempotencyKey: "only", createdAt: stamp, updatedAt: stamp,
    };
    render(<ReviewCoachWorkbench
      {...baseProps}
      planningBlocks={[]}
      onDeferTask={onDeferTask}
      snapshot={{ ...EMPTY_REVIEW_COACH_FORMAL_SNAPSHOT, adaptiveReviewTasks: [task] }}
    />);

    expect(screen.queryByRole("button", { name: "确认延期" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /今天跳过/ }));

    await waitFor(() => expect(onDeferTask).toHaveBeenCalledWith("only"));
  });

  it("does not offer replanning when nothing has decayed", () => {
    render(<ReviewCoachWorkbench {...baseProps} />);

    expect(screen.queryByText("需要重新规划")).toBeNull();
  });

  it("surfaces a decayed block and reuses prior feedback without a second form", async () => {
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
    expect(screen.queryByRole("textbox")).toBeNull();
    const submit = screen.getByRole("button", { name: /重新加入分析/ });
    fireEvent.click(submit);

    await waitFor(() => expect(onReplanDecayedBlock).toHaveBeenCalledWith({
      decisionBlockId: "block-1",
      recordId: record.id,
      contentVersion: 1,
    }));
  });
});
