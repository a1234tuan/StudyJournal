/**
 * Shared, dependency-free token estimation used by every AI request path.
 *
 * The estimate intentionally over-counts rather than under-counts, so callers that budget
 * against this number stay below the provider's real context window. It is the single source
 * of truth for: the AI Q&A context packer (`aiContextService`), the review-coach planner, the
 * knowledge-scope picker, and the voice-recall material planner (`teacherPrompt`).
 */

/** Tokens charged per CJK character (Han / Hiragana / Katakana / Hangul). */
export const AI_TOKENS_PER_CJK_CHAR = 1.5 * 1.1;
/** Tokens charged per non-CJK (latin / digit / whitespace / symbol) character. */
export const AI_TOKENS_PER_LATIN_CHAR = (1 / 3) * 1.1;
/** Fixed per-string overhead added before the safety multiplier. */
export const AI_TOKEN_ESTIMATE_OVERHEAD = 8 * 1.1;
/**
 * Lower bound of the per-character cost. Because CJK costs more than latin, dividing a token
 * budget by this value yields a character count that can never exceed that budget.
 */
export const AI_MIN_TOKENS_PER_CHAR = AI_TOKENS_PER_LATIN_CHAR;

const CJK_CHARACTER_PATTERN = /\p{Script=Han}|\p{Script=Hiragana}|\p{Script=Katakana}|\p{Script=Hangul}/u;

export const isCjkCharacter = (char: string): boolean => CJK_CHARACTER_PATTERN.test(char);

/** Counts CJK characters in the value (same set the estimator charges 1.65 tokens for). */
export const countCjkCharacters = (value: string): number => {
  let cjk = 0;
  for (const char of value) {
    if (CJK_CHARACTER_PATTERN.test(char)) cjk += 1;
  }
  return cjk;
};

/**
 * A deliberately conservative local estimate used to stay below provider context windows.
 *
 * Behaviour is intentionally preserved from the original implementation that lived in
 * `aiContextService`: an empty string still reports the fixed overhead, because a request
 * always carries framing tokens even when the payload is empty.
 */
export const estimateAiTokens = (value: string): number => {
  const chars = Array.from(value);
  let cjk = 0;
  for (const char of chars) {
    if (CJK_CHARACTER_PATTERN.test(char)) cjk += 1;
  }
  return Math.ceil((cjk * 1.5 + (chars.length - cjk) / 3 + 8) * 1.1);
};
