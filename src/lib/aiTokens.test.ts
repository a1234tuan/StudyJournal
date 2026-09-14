import { describe, expect, it } from "vitest";

import {
  AI_MIN_TOKENS_PER_CHAR,
  countCjkCharacters,
  estimateAiTokens,
  isCjkCharacter,
} from "./aiTokens";
import { estimateAiTokens as estimateFromContextService } from "../services/aiContextService";

describe("aiTokens", () => {
  it("is the same function the AI context service re-exports", () => {
    expect(estimateFromContextService).toBe(estimateAiTokens);
  });

  it("counts CJK characters across the scripts the estimator charges for", () => {
    expect(countCjkCharacters("汉字かなカナ한글")).toBe(8);
    expect(countCjkCharacters("abc 123 ,.!")).toBe(0);
    expect(countCjkCharacters("汉a字b")).toBe(2);
    expect(isCjkCharacter("汉")).toBe(true);
    expect(isCjkCharacter("漢")).toBe(true);
    expect(isCjkCharacter("a")).toBe(false);
  });

  it("charges more per CJK character than per latin character", () => {
    expect(estimateAiTokens("汉".repeat(200))).toBeGreaterThan(estimateAiTokens("x".repeat(200)));
  });

  it("keeps the fixed overhead so an empty payload is never free", () => {
    // A request always carries framing tokens even with no content.
    expect(estimateAiTokens("")).toBe(9);
    expect(estimateAiTokens("")).toBeGreaterThan(0);
  });

  it("never costs less than the cheapest per-character rate", () => {
    // This is the property that makes a budget divided by AI_MIN_TOKENS_PER_CHAR safe as a
    // character ceiling.
    for (const value of ["a".repeat(500), "汉".repeat(500), "a汉".repeat(250), "mixed 汉字 text 123"]) {
      expect(estimateAiTokens(value)).toBeGreaterThanOrEqual(Math.floor(Array.from(value).length * AI_MIN_TOKENS_PER_CHAR));
    }
  });

  it("is monotonic in length", () => {
    const base = "极限计算步骤";
    let previous = 0;
    for (let length = 0; length <= base.length * 20; length += 1) {
      const value = base.repeat(20).slice(0, length);
      const tokens = estimateAiTokens(value);
      expect(tokens).toBeGreaterThanOrEqual(previous);
      previous = tokens;
    }
  });
});
