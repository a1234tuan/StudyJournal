import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, it, expect, vi } from "vitest";
import { CardCoach } from "./CardCoach";
import type { RecordBlock } from "../../types";
import { EMPTY_REVIEW_COACH_FORMAL_SNAPSHOT } from "../reviewCoach/domain";
import { coachTestFeedback, coachTestInterpretation } from "../reviewCoach/reviewCoachTestFixtures";
const save = vi.hoisted(() => vi.fn());
vi.mock("./cardFeedback", () => ({ saveCardFeedback: save }));
const record = { id: "record-1", title: "快速排序" } as RecordBlock;
const input = { decisionBlockId: "decision-block-1", contentVersion: 1, comment: coachTestFeedback.comment, includeInAnalysis: true, operationId: "operation" };
beforeEach(() => { vi.clearAllMocks(); save.mockResolvedValue([coachTestFeedback]); });
describe("explicit single-card coach", () => {
  it("shows processing immediately and submits only this card's feedback once", async () => { let finish!: () => void; const analyze = vi.fn(() => new Promise<void>(resolve => { finish = resolve; })); render(<CardCoach record={record} inputs={[input]} scope="round" onAnalyze={analyze} onRefresh={async () => undefined} onClose={() => undefined} />); await waitFor(() => expect(analyze).toHaveBeenCalledWith("record-1", [coachTestFeedback.id])); expect(screen.getByRole("status")).toHaveTextContent("正在处理本卡反馈"); expect(screen.getByRole("button", { name: "正在分析…" })).toBeDisabled(); finish(); await waitFor(() => expect(screen.queryByRole("status")).not.toBeInTheDocument()); expect(save).toHaveBeenCalledTimes(1); });
  it("opens existing results without another paid request", async () => { const analyze = vi.fn(); render(<CardCoach record={record} inputs={[input]} scope="ordinary" snapshot={{ ...structuredClone(EMPTY_REVIEW_COACH_FORMAL_SNAPSHOT), decisionBlockFeedback: [coachTestFeedback], feedbackInterpretations: [{ ...coachTestInterpretation, status: "succeeded" }] }} onAnalyze={analyze} onRefresh={async () => undefined} onClose={() => undefined} />); expect(screen.getByText(coachTestFeedback.comment)).toBeInTheDocument(); expect(save).not.toHaveBeenCalled(); expect(analyze).not.toHaveBeenCalled(); });
  it("preserves a visible retry action on failure and returns independently of scoring", async () => { const close = vi.fn(); render(<CardCoach record={record} inputs={[input]} scope="round" onAnalyze={async () => { throw new Error("provider failure token-secret"); }} onRefresh={async () => undefined} onClose={close} />); await waitFor(() => expect(screen.getByRole("alert")).toBeInTheDocument()); expect(screen.getByRole("alert")).not.toHaveTextContent("token-secret"); fireEvent.click(screen.getByRole("button", { name: "返回卡片" })); expect(close).toHaveBeenCalledTimes(1); });
});
