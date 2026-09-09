import { afterEach, describe, expect, it, vi } from "vitest";

import type { AiChatAttachment, AiChatMessage, AiContextPack } from "../types";
import {
  buildAiMessages,
  buildUserPromptWithImages,
  buildSessionMemorySummary,
  calculateAiRequestBudget,
  DEFAULT_AI_REQUEST_TIMEOUT_MS,
  normalizeAiChatCompletionsUrl,
  parseOpenAiCompletionResult,
  selectRecentChatContext,
  sendChatCompletion,
  sendChatCompletionDetailed,
  testAiProviderConnection,
} from "./aiClientService";
import { estimateAiTokens } from "./aiContextService";

const stamp = "2026-06-22T00:00:00.000Z";

const message = (role: AiChatMessage["role"], content: string, error?: string): AiChatMessage => ({
  id: `${role}-${content}`,
  sessionId: "session",
  createdAt: stamp,
  updatedAt: stamp,
  role,
  content,
  error,
});

const attachment: AiContextPack = {
  date: "2026-06-22",
  recordIds: ["record-1"],
  markdown: "# 2026-06-22 学习日志\n\n今天学习了 B 树。",
  summary: "当天学习 B 树。",
  selectedChunks: [
    {
      chunkId: "record-1-text-1",
      recordId: "record-1",
      date: "2026-06-22",
      subject: "数据结构",
      title: "B树",
      kind: "text",
      content: "今天学习了 B 树。",
      sourceLabel: "数据结构 / B树 / 正文",
      order: 0,
    },
  ],
  allChunks: [],
  totalChunks: 1,
  estimatedChars: 10,
  contextHash: "hash",
  warnings: [],
  skippedAssets: [],
  missingOcrAssetIds: [],
};

const imageAttachment = (patch: Partial<AiChatAttachment> = {}): AiChatAttachment => ({
  id: "image-1",
  sessionId: "session",
  createdAt: stamp,
  updatedAt: stamp,
  fileName: "answer.jpg",
  mimeType: "image/jpeg",
  size: 12,
  data: new Blob(["image"], { type: "image/jpeg" }),
  ocrStatus: "done",
  ocrText: "手写作答内容",
  ...patch,
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("buildAiMessages", () => {
  it("asks the model to follow the current task with concise Markdown and no HTML", () => {
    const messages = buildAiMessages(undefined, [], "继续");
    const systemPrompt = String(messages[0].content);

    expect(systemPrompt).toContain("优先执行用户当前请求");
    expect(systemPrompt).toContain("日志外补充");
    expect(systemPrompt).toContain("不要默认必须等待用户回答");
    expect(systemPrompt).toContain("Markdown 和 LaTeX");
    expect(systemPrompt).toContain("不要输出 HTML");
  });

  it("builds OpenAI-compatible messages with log context and history", () => {
    const messages = buildAiMessages(
      attachment,
      [
        message("user", "先问我一个问题"),
        message("assistant", "B 树的阶是什么意思？"),
        message("assistant", "网络错误", "网络错误"),
      ],
      "继续追问",
    );

    expect(messages[0]).toEqual(expect.objectContaining({ role: "system" }));
    expect(messages[1]).toEqual(expect.objectContaining({
      role: "system",
      content: expect.stringContaining("今天学习了 B 树。"),
    }));
    expect(messages[1].content).toContain("依据来源");
    expect(messages[1].content).toContain("[[S1]]");
    expect(messages.map((item) => item.content)).toEqual(
      expect.arrayContaining(["先问我一个问题", "B 树的阶是什么意思？", "继续追问"]),
    );
    expect(messages.map((item) => item.content)).not.toContain("网络错误");
    expect(messages[messages.length - 1]).toEqual({ role: "user", content: "继续追问" });
  });

  it("keeps only the latest memory turns and skips failed messages", () => {
    const history: AiChatMessage[] = [];
    for (let index = 1; index <= 14; index += 1) {
      history.push(message("user", `问题 ${index}`));
      history.push(message("assistant", `回答 ${index}`));
    }
    history.splice(6, 0, message("assistant", "失败回答", "失败回答"));

    const context = selectRecentChatContext(history, 12);

    expect(context[0]).toEqual({ role: "user", content: "问题 3" });
    expect(context[1]).toEqual({ role: "assistant", content: "回答 3" });
    expect(context.at(-2)).toEqual({ role: "user", content: "问题 14" });
    expect(context.at(-1)).toEqual({ role: "assistant", content: "回答 14" });
    expect(context.map((item) => item.content)).not.toContain("失败回答");
    expect(context).toHaveLength(24);
  });

  it("passes only the selected memory window to the OpenAI messages", () => {
    const history = [
      message("user", "旧问题"),
      message("assistant", "旧回答"),
      message("user", "新问题"),
      message("assistant", "新回答"),
    ];

    const messages = buildAiMessages(attachment, history, "继续", 1);

    expect(messages.map((item) => item.content)).not.toContain("旧问题");
    expect(messages.map((item) => item.content)).toEqual(expect.arrayContaining(["新问题", "新回答", "继续"]));
  });

  it("never exceeds the 4K history budget even when a single prior turn is very long", () => {
    const context = selectRecentChatContext([
      message("user", "旧问题".repeat(3000)),
      message("assistant", "旧回答".repeat(3000)),
      message("user", "最近问题"),
      message("assistant", "最近回答"),
    ]);

    const tokens = context.reduce((sum, item) => sum + estimateAiTokens(String(item.content)), 0);
    expect(tokens).toBeLessThanOrEqual(4000);
    expect(context.map((item) => item.content)).toEqual(["最近问题", "最近回答"]);
  });

  it("includes session memory summary before recent turns", () => {
    const messages = buildAiMessages(attachment, [], "继续", 12, "用户前面一直答错 B 树高度。");

    expect(messages.map((item) => item.content).join("\n")).toContain("滚动记忆摘要");
    expect(messages.map((item) => item.content).join("\n")).toContain("B 树高度");
  });

  it("builds a local memory summary from older valid messages", () => {
    const history: AiChatMessage[] = [];
    for (let index = 1; index <= 15; index += 1) {
      history.push(message("user", `问题 ${index}`));
      history.push(message("assistant", `回答 ${index}`));
    }
    history.push(message("assistant", "失败", "失败"));

    const summary = buildSessionMemorySummary(history, 2);

    expect(summary).toContain("较早对话要点");
    expect(summary).toContain("问题");
    expect(summary).not.toContain("失败");
  });

  it("normalizes OpenAI-compatible chat completions URLs", () => {
    expect(normalizeAiChatCompletionsUrl("https://api.deepseek.com")).toBe("https://api.deepseek.com/chat/completions");
    expect(normalizeAiChatCompletionsUrl("https://integrate.api.nvidia.com/v1/")).toBe("https://integrate.api.nvidia.com/v1/chat/completions");
    expect(normalizeAiChatCompletionsUrl("https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions")).toBe(
      "https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions",
    );
    expect(normalizeAiChatCompletionsUrl("https://api.vectorengine.ai")).toBe("https://api.vectorengine.ai/chat/completions");
  });

  it("tests provider connections with a minimal prompt and no log context", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ choices: [{ message: { content: "OK" } }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await testAiProviderConnection({
      provider: {
        id: "custom",
        providerName: "中转 API",
        baseUrl: "https://relay.example/v1",
        model: "gpt-test",
        temperature: 0.7,
        maxTokens: 4096,
      },
      apiKey: "sk-test",
    });

    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    expect(result.requestUrl).toBe("https://relay.example/v1/chat/completions");
    expect(body).toMatchObject({
      model: "gpt-test",
      max_tokens: 16,
      messages: [{ role: "user", content: "请只回复 OK。" }],
    });
    expect(JSON.stringify(body)).not.toContain("学习日志上下文");
  });

  it("preserves empty final content, finish reason and reasoning token diagnostics", () => {
    const result = parseOpenAiCompletionResult({
      id: "completion-1",
      choices: [{ message: { content: null, reasoning_content: "not exposed" }, finish_reason: "length" }],
      usage: {
        prompt_tokens: 120,
        completion_tokens: 16384,
        total_tokens: 16504,
        completion_tokens_details: { reasoning_tokens: 16120 },
        prompt_tokens_details: { cached_tokens: 80 },
      },
    }, "request-header-id");

    expect(result).toEqual({
      content: "",
      finishReason: "length",
      usage: {
        promptTokens: 120,
        completionTokens: 16384,
        totalTokens: 16504,
        reasoningTokens: 16120,
        cachedPromptTokens: 80,
      },
      requestId: "request-header-id",
    });
    expect(JSON.stringify(result)).not.toContain("not exposed");
  });

  it("sends task-level structured thinking options without changing normal chat defaults", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      choices: [{ message: { content: "{}" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 12, completion_tokens: 4, total_tokens: 16 },
    }), { status: 200, headers: { "content-type": "application/json", "x-request-id": "req-structured" } }));
    vi.stubGlobal("fetch", fetchMock);
    const provider = {
      id: "deepseek",
      providerName: "DeepSeek",
      baseUrl: "https://api.deepseek.com",
      model: "deepseek-v4-pro",
      temperature: 0.7,
      maxTokens: 4096,
      contextWindowTokens: 65_536,
    };

    const result = await sendChatCompletionDetailed({
      provider,
      apiKey: "test",
      history: [],
      prompt: "输出 JSON",
      budget: {
        contextWindowTokens: 65_536,
        outputTokens: 16_384,
        historyTokens: 0,
        retrievalMode: "coverage",
        retrievalTargetTokens: 24_000,
        retrievalTokens: 24_000,
        selectedContextTokens: 24_000,
        estimatedInputTokens: 26_000,
      },
      request: {
        maxTokens: 16_384,
        structuredOutput: true,
        thinkingMode: "enabled",
        reasoningEffort: "high",
        timeoutMs: 300_000,
      },
    });

    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    expect(body).toMatchObject({
      model: "deepseek-v4-pro",
      max_tokens: 16_384,
      response_format: { type: "json_object" },
      thinking: { type: "enabled" },
      reasoning_effort: "high",
    });
    expect(result).toMatchObject({ content: "{}", finishReason: "stop", requestId: "req-structured" });
  });

  it("reports HTML responses as likely Base URL path errors", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(
      new Response("<!doctype html><html><body>portal</body></html>", {
        status: 200,
        headers: { "content-type": "text/html; charset=utf-8" },
      }),
    ));

    await expect(testAiProviderConnection({
      provider: {
        id: "custom",
        providerName: "中转 API",
        baseUrl: "https://relay.example",
        model: "gpt-test",
        temperature: 0.7,
        maxTokens: 4096,
      },
      apiKey: "sk-test",
    })).rejects.toThrow(/不是 OpenAI 兼容 JSON.*Base URL 路径错误/);
  });

  it("builds OpenAI multimodal content for direct image mode", async () => {
    const content = await buildUserPromptWithImages({
      prompt: "请批改",
      imageInputMode: "vision",
      imageAttachments: [imageAttachment()],
    });

    expect(Array.isArray(content)).toBe(true);
    expect(content).toEqual([
      { type: "text", text: "请批改" },
      expect.objectContaining({
        type: "image_url",
        image_url: expect.objectContaining({ url: expect.stringContaining("data:image/jpeg;base64,") }),
      }),
    ]);
  });

  it("builds Markdown OCR content for local OCR image mode", async () => {
    const content = await buildUserPromptWithImages({
      prompt: "看看哪里错了",
      imageInputMode: "local-ocr",
      imageAttachments: [imageAttachment()],
    });

    expect(content).toContain("看看哪里错了");
    expect(content).toContain("本轮图片 OCR 内容");
    expect(content).toContain("手写作答内容");
  });

  it("blocks image messages when image sending is disabled", async () => {
    await expect(
      buildUserPromptWithImages({
        prompt: "",
        imageInputMode: "disabled",
        imageAttachments: [imageAttachment()],
      }),
    ).rejects.toThrow("图片发送已关闭");
  });

  it("uses the focused 16K retrieval target for a normal question on a 64K model", () => {
    const budget = calculateAiRequestBudget({
      provider: {
        id: "provider",
        providerName: "测试",
        baseUrl: "https://example.com/v1",
        model: "test",
        temperature: 0.7,
        maxTokens: 4096,
        contextWindowTokens: 65536,
      },
      history: Array.from({ length: 20 }, (_, index) => message(index % 2 === 0 ? "user" : "assistant", `第 ${index} 轮`)),
      prompt: "B树的阶是什么意思？",
      memorySummary: "较早对话摘要",
    });

    expect(budget.retrievalMode).toBe("focused");
    expect(budget.retrievalTargetTokens).toBe(16000);
    expect(budget.retrievalTokens).toBe(16000);
    expect(budget.historyTokens).toBeLessThanOrEqual(4000);
    expect(budget.estimatedInputTokens + budget.outputTokens).toBeLessThanOrEqual(budget.contextWindowTokens);
  });

  it("uses the 24K coverage target for quizzes and counts source wrappers in the actual input estimate", () => {
    const budget = calculateAiRequestBudget({
      provider: {
        id: "provider",
        providerName: "测试",
        baseUrl: "https://example.com/v1",
        model: "test",
        temperature: 0.7,
        maxTokens: 4096,
        contextWindowTokens: 65536,
      },
      attachment,
      history: [],
      prompt: "请抽测这个范围",
    });

    expect(budget.retrievalMode).toBe("coverage");
    expect(budget.retrievalTargetTokens).toBe(24000);
    expect(budget.retrievalTokens).toBe(24000);
    expect(budget.selectedContextTokens).toBeGreaterThan(estimateAiTokens(attachment.selectedChunks[0].content));
    expect(budget.estimatedInputTokens + budget.outputTokens).toBeLessThanOrEqual(budget.contextWindowTokens);
  });

  it("shrinks retrieval on a 32K provider without exceeding its context window", () => {
    const budget = calculateAiRequestBudget({
      provider: {
        id: "provider-32k",
        providerName: "测试",
        baseUrl: "https://example.com/v1",
        model: "test",
        temperature: 0.7,
        maxTokens: 4096,
        contextWindowTokens: 32768,
      },
      history: Array.from({ length: 24 }, (_, index) => message(index % 2 === 0 ? "user" : "assistant", `第 ${index} 轮`)),
      prompt: "请总结这个范围",
      memorySummary: "较早对话摘要",
    });

    expect(budget.retrievalTokens).toBeLessThanOrEqual(24000);
    expect(budget.historyTokens).toBeLessThanOrEqual(4000);
    expect(budget.estimatedInputTokens + budget.outputTokens).toBeLessThanOrEqual(32768);
  });

  it("blocks a provider configuration that cannot leave 2K tokens for retrieval", () => {
    expect(() => calculateAiRequestBudget({
      provider: {
        id: "small",
        providerName: "测试",
        baseUrl: "https://example.com/v1",
        model: "test",
        temperature: 0.7,
        maxTokens: 4096,
        contextWindowTokens: 6000,
      },
      history: [],
      prompt: "测试",
    })).toThrow("至少 2K token");
  });
});

describe("AI chat request timeout and cancellation", () => {
  const chatProvider = {
    id: "deepseek",
    providerName: "DeepSeek",
    baseUrl: "https://api.deepseek.com",
    model: "deepseek-v4-pro",
    temperature: 0.7,
    maxTokens: 4096,
    contextWindowTokens: 65_536,
  };

  it("stops waiting after the default timeout instead of hanging the composer forever", async () => {
    vi.useFakeTimers();
    try {
      vi.stubGlobal("fetch", vi.fn((_url: string, init: RequestInit) => new Promise((_resolve, reject) => {
        init.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
      })));
      const pending = sendChatCompletion({ provider: chatProvider, apiKey: "test", history: [], prompt: "你好" });
      const assertion = expect(pending).rejects.toThrow(`等待超过 ${DEFAULT_AI_REQUEST_TIMEOUT_MS / 1000} 秒`);
      await vi.advanceTimersByTimeAsync(DEFAULT_AI_REQUEST_TIMEOUT_MS + 1);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });

  it("forwards the caller's AbortSignal so a send can be cancelled", async () => {
    const controller = new AbortController();
    vi.stubGlobal("fetch", vi.fn((_url: string, init: RequestInit) => new Promise((_resolve, reject) => {
      const fail = () => reject(new DOMException("aborted", "AbortError"));
      if (init.signal?.aborted) {
        fail();
        return;
      }
      init.signal?.addEventListener("abort", fail);
      queueMicrotask(() => controller.abort());
    })));

    const pending = sendChatCompletion({
      provider: chatProvider,
      apiKey: "test",
      history: [],
      prompt: "你好",
      signal: controller.signal,
    });

    await expect(pending).rejects.toThrow();
    expect(controller.signal.aborted).toBe(true);
  });
});
