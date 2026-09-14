// @vitest-environment node
/**
 * P4 paid acceptance for the AI 驾驶舱 after the A/B/C remediation batches.
 *
 * What this proves with real tokens (deterministic tests cannot):
 *   1. C-1/F-17 — the quiz generator obeys the JSON-only role prompt and returns a schema-valid
 *      turn for a real decision block (no Markdown fencing, no invented criteria, no leak).
 *   2. C-2/F-04 — the returned `practiceType` / `answerMode` are legal enum values, which the old
 *      prompt text made impossible three times out of six.
 *   3. C-4/F-20 — the local leak check passes on a real generated turn (no false positives on
 *      ordinary phrasing).
 *   4. A-1 — the evaluator receives the decision-block material and returns one of four
 *      assessments, matching only criteria that exist.
 *
 * Skipped unless the key is provided, so the deterministic suite stays free:
 *   REVIEW_COACH_LIVE_DEEPSEEK_KEY=sk-... \
 *   npx vitest run src/features/reviewCoach/aiAcceptance.live.test.ts
 *
 * Cost ceiling: 2 calls (one turn generation + one answer evaluation) at roughly 2k input and
 * 1.8k output tokens. Never commit keys; the app reads them from device-local storage.
 */
import { describe, expect, it } from "vitest";

import { quizPracticeTypes } from "./aiSchemas";
import { createQuizExecutionGateway } from "./quizExecutionGateway";
import { assertNoAnswerLeakage } from "./questionIntegrity";

const apiKey = process.env.REVIEW_COACH_LIVE_DEEPSEEK_KEY;
const live = apiKey ? describe : describe.skip;

const stamp = "2026-09-14T08:00:00.000Z";
const decisionBlockContent = [
  "决策块材料：广度优先搜索（BFS）使用一个队列。",
  "核心规则：从队列取出节点时才检查它是否是目标；",
  "一个节点的访问标记必须在它入队的同一时刻写入，而不是在出队时写入，否则同一节点会被重复入队，队列规模按分支数膨胀。",
  "时间复杂度为 O(V+E)，空间复杂度为 O(V)。",
].join("\n");

const blueprint = {
  id: "live-blueprint",
  batchId: "live-batch",
  decisionBlockId: "live-block",
  recordId: "live-record",
  contentVersion: 1,
  status: "accepted" as const,
  supportingDecisionBlockIds: [],
  feedbackIds: [],
  interpretationIds: [],
  problemHypothesis: "把访问标记的时机记混",
  hypothesisConfidence: 0.8,
  objective: "准确说出 BFS 访问标记的写入时机并说明原因",
  completionCriteria: ["说出标记在入队时写入", "解释不标记会导致重复入队"],
  initialPracticeType: "variation" as const,
  initialDifficulty: 2,
  expectedKeyPoints: ["入队时标记"],
  branches: [
    { when: "correct", nextStrategy: "finish" },
    { when: "partial", nextStrategy: "hint" },
    { when: "incorrect", nextStrategy: "explain" },
    { when: "skipped", nextStrategy: "prerequisite-check" },
  ],
  allowedStrategies: ["finish", "hint", "explain", "prerequisite-check"],
  forbiddenScope: ["与 BFS 无关的图算法"],
  evidence: [{ decisionBlockId: "live-block", recordId: "live-record", contentVersion: 1, excerptHash: "live-hash", purpose: "source" }],
  maxTurns: 2,
  maxRetriesPerTurn: 1,
  maxEstimatedTokens: 4000,
  provider: "deepseek",
  model: "deepseek-v4-flash",
  promptVersion: "session-blueprint-v1",
  policyVersion: "review-coach-policy-v1",
  schemaVersion: 1,
  idempotencyKey: "live-blueprint",
  createdAt: stamp,
  updatedAt: stamp,
};

const provider = {
  id: "live-deepseek",
  providerName: "DeepSeek",
  baseUrl: "https://api.deepseek.com",
  model: "deepseek-v4-flash",
  temperature: 0.3,
  maxTokens: 4096,
  contextWindowTokens: 65_536,
};

live("AI 驾驶舱付费验收（1 决策块 × 1 轮出题 + 1 次判题）", () => {
  it("generates a schema-valid, non-leaking turn and evaluates a real answer", { timeout: 180_000 }, async () => {
    const gateway = createQuizExecutionGateway({ provider, apiKey: apiKey!, timeoutMs: 120_000 });

    const turn = await gateway.generateTurn({
      task: { id: "live-task", decisionBlockId: blueprint.decisionBlockId, recordId: blueprint.recordId, contentVersion: 1 },
      blueprint,
      decisionBlockContent,
      previousTurns: [],
      verificationMode: undefined,
    });
    if (turn.status !== "ok") throw new Error(`生成题返回 insufficient-context：${turn.missingInformation.join("、")}`);
    expect(quizPracticeTypes).toContain(turn.practiceType);
    expect(["open", "objective", "unique"]).toContain(turn.answerMode);
    expect(turn.sourceEvidence.every((item) => item.decisionBlockId === blueprint.decisionBlockId)).toBe(true);
    // C-4: a real generated turn must survive the local check — this is the false-positive probe.
    expect(() => assertNoAnswerLeakage({ question: turn.question, hints: turn.hints, answerCriteria: turn.answerCriteria })).not.toThrow();

    const evaluation = await gateway.evaluateAnswer({
      blueprint,
      decisionBlockContent,
      question: turn.question,
      answerCriteria: turn.answerCriteria,
      answerText: "标记应该在节点入队的时候写，不然同一个节点会被重复加入队列。",
      hintsUsed: [],
    });
    if (evaluation.status !== "ok") throw new Error(`判题返回 insufficient-context：${evaluation.missingInformation.join("、")}`);
    expect(["correct", "partial", "incorrect", "unreliable"]).toContain(evaluation.assessment);
    const criteria = new Set(turn.answerCriteria);
    for (const criterion of [...evaluation.matchedCriteria, ...evaluation.missingCriteria]) {
      expect(criteria.has(criterion)).toBe(true);
    }
  });
});
