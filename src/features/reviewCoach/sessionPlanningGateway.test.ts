import { beforeEach, describe, expect, it, vi } from "vitest";

import { sendChatCompletionDetailed } from "../../services/aiClientService";
import { buildSessionPlanningPrompt, createSessionPlanningGateway } from "./sessionPlanningGateway";

vi.mock("../../services/aiClientService", async (importOriginal) => ({ ...await importOriginal<typeof import("../../services/aiClientService")>(), sendChatCompletionDetailed: vi.fn() }));

const provider = { id: "deep", providerName: "Deep", baseUrl: "https://example.test", model: "deep-model", temperature: 0, maxTokens: 8000 };
const candidate = {
  mainDecisionBlockId: "block-1", contentVersion: 1, supportingDecisionBlockIds: [], feedbackIds: ["feedback-1"], interpretationIds: [],
  problemHypothesis: "order", hypothesisConfidence: 0.8, objective: "apply order", completionCriteria: ["correct order"],
  initialPracticeType: "variation", initialDifficulty: 2, expectedKeyPoints: ["mark first"],
  branches: [{ when: "correct", nextStrategy: "finish" }, { when: "partial", nextStrategy: "hint" }, { when: "incorrect", nextStrategy: "explain" }, { when: "skipped", nextStrategy: "prerequisite-check" }],
  allowedStrategies: ["finish", "hint", "explain", "prerequisite-check"], forbiddenScope: ["other"],
  evidence: [{ decisionBlockId: "block-1", recordId: "record-1", contentVersion: 1, excerptHash: "hash-1", purpose: "source" }],
  maxTurns: 4, maxRetriesPerTurn: 1, maxEstimatedTokens: 4000,
};

describe("session planning gateway", () => {
  beforeEach(() => vi.mocked(sendChatCompletionDetailed).mockReset());

  it("pins role boundaries and source hashes in the prompt", () => {
    const prompt = buildSessionPlanningPrompt({ blocks: [{ decisionBlockId: "block-1", recordId: "record-1", contentVersion: 1, recordTitle: "BFS", subject: "DS", contextMarkdown: "context", excerptHash: "hash-1", feedback: [] }], allowedSupportingDecisionBlockIds: [] });
    expect(prompt).toContain("不得补造来源");
    expect(prompt).toContain("hash-1");
    expect(prompt).toContain("session-blueprint-v1");
  });

  it("requests strict JSON and returns token diagnostics", async () => {
    vi.mocked(sendChatCompletionDetailed).mockResolvedValue({ content: JSON.stringify({ status: "ok", summary: "done", blueprints: [candidate] }), usage: { totalTokens: 900 }, requestId: "request-1" });
    const gateway = createSessionPlanningGateway({ provider, apiKey: "secret" });
    const result = await gateway.planSession({ blocks: [], allowedSupportingDecisionBlockIds: [] });

    expect(result).toMatchObject({ response: { status: "ok", summary: "done" }, usage: { totalTokens: 900 }, requestId: "request-1" });
    expect(vi.mocked(sendChatCompletionDetailed).mock.calls[0][0].request?.structuredOutput).toBe(true);
  });
});
