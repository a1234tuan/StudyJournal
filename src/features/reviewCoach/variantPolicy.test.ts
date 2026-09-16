import { describe, expect, it } from "vitest";

import type { AdaptiveQuizTurn, SessionBlueprint } from "./domain";
import {
  NEAR_DUPLICATE_THRESHOLD,
  checkVariantEligibility,
  isNearDuplicate,
  isUnseenVariant,
  lockedVerificationTurn,
  ngramSimilarity,
  normalizeQuestion,
  targetFormStatusFor,
} from "./variantPolicy";
import { coachTestBlock, coachTestStamp } from "./reviewCoachTestFixtures";

/**
 * M4: a delayed question is only a verification if it is genuinely unseen.
 *
 * These tests pin the conservative side of the trade-off: it is better to
 * regenerate a question that was probably fine than to accept one that is
 * probably a copy.
 */

const turn = (
  sequence: number,
  question: string,
  overrides: Partial<AdaptiveQuizTurn> = {},
): AdaptiveQuizTurn => ({
  id: `turn-${sequence}`,
  taskId: "task-v2-1",
  decisionBlockId: coachTestBlock.id,
  recordId: coachTestBlock.recordId,
  contentVersion: 1,
  sequence,
  status: "answered",
  practiceType: "variation",
  answerMode: "open",
  question,
  displayedAt: coachTestStamp,
  sourceEvidence: [],
  answerCriteria: ["criterion"],
  hintsUsed: [],
  answerText: `answer ${sequence}`,
  answeredAt: coachTestStamp,
  assessment: "correct",
  qualityChecked: true,
  generationModel: "test",
  promptVersion: "p",
  policyVersion: "policy",
  idempotencyKey: `turn-${sequence}`,
  createdAt: coachTestStamp,
  updatedAt: coachTestStamp,
  ...overrides,
});

describe("variant eligibility (M4)", () => {
  it("normalizes width, case, punctuation and whitespace before comparing", () => {
    expect(normalizeQuestion("ＢＦＳ 中，节点何时被标记？")).toBe(normalizeQuestion("bfs中节点何时被标记"));
    expect(normalizeQuestion("Mark visited.   Then enqueue!")).toBe("markvisitedthenenqueue");
  });

  it("rejects an exact repeat", () => {
    const result = checkVariantEligibility(
      { question: "BFS 中节点何时被标记？" },
      [turn(1, "BFS 中节点何时被标记？")],
    );
    expect(result.eligibility).toBe("duplicate");
    expect(result.reason).toContain("exact-repeat");
  });

  it("rejects an exact repeat that only differs by punctuation and width", () => {
    const result = checkVariantEligibility(
      { question: "BFS中节点何时被标记" },
      [turn(1, "ＢＦＳ 中，节点何时被标记？")],
    );
    expect(result.eligibility).toBe("duplicate");
  });

  it("rejects a near repeat with light rewording", () => {
    const original = "BFS 中节点何时被标记为已访问？";
    const reworded = "BFS 中，节点在什么时候被标记为已访问？";
    expect(ngramSimilarity(original, reworded)).toBeGreaterThanOrEqual(NEAR_DUPLICATE_THRESHOLD);
    expect(checkVariantEligibility({ question: reworded }, [turn(1, original)]).eligibility).toBe("duplicate");
  });

  it("rejects an inserted filler phrase", () => {
    const result = checkVariantEligibility(
      { question: "请说明快速排序在最坏情况下的时间复杂度是多少。" },
      [turn(1, "请说明快速排序的最坏时间复杂度是多少。")],
    );
    expect(result.eligibility).toBe("duplicate");
  });

  it("rejects a rewrite that only swaps two words around", () => {
    const result = checkVariantEligibility(
      { question: "线程和进程的区别是什么？" },
      [turn(1, "进程和线程的区别是什么？")],
    );
    expect(result.eligibility).toBe("duplicate");
  });

  it("rejects an English rewrite that only moves the trailing verb", () => {
    const result = checkVariantEligibility(
      { question: "Why does BFS mark nodes before enqueueing? Explain." },
      [turn(1, "Explain why BFS marks nodes before enqueueing.")],
    );
    expect(result.eligibility).toBe("duplicate");
  });

  it("accepts a genuinely different question on the same target", () => {
    const result = checkVariantEligibility(
      { question: "如果图中存在环，BFS 的 visited 标记如何防止无限循环？写出你的推理。" },
      [turn(1, "BFS 中节点何时被标记为已访问？")],
    );
    expect(result.eligibility).toBe("eligible");
    expect(result.reason).toBeUndefined();
  });

  it("rejects a surface rewrite that only reorders the same words", () => {
    const original = "解释 BFS 为什么在入队前标记节点";
    const reordered = "标记节点为什么在入队前 BFS 解释";
    expect(checkVariantEligibility({ question: reordered }, [turn(1, original)]).eligibility).toBe("duplicate");
  });

  it("rejects a reorder regardless of which string is the candidate", () => {
    // Argument order must not matter: the generator does not know which of the
    // two strings the history holds, and an asymmetric test would leak.
    const original = "解释 BFS 为什么在入队前标记节点";
    const reordered = "标记节点为什么在入队前 BFS 解释";
    expect(isNearDuplicate(original, reordered)).toBe(true);
    expect(isNearDuplicate(reordered, original)).toBe(true);
  });

  it("keeps genuine new retrievals on the same target safely below the threshold", () => {
    // These all share the target's vocabulary (BFS, 标记, 已访问) but ask for a
    // different retrieval. The margin below the threshold is what stops the
    // duplicate check from eating every question the generator produces.
    const seen = "BFS 中节点何时被标记为已访问？";
    const fresh = [
      "如果图中存在环，BFS 的 visited 标记如何防止无限循环？写出你的推理。",
      "BFS 标记已访问节点后如何影响后续入队顺序？",
      "当图中有孤立的顶点时，BFS 的已访问标记会怎么处理？",
      "为什么 BFS 需要队列而不是栈？",
      "BFS 与 DFS 的遍历顺序有什么本质不同？",
    ];
    for (const question of fresh) {
      expect(ngramSimilarity(seen, question)).toBeLessThan(NEAR_DUPLICATE_THRESHOLD);
      expect(checkVariantEligibility({ question }, [turn(1, seen)]).eligibility).toBe("eligible");
    }
  });

  it("counts n-grams in code points so astral characters are not split", () => {
    // "𠮷" is a single code point but two UTF-16 code units. Slicing by code
    // unit would produce lone surrogates and lose the n-grams that span it,
    // making two identical questions look different.
    const withAstral = "𠮷 字符在 BFS 中如何被标记？";
    const sameAgain = "𠮷 字符在 BFS 中如何被标记？";
    expect(ngramSimilarity(withAstral, sameAgain)).toBe(1);
    expect(checkVariantEligibility({ question: withAstral }, [turn(1, sameAgain)]).eligibility).toBe("duplicate");
  });

  it("accepts a genuinely different question on the same target", () => {
    const result = checkVariantEligibility(
      { question: "如果图中存在环，BFS 的 visited 标记如何防止无限循环？写出你的推理。" },
      [turn(1, "BFS 中节点何时被标记为已访问？")],
    );
    expect(result.eligibility).toBe("eligible");
    expect(result.reason).toBeUndefined();
  });

  it("treats an empty question as uncertain rather than eligible", () => {
    const result = checkVariantEligibility({ question: "   " }, []);
    expect(result.eligibility).toBe("uncertain");
  });

  it("flags a form mismatch as training rather than verification", () => {
    const result = checkVariantEligibility(
      { question: "写出一段全新的边界条件说明。", answerMode: "open" },
      [turn(1, "旧题")],
      { requireTargetForm: "unique" },
    );
    expect(result.eligibility).toBe("not-applicable");
    expect(result.reason).toContain("form-mismatch");
  });

  it("locks onto the first delayed attempt and never the later remedial one", () => {
    const first = turn(1, "延迟题：首次独立尝试", { phase: "delayed-first", assessment: "incorrect" });
    const remedial = turn(2, "补救练习", { phase: "delayed-remediation", assessment: "correct" });
    expect(lockedVerificationTurn([remedial, first])!.id).toBe(first.id);
  });

  it("keeps a duplicated or off-form attempt out of the unseen-variant set", () => {
    expect(isUnseenVariant(turn(1, "q", { variantEligibility: "duplicate" }))).toBe(false);
    expect(isUnseenVariant(turn(1, "q", { variantEligibility: "eligible", targetFormStatus: "training-form" }))).toBe(false);
    expect(isUnseenVariant(turn(1, "q", { variantEligibility: "eligible", targetFormStatus: "target-form" }))).toBe(true);
  });
});

describe("targetFormStatusFor", () => {
  const blueprintWith = (initialPracticeType: SessionBlueprint["initialPracticeType"]) => (
    { initialPracticeType } as Pick<SessionBlueprint, "initialPracticeType">
  );

  it("confirms the target form only when the generated form actually matches", () => {
    expect(targetFormStatusFor({ practiceType: "concept-question" }, blueprintWith("concept-question")))
      .toBe("target-form");
    expect(targetFormStatusFor({ practiceType: "calculation" }, blueprintWith("calculation")))
      .toBe("target-form");
  });

  it("marks a drifted practice type as training, not verification", () => {
    // The blueprint planned open production; the generator produced a
    // recognition item. Stamping that `target-form` was the defect.
    const status = targetFormStatusFor({ practiceType: "cloze" }, blueprintWith("concept-question"));
    expect(status).toBe("training-form");
    expect(isUnseenVariant(turn(1, "q", { variantEligibility: "eligible", targetFormStatus: status }))).toBe(false);
  });

  it("never upgrades an unplanned form to target-form", () => {
    expect(targetFormStatusFor({ practiceType: "concept-question" }, { initialPracticeType: undefined as never }))
      .toBe("unknown");
    expect(targetFormStatusFor({ practiceType: "concept-question" }, blueprintWith("variation")))
      .toBe("training-form");
  });
});
