import type { AiProviderProfile, TtsProviderProfile } from "../../types";
import type { VoiceAudioFormat } from "./contracts";

export type VoiceProviderTemplateStatus = "candidate" | "verified" | "deprecated";
export type VoiceProviderTransport = "websocket" | "sse" | "http-stream" | "native-sdk" | "mock";

export interface AsrProviderProfile {
  id: string;
  providerId: "doubao" | "aliyun-bailian" | "openai-compatible" | "custom" | "mock";
  providerName: string;
  endpoint: string;
  transport: VoiceProviderTransport;
  model?: string;
  resourceId?: string;
  language: string;
  acceptedSampleRates: number[];
  acceptedFormats: VoiceAudioFormat["encoding"][];
  punctuation: boolean;
  inverseTextNormalization: boolean;
  browserDirectSupported: boolean;
}

export interface VoiceTtsProviderProfile extends TtsProviderProfile {
  endpoint: string;
  transport: VoiceProviderTransport;
  streaming: boolean;
  audioFormat: VoiceAudioFormat["encoding"];
  firstChunkTimeoutMs: number;
  browserDirectSupported: boolean;
}

export interface VoiceProviderTemplate {
  templateId: string;
  version: number;
  status: VoiceProviderTemplateStatus;
  verifiedAt?: string;
  minimumAppVersion: string;
  asrProfileId: string;
  llmProfileId: string;
  ttsProfileId: string;
}

export interface VoiceProviderDeviceOverrides {
  templateId: string;
  asr?: Partial<Pick<AsrProviderProfile, "endpoint" | "model" | "resourceId" | "language">>;
  llm?: Partial<Pick<AiProviderProfile, "baseUrl" | "model" | "temperature" | "maxTokens" | "contextWindowTokens">>;
  tts?: Partial<Pick<VoiceTtsProviderProfile, "endpoint" | "model" | "voice" | "firstChunkTimeoutMs">>;
}

export interface ResolvedVoiceProviderTemplate {
  templateId: string;
  templateVersion: number;
  status: VoiceProviderTemplateStatus;
  asr: AsrProviderProfile;
  llm: AiProviderProfile;
  tts: VoiceTtsProviderProfile;
}

export const BUILT_IN_ASR_PROFILES: readonly AsrProviderProfile[] = [
  {
    id: "voice-asr-mock",
    providerId: "mock",
    providerName: "Mock ASR",
    endpoint: "mock://voice-asr",
    transport: "mock",
    language: "zh-CN",
    acceptedSampleRates: [16_000],
    acceptedFormats: ["pcm-s16le"],
    punctuation: true,
    inverseTextNormalization: true,
    browserDirectSupported: true,
  },
  {
    id: "voice-asr-doubao-streaming",
    providerId: "doubao",
    providerName: "豆包流式 ASR",
    endpoint: "wss://openspeech.bytedance.com/api/v3/sauc/bigmodel",
    transport: "websocket",
    resourceId: "volc.bigasr.sauc.duration",
    language: "zh-CN",
    acceptedSampleRates: [16_000],
    acceptedFormats: ["pcm-s16le", "opus"],
    punctuation: true,
    inverseTextNormalization: true,
    browserDirectSupported: false,
  },
  {
    id: "voice-asr-aliyun-paraformer",
    providerId: "aliyun-bailian",
    providerName: "阿里云 Paraformer 实时 ASR",
    endpoint: "wss://dashscope.aliyuncs.com/api-ws/v1/inference",
    transport: "websocket",
    model: "paraformer-realtime-v2",
    language: "zh-CN",
    acceptedSampleRates: [16_000],
    acceptedFormats: ["pcm-s16le"],
    punctuation: true,
    inverseTextNormalization: true,
    browserDirectSupported: false,
  },
] as const;

export const BUILT_IN_VOICE_TTS_PROFILES: readonly VoiceTtsProviderProfile[] = [
  {
    id: "voice-tts-mock",
    providerId: "fish-audio",
    providerName: "Mock TTS",
    model: "mock",
    voice: "mock-teacher",
    endpoint: "mock://voice-tts",
    transport: "mock",
    streaming: true,
    audioFormat: "pcm-s16le",
    firstChunkTimeoutMs: 1_000,
    browserDirectSupported: true,
  },
  {
    id: "voice-tts-fish-s21",
    providerId: "fish-audio",
    providerName: "Fish Audio",
    model: "s2.1-pro-free",
    voice: "5c353fdb312f4888836a9a5680099ef0",
    endpoint: "https://api.fish.audio/v1/tts",
    transport: "http-stream",
    streaming: true,
    audioFormat: "provider-native",
    firstChunkTimeoutMs: 8_000,
    browserDirectSupported: false,
  },
  {
    id: "voice-tts-doubao-seed-20",
    providerId: "doubao",
    providerName: "豆包语音 2.0",
    model: "seed-tts-2.0",
    voice: "zh_female_yingyujiaoxue_uranus_bigtts",
    endpoint: "https://openspeech.bytedance.com/api/v3/tts/unidirectional",
    transport: "http-stream",
    streaming: true,
    audioFormat: "provider-native",
    firstChunkTimeoutMs: 8_000,
    browserDirectSupported: false,
  },
  {
    id: "voice-tts-aliyun-qwen-audio-30",
    providerId: "aliyun",
    providerName: "阿里云百炼",
    model: "qwen-audio-3.0-tts-flash",
    voice: "Cherry",
    endpoint: "https://dashscope.aliyuncs.com/api/v1/services/aigc/text2audio",
    transport: "http-stream",
    streaming: true,
    audioFormat: "provider-native",
    firstChunkTimeoutMs: 8_000,
    browserDirectSupported: false,
  },
] as const;

export const BUILT_IN_VOICE_TEMPLATES: readonly VoiceProviderTemplate[] = [
  {
    templateId: "voice-mock-cn",
    version: 1,
    status: "verified",
    verifiedAt: "2026-09-08",
    minimumAppVersion: "0.1.6",
    asrProfileId: "voice-asr-mock",
    llmProfileId: "voice-llm-mock",
    ttsProfileId: "voice-tts-mock",
  },
  {
    templateId: "voice-default-cn",
    version: 1,
    status: "candidate",
    minimumAppVersion: "0.1.6",
    asrProfileId: "voice-asr-doubao-streaming",
    llmProfileId: "deepseek-v4-flash",
    ttsProfileId: "voice-tts-fish-s21",
  },
] as const;

export const createVoiceLlmProfile = (profile: AiProviderProfile): AiProviderProfile => ({ ...profile });

/** Applies the newest built-in template while retaining explicit device-local overrides. */
export const resolveVoiceProviderTemplate = (input: {
  template: VoiceProviderTemplate;
  asrProfiles: readonly AsrProviderProfile[];
  llmProfiles: readonly AiProviderProfile[];
  ttsProfiles: readonly VoiceTtsProviderProfile[];
  overrides?: VoiceProviderDeviceOverrides;
}): ResolvedVoiceProviderTemplate => {
  const { template, overrides } = input;
  if (overrides && overrides.templateId !== template.templateId) {
    throw new Error("语音 Provider 本机覆盖与模板不匹配。");
  }
  const asr = input.asrProfiles.find((profile) => profile.id === template.asrProfileId);
  const llm = input.llmProfiles.find((profile) => profile.id === template.llmProfileId);
  const tts = input.ttsProfiles.find((profile) => profile.id === template.ttsProfileId);
  if (!asr || !llm || !tts) throw new Error("语音 Provider 模板引用了不存在的配置。");
  return {
    templateId: template.templateId,
    templateVersion: template.version,
    status: template.status,
    asr: { ...asr, ...overrides?.asr, id: asr.id, providerId: asr.providerId },
    llm: { ...llm, ...overrides?.llm, id: llm.id },
    tts: { ...tts, ...overrides?.tts, id: tts.id, providerId: tts.providerId },
  };
};

export type VoiceRuntimePlatform = "web" | "desktop" | "android";

export const assertBrowserDirectSupported = (
  profile: { providerName: string; browserDirectSupported: boolean },
  platform: VoiceRuntimePlatform,
) => {
  if (platform === "web" && !profile.browserDirectSupported) {
    throw new Error(`${profile.providerName} 未通过浏览器直连安全验证，请使用自建中继、Desktop 或 Android。`);
  }
};
