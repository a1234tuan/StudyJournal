/**
 * Review Coach interaction trace (device-local measurement scaffolding).
 *
 * Purpose: make operation friction measurable before the closed loop is built,
 * so M5 can prove `operation active time / total active time <= 15%` with real
 * numbers instead of a stopwatch.
 *
 * Three categories are strictly separated (dev plan section 4.5):
 *
 *   cognitive - the user is retrieving or reconstructing knowledge (answering).
 *   feedback  - the user is reading feedback about their own answer.
 *   operation - navigation, configuration, confirmation, waiting on AI, etc.
 *
 * Everything here is local to one device. Nothing in this module may be added to
 * `reviewCoachFormalTables`, the portable backup format, record transfer,
 * knowledge export or Firebase sync. It stores no answers, no page text, no
 * prompts and no provider responses - only a phase label and a duration.
 */

export const REVIEW_COACH_INTERACTION_IDLE_MS = 60_000;
export const REVIEW_COACH_INTERACTION_RETENTION_DAYS = 30;

export type InteractionSegmentScreen = "workbench" | "task";

export type InteractionSegmentCategory = "cognitive" | "feedback" | "operation";

export interface ReviewCoachInteractionSegmentLocal {
  id: string;
  /** Stable id for one learner flow; absent only on legacy pre-session samples. */
  sessionId?: string;
  taskId?: string;
  recordId?: string;
  screen: InteractionSegmentScreen;
  category: InteractionSegmentCategory;
  phase: string;
  activeMs: number;
  startedAt: string;
  endedAt: string;
}

/** Live state of one measurable segment. Persisted only when it closes. */
export interface InteractionSegmentDraft {
  taskId?: string;
  recordId?: string;
  screen: InteractionSegmentScreen;
  category: InteractionSegmentCategory;
  phase: string;
  startedAt: number;
  accumulatedMs: number;
  /** Timestamp of the last activity that kept the segment running. */
  lastActivityAt: number;
  /** True while the page is visible and the segment is accruing time. */
  running: boolean;
}

export interface InteractionTraceTick {
  /** Where the user is right now. */
  screen: InteractionSegmentScreen;
  category: InteractionSegmentCategory;
  phase: string;
  sessionId?: string;
  taskId?: string;
  recordId?: string;
}

export interface InteractionClockInput {
  startedAt: number;
  accumulatedMs: number;
  lastActivityAt: number;
  running: boolean;
}

/**
 * Time credited to a segment given a wall-clock `now`.
 *
 * Idle time is never credited: elapsed time past the idle threshold is clipped,
 * so a tab left open overnight cannot turn into "operation friction".
 */
export const accruedMs = (input: InteractionClockInput, now: number, idleMs = REVIEW_COACH_INTERACTION_IDLE_MS): number => {
  if (!input.running) return input.accumulatedMs;
  const effectiveNow = Math.min(now, input.lastActivityAt + idleMs);
  return input.accumulatedMs + Math.max(0, effectiveNow - input.startedAt);
};

/** True when the segment has been idle long enough that it should stop accruing. */
export const isIdle = (input: Pick<InteractionClockInput, "lastActivityAt" | "running">, now: number, idleMs = REVIEW_COACH_INTERACTION_IDLE_MS): boolean => (
  input.running && now - input.lastActivityAt >= idleMs
);

/** Pause accrual at the idle boundary without closing the segment. */
export const suspend = <T extends InteractionClockInput>(draft: T, now: number, idleMs = REVIEW_COACH_INTERACTION_IDLE_MS): T => {
  if (!draft.running) return draft;
  return { ...draft, accumulatedMs: accruedMs(draft, now, idleMs), startedAt: now, running: false };
};

/** Resume accrual and treat `now` as fresh activity. */
export const resume = <T extends InteractionClockInput>(draft: T, now: number): T => (
  draft.running ? draft : { ...draft, startedAt: now, lastActivityAt: now, running: true }
);

/** Record user activity, resuming a suspended segment at the idle boundary when needed. */
export const touch = <T extends InteractionClockInput>(draft: T, now: number, idleMs = REVIEW_COACH_INTERACTION_IDLE_MS): T => (
  draft.running
    ? { ...draft, lastActivityAt: now }
    : resume(draft, now) as T & { lastActivityAt: number }
);

export interface InteractionRollup {
  totalActiveMs: number;
  cognitiveMs: number;
  feedbackMs: number;
  operationMs: number;
  /** Operation share of measured active time; 0 when nothing was measured. */
  operationRatio: number;
  /** Distinct task ids that produced at least one qualifying segment. */
  taskIds: string[];
}

const emptyRollup = (): InteractionRollup => ({
  totalActiveMs: 0,
  cognitiveMs: 0,
  feedbackMs: 0,
  operationMs: 0,
  operationRatio: 0,
  taskIds: [],
});

export const rollupInteractionSegments = (
  segments: readonly ReviewCoachInteractionSegmentLocal[],
): InteractionRollup => {
  const total = segments.reduce((sum, segment) => sum + Math.max(0, segment.activeMs), 0);
  if (total === 0) return emptyRollup();
  const byCategory = (category: InteractionSegmentCategory) => segments
    .filter((segment) => segment.category === category)
    .reduce((sum, segment) => sum + Math.max(0, segment.activeMs), 0);
  const operationMs = byCategory("operation");
  return {
    totalActiveMs: total,
    cognitiveMs: byCategory("cognitive"),
    feedbackMs: byCategory("feedback"),
    operationMs,
    operationRatio: operationMs / total,
    taskIds: [...new Set(segments.map((segment) => segment.taskId).filter((id): id is string => Boolean(id)))],
  };
};

const DAY_MS = 24 * 60 * 60 * 1000;

/** Segments older than the retention window, which the caller should delete. */
export const expiredInteractionSegmentIds = (
  segments: readonly ReviewCoachInteractionSegmentLocal[],
  now: number,
  retentionDays = REVIEW_COACH_INTERACTION_RETENTION_DAYS,
): string[] => {
  const cutoff = now - retentionDays * DAY_MS;
  return segments
    .filter((segment) => Date.parse(segment.endedAt) < cutoff)
    .map((segment) => segment.id);
};
