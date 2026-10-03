import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DailyPlanReminder } from "./DailyPlanReminder";

beforeEach(() => {
  HTMLDialogElement.prototype.showModal = vi.fn(function (this: HTMLDialogElement) { this.open = true; });
  HTMLDialogElement.prototype.close = vi.fn(function (this: HTMLDialogElement) { this.open = false; });
});
afterEach(cleanup);
describe("daily plan invitation", () => {
  it("offers creation without embedding a plan form", () => {
    const dismiss = vi.fn(); const openPlan = vi.fn();
    render(<DailyPlanReminder open date="2026-10-03" planCount={0} onDismiss={dismiss} onOpenPlan={openPlan} />);
    expect(screen.getByRole("heading", { name: "为今天定个小目标" })).toBeVisible();
    expect(screen.queryByRole("textbox")).toBeNull();
    const action = screen.getByRole("button", { name: "去制定计划" });
    expect(action).toHaveFocus();
    fireEvent.click(action);
    expect(dismiss).toHaveBeenCalledOnce(); expect(openPlan).toHaveBeenCalledOnce();
  });
  it("acknowledges existing plans instead of asking to create them again", () => {
    const dismiss = vi.fn();
    render(<DailyPlanReminder open date="2026-10-03" planCount={3} onDismiss={dismiss} onOpenPlan={vi.fn()} />);
    expect(screen.getByRole("heading", { name: "今天的计划，已经就绪" })).toBeVisible();
    expect(screen.getByRole("button", { name: "查看今日计划" })).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "直接开始" }));
    expect(dismiss).toHaveBeenCalledOnce();
  });
  it("treats Escape cancellation as dismissal", () => {
    const dismiss = vi.fn();
    render(<DailyPlanReminder open date="2026-10-03" planCount={0} onDismiss={dismiss} onOpenPlan={vi.fn()} />);
    fireEvent(screen.getByRole("dialog"), new Event("cancel", { bubbles: false, cancelable: true }));
    expect(dismiss).toHaveBeenCalledOnce();
  });
});
