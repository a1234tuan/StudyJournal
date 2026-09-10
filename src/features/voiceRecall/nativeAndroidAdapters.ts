import { canUseNativeAi, runNativeAiChat } from "../../services/nativeAi";
import { synthesizeOnHost } from "../../services/nativeTts";
import type { LlmStreamAdapter, LlmStreamRequest, TtsStreamAdapter, TtsStreamRequest } from "./contracts";
import type { AiProviderProfile } from "../../types";
import type { VoiceTtsProviderProfile } from "./providerProfiles";

export class AndroidNativeLlmAdapter implements LlmStreamAdapter {
  readonly profileId: string;
  constructor(private readonly profile: AiProviderProfile, private readonly apiKey: string) { this.profileId = profile.id; }
  async *complete(request: LlmStreamRequest) {
    const result = await runNativeAiChat({ baseUrl: this.profile.baseUrl, apiKey: this.apiKey, model: this.profile.model, temperature: this.profile.temperature, maxTokens: this.profile.maxTokens, thinkingMode: "disabled", messages: request.messages.map(({ role, content }) => ({ role, content })), signal: request.signal });
    if (result.content) yield { type: "token" as const, text: result.content };
    if (result.usage) yield { type: "usage" as const, inputTokens: result.usage.promptTokens, outputTokens: result.usage.completionTokens };
    yield { type: "completed" as const };
  }
}

export class AndroidNativeTtsAdapter implements TtsStreamAdapter {
  readonly profileId: string;
  constructor(private readonly profile: VoiceTtsProviderProfile, private readonly apiKey: string) { this.profileId = profile.id; }
  async *synthesize(request: TtsStreamRequest) {
    const blob = await synthesizeOnHost({ providerId: "fish-audio", apiKey: this.apiKey, model: this.profile.model, voiceId: request.voice || this.profile.voice, text: request.text, format: "mp3" }, request.signal);
    if (!blob) throw new Error("Android TTS 宿主不可用。");
    yield { type: "audio" as const, chunk: new Uint8Array(await blob.arrayBuffer()), format: { encoding: "provider-native" as const, sampleRate: 16_000, channelCount: 1 as const } };
    yield { type: "usage" as const, characters: request.text.length };
    yield { type: "completed" as const };
  }
}

export const canUseAndroidVoiceAdapters = () => canUseNativeAi();
