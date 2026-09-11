import type { TtsProviderProfile } from "../../types";
import { synthesizeOnHost } from "../../services/nativeTts";
import { createTtsProvider } from "../../services/knowledgePodcastService";
import type { TtsStreamAdapter, TtsStreamEvent, TtsStreamRequest } from "./contracts";

export class BufferedTtsFallbackAdapter implements TtsStreamAdapter {
  readonly profileId: string;

  constructor(
    private readonly profile: TtsProviderProfile,
    private readonly apiKey: string,
    apiKeySecondary?: string,
  ) {
    this.profileId = profile.id;
    this.provider = createTtsProvider(profile, apiKey, apiKeySecondary);
  }

  private readonly provider;

  async *synthesize(request: TtsStreamRequest): AsyncIterable<TtsStreamEvent> {
    request.signal.throwIfAborted();
    yield { type: "usage", characters: request.text.length };
    const hosted = this.profile.providerId === "fish-audio" ? await synthesizeOnHost({ providerId: "fish-audio", apiKey: this.apiKey, model: this.profile.model, voiceId: request.voice || this.profile.voice, text: request.text, format: "mp3", speed: request.rate }, request.signal) : undefined;
    const blob = hosted ?? await this.provider.synthesize(request.text, { signal: request.signal });
    const chunk = new Uint8Array(await blob.arrayBuffer());
    if (chunk.byteLength) {
      yield { type: "audio", chunk, format: { encoding: "provider-native", sampleRate: 16_000, channelCount: 1 } };
    }
    yield { type: "completed" };
  }
}

export class SystemSpeechTtsFallbackAdapter implements TtsStreamAdapter {
  readonly profileId = "system-speech";

  async *synthesize(request: TtsStreamRequest): AsyncIterable<TtsStreamEvent> {
    if (typeof speechSynthesis === "undefined" || typeof SpeechSynthesisUtterance === "undefined") {
      throw new Error("当前系统没有可用的语音朗读能力");
    }
    await new Promise<void>((resolve, reject) => {
      const utterance = new SpeechSynthesisUtterance(request.text);
      utterance.lang = "zh-CN";
      utterance.onend = () => resolve();
      utterance.onerror = () => reject(new Error("系统语音朗读失败"));
      const abort = () => { speechSynthesis.cancel(); reject(new DOMException("TTS cancelled", "AbortError")); };
      request.signal.addEventListener("abort", abort, { once: true });
      speechSynthesis.speak(utterance);
    });
    yield { type: "usage", characters: request.text.length };
    yield { type: "completed" };
  }
}
