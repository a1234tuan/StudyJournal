import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { TodayPage } from "./TodayPage";
import type { SubjectConfig } from "../types";
import type { RecordReviewStats } from "../types";
import { getDailyMotto } from "../lib/dailyMotto";

const stamp = "2026-06-21T00:00:00.000Z";

const subjects: SubjectConfig[] = [
  {
    id: "subject-math",
    createdAt: stamp,
    updatedAt: stamp,
    name: "数学",
    order: 0,
  },
];

const renderPage = (onOpenFavorites = vi.fn()) => render(
  <TodayPage
    entry={null}
    blocks={[]}
    examDate="2026-12-27"
    subjects={subjects}
    onSaveEntry={vi.fn()}
    onCreateRecord={vi.fn()}
    onOpenFavorites={onOpenFavorites}
    onOpenRecord={vi.fn()}
    onToggleFavorite={vi.fn()}
  />,
);

afterEach(() => {
  vi.useRealTimers();
});

describe("TodayPage", () => {
  it("shows a compact learning status without adding a dashboard", () => {
    const reviewStats: RecordReviewStats = {
      activeCount: 1,
      masteredCount: 0,
      dueCount: 2,
      overdueCount: 1,
      totalReviews: 1,
      streakDays: 1,
      todayStat: {
        id: "today",
        createdAt: stamp,
        updatedAt: stamp,
        date: "2026-06-21",
        dueCountAtFirstOpen: 4,
        reviewedCount: 2,
        rememberedCount: 1,
        fuzzyCount: 1,
        forgotCount: 0,
      },
      dayStats: [],
      masteryTrend: [],
    };
    render(<TodayPage entry={null} blocks={[]} examDate="2026-12-27" subjects={subjects} reviewStats={reviewStats} onSaveEntry={vi.fn()} onCreateRecord={vi.fn()} onOpenFavorites={vi.fn()} onOpenRecord={vi.fn()} onToggleFavorite={vi.fn()} />);
    expect(screen.getByRole("region", { name: "今日状态" })).toHaveTextContent("已复习 2 / 4 条");
  });

  it("keeps subject creation out of the home new-record panel", () => {
    renderPage();

    expect(screen.queryByLabelText("新增学科")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /新建 .* 记录/ })).toBeInTheDocument();
    expect(screen.queryByText(/更多学科可到/)).not.toBeInTheDocument();
  });

  it("shows a stable daily motto in the page header", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-04T09:00:00+08:00"));
    renderPage();

    expect(screen.getByText(getDailyMotto("2026-07-04"))).toBeInTheDocument();
  });

  it("opens favorites from the compact header action", () => {
    const onOpenFavorites = vi.fn();
    renderPage(onOpenFavorites);

    fireEvent.click(screen.getByRole("button", { name: "打开收藏夹" }));

    expect(onOpenFavorites).toHaveBeenCalledTimes(1);
  });

  it("copies the selected template into a newly created record", async () => {
    const template = {
      id: "template-translation",
      createdAt: stamp,
      updatedAt: stamp,
      title: "翻译复盘",
      contentHtml: "<blockquote>原句</blockquote><ul><li>我的翻译</li></ul>",
    };
    const onCreateRecord = vi.fn().mockResolvedValue({ id: "record-1" });
    render(
      <TodayPage
        entry={null}
        blocks={[]}
        examDate="2026-12-27"
        subjects={subjects}
        templates={[template]}
        onSaveEntry={vi.fn()}
        onCreateRecord={onCreateRecord}
        onOpenFavorites={vi.fn()}
        onOpenRecord={vi.fn()}
        onToggleFavorite={vi.fn()}
      />,
    );

    fireEvent.change(screen.getByLabelText("新记录模板"), { target: { value: template.id } });
    fireEvent.click(screen.getByRole("button", { name: /新建 .* 记录/ }));

    await waitFor(() => expect(onCreateRecord).toHaveBeenCalledWith(
      expect.any(String),
      "数学",
      template.contentHtml,
    ));
  });
});
