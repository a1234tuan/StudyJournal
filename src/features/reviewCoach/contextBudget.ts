/**
 * Input-budget guard for review-coach AI calls.
 *
 * Why this exists: the answer evaluator now receives the full decision-block material
 * (`decisionBlockContent`) in addition to the question, criteria, and answer. A large
 * decision block can therefore push a single request past the provider's context window.
 * The analysis path already had a ceiling (`maxAnalysisInputTokensForProvider`); the quiz
 * path did not. Rather than inventing a second threshold, this reuses the analysis ceiling
 * so the whole coach module reasons about one input budget.
 *
 * The estimate is deliberately conservative (see `lib/aiTokens`), so callers that stay under
 * this number are guaranteed to stay under the real window.
 */
import type { AiProviderProfile } from "../../types";
import { estimateAiTokens } from "../../lib/aiTokens";
import { ActionableError } from "../../lib/uiError";
import { maxAnalysisInputTokensForProvider } from "./analysisPlanner";

/** Framing tokens for the turn/evaluation prompt itself: instructions plus JSON envelope. */
const TURN_PROMPT_OVERHEAD_TOKENS = 700;

export const maxTurnInputTokensForProvider = (provider: AiProviderProfile): number =>
  Math.max(1_000, maxAnalysisInputTokensForProvider(provider) - TURN_PROMPT_OVERHEAD_TOKENS);

export const estimateTurnInputTokens = (markdown: string): number =>
  estimateAiTokens(markdown) + TURN_PROMPT_OVERHEAD_TOKENS;

/**
 * Throws before the provider is called when the decision-block material cannot fit.
 * Failing here is strictly better than letting the provider reject the request with an
 * opaque error: the user gets an action they can take.
 */
export const assertTurnContextBudget = (provider: AiProviderProfile, decisionBlockContent: string): void => {
  const estimated = estimateTurnInputTokens(decisionBlockContent);
  const max = maxTurnInputTokensForProvider(provider);
  if (estimated > max) {
    throw new ActionableError(`这个决策块的内容过长（约 ${estimated} tokens，上限 ${max}）。请拆分决策块，或先完成其中的图片 OCR 后再开始训练。`);
  }
};
