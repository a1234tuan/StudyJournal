import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Block, SubjectConfig } from "../types";
import { JournalPage } from "./JournalPage";
import type { JournalTopic } from "../lib/journalFilters";

const view = vi.hoisted(() => ({ mobile: false, topics: [] as JournalTopic[], loading: false, error: "" }));
vi.mock("../lib/mobilePresentation", () => ({ useMobilePresentation: () => view.mobile }));
vi.mock("../features/knowledgeLibrary/useJournalTopics", () => ({ useJournalTopics: () => ({ owner: "deviceGuest", topics: view.topics, loading: view.loading, error: view.error, retry: vi.fn() }) }));
vi.mock("../components/RichTextEditor", () => ({ RichTextEditor: () => <div>只读正文</div> }));
beforeEach(() => { view.mobile = false; view.topics = []; view.loading = false; view.error = ""; });
afterEach(() => vi.restoreAllMocks());

const stamp = "2026-06-21T00:00:00.000Z";

const subjects: SubjectConfig[] = [
  {
    id: "subject-os",
    createdAt: stamp,
    updatedAt: stamp,
    name: "OS",
    order: 0,
  },
];

const record = (id: string, date: string): Block => ({
  id,
  createdAt: stamp,
  updatedAt: stamp,
  type: "record",
  date,
  order: 0,
  subject: "OS",
  tags: [],
  title: `${date} 记录`,
  contentHtml: "<p>内容</p>",
  assets: [],
  formulas: [],
  mistakeRefs: [],
});

describe("JournalPage", () => {
  const previewProps = () => ({ blocks: [record("first", "2026-06-21"), record("second", "2026-06-20")], subjects, month: new Date("2026-06-01"), onMonthChange: vi.fn(), onSelectedDateChange: vi.fn(), onSelectedSubjectChange: vi.fn(), onOpenRecord: vi.fn(), onOpenSearch: vi.fn(), onAskAi: vi.fn(), onToggleFavorite: vi.fn(), onResolvePreview: vi.fn() });
  it("keeps a desktop preview container and automatically selects the first result", () => {
    vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(900);
    const props = previewProps();
    render(<JournalPage {...props} />);
    expect(screen.getByRole("region", { name: "日志预览" })).toBeInTheDocument();
    expect(props.onResolvePreview).toHaveBeenCalledWith("first");
    expect(document.querySelector(".journal-fixed-reading")).toBeInTheDocument();
  });
  it("does not reopen an explicitly dismissed preview or auto-open mobile previews", () => {
    vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(900);
    const props = previewProps();
    const { rerender } = render(<JournalPage {...props} previewDismissed />);
    expect(props.onResolvePreview).not.toHaveBeenCalled();
    view.mobile = true;
    rerender(<JournalPage {...props} />);
    expect(props.onResolvePreview).not.toHaveBeenCalled();
    expect(screen.queryByRole("region", { name: "日志预览" })).not.toBeInTheDocument();
  });
  it("retains matching previews and replaces out-of-scope records without collapsing", () => {
    vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(900);
    const props = previewProps();
    const blocks = props.blocks.map((item, index) => ({ ...item, tags: index ? ["重点"] : [] }));
    const { rerender } = render(<JournalPage {...props} blocks={blocks} previewRecordId="second" />);
    expect(props.onResolvePreview).not.toHaveBeenCalled();
    rerender(<JournalPage {...props} blocks={blocks} previewRecordId="first" scope={{ kind: "tag", tag: "重点" }} />);
    expect(props.onResolvePreview).toHaveBeenLastCalledWith("second");
    expect(screen.getByRole("region", { name: "日志预览" })).toBeInTheDocument();
    rerender(<JournalPage {...props} blocks={blocks} previewRecordId="second" subjectFilter="不存在" />);
    expect(props.onResolvePreview).toHaveBeenLastCalledWith(undefined);
    expect(screen.getByText("当前筛选范围没有日志")).toBeInTheDocument();
  });
  it("holds topic selection during loading and reports invalid scope without widening", () => {
    const props = previewProps();
    const scope = { kind: "topic" as const, owner: "deviceGuest" as const, libraryId: "library", workspaceId: "missing" };
    view.loading = true;
    const { rerender } = render(<JournalPage {...props} scope={scope} previewRecordId="first" />);
    expect(props.onResolvePreview).not.toHaveBeenCalled();
    expect(screen.getByRole("status")).toHaveTextContent("正在读取专题");
    view.loading = false;
    rerender(<JournalPage {...props} scope={scope} previewRecordId="first" />);
    expect(screen.getByRole("status")).toHaveTextContent("专题已归档");
    expect(document.querySelectorAll(".journal-library-records .record-card")).toHaveLength(0);
    expect(props.onResolvePreview).toHaveBeenCalledWith(undefined);
  });
  it("renders old desktop calendar states as the reading workspace", () => {
    render(<JournalPage {...previewProps()} browseMode="calendar" selectedDate="2026-06-21" selectedSubject="OS" />);
    expect(document.querySelector(".journal-fixed-reading")).toBeInTheDocument();
    expect(screen.queryByText("本月有记录日期")).not.toBeInTheDocument();
  });
  it("keeps a retained selection inside the paginated list when widening scope", () => {
    const props = previewProps();
    const onVisibleRecordCountChange = vi.fn();
    const blocks = Array.from({ length: 50 }, (_, index) => record("record-" + index, "2026-06-21"));
    render(<JournalPage {...props} blocks={blocks} previewRecordId="record-35" visibleRecordCount={20} onVisibleRecordCountChange={onVisibleRecordCountChange} />);
    expect(document.querySelectorAll(".journal-library-records .record-card")).toHaveLength(40);
    expect(document.querySelector('[data-record-id="record-35"] .record-card-main')).toHaveAttribute("aria-current", "true");
    expect(onVisibleRecordCountChange).toHaveBeenCalledWith(40);
  });
  it("filters through a compact select and keeps an archived current filter visible", () => {
    const onSubjectFilterChange = vi.fn();
    render(<JournalPage blocks={[]} subjects={subjects} month={new Date("2026-06-01")} subjectFilter="历史学科" onMonthChange={vi.fn()} onSelectedDateChange={vi.fn()} onSelectedSubjectChange={vi.fn()} onOpenRecord={vi.fn()} onOpenSearch={vi.fn()} onAskAi={vi.fn()} onToggleFavorite={vi.fn()} onSubjectFilterChange={onSubjectFilterChange} />);
    expect(screen.getByRole("combobox", { name: "按学科筛选" })).toHaveValue("历史学科");
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "OS" } });
    expect(onSubjectFilterChange).toHaveBeenCalledWith("OS");
    expect(screen.getByText("按日志日期")).toBeInTheDocument();
    expect(screen.queryByText("最近更新")).not.toBeInTheDocument();
  });
  it("opens full-text search from the compact header action", () => {
    const onOpenSearch = vi.fn();

    render(
      <JournalPage
        blocks={[]}
        subjects={subjects}
        month={new Date("2026-06-01")}
        onMonthChange={vi.fn()}
        onSelectedDateChange={vi.fn()}
        onSelectedSubjectChange={vi.fn()}
        onOpenRecord={vi.fn()}
        onOpenSearch={onOpenSearch}
        onAskAi={vi.fn()}
        onToggleFavorite={vi.fn()}
      />,
    );

    expect(screen.queryByText("学科分类")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "全局搜索" }));

    expect(onOpenSearch).toHaveBeenCalledTimes(1);
  });

  it("requests the calendar view without rebuilding its record list locally", () => {
    view.mobile = true;
    const onBrowseModeChange = vi.fn();
    const blocks: Block[] = [
      record("r1", "2026-06-21"),
      record("r2", "2026-06-20"),
      record("r3", "2026-06-19"),
      record("r4", "2026-06-18"),
      record("r5", "2026-06-17"),
      record("r6", "2026-06-01"),
      record("may", "2026-05-31"),
      record("july", "2026-07-01"),
    ];

    render(
      <JournalPage
        blocks={blocks}
        subjects={subjects}
        month={new Date("2026-06-01")}
        onMonthChange={vi.fn()}
        onSelectedDateChange={vi.fn()}
        onSelectedSubjectChange={vi.fn()}
        onOpenRecord={vi.fn()}
        onOpenSearch={vi.fn()}
        onAskAi={vi.fn()}
        onToggleFavorite={vi.fn()}
        onBrowseModeChange={onBrowseModeChange}
      />,
    );

    fireEvent.click(screen.getByRole("tab", { name: "按日期" }));
    expect(onBrowseModeChange).toHaveBeenCalledWith("calendar");
  });

  it("shows every record date in the controlled calendar view and opens AI for older dates", () => {
    view.mobile = true;
    const onAskAi = vi.fn();
    const blocks: Block[] = [
      record("r1", "2026-06-21"),
      record("r2", "2026-06-20"),
      record("r3", "2026-06-19"),
      record("r4", "2026-06-18"),
      record("r5", "2026-06-17"),
      record("r6", "2026-06-01"),
      record("may", "2026-05-31"),
      record("july", "2026-07-01"),
    ];

    render(
      <JournalPage
        blocks={blocks}
        subjects={subjects}
        month={new Date("2026-06-01")}
        browseMode="calendar"
        onMonthChange={vi.fn()}
        onSelectedDateChange={vi.fn()}
        onSelectedSubjectChange={vi.fn()}
        onOpenRecord={vi.fn()}
        onOpenSearch={vi.fn()}
        onAskAi={onAskAi}
        onToggleFavorite={vi.fn()}
      />,
    );

    expect(screen.getByText("本月有记录日期")).toBeInTheDocument();
    expect(screen.getByText("2026-06-01 学习日志")).toBeInTheDocument();
    expect(screen.queryByText("2026-05-31 学习日志")).not.toBeInTheDocument();
    expect(screen.queryByText("2026-07-01 学习日志")).not.toBeInTheDocument();

    const oldCard = screen.getByText("2026-06-01 学习日志").closest("article");
    expect(oldCard).not.toBeNull();
    fireEvent.click(within(oldCard as HTMLElement).getByRole("button", { name: "AI问答" }));

    expect(onAskAi).toHaveBeenCalledWith("2026-06-01");
  });

  it("bounds the all-records DOM and loads 92 records in batches of 20", () => {
    const blocks = Array.from({ length: 92 }, (_, index) => ({
      ...record(`record-${index}`, "2026-06-21"),
      title: `性能日志 ${index + 1}`,
      contentHtml: `<p>${"长正文内容".repeat(200)}</p>`,
    }));
    const onVisibleRecordCountChange = vi.fn();
    const props = {
      blocks,
      subjects,
      month: new Date("2026-06-01"),
      onMonthChange: vi.fn(),
      onSelectedDateChange: vi.fn(),
      onSelectedSubjectChange: vi.fn(),
      onOpenRecord: vi.fn(),
      onOpenSearch: vi.fn(),
      onAskAi: vi.fn(),
      onToggleFavorite: vi.fn(),
      onVisibleRecordCountChange,
    };
    const { rerender } = render(<JournalPage {...props} visibleRecordCount={20} />);

    expect(document.querySelectorAll(".journal-library-records .record-card")).toHaveLength(20);
    expect(screen.getByText("已显示 20 / 92")).toBeInTheDocument();
    expect(screen.queryByText("性能日志 21")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "再显示 20 条" }));
    expect(onVisibleRecordCountChange).toHaveBeenCalledWith(40);

    rerender(<JournalPage {...props} visibleRecordCount={40} />);
    expect(document.querySelectorAll(".journal-library-records .record-card")).toHaveLength(40);
    expect(screen.getByText("性能日志 21")).toBeInTheDocument();
    expect(screen.getByText("已显示 40 / 92")).toBeInTheDocument();
  });

  it("restores the list scroll position after returning from a record", () => {
    const scrollTo = vi.spyOn(window, "scrollTo").mockImplementation(() => undefined);
    const requestFrame = vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      callback(0);
      return 1;
    });
    const cancelFrame = vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => undefined);

    const scrollRecords = Array.from({ length: 21 }, (_, index) => record(`r${index}`, "2026-06-21"));
    const props = {
      blocks: scrollRecords,
      subjects,
      month: new Date("2026-06-01"),
      restoreListScrollY: 640,
      onMonthChange: vi.fn(),
      onSelectedDateChange: vi.fn(),
      onSelectedSubjectChange: vi.fn(),
      onOpenRecord: vi.fn(),
      onOpenSearch: vi.fn(),
      onAskAi: vi.fn(),
      onToggleFavorite: vi.fn(),
    };
    const { rerender, unmount } = render(
      <JournalPage
        {...props}
        visibleRecordCount={20}
      />,
    );

    expect(scrollTo).toHaveBeenCalledWith({ top: 640 });
    rerender(<JournalPage {...props} visibleRecordCount={40} />);
    expect(scrollTo).toHaveBeenCalledTimes(1);
    unmount();
    expect(cancelFrame).toHaveBeenCalledWith(1);
    scrollTo.mockRestore();
    requestFrame.mockRestore();
    cancelFrame.mockRestore();
  });

  it("exports selected records through the existing multi-select mode", async () => {
    view.mobile = true;
    const onExportRecords = vi.fn(async () => "已开始下载日志互通包。");

    render(
      <JournalPage
        blocks={[record("r1", "2026-06-21")]}
        subjects={subjects}
        month={new Date("2026-06-01")}
        selectedDate="2026-06-21"
        selectedSubject="OS"
        onMonthChange={vi.fn()}
        onSelectedDateChange={vi.fn()}
        onSelectedSubjectChange={vi.fn()}
        onOpenRecord={vi.fn()}
        onOpenSearch={vi.fn()}
        onAskAi={vi.fn()}
        onToggleFavorite={vi.fn()}
        onExportRecords={onExportRecords}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "选择" }));
    fireEvent.click(screen.getByRole("button", { name: "选择记录" }));
    fireEvent.click(screen.getByRole("button", { name: "导出选中日志" }));

    await waitFor(() => expect(onExportRecords).toHaveBeenCalledWith(["r1"]));
  });
});
