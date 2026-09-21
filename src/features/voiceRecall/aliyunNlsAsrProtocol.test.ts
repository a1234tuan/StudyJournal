import { describe, expect, it } from "vitest";

import {
  buildAliyunNlsStartTranscription,
  buildAliyunNlsStopTranscription,
  parseAliyunNlsAsrMessage,
} from "./aliyunNlsAsrProtocol";

describe("Aliyun NLS SpeechTranscriber protocol", () => {
  it("builds start and stop commands with project and recognition settings", () => {
    const start = JSON.parse(buildAliyunNlsStartTranscription("a".repeat(32), "b".repeat(32), "project-app-key", {
      sampleRate: 16_000,
      format: "pcm",
      punctuation: true,
      inverseTextNormalization: true,
      vocabularyId: "study-terms",
      maxSentenceSilence: 900,
      disfluencyRemovalEnabled: false,
      semanticSentenceDetectionEnabled: true,
    }));
    expect(start.header).toEqual({
      message_id: "b".repeat(32),
      task_id: "a".repeat(32),
      namespace: "SpeechTranscriber",
      name: "StartTranscription",
      appkey: "project-app-key",
    });
    expect(start.payload).toMatchObject({
      format: "pcm",
      sample_rate: 16_000,
      enable_intermediate_result: true,
      enable_punctuation_prediction: true,
      enable_inverse_text_normalization: true,
      vocabulary_id: "study-terms",
      max_sentence_silence: 900,
      disfluency: false,
      enable_semantic_sentence_detection: true,
    });
    expect(JSON.parse(buildAliyunNlsStopTranscription("a".repeat(32), "c".repeat(32), "project-app-key"))).toEqual({
      header: {
        message_id: "c".repeat(32),
        task_id: "a".repeat(32),
        namespace: "SpeechTranscriber",
        name: "StopTranscription",
        appkey: "project-app-key",
      },
    });
  });

  it("maps the documented recognition lifecycle", () => {
    expect(parseAliyunNlsAsrMessage(JSON.stringify({ header: { name: "TranscriptionStarted", status: 20_000_000 } }))).toEqual({ type: "started" });
    expect(parseAliyunNlsAsrMessage(JSON.stringify({ header: { name: "TranscriptionResultChanged", status: 20_000_000 }, payload: { index: 1, result: "间隔复习" } }))).toEqual({ type: "partial", text: "间隔复习" });
    expect(parseAliyunNlsAsrMessage(JSON.stringify({ header: { name: "SentenceEnd", status: 20_000_000 }, payload: { index: 1, result: "间隔复习有效。" } }))).toEqual({ type: "final", text: "间隔复习有效。", segmentId: "1" });
    expect(parseAliyunNlsAsrMessage(JSON.stringify({ header: { name: "TranscriptionCompleted", status: 20_000_000 } }))).toEqual({ type: "completed" });
  });

  it("surfaces failed status frames without leaking malformed payloads", () => {
    expect(parseAliyunNlsAsrMessage(JSON.stringify({ header: { name: "TaskFailed", status: 40_000_004, status_text: "Gateway:ACCESS_DENIED" } }))).toEqual({ type: "failed", message: "Gateway:ACCESS_DENIED" });
    expect(parseAliyunNlsAsrMessage(JSON.stringify({ header: { name: "SentenceEnd", status: 40_000_000, status_text: "bad request" } }))).toEqual({ type: "failed", message: "bad request" });
    expect(parseAliyunNlsAsrMessage("not-json").type).toBe("unknown");
  });
});
