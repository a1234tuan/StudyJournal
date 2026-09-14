import type { AiProviderProfile } from "../../types";
import { sendChatCompletionDetailed } from "../../services/aiClientService";
import {
  REVIEW_COACH_AI_SCHEMA_VERSION,
  REVIEW_COACH_POLICY_VERSION,
  SESSION_BLUEPRINT_PROMPT_VERSION,
  parseSessionBlueprintAiResponse,
} from "./aiSchemas";
import { parseJsonContent } from "./aiGateway";
import { REVIEW_COACH_ROLE_SYSTEM_PROMPT } from "./rolePrompts";
import type { InterventionEffectSummary } from "./domain";
import type { ReviewCoachAiGateway } from "./orchestrator";

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
  /**
   * B-2 (F-01): read-only historical intervention effects, so the planner can pick a different
   * way of teaching when the previous one demonstrably did not work on this user.
   *
   * Only objective (AI-graded) fields appear here — never `retentionRate` or
   * `selfReportedMasteredCount`. The D-1 contract requires the objective measure to drive strategy
   * while the self-report stays the user-facing figure, and the two must never be mixed or used to
   * explain each other. Callers must filter on `objectiveEvidenceStatus === "usable"`.
   */
  interventionEffects: SessionPlanningEffectSummary[];
}

export interface SessionPlanningEffectSummary {
  strategyKey: string;
  problemType: string;
  actualPracticeType: string;
  hintLevelUsed: string;
  sampleCount: number;
  objectiveAnswerCount: number;
  objectiveCorrectRate?: number;
  objectiveUnreliableCount: number;
  verificationObjectiveCount: number;
  verificationObjectiveCorrectRate?: number;
}

/** Projects a full projection row down to the objective fields the planner is allowed to see. */
export const toSessionPlanningEffectSummary = (effect: InterventionEffectSummary): SessionPlanningEffectSummary => ({
  strategyKey: effect.strategyKey,
  problemType: effect.problemType,
  actualPracticeType: effect.actualPracticeType,
  hintLevelUsed: effect.hintLevelUsed,
  sampleCount: effect.sampleCount,
  objectiveAnswerCount: effect.objectiveAnswerCount,
  objectiveCorrectRate: effect.objectiveCorrectRate,
  objectiveUnreliableCount: effect.objectiveUnreliableCount,
  verificationObjectiveCount: effect.verificationObjectiveCount,
  verificationObjectiveCorrectRate: effect.verificationObjectiveCorrectRate,
});

export const buildSessionPlanningPrompt = (input: SessionPlanningPromptInput): string => [
  "你是学习复习会话的深度规划器。请为每个主决策块分别生成一个 SessionBlueprint。",
  "只能使用输入中的事实与引用，不得补造来源、改写原评论、激活任务或宣告掌握。",
  "必须只输出 JSON。每个 Blueprint 只允许一个 mainDecisionBlockId；辅助块只能来自 allowedSupportingDecisionBlockIds。",
  "当 allowedSupportingDecisionBlockIds 为空时，你不得引用其他块的 feedback、interpretation 或 evidence，evidence 只能来自该 Blueprint 自己的主决策块。",
  "evidence 的 decisionBlockId、recordId、contentVersion、excerptHash 必须逐字复用输入值。",
  "只允许策略 continue、hint、explain、worked-example、prerequisite-check、finish；不得生成代码或可执行 HTML。",
  "每个候选必须覆盖 correct、partial、incorrect、skipped 四种分支，maxRetriesPerTurn 不得超过 2。",
  "信息不足时输出 {\"status\":\"insufficient-context\",\"missingInformation\":[\"...\"]}。",
  "正常输出字段必须严格符合 session-blueprint-v1 JSON Schema，不要增加其他字段。",
  "输入中的 interventionEffects 是该用户的历史干预效果统计，仅用于在同一学习目标内部选择训练方式与难度。",
  "不得据此改变主决策块、不得据此宣告掌握；这些数字来自客观判题，与用户自评无关，不得混用或互相换算；样本不足的条目必须忽略。",
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
    const result = await sendChatCompletionDetailed({
      provider: options.provider,
      apiKey: options.apiKey,
      history: [],
      prompt: buildSessionPlanningPrompt(input as SessionPlanningPromptInput),
      request: {
        structuredOutput: true,
        thinkingMode: "disabled",
        timeoutMs: options.timeoutMs,
        signal,
        maxTokens: Math.min(options.provider.maxTokens, 6_000),
        // F-17: JSON-only role prompt instead of the conversational default.
        systemPrompt: REVIEW_COACH_ROLE_SYSTEM_PROMPT,
      },
    });
    return {
      response: parseSessionBlueprintAiResponse(parseJsonContent(result.content)),
      usage: result.usage,
      requestId: result.requestId,
    };
  },
});

export const defaultSessionPlanningMetadata = {
  promptVersion: SESSION_BLUEPRINT_PROMPT_VERSION,
  policyVersion: REVIEW_COACH_POLICY_VERSION,
  schemaVersion: REVIEW_COACH_AI_SCHEMA_VERSION,
} as const;
