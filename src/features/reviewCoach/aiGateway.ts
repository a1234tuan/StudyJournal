import type { AiCompletionUsage, AiProviderProfile } from "../../types";
import {
  FEEDBACK_INTERPRETATION_PROMPT_VERSION,
  REVIEW_COACH_AI_SCHEMA_VERSION,
  REVIEW_COACH_POLICY_VERSION,
  parseFeedbackInterpretationAiResponse,
  feedbackInterpretationJsonSchema,
  formatReviewCoachSchemaInstruction,
} from "./aiSchemas";
import type { ReviewCoachAiGateway } from "./orchestrator";
import { REVIEW_COACH_ROLE_SYSTEM_PROMPT } from "./rolePrompts";
import { AiSchemaError, sendChatCompletionDetailed } from "../../services/aiClientService";
import { diagnosticForAiError } from "./aiDiagnostics";

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
    throw new AiSchemaError("快速模型返回的内容不是有效 JSON。");
  }
};

export const FORMAT_REPAIR_MAX_RETRIES = 1;

/**
 * Allows one bounded repair when the provider answered but violated the JSON
 * transport/schema contract. The repair prompt is deliberately shape-only:
 * it cannot introduce new facts, IDs, evidence, or formal state.
 */
export const parseStructuredWithFormatRepair = async <T>(input: {
  prompt: string;
  call: (prompt: string) => Promise<{ content: string; usage?: AiCompletionUsage; requestId?: string }>;
  parse: (value: unknown) => T;
}): Promise<{ response: T; usage?: AiCompletionUsage; requestId?: string; repaired: boolean }> => {
  const parse = (content: string): T => input.parse(parseJsonContent(content));
  const first = await input.call(input.prompt);
  try {
    return { response: parse(first.content), usage: first.usage, requestId: first.requestId, repaired: false };
  } catch (error) {
    if (!(error instanceof AiSchemaError)) throw error;
    const repairedPrompt = [
      input.prompt,
      "上一轮已经返回内容，但没有通过本地 JSON/Schema 校验。现在只修复输出格式：只返回一个 JSON 对象，严格遵守上面给出的 Schema；不得增加、删改或猜测任何事实、来源 ID、版本、证据或正式状态。不要解释，不要 Markdown，不要代码围栏。",
    ].join("\n\n");
    const second = await input.call(repairedPrompt);
    return { response: parse(second.content), usage: second.usage, requestId: second.requestId, repaired: true };
  }
};

/** Bounds so a large block or a long interpretation history cannot blow the
 * model's context (the interpretation call has no retrieval budget). */
export const FEEDBACK_INTERPRETATION_MAX_BLOCK_CHARACTERS = 4_000;
export const FEEDBACK_INTERPRETATION_MAX_COMMENT_CHARACTERS = 1_000;
export const FEEDBACK_INTERPRETATION_MAX_HISTORY_ITEMS = 5;

export const buildFeedbackInterpretationPrompt = (input: FeedbackInterpretationPromptInput): string => [
  "请把用户对学习决策块的原始评论整理成结构化理解。只能依据给出的决策块和评论，不得补造背景。",
  "必须只输出 JSON，不要 Markdown，不要代码围栏。可以指出用户理解中的错误、题面歧义和需要检查的前置知识；这些属于模型推导，不得伪装成用户原话。",
  "只有在没有可识别训练目标、没有可验证判据且无法通过澄清或前置检查推进时，才输出 {\"status\":\"insufficient-context\",\"missingInformation\":[\"...\"]}。",
  "正常输出必须包含 status=ok、actionability、difficultyType、stuckAt、userHypothesis、preferredPractice、missingInformation、confidence。",
  formatReviewCoachSchemaInstruction(feedbackInterpretationJsonSchema),
  "",
  JSON.stringify({
    feedbackId: input.feedbackId,
    decisionBlockId: input.decisionBlockId,
    recordId: input.recordId,
    contentVersion: input.contentVersion,
    inputCompleteness: {
      commentTruncated: input.comment.length > FEEDBACK_INTERPRETATION_MAX_COMMENT_CHARACTERS,
      materialTruncated: input.decisionBlockContent.length > FEEDBACK_INTERPRETATION_MAX_BLOCK_CHARACTERS,
      historyTruncated: (input.historicalTrend?.length ?? 0) > FEEDBACK_INTERPRETATION_MAX_HISTORY_ITEMS,
    },
    originalComment: input.comment.slice(0, FEEDBACK_INTERPRETATION_MAX_COMMENT_CHARACTERS),
    decisionBlockContent: input.decisionBlockContent.slice(0, FEEDBACK_INTERPRETATION_MAX_BLOCK_CHARACTERS),
    historicalTrend: (input.historicalTrend ?? []).slice(-FEEDBACK_INTERPRETATION_MAX_HISTORY_ITEMS),
  }, null, 2),
].join("\n");

export const createFeedbackInterpretationGateway = (options: FeedbackInterpretationGatewayOptions): Pick<ReviewCoachAiGateway, "interpretFeedback"> => ({
  async interpretFeedback(input: unknown, signal?: AbortSignal) {
    try {
      const prompt = buildFeedbackInterpretationPrompt(input as FeedbackInterpretationPromptInput);
      const result = await parseStructuredWithFormatRepair({
        prompt,
        call: (attemptPrompt) => sendChatCompletionDetailed({
          provider: options.provider,
          apiKey: options.apiKey,
          history: [],
          prompt: attemptPrompt,
          request: {
            structuredOutput: true,
            thinkingMode: "disabled",
            timeoutMs: options.timeoutMs,
            signal,
            maxTokens: Math.min(options.provider.maxTokens, 900),
            systemPrompt: REVIEW_COACH_ROLE_SYSTEM_PROMPT,
          },
        }),
        parse: parseFeedbackInterpretationAiResponse,
      });
      return {
        response: result.response,
        usage: result.usage,
        requestId: result.requestId,
      };
    } catch (error) {
      throw diagnosticForAiError("feedback-interpretation", error);
    }
  },
});

export const defaultFeedbackInterpretationMetadata = {
  promptVersion: FEEDBACK_INTERPRETATION_PROMPT_VERSION,
  policyVersion: REVIEW_COACH_POLICY_VERSION,
  schemaVersion: REVIEW_COACH_AI_SCHEMA_VERSION,
} as const;
