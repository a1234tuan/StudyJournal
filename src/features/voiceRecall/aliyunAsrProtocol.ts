/**
 * DashScope Paraformer real-time ASR wire protocol.
 *
 * Verified against the live service on 2026-09-09: `run-task` -> `task-started`
 * -> binary PCM frames -> `finish-task` -> `result-generated`* -> `task-finished`.
 * Kept free of I/O so the framing can be unit tested without a socket.
 */

export interface AliyunAsrSessionConfig {
  model: string;
  sampleRate: number;
  format: "pcm" | "opus" | "mp3" | "wav";
  punctuation?: boolean;
  languageHints?: string[];
  vocabularyId?: string;
  disfluencyRemovalEnabled?: boolean;
  semanticPunctuationEnabled?: boolean;
  maxSentenceSilence?: number;
  multiThresholdModeEnabled?: boolean;
  inverseTextNormalizationEnabled?: boolean;
}

export const DEFAULT_ALIYUN_ASR_CONFIG: AliyunAsrSessionConfig = {
  model: "paraformer-realtime-v2",
  sampleRate: 16_000,
  format: "pcm",
  punctuation: true,
  languageHints: ["zh", "en"],
  disfluencyRemovalEnabled: false,
  semanticPunctuationEnabled: false,
  maxSentenceSilence: 1300,
  multiThresholdModeEnabled: false,
  inverseTextNormalizationEnabled: true,
};

export type AliyunAsrEvent =
  | { type: "started" }
  | { type: "partial"; text: string }
  | { type: "final"; text: string; segmentId?: string; usageSeconds?: number }
  | { type: "completed" }
  | { type: "failed"; message: string }
  | { type: "unknown"; raw: string };

export const buildAliyunRunTask = (taskId: string, config: AliyunAsrSessionConfig = DEFAULT_ALIYUN_ASR_CONFIG): string =>
  JSON.stringify({
    header: { action: "run-task", task_id: taskId, streaming: "duplex" },
    payload: {
      task_group: "audio",
      task: "asr",
      function: "recognition",
      model: config.model,
      parameters: {
        format: config.format,
        sample_rate: config.sampleRate,
        punctuation_prediction_enabled: config.punctuation ?? true,
        ...(config.languageHints?.length ? { language_hints: config.languageHints } : {}),
        ...(config.vocabularyId?.trim() ? { vocabulary_id: config.vocabularyId.trim() } : {}),
        ...(config.disfluencyRemovalEnabled !== undefined ? { disfluency_removal_enabled: config.disfluencyRemovalEnabled } : {}),
        ...(config.semanticPunctuationEnabled !== undefined ? { semantic_punctuation_enabled: config.semanticPunctuationEnabled } : {}),
        ...(config.maxSentenceSilence !== undefined ? { max_sentence_silence: config.maxSentenceSilence } : {}),
        ...(config.multiThresholdModeEnabled !== undefined ? { multi_threshold_mode_enabled: config.multiThresholdModeEnabled } : {}),
        ...(config.inverseTextNormalizationEnabled !== undefined ? { inverse_text_normalization_enabled: config.inverseTextNormalizationEnabled } : {}),
      },
      input: {},
    },
  });

export const buildAliyunFinishTask = (taskId: string): string =>
  JSON.stringify({
    header: { action: "finish-task", task_id: taskId, streaming: "duplex" },
    payload: { input: {} },
  });

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null ? value as Record<string, unknown> : undefined;

export const parseAliyunAsrMessage = (raw: string): AliyunAsrEvent => {
  let payload: unknown;
  try {
    payload = JSON.parse(raw);
  } catch {
    return { type: "unknown", raw };
  }
  const root = asRecord(payload);
  const header = asRecord(root?.header);
  const event = typeof header?.event === "string" ? header.event : "";
  switch (event) {
    case "task-started":
      return { type: "started" };
    case "task-finished":
      return { type: "completed" };
    case "task-failed":
      return {
        type: "failed",
        message: typeof header?.error_message === "string" ? header.error_message : "阿里云语音识别任务失败。",
      };
    case "result-generated": {
      const output = asRecord(asRecord(root?.payload)?.output);
      const sentence = asRecord(output?.sentence);
      const text = typeof sentence?.text === "string" ? sentence.text.trim() : "";
      if (!text) return { type: "unknown", raw };
      const duration = asRecord(asRecord(root?.payload)?.usage)?.duration;
      const reportedUsage = typeof duration === "number" && Number.isFinite(duration) && duration >= 0 ? { usageSeconds: duration } : {};
      const ended = sentence?.sentence_end === true || sentence?.sentenceEnd === true;
      return ended ? { type: "final", text, ...reportedUsage, ...(sentence?.begin_time !== undefined ? { segmentId: String(sentence.begin_time) } : {}) } : { type: "partial", text };
    }
    default:
      return { type: "unknown", raw };
  }
};
