import { CheckCircle2, Clock3, History, Target, TrendingDown, TrendingUp } from "lucide-react";
import { useMemo } from "react";

import type { Asset, Block, RecordReviewStats, SubjectConfig } from "../types";
import { Heatmap } from "../components/Heatmap";
import { todayISO, weekRangeLabel } from "../lib/date";
import { getRecordBlocks } from "../lib/journalSelectors";
import { deriveLearningStats, type LearningTrend, type RecallSummary } from "../lib/learningStats";
import { PageHeader } from "../components/ui";

interface StatsPageProps {
  blocks: Block[];
  assets: Asset[];
  subjects: SubjectConfig[];
  reviewStats?: RecordReviewStats | null;
}

const trendLabel: Record<LearningTrend, string> = {
  up: "较前期改善",
  down: "较前期下降",
  stable: "保持稳定",
  insufficient: "样本不足",
};

const trendIcon = (trend: LearningTrend) => {
  if (trend === "up") return <TrendingUp size={16} aria-hidden="true" />;
  if (trend === "down") return <TrendingDown size={16} aria-hidden="true" />;
  return <span className="stats-trend-dot" aria-hidden="true" />;
};

const RecallSummary = ({ summary, label }: { summary: RecallSummary; label: string }) => (
  <article className="stats-state-card">
    <div className="stats-card-heading"><span>{label}</span><Target size={17} aria-hidden="true" /></div>
    {summary.rate === null ? <strong className="stats-empty-value">暂无数据</strong> : <strong>{Math.round(summary.rate * 100)}%</strong>}
    <small>{summary.sampleSize > 0 ? `${summary.sampleSize} 次有效回忆 · ` : ""}{trendIcon(summary.trend)}{trendLabel[summary.trend]}</small>
  </article>
);

export const StatsPage = ({ blocks, reviewStats }: StatsPageProps) => {
  const records = useMemo(() => getRecordBlocks(blocks), [blocks]);
  const summary = useMemo(() => deriveLearningStats(reviewStats, todayISO()), [reviewStats]);
  const recentTrend = useMemo(
    () => reviewStats?.masteryTrend.slice(-14).filter((item) => item.reviewedCount > 0) ?? [],
    [reviewStats],
  );

  return (
    <main className="page stats-page">
      <PageHeader
        eyebrow="Stats"
        title="学习状态"
        subtitle="只保留能帮助你调整学习节奏的信息。"
        density="compact"
        actions={<span className="counter-pill">{weekRangeLabel()}</span>}
      />

      <section className="stats-section stats-action-section" aria-labelledby="stats-action-title">
        <div className="stats-section-heading">
          <div><span className="stats-eyebrow">现在</span><h2 id="stats-action-title">需要行动</h2></div>
          <Clock3 size={19} aria-hidden="true" />
        </div>
        <div className="stats-action-grid">
          <article className="stats-action-card"><span>今日待复习</span><strong>{summary.dueTodayCount}</strong><small>{summary.overdueCount > 0 ? `另有 ${summary.overdueCount} 条已逾期` : "没有逾期积压"}</small></article>
          <article className="stats-action-card"><span>今日完成进度</span><strong>{summary.progress === null ? "—" : `${Math.round(summary.progress * 100)}%`}</strong><small>{summary.dueAtFirstOpen > 0 ? `已复习 ${summary.reviewedToday} / ${summary.dueAtFirstOpen} 条` : "打开复习后会记录进度"}</small></article>
          <article className="stats-action-card"><span>逾期积压</span><strong>{summary.overdueCount}</strong><small>{summary.overdueCount > 0 ? "建议优先处理" : "节奏保持良好"}</small></article>
        </div>
      </section>

      <section className="stats-section stats-state-section" aria-labelledby="stats-state-title">
        <div className="stats-section-heading">
          <div><span className="stats-eyebrow">近期</span><h2 id="stats-state-title">学习状态</h2></div>
          <CheckCircle2 size={19} aria-hidden="true" />
        </div>
        <div className="stats-state-grid">
          <RecallSummary summary={summary.recall7} label="近 7 天回忆成功率" />
          <RecallSummary summary={summary.recall30} label="近 30 天回忆成功率" />
          <article className="stats-state-card stats-supporting-card"><div className="stats-card-heading"><span>连续复习</span><CheckCircle2 size={17} aria-hidden="true" /></div><strong>{summary.streakDays} 天</strong><small>仅表示复习连续性，不代表学习质量</small></article>
        </div>
      </section>

      <details className="stats-history-disclosure">
        <summary><History size={17} aria-hidden="true" /><span>查看历史记录</span><small>{records.length} 条日志</small></summary>
        <div className="stats-history-content">
          <Heatmap blocks={blocks} />
          {recentTrend.length > 0 && (
            <section className="stats-trend-list" aria-labelledby="stats-trend-title">
              <div className="stats-history-heading"><h3 id="stats-trend-title">回忆成功率变化</h3><small>按复习次数加权</small></div>
              <div className="stats-trend-items">
                {recentTrend.map((item) => (
                  <div className="stats-trend-item" key={item.date}>
                    <time dateTime={item.date}>{item.date.slice(5)}</time>
                    <div className="stats-trend-bar"><span style={{ width: `${Math.round(item.rememberedRate * 100)}%` }} /></div>
                    <strong>{Math.round(item.rememberedRate * 100)}%</strong><small>{item.reviewedCount} 次</small>
                  </div>
                ))}
              </div>
            </section>
          )}
        </div>
      </details>
    </main>
  );
};
