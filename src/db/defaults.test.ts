import { describe, expect, it } from "vitest";

import {
  createDefaultAiPresets,
  DEFAULT_SETTINGS,
  isCodeBiasedDefaultAiPresetSet,
  isLegacyDefaultAiPresetSet,
} from "./defaults";
import { createBaseEntity } from "../lib/entity";

describe("default AI settings", () => {
  it("uses DeepSeek v4 flash compatible defaults", () => {
    expect(DEFAULT_SETTINGS.ai?.currentProviderId).toBe("default");
    expect(DEFAULT_SETTINGS.ai?.providers[0]).toMatchObject({
      id: "default",
      providerName: "DeepSeek",
      baseUrl: "https://api.deepseek.com",
      model: "deepseek-v4-flash",
    });
  });

  it("creates the five built-in learning coach prompts", () => {
    const presets = createDefaultAiPresets();
    expect(presets).toEqual(createDefaultAiPresets());

    expect(presets.map((preset) => preset.title)).toEqual([
      "白纸复述测试",
      "变形应用题",
      "盲区挖掘",
      "费曼讲解测试",
      "我的理解对不对",
    ]);
    expect(presets.map((preset) => preset.mode)).toEqual([
      "recall",
      "application",
      "trap",
      "feynman",
      "correction",
    ]);
    expect(presets[0].prompt).toContain("请扮演严格学习考官");
    expect(presets[1].prompt).toContain("学习掌握标准");
    expect(presets[1].prompt).toContain("概念或方法明显不稳");
    expect(presets[2].prompt).toContain("未知的未知");
    expect(presets[4].prompt).toContain("请等我输入");
    expect(presets.map((preset) => preset.prompt).join("\n")).not.toMatch(/生产代码|业务场景|能跑|投入生产/);
  });

  it("detects the old four-prompt default set without matching custom prompt sets", () => {
    const oldPresets = ["5 道自测题", "随机抽问", "薄弱点总结", "明日复习计划"].map((title, order) => ({
      ...createBaseEntity(),
      title,
      prompt: title,
      order,
    }));

    expect(isLegacyDefaultAiPresetSet(oldPresets)).toBe(true);
    expect(isLegacyDefaultAiPresetSet(createDefaultAiPresets())).toBe(false);
    expect(isLegacyDefaultAiPresetSet([{ ...oldPresets[0], title: "我自己的提示词" }])).toBe(false);
  });

  it("detects the code-biased default prompt set without matching custom prompts", () => {
    const codeBiased = createDefaultAiPresets().map((preset) => ({
      ...preset,
      prompt: preset.title === "变形应用题"
        ? "请基于今天日志出题，并按生产代码标准批改；B = 能跑但有隐患；A = 可以投入生产。"
        : preset.prompt,
    }));
    const custom = createDefaultAiPresets().map((preset) => ({
      ...preset,
      prompt: preset.title === "变形应用题"
        ? "我自己的业务场景复习提示词"
        : preset.prompt,
      title: preset.title === "变形应用题" ? "我的自定义应用题" : preset.title,
    }));

    expect(isCodeBiasedDefaultAiPresetSet(codeBiased)).toBe(true);
    expect(isCodeBiasedDefaultAiPresetSet(createDefaultAiPresets())).toBe(false);
    expect(isCodeBiasedDefaultAiPresetSet(custom)).toBe(false);
  });
});
