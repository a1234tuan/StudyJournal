import type { VoiceAudioFrame } from "./contracts";

export type CapturePhase = "armed" | "speaking" | "endpoint-wait";

export type VoiceEndpointReason = "strong-punctuation" | "provider-final" | "stable-text" | "continuation" | "no-transcript";

interface VoiceActivityMetrics {
  frames: number;
  missingFrames: number;
  samples: number;
  clippedSamples: number;
  silentFrames: number;
  rms: number;
  elapsedMs: number;
  lastVoicedFrameMs?: number;
  endpointSilenceMs?: number;
  endpointReason?: VoiceEndpointReason;
}

export class VoiceActivityEndpoint {
  private noise = 0.003;
  private candidateMs = 0;
  private quietMs = 0;
  private accepted = false;
  private ended = false;
  private transcript = "";
  private transcriptKind: "partial" | "final" = "partial";
  private transcriptChangedAtMs = 0;
  phase: CapturePhase = "armed";
  readonly metrics: VoiceActivityMetrics = { frames: 0, missingFrames: 0, samples: 0, clippedSamples: 0, silentFrames: 0, rms: 0, elapsedMs: 0 };
  private previousSequence?: number;
  private readonly candidateGapMs = 180;

  updateTranscript(text: string, kind: "partial" | "final" = "partial") {
    const normalized = text.trim();
    if (normalized !== this.transcript) this.transcriptChangedAtMs = this.metrics.elapsedMs;
    this.transcript = normalized;
    this.transcriptKind = kind;
  }

  updatePartial(text: string) { this.updateTranscript(text, "partial"); }

  push(frame: VoiceAudioFrame): boolean {
    if (frame.format.encoding !== "pcm-s16le" || frame.format.channelCount !== 1 || frame.format.sampleRate <= 0 || frame.data.byteLength % 2) throw new Error("不支持的采集音频格式");
    if (this.ended || !frame.data.byteLength) return false;
    const view = new DataView(frame.data.buffer, frame.data.byteOffset, frame.data.byteLength);
    const count = frame.data.byteLength / 2;
    let energy = 0;
    for (let index = 0; index < count; index += 1) {
      const sample = view.getInt16(index * 2, true) / 32768;
      energy += sample * sample;
      if (Math.abs(sample) >= 0.98) this.metrics.clippedSamples += 1;
    }
    const rms = Math.sqrt(energy / count);
    const duration = count / frame.format.sampleRate * 1000;
    this.metrics.elapsedMs += duration;
    this.metrics.frames += 1;
    this.metrics.samples += count;
    this.metrics.rms = rms;
    if (this.previousSequence !== undefined) this.metrics.missingFrames += Math.max(0, frame.sequence - this.previousSequence - 1);
    this.previousSequence = frame.sequence;
    const threshold = Math.max(this.accepted ? 0.006 : 0.008, this.noise * (this.accepted ? 1.8 : 2.2));
    if (rms >= threshold) {
      this.candidateMs += duration;
      this.quietMs = 0;
      this.metrics.lastVoicedFrameMs = this.metrics.elapsedMs;
      if (this.candidateMs >= 350) this.accepted = true;
      this.phase = this.accepted ? "speaking" : "armed";
    } else {
      this.metrics.silentFrames += 1;
      if (!this.accepted) {
        this.candidateMs = Math.max(0, this.candidateMs - Math.min(duration, this.candidateGapMs));
        this.noise = Math.min(0.012, this.noise * 0.98 + rms * 0.02);
      }
      this.quietMs += duration;
      this.phase = this.accepted ? "endpoint-wait" : "armed";
      if (this.accepted) {
        const decision = this.endpointDecision();
        if (this.quietMs >= decision.silenceMs) {
          this.ended = true;
          this.metrics.endpointSilenceMs = this.quietMs;
          this.metrics.endpointReason = decision.reason;
          return true;
        }
      }
    }
    return false;
  }

  get hasSpeech() { return this.accepted; }

  private endpointDecision(): { silenceMs: number; reason: VoiceEndpointReason } {
    const text = this.transcript;
    if (!text) return { silenceMs: 2200, reason: "no-transcript" };
    if (/(?:因为|所以|然后|或者|就是|包括|但是|而且|以及|如果|并且|and|or|because|but)[，、,:：;；\s]*$/i.test(text)) {
      return { silenceMs: 1800, reason: "continuation" };
    }
    const stableMs = this.metrics.elapsedMs - this.transcriptChangedAtMs;
    if (/[。！？?!][”’」』）)]*$/.test(text) && (this.transcriptKind === "final" || stableMs >= 200)) {
      return { silenceMs: 700, reason: "strong-punctuation" };
    }
    if (this.transcriptKind === "final") return { silenceMs: 900, reason: "provider-final" };
    if (stableMs >= 400) return { silenceMs: 1100, reason: "stable-text" };
    return { silenceMs: 1600, reason: "stable-text" };
  }
}
