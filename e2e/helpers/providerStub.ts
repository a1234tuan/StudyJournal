import { expect, type Page, type Route } from "@playwright/test";

/**
 * Deterministic DeepSeek provider stub for E2E.
 *
 * Ordinary E2E must never contact a paid provider (AGENTS.md and dev plan
 * section 7.3). This helper intercepts the provider at the HTTP layer with
 * `page.route`, so the application code under test is the real code path -
 * unlike an injected in-app fake gateway, which would replace the thing we are
 * trying to verify.
 *
 * The stub routes on prompt content, the same way the existing Stage 9 spec
 * does, and every branch is exhaustive by design: an unexpected prompt throws so
 * a schema change surfaces as a test failure rather than a silent default.
 */

export interface DeepSeekStubOptions {
  /** Overrides for the session-planning (blueprint) response body. */
  blueprint?: Record<string, unknown>;
  /** Overrides for the quiz generation response body. */
  quizTurn?: Record<string, unknown>;
  /** Overrides for the answer evaluation response body. */
  evaluation?: Record<string, unknown>;
  /** Overrides for the question quality review response body. */
  quality?: Record<string, unknown>;
  /** Overrides for the feedback interpretation response body. */
  interpretation?: Record<string, unknown>;
  /** Recorded prompts, for assertions about what the app actually sent. */
  seenPrompts?: string[];
}

const defaultQuizTurn = {
  status: "ok",
  practiceType: "variation",
  answerMode: "unique",
  question: "请说明该步骤为什么必须在这个位置执行。",
  answerCriteria: ["能准确说明来源中的关键规则"],
  sourceEvidence: [],
  hints: ["检查决策条件与执行顺序。"],
};

const defaultEvaluation = (criteria: string[]) => ({
  status: "ok",
  assessment: "correct",
  matchedCriteria: criteria,
  missingCriteria: [],
  rationale: "回答覆盖全部判据。",
});

/**
 * Installs the provider stub. Returns the recorded prompts so a test can assert
 * that, for example, no `interventionEffects` block is sent to planning anymore.
 */
export const stubDeepSeekProvider = async (page: Page, options: DeepSeekStubOptions = {}): Promise<string[]> => {
  const seenPrompts = options.seenPrompts ?? [];

  await page.route("https://api.deepseek.com/**", async (route: Route) => {
    const payload = route.request().postDataJSON() as { messages?: Array<{ content?: string }> };
    const prompt = payload.messages?.map((item) => item.content ?? "").join("\n") ?? "";
    seenPrompts.push(prompt);
    const inputText = prompt.slice(prompt.lastIndexOf("\n{") + 1);
    let input: Record<string, unknown> = {};
    try { input = JSON.parse(inputText) as Record<string, unknown>; } catch { /* branch selection below */ }

    let result: Record<string, unknown>;
    if (prompt.includes("按给定判据评估用户回答")) {
      const criteria = Array.isArray(input.answerCriteria) ? (input.answerCriteria as string[]) : [];
      result = { ...defaultEvaluation(criteria), ...options.evaluation };
    } else if (prompt.includes("独立检查题目是否无解")) {
      result = { status: "ok", verdict: "pass", severeIssues: [], rationale: "题目条件完整。", ...options.quality };
    } else if (prompt.includes("请把用户对学习决策块的原始评论整理成结构化理解")) {
      result = {
        status: "ok",
        actionability: "needs_training",
        difficultyType: "procedure",
        stuckAt: "关键步骤的执行顺序",
        userHypothesis: "边界条件尚未稳定",
        preferredPractice: "variation",
        missingInformation: [],
        confidence: 0.84,
        ...options.interpretation,
      };
    } else if (input.blueprint !== undefined) {
      result = {
        status: "ok",
        practiceType: "variation",
        answerMode: "unique",
        question: "请根据来源说明正确的边界规则。",
        answerCriteria: ["能准确说明来源中的关键规则"],
        sourceEvidence: (input.blueprint as { evidence?: unknown[] })?.evidence ?? [],
        hints: ["检查决策条件与执行顺序。"],
        ...options.blueprint,
      };
    } else {
      result = { ...defaultQuizTurn, ...options.quizTurn };
    }

    await route.fulfill({
      status: 200,
      contentType: "application/json",
      headers: { "x-request-id": "exocortex-e2e-stub" },
      body: JSON.stringify({
        id: "exocortex-e2e-stub",
        choices: [{ finish_reason: "stop", message: { content: JSON.stringify(result) } }],
        usage: { prompt_tokens: 120, completion_tokens: 40, total_tokens: 160 },
      }),
    });
  });

  return seenPrompts;
};

/** Fails the test if any request escapes the stub to a real provider host. */
export const expectNoRealProviderTraffic = async (page: Page): Promise<void> => {
  const leaks: string[] = [];
  page.on("request", (request) => {
    const url = request.url();
    if (/api\.(deepseek|openai|anthropic)\.com|generativelanguage\.googleapis\.com/.test(url)) {
      leaks.push(url);
    }
  });
  await expect.poll(() => leaks).toEqual([]);
};
