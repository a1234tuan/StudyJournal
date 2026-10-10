import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RecordBlock } from "../../types";
import { KnowledgeRecordPane } from "./KnowledgeRecordPane";
const renderer = vi.hoisted(() => ({ props: {} as Record<string, any> }));
const presentation = vi.hoisted(() => ({ mobile: false }));
vi.mock("../../lib/mobilePresentation", () => ({ useMobilePresentation: () => presentation.mobile }));
afterEach(() => { presentation.mobile = false; });
vi.mock("../../components/RichTextEditor", () => ({ RichTextEditor: (props: Record<string, any>) => { renderer.props = props; return <div data-testid="reader" />; } }));
const record = { id: "log", title: "测试日志", date: "2026-09-29", subject: "算法", contentHtml: "<p>正文</p>", tags: [], assets: [], formulas: [], mistakeRefs: [] } as unknown as RecordBlock;
const setup = (available = true) => {
  const callbacks = { onWidthChange: vi.fn(), onScrollPosition: vi.fn(), onClose: vi.fn(), onOpenFull: vi.fn(), onOpenRecord: vi.fn() };
  const records = [record, { ...record, id: "deleted", deletedAt: "2026-09-29" }];
  const view = render(<KnowledgeRecordPane record={available ? record : undefined} records={records} subjects={[]} width={420} scrollTop={180} {...callbacks} />);
  return { ...callbacks, ...view };
};
describe("knowledge record reader", () => {
  it("expands the mobile reader without remounting or writing the saved desktop width", () => {
    presentation.mobile = true;
    const handlers = setup();
    const reader = screen.getByTestId("reader");
    const body = handlers.container.querySelector(".knowledge-record-pane-body")!;
    body.scrollTop = 220;
    fireEvent.click(screen.getByRole("button", { name: "展开日志预览" }));
    expect(screen.getByRole("complementary", { name: "日志浏览" })).toHaveClass("is-expanded");
    expect(screen.getByTestId("reader")).toBe(reader);
    expect(body.scrollTop).toBe(220);
    expect(handlers.onWidthChange).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "收起日志预览" }));
    expect(screen.getByRole("complementary", { name: "日志浏览" })).not.toHaveClass("is-expanded");
  });
  it("renders read-only content, excludes deleted references and routes valid references", () => {
    const handlers = setup();
    expect(renderer.props.readOnly).toBe(true);
    expect(renderer.props.referenceRecords).toEqual([record]);
    renderer.props.onOpenRecordReference("deleted");
    expect(handlers.onOpenRecord).not.toHaveBeenCalled();
    renderer.props.onOpenRecordReference("log");
    expect(handlers.onOpenRecord).toHaveBeenCalledWith(record);
    fireEvent.click(screen.getByRole("button", { name: "打开完整日志" }));
    expect(handlers.onOpenFull).toHaveBeenCalledWith(record);
  });
  it("keeps return available when a log is missing", () => {
    const handlers = setup(false);
    expect(screen.getByRole("status")).toHaveTextContent("原日志暂不可用");
    expect(screen.getByRole("button", { name: "打开完整日志" })).toBeDisabled();
    expect(screen.queryByTestId("reader")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "返回节点说明" }));
    expect(handlers.onClose).toHaveBeenCalledOnce();
  });
  it("restores scroll and supports bounded keyboard resize", () => {
    const handlers = setup();
    const body = handlers.container.querySelector(".knowledge-record-pane-body")!;
    expect(body.scrollTop).toBe(180);
    body.scrollTop = 240; fireEvent.scroll(body);
    expect(handlers.onScrollPosition).toHaveBeenCalledWith(240);
    const separator = screen.getByRole("separator");
    for (const [key, width] of [["Home", 360], ["End", 560], ["ArrowLeft", 440], ["ArrowRight", 400]] as const) {
      fireEvent.keyDown(separator, { key }); expect(handlers.onWidthChange).toHaveBeenLastCalledWith(width);
    }
  });
});
