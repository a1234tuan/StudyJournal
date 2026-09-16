import type { Asset, DailyPlan, EntityId, ISODate, RecordBlock, RecordReviewStatus } from "../types";
import { recordToPlainText } from "./recordContent";

/**
 * Domain logic for the "Daily Plan" feature.
 *
 * Everything here is a pure function over in-memory data: no Dexie access, no
 * React state. Callers assemble a `PlanContext` once and reuse it, which keeps
 * plan rendering O(plans) instead of O(plans x stores).
 *
 * See docs/daily-plan-final-plan-2026-09-16.md sections 3.1-3.3.
 */

/**
 * Everything the plan derivation needs, assembled by the caller.
 *
 * `recordsById` must contain the raw rows - including soft-deleted ones - so the
 * derivation can tell "never linked" apart from "linked, then deleted". That
 * distinction is what powers the "log deleted" hint (D8) without writing any data.
 */
export interface PlanContext {
  recordsById: Map<EntityId, RecordBlock>;
  draftRecordIds: Set<EntityId>;
  inFlightDraftRecordIds: Set<EntityId>;
  reviewStatuses: Map<EntityId, RecordReviewStatus>;
  assets: Asset[];
}

/**
 * Does this record hold anything a human actually wrote?
 *
 * Deliberately excludes two things:
 *
 * 1. `title`. A plan-created record is born with the plan title already in it,
 *    so counting the title would make "clicked in, wrote nothing, went back"
 *    look like a fulfilled plan and quietly break the whole feature.
 * 2. Decision blocks as a separate clause. `recordToPlainText` already recurses
 *    into them, so a decision block with text is covered by the first clause -
 *    while *keeping* a "has a decision block" clause would make a record
 *    containing one *empty* decision block count as content.
 *
 * Must go through `recordToPlainText`, never a naive regex: it understands
 * formulas, asset references and collapse/highlight blocks, whereas a regex
 * would call an image-only or formula-only log empty and let the reclaim job
 * delete it.
 */
export const hasPlanRecordContent = (
  record: RecordBlock,
  ctx: { assets: Asset[] },
): boolean =>
  recordToPlainText(record, ctx.assets).trim() !== ""
  || record.assets.length > 0
  || record.formulas.length > 0
  || record.tags.length > 0;

/**
 * May this record be physically reclaimed as "an attempt that never happened"?
 *
 * Stricter than `!hasPlanRecordContent` on purpose. Each extra clause removes a
 * way we could destroy user input:
 *
 * - a local draft means the user typed something and it reached disk;
 * - an in-flight flush means "no draft yet" is an artefact of timing, not
 *   evidence of no input (the editor's back handler commits navigation
 *   synchronously and persists the draft asynchronously, by design);
 * - an active review card means the record has already entered the review
 *   system, which owns it from then on.
 */
export const canReclaimPlanRecord = (
  record: RecordBlock,
  ctx: PlanContext,
): boolean =>
  !hasPlanRecordContent(record, ctx)
  && !ctx.draftRecordIds.has(record.id)
  && !ctx.inFlightDraftRecordIds.has(record.id)
  && ctx.reviewStatuses.get(record.id) !== "active";

/** Derived only. Never persisted - there is no status column on `DailyPlan`. */
export type PlanOutcome = "done" | "pending" | "draft";

/**
 * What does this plan currently read as?
 *
 * "Done" means "a live record is linked and it holds something a human wrote".
 * Because that is derived from the current facts rather than stored, deleting
 * the log makes the plan read as unfulfilled again on the very next render -
 * with no write at all - and restoring the log from trash flips it straight back.
 *
 * The five reachable states and why each resolves the way it does:
 *
 * | linked | live? | has content? | draft/in-flight? | outcome   |
 * |--------|-------|--------------|------------------|-----------|
 * | no     | -     | -            | -                | pending   |
 * | yes    | no    | -            | -                | pending   | (D8: log deleted)
 * | yes    | yes   | yes          | -                | done      |
 * | yes    | yes   | no           | yes              | draft     |
 * | yes    | yes   | no           | no               | pending   | (awaiting reclaim)
 *
 * `done` requires the content check even though "a live record exists" would be
 * equivalent in the steady state: during the moment between creating a record
 * and either writing to it or reclaiming it, an empty record must not read as
 * fulfilled.
 */
export const resolvePlanOutcome = (plan: DailyPlan, ctx: PlanContext): PlanOutcome => {
  if (!plan.linkedRecordId) {
    return "pending";
  }
  const record = ctx.recordsById.get(plan.linkedRecordId);
  if (!record || record.deletedAt) {
    return "pending";
  }
  if (hasPlanRecordContent(record, ctx)) {
    return "done";
  }
  if (ctx.draftRecordIds.has(record.id) || ctx.inFlightDraftRecordIds.has(record.id)) {
    return "draft";
  }
  return "pending";
};

/**
 * Was this plan linked to a log that is now gone (deleted or missing)?
 *
 * Drives one muted hint and nothing else: it does not change `outcome`, does not
 * write data, and does not enter any statistic. Its purpose is to stop "未完成"
 * from being confusing ("I definitely wrote that"), and to make the route back -
 * restoring the log from trash - discoverable.
 *
 * A plan that was simply never opened returns false, so the hint never appears
 * for the ordinary unfulfilled case.
 */
export const isLinkedRecordGone = (plan: DailyPlan, ctx: PlanContext): boolean => {
  if (!plan.linkedRecordId) {
    return false;
  }
  const record = ctx.recordsById.get(plan.linkedRecordId);
  return !record || Boolean(record.deletedAt);
};

/** One plan plus everything derived for rendering it. */
export interface DailyPlanView {
  plan: DailyPlan;
  outcome: PlanOutcome;
  /** The live linked record, if there is one. Absent once the log is deleted. */
  record?: RecordBlock;
  /** D8: linked to a log that has been deleted or no longer exists. Presentation only. */
  linkedRecordDeleted?: boolean;
}

/** Plans for one day, with its completion tally. */
export interface PlanDateGroup {
  date: ISODate;
  views: DailyPlanView[];
  doneCount: number;
  totalCount: number;
}

/**
 * Lookup from plan id to plan.
 *
 * The key is the **plan id**, not the record id: it is stable, and it does not
 * depend on `linkedRecordId` having been written back yet.
 *
 * Input must be the union of live and soft-deleted plans. That union is the only
 * place soft-deleted rows are allowed anywhere near the UI, and it is used for
 * exactly one thing - resolving the attribution label of a log whose plan was
 * deleted - never for lists, statistics or denominators.
 */
export const buildPlanIndex = (plans: DailyPlan[]): Map<EntityId, DailyPlan> =>
  new Map(plans.map((plan) => [plan.id, plan]));

/**
 * Derive the render-ready views for a day's plans.
 *
 * Contract: `plans` must already be the output of `listDailyPlans()` - that is,
 * soft-deleted rows already excluded. This function deliberately does not
 * re-filter `deletedAt`, because a second filter would hide the caller's mistake
 * instead of surfacing it, and it would let deleted rows into statistics.
 */
export const buildDailyPlanViews = (plans: DailyPlan[], ctx: PlanContext): DailyPlanView[] =>
  plans.map((plan) => {
    const linked = plan.linkedRecordId ? ctx.recordsById.get(plan.linkedRecordId) : undefined;
    const live = linked && !linked.deletedAt ? linked : undefined;
    return {
      plan,
      outcome: resolvePlanOutcome(plan, ctx),
      record: live,
      linkedRecordDeleted: isLinkedRecordGone(plan, ctx),
    };
  });

/**
 * Bucket views by day, newest day first.
 *
 * Days with no plans simply do not appear, which is what makes the history view
 * show only days that actually had plans without a separate filter.
 */
export const groupPlansByDate = (views: DailyPlanView[]): PlanDateGroup[] => {
  const byDate = new Map<ISODate, DailyPlanView[]>();
  for (const view of views) {
    const bucket = byDate.get(view.plan.date);
    if (bucket) {
      bucket.push(view);
    } else {
      byDate.set(view.plan.date, [view]);
    }
  }
  return [...byDate.entries()]
    .map(([date, dayViews]) => {
      const ordered = [...dayViews].sort((a, b) => a.plan.order - b.plan.order);
      return {
        date,
        views: ordered,
        doneCount: ordered.filter((view) => view.outcome === "done").length,
        totalCount: ordered.length,
      };
    })
    .sort((a, b) => b.date.localeCompare(a.date));
};
