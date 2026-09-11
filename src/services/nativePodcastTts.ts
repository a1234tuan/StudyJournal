import { Capacitor, registerPlugin } from "@capacitor/core";

export interface NativePodcastTtsQueueUnit {
  unitId: string;
  title: string;
  order: number;
  parts: string[];
}

export interface NativePodcastTtsJobRequest {
  jobId: string;
  podcastId: string;
  podcastTitle: string;
  apiKey: string;
  /** Tencent Cloud only: SecretKey (apiKey holds the SecretId). */
  apiKeySecondary?: string;
  providerId: string;
  model: string;
  voiceId: string;
  appId?: string;
  region?: string;
  languageCode?: string;
  units: NativePodcastTtsQueueUnit[];
}

export interface NativePodcastTtsUnitState {
  unitId: string;
  title: string;
  order: number;
  status: "pending" | "generating" | "ready" | "failed";
  error?: string;
}

export interface NativePodcastTtsState {
  jobId: string;
  podcastId: string;
  status: "running" | "completed" | "partial" | "failed" | "cancelled";
  message: string;
  startedAt: string;
  updatedAt: string;
  heartbeatAt?: string;
  requestStartedAt?: string;
  runnerActive?: boolean;
  current?: number;
  total?: number;
  partCurrent?: number;
  partTotal?: number;
  units: NativePodcastTtsUnitState[];
  diagnostics?: Array<{
    at: string;
    unitId?: string;
    unitTitle?: string;
    partCurrent?: number;
    partTotal?: number;
    attempt?: number;
    httpStatus?: number;
    requestId?: string;
    message: string;
  }>;
}

export interface NativePodcastTtsArtifact {
  jobId: string;
  podcastId: string;
  unitId: string;
  title: string;
  data: string;
  mimeType?: string;
}

interface NativePodcastTtsPlugin {
  requestNotificationPermission(): Promise<{ granted: boolean }>;
  start(options: { apiKey: string; apiKeySecondary?: string; job: Omit<NativePodcastTtsJobRequest, "apiKey" | "apiKeySecondary"> }): Promise<void>;
  getState(): Promise<{ state?: string }>;
  takeNextArtifact(): Promise<{ artifact?: NativePodcastTtsArtifact }>;
  acknowledgeArtifact(options: { jobId: string; unitId: string }): Promise<void>;
  cancel(options: { jobId?: string; podcastId?: string }): Promise<void>;
}

const NativePodcastTts = registerPlugin<NativePodcastTtsPlugin>("NativePodcastTts");

export const isNativePodcastTtsAvailable = (): boolean =>
  Capacitor.isNativePlatform() && Capacitor.getPlatform() === "android";

export const requestNativePodcastTtsNotificationPermission = async (): Promise<void> => {
  if (!isNativePodcastTtsAvailable()) return;
  await NativePodcastTts.requestNotificationPermission();
};

export const startNativePodcastTts = async (job: NativePodcastTtsJobRequest): Promise<void> => {
  if (!isNativePodcastTtsAvailable()) return;
  const { apiKey, apiKeySecondary, ...request } = job;
  await NativePodcastTts.start({ apiKey, apiKeySecondary, job: request });
};

export const getNativePodcastTtsState = async (): Promise<NativePodcastTtsState | undefined> => {
  if (!isNativePodcastTtsAvailable()) return undefined;
  const result = await NativePodcastTts.getState();
  if (!result.state) return undefined;
  try {
    return JSON.parse(result.state) as NativePodcastTtsState;
  } catch {
    return undefined;
  }
};

export const takeNativePodcastTtsArtifact = async (): Promise<NativePodcastTtsArtifact | undefined> => {
  if (!isNativePodcastTtsAvailable()) return undefined;
  return (await NativePodcastTts.takeNextArtifact()).artifact;
};

export const acknowledgeNativePodcastTtsArtifact = async (jobId: string, unitId: string): Promise<void> => {
  if (!isNativePodcastTtsAvailable()) return;
  await NativePodcastTts.acknowledgeArtifact({ jobId, unitId });
};

export const cancelNativePodcastTts = async (jobId?: string, podcastId?: string): Promise<void> => {
  if (!isNativePodcastTtsAvailable()) return;
  await NativePodcastTts.cancel({ jobId, podcastId });
};

export const base64ToPodcastAudioBlob = (data: string, mimeType = "audio/mpeg"): Blob => {
  const binary = atob(data);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return new Blob([bytes], { type: mimeType });
};
