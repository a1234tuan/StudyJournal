import { StrictMode } from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { AdaptiveReviewPage } from "./AdaptiveReviewPage";
import { coachTestBlock, coachTestBlueprint, coachTestTask, coachTestTurn, completeCoachTestSnapshot } from "./reviewCoachTestFixtures";

const record = { id: "record-1", type: "record" as const, date: "2026-09-07", order: 0, subject: "数据结构", title: "BFS", contentHtml: `<record-decision-block data-decision-block-id="${coachTestBlock.id}" data-content-version="1"><p>Mark visited before enqueue.</p></record-decision-block>`, assets: [], formulas: [], mistakeRefs: [], tags: [], createdAt: "2026-09-07T08:00:00.000Z", updatedAt: "2026-09-07T08:00:00.000Z" };
const props = { taskId: coachTestTask.id, records: [record], onBack: vi.fn(), onGenerateTurn: vi.fn(), onRequestHint: vi.fn(), onSubmitAnswer: vi.fn(), onSkipTurn: vi.fn(), onReportInvalid: vi.fn(), onFinish: vi.fn(), onFinishVerification: vi.fn(), onDefer: vi.fn(), onAbandon: vi.fn() };

describe("AdaptiveReviewPage", () => {
  beforeEach(() => vi.clearAllMocks());

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

  it("hides answer criteria and source until the user submits", () => {
    const snapshot = completeCoachTestSnapshot();
    snapshot.adaptiveReviewTasks[0] = { ...coachTestTask, status: "in-progress" };
    snapshot.adaptiveQuizTurns[0] = { ...coachTestTurn, status: "displayed", answerText: undefined, answeredAt: undefined, assessment: undefined, assessmentRationale: undefined, availableHints: ["Think about duplicates."], hintsUsed: [] };
    render(<AdaptiveReviewPage {...props} snapshot={snapshot} />);
    expect(screen.queryByText("答案依据")).not.toBeInTheDocument();
    expect(screen.queryByText("Mark visited before enqueue.")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "提示 1" })).toBeInTheDocument();
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
