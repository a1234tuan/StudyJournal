import { describe, expect, it } from "vitest";

import { buildFrictionReport, countMeasuredSessions, MIN_SESSIONS_FOR_OPERATION_BUDGET } from "./frictionReport";
import type { ReviewCoachInteractionSegmentLocal } from "./interactionTrace";

const segment = (
  overrides: Partial<ReviewCoachInteractionSegmentLocal> & { id: string },
): ReviewCoachInteractionSegmentLocal => ({
  taskId: "task-1",
  sessionId: "session-default",
  screen: "task",
  category: "cognitive",
  phase: "initial-retrieval",
  activeMs: 10_000,
  startedAt: "2026-09-15T08:00:00.000Z",
  endedAt: "2026-09-15T08:00:10.000Z",
  ...overrides,
});

/**
 * The M5 acceptance sample: ten distinct learning sessions.
 *
 * Each entry is a separate task on a separate day, so these are ten genuine
 * sittings - not ten segments inside one. Building the sample this way is the
 * point of the test: the earlier fixture reused one taskId and one timestamp,
 * which is precisely the shape the gate must now reject.
 */
const acceptanceSample = () => [
  segment({ id: "entry", taskId: undefined, category: "operation", phase: "workbench", activeMs: 1_000, startedAt: "2026-09-15T07:59:00.000Z", endedAt: "2026-09-15T07:59:01.000Z" }),
  ...Array.from({ length: MIN_SESSIONS_FOR_OPERATION_BUDGET }, (_, index) => segment({
    id: `session-${index}`,
    taskId: `task-${index}`,
    sessionId: `session-${index}`,
    phase: "initial-retrieval",
    activeMs: 60_000,
    startedAt: `2026-09-${String(index + 1).padStart(2, "0")}T08:00:00.000Z`,
    endedAt: `2026-09-${String(index + 1).padStart(2, "0")}T08:01:00.000Z`,
  })),
];

describe("frictionReport", () => {
  it("separates retrieval time from entry and operation overhead", () => {
    const report = buildFrictionReport([
      segment({ id: "entry", category: "operation", phase: "workbench", activeMs: 5_000, startedAt: "2026-09-15T08:00:00.000Z", endedAt: "2026-09-15T08:00:05.000Z" }),
      segment({ id: "initial", phase: "initial-retrieval", activeMs: 60_000, startedAt: "2026-09-15T08:00:05.000Z", endedAt: "2026-09-15T08:01:05.000Z" }),
      segment({ id: "feedback", category: "feedback", phase: "feedback", activeMs: 20_000, startedAt: "2026-09-15T08:01:05.000Z", endedAt: "2026-09-15T08:01:25.000Z" }),
      segment({ id: "post", phase: "post-judgment", activeMs: 45_000, startedAt: "2026-09-15T08:01:25.000Z", endedAt: "2026-09-15T08:02:10.000Z" }),
    ]);

    const row = report.rows[0];
    expect(row.entryToFirstRetrievalMs).toBe(5_000);
    expect(row.retrievalCount).toBe(2);
    expect(row.totalActiveMs).toBe(130_000);
    expect(row.operationMs).toBe(5_000);
    expect(report.operationRatio).toBeCloseTo(5_000 / 130_000, 6);
    // Four segments is a well-under-budget ratio but nowhere near the sample
    // the claim was defined against, so it must not report "met".
    expect(report.meetsOperationBudget).toBe(false);
  });

  it("only claims the operation budget once ten real sessions exist", () => {
    const full = buildFrictionReport(acceptanceSample());
    expect(full.measuredSessions).toBe(MIN_SESSIONS_FOR_OPERATION_BUDGET);
    expect(full.meetsOperationBudget).toBe(true);
    // One session short of the sample: still indicative only.
    const short = buildFrictionReport(acceptanceSample().filter((item) => item.id !== "session-0"));
    expect(short.measuredSessions).toBe(MIN_SESSIONS_FOR_OPERATION_BUDGET - 1);
    expect(short.meetsOperationBudget).toBe(false);
  });

  it("does not let many segments from one sitting count as many sessions", () => {
    // The defect this pins: the gate used to compare `segments.length`, so a
    // single task that emitted ten segments cleared a requirement stated in
    // sessions. Ten phases inside one sitting is one session.
    const oneSitting = Array.from({ length: MIN_SESSIONS_FOR_OPERATION_BUDGET }, (_, index) => segment({
      id: `phase-${index}`,
      taskId: "task-single",
      phase: index === 0 ? "initial-retrieval" : "post-judgment",
      activeMs: 6_000,
      startedAt: `2026-09-15T08:00:${String(index * 6).padStart(2, "0")}.000Z`,
      endedAt: `2026-09-15T08:00:${String(index * 6 + 6).padStart(2, "0")}.000Z`,
    }));
    const report = buildFrictionReport(oneSitting);

    expect(oneSitting).toHaveLength(MIN_SESSIONS_FOR_OPERATION_BUDGET);
    expect(report.measuredSessions).toBe(1);
    expect(report.meetsOperationBudget).toBe(false);
  });

  it("treats a return after a long gap as a separate session", () => {
    const sameTaskTwoSittings = [
      segment({ id: "s1a", taskId: "task-1", sessionId: "session-1", startedAt: "2026-09-15T08:00:00.000Z", endedAt: "2026-09-15T08:00:30.000Z" }),
      segment({ id: "s1b", taskId: "task-1", sessionId: "session-1", phase: "post-judgment", startedAt: "2026-09-15T08:00:30.000Z", endedAt: "2026-09-15T08:01:00.000Z" }),
      // Hours later: the learner left and came back.
      segment({ id: "s2a", taskId: "task-1", sessionId: "session-2", startedAt: "2026-09-15T14:00:00.000Z", endedAt: "2026-09-15T14:00:30.000Z" }),
    ];

    expect(countMeasuredSessions(sameTaskTwoSittings)).toBe(2);
  });

  it("does not count task-less workbench segments as learning sessions", () => {
    const workbenchOnly = Array.from({ length: MIN_SESSIONS_FOR_OPERATION_BUDGET }, (_, index) => segment({
      id: `wb-${index}`,
      taskId: undefined,
      category: "operation",
      phase: "workbench",
      startedAt: `2026-09-${String(index + 1).padStart(2, "0")}T08:00:00.000Z`,
      endedAt: `2026-09-${String(index + 1).padStart(2, "0")}T08:00:05.000Z`,
    }));

    expect(countMeasuredSessions(workbenchOnly)).toBe(0);
    expect(buildFrictionReport(workbenchOnly).meetsOperationBudget).toBe(false);
  });

  it("flags a session that blows the operation budget", () => {
    const report = buildFrictionReport([
      segment({ id: "op-1", category: "operation", phase: "workbench", activeMs: 40_000 }),
      segment({ id: "op-2", category: "operation", phase: "confirm", activeMs: 40_000 }),
      segment({ id: "retrieval", phase: "initial-retrieval", activeMs: 20_000 }),
    ]);
    expect(report.operationRatio).toBeCloseTo(0.8, 6);
    expect(report.meetsOperationBudget).toBe(false);
  });

  it("reports null rather than zero when a task has no measured time", () => {
    const report = buildFrictionReport([]);
    expect(report.rows).toEqual([]);
    expect(report.operationRatio).toBe(0);
    expect(report.measuredSessions).toBe(0);
    expect(report.meetsOperationBudget).toBe(false);
  });

  it("keeps tasks separate and never reports a negative entry delay", () => {
    const report = buildFrictionReport([
      segment({ id: "a1", taskId: "task-1", startedAt: "2026-09-15T08:00:00.000Z", endedAt: "2026-09-15T08:00:01.000Z" }),
      segment({ id: "b1", taskId: "task-2", phase: "initial-retrieval", startedAt: "2026-09-15T09:00:00.000Z", endedAt: "2026-09-15T09:00:30.000Z" }),
    ]);
    expect(report.rows.map((row) => row.taskId).sort()).toEqual(["task-1", "task-2"]);
    const task1 = report.rows.find((row) => row.taskId === "task-1")!;
    expect(task1.entryToFirstRetrievalMs).toBe(0);
  });
});
