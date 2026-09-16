/**
 * Closed-loop v2 product rules and normalization.
 *
 * These are fixed product rules, not AI-tunable fields. The planner may propose
 * any `maxTurns`; the v2 normalizer raises it to the floor. Keeping the rules in
 * one module means the planner, the repository, the validator and the tests all
 * read the same numbers.
 */

import type { LearningLoopVersion, RetrievalPhase } from "./domain";

export const CLOSED_LOOP_V2_LOOP_VERSION: LearningLoopVersion = "closed-loop-v2";

/**
 * A v2 completion needs exactly two qualifying retrievals: one before the
 * judgment and one after it. This is the whole point of the milestone.
 */
export const requiredQualifyingRetrievalsV2 = 2;

/** Version stamp recorded whenever the normalizer changes an AI-proposed budget. */
export const TURN_BUDGET_POLICY_VERSION = "closed-loop-v2-turn-budget@1.0";

/** Fixed reason written when display budget or the time box runs out before closure. */
export const BUDGET_EXHAUSTED_REASON = "budget-exhausted-before-closure";

/** Fixed reason written when the wall-clock session box, not the turn budget, ran out. */
export const TIME_BOX_EXHAUSTED_REASON = "time-box-exhausted";

/**
 * How long a single v2 attempt may stay open, in milliseconds.
 *
 * The turn budget says how many retrievals are worth showing; the time box says
 * how long the learner is expected to stay in one sitting. A five-minute box
 * keeps a single attempt to a plausible "one thing, done properly" unit instead
 * of an open-ended session that quietly becomes a marathon. Neither budget is a
 * completion criterion: running one out defers and requeues, it never closes.
 */
export const SESSION_TIME_BOX_MS = 5 * 60 * 1000;

/** True when a v2 attempt started at `startedAt` has used up its time box. */
export const isTimeBoxExhausted = (
  startedAt: string | undefined,
  now: string,
  boxMs = SESSION_TIME_BOX_MS,
): boolean => {
  if (!startedAt) return false;
  const started = Date.parse(startedAt);
  const current = Date.parse(now);
  if (!Number.isFinite(started) || !Number.isFinite(current)) return false;
  return current - started >= boxMs;
};

/**
 * The two phases that count toward a v2 completion, in order. `delayed-first`
 * and `delayed-remediation` belong to verification, not to the immediate loop.
 */
export const COMPLETION_PHASES: readonly RetrievalPhase[] = ["initial", "post-judgment"];

/** Raises an AI-proposed turn budget to the v2 floor. Never lowers a larger budget. */
export const normalizeTurnBudgetForV2 = (maxTurns: number): number => (
  Math.max(requiredQualifyingRetrievalsV2, Math.floor(Number.isFinite(maxTurns) ? maxTurns : 0))
);
