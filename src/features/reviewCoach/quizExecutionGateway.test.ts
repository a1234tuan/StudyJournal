import { beforeEach, describe, expect, it, vi } from "vitest";

import { sendChatCompletionDetailed } from "../../services/aiClientService";
import { REVIEW_COACH_ROLE_SYSTEM_PROMPT } from "./rolePrompts";
import { answerModes, quizPracticeTypes } from "./aiSchemas";
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

  it("sends the JSON-only role prompt instead of the conversational one (C-1)", async () => {
    vi.mocked(sendChatCompletionDetailed).mockResolvedValue({ content: JSON.stringify({ status: "ok", practiceType: "variation", answerMode: "open", question: "q", answerCriteria: ["c"], sourceEvidence: evidence, hints: [] }) });
    const gateway = createQuizExecutionGateway({ provider, apiKey: "secret" });
    await gateway.generateTurn({ blueprint: {}, decisionBlockContent: "source" });

    const request = vi.mocked(sendChatCompletionDetailed).mock.calls[0][0];
    expect(request.request?.systemPrompt).toBe(REVIEW_COACH_ROLE_SYSTEM_PROMPT);
  });

  it("derives the turn enums from the parser's own schema (C-2)", async () => {
    vi.mocked(sendChatCompletionDetailed).mockResolvedValue({ content: JSON.stringify({ status: "ok", practiceType: "variation", answerMode: "open", question: "q", answerCriteria: ["c"], sourceEvidence: evidence, hints: [] }) });
    const gateway = createQuizExecutionGateway({ provider, apiKey: "secret" });
    await gateway.generateTurn({ blueprint: {}, decisionBlockContent: "source" });

    const prompt = vi.mocked(sendChatCompletionDetailed).mock.calls[0][0].prompt!;
    const practiceTypeMatch = prompt.match(/"practiceType":"([^"]+)"/);
    const answerModeMatch = prompt.match(/"answerMode":"([^"]+)"/);
    // Strict set equality, order-independent: this is the assertion that catches the enum drifting
    // away from the parser again (three of the six old values were not valid practice types).
    expect(practiceTypeMatch![1].split("|").sort()).toEqual([...quizPracticeTypes].sort());
    expect(answerModeMatch![1].split("|").sort()).toEqual([...answerModes].sort());
  });

  it("offers the local leak verdict to the quality reviewer (C-4)", async () => {
    vi.mocked(sendChatCompletionDetailed).mockResolvedValue({ content: JSON.stringify({ status: "ok", verdict: "pass", severeIssues: [], rationale: "ok" }) });
    const gateway = createQuizExecutionGateway({ provider, apiKey: "secret" });
    await gateway.reviewQuestion({ candidate: {} });

    const prompt = vi.mocked(sendChatCompletionDetailed).mock.calls[0][0].prompt!;
    expect(prompt).toContain("answer-leakage");
    expect(prompt).toContain("泄露");
  });

  it("rejects malformed quality output", async () => {
    vi.mocked(sendChatCompletionDetailed).mockResolvedValue({ content: JSON.stringify({ status: "ok", verdict: "pass", severeIssues: ["invented"], rationale: "no" }) });
    const gateway = createQuizExecutionGateway({ provider, apiKey: "secret" });
    await expect(gateway.reviewQuestion({ candidate: {} })).rejects.toThrow();
  });

  it("hands the evaluator the material and warns that the criteria may be wrong", async () => {
    vi.mocked(sendChatCompletionDetailed).mockResolvedValue({ content: JSON.stringify({ status: "ok", assessment: "partial", matchedCriteria: ["states invariant"], missingCriteria: [], rationale: "partial" }) });
    const gateway = createQuizExecutionGateway({ provider, apiKey: "secret" });
    const material = "决策块材料：B 树的叶节点深度相同。";
    const result = await gateway.evaluateAnswer({ decisionBlockContent: material, answerCriteria: ["states invariant"] });
    expect(result).toMatchObject({ assessment: "partial" });
    const request = vi.mocked(sendChatCompletionDetailed).mock.calls[0][0];
    expect(request.prompt).toContain(material);
    expect(request.prompt).toContain("可能不完整或不准确");
    expect(request.prompt).toContain("必须同时对照 decisionBlockContent 判断");
    expect(request.request?.maxTokens).toBe(1400);
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
