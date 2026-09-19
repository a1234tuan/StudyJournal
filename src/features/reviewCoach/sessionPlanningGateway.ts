import type { AiProviderProfile } from "../../types";
import { sendChatCompletionDetailed } from "../../services/aiClientService";
import {
  REVIEW_COACH_AI_SCHEMA_VERSION,
  REVIEW_COACH_POLICY_VERSION,
  SESSION_BLUEPRINT_PROMPT_VERSION,
  sessionBlueprintJsonSchema,
  formatReviewCoachSchemaInstruction,
  parseSessionBlueprintAiResponse,
} from "./aiSchemas";
import { parseStructuredWithFormatRepair } from "./aiGateway";
import { REVIEW_COACH_ROLE_SYSTEM_PROMPT } from "./rolePrompts";
import type { ReviewCoachAiGateway } from "./orchestrator";
import { diagnosticForAiError } from "./aiDiagnostics";

export interface SessionPlanningGatewayOptions {
  provider: AiProviderProfile;
  apiKey: string;
  timeoutMs?: number;
}

export interface SessionPlanningPromptBlock {
  decisionBlockId: string;
  recordId: string;
  contentVersion: number;
  recordTitle: string;
  subject: string;
  contextMarkdown: string;
  excerptHash: string;
  feedback: unknown[];
}

export interface SessionPlanningPromptInput {
  blocks: SessionPlanningPromptBlock[];
  allowedSupportingDecisionBlockIds: string[];
}

export const buildSessionPlanningPrompt = (input: SessionPlanningPromptInput): string => [
  "你是学习复习会话的深度规划器。请为每个主决策块分别生成一个 SessionBlueprint。",
  "objective、completionCriteria、expectedKeyPoints、forbiddenScope 等面向学习者的文字字段中，所有数学表达式必须用 Markdown 数学分隔符包裹：行内 $...$，独立公式 $$...$$；不要输出裸 e^{...}、\\frac、\\to 等 LaTeX。",
  "只能使用输入中的来源事实与引用，不得补造来源、改写原评论、激活任务或宣告掌握。可以根据公式、定义、条件和评价进行可复核推导，可以指出错误前提或题面歧义，并把它们转成诊断题、辨析题或前置知识检查；推导结果不得冒充来源事实。",
  "必须只输出 JSON。每个 Blueprint 只允许一个 mainDecisionBlockId；辅助块只能来自 allowedSupportingDecisionBlockIds。",
  "当 allowedSupportingDecisionBlockIds 为空时，你不得引用其他块的 feedback、interpretation 或 evidence，evidence 只能来自该 Blueprint 自己的主决策块。",
  "evidence 的 decisionBlockId、recordId、contentVersion、excerptHash 必须逐字复用输入值。",
  "只允许策略 continue、hint、explain、worked-example、prerequisite-check、finish；不得生成代码或可执行 HTML。",
  "每个候选必须覆盖 correct、partial、incorrect、skipped 四种分支，maxRetriesPerTurn 不得超过 2。",
  "只有在没有可识别训练目标、没有可验证判据且澄清题/辨析题/前置检查都无法安全推进时，才输出 {\"status\":\"insufficient-context\",\"missingInformation\":[\"...\"]}。缺少标准答案、需要推导、用户理解可能错误或题面存在歧义，不单独构成信息不足。",
  `正常输出字段必须严格符合 ${SESSION_BLUEPRINT_PROMPT_VERSION} JSON Schema，不要增加其他字段。`,
  formatReviewCoachSchemaInstruction(sessionBlueprintJsonSchema),
  "你只能依据本决策块的当前版本内容与原始用户反馈来规划；不得使用跨题目的效果百分比、掌握度或置信度。",
  "",
  JSON.stringify({
    promptVersion: SESSION_BLUEPRINT_PROMPT_VERSION,
    policyVersion: REVIEW_COACH_POLICY_VERSION,
    schemaVersion: REVIEW_COACH_AI_SCHEMA_VERSION,
    ...input,
  }, null, 2),
].join("\n");

export const createSessionPlanningGateway = (options: SessionPlanningGatewayOptions): Pick<ReviewCoachAiGateway, "planSession"> => ({
  async planSession(input: unknown, signal?: AbortSignal) {
    try {
      const prompt = buildSessionPlanningPrompt(input as SessionPlanningPromptInput);
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
            maxTokens: Math.min(options.provider.maxTokens, 6_000),
            systemPrompt: REVIEW_COACH_ROLE_SYSTEM_PROMPT,
          },
        }),
        parse: parseSessionBlueprintAiResponse,
      });
      return {
        response: result.response,
        usage: result.usage,
        requestId: result.requestId,
      };
    } catch (error) {
      throw diagnosticForAiError("deep-planning", error);
    }
  },
});

export const defaultSessionPlanningMetadata = {
  promptVersion: SESSION_BLUEPRINT_PROMPT_VERSION,
  policyVersion: REVIEW_COACH_POLICY_VERSION,
  schemaVersion: REVIEW_COACH_AI_SCHEMA_VERSION,
} as const;
