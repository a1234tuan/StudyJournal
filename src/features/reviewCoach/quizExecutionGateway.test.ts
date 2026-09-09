import { beforeEach, describe, expect, it, vi } from "vitest";

import { sendChatCompletionDetailed } from "../../services/aiClientService";
import { createQuizExecutionGateway } from "./quizExecutionGateway";

vi.mock("../../services/aiClientService", async (importOriginal) => ({ ...await importOriginal<typeof import("../../services/aiClientService")>(), sendChatCompletionDetailed: vi.fn() }));

const provider = { id: "deep", providerName: "DeepSeek", baseUrl: "https://api.deepseek.com", model: "deepseek-v4-flash", temperature: 0, maxTokens: 8000 };
const evidence = [{ decisionBlockId: "block-1", recordId: "record-1", contentVersion: 1, excerptHash: "hash-1", purpose: "source" }];

describe("quiz execution gateway", () => {
  beforeEach(() => vi.mocked(sendChatCompletionDetailed).mockReset());

  it("requests structured JSON and parses a quiz turn", async () => {
    vi.mocked(sendChatCompletionDetailed).mockResolvedValue({ content: JSON.stringify({ status: "ok", practiceType: "variation", answerMode: "unique", question: "Choose the correct boundary.", answerCriteria: ["right inclusive"], sourceEvidence: evidence, hints: ["Check the invariant."] }), requestId: "turn-1", usage: { totalTokens: 120 } });
    const gateway = createQuizExecutionGateway({ provider, apiKey: "secret" });
    const result = await gateway.generateTurn({ blueprint: {}, decisionBlockContent: "source" });
    expect(result).toMatchObject({ status: "ok", answerMode: "unique" });
    const request = vi.mocked(sendChatCompletionDetailed).mock.calls[0][0];
    expect(request.request).toMatchObject({ structuredOutput: true, thinkingMode: "disabled" });
    expect(request.prompt).toContain('"answerCriteria":["..."]');
    expect(request.prompt).toContain("input.blueprint.evidence 原样复制");
  });

  it("rejects malformed quality output", async () => {
    vi.mocked(sendChatCompletionDetailed).mockResolvedValue({ content: JSON.stringify({ status: "ok", verdict: "pass", severeIssues: ["invented"], rationale: "no" }) });
    const gateway = createQuizExecutionGateway({ provider, apiKey: "secret" });
    await expect(gateway.reviewQuestion({ candidate: {} })).rejects.toThrow();
  });
});

it("uses each role's own timeout and forwards cancellation", async () => {
  vi.mocked(sendChatCompletionDetailed).mockResolvedValue({ content: JSON.stringify({ status: "insufficient-context", missingInformation: ["材料"] }) });
  const gateway = createQuizExecutionGateway({ provider, apiKey: "test-only", roleTimeouts: { "turn-generator": 11000, "question-quality-reviewer": 22000, "answer-evaluator": 33000 } });
  const signal = new AbortController().signal;
  await gateway.generateTurn({}, signal);
  await gateway.reviewQuestion({}, signal);
  await gateway.evaluateAnswer({}, signal);
  const requests = vi.mocked(sendChatCompletionDetailed).mock.calls.slice(-3).map(([request]) => request.request);
  expect(requests.map((request) => request?.timeoutMs)).toEqual([11000, 22000, 33000]);
  expect(requests.every((request) => request?.signal === signal)).toBe(true);
});
