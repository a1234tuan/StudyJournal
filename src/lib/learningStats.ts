import type { ISODate, RecordReviewStats } from "../types";

export type LearningTrend = "up" | "down" | "stable" | "insufficient";

export interface RecallSummary {
  rate: number | null;
  sampleSize: number;
  trend: LearningTrend;
}

export interface LearningStatsSummary {
  dueCount: number;
  dueTodayCount: number;
  overdueCount: number;
  reviewedToday: number;
  dueAtFirstOpen: number;
  progress: number | null;
  recall7: RecallSummary;
  recall30: RecallSummary;
  streakDays: number;
}

const emptyRecall = (): RecallSummary => ({ rate: null, sampleSize: 0, trend: "insufficient" });

const summarizeRecall = (
  trend: RecordReviewStats["masteryTrend"],
  date: ISODate,
  days: number,
): RecallSummary => {
  const start = new Date(`${date}T00:00:00Z`).getTime() - (days - 1) * 86_400_000;
  const values = trend.filter((item) => new Date(`${item.date}T00:00:00Z`).getTime() >= start);
  const sampleSize = values.reduce((sum, item) => sum + item.reviewedCount, 0);
  if (sampleSize === 0) return emptyRecall();

  const remembered = values.reduce((sum, item) => sum + item.rememberedRate * item.reviewedCount, 0);
  const midpoint = Math.ceil(values.length / 2);
  const earlier = values.slice(0, midpoint);
  const later = values.slice(midpoint);
  const earlierCount = earlier.reduce((sum, item) => sum + item.reviewedCount, 0);
  const laterCount = later.reduce((sum, item) => sum + item.reviewedCount, 0);
  let direction: LearningTrend = "insufficient";
  if (sampleSize >= 5 && earlierCount >= 2 && laterCount >= 2) {
    const earlierRate = earlier.reduce((sum, item) => sum + item.rememberedRate * item.reviewedCount, 0) / earlierCount;
    const laterRate = later.reduce((sum, item) => sum + item.rememberedRate * item.reviewedCount, 0) / laterCount;
    const delta = laterRate - earlierRate;
    direction = delta >= 0.08 ? "up" : delta <= -0.08 ? "down" : "stable";
  }
  return { rate: remembered / sampleSize, sampleSize, trend: direction };
};

export const deriveLearningStats = (
  reviewStats: RecordReviewStats | null | undefined,
  date: ISODate,
): LearningStatsSummary => {
  const todayStat = reviewStats?.todayStat;
  const dueAtFirstOpen = todayStat?.dueCountAtFirstOpen ?? 0;
  const reviewedToday = todayStat?.reviewedCount ?? 0;
  return {
    dueCount: reviewStats?.dueCount ?? 0,
    dueTodayCount: Math.max(0, (reviewStats?.dueCount ?? 0) - (reviewStats?.overdueCount ?? 0)),
    overdueCount: reviewStats?.overdueCount ?? 0,
    reviewedToday,
    dueAtFirstOpen,
    progress: dueAtFirstOpen > 0 ? Math.min(1, reviewedToday / dueAtFirstOpen) : null,
    recall7: reviewStats ? summarizeRecall(reviewStats.masteryTrend, date, 7) : emptyRecall(),
    recall30: reviewStats ? summarizeRecall(reviewStats.masteryTrend, date, 30) : emptyRecall(),
    streakDays: reviewStats?.streakDays ?? 0,
  };
};
