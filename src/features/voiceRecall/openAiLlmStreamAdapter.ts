import type { AiProviderProfile } from "../../types";
import { normalizeAiChatCompletionsUrl } from "../../services/aiClientService";
import type { LlmStreamAdapter, LlmStreamEvent, LlmStreamRequest } from "./contracts";
import { UNTRUSTED_LEARNING_CONTENT_GUARD } from "./contentBoundary";
import { createTimeoutSignal, VoiceProviderError } from "./providerRuntime";
import { parseServerSentEvents } from "./sse";

type FetchImplementation = typeof fetch;

export { UNTRUSTED_LEARNING_CONTENT_GUARD };

export const serializeVoiceTeacherMessages = (messages: readonly LlmStreamRequest["messages"][number][]) => {
  const hasUntrustedContent = messages.some((message) => message.contentBoundary === "untrusted-learning-content" || message.contentBoundary === "user-utterance");
  return [
    ...(hasUntrustedContent ? [{ role: "system" as const, content: UNTRUSTED_LEARNING_CONTENT_GUARD }] : []),
    ...messages.map(({ role, content, contentBoundary }) => ({
      role,
      content: contentBoundary === "untrusted-learning-content"
        ? `UNTRUSTED_LEARNING_CONTENT_JSON:\n${JSON.stringify(content)}`
        : content,
    })),
  ];
};

const optionalNumber = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) ? value : undefined;

export class OpenAiCompatibleLlmStreamAdapter implements LlmStreamAdapter {
  readonly profileId: string;

  constructor(
    private readonly profile: AiProviderProfile,
    private readonly apiKey: string,
    private readonly fetchImplementation: FetchImplementation = fetch,
    private readonly timeoutMs = 20_000,
  ) {
    this.profileId = profile.id;
  }

  async *complete(request: LlmStreamRequest): AsyncIterable<LlmStreamEvent> {
    const timeout = createTimeoutSignal(request.signal, this.timeoutMs);
    try {
      const response = await this.fetchImplementation(normalizeAiChatCompletionsUrl(this.profile.baseUrl), {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${this.apiKey.trim().replace(/^Bearer\s+/i, "")}` },
        body: JSON.stringify({
          model: this.profile.model,
          messages: serializeVoiceTeacherMessages(request.messages),
          temperature: this.profile.temperature,
          max_tokens: this.profile.maxTokens,
          stream: true,
          stream_options: { include_usage: true },
          ...(this.profile.voiceThinkingMode === "enabled" ? { thinking: { type: "enabled" } } : {}),
        }),
        signal: timeout.signal,
      });
      if (!response.ok) {
        const retryable = response.status === 408 || response.status === 429 || response.status >= 500;
        throw new VoiceProviderError(
          response.status === 401 || response.status === 403 ? "LLM 凭据无效或无权访问当前模型。" : `LLM 流式请求失败（HTTP ${response.status}）。`,
          response.status === 401 || response.status === 403 ? "unauthorized" : response.status === 429 ? "rate-limited" : "network",
          retryable,
          response.status,
        );
      }
      if (!response.body) throw new VoiceProviderError("LLM 没有返回可读取的流。", "invalid-response", false);
      for await (const data of parseServerSentEvents(response.body, timeout.signal)) {
        if (data === "[DONE]") break;
        let payload: Record<string, unknown>;
        try { payload = JSON.parse(data) as Record<string, unknown>; }
        catch { throw new VoiceProviderError("LLM 返回了无法解析的流事件。", "invalid-response", false); }
        const choices = payload.choices as Array<{ delta?: { content?: unknown } }> | undefined;
        const token = choices?.[0]?.delta?.content;
        if (typeof token === "string" && token) yield { type: "token", text: token };
        const usage = payload.usage as Record<string, unknown> | undefined;
        if (usage) yield { type: "usage", inputTokens: optionalNumber(usage.prompt_tokens), outputTokens: optionalNumber(usage.completion_tokens) };
      }
      yield { type: "completed" };
    } catch (error) {
      if (request.signal.aborted) throw new DOMException("LLM request cancelled", "AbortError");
      if (timeout.didTimeout()) throw new VoiceProviderError("LLM 流式请求超时。", "timeout", true);
      throw error;
    } finally {
      timeout.dispose();
    }
  }
}
