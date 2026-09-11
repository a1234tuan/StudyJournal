import { act, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { MotionPresence } from "./MotionPresence";

describe("MotionPresence", () => {
  it("keeps exiting content mounted but unavailable to assistive technology", () => {
    vi.useFakeTimers();
    const { rerender } = render(<MotionPresence present variant="modal"><section>确认框</section></MotionPresence>);
    rerender(<MotionPresence present={false} variant="modal"><section>确认框</section></MotionPresence>);

    expect(screen.getByText("确认框").parentElement).toHaveAttribute("data-motion-phase", "exiting");
    expect(screen.getByText("确认框").parentElement).toHaveAttribute("aria-hidden", "true");
    expect(screen.getByText("确认框").parentElement).toHaveAttribute("inert");

    act(() => vi.advanceTimersByTime(200));
    expect(screen.queryByText("确认框")).not.toBeInTheDocument();
    vi.useRealTimers();
  });

  it("cancels an exit when the overlay reopens", () => {
    vi.useFakeTimers();
    const { rerender } = render(<MotionPresence present variant="sheet"><section>操作</section></MotionPresence>);
    rerender(<MotionPresence present={false} variant="sheet"><section>操作</section></MotionPresence>);
    rerender(<MotionPresence present variant="sheet"><section>操作</section></MotionPresence>);
    act(() => vi.advanceTimersByTime(200));

    expect(screen.getByText("操作")).toBeInTheDocument();
    expect(screen.getByText("操作").parentElement).toHaveAttribute("data-motion-phase", "entered");
    vi.useRealTimers();
  });
});
