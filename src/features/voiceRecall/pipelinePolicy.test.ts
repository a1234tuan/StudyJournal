import { describe, expect, it } from "vitest";

import type { AsrStreamAdapter, LlmStreamAdapter, LlmStreamRequest, TtsStreamAdapter } from "./contracts";
import { VoiceRecallPipeline } from "./pipeline";
import { formatVoiceTeacherControlledReply } from "./teacherProtocol";

const asr: AsrStreamAdapter = { profileId: "unused", async *transcribe() { yield { type: "completed" }; } };

class ScriptedLlm implements LlmStreamAdapter {
  readonly profileId = "scripted";
  calls: LlmStreamRequest[] = [];
  constructor(private readonly replies: string[]) {}
  async *complete(request: LlmStreamRequest) {
    this.calls.push(request);
    const reply = this.replies[Math.min(this.calls.length - 1, this.replies.length - 1)];
    for (const token of reply.match(/.{1,5}/gu) ?? []) yield { type: "token" as const, text: token };
    yield { type: "completed" as const };
  }
}

const respond = async (llm: LlmStreamAdapter, spoken: string[]) => {
  const tts: TtsStreamAdapter = {
    profileId: "collecting",
    async *synthesize(request) {
      spoken.push(request.text);
      yield { type: "completed" as const };
    },
  };
  const pipeline = new VoiceRecallPipeline(asr, llm, tts);
  return pipeline.respond({
    sessionId: "session",
    turnId: "turn",
    operationId: "operation",
    messages: [{ role: "system", content: "test", contentBoundary: "trusted-instruction" }],
    voice: "test",
    generation: 0,
    signal: new AbortController().signal,
    policy: {
      validateDecision: (decision) => decision.nextAction === "next-topic" ? undefined : "必须推进",
      fallback: {
        decision: { v: 1, assessment: "unclear", nextAction: "next-topic", topic: "降级主题" },
        spokenReply: "切换到降级主题。",
      },
    },
  });
};

describe("VoiceRecallPipeline teacher policy", () => {
  it("strips the control header before UI and TTS", async () => {
    const spoken: string[] = [];
    const llm = new ScriptedLlm([formatVoiceTeacherControlledReply({
      decision: { v: 1, assessment: "sufficient", nextAction: "next-topic", topic: "宏任务" },
      spokenReply: "很好。接着说说宏任务。",
    })]);
    const tokens: string[] = [];
    const result = await respond(llm, spoken);
    tokens.push(result.teacherText);
    expect(result.teacherText).toBe("很好。接着说说宏任务。");
    expect(spoken.join("")).toBe(result.teacherText);
    expect(`${tokens.join("")}${spoken.join("")}`).not.toContain("voice_control");
  });

  it("repairs once, then accepts a valid controlled reply", async () => {
    const spoken: string[] = [];
    const llm = new ScriptedLlm([
      "没有控制头的回复",
      formatVoiceTeacherControlledReply({
        decision: { v: 1, assessment: "sufficient", nextAction: "next-topic", topic: "微任务" },
        spokenReply: "改为讨论微任务。",
      }),
    ]);
    const result = await respond(llm, spoken);
    expect(llm.calls).toHaveLength(2);
    expect(llm.calls[1].messages.at(-1)?.content).toContain("上一回复未通过应用校验");
    expect(result.teacherText).toBe("改为讨论微任务。");
  });

  it("uses a deterministic fallback after one failed repair", async () => {
    const spoken: string[] = [];
    const llm = new ScriptedLlm(["无效一", "无效二"]);
    const result = await respond(llm, spoken);
    expect(llm.calls).toHaveLength(2);
    expect(result).toMatchObject({ teacherText: "切换到降级主题。", decision: { nextAction: "next-topic", topic: "降级主题" } });
    expect(spoken.join("")).toBe("切换到降级主题。");
  });
});
