import type { AdaptiveQuizTurn, AdaptivePracticeType, SessionBlueprint, TargetFormStatus, VariantEligibility } from "./domain";

/**
 * M4: is this delayed question actually a *new* question?
 *
 * A delayed verification is only meaningful if the learner has not just seen
 * the same prompt. Asking it again immediately, or with one word changed,
 * measures short-term familiarity, not retention (constitution art. 2 and 8).
 *
 * The check is deliberately conservative: it would rather reject a slightly
 * different question than accept a near-copy. Rejecting costs one regeneration;
 * accepting a duplicate silently destroys the verification's meaning.
 *
 * Comparison is normalised for Unicode form, case, width and punctuation, and
 * measured by character-bigram overlap, which survives the light rewording and
 * clause reordering that a generator will otherwise produce for a repeated
 * question. There is no LLM call here: this must be deterministic and free.
 */

/** How much of a question's character n-grams may overlap before it counts as a repeat. */
export const NEAR_DUPLICATE_THRESHOLD = 0.72;

/**
 * n-gram width, in code points.
 *
 * Two, not three. Chinese questions are short and the meaningful units are
 * mostly two characters, so bigrams survive the paraphrases a model actually
 * produces while trigrams do not: reordering a question's clauses breaks nearly
 * every three-character run, which let a pure word-shuffle score 0.36 and pass
 * as "new". Measured over a corpus of deliberate rewrites and deliberate
 * rewrites-plus-new-retrieval, bigrams separate the two groups by ~0.23 while
 * trigrams leave under 0.06 - too narrow to place any threshold in.
 */
const NGRAM_SIZE = 2;

const PUNCTUATION = /[\p{P}\p{S}]/gu;
const WHITESPACE = /\s+/g;

/**
 * Splits into code points, not UTF-16 code units.
 *
 * `"𠮷".length` is 2 and `slice(0, 1)` returns a lone high surrogate, so
 * code-unit slicing corrupts astral characters (rare Han, emoji, some CJK
 * extension blocks) and invents n-grams no other question can match. Iterating
 * the string yields whole code points instead.
 */
const codePoints = (value: string): string[] => [...value];

/**
 * Folds the many ways of writing the same question into one comparable form:
 * NFKC handles full-width/half-width and compatibility forms, lower-casing
 * handles case, and stripping punctuation and whitespace removes formatting
 * noise. Digits are kept - changing a number usually changes the question.
 */
export const normalizeQuestion = (question: string): string => (
  question
    .normalize("NFKC")
    .toLowerCase()
    .replace(PUNCTUATION, "")
    .replace(WHITESPACE, "")
);

const ngrams = (value: string, size = NGRAM_SIZE): Set<string> => {
  const set = new Set<string>();
  const points = codePoints(value);
  if (points.length === 0) return set;
  if (points.length <= size) {
    set.add(points.join(""));
    return set;
  }
  for (let index = 0; index + size <= points.length; index += 1) {
    set.add(points.slice(index, index + size).join(""));
  }
  return set;
};

/** Overlap coefficient, not Jaccard: a short question fully inside a longer one is still a repeat. */
export const ngramSimilarity = (left: string, right: string): number => {
  const a = ngrams(normalizeQuestion(left));
  const b = ngrams(normalizeQuestion(right));
  if (a.size === 0 || b.size === 0) return normalizeQuestion(left) === normalizeQuestion(right) ? 1 : 0;
  let shared = 0;
  for (const gram of a) if (b.has(gram)) shared += 1;
  return shared / Math.min(a.size, b.size);
};

/** Convenience wrapper so callers do not re-derive the comparison direction. */
export const isNearDuplicate = (
  left: string,
  right: string,
  threshold = NEAR_DUPLICATE_THRESHOLD,
): boolean => ngramSimilarity(left, right) >= threshold;

export interface VariantCheckResult {
  eligibility: VariantEligibility;
  /** Machine-readable cause, recorded on the turn for the audit trail. */
  reason?: string;
}

/**
 * Decides whether a freshly generated delayed question can stand as an unseen
 * variant of the questions already asked for this target.
 *
 * Returns `eligible` with no reason when the question is genuinely new, and a
 * specific ineligibility otherwise, so the caller can regenerate and the record
 * can explain what happened.
 */
export const checkVariantEligibility = (
  candidate: { question: string; answerMode?: string },
  previousTurns: readonly AdaptiveQuizTurn[],
  options: { threshold?: number; requireTargetForm?: string } = {},
): VariantCheckResult => {
  const threshold = options.threshold ?? NEAR_DUPLICATE_THRESHOLD;
  const normalized = normalizeQuestion(candidate.question);
  if (normalized.length === 0) return { eligibility: "uncertain", reason: "empty-question" };

  for (const previous of previousTurns) {
    const previousNormalized = normalizeQuestion(previous.question);
    if (previousNormalized === normalized) {
      return { eligibility: "duplicate", reason: `exact-repeat:${previous.id}` };
    }
  }
  for (const previous of previousTurns) {
    if (isNearDuplicate(candidate.question, previous.question, threshold)) {
      return { eligibility: "duplicate", reason: `near-repeat:${previous.id}` };
    }
  }

  // A target-form match is about the retrieval the question asks for, not its
  // wording. When the caller knows which form the target requires, a mismatch
  // makes the question training rather than verification.
  if (options.requireTargetForm && candidate.answerMode && candidate.answerMode !== options.requireTargetForm) {
    return { eligibility: "not-applicable", reason: `form-mismatch:${candidate.answerMode}` };
  }

  return { eligibility: "eligible" };
};

/**
 * The first independently attempted turn of a verification.
 *
 * The delayed verification locks onto this turn the moment it is answered. Any
 * later remedial attempt is practice; it cannot rewrite what the first unaided
 * attempt showed. This is what stops "retry until right" masquerading as
 * retention.
 */
export const lockedVerificationTurn = (
  turns: readonly AdaptiveQuizTurn[],
): AdaptiveQuizTurn | undefined => {
  if (turns.length === 0) return undefined;
  const ordered = [...turns].sort((left, right) => left.sequence - right.sequence);
  const firstWithPhase = ordered.find((turn) => turn.phase === "delayed-first" && turn.status === "answered");
  if (firstWithPhase) return firstWithPhase;
  return ordered.find((turn) => turn.status === "answered" && turn.answerText !== "[skipped]");
};

/** True when the turn is a genuine unseen variant rather than training in disguise. */
export const isUnseenVariant = (turn: AdaptiveQuizTurn): boolean => (
  turn.variantEligibility === "eligible"
  && (turn.targetFormStatus === undefined || turn.targetFormStatus === "target-form")
);

/**
 * Records which form the generated question actually asked for, relative to the
 * form the blueprint intended.
 *
 * This is stamped, not assumed. The previous code wrote `"target-form"` onto
 * every v2 turn before anything had checked the question, so a question that
 * drifted into another form still satisfied `isUnseenVariant` and counted as
 * on-target verification evidence. A verification is only about the target when
 * it retrieves the target's form; a drift makes the turn training, and training
 * cannot close a loop.
 *
 * Only a positive, checkable mismatch downgrades the turn. Everything else that
 * cannot be confirmed stays `"unknown"`, because an unrecognised form must never
 * be silently upgraded to evidence of having practised the target.
 */
export const targetFormStatusFor = (
  candidate: { practiceType: AdaptivePracticeType },
  blueprint: Pick<SessionBlueprint, "initialPracticeType">,
): TargetFormStatus => {
  const expected = blueprint.initialPracticeType;
  if (!expected) return "unknown";
  return candidate.practiceType === expected ? "target-form" : "training-form";
};
