import { act, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { PAGE_TRANSITION_DURATION_MS, PageTransition } from "./PageTransition";
import { MotionPresence } from "./MotionPresence";

describe("PageTransition", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("keeps the previous page mounted while the next page enters", () => {
    vi.useFakeTimers();
    const { rerender } = render(
      <PageTransition pageKey="today">
        <main>今天</main>
      </PageTransition>,
    );

    rerender(
      <PageTransition pageKey="journal" motion="forward">
        <main>日志</main>
      </PageTransition>,
    );

    expect(screen.getByText("今天")).toBeInTheDocument();
    expect(screen.getByText("日志")).toBeInTheDocument();
    expect(screen.getByText("今天").parentElement).toHaveAttribute("aria-hidden", "true");
    expect(screen.getByText("今天").parentElement).toHaveAttribute("data-motion", "forward");
    expect(screen.getByText("日志").parentElement).toHaveClass("page-transition-layer-entering");

    act(() => {
      vi.advanceTimersByTime(PAGE_TRANSITION_DURATION_MS);
    });

    expect(screen.queryByText("今天")).not.toBeInTheDocument();
    expect(screen.getByText("日志")).toBeInTheDocument();
  });

  it("drops stale exiting pages during rapid navigation", () => {
    vi.useFakeTimers();
    const { rerender } = render(
      <PageTransition pageKey="today">
        <main>今天</main>
      </PageTransition>,
    );

    rerender(
      <PageTransition pageKey="journal">
        <main>日志</main>
      </PageTransition>,
    );
    rerender(
      <PageTransition pageKey="recordings">
        <main>录音</main>
      </PageTransition>,
    );

    expect(screen.queryByText("今天")).not.toBeInTheDocument();
    expect(screen.getByText("日志")).toBeInTheDocument();
    expect(screen.getByText("录音")).toBeInTheDocument();

    act(() => {
      vi.advanceTimersByTime(PAGE_TRANSITION_DURATION_MS);
    });

    expect(screen.queryByText("日志")).not.toBeInTheDocument();
    expect(screen.getByText("录音")).toBeInTheDocument();
  });

  it("updates content in place when the page key does not change", () => {
    const { rerender } = render(
      <PageTransition pageKey="journal">
        <main>日志列表</main>
      </PageTransition>,
    );

    rerender(
      <PageTransition pageKey="journal">
        <main>筛选后的日志列表</main>
      </PageTransition>,
    );

    expect(screen.queryByText("日志列表")).not.toBeInTheDocument();
    expect(screen.getByText("筛选后的日志列表")).toBeInTheDocument();
  });

  it("removes an exiting page's viewport presence before the page unmounts", () => {
    vi.useFakeTimers();
    const { rerender } = render(
      <PageTransition pageKey="review">
        <main>
          <span>复习正文</span>
          <MotionPresence present variant="popover">
            <button type="button">评分操作</button>
          </MotionPresence>
        </main>
      </PageTransition>,
    );

    expect(screen.getByRole("button", { name: "评分操作" })).toBeInTheDocument();

    rerender(
      <PageTransition pageKey="journal" motion="back">
        <main>日志列表</main>
      </PageTransition>,
    );

    expect(screen.getByText("复习正文")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "评分操作" })).not.toBeInTheDocument();

    act(() => {
      vi.advanceTimersByTime(PAGE_TRANSITION_DURATION_MS);
    });

    expect(screen.queryByText("复习正文")).not.toBeInTheDocument();
  });

  it("replaces the page immediately when motion is disabled", () => {
    const { rerender } = render(<PageTransition pageKey="today"><main>今天</main></PageTransition>);

    rerender(<PageTransition pageKey="journal" motion="none"><main>日志</main></PageTransition>);

    expect(screen.queryByText("今天")).not.toBeInTheDocument();
    expect(screen.getByText("日志").parentElement).toHaveClass("page-transition-layer-entered");
  });

  it("replaces the page immediately when reduced motion is requested", () => {
    vi.stubGlobal("matchMedia", vi.fn().mockReturnValue({ matches: true }));
    const { rerender } = render(<PageTransition pageKey="today"><main>今天</main></PageTransition>);

    rerender(<PageTransition pageKey="journal" motion="forward"><main>日志</main></PageTransition>);

    expect(screen.queryByText("今天")).not.toBeInTheDocument();
    expect(screen.getByText("日志").parentElement).toHaveClass("page-transition-layer-entered");
    expect(screen.getByText("日志").parentElement).toHaveAttribute("data-motion", "none");
  });
});
