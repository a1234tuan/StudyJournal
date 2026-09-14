export type VoiceStage = "asr" | "llm" | "tts" | "playback" | "storage";
export type VoiceStageEvent = "start" | "first-token" | "audio-ready" | "completed" | "failed" | "cancelled";
const labels: Record<VoiceStage, string> = { asr: "语音识别", llm: "AI 回复", tts: "语音合成", playback: "音频播放", storage: "本机保存" };
const events: { operationId: string; stage: VoiceStage; event: VoiceStageEvent; monotonicMs: number }[] = [];
export const recordVoiceStage = (operationId: string, stage: VoiceStage, event: VoiceStageEvent) => {
  events.push({ operationId, stage, event, monotonicMs: performance.now() });
  if (events.length > 512) events.splice(0, events.length - 512);
};
export const voiceStageSnapshot = () => events.map((event) => ({ ...event }));
export interface VoiceTurnObservation {
  operationId: string;
  promptVersion?: string;
  provider?: string;
  inputTokens?: number;
  outputTokens?: number;
  asrDurationMs?: number;
  llmDurationMs?: number;
  firstTokenDelayMs?: number;
  firstAudioDelayMs?: number;
  playbackDurationMs?: number;
  replyCharacters: number;
  playedCharacters: number;
  endsWithQuestion: boolean;
  interrupted: boolean;
  asrRetries: number;
  errorCode?: string;
  playbackStatus?: string;
}
const turnObservations: VoiceTurnObservation[] = [];
export const recordVoiceTurnObservation = (observation: VoiceTurnObservation) => {
  turnObservations.push({ ...observation });
  if (turnObservations.length > 256) turnObservations.splice(0, turnObservations.length - 256);
};
export const voiceTurnObservationSnapshot = () => turnObservations.map((item) => ({ ...item }));
export class VoiceStageError extends Error {
  constructor(readonly stage: VoiceStage, cause: unknown) { super(`${labels[stage]}没有完成`, { cause }); this.name = "VoiceStageError"; }
}
export const stageFailure = (stage: VoiceStage, error: unknown): unknown => error instanceof DOMException && error.name === "AbortError" ? error : error instanceof VoiceStageError ? error : new VoiceStageError(stage, error);
export const describeVoiceStage = (error: VoiceStageError) => `${labels[error.stage]}没有完成，请检查该阶段的配置或网络后重试。已确认的本机学习数据不会因此被删除。`;
