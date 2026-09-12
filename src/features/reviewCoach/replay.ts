import type {
  AdaptiveQuizTurn,
  AdaptiveReviewTask,
  AnalysisQueueItem,
  DecisionBlock,
  DecisionBlockFeedback,
  DecisionBlockState,
  DelayedVerification,
  FeedbackInterpretation,
  InterventionEffectSummary,
  ReviewCoachFormalSnapshot,
  SessionBlueprint,
  TaskOutcomeEvent,
} from "./domain";

export const REVIEW_COACH_REPLAY_VERSION = "review-coach-replay-v2";

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

  let status: DecisionBlockState["status"] = "unassessed";
  if (input.block.deletedAt) status = "stale";
  else if (activeFeedback.length > 0) status = "needs-analysis";
  if (blueprints.length > 0 || tasks.some((task) => ["waiting", "deferred"].includes(task.status))) status = "planned";

  const currentTask = tasks.find((task) => task.status === "current" || task.status === "in-progress");
  if (currentTask) status = "learning";

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
  for (const event of statusEvents) event.apply();

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
    blueprints: SessionBlueprint[];
    tasks: AdaptiveReviewTask[];
  }>();
  for (const blueprint of input.blueprints.filter((item) => item.status === "accepted" && !item.deletedAt)) {
    const interpretation = blueprint.interpretationIds.map((id) => interpretationById.get(id)).find((item) => item?.difficultyType);
    const problemType = interpretation?.difficultyType ?? "other";
    const key = [problemType, blueprint.initialPracticeType, blueprint.provider, blueprint.model, blueprint.promptVersion, blueprint.policyVersion].join(":");
    const group = groups.get(key) ?? { problemType, practiceType: blueprint.initialPracticeType, blueprints: [], tasks: [] };
    group.blueprints.push(blueprint);
    group.tasks.push(...(tasksByBlueprint.get(blueprint.id) ?? []));
    groups.set(key, group);
  }

  return [...groups.entries()].map(([strategyKey, group]) => {
    const verificationTaskIds = new Set(input.verifications.map((item) => item.taskId).filter((id): id is string => Boolean(id)));
    const interventionTasks = group.tasks.filter((task) => !verificationTaskIds.has(task.id));
    const taskIds = new Set(interventionTasks.map((task) => task.id));
    const outcomes = input.outcomes.filter((event) => taskIds.has(event.taskId) && !event.deletedAt);
    const outcomeIds = new Set(outcomes.map((event) => event.id));
    const verifications = input.verifications.filter((item) => outcomeIds.has(item.sourceOutcomeEventId) && !item.deletedAt);
    const turns = input.turns.filter((turn) => taskIds.has(turn.taskId) && !turn.deletedAt);
    const mastered = outcomes.filter((event) => event.subjectiveOutcome === "mastered").length;
    const completedVerifications = verifications.filter((item) => item.status === "completed");
    const stamps = [
      ...group.blueprints.map((item) => item.createdAt),
      ...outcomes.map((item) => item.occurredAt),
      ...completedVerifications.map((item) => item.lastVerifiedAt ?? item.updatedAt),
    ].sort();
    const masteredTaskIds = new Set(outcomes.filter((event) => event.subjectiveOutcome === "mastered").map((event) => event.taskId));
    const turnsToMastery = [...masteredTaskIds].map((taskId) => turns.filter((turn) => turn.taskId === taskId).length);
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
      strategyKey,
      sampleFrom: stamps[0] ?? input.replayedAt,
      sampleTo: stamps.at(-1) ?? input.replayedAt,
      sampleCount,
      recentSampleCount,
      recencyWeight,
      immediateMasteredCount: mastered,
      delayedRetainedCount: retainedCount,
      delayedDecayedCount: decayedCount,
      retentionRate: completedVerificationCount ? retainedCount / completedVerificationCount : undefined,
      decayRate: completedVerificationCount ? decayedCount / completedVerificationCount : undefined,
      averageTurnsToMastery: turnsToMastery.length ? turnsToMastery.reduce((total, value) => total + value, 0) / turnsToMastery.length : undefined,
      averageHintsUsed: turns.length ? hints / turns.length : undefined,
      deferredCount: outcomes.filter((event) => event.disposition === "deferred").length,
      abandonedCount: outcomes.filter((event) => event.disposition === "abandoned").length,
      invalidQuestionCount: outcomes.filter((event) => event.disposition === "question-invalid").length,
      replanCount: interventionTasks.filter((task) => task.status === "not-achieved").length,
      deletedCount: interventionTasks.filter((task) => task.deletedAt || task.status === "deleted").length,
      confidence,
      evidenceStatus: sampleCount >= 3 ? "usable" as const : "insufficient" as const,
      modelVersions: [...new Set(group.blueprints.map((item) => item.model))].sort(),
      promptVersions: [...new Set(group.blueprints.map((item) => item.promptVersion))].sort(),
      policyVersions: [...new Set(group.blueprints.map((item) => item.policyVersion))].sort(),
      replayFingerprint: coachReplayFingerprint({ group, outcomes, verifications, turns }),
    };
  }).sort((left, right) => left.id.localeCompare(right.id));
};
