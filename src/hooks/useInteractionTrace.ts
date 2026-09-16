import { useCallback, useEffect, useRef } from "react";
import { nanoid } from "nanoid";

import type { StudyJournalDatabase } from "../db/database";
import { db } from "../db/database";
import { ReviewCoachInteractionRepository } from "../features/reviewCoach/interactionRepository";
import {
  REVIEW_COACH_INTERACTION_IDLE_MS,
  accruedMs,
  resume,
  suspend,
  type InteractionSegmentCategory,
  type InteractionSegmentScreen,
  type ReviewCoachInteractionSegmentLocal,
} from "../features/reviewCoach/interactionTrace";

export interface InteractionTraceTarget {
  screen: InteractionSegmentScreen;
  category: InteractionSegmentCategory;
  phase: string;
  sessionId?: string;
  taskId?: string;
  recordId?: string;
}

const sameTarget = (left: InteractionTraceTarget | null, right: InteractionTraceTarget): boolean => (
  left !== null
  && left.screen === right.screen
  && left.category === right.category
  && left.phase === right.phase
  && left.sessionId === right.sessionId
  && left.taskId === right.taskId
  && left.recordId === right.recordId
);

interface OpenSegment {
  target: InteractionTraceTarget;
  /** Wall-clock start of the current running window. */
  startedAt: number;
  /** Time already banked from previous windows. */
  accumulatedMs: number;
  lastActivityAt: number;
  running: boolean;
  /** Sequence guard so a StrictMode remount cannot close the same window twice. */
  generation: number;
}

/**
 * Records what kind of activity the learner is currently doing.
 *
 * Timing rules (dev plan section 4.5 / M0 Go conditions):
 *
 * - page hidden or backgrounded: the segment is suspended, so hidden time is
 *   never credited;
 * - 60 seconds without interaction: suspended the same way (checked on a timer,
 *   because a page can sit visible-but-idle indefinitely);
 * - StrictMode remount, React key change or component unmount: the open window
 *   is closed exactly once and immediately, so a remount cannot double count;
 * - `beforeunload`/`pagehide`: the window is closed so an abnormal exit keeps
 *   the time that was actually spent.
 *
 * Only the phase label and duration are persisted. No answers, page text,
 * prompts or provider responses ever reach this hook.
 */
export const useInteractionTrace = (
  database: StudyJournalDatabase = db,
  repository: ReviewCoachInteractionRepository = new ReviewCoachInteractionRepository(database),
) => {
  const openRef = useRef<OpenSegment | null>(null);
  const generationRef = useRef(0);

  const closeOpenWindow = useCallback((reason: string) => {
    const open = openRef.current;
    if (!open) return;
    const now = Date.now();
    const banked = accruedMs(open, now);
    open.accumulatedMs = banked;
    open.startedAt = now;
    open.running = false;
    if (banked <= 0) return;
    const segment: ReviewCoachInteractionSegmentLocal = {
      id: `interaction-segment-${nanoid(12)}`,
      sessionId: open.target.sessionId,
      taskId: open.target.taskId,
      recordId: open.target.recordId,
      screen: open.target.screen,
      category: open.target.category,
      phase: open.target.phase,
      activeMs: Math.round(banked),
      startedAt: new Date(now - banked).toISOString(),
      endedAt: new Date(now).toISOString(),
    };
    open.accumulatedMs = 0;
    // `reason` is intentionally not persisted: it is diagnostic only and must
    // not become another field to maintain.
    void reason;
    // Measurement must never break the learning flow: a closed or blocked
    // database drops the sample instead of surfacing an error to the learner.
    void repository.append([segment]).catch(() => undefined);
  }, [repository]);

  /** Switch to a new activity. Closes the previous phase, opens a fresh one. */
  const enter = useCallback((target: InteractionTraceTarget) => {
    if (sameTarget(openRef.current?.target ?? null, target)) {
      const open = openRef.current!;
      if (!open.running) {
        const resumed = resume(open, Date.now());
        open.startedAt = resumed.startedAt;
        open.lastActivityAt = resumed.lastActivityAt;
        open.running = resumed.running;
      } else {
        open.lastActivityAt = Date.now();
      }
      return;
    }
    closeOpenWindow("phase-change");
    const now = Date.now();
    openRef.current = {
      target,
      startedAt: now,
      accumulatedMs: 0,
      lastActivityAt: now,
      running: true,
      generation: generationRef.current,
    };
  }, [closeOpenWindow]);

  /** Any user interaction keeps the current phase alive. */
  const touch = useCallback(() => {
    const open = openRef.current;
    if (!open) return;
    if (open.running) {
      open.lastActivityAt = Date.now();
      return;
    }
    const resumed = resume(open, Date.now());
    open.startedAt = resumed.startedAt;
    open.lastActivityAt = resumed.lastActivityAt;
    open.running = resumed.running;
  }, []);

  useEffect(() => {
    generationRef.current += 1;
    const open = openRef.current;
    if (open && !open.target.taskId) {
      open.generation = generationRef.current;
    }

    const handleVisibility = () => {
      if (document.visibilityState === "hidden") {
        closeOpenWindow("hidden");
      } else {
        // Do not auto-resume: the learner has to interact again. Time between
        // becoming visible and the first interaction is not attributed.
        openRef.current = null;
      }
    };
    const handlePageHide = () => closeOpenWindow("pagehide");
    const handleBeforeUnload = () => closeOpenWindow("beforeunload");

    document.addEventListener("visibilitychange", handleVisibility);
    window.addEventListener("pagehide", handlePageHide);
    window.addEventListener("beforeunload", handleBeforeUnload);

    // Real activity keeps the phase alive. This listener is registered here, in
    // the hook, rather than left to each page: the previous design only refreshed
    // `lastActivityAt` when a page happened to call `enter()` again, so a learner
    // who read feedback or typed an answer for over a minute was recorded as
    // idle - their cognitive time was silently dropped and the operation ratio
    // the 15% budget rests on was measured against a wrong denominator. One
    // listener covers every page that mounts the hook.
    //
    // Only the fact that *something* happened is used; the event target, key
    // codes and any typed text are never read, so no answer content can leak.
    const activityEvents = ["pointerdown", "keydown", "wheel", "scroll", "touchstart"] as const;
    const handleActivity = () => touch();
    for (const eventName of activityEvents) {
      window.addEventListener(eventName, handleActivity, { passive: true });
    }

    // A visible page that nobody touches is still not friction.
    const idleTimer = window.setInterval(() => {
      const current = openRef.current;
      if (current?.running && Date.now() - current.lastActivityAt >= REVIEW_COACH_INTERACTION_IDLE_MS) {
        closeOpenWindow("idle");
      }
    }, 5_000);

    return () => {
      document.removeEventListener("visibilitychange", handleVisibility);
      window.removeEventListener("pagehide", handlePageHide);
      window.removeEventListener("beforeunload", handleBeforeUnload);
      for (const eventName of activityEvents) {
        window.removeEventListener(eventName, handleActivity);
      }
      window.clearInterval(idleTimer);
      // Closing on unmount is what makes a StrictMode double-mount safe: each
      // mount owns its own window and closes it before the next mount opens one.
      closeOpenWindow("unmount");
    };
  }, [closeOpenWindow, touch]);

  return { enter, touch, flush: closeOpenWindow };
};
