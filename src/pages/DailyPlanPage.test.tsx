import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DailyPlanPage } from "./DailyPlanPage";
import type { DailyPlan, RecordBlock, RecordDraft, SubjectConfig } from "../types";
import { addDaysISO } from "../lib/date";

const stamp = "2026-09-16T00:00:00.000Z";
const today = "2026-09-16";
const yesterday = "2026-09-15";
const PLAN_TITLE = "三大计算 660 题第 50 到 60 题";

const subjects: SubjectConfig[] = [
  { id: "subject-math", createdAt: stamp, updatedAt: stamp, name: "数学", order: 0 },
  { id: "subject-english", createdAt: stamp, updatedAt: stamp, name: "英语", order: 1 },
];

const makePlan = (overrides: Partial<DailyPlan> = {}): DailyPlan => ({
  id: "plan-1",
  createdAt: stamp,
  updatedAt: stamp,
  date: today,
  subject: "数学",
  title: PLAN_TITLE,
  order: 0,
  ...overrides,
});

const makeRecord = (overrides: Partial<RecordBlock> = {}): RecordBlock => ({
  id: "record-1",
  createdAt: stamp,
  updatedAt: stamp,
  type: "record",
  date: today,
  order: 0,
  subject: "数学",
  title: PLAN_TITLE,
  contentHtml: "<p>做了 10 题，错 2 题</p>",
  assets: [],
  formulas: [],
  mistakeRefs: [],
  tags: [],
  ...overrides,
});

const makeDraft = (recordId: string): RecordDraft => ({
  id: `draft-${recordId}`,
  recordId,
  baseUpdatedAt: stamp,
  draft: makeRecord({ id: recordId }),
  updatedAt: stamp,
});

interface RenderOptions {
  plans?: DailyPlan[];
  blocks?: RecordBlock[];
  deletedRecords?: RecordBlock[];
  recordDrafts?: RecordDraft[];
  view?: "today" | "history";
  defaultSubject?: string;
  inFlightDraftRecordIds?: ReadonlySet<string>;
  onBack?: () => void;
  onViewChange?: (view: "today" | "history") => void;
  onCreatePlan?: (input: { date: string; subject: string; title: string }) => Promise<DailyPlan | undefined>;
  onDeletePlan?: (plan: DailyPlan) => Promise<void>;
  onOpenPlan?: (plan: DailyPlan) => Promise<RecordBlock | undefined>;
  onOpenRecord?: (record: RecordBlock) => void;
}

const renderPage = (options: RenderOptions = {}) => {
  const handlers = {
    onBack: options.onBack ?? vi.fn(),
    onViewChange: options.onViewChange ?? vi.fn(),
    onCreatePlan: options.onCreatePlan ?? vi.fn().mockResolvedValue(undefined),
    onDeletePlan: options.onDeletePlan ?? vi.fn().mockResolvedValue(undefined),
    onOpenPlan: options.onOpenPlan ?? vi.fn().mockResolvedValue(undefined),
    onOpenRecord: options.onOpenRecord ?? vi.fn(),
  };
  const utils = render(
    <DailyPlanPage
      plans={options.plans ?? []}
      blocks={options.blocks ?? []}
      deletedRecords={options.deletedRecords ?? []}
      recordDrafts={options.recordDrafts ?? []}
      subjects={subjects}
      assets={[]}
      reviewStates={[]}
      inFlightDraftRecordIds={options.inFlightDraftRecordIds ?? new Set<string>()}
      today={today}
      defaultSubject={options.defaultSubject}
      view={options.view ?? "today"}
      onViewChange={handlers.onViewChange}
      onBack={handlers.onBack}
      onCreatePlan={handlers.onCreatePlan}
      onDeletePlan={handlers.onDeletePlan}
      onOpenPlan={handlers.onOpenPlan}
      onOpenRecord={handlers.onOpenRecord}
    />,
  );
  return { ...utils, handlers };
};

/** The row button, not the delete button: only the row starts with the subject. */
const openButtonFor = (title: string, subject = "数学") =>
  screen.getByRole("button", { name: new RegExp(`^${subject} ${title}`) });

beforeEach(() => {
  vi.spyOn(window, "confirm").mockReturnValue(true);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("DailyPlanPage", () => {
  it("starts with the empty state and a disabled submit button", () => {
    renderPage();

    expect(screen.getByText("今天还没有计划。列一条，做完就能顺手记下来。")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /添加计划/ })).toBeDisabled();
    expect(screen.getByText("较长的计划可以拆成多条")).toBeInTheDocument();
  });

  it("creates a plan for today with the chosen subject and clears the input", async () => {
    const onCreatePlan = vi.fn().mockResolvedValue(makePlan({ id: "plan-new" }));
    renderPage({ onCreatePlan });

    const input = screen.getByLabelText("计划标题");
    expect(input).toHaveAttribute("maxlength", "40");

    fireEvent.change(input, { target: { value: "  三大计算  " } });
    fireEvent.click(screen.getByRole("button", { name: /添加计划/ }));

    await waitFor(() => expect(onCreatePlan).toHaveBeenCalledWith({
      date: today,
      subject: "数学",
      title: "三大计算",
    }));
    await waitFor(() => expect(input).toHaveValue(""));
    // The subject choice is remembered for the next plan in the same session.
    expect(screen.getByRole("button", { name: "数学" })).toHaveClass("active");
  });

  it("submits on Enter and ignores a whitespace-only title", async () => {
    const onCreatePlan = vi.fn().mockResolvedValue(undefined);
    renderPage({ onCreatePlan });

    const input = screen.getByLabelText("计划标题");
    fireEvent.change(input, { target: { value: "   " } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onCreatePlan).not.toHaveBeenCalled();

    fireEvent.change(input, { target: { value: "背 50 个单词" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(onCreatePlan).toHaveBeenCalledWith({
      date: today,
      subject: "数学",
      title: "背 50 个单词",
    }));
  });

  it("files a plan under another subject when the picker changes", async () => {
    const onCreatePlan = vi.fn().mockResolvedValue(undefined);
    renderPage({ onCreatePlan });

    fireEvent.click(screen.getByRole("button", { name: "英语" }));
    fireEvent.change(screen.getByLabelText("计划标题"), { target: { value: "精读一篇" } });
    fireEvent.click(screen.getByRole("button", { name: /添加计划/ }));

    await waitFor(() => expect(onCreatePlan).toHaveBeenCalledWith({
      date: today,
      subject: "英语",
      title: "精读一篇",
    }));
  });

  it("renders the three outcome states, all derived and none persisted", () => {
    renderPage({
      plans: [
        makePlan({ id: "plan-done", order: 0, title: "完成的计划", linkedRecordId: "record-done" }),
        makePlan({ id: "plan-pending", order: 1, title: "没写的计划" }),
        makePlan({ id: "plan-draft", order: 2, title: "写了没保存的计划", linkedRecordId: "record-draft" }),
      ],
      blocks: [
        makeRecord({ id: "record-done", title: "完成的计划", contentHtml: "<p>写完了</p>" }),
        makeRecord({ id: "record-draft", title: "写了没保存的计划", contentHtml: "" }),
      ],
      recordDrafts: [makeDraft("record-draft")],
    });

    expect(screen.getAllByText("已完成")).toHaveLength(1);
    expect(screen.getAllByText("未完成")).toHaveLength(1);
    expect(screen.getByText("未保存（上次输入已保留）")).toBeInTheDocument();
  });

  it("reads a record that only holds its own title as unfulfilled", () => {
    renderPage({
      plans: [makePlan({ linkedRecordId: "record-shell" })],
      blocks: [makeRecord({ id: "record-shell", contentHtml: "<p></p>" })],
    });

    expect(screen.getByText("未完成")).toBeInTheDocument();
    expect(screen.queryByText("日志已删除")).not.toBeInTheDocument();
  });

  it("treats a plan whose log sits in the trash as unfulfilled and says so (D8)", () => {
    renderPage({
      plans: [makePlan({ linkedRecordId: "record-trashed" })],
      deletedRecords: [makeRecord({ id: "record-trashed", deletedAt: "2026-09-16T02:00:00.000Z" })],
    });

    expect(screen.getByText("未完成")).toBeInTheDocument();
    expect(screen.getByText("日志已删除")).toBeInTheDocument();
    // The plan keeps its own identity: the title is never rewritten by D8.
    expect(screen.getByText(PLAN_TITLE)).toBeInTheDocument();
  });

  it("shows a draft outcome while a flush is still in flight", () => {
    const { unmount } = renderPage({
      plans: [makePlan({ linkedRecordId: "record-inflight" })],
      blocks: [makeRecord({ id: "record-inflight", contentHtml: "" })],
    });
    // Nothing claimed the write yet, so the row is simply unfulfilled.
    expect(screen.getByText("未完成")).toBeInTheDocument();
    unmount();

    renderPage({
      plans: [makePlan({ linkedRecordId: "record-inflight" })],
      blocks: [makeRecord({ id: "record-inflight", contentHtml: "" })],
      inFlightDraftRecordIds: new Set(["record-inflight"]),
    });
    // The editor persists drafts after it navigates away, so this window -
    // "no draft on disk, but a write is on its way" - must not read as empty.
    expect(screen.getByText("未保存（上次输入已保留）")).toBeInTheDocument();
  });

  it("keeps the plan title as the row identity and only notes a diverged log title", () => {
    const { unmount } = renderPage({
      plans: [makePlan({ linkedRecordId: "record-1" })],
      blocks: [makeRecord({ id: "record-1", title: "改了标题的日志" })],
    });

    expect(screen.getByText(PLAN_TITLE)).toBeInTheDocument();
    expect(screen.getByText("· 来自日志「改了标题的日志」")).toBeInTheDocument();
    unmount();

    renderPage({
      plans: [makePlan({ linkedRecordId: "record-2" })],
      blocks: [makeRecord({ id: "record-2", title: PLAN_TITLE })],
    });
    expect(screen.queryByText(/来自日志/)).not.toBeInTheDocument();
  });

  it("shows the header tally only once a plan exists", () => {
    const { unmount } = renderPage({
      plans: [
        makePlan({ id: "plan-done", linkedRecordId: "record-done" }),
        makePlan({ id: "plan-open", order: 1, title: "还没写的" }),
      ],
      blocks: [makeRecord({ id: "record-done" })],
    });
    expect(screen.getByText("1 / 2 完成")).toBeInTheDocument();
    unmount();

    renderPage();
    expect(screen.queryByText(/完成$/)).not.toBeInTheDocument();
  });

  it("opens the plan's log and renders the record the caller returns", async () => {
    const plan = makePlan();
    const record = makeRecord();
    const onOpenPlan = vi.fn().mockResolvedValue(record);
    const onOpenRecord = vi.fn();
    renderPage({ plans: [plan], onOpenPlan, onOpenRecord });

    fireEvent.click(openButtonFor(PLAN_TITLE));

    await waitFor(() => expect(onOpenPlan).toHaveBeenCalledWith(plan));
    await waitFor(() => expect(onOpenRecord).toHaveBeenCalledWith(record));
  });

  it("debounces a double tap so one plan cannot spawn two logs", async () => {
    let release: (record: RecordBlock | undefined) => void = () => undefined;
    const onOpenPlan = vi.fn(() => new Promise<RecordBlock | undefined>((resolve) => { release = resolve; }));
    renderPage({ plans: [makePlan()], onOpenPlan });

    const row = openButtonFor(PLAN_TITLE);
    fireEvent.click(row);
    fireEvent.click(row);
    fireEvent.click(row);

    expect(onOpenPlan).toHaveBeenCalledTimes(1);
    release(undefined);
    await waitFor(() => expect(row).not.toBeDisabled());
  });

  it("surfaces a failed plan open without crashing the page", async () => {
    const onOpenPlan = vi.fn().mockRejectedValue(new Error("boom"));
    renderPage({ plans: [makePlan()], onOpenPlan });

    fireEvent.click(openButtonFor(PLAN_TITLE));

    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("操作没有完成"));
  });

  it("confirms before deleting a plan and cancels cleanly", async () => {
    const plan = makePlan();
    const onDeletePlan = vi.fn().mockResolvedValue(undefined);
    renderPage({ plans: [plan], onDeletePlan });

    vi.mocked(window.confirm).mockReturnValue(false);
    fireEvent.click(screen.getByRole("button", { name: `删除计划 ${plan.title}` }));
    expect(onDeletePlan).not.toHaveBeenCalled();

    vi.mocked(window.confirm).mockReturnValue(true);
    fireEvent.click(screen.getByRole("button", { name: `删除计划 ${plan.title}` }));
    await waitFor(() => expect(onDeletePlan).toHaveBeenCalledWith(plan));
    expect(window.confirm).toHaveBeenCalledWith(
      "删除这条计划？已经写好的日志会保留，日志上的「来自计划」标识也会保留。",
    );
  });

  it("switches views through the caller's navigation state, not local state", () => {
    const onViewChange = vi.fn();
    renderPage({ view: "today", onViewChange });

    fireEvent.click(screen.getByRole("tab", { name: "历史" }));

    expect(onViewChange).toHaveBeenCalledWith("history");
    // Still the today view: the page renders whatever the caller decided.
    expect(screen.getByRole("heading", { name: "今日计划" })).toBeInTheDocument();
  });

  it("returns to the previous screen from both views", () => {
    const onBack = vi.fn();
    const { unmount } = renderPage({ onBack });
    fireEvent.click(screen.getByRole("button", { name: "返回今天" }));
    expect(onBack).toHaveBeenCalledTimes(1);
    unmount();

    const historyBack = vi.fn();
    renderPage({ view: "history", plans: [makePlan()], onBack: historyBack });
    fireEvent.click(screen.getByRole("button", { name: "返回今天" }));
    expect(historyBack).toHaveBeenCalledTimes(1);
  });

  it("groups history by planned day, newest first, with per-day tallies", () => {
    const { container } = renderPage({
      view: "history",
      plans: [
        makePlan({ id: "plan-today-1", date: today, order: 0, title: "今天的计划一", linkedRecordId: "record-today" }),
        makePlan({ id: "plan-today-2", date: today, order: 1, title: "今天的计划二" }),
        makePlan({ id: "plan-yesterday", date: yesterday, order: 0, subject: "英语", title: "昨天的计划" }),
      ],
      blocks: [makeRecord({ id: "record-today", title: "今天的计划一", contentHtml: "<p>写好了</p>" })],
    });

    expect(screen.getByRole("heading", { name: "计划历史" })).toBeInTheDocument();
    const groups = [...container.querySelectorAll(".daily-plan-history-group")];
    expect(groups).toHaveLength(2);
    expect(groups[0].querySelector("time")?.textContent).toBe("9 月 16 日");
    expect(groups[0].querySelector("small")?.textContent).toBe("1/2");
    expect(groups[1].querySelector("time")?.textContent).toBe("9 月 15 日");
    expect(groups[1].querySelector("small")?.textContent).toBe("0/1");
  });

  it("renders only the days that had plans and collapses the tail", () => {
    const manyPlans = Array.from({ length: 31 }, (_, index) => makePlan({
      id: `plan-${index}`,
      date: addDaysISO(today, -index),
      title: `第 ${index + 1} 天的计划`,
    }));
    const { container } = renderPage({ view: "history", plans: manyPlans });

    const groupCount = () => container.querySelectorAll(".daily-plan-history-group").length;
    expect(groupCount()).toBe(30);
    fireEvent.click(screen.getByRole("button", { name: "展开全部（还有 1 天）" }));
    expect(groupCount()).toBe(31);
    expect(screen.queryByRole("button", { name: /展开全部/ })).not.toBeInTheDocument();
  });

  it("derives honest window summaries instead of a percentage", () => {
    renderPage({
      view: "history",
      plans: [
        makePlan({ id: "plan-done", date: today, order: 0, title: "今天写掉的", linkedRecordId: "record-done" }),
        makePlan({ id: "plan-open", date: today, order: 1, title: "今天没写的" }),
      ],
      blocks: [makeRecord({ id: "record-done", title: "今天写掉的", contentHtml: "<p>写好了</p>" })],
    });

    const summary = screen.getByRole("region", { name: "计划汇总" });
    const cards = [...summary.querySelectorAll(".stats-state-card")];
    expect(cards[0]).toHaveTextContent("近 7 天已兑现");
    expect(cards[0].querySelector("strong")).toHaveTextContent("1 / 2");
    expect(cards[0].querySelector("small")).toHaveTextContent("共 2 条计划");
    expect(cards[2]).toHaveTextContent("连续完成");
    expect(cards[2].querySelector("small")).toHaveTextContent("仅计有计划的日子");
    expect(summary.textContent).not.toContain("%");
  });

  it("reports an empty window as no data and shows the history empty state", () => {
    const { unmount } = renderPage({ view: "history" });
    expect(screen.getByText("还没有计划历史。从今天开始列计划，这里会留下记录。")).toBeInTheDocument();
    unmount();

    renderPage({ view: "history", plans: [makePlan({ date: addDaysISO(today, -40) })] });
    const summary = screen.getByRole("region", { name: "计划汇总" });
    const cards = [...summary.querySelectorAll(".stats-state-card")];
    expect(cards[0].querySelector("strong")).toHaveTextContent("—");
    expect(cards[0].querySelector("small")).toHaveTextContent("这几天没有计划");
  });

  it("tallies the subject distribution from fulfilled plans", () => {
    renderPage({
      view: "history",
      plans: [
        makePlan({ id: "plan-1", order: 0, subject: "数学", title: "数学一", linkedRecordId: "record-1" }),
        makePlan({ id: "plan-2", order: 1, subject: "数学", title: "数学二" }),
        makePlan({ id: "plan-3", order: 2, subject: "英语", title: "英语一" }),
      ],
      blocks: [makeRecord({ id: "record-1", title: "数学一", contentHtml: "<p>写了</p>" })],
    });

    const region = screen.getByRole("region", { name: "学科分布" });
    expect(region.textContent).toContain("数学1 / 2");
    expect(region.textContent).toContain("英语0 / 1");
  });

  it("keeps the narrow-screen structure the responsive rules bind to", () => {
    const { container } = renderPage({ plans: [makePlan()] });

    // The two-column row and the compose row are the elements the 640px media
    // query restacks; if either disappears, the mobile layout silently breaks.
    expect(container.querySelector(".daily-plan-compose-row")).toBeInTheDocument();
    expect(container.querySelector(".daily-plan-row-main")).toBeInTheDocument();
    expect(container.querySelector(".daily-plan-row-delete")).toBeInTheDocument();
    expect(container.querySelector(".daily-plan-row-title")).toHaveTextContent(PLAN_TITLE);
  });
});
