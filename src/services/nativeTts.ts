import { Capacitor, registerPlugin } from "@capacitor/core";
import type { TtsProviderId } from "../types";

export interface TtsSynthesisOptions {
  providerId: TtsProviderId;
  apiKey: string;
  /** Tencent Cloud only: SecretKey (apiKey is the SecretId). */
  apiKeySecondary?: string;
  model: string;
  voiceId: string;
  text: string;
  format: "mp3";
  region?: string;
  languageCode?: string;
}

interface NativeTtsPlugin {
  synthesize(options: TtsSynthesisOptions): Promise<{ data: string; mimeType?: string }>;
}

const NativeTts = registerPlugin<NativeTtsPlugin>("NativeTts");

const base64ToBlob = (data: string, mimeType = "audio/mpeg"): Blob => {
  const binary = atob(data);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return new Blob([bytes], { type: mimeType });
};

export const synthesizeOnHost = async (options: TtsSynthesisOptions, signal?: AbortSignal): Promise<Blob | undefined> => {
  if (Capacitor.isNativePlatform() && Capacitor.getPlatform() === "android") {
    if (signal?.aborted) throw new DOMException("TTS cancelled", "AbortError");
    const result = await NativeTts.synthesize(options);
    if (signal?.aborted) throw new DOMException("TTS cancelled", "AbortError");
    return base64ToBlob(result.data, result.mimeType);
  }
  const desktopTts = typeof window !== "undefined" ? window.studyJournalDesktop?.tts : undefined;
  if (desktopTts) {
    if (signal?.aborted) throw new DOMException("TTS cancelled", "AbortError");
    // Cancelling only rejects the renderer promise; tell the main process to
    // abort the in-flight request so a cancelled synthesis is not billed.
    const requestId = `tts-${crypto.randomUUID()}`;
    const cancelOnAbort = () => { void desktopTts.cancel(requestId).catch(() => undefined); };
    signal?.addEventListener("abort", cancelOnAbort, { once: true });
    try {
      const result = await desktopTts.synthesize({ ...options, requestId });
      if (signal?.aborted) throw new DOMException("TTS cancelled", "AbortError");
      return base64ToBlob(result.data, result.mimeType);
    } finally {
      signal?.removeEventListener("abort", cancelOnAbort);
    }
  }
  return undefined;
};
