import type { AiProviderProfile, TtsProviderProfile } from "../../types";
import type { AsrStreamAdapter, LlmStreamAdapter, TtsStreamAdapter } from "./contracts";
import { FishAudioTtsStreamAdapter } from "./fishAudioTtsStreamAdapter";
import { MockAsrStreamAdapter, MockLlmStreamAdapter, MockTtsStreamAdapter } from "./mockProviders";
import { OpenAiCompatibleLlmStreamAdapter } from "./openAiLlmStreamAdapter";
import { assertBrowserDirectSupported, type AsrProviderProfile, type VoiceRuntimePlatform, type VoiceTtsProviderProfile } from "./providerProfiles";
import { BufferedTtsFallbackAdapter, SystemSpeechTtsFallbackAdapter } from "./ttsFallbackAdapters";
import { TransportAsrStreamAdapter, type VoiceAsrTransport } from "./transportAsrAdapter";

export const createVoiceAsrAdapter = (options: {
  profile: AsrProviderProfile;
  platform: VoiceRuntimePlatform;
  transport?: VoiceAsrTransport;
}): AsrStreamAdapter => {
  if (options.profile.providerId === "mock") return new MockAsrStreamAdapter();
  assertBrowserDirectSupported(options.profile, options.platform);
  if (!options.transport) throw new Error(`${options.profile.providerName} 需要已验证的宿主或中继传输。`);
  return new TransportAsrStreamAdapter(options.profile, options.transport);
};

export const createVoiceLlmAdapter = (options: {
  profile?: AiProviderProfile;
  apiKey?: string;
  fetchImplementation?: typeof fetch;
  mock?: boolean;
}): LlmStreamAdapter => {
  if (options.mock) return new MockLlmStreamAdapter();
  if (!options.profile || !options.apiKey) throw new Error("LLM 配置或本机凭据不完整。");
  return new OpenAiCompatibleLlmStreamAdapter(options.profile, options.apiKey, options.fetchImplementation);
};

export const createVoiceTtsAdapter = (options: {
  profile?: VoiceTtsProviderProfile;
  legacyProfile?: TtsProviderProfile;
  apiKey?: string;
  apiKeySecondary?: string;
  platform: VoiceRuntimePlatform;
  trustedStreamingFetch?: typeof fetch;
  systemFallback?: boolean;
  mock?: boolean;
}): TtsStreamAdapter => {
  if (options.mock) return new MockTtsStreamAdapter();
  if (options.systemFallback) return new SystemSpeechTtsFallbackAdapter();
  if (options.profile?.providerId === "fish-audio" && options.trustedStreamingFetch && options.apiKey) {
    assertBrowserDirectSupported(options.profile, options.platform);
    return new FishAudioTtsStreamAdapter(options.profile, options.apiKey, options.trustedStreamingFetch);
  }
  const profile = options.legacyProfile ?? options.profile;
  if (!profile || !options.apiKey) throw new Error("TTS 配置或本机凭据不完整。");
  if (options.profile) assertBrowserDirectSupported(options.profile, options.platform);
  return new BufferedTtsFallbackAdapter(profile, options.apiKey, options.apiKeySecondary);
};

export interface VoiceProviderConnectionTestResult {
  ok: boolean;
  firstEventMs?: number;
  completedMs?: number;
  eventCount: number;
  message: string;
}

export const testVoiceProviderConnection = async <T>(options: {
  open: (signal: AbortSignal) => AsyncIterable<T>;
  timeoutMs?: number;
}): Promise<VoiceProviderConnectionTestResult> => {
  const controller = new AbortController();
  const startedAt = performance.now();
  const timer = setTimeout(() => controller.abort("connection-test-timeout"), options.timeoutMs ?? 8_000);
  let firstEventMs: number | undefined;
  let eventCount = 0;
  try {
    for await (const _event of options.open(controller.signal)) {
      eventCount += 1;
      firstEventMs ??= performance.now() - startedAt;
    }
    return { ok: true, firstEventMs, completedMs: performance.now() - startedAt, eventCount, message: "连接测试完成" };
  } catch (error) {
    return { ok: false, firstEventMs, completedMs: performance.now() - startedAt, eventCount, message: controller.signal.aborted ? "连接测试超时" : "连接测试失败" };
  } finally {
    clearTimeout(timer);
  }
};
