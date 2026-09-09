import { describe, expect, it } from "vitest";

import { buildAliyunFinishTask, buildAliyunRunTask, parseAliyunAsrMessage } from "./aliyunAsrProtocol";

describe("Aliyun Paraformer wire protocol", () => {
  it("builds a run-task frame with the configured model and format", () => {
    const frame = JSON.parse(buildAliyunRunTask("task-1", { model: "paraformer-realtime-v2", sampleRate: 16_000, format: "pcm", punctuation: true }));
    expect(frame).toEqual({
      header: { action: "run-task", task_id: "task-1", streaming: "duplex" },
      payload: {
        task_group: "audio",
        task: "asr",
        function: "recognition",
        model: "paraformer-realtime-v2",
        parameters: { format: "pcm", sample_rate: 16_000, punctuation_prediction_enabled: true },
        input: {},
      },
    });
  });

  it("builds a finish-task frame", () => {
    expect(JSON.parse(buildAliyunFinishTask("task-1")).header).toEqual({ action: "finish-task", task_id: "task-1", streaming: "duplex" });
  });

  it("maps every server event the live service sends", () => {
    expect(parseAliyunAsrMessage(JSON.stringify({ header: { event: "task-started" } }))).toEqual({ type: "started" });
    expect(parseAliyunAsrMessage(JSON.stringify({ header: { event: "task-finished" } }))).toEqual({ type: "completed" });
    expect(parseAliyunAsrMessage(JSON.stringify({
      header: { event: "result-generated" },
      payload: { output: { sentence: { text: "间隔", sentence_end: false } } },
    }))).toEqual({ type: "partial", text: "间隔" });
    expect(parseAliyunAsrMessage(JSON.stringify({
      header: { event: "result-generated" },
      payload: { output: { sentence: { text: "间隔复习为什么有效？", sentence_end: true } } },
    }))).toEqual({ type: "final", text: "间隔复习为什么有效？" });
    expect(parseAliyunAsrMessage(JSON.stringify({
      header: { event: "task-failed", error_message: "invalid api key" },
    }))).toEqual({ type: "failed", message: "invalid api key" });
  });

  it("tolerates the camelCase sentence flag and malformed frames", () => {
    expect(parseAliyunAsrMessage(JSON.stringify({
      header: { event: "result-generated" },
      payload: { output: { sentence: { text: "结束", sentenceEnd: true } } },
    }))).toEqual({ type: "final", text: "结束" });
    expect(parseAliyunAsrMessage("not json").type).toBe("unknown");
    expect(parseAliyunAsrMessage(JSON.stringify({ header: { event: "result-generated" }, payload: {} })).type).toBe("unknown");
  });
});
