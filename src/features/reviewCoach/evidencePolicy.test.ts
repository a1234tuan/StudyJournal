import { describe, expect, it } from "vitest";

import type { AdaptiveQuizTurn, TaskOutcomeEvent } from "./domain";
import {
  authorityOfTurn,
  consecutiveExecutionFailedCount,
  consecutiveExecutionFailedForTask,
  effectiveTurns,
  firstQualifyingInPhase,
  isLoopClosed,
  isQualifyingRetrieval,
  loopClosureEvidence,
  supersededTurnIds,
  verificationEvidenceStatusFor,
} from "./evidencePolicy";
import { closedLoopV2Fixtures } from "./learningLoopFixtures";

const [initialTurn, postJudgmentTurn] = closedLoopV2Fixtures({ loop: "closed" }).turns;

const turn = (overrides: Partial<AdaptiveQuizTurn>): AdaptiveQuizTurn => ({
  ...structuredClone(initialTurn),
  ...overrides,
});

const event = (overrides: Partial<TaskOutcomeEvent>): TaskOutcomeEvent => ({
  id: "event-x",
  taskId: "task-v2-1",
  decisionBlockId: initialTurn.decisionBlockId,
  recordId: initialTurn.recordId,
  contentVersion: 1,
  kind: "answer-assessment",
  occurredAt: "2026-09-15T08:00:00.000Z",
  idempotencyKey: "event-x",
  createdAt: "2026-09-15T08:00:00.000Z",
  updatedAt: "2026-09-15T08:00:00.000Z",
  ...overrides,
});

describe("evidencePolicy qualifying retrieval", () => {
  it("accepts a normal answered turn", () => {
    expect(isQualifyingRetrieval(initialTurn)).toBe(true);
  });

  it("rejects skipped, invalid, unreliable and empty answers", () => {
    expect(isQualifyingRetrieval(turn({ answerText: "[skipped]" }))).toBe(false);
    expect(isQualifyingRetrieval(turn({ status: "invalid" }))).toBe(false);
    expect(isQualifyingRetrieval(turn({ assessment: "unreliable" }))).toBe(false);
    expect(isQualifyingRetrieval(turn({ answerText: "   " }))).toBe(false);
    expect(isQualifyingRetrieval(turn({ status: "displayed", answerText: undefined }))).toBe(false);
  });

  it("still qualifies an assisted retrieval, because the learner did retrieve", () => {
    expect(isQualifyingRetrieval(turn({ independenceStatus: "assisted" }))).toBe(true);
  });
});

describe("evidencePolicy authority comes from mechanism and origin together", () => {
  it("treats AI evaluation as provisional no matter how the fields are named", () => {
    expect(authorityOfTurn(turn({ judgmentMechanism: "ai-evaluation", referenceOrigin: "ai-generated" }))).toBe("provisional");
    expect(authorityOfTurn(turn({ judgmentMechanism: "ai-evaluation", referenceOrigin: "official" }))).toBe("provisional");
  });

  it("refuses to upgrade a deterministic check running on an AI-generated answer", () => {
    expect(authorityOfTurn(turn({ judgmentMechanism: "deterministic-check", referenceOrigin: "ai-generated" }))).toBe("provisional");
    expect(authorityOfTurn(turn({ judgmentMechanism: "deterministic-check", referenceOrigin: "none" }))).toBe("provisional");
  });

  it("grants objective authority only for a trusted reference", () => {
    expect(authorityOfTurn(turn({ judgmentMechanism: "reference-lookup", referenceOrigin: "official" }))).toBe("objective");
    expect(authorityOfTurn(turn({ judgmentMechanism: "deterministic-check", referenceOrigin: "source-material" }))).toBe("objective");
    expect(authorityOfTurn(turn({ judgmentMechanism: "human-review", referenceOrigin: "user-authored" }))).toBe("objective");
  });

  it("gives self-report no evidentiary value and missing fields none either", () => {
    expect(authorityOfTurn(turn({ judgmentMechanism: "self-report", referenceOrigin: "user-authored" }))).toBe("none");
    expect(authorityOfTurn(turn({ judgmentMechanism: undefined }))).toBe("none");
  });
});

describe("evidencePolicy effective evidence", () => {
  it("produces the same result for any input ordering", () => {
    const events = [
      event({ id: "supersede", kind: "evidence-superseded", supersededTurnId: postJudgmentTurn.id }),
    ];
    const forward = effectiveTurns({ turns: [initialTurn, postJudgmentTurn], events });
    const backward = effectiveTurns({ turns: [postJudgmentTurn, initialTurn], events: [...events].reverse() });
    expect(forward.map((item) => item.id).sort()).toEqual(backward.map((item) => item.id).sort());
    expect(forward.map((item) => item.id)).toEqual([initialTurn.id]);
  });

  it("retires superseded turns without deleting the audit trail", () => {
    const events = [event({ id: "s1", kind: "evidence-superseded", supersededTurnId: initialTurn.id })];
    expect([...supersededTurnIds(events)]).toEqual([initialTurn.id]);
    expect(effectiveTurns({ turns: [initialTurn, postJudgmentTurn], events }).map((item) => item.id))
      .toEqual([postJudgmentTurn.id]);
  });
});

describe("evidencePolicy loop closure", () => {
  it("closes the loop only with both phases present in order", () => {
    const closed = loopClosureEvidence({ turns: [initialTurn, postJudgmentTurn], events: [] });
    expect(closed?.initial.id).toBe(initialTurn.id);
    expect(closed?.postJudgment.id).toBe(postJudgmentTurn.id);
    expect(isLoopClosed({ turns: [initialTurn, postJudgmentTurn], events: [] })).toBe(true);
  });

  it("refuses completion when only the initial retrieval happened, even if correct", () => {
    expect(isLoopClosed({ turns: [turn({ phase: "initial", assessment: "correct" })], events: [] })).toBe(false);
    expect(loopClosureEvidence({ turns: [turn({ phase: "initial" })], events: [] })).toBeNull();
  });

  it("refuses completion when the post-judgment attempt was skipped", () => {
    expect(isLoopClosed({
      turns: [initialTurn, turn({ id: "post", sequence: 2, phase: "post-judgment", answerText: "[skipped]", assessment: "unreliable" })],
      events: [],
    })).toBe(false);
  });

  it("refuses completion when the post-judgment evidence was superseded", () => {
    expect(isLoopClosed({
      turns: [initialTurn, postJudgmentTurn],
      events: [event({ id: "s2", kind: "evidence-superseded", supersededTurnId: postJudgmentTurn.id })],
    })).toBe(false);
  });

  it("ignores delayed phases for immediate completion", () => {
    expect(isLoopClosed({
      turns: [turn({ id: "d1", sequence: 1, phase: "delayed-first" }), turn({ id: "d2", sequence: 2, phase: "delayed-remediation" })],
      events: [],
    })).toBe(false);
  });

  it("picks the earliest qualifying retrieval in each phase", () => {
    const turns = [
      turn({ id: "i1", sequence: 1, phase: "initial" }),
      turn({ id: "i2", sequence: 2, phase: "initial" }),
      turn({ id: "p1", sequence: 3, phase: "post-judgment" }),
    ];
    expect(firstQualifyingInPhase(turns, "initial")?.id).toBe("i1");
    expect(firstQualifyingInPhase(turns, "post-judgment")?.id).toBe("p1");
  });
});

describe("evidencePolicy cross-task isolation", () => {
  // The bug this guards: turns and events were pooled across every task in the
  // block, so one task's post-judgment retrieval satisfied another task's
  // completion gate. The loop is a property of one task's history.
  const otherTaskInitial = turn({ id: "other-initial", taskId: "task-v2-OTHER", sequence: 1, phase: "initial" });
  const otherTaskPost = turn({ id: "other-post", taskId: "task-v2-OTHER", sequence: 2, phase: "post-judgment" });

  it("does not close a task's loop with another task's post-judgment retrieval", () => {
    const turns = [turn({ id: "mine-initial", taskId: "task-v2-MINE", sequence: 1, phase: "initial" }), otherTaskPost];
    expect(isLoopClosed({ turns, events: [] })).toBe(false);
    expect(isLoopClosed({ turns, events: [], taskId: "task-v2-MINE" })).toBe(false);
  });

  it("still closes the loop when both turns genuinely belong to the task", () => {
    const turns = [otherTaskInitial, otherTaskPost];
    expect(isLoopClosed({ turns, events: [], taskId: "task-v2-OTHER" })).toBe(true);
  });

  it("refuses to pair an initial turn with a post-judgment turn from another task even unscoped", () => {
    // A caller that forgets to scope must degrade to "not closed", never to a
    // fabricated closure built out of two different tasks' halves.
    const turns = [
      turn({ id: "a-initial", taskId: "task-A", sequence: 1, phase: "initial" }),
      turn({ id: "b-post", taskId: "task-B", sequence: 2, phase: "post-judgment" }),
    ];
    expect(loopClosureEvidence({ turns, events: [] })).toBeNull();
  });

  it("keeps the anti-self-esteem streak inside one task", () => {
    const events = [
      event({ id: "s1", taskId: "task-A", kind: "intervention-selected", interventionPath: "execution-failed", occurredAt: "2026-09-15T08:01:00.000Z" }),
      event({ id: "s2", taskId: "task-A", kind: "intervention-selected", interventionPath: "execution-failed", occurredAt: "2026-09-15T08:02:00.000Z" }),
      // A different target's choice must not extend task-A's streak...
      event({ id: "s3", taskId: "task-B", kind: "intervention-selected", interventionPath: "execution-failed", occurredAt: "2026-09-15T08:03:00.000Z" }),
    ];
    expect(consecutiveExecutionFailedForTask(events, "task-A")).toBe(2);
    expect(consecutiveExecutionFailedForTask(events, "task-B")).toBe(1);
  });

  it("does not let another task's choice reset a genuine streak", () => {
    const events = [
      event({ id: "s1", taskId: "task-A", kind: "intervention-selected", interventionPath: "execution-failed", occurredAt: "2026-09-15T08:01:00.000Z" }),
      // task-B picking a different path used to reset task-A's streak to zero.
      event({ id: "s2", taskId: "task-B", kind: "intervention-selected", interventionPath: "confused", occurredAt: "2026-09-15T08:02:00.000Z" }),
      event({ id: "s3", taskId: "task-A", kind: "intervention-selected", interventionPath: "execution-failed", occurredAt: "2026-09-15T08:03:00.000Z" }),
    ];
    expect(consecutiveExecutionFailedForTask(events, "task-A")).toBe(2);
  });
});

describe("evidencePolicy anti-self-esteem rule", () => {
  const selection = (index: number, path: "not-formed" | "confused" | "execution-failed") => event({
    id: `sel-${index}`,
    kind: "intervention-selected",
    interventionPath: path,
    occurredAt: `2026-09-15T08:0${index}:00.000Z`,
  });

  it("counts a consecutive execution-failed streak regardless of input order", () => {
    const events = [selection(1, "execution-failed"), selection(2, "execution-failed")];
    expect(consecutiveExecutionFailedCount(events)).toBe(2);
    expect(consecutiveExecutionFailedCount([...events].reverse())).toBe(2);
  });

  it("resets the streak when another action is chosen", () => {
    expect(consecutiveExecutionFailedCount([
      selection(1, "execution-failed"),
      selection(2, "confused"),
      selection(3, "execution-failed"),
    ])).toBe(1);
  });

  it("returns zero when the learner never chose that action", () => {
    expect(consecutiveExecutionFailedCount([selection(1, "not-formed")])).toBe(0);
  });
});

describe("evidencePolicy delayed verification status", () => {
  it("only grants objective pass to authoritative independent evidence", () => {
    expect(verificationEvidenceStatusFor(turn({
      phase: "delayed-first",
      independenceStatus: "independent",
      judgmentMechanism: "reference-lookup",
      referenceOrigin: "official",
      assessment: "correct",
    }))).toBe("objective-pass");
  });

  it("keeps an AI-graded correct answer provisional", () => {
    expect(verificationEvidenceStatusFor(turn({
      phase: "delayed-first",
      independenceStatus: "independent",
      assessment: "correct",
    }))).toBe("provisional-pass");
  });

  it("excludes assisted, duplicate, off-form and missing attempts", () => {
    expect(verificationEvidenceStatusFor(turn({ phase: "delayed-first", independenceStatus: "assisted" }))).toBe("ineligible");
    expect(verificationEvidenceStatusFor(turn({ phase: "delayed-first", independenceStatus: "independent", variantEligibility: "duplicate" }))).toBe("ineligible");
    expect(verificationEvidenceStatusFor(turn({ phase: "delayed-first", independenceStatus: "independent", variantEligibility: "uncertain" }))).toBe("ineligible");
    expect(verificationEvidenceStatusFor(turn({ phase: "delayed-first", independenceStatus: "independent", targetFormStatus: "training-form" }))).toBe("ineligible");
    expect(verificationEvidenceStatusFor(turn({ phase: "delayed-first", independenceStatus: "independent", judgmentMechanism: undefined }))).toBe("ineligible");
    expect(verificationEvidenceStatusFor(undefined)).toBe("ineligible");
  });

  it("records an AI-graded failure as provisional rather than objective", () => {
    expect(verificationEvidenceStatusFor(turn({
      phase: "delayed-first",
      independenceStatus: "independent",
      judgmentMechanism: "ai-evaluation",
      referenceOrigin: "ai-generated",
      assessment: "incorrect",
    }))).toBe("provisional-fail");
  });
});
