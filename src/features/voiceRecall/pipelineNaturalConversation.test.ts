import { describe, expect, it } from "vitest";

import type { AsrStreamAdapter, LlmStreamAdapter, LlmStreamRequest, TtsStreamAdapter } from "./contracts";
import { VoiceRecallPipeline } from "./pipeline";

const asr: AsrStreamAdapter = { profileId: "unused", async *transcribe() { yield { type: "completed" }; } };

class ScriptedLlm implements LlmStreamAdapter {
  readonly profileId = "scripted";
  calls: LlmStreamRequest[] = [];
  constructor(private readonly reply: string) {}
  async *complete(request: LlmStreamRequest) {
    this.calls.push(request);
    for (const token of this.reply.match(/.{1,5}/gu) ?? []) yield { type: "token" as const, text: token };
    yield { type: "completed" as const };
  }
}

describe("VoiceRecallPipeline natural text response", () => {
  it("streams one plain-text LLM response directly to UI and TTS", async () => {
    const spoken: string[] = [];
    const llm = new ScriptedLlm("我听到了。你可以接着说。");
    const tts: TtsStreamAdapter = {
      profileId: "collecting",
      async *synthesize(request) {
        spoken.push(request.text);
        yield { type: "completed" as const };
      },
    };
    const pipeline = new VoiceRecallPipeline(asr, llm, tts);
    const result = await pipeline.respond({
      sessionId: "session",
      turnId: "turn",
      operationId: "operation",
      messages: [{ role: "system", content: "自然语音通话", contentBoundary: "trusted-instruction" }],
      voice: "test",
      generation: 0,
      signal: new AbortController().signal,
    });

    expect(llm.calls).toHaveLength(1);
    expect(result.teacherText).toBe("我听到了。你可以接着说。");
    expect(spoken.join("")).toBe(result.teacherText);
    expect(result).not.toHaveProperty("decision");
  });
});
