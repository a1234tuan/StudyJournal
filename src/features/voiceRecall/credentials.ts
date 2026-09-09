import type { AiSecret } from "../../types";
import { storage } from "../../services/storageAdapter";
import type { AsrProviderProfile } from "./providerProfiles";

/** Device-local secret slot ids for ASR providers, which are not part of the
 * existing AI/TTS settings pages. Same Dexie `aiSecrets` table, keyed by id. */
export const VOICE_ASR_SECRET_IDS: Record<AsrProviderProfile["providerId"], string | undefined> = {
  doubao: "voice-asr-doubao",
  "aliyun-bailian": "voice-asr-aliyun",
  "openai-compatible": undefined,
  custom: undefined,
  mock: undefined,
};

export const voiceAsrSecretId = (profile: AsrProviderProfile): string | undefined =>
  VOICE_ASR_SECRET_IDS[profile.providerId];

/**
 * Resolve a provider credential the same way the podcast pipeline does:
 * exact profile id first, then the provider family id, then explicit fallbacks.
 * Never returns a blank key.
 */
export const resolveVoiceSecret = async (input: {
  profileId?: string;
  providerId?: string;
  fallbackIds?: readonly string[];
}): Promise<AiSecret | undefined> => {
  const candidates = [input.profileId, input.providerId, ...(input.fallbackIds ?? [])];
  const seen = new Set<string>();
  for (const id of candidates) {
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const secret = await storage.getAiSecret?.(id);
    if (secret?.apiKey?.trim()) return secret;
  }
  return undefined;
};

export interface VoiceCredentialReadiness {
  asr: boolean;
  llm: boolean;
  tts: boolean;
}

/** A session may only start when every stage of the chain has a credential. */
export const isVoiceChainReady = (readiness: VoiceCredentialReadiness): boolean =>
  readiness.asr && readiness.llm && readiness.tts;
