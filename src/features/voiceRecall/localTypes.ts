import type { VoiceRecallInputMode, VoiceRecallSessionMode, VoiceRecallStatus } from "./domain";
import type { VoiceRecallSource } from "./contracts";

export type VoiceRecallLocalSessionStatus = VoiceRecallStatus | "interrupted" | "completed";
export type VoiceRecallLocalTurnStatus = "draft" | "finalizing" | "confirmed" | "completed" | "cancelled" | "failed";

export interface VoiceRecallProviderSnapshot {
  templateId?: string;
  templateVersion?: number;
  asrProfileId?: string;
  llmProfileId?: string;
  ttsProfileId?: string;
  configurationIdentity?: string;
  config?: import("./providerProfiles").VoiceProviderEditableConfig;
}

export interface VoiceRecallStructuredMemory {
  learningGoal: string;
  coveredPoints: string[];
  misconceptions: string[];
  pendingTopics: string[];
  nextQuestionPurpose?: string;
}

export interface VoiceRecallSessionCheckpoint {
  activeTurnId?: string;
  nextSequence: number;
  lastConfirmedText?: string;
  elapsedMs: number;
  inputMode: VoiceRecallInputMode;
  userMuted: boolean;
}

export type VoiceUsageSources = Partial<Record<keyof import("./providerRuntime").VoiceUsageTotals, "provider-reported" | "local-estimate">>;

export interface VoiceRecallSessionLocal {
  id: string;
  mode: VoiceRecallSessionMode;
  sourceKind: VoiceRecallSource["kind"];
  source: VoiceRecallSource;
  sourceRecordIds: string[];
  sourceTaskId?: string;
  sourceUnavailable?: boolean;
  status: VoiceRecallLocalSessionStatus;
  provider: VoiceRecallProviderSnapshot;
  usageOperations?: Record<string, Partial<import("./providerRuntime").VoiceUsageTotals>>;
  usageSources?: VoiceUsageSources;
  memory: VoiceRecallStructuredMemory;
  checkpoint: VoiceRecallSessionCheckpoint;
  createdAt: string;
  updatedAt: string;
  endedAt?: string;
}

export interface VoiceRecallTurnLocal {
  id: string;
  sessionId: string;
  sequence: number;
  operationId: string;
  status: VoiceRecallLocalTurnStatus;
  teacherText: string;
  providerFinalText?: string;
  cleanText?: string;
  confirmedText?: string;
  transcriptEdited?: boolean;
  uncertainSpans?: string[];
  meaningRisk?: "low" | "medium" | "high";
  playedCharacterCount?: number;
  usage?: Partial<import("./providerRuntime").VoiceUsageTotals>;
  usageSources?: VoiceUsageSources;
  errorCode?: string;
  createdAt: string;
  updatedAt: string;
}

export interface VoiceRecallUsageEstimate {
  capturedSeconds: number;
  asrSentSeconds: number;
  llmInputTokens: number;
  llmOutputTokens: number;
  ttsCharacters: number;
  estimatedCostMinorUnits?: number;
  currency?: string;
}

export interface VoiceRecallLocalHistory {
  id: string;
  sessionId?: string;
  sourceKind: VoiceRecallSource["kind"];
  source: VoiceRecallSource;
  sourceUnavailable?: boolean;
  title: string;
  summary: string;
  usage: VoiceRecallUsageEstimate;
  observedUsage?: Partial<import("./providerRuntime").VoiceUsageTotals>;
  usageSources?: VoiceUsageSources;
  savedAt: string;
}
