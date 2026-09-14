import { describe, expect, it, vi } from "vitest";

import type { AiProviderProfile } from "../../types";
import { OpenAiCompatibleLlmStreamAdapter } from "./openAiLlmStreamAdapter";

const profile = (voiceThinkingMode?: AiProviderProfile["voiceThinkingMode"]): AiProviderProfile => ({
  id: "voice-provider",
  providerName: "测试供应商",
  baseUrl: "https://example.test/v1",
  model: "voice-model",
  temperature: 0.2,
  maxTokens: 224,
  contextWindowTokens: 4096,
  voiceThinkingMode,
});

const request = () => ({
  sessionId: "session-1",
  turnId: "turn-1",
  operationId: "operation-1",
  signal: new AbortController().signal,
  messages: [{ role: "user" as const, content: "请解释这个概念。", contentBoundary: "user-utterance" as const }],
});

const response = () => new Response([
  `data: ${JSON.stringify({ choices: [{ delta: { reasoning_content: "内部推理" } }] })}`,
  `data: ${JSON.stringify({ choices: [{ delta: { content: "这是正文。" } }] })}`,
  "data: [DONE]",
  "",
].join("\n\n"), { headers: { "Content-Type": "text/event-stream" } });

describe("OpenAiCompatibleLlmStreamAdapter", () => {
  it.each([undefined, "disabled"] as const)("does not send thinking for %s", async (voiceThinkingMode) => {
    const fetchImplementation = vi.fn(async () => response()) as unknown as typeof fetch;
    const adapter = new OpenAiCompatibleLlmStreamAdapter(profile(voiceThinkingMode), "test-key", fetchImplementation);

    const events = [];
    for await (const event of adapter.complete(request())) events.push(event);

    const body = JSON.parse(String((fetchImplementation as unknown as ReturnType<typeof vi.fn>).mock.calls[0][1]?.body));
    expect(body.max_tokens).toBe(224);
    expect(body.thinking).toBeUndefined();
    expect(events).toContainEqual({ type: "token", text: "这是正文。" });
    expect(events).not.toContainEqual({ type: "token", text: "内部推理" });
  });

  it("sends thinking only when the profile explicitly enables it", async () => {
    const fetchImplementation = vi.fn(async () => response()) as unknown as typeof fetch;
    const adapter = new OpenAiCompatibleLlmStreamAdapter(profile("enabled"), "test-key", fetchImplementation);

    for await (const event of adapter.complete(request())) void event;

    const body = JSON.parse(String((fetchImplementation as unknown as ReturnType<typeof vi.fn>).mock.calls[0][1]?.body));
    expect(body.thinking).toEqual({ type: "enabled" });
  });
});
