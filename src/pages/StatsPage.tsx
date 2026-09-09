import { useMemo } from "react";
import { Cell, Pie, PieChart, ResponsiveContainer, Tooltip, XAxis, YAxis, LineChart, Line } from "recharts";

import type { Asset, Block, RecordReviewStats, SubjectConfig } from "../types";
import { Heatmap } from "../components/Heatmap";
import { weekRangeLabel } from "../lib/date";
import { getRecordBlocks, getSubjectCounts } from "../lib/journalSelectors";
import { PageHeader } from "../components/ui";

interface StatsPageProps {
  blocks: Block[];
  assets: Asset[];
  subjects: SubjectConfig[];
  reviewStats?: RecordReviewStats | null;
}

// Theme tokens so the charts follow the active visual theme and dark mode.
const COLORS = ["var(--chart-1)", "var(--chart-2)", "var(--chart-3)", "var(--chart-4)", "var(--chart-5)"];

export const StatsPage = ({ blocks, assets, subjects, reviewStats }: StatsPageProps) => {
  const records = useMemo(() => getRecordBlocks(blocks), [blocks]);
  const subjectStats = useMemo(() => {
    return getSubjectCounts(records, subjects)
      .filter((item) => item.count > 0)
      .map((item) => ({ name: item.subject, count: item.count }));
  }, [records, subjects]);

  const trend = useMemo(() => {
    const map = new Map<string, number>();
    for (const record of records) {
      map.set(record.date, (map.get(record.date) ?? 0) + 1);
    }
    return Array.from(map, ([date, count]) => ({ date: date.slice(5), count }))
      .sort((a, b) => a.date.localeCompare(b.date))
      .slice(-14);
  }, [records]);

  const activeDays = new Set(records.map((record) => record.date)).size;

  return (
    <main className="page stats-page">
      <PageHeader
        eyebrow="Stats"
        title="努力看得见"
        density="compact"
        actions={<span className="counter-pill">{weekRangeLabel()}</span>}
      />
      <Heatmap blocks={blocks} />
      <section className="metric-grid">
        <article>
          <span>累计记录</span>
          <strong>{records.length}</strong>
        </article>
        <article>
          <span>记录天数</span>
          <strong>{activeDays}</strong>
        </article>
        <article>
          <span>资源文件</span>
          <strong>{assets.length}</strong>
        </article>
        <article>
          <span>复习中</span>
          <strong>{reviewStats?.activeCount ?? 0}</strong>
        </article>
        <article>
          <span>已掌握</span>
          <strong>{reviewStats?.masteredCount ?? 0}</strong>
        </article>
        <article>
          <span>今日待复习</span>
          <strong>{reviewStats?.dueCount ?? 0}</strong>
        </article>
        <article>
          <span>连续打卡</span>
          <strong>{reviewStats?.streakDays ?? 0}</strong>
        </article>
      </section>
      <section className="chart-grid">
        <article className="chart-panel">
          <h2>科目记录</h2>
          <ResponsiveContainer width="100%" height={240}>
            <PieChart>
              <Pie data={subjectStats} dataKey="count" nameKey="name" outerRadius={78}>
                {subjectStats.map((entry, index) => (
                  <Cell key={entry.name} fill={COLORS[index % COLORS.length]} />
                ))}
              </Pie>
              <Tooltip />
            </PieChart>
          </ResponsiveContainer>
        </article>
        <article className="chart-panel">
          <h2>近 14 天记录趋势</h2>
          <ResponsiveContainer width="100%" height={240}>
            <LineChart data={trend}>
              <XAxis dataKey="date" />
              <YAxis />
              <Tooltip />
              <Line type="monotone" dataKey="count" stroke="var(--chart-1)" strokeWidth={3} dot={{ r: 3 }} />
            </LineChart>
          </ResponsiveContainer>
        </article>
        <article className="chart-panel">
          <h2>复习掌握率趋势</h2>
          <ResponsiveContainer width="100%" height={240}>
            <LineChart data={reviewStats?.masteryTrend.map((item) => ({
              date: item.date.slice(5),
              rate: Math.round(item.rememberedRate * 100),
              count: item.reviewedCount,
            })) ?? []}>
              <XAxis dataKey="date" />
              <YAxis domain={[0, 100]} />
              <Tooltip />
              <Line type="monotone" dataKey="rate" stroke="var(--chart-2)" strokeWidth={3} dot={{ r: 3 }} />
            </LineChart>
          </ResponsiveContainer>
        </article>
      </section>
    </main>
  );
};
