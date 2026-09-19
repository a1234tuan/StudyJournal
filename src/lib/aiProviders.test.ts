import { describe, expect, it } from "vitest";

import { createAiProviderTemplate, createDefaultAiProviders, normalizeAiConfig, normalizeAiProvider, structuredOutputModeForProvider } from "./aiProviders";
import { createDefaultAiPresets } from "../db/defaults";

describe("aiProviders", () => {
  it("creates built-in provider templates", () => {
    expect(createAiProviderTemplate("nvidia")).toMatchObject({
      providerName: "NVIDIA",
      baseUrl: "https://integrate.api.nvidia.com/v1",
      model: "meta/llama-3.3-70b-instruct",
      contextWindowTokens: 65536,
    });
    expect(createAiProviderTemplate("aliyun")).toMatchObject({
      providerName: "阿里云百炼",
      baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
      model: "qwen-plus",
    });
    expect(createAiProviderTemplate("custom-proxy")).toMatchObject({
      providerName: "自定义中转 API",
      baseUrl: "https://api.vectorengine.ai",
      model: "",
    });
  });

  // F-28: the seed model must be one the project actually verified end to end.
  // `deepseek-v4-pro` could not be confirmed to exist, so an out-of-the-box request
  // against the default provider would 404.
  it("seeds the verified DeepSeek v4 flash model for the default provider", () => {
    expect(createAiProviderTemplate("deepseek")).toMatchObject({
      providerName: "DeepSeek",
      baseUrl: "https://api.deepseek.com",
      model: "deepseek-v4-flash",
      builtIn: "deepseek",
    });
  });

  // F-15: `builtIn` is read back from persisted settings, so a value written by a
  // newer build (or tampered data) is not guaranteed to be in the union. The
  // template factory used to fall through the switch and return `undefined`.
  it("falls back to the DeepSeek template for an unknown builtIn value", () => {
    const template = createAiProviderTemplate("some-unreleased-provider" as never);

    expect(template).toMatchObject({
      providerName: "DeepSeek",
      baseUrl: "https://api.deepseek.com",
      model: "deepseek-v4-flash",
      builtIn: "deepseek",
    });
    // A complete profile, not a half-built object.
    expect(template.contextWindowTokens).toBe(65536);
    expect(template.temperature).toBe(0.7);
    expect(template.maxTokens).toBe(4096);
    expect(template.id).toEqual(expect.any(String));
  });

  it("keeps a caller-supplied id for the DeepSeek fallback", () => {
    const created = createAiProviderTemplate("deepseek", "default");
    expect(created.id).toBe("default");
    expect(createAiProviderTemplate("legacy-value" as never, "default").id).toBe("default");
  });

  it("uses a stable identity for the built-in provider", () => {
    expect(createDefaultAiProviders()).toEqual(createDefaultAiProviders());
  });

  it("migrates legacy single-provider AI settings into provider profiles", () => {
    const presets = createDefaultAiPresets();
    const migrated = normalizeAiConfig({
      providerName: "硅基流动",
      baseUrl: "https://api.siliconflow.cn/v1",
      model: "deepseek-ai/DeepSeek-V3",
      temperature: 0.2,
      maxTokens: 2048,
      contextWindowTokens: 32768,
      memoryTurns: 8,
    }, presets);

    expect(migrated.currentProviderId).toBe("default");
    expect(migrated.providers).toHaveLength(1);
    expect(migrated.providers[0]).toMatchObject({
      id: "default",
      providerName: "硅基流动",
      baseUrl: "https://api.siliconflow.cn/v1",
      model: "deepseek-ai/DeepSeek-V3",
      temperature: 0.2,
      maxTokens: 2048,
      memoryTurns: 8,
    });
    expect(migrated.presets).toBe(presets);
  });

  it("keeps user-cleared provider fields instead of restoring DeepSeek defaults", () => {
    const provider = normalizeAiProvider({
      id: "custom",
      providerName: "",
      baseUrl: "",
      model: "",
      temperature: 0.7,
      maxTokens: 4096,
    });

    expect(provider).toMatchObject({
      id: "custom",
      providerName: "",
      baseUrl: "",
      model: "",
    });
    expect(provider.baseUrl).not.toBe("https://api.deepseek.com");
    expect(provider.builtIn).toBeUndefined();
  });

  it("defaults only verified built-in endpoints to JSON object mode", () => {
    expect(structuredOutputModeForProvider({ builtIn: "deepseek", baseUrl: "https://api.deepseek.com" })).toBe("json-object");
    expect(structuredOutputModeForProvider({ builtIn: "deepseek", baseUrl: "https://gemini.example/v1" })).toBe("prompt-only");
    expect(structuredOutputModeForProvider({ builtIn: "custom-proxy", baseUrl: "https://relay.example/v1" })).toBe("prompt-only");
    expect(structuredOutputModeForProvider({ builtIn: "custom-proxy", structuredOutputMode: "json-object" })).toBe("json-object");
  });
});
