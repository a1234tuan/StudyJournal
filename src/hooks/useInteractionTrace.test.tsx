import Dexie from "dexie";
import { IDBKeyRange, indexedDB } from "fake-indexeddb";
import { StrictMode, useEffect } from "react";
import { act, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { StudyJournalDatabase } from "../db/database";
import { ReviewCoachInteractionRepository } from "../features/reviewCoach/interactionRepository";
import { useInteractionTrace } from "./useInteractionTrace";

Dexie.dependencies.indexedDB = indexedDB;
Dexie.dependencies.IDBKeyRange = IDBKeyRange;

interface HarnessProps {
  repository: ReviewCoachInteractionRepository;
  database: StudyJournalDatabase;
  phase: string;
  sessionId?: string;
  onReady?: (api: ReturnType<typeof useInteractionTrace>) => void;
}

const Harness = ({ database, repository, phase, sessionId, onReady }: HarnessProps) => {
  const trace = useInteractionTrace(database, repository);
  useEffect(() => {
    trace.enter({ screen: "task", category: "cognitive", phase, taskId: "task-1", sessionId });
    onReady?.(trace);
  }, [phase, sessionId]);
  return <div data-testid="harness" onClick={() => trace.touch()} />;
};

const setVisibility = (state: "visible" | "hidden") => {
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => state });
  document.dispatchEvent(new Event("visibilitychange"));
};

const readSegments = async (database: StudyJournalDatabase) => database.reviewCoachInteractionSegments.toArray();

describe("useInteractionTrace", () => {
  let database: StudyJournalDatabase;
  let repository: ReviewCoachInteractionRepository;

  beforeEach(async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    database = new StudyJournalDatabase(`interaction-hook-${crypto.randomUUID()}`);
    await database.open();
    repository = new ReviewCoachInteractionRepository(database);
    setVisibility("visible");
  });

  afterEach(async () => {
    vi.useRealTimers();
    const name = database.name;
    database.close();
    await Dexie.delete(name);
  });

  it("does not credit time while the page is hidden", async () => {
    const view = render(<Harness database={database} repository={repository} phase="initial-retrieval" />);
    await act(async () => { vi.advanceTimersByTime(10_000); });
    await act(async () => { setVisibility("hidden"); });
    await act(async () => { vi.advanceTimersByTime(600_000); });

    const segments = await readSegments(database);
    const total = segments.reduce((sum, segment) => sum + segment.activeMs, 0);
    // ~10s of visible work; the 10 hidden minutes must not appear.
    expect(total).toBeLessThan(30_000);
    expect(total).toBeGreaterThan(0);
    view.unmount();
  });

  it("suspends a visible but idle page at the 60 second boundary", async () => {
    render(<Harness database={database} repository={repository} phase="initial-retrieval" />);
    await act(async () => { vi.advanceTimersByTime(300_000); });
    const segments = await readSegments(database);
    const total = segments.reduce((sum, segment) => sum + segment.activeMs, 0);
    // Five idle minutes are clipped to roughly the one minute idle allowance.
    expect(total).toBeLessThanOrEqual(75_000);
  });

  it("keeps the window alive while the learner keeps interacting past the idle boundary", async () => {
    // The bug this pins down: production pages only ever called `enter()`, so
    // `lastActivityAt` never moved and a learner who read or typed for over a
    // minute was closed out as idle - their cognitive time vanished and the
    // operation ratio was computed against a wrong denominator. Real DOM
    // activity must refresh the clock, with no page-level wiring required.
    const view = render(<Harness database={database} repository={repository} phase="initial-retrieval" />);
    for (let elapsed = 0; elapsed < 180_000; elapsed += 10_000) {
      await act(async () => { window.dispatchEvent(new Event("pointerdown")); });
      await act(async () => { vi.advanceTimersByTime(10_000); });
    }
    // The window is still open (that is the fix), so close it to flush the
    // banked time before asserting.
    view.unmount();
    await act(async () => { vi.advanceTimersByTime(1_000); });

    const segments = await readSegments(database);
    const total = segments.reduce((sum, segment) => sum + segment.activeMs, 0);
    // Three active minutes must be credited, not clipped to the one minute a
    // genuinely idle page would get.
    expect(total).toBeGreaterThan(150_000);
  });

  it("still clips a visible page that receives no interaction at all", async () => {
    // The counterpart guard: registering activity listeners must not disable the
    // idle rule. A page nobody touches is still not friction.
    render(<Harness database={database} repository={repository} phase="initial-retrieval" />);
    await act(async () => { vi.advanceTimersByTime(300_000); });
    const segments = await readSegments(database);
    const total = segments.reduce((sum, segment) => sum + segment.activeMs, 0);
    expect(total).toBeLessThanOrEqual(75_000);
  });

  it("closes exactly one window across a StrictMode double mount", async () => {
    const view = render(
      <StrictMode>
        <Harness database={database} repository={repository} phase="initial-retrieval" />
      </StrictMode>,
    );
    await act(async () => { vi.advanceTimersByTime(20_000); });
    view.unmount();
    await act(async () => { vi.advanceTimersByTime(1_000); });

    const segments = await readSegments(database);
    const total = segments.reduce((sum, segment) => sum + segment.activeMs, 0);
    // A double mount would double this. Generous upper bound for timer jitter.
    expect(total).toBeLessThanOrEqual(40_000);
  });

  it("keeps what was actually spent when the app exits abnormally", async () => {
    render(<Harness database={database} repository={repository} phase="initial-retrieval" />);
    await act(async () => { vi.advanceTimersByTime(15_000); });
    await act(async () => { window.dispatchEvent(new Event("pagehide")); });
    await act(async () => { vi.advanceTimersByTime(60_000); });

    const segments = await readSegments(database);
    const total = segments.reduce((sum, segment) => sum + segment.activeMs, 0);
    expect(total).toBeGreaterThan(0);
    expect(total).toBeLessThan(30_000);
  });

  it("splits phases so the report can tell retrieval from operation", async () => {
    const phases: string[] = ["workbench", "initial-retrieval"];
    const view = render(<Harness database={database} repository={repository} phase={phases[0]} />);
    await act(async () => { vi.advanceTimersByTime(10_000); });
    view.rerender(<Harness database={database} repository={repository} phase={phases[1]} />);
    await act(async () => { vi.advanceTimersByTime(10_000); });
    view.unmount();
    await act(async () => { vi.advanceTimersByTime(100); });

    const segments = await readSegments(database);
    const distinctPhases = new Set(segments.map((segment) => segment.phase));
    expect(distinctPhases.size).toBeGreaterThanOrEqual(2);
    expect(segments.every((segment) => segment.activeMs >= 0)).toBe(true);
  });

  it("persists the explicit learning-flow session id", async () => {
    const view = render(<Harness database={database} repository={repository} phase="initial-retrieval" sessionId="review-flow-1" />);
    await act(async () => { vi.advanceTimersByTime(5_000); });
    view.unmount();
    await act(async () => { vi.advanceTimersByTime(100); });

    const segments = await readSegments(database);
    expect(segments).toHaveLength(1);
    expect(segments[0].sessionId).toBe("review-flow-1");
  });

  it("never stores answer text, prompts or provider responses", async () => {
    render(<Harness database={database} repository={repository} phase="initial-retrieval" />);
    await act(async () => { vi.advanceTimersByTime(5_000); });
    const segments = await readSegments(database);
    for (const segment of segments) {
      expect(Object.keys(segment).sort()).toEqual([
        "activeMs", "category", "endedAt", "id", "phase", "recordId", "screen", "startedAt", "taskId",
      ]);
    }
  });
});
