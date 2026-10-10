import { fireEvent, render, screen } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { JournalRecordPreview } from "./JournalRecordPreview";
import type { RecordBlock } from "../types";

vi.mock("./RichTextEditor", () => ({ RichTextEditor: ({ readOnly, value }: { readOnly: boolean; value: string }) => <div data-testid="reader" data-readonly={readOnly}>{value}</div> }));
const record = { id: "a", type: "record", title: "真实标题", date: "2026-10-08", subject: "数学", contentHtml: "<p>真实正文</p>", tags: [], assets: [], formulas: [], mistakeRefs: [] } as unknown as RecordBlock;

it("renders read-only content and keeps full opening explicit", () => {
  const onOpenFull = vi.fn();
  const onClose = vi.fn();
  const onScroll = vi.fn();
  const { container } = render(<JournalRecordPreview record={record} recordId="a" records={[record]} subjects={[]} scrollTop={240} onScroll={onScroll} onClose={onClose} onOpenFull={onOpenFull} />);
  expect(screen.getByTestId("reader")).toHaveAttribute("data-readonly", "true");
  expect(screen.getByRole("heading", { name: "真实标题" })).toBeInTheDocument();
  const body = container.querySelector(".journal-preview-body")!;
  expect(body.scrollTop).toBe(240);
  fireEvent.scroll(body, { target: { scrollTop: 300 } });
  expect(onScroll).toHaveBeenCalledWith("a", 300);
  expect(onOpenFull).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "打开完整日志" }));
  expect(onOpenFull).toHaveBeenCalledWith(record);
  fireEvent.click(screen.getByRole("button", { name: "返回列表" }));
  expect(onClose).toHaveBeenCalledOnce();
});

it("reports a missing source without offering a broken full-page action", () => {
  render(<JournalRecordPreview recordId="missing" records={[]} subjects={[]} scrollTop={0} onScroll={vi.fn()} onClose={vi.fn()} onOpenFull={vi.fn()} />);
  expect(screen.getByRole("status")).toHaveTextContent("原日志暂不可用");
  expect(screen.getByRole("button", { name: "打开完整日志" })).toBeDisabled();
});
