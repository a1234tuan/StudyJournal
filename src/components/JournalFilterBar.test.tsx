import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { JournalFilterBar } from "./JournalFilterBar";
import type { JournalScope } from "../lib/journalFilters";

const props = () => ({ scope: { kind: "all" } as JournalScope, tags: [{ key: "重点", label: "重点" }, { key: "公式", label: "公式" }], topics: [{ owner: "deviceGuest" as const, libraryId: "lib", libraryTitle: "本机库", workspaceId: "topic", title: "线性代数", recordIds: new Set<string>() }], loading: false, error: "", onRetry: vi.fn(), subjects: [], subject: "全部", mobile: false, calendar: false, onScope: vi.fn(), onSubject: vi.fn(), onCalendar: vi.fn(), onSearch: vi.fn() });
describe("journal filter bar", () => {
  it("keeps visible scope controls and subject while removing desktop dates", () => {
    render(<JournalFilterBar {...props()} />);
    expect(screen.getByRole("button", { name: "按标签" })).toBeVisible();
    expect(screen.getByRole("button", { name: "按专题" })).toBeVisible();
    expect(screen.getByLabelText("按学科筛选")).toHaveValue("全部");
    expect(screen.queryByRole("tab", { name: "按日期" })).not.toBeInTheDocument();
  });
  it("searches tags and chooses a scope without resetting subject", () => {
    const callbacks = props();
    render(<JournalFilterBar {...callbacks} subject="数学" />);
    fireEvent.click(screen.getByRole("button", { name: "按标签" }));
    expect(screen.getByLabelText("搜索标签")).toHaveFocus();
    fireEvent.change(screen.getByLabelText("搜索标签"), { target: { value: "重" } });
    expect(screen.queryByRole("button", { name: "公式" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "重点" }));
    expect(callbacks.onScope).toHaveBeenCalledWith({ kind: "tag", tag: "重点" });
    expect(callbacks.onSubject).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });
  it("matches topic library names and restores trigger focus on Escape", () => {
    render(<JournalFilterBar {...props()} />);
    const trigger = screen.getByRole("button", { name: "按专题" });
    fireEvent.click(trigger);
    fireEvent.change(screen.getByLabelText("搜索专题"), { target: { value: "本机" } });
    expect(screen.getByRole("button", { name: "线性代数 本机库" })).toBeVisible();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
  });
  it("does not turn topic failures into empty results and supports retry", () => {
    const callbacks = props();
    render(<JournalFilterBar {...callbacks} error="读取失败" />);
    fireEvent.click(screen.getByRole("button", { name: "按专题" }));
    expect(screen.getByRole("status")).toHaveTextContent("读取失败");
    fireEvent.click(screen.getByRole("button", { name: "重试" }));
    expect(callbacks.onRetry).toHaveBeenCalledOnce();
  });
  it("preserves the mobile calendar and dismisses on outside pointer", () => {
    render(<JournalFilterBar {...props()} mobile />);
    expect(screen.getByRole("tab", { name: "按日期" })).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "按标签" }));
    fireEvent.pointerDown(document.body);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });
});
