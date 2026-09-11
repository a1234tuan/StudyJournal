import { canUseNativeAi } from "../../services/nativeAi";
import { streamAndroidLlm } from "./androidLlmStream";
import { synthesizeOnHost } from "../../services/nativeTts";
import type { LlmStreamAdapter, LlmStreamRequest, TtsStreamAdapter, TtsStreamRequest } from "./contracts";
import type { AiProviderProfile } from "../../types";
import type { VoiceTtsProviderProfile } from "./providerProfiles";

export class AndroidNativeLlmAdapter implements LlmStreamAdapter {
  readonly profileId: string;
  constructor(private readonly profile: AiProviderProfile, private readonly apiKey: string) { this.profileId = profile.id; }
  async *complete(request: LlmStreamRequest) {
    yield* streamAndroidLlm(this.profile, this.apiKey, request);
  }
}

export class AndroidNativeTtsAdapter implements TtsStreamAdapter {
  readonly profileId: string;
  constructor(private readonly profile: VoiceTtsProviderProfile, private readonly apiKey: string) { this.profileId = profile.id; }
  async *synthesize(request: TtsStreamRequest) {
    const blob = await synthesizeOnHost({ providerId: "fish-audio", apiKey: this.apiKey, model: this.profile.model, voiceId: request.voice || this.profile.voice, text: request.text, format: "mp3", speed: request.rate }, request.signal);
    if (!blob) throw new Error("Android TTS 宿主不可用。");
    yield { type: "audio" as const, chunk: new Uint8Array(await blob.arrayBuffer()), format: { encoding: "provider-native" as const, sampleRate: 16_000, channelCount: 1 as const } };
    yield { type: "usage" as const, characters: request.text.length };
    yield { type: "completed" as const };
  }
}

export const canUseAndroidVoiceAdapters = () => canUseNativeAi();
