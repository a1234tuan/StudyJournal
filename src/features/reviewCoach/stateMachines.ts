import type {
  AdaptiveQuizTurnStatus,
  AdaptiveReviewTaskStatus,
  AnalysisBatchStatus,
  AnalysisQueueStatus,
  DelayedVerificationStatus,
  FeedbackInterpretationStatus,
} from "./domain";

export class ReviewCoachTransitionError extends Error {
  readonly machine: string;
  readonly from: string;
  readonly to: string;

  constructor(machine: string, from: string, to: string) {
    super(`Illegal ${machine} transition: ${from} -> ${to}`);
    this.name = "ReviewCoachTransitionError";
    this.machine = machine;
    this.from = from;
    this.to = to;
  }
}

const transition = <T extends string>(
  machine: string,
  allowed: Readonly<Record<T, readonly T[]>>,
  from: T,
  to: T,
): T => {
  if (from === to || allowed[from].includes(to)) return to;
  throw new ReviewCoachTransitionError(machine, from, to);
};

const interpretationTransitions: Readonly<Record<FeedbackInterpretationStatus, readonly FeedbackInterpretationStatus[]>> = {
  pending: ["running", "superseded"],
  running: ["pending", "succeeded", "insufficient-context", "failed", "superseded"],
  succeeded: ["superseded"],
  "insufficient-context": ["pending", "succeeded", "superseded"],
  failed: ["pending", "succeeded", "superseded"],
  superseded: [],
};

const queueTransitions: Readonly<Record<AnalysisQueueStatus, readonly AnalysisQueueStatus[]>> = {
  eligible: ["excluded", "batched", "stale", "deleted"],
  excluded: ["eligible", "stale", "deleted"],
  batched: ["eligible", "consumed", "stale", "deleted"],
  consumed: ["eligible", "stale", "deleted"],
  stale: ["deleted"],
  deleted: [],
};

const batchTransitions: Readonly<Record<AnalysisBatchStatus, readonly AnalysisBatchStatus[]>> = {
  draft: ["confirmed", "cancelled", "stale"],
  confirmed: ["running", "cancelled", "stale"],
  running: ["confirmed", "succeeded", "partial", "failed", "cancelled", "stale"],
  succeeded: ["stale"],
  partial: ["stale"],
  failed: [],
  cancelled: [],
  stale: [],
};

const taskTransitions: Readonly<Record<AdaptiveReviewTaskStatus, readonly AdaptiveReviewTaskStatus[]>> = {
  waiting: ["current", "deferred", "abandoned", "stale", "deleted"],
  current: ["in-progress", "waiting", "deferred", "abandoned", "stale", "deleted"],
  "in-progress": ["waiting", "deferred", "completed", "not-achieved", "invalid", "abandoned", "stale"],
  deferred: ["waiting", "current", "abandoned", "stale", "deleted"],
  completed: ["deleted"],
  "not-achieved": ["deleted"],
  invalid: ["deleted"],
  abandoned: ["deleted"],
  stale: ["deleted"],
  deleted: [],
};

const quizTurnTransitions: Readonly<Record<AdaptiveQuizTurnStatus, readonly AdaptiveQuizTurnStatus[]>> = {
  displayed: ["answered", "invalid"],
  answered: ["invalid"],
  invalid: [],
};

const verificationTransitions: Readonly<Record<DelayedVerificationStatus, readonly DelayedVerificationStatus[]>> = {
  scheduled: ["eligible", "cancelled", "stale"],
  eligible: ["queued", "cancelled", "missed", "stale"],
  queued: ["in-progress", "eligible", "cancelled", "missed", "stale"],
  "in-progress": ["completed", "eligible", "cancelled", "missed", "stale"],
  // Terminal on purpose. A verification whose evidence stayed provisional is
  // still "completed" as an *action*; that it must be checked again is recorded
  // on the row (`nextVerificationDueAt` / `concludedAt`) and expressed as a new
  // task, never by moving this status backwards. Re-opening it through the state
  // machine would also let a v1 completed verification be un-completed.
  completed: [],
  missed: ["eligible", "cancelled", "stale"],
  cancelled: [],
  stale: [],
};

export const transitionFeedbackStatus = (from: "active" | "deleted", to: "active" | "deleted") => {
  if (from === to || (from === "active" && to === "deleted")) return to;
  throw new ReviewCoachTransitionError("feedback", from, to);
};

export const transitionFeedbackInterpretation = (from: FeedbackInterpretationStatus, to: FeedbackInterpretationStatus) =>
  transition("feedback-interpretation", interpretationTransitions, from, to);

export const transitionAnalysisQueueItem = (from: AnalysisQueueStatus, to: AnalysisQueueStatus) =>
  transition("analysis-queue", queueTransitions, from, to);

export const transitionAnalysisBatch = (from: AnalysisBatchStatus, to: AnalysisBatchStatus) =>
  transition("analysis-batch", batchTransitions, from, to);

export const transitionAdaptiveReviewTask = (from: AdaptiveReviewTaskStatus, to: AdaptiveReviewTaskStatus) =>
  transition("adaptive-review-task", taskTransitions, from, to);

export const transitionAdaptiveQuizTurn = (from: AdaptiveQuizTurnStatus, to: AdaptiveQuizTurnStatus) =>
  transition("adaptive-quiz-turn", quizTurnTransitions, from, to);

export const transitionDelayedVerification = (from: DelayedVerificationStatus, to: DelayedVerificationStatus) =>
  transition("delayed-verification", verificationTransitions, from, to);
