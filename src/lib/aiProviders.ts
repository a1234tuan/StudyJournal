import type { AiProviderConfig, AiProviderProfile } from "../types";
import { newId } from "./entity";

export const DEFAULT_AI_MEMORY_TURNS = 12;
export const DEFAULT_AI_CONTEXT_WINDOW_TOKENS = 65_536;

export type AiStructuredOutputMode = NonNullable<AiProviderProfile["structuredOutputMode"]>;

export const structuredOutputModeForProvider = (provider: Pick<AiProviderProfile, "builtIn" | "structuredOutputMode"> & Partial<Pick<AiProviderProfile, "baseUrl">>): AiStructuredOutputMode => {
  if (provider.structuredOutputMode) return provider.structuredOutputMode;
  if (!provider.builtIn || provider.builtIn === "custom-proxy") return "prompt-only";
  let host = "";
  try { host = new URL(provider.baseUrl ?? "").hostname.toLowerCase(); } catch { /* invalid URL is handled by request validation */ }
  const expectedHost = provider.builtIn === "deepseek"
    ? "api.deepseek.com"
    : provider.builtIn === "nvidia"
      ? "integrate.api.nvidia.com"
      : "dashscope.aliyuncs.com";
  return host === expectedHost ? "json-object" : "prompt-only";
};

const baseProvider = (): Omit<AiProviderProfile, "id" | "providerName" | "baseUrl" | "model" | "builtIn"> => ({
  temperature: 0.7,
  maxTokens: 4096,
  contextWindowTokens: DEFAULT_AI_CONTEXT_WINDOW_TOKENS,
  memoryTurns: DEFAULT_AI_MEMORY_TURNS,
});

export const createAiProviderTemplate = (
  builtIn: NonNullable<AiProviderProfile["builtIn"]>,
  id = newId(),
): AiProviderProfile => {
  const base = baseProvider();
  switch (builtIn) {
    // Unknown or legacy builtIn values read from persisted settings fall back to the
    // documented default provider instead of returning undefined.
    case "deepseek":
    default:
      return {
        ...base,
        id,
        providerName: "DeepSeek",
        baseUrl: "https://api.deepseek.com",
        model: "deepseek-v4-flash",
        structuredOutputMode: "json-object",
        builtIn: "deepseek",
      };
    case "nvidia":
      return {
        ...base,
        id,
        providerName: "NVIDIA",
        baseUrl: "https://integrate.api.nvidia.com/v1",
        model: "meta/llama-3.3-70b-instruct",
        structuredOutputMode: "json-object",
        builtIn,
      };
    case "aliyun":
      return {
        ...base,
        id,
        providerName: "阿里云百炼",
        baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
        model: "qwen-plus",
        structuredOutputMode: "json-object",
        builtIn,
      };
    case "custom-proxy":
      return {
        ...base,
        id,
        providerName: "自定义中转 API",
        baseUrl: "https://api.vectorengine.ai",
        model: "",
        structuredOutputMode: "prompt-only",
        builtIn,
      };
  }
};

export const createDefaultAiProviders = (): AiProviderProfile[] => [
  createAiProviderTemplate("deepseek", "default"),
];

type LegacyAiConfig = Partial<AiProviderProfile> & Partial<AiProviderConfig>;
type SingleProviderLegacyAiConfig = LegacyAiConfig & Pick<AiProviderProfile, "baseUrl" | "model">;

const isLegacyProviderConfig = (value: LegacyAiConfig | undefined): value is SingleProviderLegacyAiConfig =>
  Boolean(value && "baseUrl" in value && "model" in value && !("providers" in value));

export const normalizeAiProvider = (provider: Partial<AiProviderProfile>): AiProviderProfile => {
  const fallback = createAiProviderTemplate("deepseek");
  return {
    ...fallback,
    ...provider,
    id: provider.id?.trim() || fallback.id,
    providerName: typeof provider.providerName === "string" ? provider.providerName.trim() : fallback.providerName,
    baseUrl: typeof provider.baseUrl === "string" ? provider.baseUrl.trim() : fallback.baseUrl,
    model: typeof provider.model === "string" ? provider.model.trim() : fallback.model,
    temperature: Number(provider.temperature) || fallback.temperature,
    maxTokens: Number(provider.maxTokens) || fallback.maxTokens,
    contextWindowTokens: Number(provider.contextWindowTokens) || fallback.contextWindowTokens,
    memoryTurns: Number(provider.memoryTurns) || DEFAULT_AI_MEMORY_TURNS,
    // Missing capability metadata means "custom/unknown", not DeepSeek. The
    // fallback supplies numeric defaults only; inheriting its builtIn marker
    // would make Gemini and relays receive DeepSeek-specific request fields.
    builtIn: provider.builtIn,
    structuredOutputMode: provider.structuredOutputMode === "json-object" || provider.structuredOutputMode === "prompt-only"
      ? provider.structuredOutputMode
      : structuredOutputModeForProvider(provider),
  };
};

export const normalizeAiConfig = (
  ai: LegacyAiConfig | undefined,
  presets: AiProviderConfig["presets"],
): AiProviderConfig => {
  if (isLegacyProviderConfig(ai)) {
    const legacy = ai;
    const provider = normalizeAiProvider({
      id: "default",
      providerName: legacy.providerName,
      baseUrl: legacy.baseUrl,
      model: legacy.model,
      temperature: legacy.temperature,
      maxTokens: legacy.maxTokens,
      contextWindowTokens: legacy.contextWindowTokens,
      memoryTurns: legacy.memoryTurns,
      builtIn: legacy.providerName === "DeepSeek" ? "deepseek" : undefined,
    });
    return {
      currentProviderId: provider.id,
      providers: [provider],
      presets,
      imageInputMode: legacy.imageInputMode ?? "local-ocr",
    };
  }

  const normalizedProviders = (ai?.providers?.length ? ai.providers : createDefaultAiProviders()).map(normalizeAiProvider);
  const currentProviderId = normalizedProviders.some((provider) => provider.id === ai?.currentProviderId)
    ? ai?.currentProviderId ?? normalizedProviders[0].id
    : normalizedProviders[0].id;

  return {
    currentProviderId,
    providers: normalizedProviders,
    presets,
    imageInputMode: ai?.imageInputMode ?? "local-ocr",
  };
};

export const getCurrentAiProvider = (config: AiProviderConfig | undefined): AiProviderProfile | undefined => {
  if (!config?.providers.length) {
    return undefined;
  }
  return config.providers.find((provider) => provider.id === config.currentProviderId) ?? config.providers[0];
};
