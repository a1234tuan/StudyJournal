/** Alibaba Cloud Intelligent Speech Interaction (NLS) SpeechTranscriber protocol. */

export interface AliyunNlsAsrSessionConfig {
  sampleRate: 8_000 | 16_000;
  format: "pcm" | "wav" | "opus" | "speex" | "amr" | "mp3" | "aac";
  punctuation?: boolean;
  inverseTextNormalization?: boolean;
  vocabularyId?: string;
  maxSentenceSilence?: number;
  disfluencyRemovalEnabled?: boolean;
  semanticSentenceDetectionEnabled?: boolean;
}

export const DEFAULT_ALIYUN_NLS_ASR_CONFIG: AliyunNlsAsrSessionConfig = {
  sampleRate: 16_000,
  format: "pcm",
  punctuation: true,
  inverseTextNormalization: true,
  maxSentenceSilence: 800,
  disfluencyRemovalEnabled: false,
  semanticSentenceDetectionEnabled: false,
};

export type AliyunNlsAsrEvent =
  | { type: "started" }
  | { type: "partial"; text: string }
  | { type: "final"; text: string; segmentId?: string }
  | { type: "completed" }
  | { type: "failed"; message: string }
  | { type: "unknown"; raw: string };

const header = (name: "StartTranscription" | "StopTranscription", taskId: string, messageId: string, appKey: string) => ({
  message_id: messageId,
  task_id: taskId,
  namespace: "SpeechTranscriber",
  name,
  appkey: appKey,
});

export const buildAliyunNlsStartTranscription = (
  taskId: string,
  messageId: string,
  appKey: string,
  config: AliyunNlsAsrSessionConfig = DEFAULT_ALIYUN_NLS_ASR_CONFIG,
): string => JSON.stringify({
  header: header("StartTranscription", taskId, messageId, appKey),
  payload: {
    format: config.format,
    sample_rate: config.sampleRate,
    enable_intermediate_result: true,
    enable_punctuation_prediction: config.punctuation ?? true,
    enable_inverse_text_normalization: config.inverseTextNormalization ?? true,
    ...(config.vocabularyId?.trim() ? { vocabulary_id: config.vocabularyId.trim() } : {}),
    ...(config.maxSentenceSilence !== undefined ? { max_sentence_silence: config.maxSentenceSilence } : {}),
    ...(config.disfluencyRemovalEnabled !== undefined ? { disfluency: config.disfluencyRemovalEnabled } : {}),
    ...(config.semanticSentenceDetectionEnabled !== undefined ? { enable_semantic_sentence_detection: config.semanticSentenceDetectionEnabled } : {}),
  },
});

export const buildAliyunNlsStopTranscription = (
  taskId: string,
  messageId: string,
  appKey: string,
): string => JSON.stringify({ header: header("StopTranscription", taskId, messageId, appKey) });

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null ? value as Record<string, unknown> : undefined;

export const parseAliyunNlsAsrMessage = (raw: string): AliyunNlsAsrEvent => {
  let decoded: unknown;
  try {
    decoded = JSON.parse(raw);
  } catch {
    return { type: "unknown", raw };
  }
  const root = asRecord(decoded);
  const responseHeader = asRecord(root?.header);
  const name = typeof responseHeader?.name === "string" ? responseHeader.name : "";
  const status = responseHeader?.status;
  const statusText = typeof responseHeader?.status_text === "string" ? responseHeader.status_text : "";
  if (name === "TaskFailed" || (typeof status === "number" && status !== 20_000_000)) {
    return { type: "failed", message: statusText || "阿里云智能语音交互识别任务失败。" };
  }
  const responsePayload = asRecord(root?.payload);
  const text = typeof responsePayload?.result === "string" ? responsePayload.result.trim() : "";
  switch (name) {
    case "TranscriptionStarted":
      return { type: "started" };
    case "TranscriptionResultChanged":
      return text ? { type: "partial", text } : { type: "unknown", raw };
    case "SentenceEnd":
      return text ? { type: "final", text, ...(responsePayload?.index !== undefined ? { segmentId: String(responsePayload.index) } : {}) } : { type: "unknown", raw };
    case "TranscriptionCompleted":
      return { type: "completed" };
    default:
      return { type: "unknown", raw };
  }
};
