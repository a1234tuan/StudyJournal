import { Capacitor, registerPlugin, type PluginListenerHandle } from "@capacitor/core";

import type { VoiceAudioFrame, VoiceCaptureAdapter, VoiceCaptureOptions } from "./contracts";

interface NativeVoiceFrameEvent {
  sequence: number;
  capturedAtMonotonicMs: number;
  sampleRate: number;
  channelCount: 1;
  data: string;
}

interface NativeVoiceCapturePlugin {
  start(options: { sampleRate: number; frameSize: number }): Promise<void>;
  pause(): Promise<void>;
  resume(): Promise<void>;
  stop(): Promise<void>;
  status(): Promise<{ capturing: boolean; paused: boolean; sampleRate?: number }>;
  addListener(eventName: "audioFrame", listener: (event: NativeVoiceFrameEvent) => void): Promise<PluginListenerHandle>;
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
  private listener?: PluginListenerHandle;
  private stopCurrent?: () => void;

  async requestPermission(): Promise<"granted" | "denied" | "prompt"> {
    return canUseNativeVoiceCapture() ? "prompt" : "denied";
  }

  async *start(options: VoiceCaptureOptions, signal: AbortSignal): AsyncIterable<VoiceAudioFrame> {
    if (!canUseNativeVoiceCapture()) throw new Error("当前平台不支持原生实时语音采集");
    const values: VoiceAudioFrame[] = [];
    let wake: (() => void) | undefined;
    let done = false;
    this.stopCurrent = () => { done = true; wake?.(); };
    this.listener = await NativeVoiceCapture.addListener("audioFrame", (event) => {
      values.push({
        sequence: event.sequence,
        capturedAtMonotonicMs: event.capturedAtMonotonicMs,
        format: { encoding: "pcm-s16le", sampleRate: event.sampleRate, channelCount: event.channelCount },
        data: decodeBase64(event.data),
      });
      wake?.();
      wake = undefined;
    });
    await NativeVoiceCapture.start({ sampleRate: options.preferredFormat.sampleRate, frameSize: 2048 });
    signal.addEventListener("abort", () => { void this.stop(); }, { once: true });
    while (!done) {
      const value = values.shift();
      if (value) yield value;
      else await new Promise<void>((resolve) => { wake = resolve; });
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
    if (canUseNativeVoiceCapture()) await NativeVoiceCapture.stop().catch(() => undefined);
  }
}
