import type { TtsProviderConfig, TtsProviderId, TtsProviderProfile } from "../types";
import { newId } from "./entity";

export const createTtsProviderTemplate = (providerId: TtsProviderId, id = newId()): TtsProviderProfile => {
  switch (providerId) {
    case "fish-audio":
      return {
        id,
        providerId,
        providerName: "Fish Audio",
        model: "s2.1-pro-free",
        voice: "",
      };
    case "aliyun":
      return {
        id,
        providerId,
        providerName: "阿里云百炼",
        model: "qwen3-tts-flash",
        voice: "Cherry",
      };
    case "tencent":
      return {
        id,
        providerId,
        providerName: "腾讯云",
        model: "",
        voice: "101001",
        region: "ap-guangzhou",
      };
    case "google":
      return {
        id,
        providerId,
        providerName: "Google Cloud",
        model: "",
        voice: "cmn-CN-Wavenet-A",
        languageCode: "cmn-CN",
      };
    case "doubao":
      return {
        id,
        providerId,
        providerName: "豆包语音 2.0",
        model: "seed-tts-2.0",
        voice: "zh_female_yingyujiaoxue_uranus_bigtts",
      };
  }
};

export const createDefaultTtsProviders = (): TtsProviderProfile[] => [createTtsProviderTemplate("fish-audio", "default")];

export const normalizeTtsProvider = (profile: Partial<TtsProviderProfile>): TtsProviderProfile => {
  const providerId: TtsProviderId =
    profile.providerId === "aliyun" || profile.providerId === "tencent" || profile.providerId === "google" || profile.providerId === "doubao"
      ? profile.providerId
      : "fish-audio";
  const fallback = createTtsProviderTemplate(providerId);
  return {
    ...fallback,
    ...profile,
    id: profile.id?.trim() || fallback.id,
    providerId,
    providerName: typeof profile.providerName === "string" ? profile.providerName.trim() : fallback.providerName,
    model: typeof profile.model === "string" ? profile.model.trim() : fallback.model,
    voice: typeof profile.voice === "string" ? profile.voice.trim() : fallback.voice,
    appId: typeof profile.appId === "string" ? profile.appId.trim() : fallback.appId,
    region: typeof profile.region === "string" ? profile.region.trim() : fallback.region,
    languageCode: typeof profile.languageCode === "string" ? profile.languageCode.trim() : fallback.languageCode,
  };
};

/** Legacy shape: `AppSettings.tts` used to be `{model, voiceId, format}` for Fish Audio only. */
interface LegacyTtsConfig {
  model?: string;
  voiceId?: string;
  format?: "mp3";
}

type PartialTtsConfig = Partial<TtsProviderConfig> & LegacyTtsConfig;

const isLegacyTtsConfig = (value: PartialTtsConfig | undefined): value is LegacyTtsConfig =>
  Boolean(value && ("voiceId" in value || "format" in value) && !("providers" in value));

export const normalizeTtsConfig = (tts: PartialTtsConfig | undefined): TtsProviderConfig => {
  if (isLegacyTtsConfig(tts)) {
    const provider = normalizeTtsProvider({
      id: "default",
      providerId: "fish-audio",
      model: tts.model,
      voice: tts.voiceId,
    });
    return {
      currentProviderId: provider.id,
      providers: [provider],
    };
  }

  const config = tts as Partial<TtsProviderConfig> | undefined;
  const normalizedProviders = (config?.providers?.length ? config.providers : createDefaultTtsProviders()).map(
    normalizeTtsProvider,
  );
  const currentProviderId = normalizedProviders.some((provider) => provider.id === config?.currentProviderId)
    ? config?.currentProviderId ?? normalizedProviders[0].id
    : normalizedProviders[0].id;

  return {
    currentProviderId,
    providers: normalizedProviders,
  };
};

export const getCurrentTtsProvider = (config: TtsProviderConfig | undefined): TtsProviderProfile | undefined => {
  if (!config?.providers.length) {
    return undefined;
  }
  return config.providers.find((provider) => provider.id === config.currentProviderId) ?? config.providers[0];
};

export const TTS_PROVIDER_LABELS: Record<TtsProviderId, string> = {
  "fish-audio": "Fish Audio",
  aliyun: "阿里云百炼",
  tencent: "腾讯云",
  google: "Google Cloud",
  doubao: "豆包语音",
};

/** Whether this provider needs a key pair (SecretId + SecretKey) instead of a single API key. */
export const ttsProviderNeedsSecondaryKey = (providerId: TtsProviderId): boolean => providerId === "tencent";
