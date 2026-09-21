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
  audioReadyToPlaybackMs?: number;
  lastVoiceToEndpointMs?: number;
  endpointToAsrFinalMs?: number;
  endpointReason?: import("./voiceActivity").VoiceEndpointReason;
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
export const voiceOperationLatency = (operationId: string, responseStartedAt: number) => {
  const operationEvents = events.filter((event) => event.operationId === operationId || event.operationId.startsWith(`${operationId}:tts:`));
  const at = (stage: VoiceStage, event: VoiceStageEvent) => operationEvents.find((item) => item.stage === stage && item.event === event)?.monotonicMs;
  const llmStarted = at("llm", "start") ?? responseStartedAt;
  const firstToken = at("llm", "first-token");
  const firstAudio = at("tts", "audio-ready");
  const playbackStarted = at("playback", "start");
  return {
    firstTokenDelayMs: firstToken === undefined ? undefined : Math.max(0, firstToken - llmStarted),
    firstAudioDelayMs: firstAudio === undefined ? undefined : Math.max(0, firstAudio - responseStartedAt),
    audioReadyToPlaybackMs: firstAudio === undefined || playbackStarted === undefined ? undefined : Math.max(0, playbackStarted - firstAudio),
  };
};
export class VoiceStageError extends Error {
  constructor(readonly stage: VoiceStage, cause: unknown) { super(`${labels[stage]}没有完成`, { cause }); this.name = "VoiceStageError"; }
}
export const stageFailure = (stage: VoiceStage, error: unknown): unknown => error instanceof DOMException && error.name === "AbortError" ? error : error instanceof VoiceStageError ? error : new VoiceStageError(stage, error);
const safeStageCause = (cause: unknown): string | undefined => {
  if (!(cause instanceof Error) || !cause.message.trim()) return undefined;
  return cause.message.trim()
    .replace(/([?&](?:token|appkey)=)[^&\s]+/gi, "$1[已隐藏]")
    .replace(/((?:access[ _-]?token|appkey)\s*(?:[:=]|\s))["']?[A-Za-z0-9._~+/-]{6,}["']?/gi, "$1[已隐藏]")
    .replace(/(bearer\s+)[A-Za-z0-9._~+/-]+/gi, "$1[已隐藏]")
    .replace(/[A-Za-z0-9_-]{24,}/g, "[已隐藏]")
    .slice(0, 180);
};
export const describeVoiceStage = (error: VoiceStageError) => {
  const detail = safeStageCause(error.cause);
  return `${labels[error.stage]}没有完成${detail ? `：${detail}` : ""}。请检查该阶段的配置或网络后重试。已确认的本机学习数据不会因此被删除。`;
};
