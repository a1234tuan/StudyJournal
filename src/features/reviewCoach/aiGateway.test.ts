import { beforeEach, describe, expect, it, vi } from "vitest";

import { sendChatCompletionDetailed } from "../../services/aiClientService";
import { buildFeedbackInterpretationPrompt, createFeedbackInterpretationGateway } from "./aiGateway";

vi.mock("../../services/aiClientService", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../services/aiClientService")>(),
  sendChatCompletionDetailed: vi.fn(),
}));

const provider = {
  id: "test-provider",
  providerName: "Test",
  baseUrl: "https://example.test",
  model: "fast-model",
  temperature: 0,
  maxTokens: 1200,
};

describe("feedback interpretation gateway", () => {
  beforeEach(() => vi.mocked(sendChatCompletionDetailed).mockReset());

  it("builds a grounded prompt from the original comment and block content", () => {
    const prompt = buildFeedbackInterpretationPrompt({
      feedbackId: "feedback-1", decisionBlockId: "block-1", recordId: "record-1", contentVersion: 2,
      comment: "I keep mixing these steps.", decisionBlockContent: "Step A then Step B",
    });
    expect(prompt).toContain("I keep mixing these steps.");
    expect(prompt).toContain("Step A then Step B");
    expect(prompt).toContain("insufficient-context");
  });

  it("requests structured output and parses a fenced JSON response", async () => {
    vi.mocked(sendChatCompletionDetailed).mockResolvedValue({ content: "```json\n{\"status\":\"ok\",\"actionability\":\"needs_training\",\"difficultyType\":\"concept\",\"stuckAt\":null,\"userHypothesis\":null,\"preferredPractice\":null,\"missingInformation\":[],\"confidence\":0.7}\n```" });
    const gateway = createFeedbackInterpretationGateway({ provider, apiKey: "secret" });
    await expect(gateway.interpretFeedback({
      feedbackId: "feedback-1", decisionBlockId: "block-1", recordId: "record-1", contentVersion: 1,
      comment: "Why?", decisionBlockContent: "Context",
    })).resolves.toMatchObject({ response: { status: "ok", confidence: 0.7 } });
    expect(vi.mocked(sendChatCompletionDetailed).mock.calls[0][0].request?.structuredOutput).toBe(true);
  });

  it("rejects non-JSON model output", async () => {
    vi.mocked(sendChatCompletionDetailed).mockResolvedValue({ content: "not json" });
    const gateway = createFeedbackInterpretationGateway({ provider, apiKey: "secret" });
    await expect(gateway.interpretFeedback({ feedbackId: "f", decisionBlockId: "b", recordId: "r", contentVersion: 1, comment: "x", decisionBlockContent: "y" })).rejects.toThrow("有效 JSON");
  });
});
