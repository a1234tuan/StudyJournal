import type { TtsProviderProfile } from "../../types";
import { createTtsProvider } from "../../services/knowledgePodcastService";
import type { TtsStreamAdapter, TtsStreamEvent, TtsStreamRequest } from "./contracts";

export class BufferedTtsFallbackAdapter implements TtsStreamAdapter {
  readonly profileId: string;

  constructor(
    profile: TtsProviderProfile,
    apiKey: string,
    apiKeySecondary?: string,
  ) {
    this.profileId = profile.id;
    this.provider = createTtsProvider(profile, apiKey, apiKeySecondary);
  }

  private readonly provider;

  async *synthesize(request: TtsStreamRequest): AsyncIterable<TtsStreamEvent> {
    const blob = await this.provider.synthesize(request.text, { signal: request.signal });
    const chunk = new Uint8Array(await blob.arrayBuffer());
    if (chunk.byteLength) {
      yield { type: "audio", chunk, format: { encoding: "provider-native", sampleRate: 16_000, channelCount: 1 } };
    }
    yield { type: "usage", characters: request.text.length };
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
