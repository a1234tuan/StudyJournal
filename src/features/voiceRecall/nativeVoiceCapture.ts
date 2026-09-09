import { Capacitor, registerPlugin, type PluginListenerHandle } from "@capacitor/core";

import type { VoiceAudioFrame, VoiceCaptureAdapter, VoiceCaptureOptions } from "./contracts";

interface NativeVoiceFrameEvent {
  requestId?: string;
  sequence: number;
  capturedAtMonotonicMs: number;
  sampleRate: number;
  channelCount: 1;
  data: string;
}

interface NativeVoiceCapturePlugin {
  start(options: { sampleRate: number; frameSize: number; requestId: string }): Promise<void>;
  pause(): Promise<void>;
  resume(): Promise<void>;
  stop(options: { requestId: string }): Promise<void>;
  status(): Promise<{ capturing: boolean; paused: boolean; sampleRate?: number }>;
  addListener(eventName: "audioFrame", listener: (event: NativeVoiceFrameEvent) => void): Promise<PluginListenerHandle>;
  addListener(eventName: "captureError", listener: (event: { message?: string; requestId?: string }) => void): Promise<PluginListenerHandle>;
}

const NativeVoiceCapture = registerPlugin<NativeVoiceCapturePlugin>("NativeVoiceCapture");

const decodeBase64 = (value: string): Uint8Array => {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
};

export const canUseNativeVoiceCapture = (): boolean =>
  Capacitor.isNativePlatform() && Capacitor.getPlatform() === "android";

export class NativeVoiceCaptureAdapter implements VoiceCaptureAdapter {
  readonly id = "android-native-pcm";
  private readonly requestId = crypto.randomUUID();
  private listener?: PluginListenerHandle;
  private errorListener?: PluginListenerHandle;
  private stopCurrent?: () => void;

  async requestPermission(): Promise<"granted" | "denied" | "prompt"> {
    return canUseNativeVoiceCapture() ? "prompt" : "denied";
  }

  async *start(options: VoiceCaptureOptions, signal: AbortSignal): AsyncIterable<VoiceAudioFrame> {
    if (!canUseNativeVoiceCapture()) throw new Error("当前平台不支持原生实时语音采集");
    if (signal.aborted) return;
    const abort = () => { void this.stop(); };
    signal.addEventListener("abort", abort, { once: true });
    try {
    const values: VoiceAudioFrame[] = [];
    let wake: (() => void) | undefined;
    let done = false;
    let failure: Error | undefined;
    this.stopCurrent = () => { done = true; wake?.(); };
    this.listener = await NativeVoiceCapture.addListener("audioFrame", (event) => {
      if (signal.aborted || event.requestId !== this.requestId) return;
      values.push({
        sequence: event.sequence,
        capturedAtMonotonicMs: event.capturedAtMonotonicMs,
        format: { encoding: "pcm-s16le", sampleRate: event.sampleRate, channelCount: event.channelCount },
        data: decodeBase64(event.data),
      });
      wake?.();
      wake = undefined;
    });
    // A dead microphone (AudioRecord failure) must surface as an error instead of
    // leaving the UI showing "listening" forever.
    if (signal.aborted) return;
    this.errorListener = await NativeVoiceCapture.addListener("captureError", (event) => {
      if (signal.aborted || event.requestId !== this.requestId) return;
      failure = new Error(event?.message?.trim() || "麦克风采集中断，请检查权限或重新开始通话。");
      done = true;
      wake?.();
      wake = undefined;
    });
    if (signal.aborted) return;
    await NativeVoiceCapture.start({ sampleRate: options.preferredFormat.sampleRate, frameSize: 2048, requestId: this.requestId });
    if (signal.aborted) return;
    while (!done) {
      const value = values.shift();
      if (value) yield value;
      else await new Promise<void>((resolve) => { wake = resolve; });
    }
    if (failure) throw failure;
    } finally {
      signal.removeEventListener("abort", abort);
      await this.stop();
    }
  }

  async pause() {
    await NativeVoiceCapture.pause();
  }

  async stop() {
    this.stopCurrent?.();
    this.stopCurrent = undefined;
    await this.listener?.remove();
    this.listener = undefined;
    await this.errorListener?.remove();
    this.errorListener = undefined;
    if (canUseNativeVoiceCapture()) await NativeVoiceCapture.stop({ requestId: this.requestId }).catch(() => undefined);
  }
}
