import type { ReviewCoachInteractionSegmentLocal } from "./interactionTrace";
import { rollupInteractionSegments } from "./interactionTrace";

/**
 * Development-only friction report.
 *
 * This is what M0 exists to produce before the loop is built: a way to say, from
 * real sessions, how long the learner spent retrieving versus reading feedback
 * versus operating the interface. It is intentionally not wired into the learner
 * UI - it would become a fourth competing metric (constitution art. 14).
 *
 * The report also exposes "entry to first retrieval", the friction the learner
 * pays before any learning happens at all.
 */

export interface FrictionReportRow {
  taskId: string;
  entryToFirstRetrievalMs: number | null;
  retrievalCount: number;
  totalActiveMs: number;
  operationMs: number;
  /** Operation share for this task; null when the task has no measured time. */
  operationRatio: number | null;
}

export interface FrictionReport {
  rows: FrictionReportRow[];
  totalActiveMs: number;
  operationMs: number;
  operationRatio: number;
  /** Distinct learning sessions behind this report; see `countMeasuredSessions`. */
  measuredSessions: number;
  /** `true` when the sample is large enough to make a claim about the 15% target. */
  meetsOperationBudget: boolean;
}

/**
 * The M5 acceptance sample: ten *sessions*, not ten segments.
 *
 * The previous check was `segments.length >= 10`. That was wrong in two
 * compounding ways, and both made the gate easier to satisfy than the claim it
 * guards:
 *
 * - one task can emit many segments (every phase change opens a new one), so a
 *   single sitting produced ten segments and the report said "met";
 * - the workbench's own segments carry no `taskId` and were bucketed together
 *   by `taskId ?? ""`, so unrelated entry friction inflated the same count.
 *
 * A session is what the 15% target was actually stated against: one sitting in
 * which the learner returns to a task. Ten segments inside one sitting is one
 * session, and one session cannot support a claim about typical friction.
 */
export const MIN_SESSIONS_FOR_OPERATION_BUDGET = 10;

/**
 * Segments for one task, split into sessions.
 *
 * A session is a maximal run of segments on the same task where each segment
 * follows the previous one within the idle threshold. The hook already closes a
 * window once the learner stops interacting for that long, so a larger gap is
 * evidence that they left and came back - which is exactly the boundary the
 * target is stated per.
 *
 * Only segments bound to a task count. Workbench segments measure entry
 * friction before any task exists; they are real time but they are not a
 * session of learning, and counting them would let opening the screen ten times
 * satisfy a learning-sample requirement.
 */
/** One session's worth of segments, in the order they were produced. */
const byTask = (segments: readonly ReviewCoachInteractionSegmentLocal[]) => {
  const groups = new Map<string, ReviewCoachInteractionSegmentLocal[]>();
  for (const segment of segments) {
    const key = segment.taskId ?? "";
    groups.set(key, [...(groups.get(key) ?? []), segment]);
  }
  for (const group of groups.values()) {
    group.sort((left, right) => left.endedAt.localeCompare(right.endedAt));
  }
  return groups;
};

/**
 * Distinct learning sessions across the sample, counted per task.
 *
 * Task-less (workbench) segments are excluded on purpose: see `sessionsForTask`.
 */
export const countMeasuredSessions = (segments: readonly ReviewCoachInteractionSegmentLocal[]): number => new Set(
  segments
    .filter((segment) => Boolean(segment.sessionId && segment.taskId))
    .map((segment) => segment.sessionId!),
).size;

const elapsed = (fromIso: string, toIso: string): number => {
  const value = Date.parse(toIso) - Date.parse(fromIso);
  return Number.isFinite(value) && value > 0 ? value : 0;
};

export const buildFrictionReport = (
  segments: readonly ReviewCoachInteractionSegmentLocal[],
): FrictionReport => {
  const rows: FrictionReportRow[] = [];
  for (const [taskId, group] of byTask(segments)) {
    const first = group[0];
    const firstRetrieval = group.find((segment) => segment.category === "cognitive" && segment.phase === "initial-retrieval");
    const rollup = rollupInteractionSegments(group);
    rows.push({
      taskId,
      entryToFirstRetrievalMs: firstRetrieval ? elapsed(first.startedAt, firstRetrieval.startedAt) : null,
      retrievalCount: group.filter((segment) => segment.category === "cognitive").length,
      totalActiveMs: rollup.totalActiveMs,
      operationMs: rollup.operationMs,
      operationRatio: rollup.totalActiveMs > 0 ? rollup.operationRatio : null,
    });
  }
  const rollup = rollupInteractionSegments(segments);
  const measuredSessions = countMeasuredSessions(segments);
  return {
    rows,
    totalActiveMs: rollup.totalActiveMs,
    operationMs: rollup.operationMs,
    operationRatio: rollup.operationRatio,
    measuredSessions,
    // Ten sessions is the M5 acceptance sample, so anything less is indicative only.
    meetsOperationBudget: measuredSessions >= MIN_SESSIONS_FOR_OPERATION_BUDGET && rollup.operationRatio <= 0.15,
  };
};
