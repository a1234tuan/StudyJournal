import { createAsyncQueue, type AsyncQueue } from "./asyncQueue";
import type { VoiceAudioFrame, VoiceCaptureAdapter, VoiceCaptureOptions } from "./contracts";

const floatToPcm16 = (input: Float32Array): Uint8Array => {
  const output = new Int16Array(input.length);
  for (let index = 0; index < input.length; index += 1) {
    const sample = Math.max(-1, Math.min(1, input[index]));
    output[index] = sample < 0 ? sample * 0x8000 : sample * 0x7fff;
  }
  return new Uint8Array(output.buffer);
};

export class WebVoiceCaptureAdapter implements VoiceCaptureAdapter {
  diagnostics: Record<string, string | number | boolean> = {};
  readonly id = "web-audio-pcm";
  private stream?: MediaStream;
  private context?: AudioContext;
  private source?: MediaStreamAudioSourceNode;
  private processor?: ScriptProcessorNode;
  private queue?: AsyncQueue<VoiceAudioFrame>;

  async requestPermission(): Promise<"granted" | "denied" | "prompt"> {
    if (!navigator.mediaDevices?.getUserMedia) return "denied";
    const permission = await navigator.permissions?.query?.({ name: "microphone" as PermissionName }).catch(() => undefined);
    return permission?.state ?? "prompt";
  }

  async *start(options: VoiceCaptureOptions, signal: AbortSignal): AsyncIterable<VoiceAudioFrame> {
    if (this.stream) throw new Error("语音采集已经在进行中");
    if (signal.aborted) return;
    const stream = await navigator.mediaDevices.getUserMedia({ audio: {
      channelCount: options.preferredFormat.channelCount,
      sampleRate: options.preferredFormat.sampleRate,
      echoCancellation: options.echoCancellation,
      noiseSuppression: options.noiseSuppression,
      autoGainControl: options.autoGainControl,
    } });
    if (signal.aborted) { stream.getTracks().forEach((track) => track.stop()); return; }
    this.stream = stream;
    const settings = stream.getAudioTracks?.()[0]?.getSettings?.();
    this.diagnostics = { echoCancellation: settings?.echoCancellation ?? "unknown", noiseSuppression: settings?.noiseSuppression ?? "unknown", autoGainControl: settings?.autoGainControl ?? "unknown" };
    await window.studyJournalDesktop?.voice.setCaptureActive(true);
    if (signal.aborted) { await this.stop(); return; }
    this.context = new AudioContext({ sampleRate: options.preferredFormat.sampleRate });
    this.diagnostics.sampleRate = this.context.sampleRate;
    this.source = this.context.createMediaStreamSource(this.stream);
    this.processor = this.context.createScriptProcessor(2048, 1, 1);
    this.queue = createAsyncQueue<VoiceAudioFrame>();
    let sequence = 0;
    this.processor.onaudioprocess = (event) => this.queue?.push({
      sequence: sequence++,
      capturedAtMonotonicMs: performance.now(),
      format: { encoding: "pcm-s16le", sampleRate: this.context!.sampleRate, channelCount: 1 },
      data: floatToPcm16(event.inputBuffer.getChannelData(0)),
    });
    this.source.connect(this.processor);
    this.processor.connect(this.context.destination);
    const abort = () => { void this.stop(); };
    signal.addEventListener("abort", abort, { once: true });
    try {
      for await (const frame of this.queue) {
        if (signal.aborted) break;
        yield frame;
      }
    } finally {
      signal.removeEventListener("abort", abort);
      await this.stop();
    }
  }

  async pause() {
    await this.context?.suspend();
  }

  async stop() {
    this.queue?.close();
    this.processor?.disconnect();
    this.source?.disconnect();
    this.stream?.getTracks().forEach((track) => track.stop());
    await this.context?.close().catch(() => undefined);
    this.queue = undefined;
    this.processor = undefined;
    this.source = undefined;
    this.stream = undefined;
    this.context = undefined;
    await window.studyJournalDesktop?.voice.setCaptureActive(false);
  }
}
