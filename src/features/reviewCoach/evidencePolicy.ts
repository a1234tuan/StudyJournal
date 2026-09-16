/**
 * Single source of truth for "which results count".
 *
 * Completion, scheduling, projection, verification and metrics must all call
 * this module. Any other module that decides for itself which results are valid
 * creates a drift risk, and the whole point of the evidence kernel is that the
 * rules live in exactly one place (dev plan section 4.2).
 *
 * Two ideas do the work:
 *
 * 1. **Validity** - was this a real retrieval attempt? Answered, not skipped,
 *    not invalid, not graded unreliable.
 *
 * 2. **Authority** - how much does the conclusion count? This is derived from
 *    `judgmentMechanism` AND `referenceOrigin` together, never from a single
 *    field and never from how the field is named:
 *
 *        reference-lookup / AI-generated  -> provisional, not objective
 *        deterministic-check / official   -> objective
 *        ai-evaluation (anything)         -> provisional
 *        self-report (anything)           -> no evidence at all
 *
 *    Deterministic comparison against an AI-authored expected answer is still
 *    provisional, because the reference itself is not authoritative.
 */

import {
  COMPLETION_PHASES,
  CLOSED_LOOP_V2_LOOP_VERSION,
} from "./learningLoopPolicy";
import { SKIPPED_ANSWER_TEXT } from "./replay";
import type {
  AdaptiveQuizTurn,
  DelayedVerification,
  EvidenceSupersedeReason,
  JudgmentMechanism,
  ReferenceOrigin,
  RetrievalPhase,
  TaskOutcomeEvent,
} from "./domain";

export type EvidenceAuthority = "objective" | "provisional" | "none";

/** Reasons a turn cannot count as a retrieval at all. */
export const isSkippedTurn = (turn: AdaptiveQuizTurn): boolean => (
  turn.answerText === SKIPPED_ANSWER_TEXT || turn.assessment === "unreliable" || turn.status === "invalid"
);

/**
 * A qualifying retrieval: the learner actually attempted to retrieve.
 *
 * Assisted retrievals still qualify for closing the immediate loop - the learner
 * did retrieve, with help - but they are not independent evidence, so they
 * cannot produce an objective or provisional pass on their own.
 */
export const isQualifyingRetrieval = (turn: AdaptiveQuizTurn): boolean => {
  if (isSkippedTurn(turn)) return false;
  if (turn.status !== "answered") return false;
  if (!turn.answerText || turn.answerText.trim().length === 0) return false;
  return turn.assessment !== undefined;
};

/** True when the learner retrieved without hints, materials or AI completion. */
export const isIndependentRetrieval = (turn: AdaptiveQuizTurn): boolean => (
  turn.independenceStatus === "independent"
);

/**
 * Authority from mechanism + origin. Both fields are required to upgrade above
 * provisional; a missing field means provisional at best.
 */
export const authorityOfTurn = (turn: AdaptiveQuizTurn): EvidenceAuthority => {
  const mechanism: JudgmentMechanism | undefined = turn.judgmentMechanism;
  const origin: ReferenceOrigin | undefined = turn.referenceOrigin;
  if (!mechanism) return "none";
  if (mechanism === "self-report") return "none";
  if (mechanism === "ai-evaluation") return "provisional";
  // Only non-AI references can carry objective authority.
  const authoritativeOrigin = origin === "official" || origin === "source-material" || origin === "user-authored";
  if (!authoritativeOrigin) return "provisional";
  if (mechanism === "reference-lookup" || mechanism === "deterministic-check" || mechanism === "human-review") {
    return "objective";
  }
  return "provisional";
};

/**
 * Turn ids retired by `evidence-superseded` events.
 *
 * Append-only: a correction never deletes the original judgment, it retires it,
 * so the audit trail survives and replay stays deterministic.
 */
export const supersededTurnIds = (events: readonly TaskOutcomeEvent[]): Set<string> => {
  const ids = new Set<string>();
  for (const event of events) {
    if (event.kind === "evidence-superseded" && event.supersededTurnId) ids.add(event.supersededTurnId);
  }
  return ids;
};

export const supersededEventIds = (events: readonly TaskOutcomeEvent[]): Set<string> => {
  const ids = new Set<string>();
  for (const event of events) {
    if (event.kind === "evidence-superseded" && event.supersededEventId) ids.add(event.supersededEventId);
  }
  return ids;
};

export interface EvidenceQuery {
  turns: readonly AdaptiveQuizTurn[];
  events: readonly TaskOutcomeEvent[];
  /**
   * Restricts the query to one task.
   *
   * Every caller that answers a per-task question must set this. A loop is a
   * property of a single task's history: pooling turns across tasks let a
   * different task's `post-judgment` turn close *this* task's loop, which
   * silently satisfied the completion gate for a task that never retrieved
   * after its own judgment.
   */
  taskId?: string;
}

/** Narrows a query to one task, keeping every other field intact. */
export const scopeEvidenceToTask = (query: EvidenceQuery, taskId: string): EvidenceQuery => ({
  turns: query.turns.filter((turn) => turn.taskId === taskId),
  events: query.events.filter((event) => event.taskId === taskId),
  taskId,
});

/**
 * Turns that may drive completion or scheduling.
 *
 * Order does not matter: superseded turns are removed by id, so shuffling the
 * inputs cannot change the answer.
 */
export const effectiveTurns = ({ turns, events, taskId }: EvidenceQuery): AdaptiveQuizTurn[] => {
  const retired = supersededTurnIds(events);
  const invalidTurnIds = new Set(
    events
      .filter((event) => event.kind === "task-disposition" && event.disposition === "question-invalid" && event.turnId)
      .map((event) => event.turnId as string),
  );
  const skippedInvalid = new Set<string>();
  for (const event of events) {
    if (event.kind === "answer-assessment") {
      const superseded = event.supersededTurnId;
      if (superseded) skippedInvalid.add(superseded);
    }
  }
  return turns.filter((turn) => (
    !retired.has(turn.id)
    && !invalidTurnIds.has(turn.id)
    && !skippedInvalid.has(turn.id)
    && (taskId === undefined || turn.taskId === taskId)
  ));
};

/** The earliest qualifying retrieval in a given phase, in display order. */
export const firstQualifyingInPhase = (
  turns: readonly AdaptiveQuizTurn[],
  phase: RetrievalPhase,
): AdaptiveQuizTurn | undefined => (
  [...turns]
    .filter((turn) => turn.phase === phase && isQualifyingRetrieval(turn))
    .sort((left, right) => left.sequence - right.sequence)[0]
);

export interface LoopClosureEvidence {
  initial: AdaptiveQuizTurn;
  postJudgment: AdaptiveQuizTurn;
}

/**
 * Whether a v2 immediate loop is closed.
 *
 * The whole milestone reduces to this: one qualifying retrieval before the
 * judgment and one after it, **in the same task**. An initially correct answer
 * does not excuse the learner from retrieving again - feedback has to be
 * followed by retrieval or the loop was never closed.
 *
 * When the query names a task, both retrievals must belong to it. Callers that
 * legitimately ask the whole-snapshot question (an audit sweep) may omit
 * `taskId`, and then the pairing rule below additionally requires both turns to
 * share a task, so a pooled snapshot can never fabricate a closure either.
 */
export const loopClosureEvidence = (query: EvidenceQuery): LoopClosureEvidence | null => {
  const turns = effectiveTurns(query);
  const initial = firstQualifyingInPhase(turns, COMPLETION_PHASES[0]);
  const postJudgment = firstQualifyingInPhase(turns, COMPLETION_PHASES[1]);
  if (!initial || !postJudgment) return null;
  if (postJudgment.sequence <= initial.sequence) return null;
  // Cross-task pairing is never a closure. This is the safety net for a caller
  // that forgot to scope: it degrades to "not closed" instead of answering yes.
  if (initial.taskId !== postJudgment.taskId) return null;
  return { initial, postJudgment };
};

export const isLoopClosed = (query: EvidenceQuery): boolean => loopClosureEvidence(query) !== null;

/**
 * Terminal dispositions that end a task without completing it. Used to make sure
 * a budget-exhausted deferral is not mistaken for a completion.
 */
export const isNonCompletionDisposition = (event: TaskOutcomeEvent): boolean => (
  event.kind === "task-disposition"
  && (event.disposition === "deferred" || event.disposition === "abandoned" || event.disposition === "question-invalid")
);

/**
 * How many times the learner has chosen the "I can but did not produce it"
 * action for this target. Two in a row force the third attempt into the
 * material-backed path (constitution art. 6, the anti-self-esteem rule).
 *
 * The streak is per target, so `events` must already be scoped to one task.
 * `consecutiveExecutionFailedForTask` is the scoped helper; passing a whole
 * snapshot here would let an unrelated task reset (or extend) the streak.
 */
export const consecutiveExecutionFailedCount = (events: readonly TaskOutcomeEvent[]): number => {
  const selections = events
    .filter((event) => event.kind === "intervention-selected" && event.interventionPath)
    .sort((left, right) => left.occurredAt.localeCompare(right.occurredAt) || left.id.localeCompare(right.id));
  let streak = 0;
  for (const event of selections) {
    streak = event.interventionPath === "execution-failed" ? streak + 1 : 0;
  }
  return streak;
};

/**
 * Task-scoped view of the anti-self-esteem streak.
 *
 * A "cannot help but not yet produce it" pattern is a property of one target's
 * history. Pooling tasks made the counter trivially wrong in both directions:
 * another task's choice reset a genuine streak, and another task's streak
 * forced the material-backed path on a task that never earned it.
 */
export const consecutiveExecutionFailedForTask = (
  events: readonly TaskOutcomeEvent[],
  taskId: string,
): number => consecutiveExecutionFailedCount(events.filter((event) => event.taskId === taskId));

export const LOOP_VERSION_V2 = CLOSED_LOOP_V2_LOOP_VERSION;

export type { EvidenceSupersedeReason };

/**
 * The only evidence statuses that may produce a durable `retained` / `decayed`
 * conclusion about a decision block.
 *
 * Constitution art. 9: an AI-only judgment can never become an irreversible
 * "retained" fact. `provisional-*` statuses therefore schedule further
 * verification instead of concluding anything. This list is the single place
 * that decision is encoded; projections, metrics and replan all read it so a
 * later policy change cannot silently reopen the hole in one caller only.
 */
export const CONCLUSION_BEARING_EVIDENCE_STATUSES: readonly NonNullable<DelayedVerification["evidenceStatus"]>[] = [
  "objective-pass",
  "objective-fail",
];

/**
 * The durable conclusion a completed verification may write, or `undefined`
 * when the evidence was only provisional and must not conclude anything.
 *
 * `verificationOutcome` keeps its legacy `"retained" | "decayed"` shape for v1
 * rows and older readers, but only objective evidence may fill it. A
 * provisional result returns `undefined`, which the projection treats as
 * "still pending verification".
 */
export const conclusionOutcomeForEvidence = (
  evidenceStatus: DelayedVerification["evidenceStatus"],
): "retained" | "decayed" | undefined => {
  if (evidenceStatus === "objective-pass") return "retained";
  if (evidenceStatus === "objective-fail") return "decayed";
  return undefined;
};

/** True when a completed verification carries a conclusion that may set block state. */
export const hasDurableConclusion = (verification: DelayedVerification): boolean => (
  verification.status === "completed"
  && (
    verification.evidenceStatus !== undefined
      ? (CONCLUSION_BEARING_EVIDENCE_STATUSES as readonly string[]).includes(verification.evidenceStatus)
      // Legacy v1 rows predate `evidenceStatus`. They were written by the
      // subjective v1 scheduler, so their own recorded outcome is all we have.
      : verification.verificationOutcome === "retained" || verification.verificationOutcome === "decayed"
  )
);

/**
 * Whether completing this verification settles the target, or leaves it open.
 *
 * This is the "verification action completed, evidence conclusion did not"
 * distinction the dev plan names (section 6.3, and the M4 rule at "provisional
 * pass 继续安排未来验证，不写 retained").
 *
 * A provisional result is not a conclusion - the judge was a model reading its
 * own criteria - so closing the verification row must not mean the *chain* is
 * over. The row closes because the learner did submit an attempt; a fresh
 * verification is opened because nothing was settled.
 *
 * Only objective evidence settles: an objective pass or fail is a real result,
 * and re-asking the same target afterwards would be busywork rather than
 * verification.
 */
export const settledByVerification = (verification: DelayedVerification): boolean => (
  verification.evidenceStatus === "objective-pass" || verification.evidenceStatus === "objective-fail"
);

/** True when a completed verification should schedule its own successor. */
export const continuesVerificationChain = (verification: DelayedVerification): boolean => (
  verification.status === "completed"
  && verification.loopVersion === CLOSED_LOOP_V2_LOOP_VERSION
  && (verification.evidenceStatus === "provisional-pass" || verification.evidenceStatus === "provisional-fail")
);


/** The durable conclusion of a completed verification, if it has one. */
export const durableConclusionOf = (verification: DelayedVerification): "retained" | "decayed" | undefined => {
  if (!hasDurableConclusion(verification)) return undefined;
  if (verification.evidenceStatus === "objective-fail") return "decayed";
  if (verification.evidenceStatus === "objective-pass") return "retained";
  return verification.verificationOutcome === "decayed" ? "decayed" : "retained";
};

/** Delayed verification evidence status, derived from the locked first attempt. */
export const verificationEvidenceStatusFor = (
  turn: AdaptiveQuizTurn | undefined,
): DelayedVerification["evidenceStatus"] => {
  if (!turn || !isQualifyingRetrieval(turn)) return "ineligible";
  // Assisted, duplicated or off-target attempts are not acceptable verification
  // evidence even if the answer itself was right.
  if (turn.independenceStatus !== "independent") return "ineligible";
  if (turn.variantEligibility !== undefined && turn.variantEligibility !== "eligible") return "ineligible";
  if (turn.targetFormStatus !== undefined && turn.targetFormStatus !== "target-form") return "ineligible";
  const authority = authorityOfTurn(turn);
  if (authority === "none") return "ineligible";
  const correct = turn.assessment === "correct";
  if (authority === "objective") return correct ? "objective-pass" : "objective-fail";
  return correct ? "provisional-pass" : "provisional-fail";
};
