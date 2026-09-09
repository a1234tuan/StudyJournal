import type { AiProviderProfile } from "../../types";
import {
  FEEDBACK_INTERPRETATION_PROMPT_VERSION,
  REVIEW_COACH_AI_SCHEMA_VERSION,
  REVIEW_COACH_POLICY_VERSION,
  parseFeedbackInterpretationAiResponse,
} from "./aiSchemas";
import type { ReviewCoachAiGateway } from "./orchestrator";
import { sendChatCompletionDetailed } from "../../services/aiClientService";

export interface FeedbackInterpretationGatewayOptions {
  provider: AiProviderProfile;
  apiKey: string;
  timeoutMs?: number;
}

export interface FeedbackInterpretationPromptInput {
  feedbackId: string;
  decisionBlockId: string;
  recordId: string;
  contentVersion: number;
  comment: string;
  decisionBlockContent: string;
  historicalTrend?: unknown[];
}

export const parseJsonContent = (content: string): unknown => {
  const trimmed = content.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i)?.[1] ?? trimmed;
  try {
    return JSON.parse(fenced);
  } catch {
    throw new Error("快速模型返回的内容不是有效 JSON。");
  }
};

/** Bounds so a large block or a long interpretation history cannot blow the
 * model's context (the interpretation call has no retrieval budget). */
export const FEEDBACK_INTERPRETATION_MAX_BLOCK_CHARACTERS = 4_000;
export const FEEDBACK_INTERPRETATION_MAX_COMMENT_CHARACTERS = 1_000;
export const FEEDBACK_INTERPRETATION_MAX_HISTORY_ITEMS = 5;

export const buildFeedbackInterpretationPrompt = (input: FeedbackInterpretationPromptInput): string => [
  "请把用户对学习决策块的原始评论整理成结构化理解。只能依据给出的决策块和评论，不得补造背景。",
  "必须只输出 JSON，不要 Markdown，不要代码围栏。",
  "如果背景不足，输出 {\"status\":\"insufficient-context\",\"missingInformation\":[\"...\"]}。",
  "正常输出必须包含 status=ok、actionability、difficultyType、stuckAt、userHypothesis、preferredPractice、missingInformation、confidence。",
  "",
  JSON.stringify({
    feedbackId: input.feedbackId,
    decisionBlockId: input.decisionBlockId,
    recordId: input.recordId,
    contentVersion: input.contentVersion,
    originalComment: input.comment.slice(0, FEEDBACK_INTERPRETATION_MAX_COMMENT_CHARACTERS),
    decisionBlockContent: input.decisionBlockContent.slice(0, FEEDBACK_INTERPRETATION_MAX_BLOCK_CHARACTERS),
    historicalTrend: (input.historicalTrend ?? []).slice(-FEEDBACK_INTERPRETATION_MAX_HISTORY_ITEMS),
  }, null, 2),
].join("\n");

export const createFeedbackInterpretationGateway = (options: FeedbackInterpretationGatewayOptions): Pick<ReviewCoachAiGateway, "interpretFeedback"> => ({
  async interpretFeedback(input: unknown, signal?: AbortSignal) {
    const result = await sendChatCompletionDetailed({
      provider: options.provider,
      apiKey: options.apiKey,
      history: [],
      prompt: buildFeedbackInterpretationPrompt(input as FeedbackInterpretationPromptInput),
      request: {
        structuredOutput: true,
        // Structured JSON must not compete with reasoning tokens: verified on
        // 2026-09-09 that a reasoning model otherwise returns an empty body.
        thinkingMode: "disabled",
        timeoutMs: options.timeoutMs,
        signal,
        maxTokens: Math.min(options.provider.maxTokens, 900),
      },
    });
    return {
      response: parseFeedbackInterpretationAiResponse(parseJsonContent(result.content)),
      usage: result.usage,
      requestId: result.requestId,
    };
  },
});

export const defaultFeedbackInterpretationMetadata = {
  promptVersion: FEEDBACK_INTERPRETATION_PROMPT_VERSION,
  policyVersion: REVIEW_COACH_POLICY_VERSION,
  schemaVersion: REVIEW_COACH_AI_SCHEMA_VERSION,
} as const;
