import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { useState } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { RecordBlock, RecordReviewLog, RecordReviewRating, RecordReviewState, RecordReviewStats, RecordReviewUndoToken, SubjectConfig } from "../types";
import type { AnalysisQueueItem, DecisionBlockFeedback } from "../features/reviewCoach/domain";
import { createInitialReviewLibraryState } from "../lib/tabNavigation";

const richTextEditorMock = vi.hoisted(() => ({
  props: [] as any[],
}));

vi.mock("../components/RichTextEditor", () => ({
  RichTextEditor: (props: any) => {
    richTextEditorMock.props.push(props);
    return <div data-testid="rich-editor" />;
  },
}));

vi.mock("../lib/date", async () => {
  const actual = await vi.importActual<typeof import("../lib/date")>("../lib/date");
  return {
    ...actual,
    todayISO: () => "2026-07-03",
  };
});

import { ReviewPage } from "./ReviewPage";

const stamp = "2026-06-21T00:00:00.000Z";

const record = (id: string, title: string, subject: string): RecordBlock => ({
  id,
  createdAt: stamp,
  updatedAt: stamp,
  type: "record",
  date: "2026-06-20",
  order: 0,
  subject,
  tags: [],
  title,
  contentHtml: "<p>content</p>",
  assets: [],
  formulas: [],
  mistakeRefs: [],
});

const withDecisionBlock = (item: RecordBlock, decisionBlockId = `decision-${item.id}`): RecordBlock => ({
  ...item,
  contentHtml: `<p>content</p><record-decision-block data-decision-block-id="${decisionBlockId}" data-content-version="1" data-created-at="${stamp}" data-updated-at="${stamp}"><p>${item.title} 的关键边界</p></record-decision-block>`,
});

const decisionBlockFeedback = (patch: Partial<DecisionBlockFeedback> = {}): DecisionBlockFeedback => ({
  id: "feedback-active",
  decisionBlockId: "decision-active",
  recordId: "active",
  contentVersion: 1,
  reviewLogId: "log-active",
  comment: "入队时机仍然容易混淆",
  includeInAnalysis: true,
  source: "review",
  occurredAt: "2026-07-02T16:30:00.000Z",
  idempotencyKey: "feedback-operation-active",
  createdAt: "2026-07-02T16:30:00.000Z",
  updatedAt: "2026-07-02T16:30:00.000Z",
  ...patch,
});

const analysisQueueItem = (patch: Partial<AnalysisQueueItem> = {}): AnalysisQueueItem => ({
  id: "queue-active",
  decisionBlockId: "decision-active",
  recordId: "active",
  contentVersion: 1,
  feedbackId: "feedback-active",
  status: "eligible",
  eligibilityReason: "user-feedback",
  createdAt: "2026-07-02T16:30:00.000Z",
  updatedAt: "2026-07-02T16:30:00.000Z",
  ...patch,
});

const review = (recordId: string, patch: Partial<RecordReviewState> = {}): RecordReviewState => ({
  id: recordId,
  recordId,
  createdAt: stamp,
  updatedAt: stamp,
  status: "active",
  easeFactor: 2.5,
  repetition: 1,
  intervalDays: 1,
  nextReviewDate: "2026-07-02",
  consecutiveRemembered: 1,
  totalReviews: 2,
  ...patch,
});

const reviewLog = (recordId: string, patch: Partial<RecordReviewLog> = {}): RecordReviewLog => ({
  id: `log-${recordId}`,
  recordId,
  createdAt: stamp,
  updatedAt: stamp,
  rating: "good",
  normalizedRating: "good",
  reviewKind: "overview",
  scheduler: "overview-v1",
  reviewedAt: "2026-07-02T16:30:00.000Z",
  previousEaseFactor: 2.5,
  nextEaseFactor: 2.6,
  previousRepetition: 1,
  nextRepetition: 2,
  previousIntervalDays: 1,
  nextIntervalDays: 6,
  ...patch,
});

const undoToken = (recordId: string): RecordReviewUndoToken => ({
  recordId,
  reviewedAt: "2026-07-03T01:30:00.000Z",
  reviewLogId: `log-${recordId}`,
  previousReview: review(recordId),
});

const stats: RecordReviewStats = {
  activeCount: 2,
  masteredCount: 1,
  dueCount: 2,
  overdueCount: 1,
  totalReviews: 2,
  streakDays: 0,
  dayStats: [],
  masteryTrend: [],
};

const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};

const records = [
  record("active", "BFS 队列", "数据结构"),
  record("second", "页表缓存", "OS"),
  record("new", "概率笔记", "数学"),
  record("mastered", "进程同步", "OS"),
];

const referenceSubjects: SubjectConfig[] = [
  { id: "subject-data", createdAt: stamp, updatedAt: stamp, name: "数据结构", order: 0 },
  { id: "subject-os", createdAt: stamp, updatedAt: stamp, name: "OS", order: 1 },
  { id: "subject-math", createdAt: stamp, updatedAt: stamp, name: "数学", order: 2 },
];

type RenderOptions = Partial<React.ComponentProps<typeof ReviewPage>>;

const renderReviewPage = (options: RenderOptions = {}) => {
  const handlers = {
    onModeChange: vi.fn(),
    onQueueChange: vi.fn(),
    onCurrentRecordChange: vi.fn(),
    onLibraryStateChange: vi.fn(),
    onEnsureDay: vi.fn().mockResolvedValue(undefined),
    onRate: vi.fn().mockResolvedValue(undefined),
    onUndo: vi.fn().mockResolvedValue(undefined),
    onRefresh: vi.fn().mockResolvedValue(undefined),
    onOpenStats: vi.fn(),
    onOpenRecord: vi.fn(),
    onEditRecord: vi.fn(),
    onAddToReview: vi.fn(),
    onRemoveReview: vi.fn(),
    onResetReview: vi.fn(),
  };
  const {
    libraryState: initialLibraryState = createInitialReviewLibraryState(),
    onLibraryStateChange = handlers.onLibraryStateChange,
    ...restOptions
  } = options;
  const ReviewPageHarness = () => {
    const [libraryState, setLibraryState] = useState(initialLibraryState);
    return (
      <ReviewPage
        records={records}
        dueReviews={[review("active")]}
        reviewStates={[review("active"), review("mastered", { status: "mastered", nextReviewDate: undefined })]}
        stats={stats}
        mode="manage"
        queueIds={["active"]}
        currentRecordId="active"
        {...handlers}
        {...restOptions}
        libraryState={libraryState}
        onLibraryStateChange={(state) => {
          onLibraryStateChange(state);
          setLibraryState(state);
        }}
      />
    );
  };
  render(
    <ReviewPageHarness />,
  );
  return { handlers: { ...handlers, ...restOptions, onLibraryStateChange }, records };
};

const clickRating = (name: string | RegExp) => {
  fireEvent.click(screen.getByRole("button", { name }));
};

describe("ReviewPage", () => {
  beforeEach(() => {
    window.localStorage.clear();
    richTextEditorMock.props = [];
  });

  it("opens voice recall for the current card without changing queue or rating state", () => {
    const onOpenVoiceRecall = vi.fn();
    const onQueueChange = vi.fn();
    const onCurrentRecordChange = vi.fn();
    const onRate = vi.fn();
    renderReviewPage({
      mode: "queue",
      dueReviews: [review("active")],
      reviewStates: [review("active")],
      queueIds: ["active", "second"],
      currentRecordId: "active",
      onOpenVoiceRecall,
      onQueueChange,
      onCurrentRecordChange,
      onRate,
    });

    const queueCallsBeforeOpen = onQueueChange.mock.calls.length;
    const currentCallsBeforeOpen = onCurrentRecordChange.mock.calls.length;
    fireEvent.click(screen.getByRole("button", { name: "打开复习更多菜单" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "语音复述当前卡片" }));

    expect(onOpenVoiceRecall).toHaveBeenCalledWith(records[0]);
    expect(onQueueChange).toHaveBeenCalledTimes(queueCallsBeforeOpen);
    expect(onCurrentRecordChange).toHaveBeenCalledTimes(currentCallsBeforeOpen);
    expect(onRate).not.toHaveBeenCalled();
  });

  it("shows a strictly later easy interval for overview cards", () => {
    const currentReview = review("active", { intervalDays: 10 });
    renderReviewPage({
      mode: "queue",
      dueReviews: [currentReview],
      reviewStates: [currentReview],
      queueIds: ["active"],
      currentRecordId: "active",
    });

    expect(screen.getByRole("button", { name: "良好，21天后" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "轻松，61天后" })).toBeInTheDocument();
  });

  it("uses a progress bar instead of queue statistics in the review workspace", () => {
    renderReviewPage({
      mode: "queue",
      dueReviews: [review("active"), review("second", { nextReviewDate: "2026-07-03" })],
      reviewStates: [review("active"), review("second", { nextReviewDate: "2026-07-03" })],
      queueIds: ["active", "second"],
      currentRecordId: "active",
    });

    const progress = screen.getByRole("progressbar", { name: "复习进度，第 1 条，共 2 条" });
    expect(progress).toHaveAttribute("aria-valuemin", "0");
    expect(progress).toHaveAttribute("aria-valuemax", "2");
    expect(progress).toHaveAttribute("aria-valuenow", "1");
    expect(screen.queryByText("已掌握")).not.toBeInTheDocument();
  });

  it("keeps the review total fixed while advancing through the session", async () => {
    const sessionReviews = [
      review("active"),
      review("second", { nextReviewDate: "2026-07-03" }),
      review("new", { nextReviewDate: "2026-07-03" }),
    ];
    const ProgressHarness = () => {
      const [queueIds, setQueueIds] = useState(sessionReviews.map((item) => item.recordId));
      const [currentRecordId, setCurrentRecordId] = useState<string | undefined>("active");
      const [libraryState, setLibraryState] = useState(createInitialReviewLibraryState());

      return (
        <ReviewPage
          records={records}
          dueReviews={sessionReviews}
          reviewStates={sessionReviews}
          stats={stats}
          mode="queue"
          queueIds={queueIds}
          currentRecordId={currentRecordId}
          libraryState={libraryState}
          onModeChange={vi.fn()}
          onQueueChange={setQueueIds}
          onCurrentRecordChange={setCurrentRecordId}
          onLibraryStateChange={setLibraryState}
          onEnsureDay={vi.fn().mockResolvedValue(undefined)}
          onRate={vi.fn().mockResolvedValue(undefined)}
          onUndo={vi.fn().mockResolvedValue(undefined)}
          onRefresh={vi.fn().mockResolvedValue(undefined)}
          onOpenRecord={vi.fn()}
          onEditRecord={vi.fn()}
          onAddToReview={vi.fn()}
          onRemoveReview={vi.fn()}
          onResetReview={vi.fn()}
        />
      );
    };

    render(<ProgressHarness />);

    const initialProgress = screen.getByRole("progressbar", { name: "复习进度，第 1 条，共 3 条" });
    expect(initialProgress).toHaveAttribute("aria-valuemax", "3");
    expect(initialProgress).toHaveAttribute("aria-valuenow", "1");
    expect(initialProgress.querySelector("span")).toHaveStyle({ width: "33%" });
    expect(screen.getByRole("button", { name: /忘记了/ }).querySelector("svg")).toBeNull();
    expect(screen.getByRole("button", { name: /模糊/ }).querySelector("svg")).toBeNull();

    clickRating(/良好/);
    await waitFor(() => {
      const progress = screen.getByRole("progressbar", { name: "复习进度，第 2 条，共 3 条" });
      expect(progress).toHaveAttribute("aria-valuemax", "3");
      expect(progress).toHaveAttribute("aria-valuenow", "2");
      expect(progress.querySelector("span")).toHaveStyle({ width: "67%" });
    });

    clickRating(/良好/);
    await waitFor(() => {
      const progress = screen.getByRole("progressbar", { name: "复习进度，第 3 条，共 3 条" });
      expect(progress).toHaveAttribute("aria-valuemax", "3");
      expect(progress).toHaveAttribute("aria-valuenow", "3");
      expect(progress.querySelector("span")).toHaveStyle({ width: "100%" });
    });
  });

  it("keeps progress after a rating refresh removes the card from due reviews", async () => {
    const sessionReviews = [
      review("active"),
      review("second", { nextReviewDate: "2026-07-03" }),
      review("new", { nextReviewDate: "2026-07-03" }),
    ];
    const ProgressRefreshHarness = () => {
      const [dueReviews, setDueReviews] = useState(sessionReviews);
      const [queueIds, setQueueIds] = useState(sessionReviews.map((item) => item.recordId));
      const [currentRecordId, setCurrentRecordId] = useState<string | undefined>("active");

      return (
        <ReviewPage
          records={records}
          dueReviews={dueReviews}
          reviewStates={dueReviews}
          stats={stats}
          mode="queue"
          queueIds={queueIds}
          currentRecordId={currentRecordId}
          libraryState={createInitialReviewLibraryState()}
          onModeChange={vi.fn()}
          onQueueChange={setQueueIds}
          onCurrentRecordChange={setCurrentRecordId}
          onLibraryStateChange={vi.fn()}
          onEnsureDay={vi.fn().mockResolvedValue(undefined)}
          onRate={async (recordId) => {
            setDueReviews((current) => current.filter((item) => item.recordId !== recordId));
            return undefined;
          }}
          onUndo={vi.fn().mockResolvedValue(undefined)}
          onRefresh={vi.fn().mockResolvedValue(undefined)}
          onOpenRecord={vi.fn()}
          onEditRecord={vi.fn()}
          onAddToReview={vi.fn()}
          onRemoveReview={vi.fn()}
          onResetReview={vi.fn()}
        />
      );
    };

    render(<ProgressRefreshHarness />);
    expect(screen.getByRole("progressbar", { name: "复习进度，第 1 条，共 3 条" })).toBeInTheDocument();

    clickRating(/良好/);
    await waitFor(() => expect(screen.getByRole("progressbar", { name: "复习进度，第 2 条，共 3 条" })).toBeInTheDocument());

    clickRating(/良好/);
    await waitFor(() => {
      const progress = screen.getByRole("progressbar", { name: "复习进度，第 3 条，共 3 条" });
      expect(progress).toHaveAttribute("aria-valuemax", "3");
      expect(progress).toHaveAttribute("aria-valuenow", "3");
      expect(progress.querySelector("span")).toHaveStyle({ width: "100%" });
    });
  });

  it("moves undo, refresh and statistics into the review overflow menu", async () => {
    const { handlers } = renderReviewPage({
      mode: "queue",
      dueReviews: [review("active")],
      reviewStates: [review("active")],
      queueIds: ["active"],
      currentRecordId: "active",
    });

    fireEvent.click(screen.getByRole("button", { name: "打开复习更多菜单" }));
    expect(screen.getByRole("menuitem", { name: /撤回上次评分/ })).toBeDisabled();
    fireEvent.click(screen.getByRole("menuitem", { name: "刷新复习列表" }));
    await waitFor(() => expect(handlers.onRefresh).toHaveBeenCalledTimes(1));

    fireEvent.click(screen.getByRole("button", { name: "打开复习更多菜单" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "学习统计" }));
    expect(handlers.onOpenStats).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole("button", { name: "打开复习更多菜单" }));
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("menu", { name: "复习操作" })).not.toBeInTheDocument();
  });

  it("shows record tags on a review card", () => {
    renderReviewPage({
      mode: "queue",
      records: records.map((item) => item.id === "active" ? { ...item, tags: ["队列", "重点"] } : item),
      dueReviews: [review("active")],
      reviewStates: [review("active")],
      queueIds: ["active"],
      currentRecordId: "active",
    });

    expect(screen.getByLabelText("日志标签：队列、重点")).toBeInTheDocument();
  });

  it("keeps the deck scope collapsed above a full-width library and reuses the existing scope state", () => {
    const { handlers } = renderReviewPage({ mode: "manage" });
    const summary = screen.getByText("牌组范围");
    const details = summary.closest("details");

    expect(details).not.toHaveAttribute("open");
    expect(details?.parentElement?.nextElementSibling).toHaveClass("review-library-content");

    fireEvent.click(summary);
    expect(details).toHaveAttribute("open");
    fireEvent.click(within(details as HTMLElement).getByRole("button", { name: /^OS/ }));

    expect(handlers.onLibraryStateChange).toHaveBeenLastCalledWith(expect.objectContaining({
      scope: { kind: "subject", subject: "OS" },
    }));
  });

  it("places review-focus feedback after the centered read-only body", () => {
    renderReviewPage({
      records: records.map((item) => item.id === "active" ? withDecisionBlock(item) : item),
      mode: "queue",
      dueReviews: [review("active")],
      reviewStates: [review("active")],
      queueIds: ["active"],
      currentRecordId: "active",
    });

    const layout = document.querySelector(".review-learning-layout");
    expect(layout).toHaveClass("has-decision-blocks");
    expect(layout?.children[0]).toHaveClass("review-annotation-root");
    expect(layout?.children[1]).toHaveClass("decision-block-reflection-list");
  });

  it("replaces the rating dock with annotation tools and restores it when annotation closes", () => {
    renderReviewPage({
      records: records.map((item) => item.id === "active" ? withDecisionBlock(item) : item),
      mode: "queue",
      dueReviews: [review("active")],
      reviewStates: [review("active")],
      queueIds: ["active"],
      currentRecordId: "active",
    });

    expect(document.querySelector(".review-bottom-controls")).toHaveClass("review-viewport-dock", "has-decision-blocks");
    expect(screen.queryByRole("toolbar", { name: "批注工具栏" })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "打开批注工具" }));
    expect(document.querySelector(".review-bottom-controls")).toBeNull();
    expect(screen.getByRole("toolbar", { name: "批注工具栏" })).toHaveClass("review-viewport-dock");

    fireEvent.click(screen.getByRole("button", { name: "关闭批注工具" }));
    expect(document.querySelector(".review-bottom-controls")).toBeInTheDocument();
    expect(screen.queryByRole("toolbar", { name: "批注工具栏" })).not.toBeInTheDocument();
  });

  it("passes queue card references to the read-only editor without enabling queue editing", () => {
    const onOpenRecordReference = vi.fn();
    renderReviewPage({
      mode: "queue",
      queueIds: ["active"],
      currentRecordId: "active",
      referenceRecords: records,
      referenceSubjects,
      onOpenRecordReference,
    });

    const editorProps = richTextEditorMock.props.at(-1);
    expect(editorProps).toMatchObject({
      readOnly: true,
      currentRecordId: "active",
      referenceRecords: records,
      referenceSubjects,
    });

    editorProps.onOpenRecordReference("second");
    expect(onOpenRecordReference).toHaveBeenCalledWith("active", "second");
    expect(editorProps.renderInsertTools).toBeUndefined();
  });

  it("restores the review queue scroll position after returning from a reference", async () => {
    const scrollTo = vi.spyOn(window, "scrollTo").mockImplementation(() => undefined);
    renderReviewPage({
      mode: "queue",
      queueIds: ["active"],
      currentRecordId: "active",
      restoreScrollY: 286,
    });

    await waitFor(() => expect(scrollTo).toHaveBeenCalledWith(0, 286));
    scrollTo.mockRestore();
  });

  it("uses a compact card menu for preview, editing and review actions", () => {
    const { handlers } = renderReviewPage();

    expect(screen.getByText("BFS 队列")).toBeInTheDocument();
    expect(screen.getByText("概率笔记")).toBeInTheDocument();
    expect(screen.getByText("进程同步")).toBeInTheDocument();

    const activeCard = screen.getByText("BFS 队列").closest("article");
    expect(activeCard).not.toBeNull();
    expect(within(activeCard as HTMLElement).getByText("数据结构")).toBeInTheDocument();
    expect(within(activeCard as HTMLElement).getByText(/到期 2026-07-02/)).toBeInTheDocument();

    fireEvent.click(within(activeCard as HTMLElement).getByRole("button", { name: /打开 BFS 队列 的操作菜单/ }));
    fireEvent.click(within(activeCard as HTMLElement).getByRole("menuitem", { name: /预览/ }));
    fireEvent.click(within(activeCard as HTMLElement).getByRole("button", { name: /打开 BFS 队列 的操作菜单/ }));
    fireEvent.click(within(activeCard as HTMLElement).getByRole("menuitem", { name: /编辑/ }));
    fireEvent.click(within(activeCard as HTMLElement).getByRole("button", { name: /打开 BFS 队列 的操作菜单/ }));
    fireEvent.click(within(activeCard as HTMLElement).getByRole("menuitem", { name: /忘记重排/ }));
    fireEvent.click(within(activeCard as HTMLElement).getByRole("button", { name: /打开 BFS 队列 的操作菜单/ }));
    fireEvent.click(within(activeCard as HTMLElement).getByRole("menuitem", { name: /搁置/ }));

    expect(handlers.onOpenRecord).toHaveBeenCalledWith(records[0]);
    expect(handlers.onEditRecord).toHaveBeenCalledWith(records[0]);
    expect(handlers.onResetReview).toHaveBeenCalledWith("active");
    expect(handlers.onRemoveReview).toHaveBeenCalledWith("active");

    const newCard = screen.getByText("概率笔记").closest("article");
    expect(newCard).not.toBeNull();
    expect(within(newCard as HTMLElement).getByText("未加入")).toBeInTheDocument();
    fireEvent.click(within(newCard as HTMLElement).getByRole("button", { name: /打开 概率笔记 的操作菜单/ }));
    fireEvent.click(within(newCard as HTMLElement).getByRole("menuitem", { name: /加入复习/ }));

    expect(handlers.onAddToReview).toHaveBeenCalledWith("new");
  });

  it("does not clear an existing queue while the daily suggestion queue initializes", async () => {
    const onQueueChange = vi.fn();
    const onCurrentRecordChange = vi.fn();

    renderReviewPage({
      mode: "queue",
      dueReviews: [review("active")],
      reviewStates: [review("active")],
      queueIds: ["active"],
      currentRecordId: "active",
      onQueueChange,
      onCurrentRecordChange,
    });

    expect(screen.getByText("BFS 队列")).toBeInTheDocument();
    await waitFor(() => expect(screen.getByText("BFS 队列")).toBeInTheDocument());
    expect(onQueueChange).not.toHaveBeenCalledWith([]);
    expect(onCurrentRecordChange).not.toHaveBeenCalledWith(undefined);
  });

  it("initializes the suggested queue with at most twenty due cards", async () => {
    const manyRecords = Array.from({ length: 25 }, (_, index) => record(`due-${index + 1}`, `复习卡 ${index + 1}`, "数据结构"));
    const manyReviews = manyRecords.map((item) => review(item.id));
    const onQueueChange = vi.fn();
    const onCurrentRecordChange = vi.fn();

    renderReviewPage({
      records: manyRecords,
      dueReviews: manyReviews,
      reviewStates: manyReviews,
      mode: "queue",
      queueIds: [],
      currentRecordId: undefined,
      onQueueChange,
      onCurrentRecordChange,
    });

    const expectedIds = manyRecords.slice(0, 20).map((item) => item.id);
    await waitFor(() => expect(onQueueChange).toHaveBeenCalledWith(expectedIds));
    expect(onCurrentRecordChange).toHaveBeenCalledWith("due-1");
  });

  it("filters the card library by subject, tag and explicit status", () => {
    renderReviewPage({
      records: records.map((item) => item.id === "active" ? { ...item, tags: ["队列", "重点"] } : item),
    });

    fireEvent.click(screen.getByRole("button", { name: /^数据结构/ }));
    expect(screen.getByText("BFS 队列")).toBeInTheDocument();
    expect(screen.queryByText("概率笔记")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /^队列/ }));
    expect(screen.getByText("BFS 队列")).toBeInTheDocument();
    expect(screen.queryByText("页表缓存")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "筛选" }));
    fireEvent.click(screen.getByRole("button", { name: "已掌握" }));
    expect(screen.getByText("没有匹配的卡片")).toBeInTheDocument();
  });

  it("searches titles, subjects and tags without scanning record content", () => {
    renderReviewPage({
      records: records.map((item) => {
        if (item.id === "active") return { ...item, tags: ["图论"], contentHtml: "<p>仅正文命中</p>" };
        if (item.id === "second") return { ...item, tags: ["图论"] };
        return item;
      }),
    });

    fireEvent.change(screen.getByLabelText("搜索标题、学科、标签"), { target: { value: "图论" } });
    expect(screen.getByText("BFS 队列")).toBeInTheDocument();
    expect(screen.getByText("页表缓存")).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("搜索标题、学科、标签"), { target: { value: "仅正文命中" } });
    expect(screen.getByText("没有匹配的卡片")).toBeInTheDocument();
  });

  it("isolates identical tag names by subject while a record remains in each of its tag views", () => {
    renderReviewPage({
      records: records.map((item) => {
        if (item.id === "active") return { ...item, tags: ["专项", "队列"] };
        if (item.id === "second") return { ...item, tags: ["专项"] };
        return item;
      }),
      libraryState: {
        ...createInitialReviewLibraryState(),
        scope: { kind: "tag", subject: "数据结构", tag: "专项" },
      },
    });

    expect(screen.getByText("BFS 队列")).toBeInTheDocument();
    expect(screen.queryByText("页表缓存")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /^队列/ }));
    expect(screen.getByText("BFS 队列")).toBeInTheDocument();
  });

  it("keeps suspended cards out of the new-card filter and count", () => {
    renderReviewPage({
      reviewStates: [
        review("active"),
        review("new", { totalReviews: 0, nextReviewDate: "2026-07-03" }),
        review("second", { status: "removed", nextReviewDate: undefined }),
      ],
    });

    fireEvent.click(screen.getByRole("button", { name: "筛选" }));
    expect(screen.getByRole("button", { name: /^新卡$/ })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "新卡" }));
    expect(screen.getByText("概率笔记")).toBeInTheDocument();
    expect(screen.queryByText("页表缓存")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "已搁置" }));
    expect(screen.getByText("页表缓存")).toBeInTheDocument();
    expect(screen.queryByText("概率笔记")).not.toBeInTheDocument();
  });

  it("removes an overdue card immediately after a good rating and prevents stale due props from requeueing it", async () => {
    const onRate = vi.fn().mockResolvedValue(undefined);
    const onQueueChange = vi.fn();
    const onCurrentRecordChange = vi.fn();
    const { rerender } = render(
      <ReviewPage
        records={records}
        dueReviews={[review("active")]}
        reviewStates={[review("active")]}
        stats={stats}
        mode="queue"
        queueIds={["active"]}
        currentRecordId="active"
        libraryState={createInitialReviewLibraryState()}
        onModeChange={vi.fn()}
        onQueueChange={onQueueChange}
        onCurrentRecordChange={onCurrentRecordChange}
        onLibraryStateChange={vi.fn()}
        onEnsureDay={vi.fn().mockResolvedValue(undefined)}
        onRate={onRate}
        onUndo={vi.fn().mockResolvedValue(undefined)}
        onRefresh={vi.fn().mockResolvedValue(undefined)}
        onOpenRecord={vi.fn()}
        onEditRecord={vi.fn()}
        onAddToReview={vi.fn()}
        onRemoveReview={vi.fn()}
        onResetReview={vi.fn()}
      />,
    );

    expect(screen.getByText("BFS 队列")).toBeInTheDocument();
    clickRating(/良好/);

    expect(onQueueChange).toHaveBeenLastCalledWith([]);
    expect(onCurrentRecordChange).toHaveBeenLastCalledWith(undefined);
    expect(screen.queryByText("BFS 队列")).not.toBeInTheDocument();

    rerender(
      <ReviewPage
        records={records}
        dueReviews={[review("active")]}
        reviewStates={[review("active")]}
        stats={stats}
        mode="queue"
        queueIds={["active"]}
        currentRecordId="active"
        libraryState={createInitialReviewLibraryState()}
        onModeChange={vi.fn()}
        onQueueChange={onQueueChange}
        onCurrentRecordChange={onCurrentRecordChange}
        onLibraryStateChange={vi.fn()}
        onEnsureDay={vi.fn().mockResolvedValue(undefined)}
        onRate={onRate}
        onUndo={vi.fn().mockResolvedValue(undefined)}
        onRefresh={vi.fn().mockResolvedValue(undefined)}
        onOpenRecord={vi.fn()}
        onEditRecord={vi.fn()}
        onAddToReview={vi.fn()}
        onRemoveReview={vi.fn()}
        onResetReview={vi.fn()}
      />,
    );

    expect(screen.queryByText("BFS 队列")).not.toBeInTheDocument();
    await waitFor(() => expect(onRate).toHaveBeenCalledWith("active", "good"));
  });

  it("submits non-empty decision-block feedback with the rating", async () => {
    const onRate = vi.fn().mockResolvedValue(undefined);
    renderReviewPage({
      records: records.map((item) => item.id === "active" ? withDecisionBlock(item) : item),
      mode: "queue",
      dueReviews: [review("active")],
      reviewStates: [review("active")],
      queueIds: ["active"],
      currentRecordId: "active",
      onRate,
    });

    expect(document.querySelector(".review-bottom-controls")).toHaveClass("has-decision-blocks");
    fireEvent.change(screen.getByLabelText("复习重点 1 本次评论"), {
      target: { value: "- 新理解\n1. 掌握更稳" },
    });
    clickRating(/良好/);

    await waitFor(() => expect(onRate).toHaveBeenCalledWith("active", "good", [expect.objectContaining({
      decisionBlockId: "decision-active",
      contentVersion: 1,
      comment: "- 新理解\n1. 掌握更稳",
      includeInAnalysis: true,
      operationId: expect.any(String),
    })]));
  });

  it("exits an active review session without discarding its queue", () => {
    const { handlers } = renderReviewPage({ mode: "queue" });

    fireEvent.click(screen.getByRole("button", { name: "返回复习" }));

    expect(handlers.onModeChange).toHaveBeenCalledWith("manage");
    expect(handlers.onQueueChange).not.toHaveBeenCalledWith([]);
    expect(handlers.onCurrentRecordChange).not.toHaveBeenCalledWith(undefined);
  });

  it("keeps decision-block feedback when rating fails", async () => {
    const onRate = vi.fn().mockRejectedValue(new Error("数据库写入失败"));
    renderReviewPage({
      records: records.map((item) => item.id === "active" ? withDecisionBlock(item) : item),
      mode: "queue",
      dueReviews: [review("active")],
      reviewStates: [review("active")],
      queueIds: ["active"],
      currentRecordId: "active",
      onRate,
    });

    fireEvent.change(screen.getByLabelText("复习重点 1 本次评论"), {
      target: { value: "这次还是容易混淆" },
    });
    clickRating(/良好/);

    await waitFor(() => expect(screen.getByText(/复习评分失败/)).toBeInTheDocument());
    await waitFor(() => expect(screen.getByLabelText("复习重点 1 本次评论")).toHaveValue("这次还是容易混淆"));
  });

  it("shows legacy record-level evaluation as collapsed read-only history", () => {
    renderReviewPage({
      mode: "queue",
      dueReviews: [review("active")],
      reviewStates: [review("active")],
      reviewLogsByRecord: {
        active: [reviewLog("active", { evaluationText: "- 上次把页表和 TLB 关系理顺了" })],
      },
      queueIds: ["active"],
      currentRecordId: "active",
    });

    expect(screen.getByText("旧版整条日志评价（1）").closest("details")).not.toHaveAttribute("open");
    expect(screen.getByText("- 上次把页表和 TLB 关系理顺了")).toBeInTheDocument();
  });

  it("manages queued block feedback and explicitly links legacy evaluations", async () => {
    const onTransitionAnalysisQueueItem = vi.fn().mockResolvedValue(undefined);
    const onUpdateAnalysisQueueItemNote = vi.fn().mockResolvedValue(undefined);
    const onDeleteDecisionBlockFeedback = vi.fn().mockResolvedValue(undefined);
    const onLinkLegacyReviewFeedback = vi.fn().mockResolvedValue(undefined);
    renderReviewPage({
      records: records.map((item) => item.id === "active" ? withDecisionBlock(item) : item),
      mode: "queue",
      dueReviews: [review("active")],
      reviewStates: [review("active")],
      reviewLogsByRecord: {
        active: [reviewLog("active", { evaluationText: "旧评价待手动确认" })],
      },
      decisionBlockFeedback: [decisionBlockFeedback()],
      analysisQueueItems: [analysisQueueItem()],
      queueIds: ["active"],
      currentRecordId: "active",
      onTransitionAnalysisQueueItem,
      onUpdateAnalysisQueueItemNote,
      onDeleteDecisionBlockFeedback,
      onLinkLegacyReviewFeedback,
    });

    fireEvent.click(screen.getByText("1 条历史评论"));
    fireEvent.click(screen.getByRole("button", { name: "排除本次" }));
    await waitFor(() => expect(onTransitionAnalysisQueueItem).toHaveBeenCalledWith("queue-active", "excluded"));

    fireEvent.change(screen.getByLabelText("评论 feedback-active 的本次分析说明"), { target: { value: "只检查入队时机" } });
    fireEvent.click(screen.getByRole("button", { name: "保存说明" }));
    await waitFor(() => expect(onUpdateAnalysisQueueItemNote).toHaveBeenCalledWith("queue-active", "只检查入队时机"));

    fireEvent.click(screen.getByRole("button", { name: "永久删除评论：入队时机仍然容易混淆" }));
    await waitFor(() => expect(onDeleteDecisionBlockFeedback).toHaveBeenCalledWith("feedback-active"));

    fireEvent.click(screen.getByText("旧版整条日志评价（1）"));
    fireEvent.change(screen.getByLabelText("为旧评价 log-active 选择复习重点"), { target: { value: "decision-active" } });
    fireEvent.click(screen.getByRole("button", { name: "确认关联" }));
    await waitFor(() => expect(onLinkLegacyReviewFeedback).toHaveBeenCalledWith({
      recordId: "active",
      reviewLogId: "log-active",
      decisionBlockId: "decision-active",
      contentVersion: 1,
      comment: "旧评价待手动确认",
      includeInAnalysis: true,
    }));
  });

  it("disables rating buttons while a rating is in flight and avoids duplicate rate calls", async () => {
    const pending = deferred<void>();
    const onRate = vi.fn(() => pending.promise);
    renderReviewPage({
      mode: "queue",
      dueReviews: [review("active"), review("second", { nextReviewDate: "2026-07-03" })],
      reviewStates: [review("active"), review("second", { nextReviewDate: "2026-07-03" })],
      queueIds: ["active", "second"],
      currentRecordId: "active",
      onRate: onRate as (recordId: string, rating: RecordReviewRating) => Promise<RecordReviewUndoToken | undefined>,
    });

    clickRating(/良好/);
    expect(screen.getByText("页表缓存")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /良好/ })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: /模糊/ }));
    expect(onRate).toHaveBeenCalledTimes(1);

    pending.resolve();
    await waitFor(() => expect(screen.getByText("页表缓存")).toBeInTheDocument());
  });

  it("rolls the current card back into the queue when rating fails", async () => {
    const onRate = vi.fn().mockRejectedValue(new Error("数据库写入失败"));
    const onQueueChange = vi.fn();
    const onCurrentRecordChange = vi.fn();
    renderReviewPage({
      mode: "queue",
      dueReviews: [review("active")],
      reviewStates: [review("active")],
      queueIds: ["active"],
      currentRecordId: "active",
      onRate,
      onQueueChange,
      onCurrentRecordChange,
    });

    clickRating(/良好/);

    await waitFor(() => expect(screen.getByText("BFS 队列")).toBeInTheDocument());
    expect(screen.getByText(/复习评分失败/)).toBeInTheDocument();
    expect(onQueueChange).toHaveBeenLastCalledWith(["active"]);
    expect(onCurrentRecordChange).toHaveBeenLastCalledWith("active");
  });

  it("undoes consecutive ratings in reverse order and restores decision-block feedback", async () => {
    const onRate = vi.fn()
      .mockResolvedValueOnce(undoToken("active"))
      .mockResolvedValueOnce(undoToken("second"));
    const onUndo = vi.fn().mockResolvedValue(undefined);
    const onQueueChange = vi.fn();
    const onCurrentRecordChange = vi.fn();
    renderReviewPage({
      records: records.map((item) => item.id === "active" ? withDecisionBlock(item) : item),
      mode: "queue",
      dueReviews: [review("active"), review("second", { nextReviewDate: "2026-07-03" })],
      reviewStates: [review("active"), review("second", { nextReviewDate: "2026-07-03" })],
      queueIds: ["active", "second"],
      currentRecordId: "active",
      onRate,
      onUndo,
      onQueueChange,
      onCurrentRecordChange,
    });

    fireEvent.change(screen.getByLabelText("复习重点 1 本次评论"), { target: { value: "要重新理解 BFS 层序边界" } });
    clickRating(/良好/);
    fireEvent.click(screen.getByRole("button", { name: "打开复习更多菜单" }));
    await waitFor(() => expect(screen.getByRole("menuitem", { name: /撤回上次评分/ })).toBeEnabled());
    fireEvent.keyDown(document, { key: "Escape" });
    await waitFor(() => expect(screen.getByText("页表缓存")).toBeInTheDocument());

    clickRating(/良好/);
    await waitFor(() => expect(screen.getByText("今天暂无待复习")).toBeInTheDocument());

    fireEvent.keyDown(window, { key: "z", ctrlKey: true });
    await waitFor(() => expect(onUndo).toHaveBeenCalledWith(expect.objectContaining({ recordId: "second" })));
    await waitFor(() => expect(screen.getByText("页表缓存")).toBeInTheDocument());

    fireEvent.click(screen.getByRole("button", { name: "打开复习更多菜单" }));
    fireEvent.click(screen.getByRole("menuitem", { name: /撤回上次评分/ }));
    await waitFor(() => expect(onUndo).toHaveBeenCalledWith(expect.objectContaining({ recordId: "active" })));
    await waitFor(() => expect(screen.getByText("BFS 队列")).toBeInTheDocument());
    await waitFor(() => expect(screen.getByLabelText("复习重点 1 本次评论")).toHaveValue("要重新理解 BFS 层序边界"));
    expect(onQueueChange).toHaveBeenLastCalledWith(["active", "second"]);
    expect(onCurrentRecordChange).toHaveBeenLastCalledWith("active");
  });

  it("keeps an undone card in the active queue after refreshed due reviews arrive", async () => {
    const initialDueReviews = [review("active"), review("second", { nextReviewDate: "2026-07-03" })];
    const undoRefresh = deferred<void>();

    const ReviewQueueHarness = () => {
      const [dueReviews, setDueReviews] = useState(initialDueReviews);
      const [queueIds, setQueueIds] = useState(["active", "second"]);
      const [currentRecordId, setCurrentRecordId] = useState<string | undefined>("active");
      const [libraryState, setLibraryState] = useState(createInitialReviewLibraryState());

      return (
        <>
          <output data-testid="review-queue">{queueIds.join("|")}</output>
          <ReviewPage
            records={records}
            dueReviews={dueReviews}
            reviewStates={initialDueReviews}
            stats={stats}
            mode="queue"
            queueIds={queueIds}
            currentRecordId={currentRecordId}
            libraryState={libraryState}
            onModeChange={vi.fn()}
            onQueueChange={setQueueIds}
            onCurrentRecordChange={setCurrentRecordId}
            onLibraryStateChange={setLibraryState}
            onEnsureDay={vi.fn().mockResolvedValue(undefined)}
            onRate={async (recordId) => {
              setDueReviews((current) => current.filter((review) => review.recordId !== recordId));
              return undoToken(recordId);
            }}
            onUndo={async () => {
              setDueReviews(initialDueReviews);
              await undoRefresh.promise;
            }}
            onRefresh={vi.fn().mockResolvedValue(undefined)}
            onOpenRecord={vi.fn()}
            onEditRecord={vi.fn()}
            onAddToReview={vi.fn()}
            onRemoveReview={vi.fn()}
            onResetReview={vi.fn()}
          />
        </>
      );
    };

    render(<ReviewQueueHarness />);

    clickRating(/良好/);
    await waitFor(() => expect(screen.getByText("页表缓存")).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: "打开复习更多菜单" }));
    fireEvent.click(screen.getByRole("menuitem", { name: /撤回上次评分/ }));
    await waitFor(() => expect(screen.getByTestId("review-queue")).toHaveTextContent("second"));

    undoRefresh.resolve(undefined);

    await waitFor(() => expect(screen.getByText("BFS 队列")).toBeInTheDocument());
    await waitFor(() => expect(screen.getByTestId("review-queue")).toHaveTextContent("active|second"));
  });

  it("advances through due cards and shows empty state after the last card", async () => {
    const onQueueChange = vi.fn();
    const onCurrentRecordChange = vi.fn();
    renderReviewPage({
      mode: "queue",
      dueReviews: [review("active"), review("second", { nextReviewDate: "2026-07-03" })],
      reviewStates: [review("active"), review("second", { nextReviewDate: "2026-07-03" })],
      queueIds: ["active", "second"],
      currentRecordId: "active",
      onQueueChange,
      onCurrentRecordChange,
    });

    clickRating(/良好/);

    expect(onQueueChange).toHaveBeenLastCalledWith(["second"]);
    expect(onCurrentRecordChange).toHaveBeenLastCalledWith("second");
    await waitFor(() => expect(screen.getByText("页表缓存")).toBeInTheDocument());
  });
});
