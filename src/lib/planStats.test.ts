import { describe, expect, it } from "vitest";

import type { DailyPlan } from "../types";
import { groupPlansByDate, type DailyPlanView } from "./dailyPlan";
import { derivePlanStats } from "./planStats";

const TODAY = "2026-09-16";

const view = (
  date: string,
  outcome: DailyPlanView["outcome"],
  subject = "数学",
  order = 0,
): DailyPlanView => ({
  plan: {
    id: `${date}-${subject}-${order}`,
    createdAt: `${date}T00:00:00.000Z`,
    updatedAt: `${date}T00:00:00.000Z`,
    date,
    subject,
    title: "计划",
    order,
  } satisfies DailyPlan,
  outcome,
});

const groupsFor = (views: DailyPlanView[]) => groupPlansByDate(views);

describe("derivePlanStats", () => {
  it("reports today's tally separately from the rolling windows", () => {
    const stats = derivePlanStats(groupsFor([
      view(TODAY, "done", "数学", 0),
      view(TODAY, "done", "数学", 1),
      view(TODAY, "pending", "英语", 2),
    ]), TODAY);

    expect(stats.today).toEqual({ done: 2, total: 3, hasData: true });
    expect(stats.last7).toEqual({ done: 2, total: 3, hasData: true });
    expect(stats.last30).toEqual({ done: 2, total: 3, hasData: true });
  });

  it("marks a window without plans as having no data rather than zero per cent", () => {
    const stats = derivePlanStats([], TODAY);

    expect(stats.today).toEqual({ done: 0, total: 0, hasData: false });
    expect(stats.last7.hasData).toBe(false);
    expect(stats.last30.hasData).toBe(false);
    expect(stats.subjects).toEqual([]);
    expect(stats.streakDays).toBe(0);
  });

  it("counts the rolling windows inclusively from today", () => {
    const stats = derivePlanStats(groupsFor([
      view(TODAY, "done"),
      view("2026-09-10", "done"),  // 6 days back: inside 7
      view("2026-09-09", "done"),  // 7 days back: outside 7, inside 30
      view("2026-08-18", "done"),  // 29 days back: inside 30
      view("2026-08-17", "done"),  // 30 days back: outside both
    ]), TODAY);

    expect(stats.last7).toMatchObject({ done: 2, total: 2 });
    expect(stats.last30).toMatchObject({ done: 4, total: 4 });
  });

  it("ignores plans dated in the future", () => {
    const stats = derivePlanStats(groupsFor([
      view(TODAY, "done"),
      view("2026-09-20", "pending"),
    ]), TODAY);

    expect(stats.last7).toMatchObject({ done: 1, total: 1 });
    expect(stats.last30).toMatchObject({ done: 1, total: 1 });
    expect(stats.today).toMatchObject({ done: 1, total: 1 });
  });

  it("counts a streak across days that have no plans", () => {
    // 09-14, 09-13 and 09-11 were all fully fulfilled; 09-12 had no plans at all.
    const stats = derivePlanStats(groupsFor([
      view("2026-09-14", "done"),
      view("2026-09-13", "done"),
      view("2026-09-11", "done"),
    ]), TODAY);

    expect(stats.streakDays).toBe(3);
  });

  it("breaks the streak at the first planned day that is not fully fulfilled", () => {
    const stats = derivePlanStats(groupsFor([
      view("2026-09-15", "done"),
      view("2026-09-14", "pending"),
      view("2026-09-13", "done"),
    ]), TODAY);

    expect(stats.streakDays).toBe(1);
  });

  it("reports zero when the most recent planned day is unfinished", () => {
    const stats = derivePlanStats(groupsFor([view(TODAY, "pending")]), TODAY);
    expect(stats.streakDays).toBe(0);
  });

  it("breaks the run on a planned day that is only partly fulfilled", () => {
    // The most recent planned day is incomplete, so the run ends there - a day
    // counts only when every plan on it was fulfilled.
    const stats = derivePlanStats(groupsFor([
      view("2026-09-15", "done", "数学", 0),
      view("2026-09-15", "pending", "数学", 1),
      view("2026-09-14", "done"),
    ]), TODAY);

    expect(stats.streakDays).toBe(0);
  });

  it("counts a partly fulfilled day only after a later fulfilled day", () => {
    const stats = derivePlanStats(groupsFor([
      view("2026-09-15", "done", "数学", 0),
      view("2026-09-15", "pending", "数学", 1),
      view("2026-09-14", "done"),
      view("2026-09-13", "done"),
    ]), TODAY);

    // 09-15 is incomplete so it contributes nothing and ends the run; the two
    // full days behind it do not survive a break in front of them.
    expect(stats.streakDays).toBe(0);
    // ...but they are still counted in the window totals, which is the point of
    // keeping the two numbers separate.
    expect(stats.last7).toMatchObject({ done: 3, total: 4 });
  });

  it("does not let a future day extend or break the streak", () => {
    const stats = derivePlanStats(groupsFor([
      view("2026-09-20", "pending"),
      view("2026-09-15", "done"),
      view("2026-09-14", "done"),
    ]), TODAY);

    expect(stats.streakDays).toBe(2);
  });

  it("groups subjects by subject and counts each plan once", () => {
    const stats = derivePlanStats(groupsFor([
      view("2026-09-16", "done", "数学", 0),
      view("2026-09-16", "pending", "数学", 1),
      view("2026-09-15", "done", "数学", 0),
      view("2026-09-15", "done", "英语", 0),
      view("2026-09-14", "done", "英语", 0),
      view("2026-09-14", "done", "英语", 1),
    ]), TODAY);

    expect(stats.subjects).toEqual([
      { subject: "数学", done: 2, total: 3 },
      { subject: "英语", done: 3, total: 3 },
    ]);
  });

  it("omits subjects that have no plans", () => {
    const stats = derivePlanStats(groupsFor([view(TODAY, "done", "数据结构")]), TODAY);

    expect(stats.subjects).toEqual([{ subject: "数据结构", done: 1, total: 1 }]);
  });

  it("reports the same totals the groups do, so the page cannot disagree with itself", () => {
    const groups = groupsFor([
      view("2026-09-16", "done", "数学", 0),
      view("2026-09-16", "draft", "数学", 1),
      view("2026-09-15", "pending", "英语", 0),
    ]);
    const stats = derivePlanStats(groups, TODAY);

    expect(stats.last7.done).toBe(groups.reduce((sum, group) => sum + group.doneCount, 0));
    expect(stats.last7.total).toBe(groups.reduce((sum, group) => sum + group.totalCount, 0));
    // "draft" is not fulfilment - it must not inflate "done".
    expect(stats.last7.done).toBe(1);
  });
});
