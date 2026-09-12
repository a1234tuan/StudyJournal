import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import type { RecordReviewStats } from "../types";
import { StatsPage } from "./StatsPage";

const stats: RecordReviewStats = {
  activeCount: 3,
  masteredCount: 1,
  dueCount: 4,
  overdueCount: 1,
  totalReviews: 8,
  streakDays: 2,
  todayStat: {
    id: "day",
    createdAt: "2026-09-12T00:00:00.000Z",
    updatedAt: "2026-09-12T00:00:00.000Z",
    date: "2026-09-12",
    dueCountAtFirstOpen: 6,
    reviewedCount: 3,
    rememberedCount: 2,
    fuzzyCount: 1,
    forgotCount: 0,
  },
  dayStats: [],
  masteryTrend: [
    { date: "2026-09-10", rememberedRate: 0.5, reviewedCount: 4 },
    { date: "2026-09-11", rememberedRate: 0.75, reviewedCount: 4 },
  ],
};

describe("StatsPage", () => {
  it("leads with actionable review state and keeps history collapsed", () => {
    render(<StatsPage blocks={[]} assets={[]} subjects={[]} reviewStats={stats} />);

    expect(screen.getByRole("heading", { name: "需要行动" })).toBeInTheDocument();
    expect(screen.getByText("今日待复习")).toBeInTheDocument();
    expect(screen.getByText("逾期积压")).toBeInTheDocument();
    expect(screen.getByText("近 7 天回忆成功率")).toBeInTheDocument();
    expect(screen.getAllByText(/8 次有效回忆/)).toHaveLength(2);
    expect(screen.queryByText("资源文件")).not.toBeInTheDocument();
    expect(screen.queryByText("近 14 天记录趋势")).not.toBeInTheDocument();
    expect(screen.getByText("查看历史记录").closest("details")).not.toHaveAttribute("open");
  });

  it("does not overstate empty review data", () => {
    render(<StatsPage blocks={[]} assets={[]} subjects={[]} reviewStats={null} />);

    expect(screen.getAllByText("暂无数据")).toHaveLength(2);
    expect(screen.getAllByText("样本不足")).toHaveLength(2);
  });
});
