import type { ISODate, Subject } from "../types";
import { addDaysISO } from "./date";
import type { PlanDateGroup } from "./dailyPlan";

/**
 * Deterministic plan statistics. No model calls, no heuristics - every number
 * here is a count over the plan rows the user created.
 *
 * Two honesty rules are baked into the shapes rather than left to the UI:
 *
 * 1. A window with no plans reports `hasData: false` instead of `0 / 0` or a
 *    percentage. Rendering "0%" for "you did not plan anything" would be a
 *    claim the data does not support.
 * 2. `streakDays` uses the loose reading - days with no plans are stepped over
 *    rather than breaking the run - because the strict reading leaves this
 *    number pinned at 1 for anyone who does not plan every single day. The UI
 *    must label it, since "consecutive days" already means something else in the
 *    review module.
 *
 * `groups` must already be `groupPlansByDate()` output: newest day first, and
 * containing only live plans.
 */
export interface PlanWindowSummary {
  done: number;
  total: number;
  /** False when the window contains no plans at all. */
  hasData: boolean;
}

export interface PlanSubjectSummary {
  subject: Subject;
  done: number;
  total: number;
}

export interface PlanStats {
  today: PlanWindowSummary;
  last7: PlanWindowSummary;
  last30: PlanWindowSummary;
  /** Consecutive fully-fulfilled planned days, counting back from the latest one. */
  streakDays: number;
  /** Per subject across every planned day, most plans first. */
  subjects: PlanSubjectSummary[];
}

const summarise = (groups: PlanDateGroup[]): PlanWindowSummary => {
  const done = groups.reduce((sum, group) => sum + group.doneCount, 0);
  const total = groups.reduce((sum, group) => sum + group.totalCount, 0);
  return { done, total, hasData: total > 0 };
};

/** ISO calendar days compare correctly as strings, so no Date parsing is needed. */
const withinLastDays = (date: ISODate, today: ISODate, days: number): boolean =>
  date <= today && date >= addDaysISO(today, -(days - 1));

const deriveStreakDays = (groups: PlanDateGroup[], today: ISODate): number => {
  let streak = 0;
  for (const group of groups) {
    // Future-dated plans cannot have been fulfilled yet, so they neither extend
    // nor break the run.
    if (group.date > today) {
      continue;
    }
    if (group.doneCount < group.totalCount) {
      break;
    }
    if (group.totalCount > 0) {
      streak += 1;
    }
  }
  return streak;
};

const deriveSubjects = (groups: PlanDateGroup[]): PlanSubjectSummary[] => {
  const bySubject = new Map<Subject, PlanSubjectSummary>();
  for (const group of groups) {
    for (const view of group.views) {
      const current = bySubject.get(view.plan.subject) ?? { subject: view.plan.subject, done: 0, total: 0 };
      current.total += 1;
      if (view.outcome === "done") {
        current.done += 1;
      }
      bySubject.set(view.plan.subject, current);
    }
  }
  return [...bySubject.values()].sort((a, b) => b.total - a.total || a.subject.localeCompare(b.subject));
};

export const derivePlanStats = (groups: PlanDateGroup[], today: ISODate): PlanStats => ({
  today: summarise(groups.filter((group) => group.date === today)),
  last7: summarise(groups.filter((group) => withinLastDays(group.date, today, 7))),
  last30: summarise(groups.filter((group) => withinLastDays(group.date, today, 30))),
  streakDays: deriveStreakDays(groups, today),
  subjects: deriveSubjects(groups),
});
