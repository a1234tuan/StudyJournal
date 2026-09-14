import { describe, expect, it } from "vitest";

import type { AiProviderProfile } from "../../types";
import { ActionableError } from "../../lib/uiError";
import { assertTurnContextBudget, estimateTurnInputTokens, maxTurnInputTokensForProvider } from "./contextBudget";

const provider = (overrides: Partial<AiProviderProfile> = {}): AiProviderProfile => ({
  id: "deep",
  providerName: "DeepSeek",
  baseUrl: "https://api.deepseek.com",
  model: "deepseek-v4-flash",
  temperature: 0,
  maxTokens: 4_096,
  contextWindowTokens: 65_536,
  ...overrides,
});

describe("turn context budget", () => {
  it("leaves the analysis ceiling intact and subtracts only the turn prompt overhead", () => {
    // The analysis ceiling for this provider is 65536 - 4096 - 2000 = 59440.
    expect(maxTurnInputTokensForProvider(provider())).toBe(59_440 - 700);
  });

  it("accepts a decision block that fits", () => {
    expect(() => assertTurnContextBudget(provider(), "决策块材料：B 树的叶节点深度相同。")).not.toThrow();
  });

  it("rejects an oversized decision block with an actionable error before the provider is called", () => {
    const tiny = provider({ contextWindowTokens: 2_000, maxTokens: 1_500 });
    expect(maxTurnInputTokensForProvider(tiny)).toBe(1_000);
    const oversized = "a".repeat(4_000);
    expect(estimateTurnInputTokens(oversized)).toBeGreaterThan(1_000);
    expect(() => assertTurnContextBudget(tiny, oversized)).toThrow(ActionableError);
    expect(() => assertTurnContextBudget(tiny, oversized)).toThrow("这个决策块的内容过长");
  });

  it("counts the prompt framing even for empty material", () => {
    expect(estimateTurnInputTokens("")).toBeGreaterThan(700);
  });
});
