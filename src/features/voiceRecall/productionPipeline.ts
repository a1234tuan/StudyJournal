import type { AppSettings } from "../../types";
import { formatUiError } from "../../lib/uiError";
import { getCurrentAiProvider } from "../../lib/aiProviders";
import type { VoiceAudioFormat } from "./contracts";
import { resolveVoiceSecret, voiceAsrSecretId } from "./credentials";
import { createAndroidVoiceSocketFactory } from "./androidVoiceSocket";
import { createDesktopVoiceSocketFactory } from "./desktopVoiceSocket";
import { createAliyunAsrTransport, type VoiceSocketFactory } from "./aliyunAsrTransport";
import { DEFAULT_ALIYUN_ASR_CONFIG } from "./aliyunAsrProtocol";
import { VoiceRecallPipeline } from "./pipeline";
import {
  BUILT_IN_ASR_PROFILES,
  BUILT_IN_VOICE_TTS_PROFILES,
  USER_VOICE_TEMPLATES,
  resolveVoiceProviderTemplate,
  type AsrProviderProfile,
  type VoiceProviderEditableConfig,
  type VoiceProviderDeviceOverrides,
  type VoiceTtsProviderProfile,
} from "./providerProfiles";
import { createVoiceAsrAdapter, createVoiceLlmAdapter, createVoiceTtsAdapter } from "./providerFactory";
import type { VoiceAsrTransport } from "./transportAsrAdapter";
import { voicePlatformUnsupportedMessage, voiceRuntimePlatform, type VoiceRuntimePlatform } from "./runtimePlatform";
import type { VoicePlaybackEncoding } from "./audioPlaybackSink";

/** Voice replies are spoken, so they must stay short: a long answer costs more
 * TTS and forces the user to wait. Clamped regardless of the chat setting. */
export const VOICE_LLM_MAX_TOKENS = 320;

/** Configuration/platform problems we author ourselves: shown to the user
 * verbatim because they say what to fix, unlike raw provider errors. */
export class VoiceConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "VoiceConfigurationError";
  }
}

export const describeVoiceError = (error: unknown): string =>
  error instanceof VoiceConfigurationError ? error.message : formatUiError(error, "voice-recall");

export interface ProductionVoiceSession {
  pipeline: VoiceRecallPipeline;
  asrFormat: VoiceAudioFormat;
  ttsVoice: string;
  ttsEncoding: VoicePlaybackEncoding;
  ttsSampleRate: number;
  summary: { asr: string; llm: string; tts: string };
}

export interface CreateProductionVoiceSessionInput {
  settings: AppSettings;
  templateId?: string;
  config?: VoiceProviderEditableConfig;
  platform?: VoiceRuntimePlatform;
  fetchImplementation?: typeof fetch;
  socketFactory?: VoiceSocketFactory;
  /** Test seam: inject a transport instead of opening a real socket. */
  asrTransportFactory?: (profile: AsrProviderProfile, apiKey: string) => VoiceAsrTransport;
}

const overridesFromConfig = (
  config: VoiceProviderEditableConfig | undefined,
  templateId: string,
): VoiceProviderDeviceOverrides | undefined => {
  if (!config || config.templateId !== templateId) return undefined;
  return {
    templateId,
    asr: {
      endpoint: config.asrEndpoint || undefined,
      model: config.asrModel || undefined,
      resourceId: config.asrResourceId || undefined,
    },
    tts: {
      endpoint: config.ttsEndpoint || undefined,
      model: config.ttsModel || undefined,
      voice: config.ttsVoice || undefined,
    },
  };
};

const buildAsrTransport = (
  input: CreateProductionVoiceSessionInput,
  platform: VoiceRuntimePlatform,
  profile: AsrProviderProfile,
  apiKey: string,
): VoiceAsrTransport => {
  if (input.asrTransportFactory) return input.asrTransportFactory(profile, apiKey);
  if (profile.providerId === "aliyun-bailian") {
    const socketFactory = input.socketFactory ?? hostSocketFactory(platform);
    return createAliyunAsrTransport({ apiKey, socketFactory });
  }
  throw new VoiceConfigurationError(`${profile.providerName} 的实时识别传输尚未接入，请改用阿里云 Paraformer。`);
};

/** The WebSocket must live in a privileged host: the renderer cannot set an
 * Authorization header on a browser WebSocket. */
const hostSocketFactory = (platform: VoiceRuntimePlatform): VoiceSocketFactory => {
  if (platform === "android") return createAndroidVoiceSocketFactory();
  const bridge = typeof window !== "undefined" ? window.studyJournalDesktop?.voiceAsr : undefined;
  if (platform === "desktop" && bridge) return createDesktopVoiceSocketFactory(bridge);
  throw new VoiceConfigurationError(voicePlatformUnsupportedMessage(platform));
};

const playbackEncoding = (profile: VoiceTtsProviderProfile): VoicePlaybackEncoding =>
  profile.audioFormat === "pcm-s16le" ? "pcm-s16le" : "provider-native";

/**
 * Resolves the configured template + device-local credentials into a real
 * ASR -> LLM -> TTS pipeline. Throws a user-facing message when a stage cannot
 * run on the current platform or has no credential, so the caller can refuse to
 * start instead of simulating the call.
 */
export const createProductionVoiceSession = async (
  input: CreateProductionVoiceSessionInput,
): Promise<ProductionVoiceSession> => {
  const platform = input.platform ?? voiceRuntimePlatform();
  const baseTemplate = USER_VOICE_TEMPLATES.find((item) => item.templateId === input.templateId) ?? USER_VOICE_TEMPLATES[0];
  const configuredLlm = getCurrentAiProvider(input.settings.ai);
  if (!configuredLlm) throw new VoiceConfigurationError("请先在“更多 → AI 设置”里配置 AI 供应商。");
  const llmProfile = { ...configuredLlm, maxTokens: Math.min(configuredLlm.maxTokens || VOICE_LLM_MAX_TOKENS, VOICE_LLM_MAX_TOKENS) };
  // The template's LLM id is aspirational; the user's configured provider is what
  // actually runs, so bind the template to it before resolving.
  const template = { ...baseTemplate, llmProfileId: llmProfile.id };

  const resolved = resolveVoiceProviderTemplate({
    template,
    asrProfiles: BUILT_IN_ASR_PROFILES,
    llmProfiles: [llmProfile],
    ttsProfiles: BUILT_IN_VOICE_TTS_PROFILES,
    overrides: overridesFromConfig(input.config, template.templateId),
  });

  const [asrSecret, llmSecret, ttsSecret] = await Promise.all([
    resolveVoiceSecret({ profileId: voiceAsrSecretId(resolved.asr), providerId: resolved.asr.providerId }),
    resolveVoiceSecret({ profileId: llmProfile.id, providerId: "default", fallbackIds: ["default"] }),
    resolveVoiceSecret({ profileId: resolved.tts.id, providerId: resolved.tts.providerId, fallbackIds: ["fish-audio", "default"] }),
  ]);
  if (!asrSecret) throw new VoiceConfigurationError(`缺少 ${resolved.asr.providerName} 的密钥，请在语音服务设置中填写。`);
  if (!llmSecret) throw new VoiceConfigurationError(`缺少 ${llmProfile.providerName} 的 API Key，请在“更多 → AI 设置”中填写。`);
  if (!ttsSecret) throw new VoiceConfigurationError(`缺少 ${resolved.tts.providerName} 的密钥，请在“更多 → TTS 设置”中填写。`);

  const asr = createVoiceAsrAdapter({
    profile: resolved.asr,
    platform,
    transport: buildAsrTransport(input, platform, resolved.asr, asrSecret.apiKey),
  });
  const llm = createVoiceLlmAdapter({
    profile: resolved.llm,
    apiKey: llmSecret.apiKey,
    fetchImplementation: input.fetchImplementation,
  });
  const tts = createVoiceTtsAdapter({
    profile: resolved.tts,
    apiKey: ttsSecret.apiKey,
    apiKeySecondary: ttsSecret.apiKeySecondary,
    platform,
  });

  return {
    pipeline: new VoiceRecallPipeline(asr, llm, tts),
    asrFormat: {
      encoding: resolved.asr.acceptedFormats[0] ?? "pcm-s16le",
      sampleRate: resolved.asr.acceptedSampleRates[0] ?? DEFAULT_ALIYUN_ASR_CONFIG.sampleRate,
      channelCount: 1,
    },
    ttsVoice: resolved.tts.voice,
    ttsEncoding: playbackEncoding(resolved.tts),
    ttsSampleRate: 16_000,
    summary: {
      asr: resolved.asr.providerName,
      llm: `${resolved.llm.providerName} · ${resolved.llm.model}`,
      tts: `${resolved.tts.providerName} · ${resolved.tts.voice}`,
    },
  };
};
