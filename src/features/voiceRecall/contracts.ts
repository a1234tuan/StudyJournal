import type { VoiceRecallInputMode, VoiceRecallSessionMode } from "./domain";

export interface VoiceOperationContext {
  sessionId: string;
  turnId: string;
  operationId: string;
  signal: AbortSignal;
}

export interface VoiceAudioFormat {
  encoding: "pcm-s16le" | "opus" | "aac" | "provider-native";
  sampleRate: number;
  channelCount: 1 | 2;
}

export interface VoiceAudioFrame {
  sequence: number;
  capturedAtMonotonicMs: number;
  format: VoiceAudioFormat;
  data: Uint8Array;
}

export interface VoiceCaptureOptions {
  inputMode: VoiceRecallInputMode;
  echoCancellation: boolean;
  noiseSuppression: boolean;
  autoGainControl: boolean;
  preferredFormat: VoiceAudioFormat;
}

export interface VoiceCaptureAdapter {
  readonly id: string;
  requestPermission(): Promise<"granted" | "denied" | "prompt">;
  start(options: VoiceCaptureOptions, signal: AbortSignal): AsyncIterable<VoiceAudioFrame>;
  pause(): Promise<void>;
  stop(): Promise<void>;
}

export type AsrStreamEvent =
  | { type: "partial"; text: string; confidence?: number }
  | { type: "final"; text: string; confidence?: number; usageSeconds?: number; cumulative?: boolean }
  | { type: "completed"; usageSeconds?: number };

export interface AsrStreamRequest extends VoiceOperationContext {
  language: string;
  format: VoiceAudioFormat;
  frames: AsyncIterable<VoiceAudioFrame>;
}

export interface AsrStreamAdapter {
  readonly profileId: string;
  transcribe(request: AsrStreamRequest): AsyncIterable<AsrStreamEvent>;
}

export type LlmStreamEvent =
  | { type: "token"; text: string }
  | { type: "usage"; inputTokens?: number; outputTokens?: number }
  | { type: "completed" };

export interface VoiceTeacherMessage {
  role: "system" | "user" | "assistant";
  content: string;
  contentBoundary?: "trusted-instruction" | "untrusted-learning-content";
}

export interface LlmStreamRequest extends VoiceOperationContext {
  messages: readonly VoiceTeacherMessage[];
}

export interface LlmStreamAdapter {
  readonly profileId: string;
  complete(request: LlmStreamRequest): AsyncIterable<LlmStreamEvent>;
}

export type TtsStreamEvent =
  | { type: "audio"; chunk: Uint8Array; format: VoiceAudioFormat }
  | { type: "usage"; characters?: number }
  | { type: "completed" };

export interface TtsStreamRequest extends VoiceOperationContext {
  text: string;
  voice: string;
}

export interface TtsStreamAdapter {
  readonly profileId: string;
  synthesize(request: TtsStreamRequest): AsyncIterable<TtsStreamEvent>;
}

export interface VoiceRecallSource {
  kind: "review-home" | "record" | "review-card" | "coach-task" | "free-topic";
  recordIds?: string[];
  taskId?: string;
  returnIdentity?: string;
}

export interface VoiceRecallSessionRequest {
  mode: VoiceRecallSessionMode;
  source: VoiceRecallSource;
  inputMode: VoiceRecallInputMode;
}
