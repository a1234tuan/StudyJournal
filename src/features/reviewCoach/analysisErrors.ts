import type { AnalysisBatch } from "./domain";
import { AiRequestError } from "../../services/aiClientService";
import { ActionableError, isActionableError } from "../../lib/uiError";
import { ReviewCoachAiDiagnosticError } from "./aiDiagnostics";

export type AnalysisFailureCategory =
  | "authentication"
  | "configuration"
  | "rate-limit"
  | "timeout"
  | "network"
  | "incompatible-response"
  | "invalid-json"
  | "schema-mismatch"
  | "insufficient-context"
  | "local-data"
  | "unknown";

const localValidationMessages: Record<string, string> = {
  "invalid-analysis-input": "分析队列刚刚发生了变化，可能已被另一次点击、恢复操作或同步接管。请重新进入学习助教后再试。",
  "changed-analysis-input": "分析期间复习重点的冻结输入发生了变化。请重新进入学习助教后再试。",
  "invalid-analysis-batch-size": "本机生成的分析分批不符合约束。这是应用内部问题，不是模型或网络问题。",
  "missing-analysis-batch": "本机找不到刚创建的分析批次，分析可能被恢复或同步操作中断。请重新进入学习助教后再试。",
  "task-uniqueness": "这个复习重点已经有一个未完成的学习助教任务。请重新进入学习助教并继续现有任务。",
  "invalid-content-version": "复习重点的内容版本已经变化。请确认日志保存完成，再重新进入学习助教。",
  "dangling-decision-block": "当前复习重点已经被删除或替换。请返回日志确认内容后再试。",
  "record-mismatch": "复习重点与当前日志记录不再匹配。请返回日志确认内容后再试。",
};

const validationCodeOf = (error: unknown): string | undefined => {
  if (!(error instanceof Error) || error.name !== "ReviewCoachValidationError") return undefined;
  const code = (error as Error & { code?: unknown }).code;
  return typeof code === "string" && /^[a-z0-9-]+$/.test(code) ? code : undefined;
};

const knownCategories = new Set<AnalysisFailureCategory>([
  "authentication",
  "configuration",
  "rate-limit",
  "timeout",
  "network",
  "incompatible-response",
  "invalid-json",
  "schema-mismatch",
  "insufficient-context",
  "local-data",
  "unknown",
]);

const knownStages = new Set([
  "feedback-interpretation",
  "deep-planning",
  "turn-generation",
  "question-quality",
  "answer-evaluation",
]);

const stageLabels: Record<string, string> = {
  "feedback-interpretation": "反馈理解阶段",
  "deep-planning": "深度规划阶段",
  "turn-generation": "出题阶段",
  "question-quality": "题目质检阶段",
  "answer-evaluation": "答案评估阶段",
};

const normalizeAiCategory = (category: string): AnalysisFailureCategory => {
  if (category === "authentication" || category === "configuration" || category === "rate-limit" || category === "timeout" || category === "network") {
    return category;
  }
  if (category === "schema" || category === "response") return "incompatible-response";
  return "unknown";
};

/** Persist only a stable category. Provider responses can contain sensitive or untrusted text. */
export const analysisFailureCode = (error: unknown): string => {
  if (error instanceof ReviewCoachAiDiagnosticError) {
    if (error.kind === "provider-request" && error.cause instanceof AiRequestError) {
      return `analysis:${error.stage}:${normalizeAiCategory(error.cause.category)}`;
    }
    return `analysis:${error.stage}:${error.kind}`;
  }
  if (error instanceof AiRequestError) {
    if (error.message.startsWith("insufficient-context:")) return "analysis:insufficient-context";
    return `analysis:${normalizeAiCategory(error.category)}`;
  }
  const validationCode = validationCodeOf(error);
  if (validationCode) return `analysis:local-data:${validationCode}`;
  if (error instanceof Error && /blueprint|frozen input|evidence|feedback references|interpretation references/i.test(error.message)) {
    return "analysis:incompatible-response";
  }
  return "analysis:unknown";
};

const categoryFromLegacyCode = (code: string | undefined): AnalysisFailureCategory => {
  if (!code) return "unknown";
  const stable = code.startsWith("analysis:") ? code.slice("analysis:".length) : "";
  if (stable.startsWith("local-data:")) return "local-data";
  if (knownCategories.has(stable as AnalysisFailureCategory)) return stable as AnalysisFailureCategory;
  const [, stagedCategory] = stable.split(":", 2);
  if (knownStages.has(stable.split(":", 1)[0] ?? "") && knownCategories.has(stagedCategory as AnalysisFailureCategory)) {
    return stagedCategory as AnalysisFailureCategory;
  }

  // Older app versions stored a truncated exception message. Classify it, but
  // never return it to the UI or copy it into a new batch.
  const legacy = code.toLowerCase();
  if (/401|403|unauthori[sz]ed|authentication|api key|apikey/.test(legacy)) return "authentication";
  if (/429|rate.?limit|quota|配额|限流/.test(legacy)) return "rate-limit";
  if (/timeout|timed out|等待超过|超时/.test(legacy)) return "timeout";
  if (/cors|network|fetch|503|502|504|网络/.test(legacy)) return "network";
  if (/base url|configuration|配置/.test(legacy)) return "configuration";
  if (/insufficient-context/.test(legacy)) return "insufficient-context";
  if (/schema|json|choices|response|unexpected field|invalid .*response/.test(legacy)) return "incompatible-response";
  if (/content-version|analysis-input|decision-block|queue-item|blueprint/.test(legacy)) return "local-data";
  return "unknown";
};

const stagePrefix = (code: string | undefined): string => {
  const stable = code?.startsWith("analysis:") ? code.slice("analysis:".length) : "";
  const stage = stable.split(":", 1)[0] ?? "";
  return stageLabels[stage] ? `${stageLabels[stage]}：` : "";
};

const localValidationCodeFromFailure = (code: string | undefined): string | undefined => {
  const prefix = "analysis:local-data:";
  if (!code?.startsWith(prefix)) return undefined;
  const validationCode = code.slice(prefix.length);
  return /^[a-z0-9-]+$/.test(validationCode) ? validationCode : undefined;
};

const localValidationMessage = (code: string | undefined): string | undefined => {
  const validationCode = localValidationCodeFromFailure(code);
  if (!validationCode) return undefined;
  const message = localValidationMessages[validationCode] ?? categoryMessage["local-data"];
  return `${message}（校验代码 RC-${validationCode}）`;
};

const categoryMessage: Record<AnalysisFailureCategory, string> = {
  authentication: "模型服务认证失败。请在“更多 -> AI 设置”检查当前供应商的 API Key。",
  configuration: "当前模型服务配置不可用。请检查 Base URL、模型名称和 API Key。",
  "rate-limit": "模型服务触发限流或配额不足。请稍后重试，或检查该供应商的额度。",
  timeout: "模型服务在限定时间内没有返回结果。请检查网络后重试。",
  network: "无法连接当前模型服务。请检查代理、网络和 Base URL 后重试。",
  "incompatible-response": "当前模型没有返回学习助教要求的结构化 JSON。请换用支持 OpenAI Chat Completions 与 JSON 输出的模型，或检查中转接口兼容性。",
  "invalid-json": "模型服务已返回内容，但内容不是有效 JSON。可能是中转接口未按结构化输出返回；请重试或检查模型兼容性。",
  "schema-mismatch": "模型服务返回了 JSON，但字段不符合学习助教的任务格式。请重试；若持续失败，请换用支持 JSON 输出的模型或检查中转接口。",
  "insufficient-context": "当前复习重点的信息不足，模型无法生成可靠题目。请补充重点内容或评价后重试。",
  "local-data": "复习重点在分析期间发生了变化，或本机任务数据不一致。请返回日志确认内容已保存，再重新进入学习助教。",
  unknown: "学习助教分析失败，已保留本机记录。请重试；若仍失败，请检查当前模型配置和网络。",
};

export const actionableAnalysisBatchError = (batch: AnalysisBatch): ActionableError | undefined => {
  if (batch.status !== "failed" && batch.status !== "partial") return undefined;
  const failed = batch.subBatches.filter((item) => item.status === "failed");
  const failureCode = failed.find((item) => item.errorCode)?.errorCode ?? batch.errorCode;
  const category = categoryFromLegacyCode(failureCode);
  const modelLabel = [batch.provider, batch.model].filter(Boolean).join(" / ");
  const prefix = batch.status === "partial"
    ? "部分复习重点已生成任务，其余部分未完成。"
    : "没有生成复习任务。";
  const model = modelLabel ? `当前模型：${modelLabel}。` : "";
  return new ActionableError(`${prefix}${model}${stagePrefix(failureCode)}${localValidationMessage(failureCode) ?? categoryMessage[category]}`);
};

export const actionableDirectAnalysisError = (
  error: unknown,
  provider?: { providerName: string; model: string },
): Error => {
  if (isActionableError(error)) return error;
  const code = analysisFailureCode(error);
  if (code === "analysis:unknown") return error instanceof Error ? error : new Error("analysis-failed");
  const category = categoryFromLegacyCode(code);
  const modelLabel = provider ? `${provider.providerName} / ${provider.model}` : "";
  return new ActionableError(`${modelLabel ? `当前模型：${modelLabel}。` : ""}${stagePrefix(code)}${localValidationMessage(code) ?? categoryMessage[category]}`);
};

export const assertAnalysisBatchCompleted = (batch: AnalysisBatch): void => {
  const error = actionableAnalysisBatchError(batch);
  if (error) throw error;
};
