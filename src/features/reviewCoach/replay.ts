import type {
  AdaptivePracticeType,
  AdaptiveQuizTurn,
  AdaptiveReviewTask,
  AnalysisQueueItem,
  DecisionBlock,
  DecisionBlockFeedback,
  DecisionBlockState,
  DelayedVerification,
  EffectHintLevel,
  FeedbackInterpretation,
  ImmediateAnswerAssessment,
  InterventionEffectSummary,
  ReviewCoachFormalSnapshot,
  SessionBlueprint,
  TaskOutcomeEvent,
} from "./domain";

export const REVIEW_COACH_REPLAY_VERSION = "review-coach-replay-v3";

/** Counts AI answer assessments by outcome. Unreliable answers are counted but never treated
 *  as wrong: the value mixes "the model could not judge" with "the user skipped the turn". */
const countAssessments = (events: readonly TaskOutcomeEvent[]): Record<ImmediateAnswerAssessment, number> => {
  const counts: Record<ImmediateAnswerAssessment, number> = { correct: 0, partial: 0, incorrect: 0, unreliable: 0 };
  for (const event of events) {
    if (event.kind !== "answer-assessment" || !event.answerAssessment) continue;
    counts[event.answerAssessment] += 1;
  }
  return counts;
};

const totalAssessments = (counts: Record<ImmediateAnswerAssessment, number>): number =>
  counts.correct + counts.partial + counts.incorrect + counts.unreliable;

/** Denominator excludes `unreliable`, so a skipped or unjudgeable turn never counts as wrong. */
const rateOf = (counts: Record<ImmediateAnswerAssessment, number>): number | undefined => {
  const rated = counts.correct + counts.partial + counts.incorrect;
  return rated ? counts.correct / rated : undefined;
};

const NO_ACTUAL_PRACTICE_TYPE = "none" as const;
/** Hint level 1 is the weakest hint; level >= 2 is an explanation or a worked example. */
const HINT_LEVEL_STRONGER_THRESHOLD = 2;
/** `skipQuizTurn` writes this literal into `answerText`; such a turn carries no retrieval evidence. */
const SKIPPED_ANSWER_TEXT = "[skipped]";

/**
 * The practice type that dominated a task's turns. Ties resolve to the lexicographically
 * smallest type so the result never depends on input order or object iteration.
 */
const dominantPracticeType = (turns: readonly AdaptiveQuizTurn[]): AdaptivePracticeType | typeof NO_ACTUAL_PRACTICE_TYPE => {
  if (turns.length === 0) return NO_ACTUAL_PRACTICE_TYPE;
  const counts = new Map<AdaptivePracticeType, number>();
  for (const turn of turns) counts.set(turn.practiceType, (counts.get(turn.practiceType) ?? 0) + 1);
  return [...counts.entries()]
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))[0][0];
};

const hintLevelOf = (turns: readonly AdaptiveQuizTurn[]): EffectHintLevel => {
  let strongest = 0;
  for (const turn of turns) {
    for (const hint of turn.hintsUsed) strongest = Math.max(strongest, hint.level);
  }
  if (strongest === 0) return "none";
  return strongest >= HINT_LEVEL_STRONGER_THRESHOLD ? "explain-or-worked-example" : "hint-only";
};

const canonicalize = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.keys(value as Record<string, unknown>)
      .sort()
      .reduce<Record<string, unknown>>((result, key) => {
        const next = (value as Record<string, unknown>)[key];
        if (next !== undefined) result[key] = canonicalize(next);
        return result;
      }, {});
  }
  return value;
};

export const coachReplayFingerprint = (value: unknown): string => {
  const source = JSON.stringify(canonicalize(value));
  let hash = 2166136261;
  for (let index = 0; index < source.length; index += 1) {
    hash ^= source.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return `replay-${(hash >>> 0).toString(16).padStart(8, "0")}`;
};

const compareEvents = <T extends { id: string }>(left: T, right: T, getTime: (value: T) => string) =>
  getTime(left).localeCompare(getTime(right)) || left.id.localeCompare(right.id);

const compareById = <T extends { id: string }>(left: T, right: T) => left.id.localeCompare(right.id);

const verificationTime = (verification: DelayedVerification) => verification.lastVerifiedAt ?? verification.updatedAt;

const compareVerifications = (left: DelayedVerification, right: DelayedVerification) =>
  verificationTime(left).localeCompare(verificationTime(right)) || left.id.localeCompare(right.id);

export interface DecisionBlockReplayInput {
  block: DecisionBlock;
  feedback: DecisionBlockFeedback[];
  queueItems: AnalysisQueueItem[];
  blueprints: SessionBlueprint[];
  tasks: AdaptiveReviewTask[];
  turns: AdaptiveQuizTurn[];
  outcomes: TaskOutcomeEvent[];
  verifications: DelayedVerification[];
  replayedAt?: string;
}

export const replayDecisionBlockState = (input: DecisionBlockReplayInput): DecisionBlockState => {
  const version = input.block.contentVersion;
  const activeFeedback = input.feedback
    .filter((item) => item.decisionBlockId === input.block.id && item.contentVersion === version && !item.deletedAt)
    .sort((a, b) => compareEvents(a, b, (value) => value.occurredAt));
  const queueItems = input.queueItems.filter((item) => item.decisionBlockId === input.block.id && item.contentVersion === version && !item.deletedAt);
  const blueprints = input.blueprints.filter((item) => item.decisionBlockId === input.block.id && item.contentVersion === version && !item.deletedAt && item.status === "accepted");
  const tasks = input.tasks.filter((item) => item.decisionBlockId === input.block.id && item.contentVersion === version && !item.deletedAt);
  const turns = input.turns.filter((item) => item.decisionBlockId === input.block.id && item.contentVersion === version && !item.deletedAt);
  const outcomes = input.outcomes
    .filter((item) => item.decisionBlockId === input.block.id && item.contentVersion === version && !item.deletedAt)
    .sort((a, b) => compareEvents(a, b, (value) => value.occurredAt));
  const verifications = input.verifications
    .filter((item) => item.decisionBlockId === input.block.id && item.contentVersion === version && !item.deletedAt)
    .sort(compareVerifications);

  const currentTask = tasks.find((task) => task.status === "current" || task.status === "in-progress");
  const hasOpenTask = tasks.some((task) => task.status === "waiting" || task.status === "deferred");

  const statusEvents = [
    ...outcomes
      .filter((outcome) => outcome.kind === "self-assessment")
      .map((outcome) => ({ time: outcome.occurredAt, kind: 0, id: outcome.id, apply: () => {
        if (outcome.subjectiveOutcome === "mastered") status = "improved-pending-verification";
        if (outcome.subjectiveOutcome === "needs-consolidation") status = "needs-consolidation";
        if (outcome.subjectiveOutcome === "not-mastered") status = "not-mastered";
      } })),
    ...verifications
      .filter((verification) => verification.status === "completed" && verification.verificationOutcome)
      .map((verification) => ({ time: verification.lastVerifiedAt ?? verification.updatedAt, kind: 1, id: verification.id, apply: () => {
        if (verification.verificationOutcome === "retained") status = "retained";
        if (verification.verificationOutcome === "decayed") status = "needs-consolidation";
      } })),
  ].sort((left, right) => left.time.localeCompare(right.time) || left.kind - right.kind || left.id.localeCompare(right.id));

  // B-1 (F-08): explicit precedence instead of "last writer wins". A projection is a function of the
  // whole fact set, and the previous code let an older self-assessment overwrite the fact that a
  // *newer* piece of feedback had not been analysed yet — so a block the user had just complained
  // about still showed "improved-pending-verification".
  const lastFeedbackAt = activeFeedback.at(-1)?.occurredAt;
  const lastContentEventAt = statusEvents.at(-1)?.time;
  let status: DecisionBlockState["status"];
  if (input.block.deletedAt) {
    status = "stale";
  } else if (currentTask) {
    // A task in flight outranks everything else: the user is mid-exercise right now.
    status = "learning";
  } else if (lastFeedbackAt && (!lastContentEventAt || lastContentEventAt < lastFeedbackAt)) {
    // Unprocessed feedback outranks a stale result, because the result describes an older state.
    status = "needs-analysis";
  } else {
    status = "unassessed";
    for (const event of statusEvents) event.apply();
    // No content event decided the status: fall back to "there is a plan", then to "nothing yet".
    if (status === "unassessed" && (blueprints.length > 0 || hasOpenTask)) status = "planned";
  }

  const pendingVerification = verifications
    .filter((item) => ["scheduled", "eligible", "queued", "in-progress", "missed"].includes(item.status))
    .at(-1);
  const completedVerifications = verifications.filter((item) => item.status === "completed" && item.verificationOutcome);
  const replayedAt = input.replayedAt ?? input.block.updatedAt;
  const replayFacts = {
    block: input.block,
    feedback: activeFeedback,
    queueItems,
    blueprints,
    tasks,
    turns,
    outcomes,
    verifications,
  };
  return {
    id: input.block.id,
    decisionBlockId: input.block.id,
    recordId: input.block.recordId,
    contentVersion: version,
    createdAt: input.block.createdAt,
    updatedAt: replayedAt,
    status,
    lastFeedbackAt: activeFeedback.at(-1)?.occurredAt,
    lastOutcomeAt: outcomes.at(-1)?.occurredAt,
    lastVerifiedAt: completedVerifications.at(-1)?.lastVerifiedAt ?? completedVerifications.at(-1)?.updatedAt,
    currentTaskId: currentTask?.id,
    pendingVerificationId: pendingVerification?.id,
    replayFingerprint: coachReplayFingerprint(replayFacts),
    replayVersion: REVIEW_COACH_REPLAY_VERSION,
  };
};

export const replayAllDecisionBlockStates = (
  snapshot: ReviewCoachFormalSnapshot,
  replayedAt?: string,
): DecisionBlockState[] => snapshot.decisionBlocks.map((block) => replayDecisionBlockState({
  block,
  feedback: snapshot.decisionBlockFeedback,
  queueItems: snapshot.analysisQueueItems,
  blueprints: snapshot.sessionBlueprints,
  tasks: snapshot.adaptiveReviewTasks,
  turns: snapshot.adaptiveQuizTurns,
  outcomes: snapshot.taskOutcomeEvents,
  verifications: snapshot.delayedVerifications,
  replayedAt,
}));

export interface DecayedBlockNeedingReplan {
  decisionBlockId: string;
  recordId: string;
  contentVersion: number;
  decayedAt: string;
}

/**
 * B-3 (F-03): the derived query behind the workbench "needs replanning" surface.
 *
 * A decayed verification used to be a dead end — it wrote a projection and nothing else. This
 * reports the blocks where the decay is still the newest word: nothing has been said or planned
 * since. It deliberately does *not* write anything, because a system-authored
 * `DecisionBlockFeedback` would change the meaning of a formal, synchronised fact.
 */
export const listDecayedBlocksNeedingReplan = (snapshot: ReviewCoachFormalSnapshot): DecayedBlockNeedingReplan[] => {
  const result: DecayedBlockNeedingReplan[] = [];
  for (const block of snapshot.decisionBlocks) {
    if (block.deletedAt) continue;
    const version = block.contentVersion;
    const inBlock = <T extends { decisionBlockId: string; contentVersion: number; deletedAt?: string }>(items: readonly T[]) =>
      items.filter((item) => item.decisionBlockId === block.id && item.contentVersion === version && !item.deletedAt);

    const latestCompleted = inBlock(snapshot.delayedVerifications)
      .filter((item) => item.status === "completed" && item.verificationOutcome)
      .sort(compareVerifications)
      .at(-1);
    if (!latestCompleted || latestCompleted.verificationOutcome !== "decayed") continue;
    const decayedAt = verificationTime(latestCompleted);

    // Any of these means someone (the user or the planner) already moved past the decay.
    if (inBlock(snapshot.decisionBlockFeedback).some((item) => item.occurredAt > decayedAt)) continue;
    if (inBlock(snapshot.sessionBlueprints).some((item) => item.status === "accepted" && item.createdAt > decayedAt)) continue;
    if (inBlock(snapshot.adaptiveReviewTasks).some((item) => ["waiting", "deferred", "current", "in-progress"].includes(item.status))) continue;

    result.push({ decisionBlockId: block.id, recordId: block.recordId, contentVersion: version, decayedAt });
  }
  return result.sort((left, right) => left.decayedAt.localeCompare(right.decayedAt) || left.decisionBlockId.localeCompare(right.decisionBlockId));
};

export interface InterventionReplayInput {
  interpretations: FeedbackInterpretation[];
  blueprints: SessionBlueprint[];
  tasks: AdaptiveReviewTask[];
  turns: AdaptiveQuizTurn[];
  outcomes: TaskOutcomeEvent[];
  verifications: DelayedVerification[];
  replayedAt: string;
}

export const replayInterventionEffectSummaries = (input: InterventionReplayInput): InterventionEffectSummary[] => {
  const interpretationById = new Map(input.interpretations.map((item) => [item.id, item]));
  const tasksByBlueprint = new Map<string, AdaptiveReviewTask[]>();
  for (const task of input.tasks) {
    const current = tasksByBlueprint.get(task.blueprintId) ?? [];
    current.push(task);
    tasksByBlueprint.set(task.blueprintId, current);
  }

  const groups = new Map<string, {
    problemType: NonNullable<FeedbackInterpretation["difficultyType"]>;
    practiceType: SessionBlueprint["initialPracticeType"];
    actualPracticeType: AdaptivePracticeType | typeof NO_ACTUAL_PRACTICE_TYPE;
    hintLevelUsed: EffectHintLevel;
    blueprints: SessionBlueprint[];
    tasks: AdaptiveReviewTask[];
  }>();
  // A task created only to run a delayed verification is not an intervention sample.
  const verificationTaskIds = new Set(input.verifications.map((item) => item.taskId).filter((id): id is string => Boolean(id)));
  const turnsByTask = new Map<string, AdaptiveQuizTurn[]>();
  for (const turn of input.turns) {
    if (turn.deletedAt) continue;
    const current = turnsByTask.get(turn.taskId) ?? [];
    current.push(turn);
    turnsByTask.set(turn.taskId, current);
  }

  /** Adds the blueprint to the group exactly once, even when several of its tasks share the key. */
  const attachBlueprint = (group: { blueprints: SessionBlueprint[] }, blueprint: SessionBlueprint) => {
    if (!group.blueprints.some((item) => item.id === blueprint.id)) group.blueprints.push(blueprint);
  };

  for (const blueprint of input.blueprints.filter((item) => item.status === "accepted" && !item.deletedAt)) {
    const interpretation = blueprint.interpretationIds.map((id) => interpretationById.get(id)).find((item) => item?.difficultyType);
    const problemType = interpretation?.difficultyType ?? "other";
    const prefix = [problemType, blueprint.initialPracticeType, blueprint.provider, blueprint.model, blueprint.promptVersion, blueprint.policyVersion];
    const interventionTasks = (tasksByBlueprint.get(blueprint.id) ?? []).filter((task) => !verificationTaskIds.has(task.id));
    if (interventionTasks.length === 0) {
      // Preserve the previous behaviour: an accepted blueprint always yields an entry, even
      // before any turn exists. Such a group has no turn-level dimensions to split on.
      const key = [...prefix, NO_ACTUAL_PRACTICE_TYPE, "none", ""].join(":");
      const group = groups.get(key) ?? { problemType, practiceType: blueprint.initialPracticeType, actualPracticeType: NO_ACTUAL_PRACTICE_TYPE, hintLevelUsed: "none" as const, blueprints: [], tasks: [] };
      attachBlueprint(group, blueprint);
      groups.set(key, group);
      continue;
    }
    for (const task of interventionTasks) {
      const taskTurns = turnsByTask.get(task.id) ?? [];
      const actualPracticeType = dominantPracticeType(taskTurns);
      const hintLevelUsed = hintLevelOf(taskTurns);
      // Turn-level prompt versions belong in the key: C-batch prompt changes create a new
      // regime, and effect samples from different regimes must never be pooled.
      const turnPromptVersions = [...new Set(taskTurns.map((turn) => turn.promptVersion))].sort();
      const key = [...prefix, actualPracticeType, hintLevelUsed, turnPromptVersions.join(",")].join(":");
      const group = groups.get(key) ?? { problemType, practiceType: blueprint.initialPracticeType, actualPracticeType, hintLevelUsed, blueprints: [], tasks: [] };
      attachBlueprint(group, blueprint);
      group.tasks.push(task);
      groups.set(key, group);
    }
  }

  // The stored order of a group's facts must never depend on input order (§2.4 constraint 1):
  // `replayFingerprint` is a content hash, and an unstable array order would make it unstable too.
  const turnSequenceById = new Map(input.turns.map((turn) => [turn.id, turn.sequence]));

  return [...groups.entries()].map(([strategyKey, group]) => {
    const blueprints = [...group.blueprints].sort(compareById);
    const interventionTasks = [...group.tasks].sort(compareById);
    const taskIds = new Set(interventionTasks.map((task) => task.id));
    const outcomes = input.outcomes.filter((event) => taskIds.has(event.taskId) && !event.deletedAt);
    const outcomeIds = new Set(outcomes.map((event) => event.id));
    const verifications = input.verifications.filter((item) => outcomeIds.has(item.sourceOutcomeEventId) && !item.deletedAt);
    const turns = input.turns.filter((turn) => taskIds.has(turn.taskId) && !turn.deletedAt);
    // Objective evidence. `verifications` above is already scoped to this group (it is keyed by
    // the group's own outcome events), so its tasks identify exactly this group's verification turns.
    const groupVerificationTaskIds = new Set(verifications.map((item) => item.taskId).filter((id): id is string => Boolean(id)));
    const objectiveCounts = countAssessments(outcomes);
    const verificationCounts = countAssessments(input.outcomes.filter((event) => groupVerificationTaskIds.has(event.taskId) && !event.deletedAt));
    const objectiveAnswerCount = totalAssessments(objectiveCounts);
    const verificationObjectiveCount = totalAssessments(verificationCounts);
    const lastAssessmentByTask = new Map<string, ImmediateAnswerAssessment>();
    // "Latest turn" needs the deterministic comparator from §2.4 constraint 2 — wall-clock time
    // alone cannot order two events written by different devices, so sequence then id break ties.
    for (const event of [...outcomes].sort((left, right) =>
      left.occurredAt.localeCompare(right.occurredAt)
      || (turnSequenceById.get(left.turnId ?? "") ?? 0) - (turnSequenceById.get(right.turnId ?? "") ?? 0)
      || left.id.localeCompare(right.id))) {
      if (event.kind === "answer-assessment" && event.answerAssessment) lastAssessmentByTask.set(event.taskId, event.answerAssessment);
    }
    const mastered = outcomes.filter((event) => event.subjectiveOutcome === "mastered").length;
    const completedVerifications = verifications.filter((item) => item.status === "completed");
    const stamps = [
      ...blueprints.map((item) => item.createdAt),
      ...outcomes.map((item) => item.occurredAt),
      ...completedVerifications.map((item) => item.lastVerifiedAt ?? item.updatedAt),
    ].sort();
    const masteredTaskIds = new Set(outcomes.filter((event) => event.subjectiveOutcome === "mastered").map((event) => event.taskId));
    // How did the user actually perform on the last turn of the tasks they called "mastered"?
    // Unreliable last turns are omitted rather than guessed.
    const masteryAssessmentBreakdown = { correct: 0, partial: 0, incorrect: 0 };
    for (const taskId of masteredTaskIds) {
      const assessment = lastAssessmentByTask.get(taskId);
      if (assessment === "correct") masteryAssessmentBreakdown.correct += 1;
      else if (assessment === "partial") masteryAssessmentBreakdown.partial += 1;
      else if (assessment === "incorrect") masteryAssessmentBreakdown.incorrect += 1;
    }
    const turnsToMastery = [...masteredTaskIds].map((taskId) =>
      // A skipped turn is not an attempt (the user never saw a scored answer), so counting it
      // would inflate "how many turns it took to master" for tasks the user skipped through.
      turns.filter((turn) => turn.taskId === taskId && turn.answerText !== SKIPPED_ANSWER_TEXT).length);
    const hints = turns.flatMap((turn) => turn.hintsUsed).length;
    const sampleTasks = interventionTasks.filter((task) => task.startedAt || outcomes.some((event) => event.taskId === task.id));
    const sampleCount = sampleTasks.length;
    const recentCutoff = new Date(Date.parse(input.replayedAt) - 30 * 86_400_000).toISOString();
    const recentSampleCount = sampleTasks.filter((task) => (task.endedAt ?? task.updatedAt) >= recentCutoff).length;
    const recencyWeight = sampleCount ? recentSampleCount / sampleCount : 0;
    const confidence = Math.min(1, sampleCount / 10) * (0.5 + recencyWeight * 0.5);
    const retainedCount = completedVerifications.filter((item) => item.verificationOutcome === "retained").length;
    const decayedCount = completedVerifications.filter((item) => item.verificationOutcome === "decayed").length;
    const completedVerificationCount = retainedCount + decayedCount;
    return {
      id: strategyKey,
      createdAt: stamps[0] ?? input.replayedAt,
      updatedAt: input.replayedAt,
      problemType: group.problemType,
      practiceType: group.practiceType,
      actualPracticeType: group.actualPracticeType,
      hintLevelUsed: group.hintLevelUsed,
      strategyKey,
      sampleFrom: stamps[0] ?? input.replayedAt,
      sampleTo: stamps.at(-1) ?? input.replayedAt,
      sampleCount,
      recentSampleCount,
      recencyWeight,
      immediateMasteredCount: mastered,
      selfReportedMasteredCount: mastered,
      objectiveAnswerCount,
      objectiveCorrectCount: objectiveCounts.correct,
      objectivePartialCount: objectiveCounts.partial,
      objectiveIncorrectCount: objectiveCounts.incorrect,
      objectiveUnreliableCount: objectiveCounts.unreliable,
      objectiveCorrectRate: rateOf(objectiveCounts),
      verificationObjectiveCount,
      verificationObjectiveCorrectCount: verificationCounts.correct,
      verificationObjectiveCorrectRate: rateOf(verificationCounts),
      objectiveEvidenceStatus: objectiveAnswerCount >= 3 ? "usable" as const : "insufficient" as const,
      masteryAssessmentBreakdown,
      delayedRetainedCount: retainedCount,
      delayedDecayedCount: decayedCount,
      retentionRate: completedVerificationCount ? retainedCount / completedVerificationCount : undefined,
      decayRate: completedVerificationCount ? decayedCount / completedVerificationCount : undefined,
      averageTurnsToMastery: turnsToMastery.length ? turnsToMastery.reduce((total, value) => total + value, 0) / turnsToMastery.length : undefined,
      // Denominator is every non-deleted turn of the group, including skipped ones: the question
      // is "how often did the user lean on hints", and a skipped turn still consumed the material.
      averageHintsUsed: turns.length ? hints / turns.length : undefined,
      deferredCount: outcomes.filter((event) => event.disposition === "deferred").length,
      abandonedCount: outcomes.filter((event) => event.disposition === "abandoned").length,
      invalidQuestionCount: outcomes.filter((event) => event.disposition === "question-invalid").length,
      replanCount: interventionTasks.filter((task) => task.status === "not-achieved").length,
      deletedCount: interventionTasks.filter((task) => task.deletedAt || task.status === "deleted").length,
      confidence,
      evidenceStatus: sampleCount >= 3 ? "usable" as const : "insufficient" as const,
      modelVersions: [...new Set(blueprints.map((item) => item.model))].sort(),
      promptVersions: [...new Set(blueprints.map((item) => item.promptVersion))].sort(),
      policyVersions: [...new Set(blueprints.map((item) => item.policyVersion))].sort(),
      // Sorted copies only: `coachReplayFingerprint` sorts object keys but preserves array order,
      // so hashing the raw arrays would make the fingerprint depend on input order.
      replayFingerprint: coachReplayFingerprint({
        problemType: group.problemType,
        practiceType: group.practiceType,
        actualPracticeType: group.actualPracticeType,
        hintLevelUsed: group.hintLevelUsed,
        blueprints,
        tasks: interventionTasks,
        outcomes: [...outcomes].sort(compareById),
        verifications: [...verifications].sort(compareById),
        turns: [...turns].sort(compareById),
      }),
    };
  }).sort((left, right) => left.id.localeCompare(right.id));
};
