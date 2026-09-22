import { StrictMode } from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AdaptiveReviewPage } from "./AdaptiveReviewPage";
import * as traceModule from "../../hooks/useInteractionTrace";
import { coachTestBlock, coachTestBlueprint, coachTestStamp, coachTestTask, coachTestTurn, completeCoachTestSnapshot } from "./reviewCoachTestFixtures";
import { closedLoopV2Fixtures } from "./learningLoopFixtures";

const record = { id: "record-1", type: "record" as const, date: "2026-09-07", order: 0, subject: "数据结构", title: "BFS", contentHtml: `<record-decision-block data-decision-block-id="${coachTestBlock.id}" data-content-version="1"><p>Mark visited before enqueue.</p></record-decision-block>`, assets: [], formulas: [], mistakeRefs: [], tags: [], createdAt: "2026-09-07T08:00:00.000Z", updatedAt: "2026-09-07T08:00:00.000Z" };
const props = { taskId: coachTestTask.id, records: [record], onBack: vi.fn(), onGenerateTurn: vi.fn(), onRequestHint: vi.fn(), onSubmitAnswer: vi.fn(), onSkipTurn: vi.fn(), onReportInvalid: vi.fn(), onFinish: vi.fn(), onFinishVerification: vi.fn(), onCompleteLoop: vi.fn(), onCompleteV2Verification: vi.fn(), onSelectIntervention: vi.fn(), onDeferAttempt: vi.fn(), onDefer: vi.fn(), onAbandon: vi.fn() };

describe("AdaptiveReviewPage", () => {
  beforeEach(() => vi.clearAllMocks());

  it.each(["record", "task", "blueprint", "snapshot"])("keeps hook order and draft when %s disappears and returns", (missing) => {
    const snapshot = completeCoachTestSnapshot();
    snapshot.adaptiveQuizTurns[0] = { ...coachTestTurn, status: "displayed", hintsUsed: [], availableHints: ["提示"] };
    const view = render(<AdaptiveReviewPage {...props} snapshot={snapshot} />);
    fireEvent.change(screen.getByLabelText("你的回答"), { target: { value: "未提交的推导" } });
    const unavailable = { ...snapshot, ...(missing === "task" ? { adaptiveReviewTasks: [] } : missing === "blueprint" ? { sessionBlueprints: [] } : missing === "snapshot" ? { adaptiveReviewTasks: [], adaptiveQuizTurns: [], sessionBlueprints: [] } : {}) };
    view.rerender(<AdaptiveReviewPage {...props} snapshot={unavailable} records={missing === "record" ? [] : props.records} />);
    expect(screen.getByText("任务不可用")).toBeInTheDocument();
    view.rerender(<AdaptiveReviewPage {...props} snapshot={snapshot} />);
    expect(screen.getByLabelText("你的回答")).toHaveValue("未提交的推导");
  });

  it.each([false, true])("preserves text, images and confirmed voice input after hint failure=%s", async (fails) => {
    const snapshot = completeCoachTestSnapshot();
    snapshot.adaptiveQuizTurns[0] = { ...coachTestTurn, status: "displayed", hintsUsed: [], availableHints: ["提示"] };
    const hint = fails ? vi.fn().mockRejectedValue(new Error("hint failed")) : vi.fn().mockResolvedValue(undefined);
    render(<AdaptiveReviewPage {...props} snapshot={snapshot} onRequestHint={hint} />);
    fireEvent.click(screen.getByRole("button", { name: "语音输入" }));
    fireEvent.change(screen.getByLabelText("语音回答转写"), { target: { value: "未提交的推导" } });
    fireEvent.change(screen.getByRole("group", { name: "本轮图片附件" }).querySelector('input[type="file"]')!, { target: { files: [new File(["image"], "draft.png", { type: "image/png" })] } });
    fireEvent.click(screen.getByRole("button", { name: "确认转写" }));
    fireEvent.click(screen.getByRole("button", { name: "提示 1" }));
    await waitFor(() => expect(hint).toHaveBeenCalledOnce());
    await waitFor(() => expect(screen.getByRole("button", { name: "提示 1" })).toBeEnabled());
    expect(screen.getByLabelText("语音回答转写")).toHaveValue("未提交的推导");
    expect(screen.getByRole("button", { name: "转写已确认" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "移除图片 draft.png" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "提交回答" })).toBeEnabled();
  });

  it("requires explicit transcript confirmation before submitting one voice answer", async () => {
    const snapshot = completeCoachTestSnapshot();
    snapshot.adaptiveReviewTasks[0] = { ...coachTestTask, status: "in-progress" };
    snapshot.adaptiveQuizTurns[0] = { ...coachTestTurn, status: "displayed", answerText: undefined, answeredAt: undefined, assessment: undefined, assessmentRationale: undefined };
    render(<AdaptiveReviewPage {...props} snapshot={snapshot} />);

    fireEvent.click(screen.getByRole("button", { name: "语音输入" }));
    fireEvent.change(screen.getByLabelText("语音回答转写"), { target: { value: "  入队时立即标记访问  " } });
    expect(screen.getByRole("button", { name: "提交回答" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "确认转写" }));
    expect(screen.getByRole("button", { name: "提交回答" })).toBeEnabled();
    fireEvent.change(screen.getByLabelText("语音回答转写"), { target: { value: "修改后必须重新确认" } });
    expect(screen.getByRole("button", { name: "提交回答" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "确认转写" }));
    fireEvent.click(screen.getByRole("button", { name: "提交回答" }));

    await waitFor(() => expect(props.onSubmitAnswer).toHaveBeenCalledTimes(1));
    expect(props.onSubmitAnswer).toHaveBeenCalledWith(coachTestTurn.id, "修改后必须重新确认", expect.any(AbortSignal));
  });

  it("sends selected answer images with the typed answer and keeps direct vision as the default", async () => {
    const snapshot = completeCoachTestSnapshot();
    snapshot.adaptiveReviewTasks[0] = { ...coachTestTask, status: "in-progress" };
    snapshot.adaptiveQuizTurns[0] = { ...coachTestTurn, status: "displayed", answerText: undefined, answeredAt: undefined, assessment: undefined, assessmentRationale: undefined };
    render(<AdaptiveReviewPage {...props} snapshot={snapshot} />);

    const image = new File(["handwritten"], "answer.png", { type: "image/png" });
    const imageInput = screen.getByRole("group", { name: "本轮图片附件" }).querySelector('input[type="file"]');
    fireEvent.change(imageInput!, { target: { files: [image] } });
    expect(screen.getByRole("button", { name: "直发 AI" })).toHaveAttribute("aria-pressed", "true");
    fireEvent.change(screen.getByLabelText("你的回答"), { target: { value: "请结合图片批改" } });
    fireEvent.click(screen.getByRole("button", { name: "提交回答" }));

    await waitFor(() => expect(props.onSubmitAnswer).toHaveBeenCalledTimes(1));
    expect(props.onSubmitAnswer).toHaveBeenCalledWith(
      coachTestTurn.id,
      "请结合图片批改",
      expect.any(AbortSignal),
      expect.objectContaining({
        imageInputMode: "vision",
        imageAttachments: [expect.objectContaining({ fileName: "answer.png", mimeType: "image/png" })],
      }),
    );
  });

  it("allows an image-only answer and switches the attachment path to local OCR", async () => {
    const snapshot = completeCoachTestSnapshot();
    snapshot.adaptiveReviewTasks[0] = { ...coachTestTask, status: "in-progress" };
    snapshot.adaptiveQuizTurns[0] = { ...coachTestTurn, status: "displayed", answerText: undefined, answeredAt: undefined, assessment: undefined, assessmentRationale: undefined };
    render(<AdaptiveReviewPage {...props} snapshot={snapshot} />);

    const image = new File(["drawing"], "diagram.jpg", { type: "image/jpeg" });
    const imageInput = screen.getByRole("group", { name: "本轮图片附件" }).querySelector('input[type="file"]');
    fireEvent.change(imageInput!, { target: { files: [image] } });
    fireEvent.click(screen.getByRole("button", { name: "本地 OCR" }));
    expect(screen.getByRole("button", { name: "提交回答" })).toBeEnabled();
  });

  it("hides answer criteria and source until the user submits", () => {
    const snapshot = completeCoachTestSnapshot();
    snapshot.adaptiveReviewTasks[0] = { ...coachTestTask, status: "in-progress" };
    snapshot.adaptiveQuizTurns[0] = { ...coachTestTurn, status: "displayed", answerText: undefined, answeredAt: undefined, assessment: undefined, assessmentRationale: undefined, availableHints: ["Think about duplicates."], hintsUsed: [] };
    render(<AdaptiveReviewPage {...props} snapshot={snapshot} />);
    expect(screen.queryByText("答案依据")).not.toBeInTheDocument();
    expect(screen.queryByText("Mark visited before enqueue.")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "提示 1" })).toBeInTheDocument();
  });

  it("renders coach objectives, questions, hints and criteria with KaTeX", () => {
    const snapshot = completeCoachTestSnapshot();
    snapshot.sessionBlueprints[0] = {
      ...coachTestBlueprint,
      objective: "判断 $x \\to 0^+$ 时 $e^{1/x}$ 的极限。",
      completionCriteria: ["能说明 $t=1/x$ 的换元方向。"],
    };
    snapshot.adaptiveReviewTasks[0] = { ...coachTestTask, status: "in-progress" };
    snapshot.adaptiveQuizTurns[0] = {
      ...coachTestTurn,
      status: "displayed",
      question: "设 $t=\\dfrac{1}{x}$，求 $\\arctan t$。",
      availableHints: ["先判断 $x\\to0^+$ 时 $t$ 的方向。"],
      answerText: undefined,
      answeredAt: undefined,
      assessment: undefined,
      assessmentRationale: undefined,
      hintsUsed: [{ level: 1, requestedAt: coachTestStamp }],
    };

    const { container } = render(<AdaptiveReviewPage {...props} snapshot={snapshot} />);

    expect(container.querySelectorAll(".katex").length).toBeGreaterThanOrEqual(4);
    expect(container.querySelector(".adaptive-review-question")).toHaveTextContent("设");
    expect(container.querySelector(".adaptive-review-question")).not.toHaveTextContent("$t=");
  });

  it("shows answer evidence after submission and requires confirmation for conflicting mastery", () => {
    const snapshot = completeCoachTestSnapshot();
    snapshot.adaptiveReviewTasks[0] = { ...coachTestTask, status: "in-progress" };
    snapshot.adaptiveQuizTurns[0] = { ...coachTestTurn, assessment: "incorrect", assessmentRationale: "Wrong order", answerText: "After dequeue" };
    render(<AdaptiveReviewPage {...props} snapshot={snapshot} />);
    expect(screen.getByText("答案依据")).toBeInTheDocument();
    expect(screen.getByText("Mark visited before enqueue.")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "结束本次训练" }));
    fireEvent.click(screen.getByRole("button", { name: "已掌握" }));
    expect(screen.getByRole("button", { name: "确认已掌握" })).toBeInTheDocument();
    expect(props.onFinish).not.toHaveBeenCalled();
  });

  it("renders formulas and structure from the canonical source fragment after submission", async () => {
    const snapshot = completeCoachTestSnapshot();
    snapshot.adaptiveReviewTasks[0] = { ...coachTestTask, status: "in-progress" };
    snapshot.adaptiveQuizTurns[0] = { ...coachTestTurn, assessment: "incorrect", assessmentRationale: "Wrong order", answerText: "After dequeue" };
    const richRecord = {
      ...record,
      contentHtml: [
        `<record-decision-block data-decision-block-id="${coachTestBlock.id}" data-content-version="1">`,
        '<p>令 <record-inline-math data-formula-id="source-inline" data-latex="t=1/x"></record-inline-math></p>',
        '<record-collapse data-title="原题解析" data-summary="含公式" data-default-open="true">',
        '<record-formula data-formula-id="source-block" data-title="原极限" data-latex="\\lim_{x\\to0^+} e^{1/x}"></record-formula>',
        "</record-collapse>",
        "</record-decision-block>",
      ].join(""),
    };
    const { container } = render(<AdaptiveReviewPage {...props} records={[richRecord]} snapshot={snapshot} />);

    await waitFor(() => expect(container.querySelectorAll(".adaptive-review-source .katex").length).toBeGreaterThanOrEqual(2));
    expect(screen.getByText("原题解析")).toBeInTheDocument();
    expect(container.querySelectorAll(".adaptive-review-source .katex-display")).toHaveLength(1);
  });

  it("hides completion criteria before a delayed verification answer", () => {
    const snapshot = completeCoachTestSnapshot();
    snapshot.adaptiveReviewTasks[0] = { ...coachTestTask, status: "in-progress" };
    snapshot.adaptiveQuizTurns[0] = { ...coachTestTurn, status: "displayed", answerText: undefined, answeredAt: undefined, assessment: undefined, assessmentRationale: undefined };
    snapshot.delayedVerifications[0] = { ...snapshot.delayedVerifications[0], taskId: coachTestTask.id, status: "in-progress", lastVerifiedAt: undefined, verificationOutcome: undefined };
    render(<AdaptiveReviewPage {...props} snapshot={snapshot} />);
    expect(screen.queryByText(coachTestBlueprint.objective)).not.toBeInTheDocument();
    expect(screen.queryByText(coachTestBlueprint.completionCriteria[0])).not.toBeInTheDocument();
    expect(screen.queryByText(/不等同于无提示独立作答结果/)).not.toBeInTheDocument();
  });

  it("uses retained and decayed outcomes for a delayed-verification task", async () => {
    const snapshot = completeCoachTestSnapshot();
    snapshot.adaptiveReviewTasks[0] = { ...coachTestTask, status: "in-progress" };
    snapshot.delayedVerifications[0] = { ...snapshot.delayedVerifications[0], taskId: coachTestTask.id, status: "in-progress", lastVerifiedAt: undefined, verificationOutcome: undefined };
    render(<AdaptiveReviewPage {...props} snapshot={snapshot} />);

    expect(screen.queryByText("延迟验证目标")).not.toBeInTheDocument();
    expect(screen.getByText(/不会改写整条日志的 FSRS 日期/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "结束本次训练" }));
    fireEvent.click(screen.getByRole("button", { name: "已经衰退" }));

    await waitFor(() => expect(props.onFinishVerification).toHaveBeenCalledWith(coachTestTask.id, "decayed", undefined));
    expect(props.onFinish).not.toHaveBeenCalled();
  });
});

it("provides a fresh signal after StrictMode remount and aborts it on unmount", async () => {
  const snapshot = completeCoachTestSnapshot();
  snapshot.adaptiveReviewTasks[0] = { ...coachTestTask, status: "current" };
  snapshot.adaptiveQuizTurns = [];
  const generate = vi.fn(async (_id: string, _signal?: AbortSignal) => undefined);
  const view = render(<StrictMode><AdaptiveReviewPage {...props} onGenerateTurn={generate} snapshot={snapshot} /></StrictMode>);
  fireEvent.click(screen.getByRole("button", { name: "开始训练" }));
  await waitFor(() => expect(generate).toHaveBeenCalledOnce());
  const signal = generate.mock.calls[0][1];
  expect(signal?.aborted).toBe(false);
  view.unmount();
  expect(signal?.aborted).toBe(true);
});

describe("AdaptiveReviewPage closed-loop v2", () => {
  beforeEach(() => vi.clearAllMocks());

  /** A v2 attempt holding only the initial retrieval. */
  const v2SnapshotWithInitialOnly = (assessment: "correct" | "partial" | "incorrect" = "incorrect") => {
    const snapshot = completeCoachTestSnapshot();
    const { blueprint, task, turns } = closedLoopV2Fixtures({ blueprintId: snapshot.sessionBlueprints[0].id, taskId: coachTestTask.id });
    snapshot.sessionBlueprints[0] = { ...blueprint, status: "accepted" };
    snapshot.adaptiveReviewTasks[0] = task;
    // The intervention choice is a *remedy*, so the default here is a retrieval
    // that actually fell short. Passing "correct" exercises the other branch.
    snapshot.adaptiveQuizTurns = [{ ...turns[0], assessment }];
    return snapshot;
  };

  /** A v2 attempt that already produced both qualifying retrievals. */
  const v2SnapshotWithFullLoop = () => {
    const snapshot = completeCoachTestSnapshot();
    const { blueprint, task, turns } = closedLoopV2Fixtures({ blueprintId: snapshot.sessionBlueprints[0].id, taskId: coachTestTask.id, loop: "closed" });
    snapshot.sessionBlueprints[0] = { ...blueprint, status: "accepted" };
    snapshot.adaptiveReviewTasks[0] = task;
    snapshot.adaptiveQuizTurns = turns;
    snapshot.taskOutcomeEvents.push(
      ...turns.map((turn, index) => ({
        id: `v2-answer-${index + 1}`,
        taskId: task.id,
        turnId: turn.id,
        decisionBlockId: task.decisionBlockId,
        recordId: task.recordId,
        contentVersion: task.contentVersion,
        kind: "answer-assessment" as const,
        answerAssessment: turn.assessment,
        occurredAt: coachTestStamp,
        idempotencyKey: `v2-answer-${index + 1}`,
        createdAt: coachTestStamp,
        updatedAt: coachTestStamp,
      })),
    );
    return snapshot;
  };

  it("never offers a mastery verdict on a closed-loop-v2 task", () => {
    const snapshot = v2SnapshotWithInitialOnly();
    render(<AdaptiveReviewPage {...props} snapshot={snapshot} />);

    // The v1 verdict panel must not be reachable at all.
    expect(screen.queryByRole("button", { name: "结束本次训练" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "已掌握" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "仍需巩固" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "未掌握" })).not.toBeInTheDocument();
  });

  it("blocks closure after a first correct answer and pushes the post-judgment retrieval", () => {
    const snapshot = v2SnapshotWithInitialOnly();
    render(<AdaptiveReviewPage {...props} snapshot={snapshot} />);

    // Getting it right first time is not completion: the page still asks for
    // the retrieval that follows feedback.
    expect(screen.getByText("提取 1/2")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "按这个方式再提取一次" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "完成本次闭环" })).not.toBeInTheDocument();
  });

  it("offers closure and no verdict once both qualifying retrievals exist", () => {
    const snapshot = v2SnapshotWithFullLoop();
    render(<AdaptiveReviewPage {...props} snapshot={snapshot} />);

    expect(screen.getByText("提取 2/2")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "完成本次闭环" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "已掌握" })).not.toBeInTheDocument();
  });

  it("sends a v2 task to defer-and-requeue instead of asking for a result", async () => {
    const snapshot = v2SnapshotWithInitialOnly();
    snapshot.sessionBlueprints[0] = { ...snapshot.sessionBlueprints[0], maxTurns: 1 };
    render(<AdaptiveReviewPage {...props} snapshot={snapshot} />);
    fireEvent.click(screen.getByRole("button", { name: "稍后再练" }));

    await waitFor(() => expect(props.onDeferAttempt).toHaveBeenCalledWith(coachTestTask.id));
    expect(props.onFinish).not.toHaveBeenCalled();
    expect(props.onDefer).not.toHaveBeenCalled();
  });

  it("asks which action to take next, never what went wrong", () => {
    const snapshot = v2SnapshotWithInitialOnly("incorrect");
    render(<AdaptiveReviewPage {...props} snapshot={snapshot} />);

    expect(screen.getByText("下一步做什么")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "我没有想出来" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "我记混了" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "我会，但没写出来" })).toBeInTheDocument();
    // No diagnosis, cause or self-rated mastery question may appear.
    expect(screen.queryByText(/你掌握了吗|为什么|能力|基础/)).not.toBeInTheDocument();
  });

  it("does not force a remedy choice when the retrieval was correct", () => {
    // The bug: a correct first answer still had to pick from "I could not form
    // it / I mixed it up / I could but did not produce it", which made the
    // learner misdescribe their own performance before they could continue.
    const snapshot = v2SnapshotWithInitialOnly("correct");
    render(<AdaptiveReviewPage {...props} snapshot={snapshot} />);

    expect(screen.queryByText("下一步做什么")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "我没有想出来" })).not.toBeInTheDocument();
    // The loop still has to be closed by retrieving again, so the way forward
    // exists and is not gated behind a fabricated self-report.
    const next = screen.getByRole("button", { name: "按这个方式再提取一次" });
    expect(next).toBeEnabled();
  });

  it("still requires a choice when the retrieval fell short", () => {
    const snapshot = v2SnapshotWithInitialOnly("incorrect");
    render(<AdaptiveReviewPage {...props} snapshot={snapshot} />);
    expect(screen.getByRole("button", { name: "按这个方式再提取一次" })).toBeDisabled();
  });

  it("records the chosen action before requesting the next retrieval", async () => {
    const snapshot = v2SnapshotWithInitialOnly("incorrect");
    render(<AdaptiveReviewPage {...props} snapshot={snapshot} />);

    const next = screen.getByRole("button", { name: "按这个方式再提取一次" });
    expect(next).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "我记混了" }));
    expect(next).toBeEnabled();
    fireEvent.click(next);

    await waitFor(() => expect(props.onSelectIntervention).toHaveBeenCalledWith(coachTestTask.id, "confused", expect.any(String)));
    expect(props.onGenerateTurn).toHaveBeenCalled();
  });
});

describe("AdaptiveReviewPage friction measurement", () => {
  beforeEach(() => vi.clearAllMocks());

  /**
   * The trace hook is mocked so the assertion is about *whether the page feeds
   * it at all*. Before this fix nothing in the product called the hook, so every
   * session produced zero segments and the M5 operation budget could never be
   * evaluated on real data.
   */
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

  const displayedSnapshot = () => {
    const snapshot = completeCoachTestSnapshot();
    snapshot.adaptiveReviewTasks[0] = { ...coachTestTask, status: "in-progress" };
    snapshot.adaptiveQuizTurns[0] = { ...coachTestTurn, status: "displayed", answerText: undefined, answeredAt: undefined, assessment: undefined, assessmentRationale: undefined };
    return snapshot;
  };

  it("records answering time as cognitive time rather than leaving it unmeasured", () => {
    render(<AdaptiveReviewPage {...props} snapshot={displayedSnapshot()} />);
    expect(traceEnter).toHaveBeenCalledWith(expect.objectContaining({
      screen: "task",
      category: "cognitive",
      phase: "initial-retrieval",
      taskId: coachTestTask.id,
      recordId: record.id,
    }));
  });

  it("records reading feedback as feedback time rather than more retrieval", () => {
    const snapshot = completeCoachTestSnapshot();
    snapshot.adaptiveReviewTasks[0] = { ...coachTestTask, status: "in-progress" };
    snapshot.adaptiveQuizTurns[0] = { ...coachTestTurn, assessment: "incorrect", assessmentRationale: "Wrong order", answerText: "After dequeue" };
    render(<AdaptiveReviewPage {...props} snapshot={snapshot} />);
    expect(traceEnter).toHaveBeenLastCalledWith(expect.objectContaining({ category: "feedback", phase: "feedback" }));
    // The phase label is a duration bucket, never a place to store the answer.
    expect(JSON.stringify(traceEnter.mock.calls)).not.toContain("After dequeue");
  });
});
