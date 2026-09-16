import type { AdaptiveQuizTurn, AdaptiveReviewTask, SessionBlueprint } from "./domain";
import {
  CLOSED_LOOP_V2_LOOP_VERSION,
  TURN_BUDGET_POLICY_VERSION,
  normalizeTurnBudgetForV2,
} from "./learningLoopPolicy";
import { coachTestBlock, coachTestBlueprint, coachTestStamp } from "./reviewCoachTestFixtures";

/**
 * Closed-loop v2 fixtures.
 *
 * The v1 fixtures in `reviewCoachTestFixtures.ts` intentionally stay frozen: they
 * model pre-v2 history and must keep loading through the legacy read path. These
 * fixtures model what a v2 build is allowed to write, so tests can assert the new
 * contract without mutating the historical baseline.
 */

export interface ClosedLoopV2FixtureOptions {
  maxTurns?: number;
  taskId?: string;
  blueprintId?: string;
  assessment?: "correct" | "partial" | "incorrect" | "unreliable";
  independenceStatus?: "independent" | "assisted" | "unknown";
  /** `open` stops after the initial retrieval; `closed` adds the post-judgment one. */
  loop?: "open" | "closed";
}

export const closedLoopV2Blueprint = (
  options: ClosedLoopV2FixtureOptions = {},
): SessionBlueprint => ({
  ...structuredClone(coachTestBlueprint),
  id: options.blueprintId ?? "blueprint-v2-1",
  status: "accepted",
  loopVersion: CLOSED_LOOP_V2_LOOP_VERSION,
  maxTurns: normalizeTurnBudgetForV2(options.maxTurns ?? 4),
  turnBudgetPolicyVersion: TURN_BUDGET_POLICY_VERSION,
  idempotencyKey: `blueprint-v2-operation:${options.blueprintId ?? "blueprint-v2-1"}`,
});

export const closedLoopV2Task = (
  blueprint: SessionBlueprint,
  options: ClosedLoopV2FixtureOptions = {},
): AdaptiveReviewTask => ({
  id: options.taskId ?? "task-v2-1",
  blueprintId: blueprint.id,
  decisionBlockId: coachTestBlock.id,
  recordId: coachTestBlock.recordId,
  contentVersion: 1,
  // A v2 task stays open until two qualifying retrievals actually happened.
  status: "in-progress",
  priorityTier: "first-difficulty",
  queuedAt: coachTestStamp,
  startedAt: coachTestStamp,
  activeSlotKey: "global-current",
  openTargetKey: `decision-block:${coachTestBlock.id}:1`,
  loopVersion: CLOSED_LOOP_V2_LOOP_VERSION,
  idempotencyKey: `task-v2-operation:${options.taskId ?? "task-v2-1"}`,
  createdAt: coachTestStamp,
  updatedAt: coachTestStamp,
});

const v2Turn = (
  task: AdaptiveReviewTask,
  sequence: number,
  phase: AdaptiveQuizTurn["phase"],
  question: string,
  options: ClosedLoopV2FixtureOptions,
): AdaptiveQuizTurn => ({
  id: `turn-v2-${sequence}`,
  taskId: task.id,
  decisionBlockId: coachTestBlock.id,
  recordId: coachTestBlock.recordId,
  contentVersion: 1,
  sequence,
  status: "answered",
  practiceType: "variation",
  answerMode: "open",
  question,
  displayedAt: coachTestStamp,
  sourceEvidence: closedLoopV2Blueprint().evidence,
  answerCriteria: ["以自己的话说明关键规则"],
  hintsUsed: [],
  answerText: `v2 answer ${sequence}`,
  answeredAt: coachTestStamp,
  assessment: options.assessment ?? "correct",
  assessmentRationale: "AI 评价：覆盖判据。",
  qualityChecked: true,
  qualityModel: "test-quality-model",
  generationModel: "test-generation-model",
  promptVersion: "quiz-turn-v2",
  policyVersion: "review-coach-policy-v2",
  idempotencyKey: `quiz-turn-v2-operation:${task.id}:${sequence}`,
  phase,
  independenceStatus: options.independenceStatus ?? "independent",
  variantEligibility: "eligible",
  targetFormStatus: "target-form",
  // Every v2 answer today is graded by the model, and the criteria are model
  // generated, so the strongest honest authority is provisional.
  judgmentMechanism: "ai-evaluation",
  referenceOrigin: "ai-generated",
  questionFingerprint: `fingerprint-${sequence}`,
  createdAt: coachTestStamp,
  updatedAt: coachTestStamp,
});

export const closedLoopV2Fixtures = (options: ClosedLoopV2FixtureOptions = {}) => {
  const blueprint = closedLoopV2Blueprint(options);
  const task = closedLoopV2Task(blueprint, options);
  const initial = v2Turn(task, 1, "initial", "首次提取：BFS 中节点何时被标记？", options);
  // The default attempt is *open*: one retrieval in, loop not yet closed.
  // Tests that need a closable attempt ask for `loop: "closed"` explicitly, so
  // no test can accidentally treat a single answer as a finished loop.
  const postJudgment = v2Turn(task, 2, "post-judgment", "反馈后再提取：写出一条不属于 BFS 的边界规则。", options);
  const turns = options.loop === "closed" ? [initial, postJudgment] : [initial];
  return { blueprint, task, turns, initial, postJudgment };
};
