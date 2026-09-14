import { describe, expect, it } from "vitest";

import { MIN_LEAK_CRITERION_LENGTH, assertNoAnswerLeakage, findLeakedCriteria, normalizeForLeakCheck } from "./questionIntegrity";
import { ReviewCoachValidationError } from "./validation";

const candidate = (question: string, hints: string[] = [], answerCriteria: string[] = ["在入队前标记"]) => ({ question, hints, answerCriteria });

describe("review coach local answer-leakage check (F-20)", () => {
  it("folds full-width forms and spacing before comparing", () => {
    expect(normalizeForLeakCheck(" ＡＢＣ，１２３ ")).toBe("abc123");
    expect(normalizeForLeakCheck("Mark Before Enqueue")).toBe("markbeforeenqueue");
  });

  it("flags a question that recites a criterion", () => {
    expect(findLeakedCriteria(candidate("请问在入队前标记是对的吗？"))).toEqual(["在入队前标记"]);
  });

  it("sees through full-width and whitespace variants of the same criterion", () => {
    expect(findLeakedCriteria(candidate("请问在入队前标记 对吗？"))).toEqual(["在入队前标记"]);
    expect(findLeakedCriteria({ question: "Should a node be marked before enqueueing?", hints: [], answerCriteria: ["before enqueue"] }))
      .toEqual(["before enqueue"]);
  });

  it("flags a criterion hidden in a hint, not just in the question", () => {
    expect(findLeakedCriteria(candidate("BFS 标记时机", ["回忆一下：在入队前标记"]))).toEqual(["在入队前标记"]);
  });

  it("does not flag a question that only cites the source material", () => {
    expect(findLeakedCriteria(candidate("根据教材中 BFS 一节的伪代码，说明访问标记放在哪一步。"))).toEqual([]);
  });

  it("silently skips criteria too short to judge reliably", () => {
    // Two characters would match half the Chinese language; the promise is "necessary, not
    // sufficient", so an unreliable signal is dropped instead of guessed at.
    expect(findLeakedCriteria({ question: "顺序是什么？", hints: [], answerCriteria: ["顺序"] })).toEqual([]);
    expect("顺序".length).toBeLessThan(MIN_LEAK_CRITERION_LENGTH);
  });

  it("throws a typed validation error the UI can format", () => {
    expect(() => assertNoAnswerLeakage(candidate("在入队前标记即可"))).toThrowError(
      expect.objectContaining<Partial<ReviewCoachValidationError>>({ code: "answer-leakage" }),
    );
    expect(() => assertNoAnswerLeakage(candidate("说明访问标记放在哪一步"))).not.toThrow();
  });

  it("is deterministic and never needs a provider", () => {
    const first = findLeakedCriteria(candidate("在入队前标记即可"));
    const second = findLeakedCriteria(candidate("在入队前标记即可"));

    expect(first).toEqual(second);
  });
});
