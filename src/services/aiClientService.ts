import type { AiChatAttachment, AiChatMessage, AiCompletionResult, AiCompletionUsage, AiContextPack, AiProviderProfile } from "../types";
import { DEFAULT_AI_CONTEXT_WINDOW_TOKENS, DEFAULT_AI_MEMORY_TURNS } from "../lib/aiProviders";
import { blobToBase64 } from "./backup";
import { canUseNativeAi, runNativeAiChat } from "./nativeAi";
import {
  COVERAGE_AI_RETRIEVAL_TOKENS,
  estimateAiContextSourceTokens,
  estimateAiTokens,
  FOCUSED_AI_RETRIEVAL_TOKENS,
  formatAiContextSource,
  getAiRetrievalMode,
  type AiRetrievalMode,
} from "./aiContextService";

export type AiChatPayloadContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string; detail?: "auto" | "low" | "high" } };

export type AiChatPayloadMessage = {
  role: "system" | "user" | "assistant";
  content: string | AiChatPayloadContentPart[];
};

export interface AiConnectionTestResult {
  requestUrl: string;
  content: string;
}

/** Default wall-clock cap for a chat completion. Callers may override it (the
 * podcast script builder uses 5 minutes); without it a stalled connection left
 * the composer disabled until the user reloaded the app. */
export const DEFAULT_AI_REQUEST_TIMEOUT_MS = 120_000;

/** Carries whether a retry can possibly succeed, so callers stop re-billing
 * requests that failed for a deterministic reason (bad key, wrong Base URL,
 * schema mismatch, CORS). */
export class AiRequestError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
    readonly status?: number,
    /** True when the message tells the user exactly what to fix. */
    readonly actionable = false,
    readonly retryAfterMs?: number,
    readonly category = status === 401 || status === 403 ? "authentication" : status === 429 ? "rate-limit" : status === 408 ? "timeout" : status && status >= 500 ? "network" : actionable ? "configuration" : retryable ? "network" : "response",
  ) {
    super(message);
    this.name = "AiRequestError";
  }
}

export class AiSchemaError extends AiRequestError {
  constructor(message: string) { super(message, false, undefined, false, undefined, "schema"); this.name = "AiSchemaError"; }
}

export interface AiCompletionRequestOptions {
  structuredOutput?: boolean;
  thinkingMode?: "enabled" | "disabled";
  reasoningEffort?: "low" | "high" | "max";
  timeoutMs?: number;
  signal?: AbortSignal;
}

const SYSTEM_PROMPT = [
  "你是一个基于用户本地学习日志工作的学习助手。优先执行用户当前请求和所选预设，不要把所有任务固定成同一种回答流程。",
  "优先依据日志内容回答；日志没有的信息不要伪装成来自日志。需要补充通用知识时，请标明“日志外补充”。证据不足时直接说“不确定”或“日志中没有足够依据”。",
  "如果用户要求出题、批改、追问或测试，请按用户当前要求决定是否给答案、是否等待作答；不要默认必须等待用户回答。",
  "回答要清晰、具体、可复习。使用 Markdown 和 LaTeX，不要输出 HTML。使用日志内容时，结尾简短列出依据来源。",
].join("\n");

export const normalizeAiChatCompletionsUrl = (baseUrl: string): string => {
  const trimmed = baseUrl.trim().replace(/\/+$/, "");
  if (!trimmed) {
    throw new AiRequestError("请先填写 AI 接口 Base URL。", false, undefined, true);
  }
  return trimmed.endsWith("/chat/completions") ? trimmed : `${trimmed}/chat/completions`;
};

const responseSnippet = (text: string, maxLength = 180): string => {
  const compact = text.replace(/\s+/g, " ").trim();
  return compact.length > maxLength ? `${compact.slice(0, maxLength)}...` : compact;
};

const isLikelyHtmlResponse = (text: string, contentType: string): boolean =>
  contentType.toLowerCase().includes("text/html") || /^\s*<!doctype\b/i.test(text) || /^\s*<html\b/i.test(text);

const formatResponseMeta = (status: number, contentType: string, requestUrl: string): string =>
  [
    `HTTP ${status}`,
    contentType ? `Content-Type：${contentType}` : "",
    `请求地址：${requestUrl}`,
  ].filter(Boolean).join("，");

const tryParseJson = (text: string): { ok: true; value: unknown } | { ok: false } => {
  try {
    return { ok: true, value: text ? JSON.parse(text) : {} };
  } catch {
    return { ok: false };
  }
};

const MEMORY_SUMMARY_TURNS = 12;
export const MAX_AI_HISTORY_TOKENS = 4_000;
const SYSTEM_AND_SAFETY_RESERVE_TOKENS = 1_200;
const CONTEXT_PROMPT_RESERVE_TOKENS = 600;
const MIN_AI_RETRIEVAL_TOKENS = 2_000;

export interface AiRequestBudget {
  contextWindowTokens: number;
  outputTokens: number;
  historyTokens: number;
  retrievalMode: AiRetrievalMode;
  retrievalTargetTokens: number;
  retrievalTokens: number;
  selectedContextTokens: number;
  estimatedInputTokens: number;
}

const plainTextForMemory = (message: AiChatMessage): string => {
  const attachmentNote = message.attachmentIds?.length ? `\n[用户上传了 ${message.attachmentIds.length} 张图片]` : "";
  return `${message.content}${attachmentNote}`.trim();
};

export const selectRecentChatContext = (
  history: AiChatMessage[],
  memoryTurns = DEFAULT_AI_MEMORY_TURNS,
  maxTokens = MAX_AI_HISTORY_TOKENS,
): AiChatPayloadMessage[] => {
  const cleanHistory = history.filter((message) => message.role !== "system" && !message.error);
  const turns: AiChatPayloadMessage[][] = [];
  let pendingUser: AiChatPayloadMessage | null = null;

  for (const message of cleanHistory) {
    if (message.role === "user") {
      if (pendingUser) {
        turns.push([pendingUser]);
      }
      pendingUser = { role: "user", content: plainTextForMemory(message) };
      continue;
    }

    if (message.role === "assistant") {
      if (pendingUser) {
        turns.push([pendingUser, { role: "assistant", content: message.content }]);
        pendingUser = null;
      } else {
        turns.push([{ role: "assistant", content: message.content }]);
      }
    }
  }

  if (pendingUser) {
    turns.push([pendingUser]);
  }

  const selected: AiChatPayloadMessage[][] = [];
  let totalTokens = 0;
  for (const turn of turns.slice(-Math.max(0, memoryTurns)).reverse()) {
    const turnTokens = turn.reduce((sum, message) => sum + estimateAiTokens(
      typeof message.content === "string" ? message.content : JSON.stringify(message.content),
    ), 0);
    if (totalTokens + turnTokens > maxTokens) continue;
    selected.unshift(turn);
    totalTokens += turnTokens;
    if (totalTokens >= maxTokens) break;
  }
  return selected.flat();
};

export const calculateAiRequestBudget = (options: {
  provider: AiProviderProfile | undefined;
  history: AiChatMessage[];
  prompt: string;
  memorySummary?: string;
  attachment?: AiContextPack;
}): AiRequestBudget => {
  const provider = options.provider;
  if (!provider) {
    throw new AiRequestError("请先在“更多 → AI 设置”里配置 AI 供应商。", false, undefined, true);
  }
  const contextWindowTokens = provider.contextWindowTokens ?? DEFAULT_AI_CONTEXT_WINDOW_TOKENS;
  const outputTokens = provider.maxTokens;
  const retrievalMode = getAiRetrievalMode(options.prompt);
  const retrievalTargetTokens = retrievalMode === "coverage"
    ? COVERAGE_AI_RETRIEVAL_TOKENS
    : FOCUSED_AI_RETRIEVAL_TOKENS;
  const recent = selectRecentChatContext(options.history, provider.memoryTurns ?? DEFAULT_AI_MEMORY_TURNS);
  const historyTokens = recent.reduce((sum, message) => sum + estimateAiTokens(
    typeof message.content === "string" ? message.content : JSON.stringify(message.content),
  ), 0);
  const summaryTokens = estimateAiTokens(options.memorySummary ?? "");
  const promptTokens = estimateAiTokens(options.prompt);
  const available = contextWindowTokens - outputTokens - SYSTEM_AND_SAFETY_RESERVE_TOKENS - CONTEXT_PROMPT_RESERVE_TOKENS - historyTokens - summaryTokens - promptTokens;
  const retrievalTokens = Math.min(retrievalTargetTokens, Math.max(0, available));
  if (retrievalTokens < MIN_AI_RETRIEVAL_TOKENS) {
    throw new AiRequestError("当前供应商的 Context Window 不能为知识库检索保留至少 2K token。请降低 Max Tokens，或在 AI 设置中提高 Context Window Tokens。", false, undefined, true);
  }
  const selectedChunks = options.attachment?.selectedChunks?.length
    ? options.attachment.selectedChunks
    : options.attachment?.allChunks ?? [];
  const selectedContextTokens = selectedChunks.length > 0
    ? selectedChunks.reduce((sum, chunk, index) => sum + estimateAiContextSourceTokens(chunk, index), 0)
    : retrievalTokens;
  return {
    contextWindowTokens,
    outputTokens,
    historyTokens,
    retrievalMode,
    retrievalTargetTokens,
    retrievalTokens,
    selectedContextTokens,
    estimatedInputTokens: SYSTEM_AND_SAFETY_RESERVE_TOKENS + CONTEXT_PROMPT_RESERVE_TOKENS + historyTokens + summaryTokens + promptTokens + selectedContextTokens,
  };
};

export const buildAiMessages = (
  attachment: AiContextPack | undefined,
  history: AiChatMessage[],
  nextPrompt: string,
  memoryTurns = DEFAULT_AI_MEMORY_TURNS,
  memorySummary?: string,
  nextContent?: string | AiChatPayloadContentPart[],
): AiChatPayloadMessage[] => {
  const messages: AiChatPayloadMessage[] = [{ role: "system", content: SYSTEM_PROMPT }];
  if (attachment) {
    const selectedChunks = attachment.selectedChunks?.length ? attachment.selectedChunks : attachment.allChunks ?? [];
    const sourceLines = selectedChunks.map(formatAiContextSource);
    messages.push({
      role: "system",
      content: [
        `以下是 ${attachment.scopeTitle ?? attachment.date} 的学习日志上下文。后续回答请优先依据这些内容。`,
        "",
        "## 范围摘要",
        attachment.summary || "无摘要。",
        "",
        "## 可引用日志片段",
        sourceLines.length > 0 ? sourceLines.join("\n\n") : "没有可用日志片段。",
        "",
        "## 上下文提示",
        `记录数：${attachment.recordIds.length}`,
        `命中片段：${selectedChunks.length}/${attachment.totalChunks ?? selectedChunks.length}`,
        `图片 OCR：${attachment.ocrSummary?.includedImages ?? 0}/${(attachment.ocrSummary?.includedImages ?? 0) + (attachment.ocrSummary?.skippedImages ?? 0)}`,
        attachment.warnings.length ? attachment.warnings.map((warning) => `- ${warning}`).join("\n") : "- 无额外警告。",
        "",
        "回答要求：如果使用了日志内容，请在回答末尾写“依据来源：[[S1]] 来源标签、[[S2]] 来源标签”。如果日志证据不足，请明确说明。",
        "",
      ].join("\n"),
    });
  }

  if (memorySummary?.trim()) {
    messages.push({
      role: "system",
      content: [
        "以下是较早聊天的滚动记忆摘要，用于保持连续问答背景；如果它和最新日志片段冲突，以日志片段和最近对话为准。",
        "",
        memorySummary.trim(),
      ].join("\n"),
    });
  }

  messages.push(...selectRecentChatContext(history, memoryTurns));
  messages.push({ role: "user", content: nextContent ?? nextPrompt });
  return messages;
};

export const buildSessionMemorySummary = (
  history: AiChatMessage[],
  memoryTurns = DEFAULT_AI_MEMORY_TURNS,
): string | undefined => {
  const cleanHistory = history.filter((message) => message.role !== "system" && !message.error);
  const recent = selectRecentChatContext(cleanHistory, memoryTurns);
  const recentKeys = new Set(recent.map((message) => `${message.role}:${message.content}`));
  const older = cleanHistory.filter((message) => !recentKeys.has(`${message.role}:${message.content}`));
  if (older.length < MEMORY_SUMMARY_TURNS) {
    return undefined;
  }
  const lines = older
    .slice(-MEMORY_SUMMARY_TURNS * 2)
    .map((message) => `${message.role === "user" ? "用户" : "AI"}：${message.content}`)
    .join("\n");
  return [
    "较早对话要点：",
    lines.length > 1800 ? `${lines.slice(0, 1800)}...` : lines,
  ].join("\n");
};

const optionalNumber = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) ? value : undefined;

const parseUsage = (value: unknown): AiCompletionUsage | undefined => {
  if (!value || typeof value !== "object") return undefined;
  const usage = value as Record<string, unknown>;
  const completionDetails = usage.completion_tokens_details && typeof usage.completion_tokens_details === "object"
    ? usage.completion_tokens_details as Record<string, unknown>
    : undefined;
  const promptDetails = usage.prompt_tokens_details && typeof usage.prompt_tokens_details === "object"
    ? usage.prompt_tokens_details as Record<string, unknown>
    : undefined;
  const result: AiCompletionUsage = {
    promptTokens: optionalNumber(usage.prompt_tokens),
    completionTokens: optionalNumber(usage.completion_tokens),
    totalTokens: optionalNumber(usage.total_tokens),
    reasoningTokens: optionalNumber(completionDetails?.reasoning_tokens) ?? optionalNumber(usage.reasoning_tokens),
    cachedPromptTokens: optionalNumber(promptDetails?.cached_tokens) ?? optionalNumber(usage.prompt_cache_hit_tokens),
  };
  return Object.values(result).some((item) => item !== undefined) ? result : undefined;
};

export const parseOpenAiCompletionResult = (body: unknown, requestId?: string): AiCompletionResult => {
  const first = (body as { choices?: Array<{ message?: { content?: unknown }; text?: unknown; finish_reason?: unknown }> }).choices?.[0];
  if (!first) throw new AiSchemaError("AI 接口没有返回 choices，可能不是 OpenAI 兼容格式。");
  const rawContent = first.message?.content ?? first.text;
  const content = typeof rawContent === "string" ? rawContent.trim() : "";
  const finishReason = typeof first.finish_reason === "string" ? first.finish_reason : undefined;
  const bodyRequestId = (body as { id?: unknown; request_id?: unknown }).request_id ?? (body as { id?: unknown }).id;
  return {
    content,
    finishReason,
    usage: parseUsage((body as { usage?: unknown }).usage),
    requestId: requestId || (typeof bodyRequestId === "string" ? bodyRequestId : undefined),
  };
};

const extractErrorMessage = (body: unknown, fallback: string): string => {
  const errorMessage = (body as { error?: { message?: unknown }; message?: unknown }).error?.message ??
    (body as { message?: unknown }).message;
  return typeof errorMessage === "string" && errorMessage.trim() ? errorMessage : fallback;
};

const requestOpenAiChatCompletionDetailed = async (options: {
  provider: AiProviderProfile;
  apiKey: string;
  messages: AiChatPayloadMessage[];
  maxTokens?: number;
} & AiCompletionRequestOptions): Promise<AiCompletionResult> => {
  const { provider, apiKey, messages } = options;
  if (options.signal?.aborted) throw new DOMException("AI request cancelled", "AbortError");
  const maxTokens = options.maxTokens ?? provider.maxTokens;

  if (canUseNativeAi()) {
    return runNativeAiChat({
      baseUrl: provider.baseUrl,
      apiKey,
      model: provider.model,
      temperature: provider.temperature,
      maxTokens,
      messages,
      structuredOutput: options.structuredOutput,
      thinkingMode: options.thinkingMode,
      reasoningEffort: options.reasoningEffort,
      timeoutMs: options.timeoutMs,
      signal: options.signal,
    }).catch((error: unknown) => {
      if (options.signal?.aborted || (error instanceof DOMException && error.name === "AbortError")) throw new DOMException("AI request cancelled", "AbortError");
      const code = typeof error === "object" && error !== null && "code" in error ? String(error.code) : "";
      const status = /^HTTP_\d+$/.test(code) ? Number(code.slice(5)) : undefined;
      const retryable = code === "NETWORK" || code === "TIMEOUT" || status === 408 || status === 429 || Boolean(status && status >= 500);
      const retryAfter = typeof error === "object" && error !== null && "data" in error ? (error.data as { retryAfter?: string })?.retryAfter : undefined;
      const retryAfterMs = retryAfter ? (/^\d+(?:\.\d+)?$/.test(retryAfter) ? Number(retryAfter) * 1000 : Math.max(0, Date.parse(retryAfter) - Date.now())) : undefined;
      throw new AiRequestError("原生 AI 请求失败，请检查服务配置或网络。", retryable, status, code === "CONFIGURATION", retryAfterMs, code === "TIMEOUT" ? "timeout" : undefined);
    });
  }

  const requestUrl = normalizeAiChatCompletionsUrl(provider.baseUrl);
  const timeoutController = new AbortController();
  const timeoutMs = options.timeoutMs ?? DEFAULT_AI_REQUEST_TIMEOUT_MS;
  let timedOut = false;
  const timeoutId = timeoutMs > 0 ? globalThis.setTimeout(() => {
    timedOut = true;
    timeoutController.abort();
  }, timeoutMs) : undefined;
  const abortFromCaller = () => timeoutController.abort(options.signal?.reason);
  options.signal?.addEventListener("abort", abortFromCaller, { once: true });
  try {
    const response = await fetch(requestUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: provider.model,
        messages,
        temperature: provider.temperature,
        max_tokens: maxTokens,
        ...(options.structuredOutput ? { response_format: { type: "json_object" } } : {}),
        ...(options.thinkingMode ? { thinking: { type: options.thinkingMode } } : {}),
        ...(options.reasoningEffort ? { reasoning_effort: options.reasoningEffort } : {}),
      }),
      signal: timeoutController.signal,
    });
    const text = await response.text();
    const contentType = response.headers.get("content-type") ?? "";
    const parsed = tryParseJson(text);
    const fallbackDetail = responseSnippet(text) || "响应体为空。";

    if (!response.ok) {
      const detail = parsed.ok
        ? extractErrorMessage(parsed.value, fallbackDetail)
        : [
          isLikelyHtmlResponse(text, contentType) ? "接口返回的是 HTML 页面，Base URL 可能缺少 /v1 或填成了网页入口。" : "接口返回的不是 JSON。",
          fallbackDetail ? `响应片段：${fallbackDetail}` : "",
        ].filter(Boolean).join(" ");
      const retryableStatus = response.status === 408 || response.status === 429 || response.status >= 500;
      const actionableStatus = response.status === 401 || response.status === 403 || response.status === 404;
      const retryAfter = response.headers.get("retry-after");
      const retryAfterMs = retryAfter ? (/^\d+(?:\.\d+)?$/.test(retryAfter) ? Number(retryAfter) * 1000 : Math.max(0, Date.parse(retryAfter) - Date.now())) : undefined;
      throw new AiRequestError(`${provider.providerName} AI 接口请求失败：${formatResponseMeta(response.status, contentType, requestUrl)}，${detail}`, retryableStatus, response.status, actionableStatus, retryAfterMs);
    }

    if (!parsed.ok) {
      const hint = isLikelyHtmlResponse(text, contentType)
        ? "接口返回的是 HTML 页面，Base URL 可能缺少 /v1 或填成了网页入口。"
        : "接口返回的不是 JSON。";
      throw new AiRequestError(
        `${provider.providerName} AI 接口返回的不是 OpenAI 兼容 JSON，可能 Base URL 路径错误。${formatResponseMeta(response.status, contentType, requestUrl)}，${hint}响应片段：${fallbackDetail}`,
        false,
        response.status,
        true,
      );
    }

    return parseOpenAiCompletionResult(parsed.value, response.headers.get("x-request-id") ?? response.headers.get("request-id") ?? undefined);
  } catch (error) {
    if (timedOut) {
      throw new AiRequestError(`AI 请求等待超过 ${Math.round(timeoutMs / 1000)} 秒，已停止等待。`, true);
    }
    if (error instanceof DOMException && error.name === "AbortError") throw error;
    if (error instanceof TypeError) {
      throw new AiRequestError("Web 端请求失败，可能被第三方接口 CORS 限制。请在 Android 端使用，或配置允许跨域的代理 Base URL。", false, undefined, true);
    }
    throw error;
  } finally {
    if (timeoutId !== undefined) globalThis.clearTimeout(timeoutId);
    options.signal?.removeEventListener("abort", abortFromCaller);
  }
};

const requestOpenAiChatCompletion = async (options: Parameters<typeof requestOpenAiChatCompletionDetailed>[0]): Promise<string> => {
  const result = await requestOpenAiChatCompletionDetailed(options);
  if (!result.content) throw new AiRequestError("AI 接口返回为空，或没有返回最终正文。", false);
  return result.content;
};

const imageAttachmentToContentPart = async (attachment: AiChatAttachment): Promise<AiChatPayloadContentPart> => {
  const base64 = await blobToBase64(attachment.data);
  return {
    type: "image_url",
    image_url: {
      url: `data:${attachment.mimeType || "image/jpeg"};base64,${base64}`,
      detail: "auto",
    },
  };
};

const buildOcrMarkdownPrompt = (prompt: string, attachments: AiChatAttachment[]): string => {
  const imageBlocks = attachments.map((attachment, index) => [
    `### 用户上传图片 ${index + 1}：${attachment.fileName}`,
    "",
    "以下是本地 PaddleOCR 识别出的图片文字，请基于它进行批改或回答：",
    "",
    "```text",
    attachment.ocrText?.trim() || "（没有可用 OCR 文本）",
    "```",
  ].join("\n"));
  return [
    prompt.trim() || "请根据我上传的图片内容进行回答或批改。",
    "",
    "## 本轮图片 OCR 内容",
    imageBlocks.join("\n\n"),
  ].join("\n").trim();
};

export const buildUserPromptWithImages = async (options: {
  prompt: string;
  imageInputMode?: "vision" | "local-ocr" | "disabled";
  imageAttachments?: AiChatAttachment[];
}): Promise<string | AiChatPayloadContentPart[]> => {
  const attachments = options.imageAttachments ?? [];
  const prompt = options.prompt.trim();
  const mode = options.imageInputMode ?? "local-ocr";
  if (attachments.length === 0) {
    return prompt;
  }
  if (mode === "disabled") {
    throw new Error("AI 图片发送已关闭，请在 AI 设置中开启图片问答方式。");
  }
  if (mode === "local-ocr") {
    const failed = attachments.find((attachment) => attachment.ocrStatus !== "done" || !attachment.ocrText?.trim());
    if (failed) {
      throw new Error(`${failed.fileName} 没有可用 OCR 文本，请重新 OCR 后再发送。`);
    }
    return buildOcrMarkdownPrompt(prompt, attachments);
  }
  const content: AiChatPayloadContentPart[] = [
    { type: "text", text: prompt || "请根据我上传的图片内容进行回答或批改。" },
  ];
  content.push(...await Promise.all(attachments.map(imageAttachmentToContentPart)));
  return content;
};

export const sendChatCompletion = async (options: {
  provider: AiProviderProfile | undefined;
  apiKey: string | undefined;
  attachment?: AiContextPack;
  history: AiChatMessage[];
  prompt: string;
  memorySummary?: string;
  imageInputMode?: "vision" | "local-ocr" | "disabled";
  imageAttachments?: AiChatAttachment[];
  budget?: AiRequestBudget;
  signal?: AbortSignal;
  timeoutMs?: number;
}): Promise<string> => {
  const { provider, apiKey, attachment, history, prompt, memorySummary, imageInputMode, imageAttachments } = options;
  if (!provider) {
    throw new Error("请先在“更多 → AI 设置”里配置 AI 供应商。");
  }
  if (!apiKey?.trim()) {
    throw new AiRequestError(`请先在“更多 → AI 设置”里填写 ${provider.providerName} 的 API Key。`, false, undefined, true);
  }
  if (!provider.model.trim()) {
    throw new AiRequestError(`请先填写 ${provider.providerName} 的模型名称。`, false, undefined, true);
  }

  const userContent = await buildUserPromptWithImages({
    prompt,
    imageInputMode,
    imageAttachments,
  });
  const budget = options.budget ?? calculateAiRequestBudget({ provider, history, prompt, memorySummary });
  const messages = buildAiMessages(
    attachment,
    history,
    prompt,
    provider.memoryTurns ?? DEFAULT_AI_MEMORY_TURNS,
    memorySummary,
    userContent,
  );
  return requestOpenAiChatCompletion({
    provider,
    apiKey: apiKey.trim(),
    messages,
    maxTokens: budget.outputTokens,
    signal: options.signal,
    timeoutMs: options.timeoutMs,
  });
};

export const sendChatCompletionDetailed = async (options: {
  provider: AiProviderProfile | undefined;
  apiKey: string | undefined;
  attachment?: AiContextPack;
  history: AiChatMessage[];
  prompt: string;
  memorySummary?: string;
  budget?: AiRequestBudget;
  request?: AiCompletionRequestOptions & { maxTokens?: number };
}): Promise<AiCompletionResult> => {
  const { provider, apiKey, attachment, history, prompt, memorySummary } = options;
  if (!provider) throw new Error("请先在“更多 → AI 设置”里配置 AI 供应商。");
  if (!apiKey?.trim()) throw new Error(`请先在“更多 → AI 设置”里填写 ${provider.providerName} 的 API Key。`);
  if (!provider.model.trim()) throw new Error(`请先填写 ${provider.providerName} 的模型名称。`);
  const budget = options.budget ?? calculateAiRequestBudget({ provider, history, prompt, memorySummary, attachment });
  return requestOpenAiChatCompletionDetailed({
    provider,
    apiKey: apiKey.trim(),
    messages: buildAiMessages(attachment, history, prompt, provider.memoryTurns ?? DEFAULT_AI_MEMORY_TURNS, memorySummary),
    maxTokens: options.request?.maxTokens ?? budget.outputTokens,
    ...options.request,
  });
};

export const testAiProviderConnection = async (options: {
  provider: AiProviderProfile | undefined;
  apiKey: string | undefined;
}): Promise<AiConnectionTestResult> => {
  const { provider, apiKey } = options;
  if (!provider) {
    throw new Error("请先配置 AI 供应商。");
  }
  if (!apiKey?.trim()) {
    throw new Error(`请先填写 ${provider.providerName || "当前供应商"} 的 API Key。`);
  }
  if (!provider.providerName.trim() || !provider.baseUrl.trim() || !provider.model.trim()) {
    throw new Error("请先补齐供应商名称、Base URL 和模型名称。");
  }

  const requestUrl = normalizeAiChatCompletionsUrl(provider.baseUrl);
  const content = await requestOpenAiChatCompletion({
    provider,
    apiKey: apiKey.trim(),
    maxTokens: 16,
    messages: [{ role: "user", content: "请只回复 OK。" }],
  });
  return { requestUrl, content };
};
