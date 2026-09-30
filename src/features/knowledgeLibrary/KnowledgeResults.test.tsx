import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RecordBlock } from "../../types";
import { emptyKnowledgeState } from "./domain";
import { KnowledgeResults } from "./KnowledgeResults";
const record = (id: string, date: string, deletedAt?: string): RecordBlock => ({ id, date, deletedAt, type: "record", title: id, subject: "算法", createdAt: date + "T00:00:00.000Z", updatedAt: "2026-09-30T00:00:00.000Z", order: 0, contentHtml: "<p></p>", tags: [], assets: [], formulas: [], mistakeRefs: [] });
const renderResults = (mode: "picker" | "search", records: RecordBlock[]) => render(<KnowledgeResults state={emptyKnowledgeState()} records={records} assets={[]} mode={mode} selected={[]} onSelected={vi.fn()} onOpen={vi.fn()} />);
const titles = () => Array.from(document.querySelectorAll(".knowledge-result-text strong"), element => element.textContent);
beforeEach(() => { vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} }); });
afterEach(() => vi.unstubAllGlobals());
describe("knowledge record picker date ordering", () => {
  it("sorts dates newest first across years and months without mutating input", () => {
    const records = [record("旧日志", "2025-12-31"), record("本月日志", "2026-09-30"), record("上月日志", "2026-08-31"), record("已删除", "2026-10-01", "2026-09-30")];
    const before = structuredClone(records);
    renderResults("picker", records);
    expect(titles()).toEqual(["本月日志", "上月日志", "旧日志"]);
    expect(records).toEqual(before);
  });
  it("keeps descending dates after searching and preserves same-day order", () => {
    renderResults("picker", [record("匹配旧", "2026-09-01"), record("匹配新一", "2026-09-30"), record("其他", "2026-09-29"), record("匹配新二", "2026-09-30")]);
    fireEvent.change(screen.getByRole("textbox", { name: "查找要关联的日志" }), { target: { value: "匹配" } });
    expect(titles()).toEqual(["匹配新一", "匹配新二", "匹配旧"]);
    fireEvent.click(screen.getByRole("checkbox", { name: "匹配新一" }));
    expect(titles()).toEqual(["匹配新一", "匹配新二", "匹配旧"]);
  });
  it("does not reorder the general search view", () => {
    renderResults("search", [record("旧日志", "2026-09-01"), record("新日志", "2026-09-30")]);
    expect(titles()).toEqual(["旧日志", "新日志"]);
  });
});
