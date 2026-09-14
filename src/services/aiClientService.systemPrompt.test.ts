import { afterEach, describe, expect, it, vi } from "vitest";

import { CHAT_SYSTEM_PROMPT, buildAiMessages, sendChatCompletionDetailed } from "./aiClientService";
import { REVIEW_COACH_ROLE_SYSTEM_PROMPT } from "../features/reviewCoach/rolePrompts";

const provider = {
  id: "deep",
  providerName: "Deep",
  baseUrl: "https://api.example.test/v1",
  model: "deepseek-v4-flash",
  temperature: 0.3,
  maxTokens: 4096,
};

const attachment = {
  date: "2026-09-14",
  recordIds: ["record-1"],
  markdown: "# 日志\n\nB 树。",
  summary: "B 树。",
  selectedChunks: [],
  warnings: [],
} as unknown as Parameters<typeof buildAiMessages>[0];

const fetchMock = () => {
  // A fresh Response per call: a single shared instance would be "already read" on the second
  // invocation and surface as a CORS-shaped TypeError instead of a test failure.
  const mock = vi.fn().mockImplementation(async () => new Response(
    JSON.stringify({ id: "c1", choices: [{ message: { content: "{}" } }], usage: { total_tokens: 10 } }),
    { status: 200, headers: { "content-type": "application/json" } },
  ));
  vi.stubGlobal("fetch", mock);
  return mock;
};

describe("AI system prompt routing (F-17)", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("sends the role prompt, never the conversational one, for structured calls", async () => {
    const mock = fetchMock();
    await sendChatCompletionDetailed({
      provider,
      apiKey: "sk-test",
      history: [],
      prompt: "请输出 JSON。",
      request: { structuredOutput: true, systemPrompt: REVIEW_COACH_ROLE_SYSTEM_PROMPT },
    });

    const body = JSON.parse(mock.mock.calls[0][1].body as string) as { messages: Array<{ role: string; content: string }>; systemPrompt?: string };
    expect(body.messages.filter((item) => item.role === "system")).toHaveLength(1);
    expect(body.messages[0]).toEqual({ role: "system", content: REVIEW_COACH_ROLE_SYSTEM_PROMPT });

    // The specific conflict F-17 describes: the default prompt *required* Markdown/LaTeX and a
    // trailing source list while every coach gateway demanded JSON and nothing else. The role
    // prompt must not require them — it forbids them, which is why the negative wording stays.
    const systemText = body.messages[0].content;
    expect(systemText).not.toContain("使用 Markdown 和 LaTeX");
    expect(systemText).not.toContain("列出依据来源");
    expect(systemText).toContain("不要 Markdown");

    // The override travels in-memory only; it must never become a request field. (`systemPrompt`
    // would be an unknown parameter to the provider, and the whitelist below is what prevents it.)
    expect(body.systemPrompt).toBeUndefined();
    expect(Object.keys(body)).not.toContain("systemPrompt");
  });

  it("keeps the conversational default when no role prompt is given", async () => {
    const mock = fetchMock();
    await sendChatCompletionDetailed({ provider, apiKey: "sk-test", history: [], prompt: "你好" });

    const body = JSON.parse(mock.mock.calls[0][1].body as string) as { messages: Array<{ content: string }> };
    expect(body.messages[0].content).toBe(CHAT_SYSTEM_PROMPT);
    expect(body.messages[0].content).toContain("Markdown");
  });

  it("does not accumulate a second role prompt when the same call is retried", async () => {
    const mock = fetchMock();
    const call = () => sendChatCompletionDetailed({
      provider,
      apiKey: "sk-test",
      history: [],
      prompt: "请输出 JSON。",
      request: { structuredOutput: true, systemPrompt: REVIEW_COACH_ROLE_SYSTEM_PROMPT },
    });
    await call();
    await call();

    for (const invocation of mock.mock.calls) {
      const body = JSON.parse(invocation[1].body as string) as { messages: Array<{ role: string; content: string }> };
      expect(body.messages.filter((item) => item.role === "system" && item.content === REVIEW_COACH_ROLE_SYSTEM_PROMPT)).toHaveLength(1);
    }
  });

  it("still emits only one role prompt alongside a log-context block", () => {
    const messages = buildAiMessages(attachment, [], "请输出 JSON。", undefined, undefined, undefined, REVIEW_COACH_ROLE_SYSTEM_PROMPT);

    expect(messages.filter((item) => item.content === REVIEW_COACH_ROLE_SYSTEM_PROMPT)).toHaveLength(1);
    // The log-context block is a separate system message and must not become a second role prompt.
    expect(messages.filter((item) => item.role === "system")).toHaveLength(2);
    expect(messages[0].content).toBe(REVIEW_COACH_ROLE_SYSTEM_PROMPT);
  });
});
