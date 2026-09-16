import type { AdaptiveQuizTurn, DelayedVerification } from "./domain";
import { authorityOfTurn, isIndependentRetrieval, isQualifyingRetrieval } from "./evidencePolicy";

export const DELAYED_VERIFICATION_STRATEGY_VERSION = "delayed-verification-v1";
/** v2 adds independence, authority and prior-evidence inputs the v1 window ignored. */
export const DELAYED_VERIFICATION_STRATEGY_VERSION_V2 = "delayed-verification-v2";

const HOUR_MS = 60 * 60 * 1000;

const addHours = (stamp: string, hours: number) => new Date(Date.parse(stamp) + hours * HOUR_MS).toISOString();

export interface DelayedVerificationSchedule {
  verificationEligibleAt: string;
  verificationDueAt: string;
  strategyVersion: string;
}

export const calculateDelayedVerificationSchedule = (input: {
  completedAt: string;
  subjectiveOutcome: "mastered" | "needs-consolidation";
  answeredTurns: readonly AdaptiveQuizTurn[];
  priorVerifications: readonly DelayedVerification[];
}): DelayedVerificationSchedule => {
  const latestAnswer = [...input.answeredTurns]
    .filter((turn) => turn.status === "answered" && turn.answerText !== "[skipped]")
    .sort((left, right) => left.sequence - right.sequence)
    .at(-1);
  const hinted = input.answeredTurns.some((turn) => turn.hintsUsed.length > 0);
  const previouslyDecayed = input.priorVerifications.some((item) => item.verificationOutcome === "decayed");

  let eligibleHours = input.subjectiveOutcome === "needs-consolidation" ? 8 : 24;
  let dueHours = input.subjectiveOutcome === "needs-consolidation" ? 24 : 72;
  if (latestAnswer?.assessment === "incorrect") {
    eligibleHours = 6;
    dueHours = 18;
  } else if (hinted || latestAnswer?.assessment === "partial" || latestAnswer?.assessment === "unreliable") {
    eligibleHours = Math.min(eligibleHours, 12);
    dueHours = Math.min(dueHours, 36);
  }
  if (previouslyDecayed) {
    eligibleHours = Math.min(eligibleHours, 6);
    dueHours = Math.min(dueHours, 18);
  }

  return {
    verificationEligibleAt: addHours(input.completedAt, eligibleHours),
    verificationDueAt: addHours(input.completedAt, dueHours),
    strategyVersion: DELAYED_VERIFICATION_STRATEGY_VERSION,
  };
};

/**
 * v2 scheduling.
 *
 * The v1 signature took a `subjectiveOutcome` and used it to choose between the
 * 8/24 and 24/72 hour windows. That made the learner's opinion of their own
 * performance the input to the system's plan (dev plan sections 1.1 and 6.2).
 *
 * v2 takes only what was actually observed in the retrieval: whether it was
 * independent, how it was graded, and whether the same target has already
 * decayed. No subjective outcome, no confidence, no UI choice.
 */
export const calculateClosedLoopVerificationSchedule = (input: {
  completedAt: string;
  /** The qualifying post-judgment retrieval that closed the loop. */
  postJudgmentTurn: AdaptiveQuizTurn;
  answeredTurns: readonly AdaptiveQuizTurn[];
  priorVerifications: readonly DelayedVerification[];
}): DelayedVerificationSchedule => {
  const { postJudgmentTurn } = input;
  const assisted = !isIndependentRetrieval(postJudgmentTurn)
    || input.answeredTurns.some((turn) => turn.phase === "post-judgment" && !isIndependentRetrieval(turn));
  const hinted = postJudgmentTurn.hintsUsed.length > 0;
  const authority = authorityOfTurn(postJudgmentTurn);
  const provisionalFailure = input.priorVerifications.some((item) => (
    item.status === "completed" && (item.evidenceStatus === "provisional-fail" || item.evidenceStatus === "objective-fail")
  ));

  // Conservative first defaults, recorded as such. Not claimed to be personal
  // optimum; the 30-day review decides whether they are worth changing.
  let eligibleHours = 24;
  let dueHours = 72;
  if (postJudgmentTurn.assessment === "incorrect") {
    eligibleHours = 6;
    dueHours = 18;
  } else if (postJudgmentTurn.assessment === "partial" || assisted || hinted) {
    eligibleHours = 8;
    dueHours = 24;
  }
  if (authority === "provisional") {
    // A provisional pass needs to be re-checked sooner than a settled one.
    eligibleHours = Math.min(eligibleHours, 12);
    dueHours = Math.min(dueHours, 36);
  }
  if (provisionalFailure) {
    eligibleHours = Math.min(eligibleHours, 6);
    dueHours = Math.min(dueHours, 18);
  }

  return {
    verificationEligibleAt: addHours(input.completedAt, eligibleHours),
    verificationDueAt: addHours(input.completedAt, dueHours),
    strategyVersion: DELAYED_VERIFICATION_STRATEGY_VERSION_V2,
  };
};

/**
 * The window for a *follow-up* verification, opened because the previous one
 * produced provisional evidence and settled nothing.
 *
 * The window is measured from this completion, not inherited from the previous
 * verification: the learner has just been re-checked, so reusing the old
 * `verificationDueAt` would make the successor immediately overdue and turn the
 * chain into a tight loop rather than a delayed re-check.
 *
 * A history of provisional results shortens the next wait. Nothing has settled,
 * so the honest reading is "still uncertain" - which argues for checking again
 * sooner, not later. A repeated provisional failure is the strongest signal and
 * uses the shortest window, mirroring the initial schedule's rule.
 */
export const calculateVerificationFollowUpSchedule = (input: {
  completedAt: string;
  priorVerifications: readonly DelayedVerification[];
}): DelayedVerificationSchedule => {
  const provisionalFailures = input.priorVerifications.filter((item) => (
    item.status === "completed" && item.evidenceStatus === "provisional-fail"
  )).length;

  // Conservative defaults, same honest footing as the initial schedule: the
  // 30-day review decides whether they are worth changing.
  let eligibleHours = 12;
  let dueHours = 36;
  if (provisionalFailures > 0) {
    eligibleHours = 6;
    dueHours = 18;
  }

  return {
    verificationEligibleAt: addHours(input.completedAt, eligibleHours),
    verificationDueAt: addHours(input.completedAt, dueHours),
    strategyVersion: DELAYED_VERIFICATION_STRATEGY_VERSION_V2,
  };
};

/** True when the effective post-retrieval evidence permits opening a verification at all. */
export const qualifiesForVerification = (turn: AdaptiveQuizTurn): boolean => (
  isQualifyingRetrieval(turn) && turn.phase === "post-judgment"
);

export const isVerificationEligible = (verification: DelayedVerification, now: string) =>
  verification.status === "scheduled" && verification.verificationEligibleAt <= now;

export const isVerificationDue = (verification: DelayedVerification, now: string) =>
  ["eligible", "missed"].includes(verification.status) && verification.verificationDueAt <= now;

/**
 * An unsettled verification whose next check has come around.
 *
 * `status: "completed"` only means the learner submitted an attempt. When the
 * evidence stayed provisional (`concludedAt` unset) the target is still open, so
 * the verification is due again once `nextVerificationDueAt` passes. This is the
 * rule that keeps "AI-correct" from quietly ending the verification chain.
 */
export const isVerificationRecheckDue = (verification: DelayedVerification, now: string) => (
  verification.status === "completed"
  && verification.concludedAt === undefined
  && verification.nextVerificationDueAt !== undefined
  && verification.nextVerificationDueAt <= now
);
