import { ReviewCoachValidationError } from "./validation";

/**
 * C-4 (F-20): a deterministic, local answer-leakage check.
 *
 * Why local and not another model call: the product boundary document (`docs/新的方案.md` §8.3)
 * says open questions get local structural and source-constraint validation only, and a second
 * paid call per turn would raise cost for every question. This catches the most common leak — the
 * question or a hint simply reciting an acceptance criterion.
 *
 * Boundary of what this can do: it only catches a criterion that appears *verbatim* (after
 * normalisation) in the question or a hint. A semantically equivalent paraphrase still gets
 * through, and a short criterion can match by coincidence — which is why criteria shorter than
 * `MIN_LEAK_CRITERION_LENGTH` are skipped rather than guessed at. This check is necessary, not
 * sufficient. It must never call a model.
 */

/** Criteria at or below this normalised length are too short to judge reliably, so they are skipped. */
export const MIN_LEAK_CRITERION_LENGTH = 3;

/** Folds full-width forms, whitespace, punctuation and case so cosmetic variants still match. */
export const normalizeForLeakCheck = (text: string): string => text
  .replace(/[\uFF01-\uFF5E]/g, (character) => String.fromCharCode(character.charCodeAt(0) - 0xFEE0))
  .replace(/[\u3000\u00A0]/g, " ")
  .toLowerCase()
  .replace(/[^\p{L}\p{N}]+/gu, "");

export interface LeakCheckCandidate {
  question: string;
  hints: readonly string[];
  answerCriteria: readonly string[];
}

/** Returns the criteria that leak, in input order. Empty means "no leak detected". */
export const findLeakedCriteria = (candidate: LeakCheckCandidate): string[] => {
  const question = normalizeForLeakCheck(candidate.question);
  const hints = candidate.hints.map(normalizeForLeakCheck);
  return candidate.answerCriteria.filter((criterion) => {
    const normalized = normalizeForLeakCheck(criterion);
    if (normalized.length < MIN_LEAK_CRITERION_LENGTH) return false;
    return question.includes(normalized) || hints.some((hint) => hint.includes(normalized));
  });
};

export const assertNoAnswerLeakage = (candidate: LeakCheckCandidate): void => {
  const leaked = findLeakedCriteria(candidate);
  if (leaked.length > 0) {
    throw new ReviewCoachValidationError(
      "answer-leakage",
      `题面或提示泄露了答案判据：${leaked.join("、")}`,
    );
  }
};
