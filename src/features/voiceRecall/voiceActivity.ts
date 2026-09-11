import type { VoiceAudioFrame } from "./contracts";

export type CapturePhase = "armed" | "speaking" | "endpoint-wait";

export class VoiceActivityEndpoint {
  private noise = 0.003;
  private candidateMs = 0;
  private quietMs = 0;
  private accepted = false;
  private ended = false;
  private partial = "";
  phase: CapturePhase = "armed";
  readonly metrics = { frames: 0, missingFrames: 0, samples: 0, clippedSamples: 0, silentFrames: 0, rms: 0 };
  private previousSequence?: number;

  updatePartial(text: string) { this.partial = text; }

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
    this.metrics.frames += 1;
    this.metrics.samples += count;
    this.metrics.rms = rms;
    if (this.previousSequence !== undefined) this.metrics.missingFrames += Math.max(0, frame.sequence - this.previousSequence - 1);
    this.previousSequence = frame.sequence;
    const threshold = Math.max(this.accepted ? 0.012 : 0.018, this.noise * (this.accepted ? 2 : 3));
    if (rms >= threshold) {
      this.candidateMs += duration;
      this.quietMs = 0;
      if (this.candidateMs >= 350) this.accepted = true;
      this.phase = this.accepted ? "speaking" : "armed";
    } else {
      this.metrics.silentFrames += 1;
      if (!this.accepted) { this.candidateMs = 0; this.noise = Math.min(0.02, this.noise * 0.98 + rms * 0.02); }
      this.quietMs += duration;
      this.phase = this.accepted ? "endpoint-wait" : "armed";
      const incomplete = !this.partial.trim() || /(?:因为|所以|然后|或者|就是|包括|但是|而且|and|or|because)[，、,:：;；\s]*$/i.test(this.partial.trim());
      if (this.accepted && this.quietMs >= (incomplete ? 4000 : 2000)) { this.ended = true; return true; }
    }
    return false;
  }

  get hasSpeech() { return this.accepted; }
}
