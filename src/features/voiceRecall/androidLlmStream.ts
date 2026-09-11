import type { PluginListenerHandle } from "@capacitor/core";
import { NativeAi } from "../../services/nativeAi";
import type { AiProviderProfile } from "../../types";
import type { LlmStreamEvent, LlmStreamRequest } from "./contracts";
import { createAsyncQueue } from "./asyncQueue";
import { serializeVoiceTeacherMessages } from "./openAiLlmStreamAdapter";
import { createTimeoutSignal } from "./providerRuntime";

interface NativeStreamBridge {
  stream(options: { requestId: string; baseUrl: string; apiKey: string; model: string; maxTokens: number; temperature: number; messagesJson: string; timeoutMs: number }): Promise<void>;
  cancel(options: { requestId: string }): Promise<unknown>;
  addListener(name: "voiceAiEvent", listener: (event: LlmStreamEvent & { requestId: string }) => void): Promise<PluginListenerHandle>;
}

export async function* streamAndroidLlm(profile: AiProviderProfile, apiKey: string, request: LlmStreamRequest, host: NativeStreamBridge = NativeAi as unknown as NativeStreamBridge): AsyncIterable<LlmStreamEvent> {
  request.signal.throwIfAborted();
  const timeout = createTimeoutSignal(request.signal, 20000);
  const requestId = `voice-llm-${crypto.randomUUID()}`;
  const queue = createAsyncQueue<LlmStreamEvent>();
  let handle: PluginListenerHandle | undefined;
  let started = false;
  const abort = () => {
    queue.fail(new DOMException(timeout.didTimeout() ? "LLM timeout" : "LLM cancelled", timeout.didTimeout() ? "TimeoutError" : "AbortError"));
    if (started) void host.cancel({ requestId }).catch(() => undefined);
  };
  timeout.signal.addEventListener("abort", abort, { once: true });
  try {
    handle = await host.addListener("voiceAiEvent", (event) => {
      if (event.requestId === requestId && !timeout.signal.aborted) queue.push(event);
    });
    timeout.signal.throwIfAborted();
    started = true;
    void host.stream({ requestId, baseUrl: profile.baseUrl, apiKey, model: profile.model, maxTokens: profile.maxTokens, temperature: profile.temperature, messagesJson: JSON.stringify(serializeVoiceTeacherMessages(request.messages)), timeoutMs: 20000 }).then(() => queue.close(), (error) => queue.fail(error));
    let completed = false;
    for await (const event of queue) {
      timeout.signal.throwIfAborted();
      if (event.type === "completed") completed = true;
      yield event;
    }
    if (!completed) throw new Error("LLM 流提前结束");
  } finally {
    timeout.signal.removeEventListener("abort", abort);
    timeout.dispose();
    if (started) void host.cancel({ requestId }).catch(() => undefined);
    await handle?.remove();
    queue.close();
  }
}
