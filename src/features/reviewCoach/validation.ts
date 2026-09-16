import type {
  AdaptiveReviewTaskStatus,
  AnalysisInputRef,
  DecisionBlock,
  ReviewCoachFormalSnapshot,
  SessionBlueprint,
  TaskOutcomeEvent,
  VersionedDecisionBlockRef,
} from "./domain";
import { isLoopClosed } from "./evidencePolicy";

export class ReviewCoachValidationError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "ReviewCoachValidationError";
    this.code = code;
  }
}

export const assertPositiveContentVersion = (value: number) => {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new ReviewCoachValidationError("invalid-content-version", "contentVersion must be a positive integer.");
  }
};

export const assertCurrentDecisionBlockRef = (
  block: DecisionBlock | undefined,
  ref: VersionedDecisionBlockRef,
) => {
  if (!block || block.deletedAt) {
    throw new ReviewCoachValidationError("dangling-decision-block", `Decision block ${ref.decisionBlockId} does not exist.`);
  }
  if (block.recordId !== ref.recordId) {
    throw new ReviewCoachValidationError("record-mismatch", `Decision block ${ref.decisionBlockId} belongs to another record.`);
  }
  if (block.contentVersion !== ref.contentVersion) {
    throw new ReviewCoachValidationError(
      "stale-content-version",
      `Decision block ${ref.decisionBlockId} is at version ${block.contentVersion}, not ${ref.contentVersion}.`,
    );
  }
};

const assertUnique = <T>(items: T[], keyOf: (item: T) => string, code: string) => {
  const seen = new Set<string>();
  for (const item of items) {
    const key = keyOf(item);
    if (seen.has(key)) throw new ReviewCoachValidationError(code, `Duplicate value: ${key}.`);
    seen.add(key);
  }
};

const assertInputRef = (
  ref: AnalysisInputRef,
  snapshot: ReviewCoachFormalSnapshot,
  blocks: Map<string, DecisionBlock>,
  requireCurrent: boolean,
) => {
  const block = blocks.get(ref.decisionBlockId);
  if (!block || block.recordId !== ref.recordId || ref.contentVersion > block.contentVersion) {
    throw new ReviewCoachValidationError("dangling-decision-block", `Analysis input block ${ref.decisionBlockId} is missing or mismatched.`);
  }
  if (requireCurrent) assertCurrentDecisionBlockRef(block, ref);
  const queueItem = snapshot.analysisQueueItems.find((item) => item.id === ref.queueItemId);
  const feedback = snapshot.decisionBlockFeedback.find((item) => item.id === ref.feedbackId);
  if (!queueItem || queueItem.feedbackId !== ref.feedbackId) {
    throw new ReviewCoachValidationError("dangling-queue-item", `Analysis input ${ref.queueItemId} is missing or mismatched.`);
  }
  if (!feedback || feedback.decisionBlockId !== ref.decisionBlockId) {
    throw new ReviewCoachValidationError("dangling-feedback", `Analysis input feedback ${ref.feedbackId} is missing or mismatched.`);
  }
  if (ref.interpretationId && !snapshot.feedbackInterpretations.some((item) => item.id === ref.interpretationId && item.feedbackId === ref.feedbackId)) {
    throw new ReviewCoachValidationError("dangling-interpretation", `Interpretation ${ref.interpretationId} is missing or mismatched.`);
  }
};

export const isOpenTaskStatus = (status: AdaptiveReviewTaskStatus) =>
  status === "waiting" || status === "current" || status === "in-progress" || status === "deferred";

export const openTargetKeyFor = (ref: VersionedDecisionBlockRef) =>
  `${ref.decisionBlockId}:${ref.contentVersion}`;

export const assertTaskOutcomeShape = (event: TaskOutcomeEvent) => {
  /**
   * v2 adds two event kinds that carry no result category by design:
   *
   * - `intervention-selected` records a learner *action*, not a judgment;
   * - `evidence-superseded` records a *correction* to earlier evidence.
   *
   * Neither may carry an assessment, a disposition or a subjective outcome:
   * that is exactly the confusion the constitution forbids.
   */
  const carriesResultCategory = event.kind === "answer-assessment"
    || event.kind === "self-assessment"
    || event.kind === "task-disposition";
  const populated = [event.answerAssessment, event.subjectiveOutcome, event.disposition].filter((value) => value !== undefined);
  if (carriesResultCategory && populated.length !== 1) {
    throw new ReviewCoachValidationError("invalid-outcome-shape", "An outcome event must contain exactly one result category.");
  }
  if (event.kind === "answer-assessment" && !event.answerAssessment) {
    throw new ReviewCoachValidationError("invalid-outcome-shape", "Answer assessment event is missing answerAssessment.");
  }
  if (event.kind === "self-assessment" && !event.subjectiveOutcome) {
    throw new ReviewCoachValidationError("invalid-outcome-shape", "Self-assessment event is missing subjectiveOutcome.");
  }
  if (event.kind === "task-disposition" && !event.disposition) {
    throw new ReviewCoachValidationError("invalid-outcome-shape", "Task disposition event is missing disposition.");
  }
  if (event.kind === "intervention-selected") {
    if (!event.interventionPath) {
      throw new ReviewCoachValidationError("invalid-outcome-shape", "Intervention selection is missing its path.");
    }
    if (populated.length > 0) {
      throw new ReviewCoachValidationError("invalid-outcome-shape", "An intervention selection must not carry a result category.");
    }
  }
  if (event.kind === "evidence-superseded") {
    if (!event.supersededEventId && !event.supersededTurnId) {
      throw new ReviewCoachValidationError("invalid-outcome-shape", "A supersede event must name what it retires.");
    }
    if (!event.supersedeReason) {
      throw new ReviewCoachValidationError("invalid-outcome-shape", "A supersede event must state why evidence stopped counting.");
    }
    if (populated.length > 0) {
      throw new ReviewCoachValidationError("invalid-outcome-shape", "A supersede event must not carry a result category.");
    }
  }
};

export const assertBlueprintCapabilityWhitelist = (blueprint: SessionBlueprint) => {
  const supported = new Set(["continue", "hint", "explain", "worked-example", "prerequisite-check", "finish"]);
  if (blueprint.allowedStrategies.some((strategy) => !supported.has(strategy))) {
    throw new ReviewCoachValidationError("unsupported-blueprint-capability", "Blueprint contains an unsupported strategy.");
  }
  if (blueprint.branches.some((branch) => !supported.has(branch.nextStrategy))) {
    throw new ReviewCoachValidationError("unsupported-blueprint-capability", "Blueprint branch contains an unsupported strategy.");
  }
  const branchCases = new Set(blueprint.branches.map((branch) => branch.when));
  if (["correct", "partial", "incorrect", "skipped"].some((value) => !branchCases.has(value as never))) {
    throw new ReviewCoachValidationError("incomplete-blueprint-branches", "Blueprint must define all answer branches.");
  }
};

export const validateReviewCoachFormalSnapshot = (
  snapshot: ReviewCoachFormalSnapshot,
  recordIds?: ReadonlySet<string>,
) => {
  const allEntities: Array<{ id: string }> = [
    ...snapshot.decisionBlocks,
    ...snapshot.decisionBlockArchives,
    ...snapshot.decisionBlockFeedback,
    ...snapshot.feedbackInterpretations,
    ...snapshot.analysisQueueItems,
    ...snapshot.analysisBatches,
    ...snapshot.sessionBlueprints,
    ...snapshot.adaptiveReviewTasks,
    ...snapshot.adaptiveQuizTurns,
    ...snapshot.taskOutcomeEvents,
    ...snapshot.delayedVerifications,
    ...snapshot.aiRoleConfigs,
  ];
  assertUnique(allEntities, (item) => item.id, "duplicate-entity-id");
  const idempotentEntities: Array<{ idempotencyKey: string }> = [
    ...snapshot.decisionBlockArchives,
    ...snapshot.decisionBlockFeedback,
    ...snapshot.analysisBatches,
    ...snapshot.sessionBlueprints,
    ...snapshot.adaptiveReviewTasks,
    ...snapshot.adaptiveQuizTurns,
    ...snapshot.taskOutcomeEvents,
    ...snapshot.delayedVerifications,
  ];
  assertUnique(idempotentEntities, (item) => item.idempotencyKey, "duplicate-idempotency-key");
  assertUnique(snapshot.feedbackInterpretations, (item) => item.feedbackId, "duplicate-feedback-interpretation");
  assertUnique(snapshot.analysisQueueItems, (item) => item.feedbackId, "duplicate-analysis-queue-item");
  assertUnique(snapshot.adaptiveQuizTurns, (item) => `${item.taskId}:${item.sequence}`, "duplicate-quiz-turn-sequence");
  assertUnique(snapshot.delayedVerifications, (item) => item.sourceOutcomeEventId, "duplicate-delayed-verification");

  const blocks = new Map(snapshot.decisionBlocks.map((block) => [block.id, block]));
  for (const block of snapshot.decisionBlocks) {
    assertPositiveContentVersion(block.contentVersion);
    if (recordIds && !recordIds.has(block.recordId)) {
      throw new ReviewCoachValidationError("dangling-record", `Record ${block.recordId} does not exist.`);
    }
  }
  for (const archive of snapshot.decisionBlockArchives) {
    const block = blocks.get(archive.decisionBlockId);
    if (!block || block.recordId !== archive.recordId || archive.contentVersion > block.contentVersion) {
      throw new ReviewCoachValidationError("dangling-archive", `Archive ${archive.id} does not match its decision block.`);
    }
  }
  for (const feedback of snapshot.decisionBlockFeedback) {
    const block = blocks.get(feedback.decisionBlockId);
    if (!block || block.recordId !== feedback.recordId || feedback.contentVersion > block.contentVersion) {
      throw new ReviewCoachValidationError("dangling-feedback", `Feedback ${feedback.id} does not match its decision block.`);
    }
    if (!feedback.comment.trim()) throw new ReviewCoachValidationError("empty-feedback", `Feedback ${feedback.id} is empty.`);
  }
  for (const interpretation of snapshot.feedbackInterpretations) {
    const feedback = snapshot.decisionBlockFeedback.find((item) => item.id === interpretation.feedbackId);
    if (!feedback || feedback.decisionBlockId !== interpretation.decisionBlockId || feedback.contentVersion !== interpretation.contentVersion) {
      throw new ReviewCoachValidationError("dangling-interpretation", `Interpretation ${interpretation.id} does not match its feedback.`);
    }
    if (interpretation.confidence !== undefined && (interpretation.confidence < 0 || interpretation.confidence > 1)) {
      throw new ReviewCoachValidationError("invalid-confidence", `Interpretation ${interpretation.id} has invalid confidence.`);
    }
  }
  for (const queueItem of snapshot.analysisQueueItems) {
    const feedback = snapshot.decisionBlockFeedback.find((item) => item.id === queueItem.feedbackId);
    if (!feedback || feedback.decisionBlockId !== queueItem.decisionBlockId || feedback.contentVersion !== queueItem.contentVersion) {
      throw new ReviewCoachValidationError("dangling-queue-item", `Queue item ${queueItem.id} does not match its feedback.`);
    }
    if (queueItem.status !== "stale" && queueItem.status !== "deleted") {
      assertCurrentDecisionBlockRef(blocks.get(queueItem.decisionBlockId), queueItem);
    }
  }
  for (const batch of snapshot.analysisBatches) {
    const requireCurrent = !["failed", "cancelled", "stale"].includes(batch.status);
    batch.inputRefs.forEach((ref) => assertInputRef(ref, snapshot, blocks, requireCurrent));
    const partitionedRefs = batch.subBatches.flatMap((subBatch) => subBatch.inputRefs.map((ref) => ref.queueItemId));
    const expectedRefs = batch.inputRefs.map((ref) => ref.queueItemId);
    if (
      batch.inputRefs.length === 0 ||
      batch.subBatches.some((subBatch) => subBatch.inputRefs.length === 0 || new Set(subBatch.inputRefs.map((ref) => ref.decisionBlockId)).size > 3) ||
      partitionedRefs.length !== expectedRefs.length ||
      new Set(partitionedRefs).size !== partitionedRefs.length ||
      expectedRefs.some((id) => !partitionedRefs.includes(id))
    ) {
      throw new ReviewCoachValidationError("invalid-analysis-batch-size", `Analysis batch ${batch.id} has an invalid sub-batch size.`);
    }
  }
  for (const blueprint of snapshot.sessionBlueprints) {
    assertBlueprintCapabilityWhitelist(blueprint);
    if (blueprint.status !== "stale") assertCurrentDecisionBlockRef(blocks.get(blueprint.decisionBlockId), blueprint);
    if (!snapshot.analysisBatches.some((batch) => batch.id === blueprint.batchId)) {
      throw new ReviewCoachValidationError("dangling-analysis-batch", `Blueprint ${blueprint.id} has no analysis batch.`);
    }
    for (const evidence of blueprint.evidence) {
      const block = blocks.get(evidence.decisionBlockId);
      if (!block || block.recordId !== evidence.recordId || evidence.contentVersion > block.contentVersion) {
        throw new ReviewCoachValidationError("dangling-blueprint-evidence", `Blueprint ${blueprint.id} contains invalid evidence.`);
      }
    }
  }
  const blueprintById = new Map(snapshot.sessionBlueprints.map((item) => [item.id, item]));
  const openTargets = new Set<string>();
  let currentTasks = 0;
  for (const task of snapshot.adaptiveReviewTasks) {
    const blueprint = blueprintById.get(task.blueprintId);
    if (!blueprint || blueprint.decisionBlockId !== task.decisionBlockId || blueprint.contentVersion !== task.contentVersion) {
      throw new ReviewCoachValidationError("dangling-blueprint", `Task ${task.id} does not match its blueprint.`);
    }
    if (task.status !== "stale" && task.status !== "deleted") assertCurrentDecisionBlockRef(blocks.get(task.decisionBlockId), task);
    if (task.status === "current" || task.status === "in-progress") currentTasks += 1;
    // A deferred attempt that has been replaced has handed its target over to
    // the replacement. It stays `deferred` for its own audit trail, but it no
    // longer occupies the decision block - otherwise the requeue it created
    // would be rejected as a duplicate target.
    const supersededByReplacement = task.status === "deferred" && Boolean(task.replacedByTaskId);
    if (isOpenTaskStatus(task.status) && !supersededByReplacement) {
      const key = openTargetKeyFor(task);
      if (openTargets.has(key)) throw new ReviewCoachValidationError("duplicate-open-task", `More than one open task targets ${key}.`);
      openTargets.add(key);
    }
  }
  if (currentTasks > 1) throw new ReviewCoachValidationError("multiple-current-tasks", "Only one current task is allowed globally.");

  const taskById = new Map(snapshot.adaptiveReviewTasks.map((item) => [item.id, item]));
  const turnById = new Map(snapshot.adaptiveQuizTurns.map((item) => [item.id, item]));
  for (const turn of snapshot.adaptiveQuizTurns) {
    const task = taskById.get(turn.taskId);
    if (!task || task.decisionBlockId !== turn.decisionBlockId || task.contentVersion !== turn.contentVersion) {
      throw new ReviewCoachValidationError("dangling-task", `Quiz turn ${turn.id} does not match its task.`);
    }
  }
  for (const outcome of snapshot.taskOutcomeEvents) {
    assertTaskOutcomeShape(outcome);
    const task = taskById.get(outcome.taskId);
    if (!task || task.decisionBlockId !== outcome.decisionBlockId || task.contentVersion !== outcome.contentVersion) {
      throw new ReviewCoachValidationError("dangling-task", `Outcome ${outcome.id} does not match its task.`);
    }
    if (outcome.turnId && turnById.get(outcome.turnId)?.taskId !== outcome.taskId) {
      throw new ReviewCoachValidationError("dangling-turn", `Outcome ${outcome.id} does not match its turn.`);
    }
    if (outcome.kind === "self-assessment") {
      const answerEvents = snapshot.taskOutcomeEvents.filter((item) => item.taskId === outcome.taskId && item.kind === "answer-assessment" && !item.deletedAt);
      if (answerEvents.length === 0) {
        throw new ReviewCoachValidationError("self-assessment-without-answer", `Self-assessment ${outcome.id} has no answer evidence.`);
      }
      const lastAnswer = [...answerEvents].sort((left, right) => left.occurredAt.localeCompare(right.occurredAt) || left.id.localeCompare(right.id)).at(-1);
      if (outcome.subjectiveOutcome === "mastered" && lastAnswer?.answerAssessment === "incorrect" && !outcome.confirmedConflict) {
        throw new ReviewCoachValidationError("unconfirmed-outcome-conflict", `Mastered outcome ${outcome.id} conflicts with the last answer.`);
      }
    }
  }
  const verificationTaskIds = new Set(snapshot.delayedVerifications.map((item) => item.taskId).filter(Boolean));
  // A verification task is durably marked by its `priorityTier` as well as by
  // the `taskId` link. A verification that stays open after a provisional result
  // gets a *fresh* task for each re-check, and only the newest one is linked, so
  // keying solely off the link would make the earlier completed rounds look like
  // ordinary v2 loops that never closed.
  const isVerificationTaskRecord = (task: { id: string; priorityTier: string }) => (
    task.priorityTier === "due-verification" || verificationTaskIds.has(task.id)
  );
  for (const task of snapshot.adaptiveReviewTasks) {
    const events = snapshot.taskOutcomeEvents.filter((item) => item.taskId === task.id && !item.deletedAt);
    const dispositions = new Set(events.map((item) => item.disposition).filter(Boolean));
    const subjective = new Set(events.map((item) => item.subjectiveOutcome).filter(Boolean));
    // v1 tasks were completed by a self-assessment, so their history must keep
    // validating exactly as it was written. v2 tasks are the opposite: a
    // completion may never rest on a self-report, and must instead have two
    // qualifying retrievals (one before the judgment, one after).
    const isV2 = task.loopVersion === "closed-loop-v2";
    // A delayed verification runs on its own task, and its turns are
    // `delayed-first`, not `initial` / `post-judgment` - so the immediate-loop
    // rule below does not describe it. It is validated through its
    // DelayedVerification row instead; there the requirement is the opposite
    // one: the completion must rest on the locked first independent attempt.
    const isVerificationTask = isVerificationTaskRecord(task);
    if (isV2 && isVerificationTask) {
      // Still a v2 completion, so it may never rest on a self-report - that
      // part of the contract is shared and is checked here.
      if (subjective.size > 0) {
        throw new ReviewCoachValidationError("self-report-drives-completion", `Completed v2 verification task ${task.id} still carries a subjective outcome.`);
      }
    } else if (isV2) {
      if (task.status === "completed") {
        if (!dispositions.has("completed")) {
          throw new ReviewCoachValidationError("unsupported-task-terminal-state", `Completed v2 task ${task.id} has no completed disposition.`);
        }
        const turns = snapshot.adaptiveQuizTurns.filter((item) => item.taskId === task.id && !item.deletedAt);
        if (!isLoopClosed({ turns, events })) {
          throw new ReviewCoachValidationError("loop-not-closed", `Completed v2 task ${task.id} lacks a post-judgment retrieval.`);
        }
        if (subjective.size > 0) {
          throw new ReviewCoachValidationError("self-report-drives-completion", `Completed v2 task ${task.id} still carries a subjective outcome.`);
        }
      }
    } else {
      if (task.status === "completed" && (!dispositions.has("completed") || subjective.size === 0)) {
        throw new ReviewCoachValidationError("unsupported-task-terminal-state", `Completed task ${task.id} has no completed disposition and self-assessment.`);
      }
      if (task.status === "not-achieved" && (!dispositions.has("completed") || !subjective.has("not-mastered"))) {
        throw new ReviewCoachValidationError("unsupported-task-terminal-state", `Not-achieved task ${task.id} has no matching outcome.`);
      }
    }
    if (task.status === "invalid" && !dispositions.has("question-invalid")) {
      throw new ReviewCoachValidationError("unsupported-task-terminal-state", `Invalid task ${task.id} has no question-invalid disposition.`);
    }
    if (task.status === "deferred" && !dispositions.has("deferred")) {
      throw new ReviewCoachValidationError("unsupported-task-terminal-state", `Deferred task ${task.id} has no deferred disposition.`);
    }
    if (task.status === "abandoned" && !dispositions.has("abandoned")) {
      throw new ReviewCoachValidationError("unsupported-task-terminal-state", `Abandoned task ${task.id} has no abandoned disposition.`);
    }
  }
  const outcomeById = new Map(snapshot.taskOutcomeEvents.map((item) => [item.id, item]));
  for (const verification of snapshot.delayedVerifications) {
    const outcome = outcomeById.get(verification.sourceOutcomeEventId);
    const isV2Verification = verification.loopVersion === "closed-loop-v2";
    if (isV2Verification) {
      // v2 verification is opened by the qualifying post-judgment retrieval, not
      // by the learner declaring how well they think they did.
      if (!outcome || outcome.kind !== "answer-assessment") {
        throw new ReviewCoachValidationError("invalid-verification-source", `v2 verification ${verification.id} requires a post-judgment answer event.`);
      }
      const sourceTurn = outcome.turnId ? snapshot.adaptiveQuizTurns.find((item) => item.id === outcome.turnId) : undefined;
      if (!sourceTurn || sourceTurn.phase !== "post-judgment") {
        throw new ReviewCoachValidationError("invalid-verification-source", `v2 verification ${verification.id} must originate from a post-judgment turn.`);
      }
    } else if (!outcome || outcome.kind !== "self-assessment" || !["mastered", "needs-consolidation"].includes(outcome.subjectiveOutcome ?? "")) {
      throw new ReviewCoachValidationError("invalid-verification-source", `Verification ${verification.id} requires a completed self-assessment.`);
    }
    if (!outcome) {
      throw new ReviewCoachValidationError("invalid-verification-source", `Verification ${verification.id} has no source event.`);
    }
    if (outcome.decisionBlockId !== verification.decisionBlockId || outcome.contentVersion !== verification.contentVersion) {
      throw new ReviewCoachValidationError("invalid-verification-source", `Verification ${verification.id} targets another block version.`);
    }
    if (verification.taskId) {
      const task = taskById.get(verification.taskId);
      if (!task || task.priorityTier !== "due-verification" || task.decisionBlockId !== verification.decisionBlockId || task.contentVersion !== verification.contentVersion) {
        throw new ReviewCoachValidationError("invalid-verification-task", `Verification ${verification.id} has a mismatched task.`);
      }
    }
    if (verification.status === "completed") {
      if (isV2Verification) {
        // v2 records the evidence class, not a self-reported retained/decayed.
        if (!verification.evidenceStatus || !verification.lastVerifiedAt) {
          throw new ReviewCoachValidationError("missing-verification-outcome", `v2 verification ${verification.id} is completed without derived evidence.`);
        }
        if (verification.evidenceStatus === "ineligible") {
          throw new ReviewCoachValidationError("missing-verification-outcome", `v2 verification ${verification.id} completed on ineligible evidence.`);
        }
      } else if (!verification.verificationOutcome || !verification.lastVerifiedAt) {
        throw new ReviewCoachValidationError("missing-verification-outcome", `Verification ${verification.id} is completed without an outcome.`);
      }
    }
  }
};
