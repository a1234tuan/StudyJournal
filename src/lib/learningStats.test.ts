import { describe, expect, it } from "vitest";

import type { RecordReviewStats } from "../types";
import { deriveLearningStats } from "./learningStats";

const baseStats = (overrides: Partial<RecordReviewStats> = {}): RecordReviewStats => ({
  activeCount: 4,
  masteredCount: 1,
  dueCount: 5,
  overdueCount: 2,
  totalReviews: 8,
  streakDays: 3,
  todayStat: {
    id: "day-1",
    createdAt: "2026-09-12T00:00:00.000Z",
    updatedAt: "2026-09-12T00:00:00.000Z",
    date: "2026-09-12",
    dueCountAtFirstOpen: 8,
    reviewedCount: 4,
    rememberedCount: 3,
    fuzzyCount: 1,
    forgotCount: 0,
  },
  dayStats: [],
  masteryTrend: [],
  ...overrides,
});

describe("deriveLearningStats", () => {
  it("derives today's workload and progress", () => {
    const result = deriveLearningStats(baseStats(), "2026-09-12");
    expect(result.dueCount).toBe(5);
    expect(result.dueTodayCount).toBe(3);
    expect(result.overdueCount).toBe(2);
    expect(result.reviewedToday).toBe(4);
    expect(result.progress).toBe(0.5);
  });

  it("returns honest empty and insufficient states", () => {
    const result = deriveLearningStats(undefined, "2026-09-12");
    expect(result.progress).toBeNull();
    expect(result.recall7).toEqual({ rate: null, sampleSize: 0, trend: "insufficient" });
  });

  it("weights recall by reviewed samples and reports a meaningful direction", () => {
    const masteryTrend = [
      { date: "2026-09-07", rememberedRate: 0.2, reviewedCount: 5 },
      { date: "2026-09-08", rememberedRate: 0.4, reviewedCount: 5 },
      { date: "2026-09-09", rememberedRate: 0.8, reviewedCount: 5 },
      { date: "2026-09-10", rememberedRate: 1, reviewedCount: 5 },
    ];
    const result = deriveLearningStats(baseStats({ masteryTrend }), "2026-09-10");
    expect(result.recall7.rate).toBeCloseTo(0.6);
    expect(result.recall7.sampleSize).toBe(20);
    expect(result.recall7.trend).toBe("up");
  });
});
