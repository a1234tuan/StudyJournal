import { describe, expect, it } from "vitest";

import {
  REVIEW_COACH_INTERACTION_IDLE_MS,
  REVIEW_COACH_INTERACTION_RETENTION_DAYS,
  accruedMs,
  expiredInteractionSegmentIds,
  isIdle,
  resume,
  rollupInteractionSegments,
  suspend,
  touch,
  type ReviewCoachInteractionSegmentLocal,
} from "./interactionTrace";

const segment = (
  overrides: Partial<ReviewCoachInteractionSegmentLocal> = {},
): ReviewCoachInteractionSegmentLocal => ({
  id: "segment-1",
  screen: "task",
  category: "cognitive",
  phase: "initial-retrieval",
  activeMs: 12_000,
  startedAt: "2026-09-15T08:00:00.000Z",
  endedAt: "2026-09-15T08:00:12.000Z",
  ...overrides,
});

describe("interactionTrace accrual", () => {
  it("credits only elapsed active time", () => {
    const draft = { startedAt: 1_000, accumulatedMs: 5_000, lastActivityAt: 1_000, running: true };
    expect(accruedMs(draft, 4_000)).toBe(8_000);
  });

  it("never credits time past the idle boundary, so a forgotten tab is not friction", () => {
    const draft = { startedAt: 0, accumulatedMs: 0, lastActivityAt: 0, running: true };
    expect(accruedMs(draft, REVIEW_COACH_INTERACTION_IDLE_MS * 10)).toBe(REVIEW_COACH_INTERACTION_IDLE_MS);
  });

  it("stops accruing once suspended and keeps the partial time", () => {
    const draft = { startedAt: 0, accumulatedMs: 0, lastActivityAt: 0, running: true };
    const paused = suspend(draft, 9_000);
    expect(paused.running).toBe(false);
    expect(paused.accumulatedMs).toBe(9_000);
    // Time keeps passing while hidden.
    expect(accruedMs(paused, 999_999)).toBe(9_000);
  });

  it("treats a hidden page as idle without destroying accumulated time", () => {
    const draft = { startedAt: 0, accumulatedMs: 2_000, lastActivityAt: 0, running: true };
    const hidden = suspend(draft, 3_000);
    const visibleAgain = resume(hidden, 500_000);
    // 2_000 already banked + 3_000 from the run before hiding; the whole gap
    // while hidden is dropped, then 1_000 of fresh activity is credited.
    expect(accruedMs(visibleAgain, 501_000)).toBe(6_000);
  });

  it("does not double count when a segment is resumed twice", () => {
    const draft = { startedAt: 0, accumulatedMs: 1_000, lastActivityAt: 0, running: false };
    const first = resume(draft, 10_000);
    const second = resume(first, 20_000);
    expect(second.startedAt).toBe(10_000);
    expect(accruedMs(second, 11_000)).toBe(2_000);
  });

  it("reports idleness only for running segments", () => {
    expect(isIdle({ lastActivityAt: 0, running: true }, REVIEW_COACH_INTERACTION_IDLE_MS)).toBe(true);
    expect(isIdle({ lastActivityAt: 0, running: true }, REVIEW_COACH_INTERACTION_IDLE_MS - 1)).toBe(false);
    expect(isIdle({ lastActivityAt: 0, running: false }, REVIEW_COACH_INTERACTION_IDLE_MS * 5)).toBe(false);
  });

  it("resumes an idled segment on the next interaction instead of leaking the gap", () => {
    // 4_000 already banked; startedAt sits at the activity boundary.
    const idled = suspend({ startedAt: 4_000, accumulatedMs: 4_000, lastActivityAt: 4_000, running: true }, 4_000);
    expect(idled.accumulatedMs).toBe(4_000);
    const touched = touch(idled, 900_000);
    expect(touched.running).toBe(true);
    // 4_000 banked + 1_000 of new activity; the 15 idle minutes are dropped.
    expect(accruedMs(touched, 901_000)).toBe(5_000);
  });

  it("keeps a running segment running and only refreshes activity", () => {
    const running = { startedAt: 0, accumulatedMs: 0, lastActivityAt: 0, running: true };
    const touched = touch(running, 5_000);
    expect(touched.startedAt).toBe(0);
    expect(touched.lastActivityAt).toBe(5_000);
  });
});

describe("interactionTrace rollup", () => {
  it("separates cognitive, feedback and operation time", () => {
    const rollup = rollupInteractionSegments([
      segment({ id: "a", category: "cognitive", activeMs: 60_000, taskId: "task-1" }),
      segment({ id: "b", category: "feedback", activeMs: 20_000, taskId: "task-1" }),
      segment({ id: "c", category: "operation", activeMs: 20_000 }),
      segment({ id: "d", category: "operation", activeMs: 10_000, taskId: "task-2" }),
    ]);
    expect(rollup.totalActiveMs).toBe(110_000);
    expect(rollup.cognitiveMs).toBe(60_000);
    expect(rollup.feedbackMs).toBe(20_000);
    expect(rollup.operationMs).toBe(30_000);
    expect(rollup.operationRatio).toBeCloseTo(30_000 / 110_000, 6);
    expect(rollup.taskIds).toEqual(["task-1", "task-2"]);
  });

  it("reports a zero ratio rather than NaN when nothing was measured", () => {
    const rollup = rollupInteractionSegments([]);
    expect(rollup.totalActiveMs).toBe(0);
    expect(rollup.operationRatio).toBe(0);
  });

  it("ignores negative durations from clock skew", () => {
    const rollup = rollupInteractionSegments([segment({ activeMs: -5_000 })]);
    expect(rollup.totalActiveMs).toBe(0);
    expect(rollup.operationRatio).toBe(0);
  });
});

describe("interactionTrace retention", () => {
  it("expires segments past the retention window", () => {
    const now = Date.parse("2026-09-15T08:00:00.000Z");
    const fresh = segment({ id: "fresh", endedAt: new Date(now - 1_000).toISOString() });
    const stale = segment({
      id: "stale",
      endedAt: new Date(now - (REVIEW_COACH_INTERACTION_RETENTION_DAYS + 1) * 24 * 60 * 60 * 1000).toISOString(),
    });
    expect(expiredInteractionSegmentIds([fresh, stale], now)).toEqual(["stale"]);
  });
});
