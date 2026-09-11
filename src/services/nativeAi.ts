import { Capacitor, registerPlugin } from "@capacitor/core";

import type { AiCompletionResult } from "../types";
import type { AiChatPayloadMessage, AiCompletionRequestOptions } from "./aiClientService";

interface NativeAiPlugin {
  chat(options: {
    baseUrl: string;
    apiKey: string;
    model: string;
    temperature: number;
    maxTokens: number;
    messagesJson: string;
    structuredOutput?: boolean;
    thinkingMode?: "enabled" | "disabled";
    reasoningEffort?: "low" | "high" | "max";
    timeoutMs?: number;
    requestId?: string;
  }): Promise<AiCompletionResult>;
  cancel(options: { requestId: string }): Promise<{ cancelled: boolean }>;
}

export const NativeAi = registerPlugin<NativeAiPlugin>("NativeAi");

export const canUseNativeAi = (): boolean =>
  Capacitor.isNativePlatform() && Capacitor.getPlatform() === "android";

export const runNativeAiChat = async (options: {
  baseUrl: string;
  apiKey: string;
  model: string;
  temperature: number;
  maxTokens: number;
  messages: AiChatPayloadMessage[];
} & Pick<AiCompletionRequestOptions, "structuredOutput" | "thinkingMode" | "reasoningEffort" | "timeoutMs" | "signal">): Promise<AiCompletionResult> => {
  const { signal, messages, ...nativeOptions } = options;
  if (signal?.aborted) throw new DOMException("AI request cancelled", "AbortError");
  const requestId = `ai-${crypto.randomUUID()}`;
  const nativePromise = NativeAi.chat({
    ...nativeOptions,
    requestId,
    messagesJson: JSON.stringify(messages),
  });
  if (!signal) return nativePromise;
  return new Promise<AiCompletionResult>((resolve, reject) => {
    const abort = () => {
      // Rejecting the renderer promise is not enough: the native HttpURLConnection
      // would keep running and still be billed, so disconnect it as well.
      void NativeAi.cancel({ requestId }).catch(() => undefined);
      reject(new DOMException("AI request cancelled", "AbortError"));
    };
    signal.addEventListener("abort", abort, { once: true });
    nativePromise.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
};
