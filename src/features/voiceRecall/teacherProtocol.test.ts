import { describe, expect, it } from "vitest";

import { VoiceTeacherStreamParser, formatVoiceTeacherControlledReply, parseVoiceTeacherDecision } from "./teacherProtocol";

describe("voice teacher control protocol", () => {
  it("parses a versioned decision and bounds optional memory fields", () => {
    expect(parseVoiceTeacherDecision(JSON.stringify({
      v: 1,
      assessment: "partial",
      nextAction: "follow-up",
      topic: " 调用栈 ",
      note: "缺少出栈条件",
      topicPlan: ["调用栈", "调用栈", "宏任务"],
    }))).toEqual({
      v: 1,
      assessment: "partial",
      nextAction: "follow-up",
      topic: "调用栈",
      note: "缺少出栈条件",
      topicPlan: ["调用栈", "宏任务"],
    });
  });

  it("holds a fragmented control header and emits only the spoken reply", () => {
    const encoded = formatVoiceTeacherControlledReply({
      decision: { v: 1, assessment: "sufficient", nextAction: "next-topic", topic: "宏任务" },
      spokenReply: "很好。接着说说宏任务。",
    });
    const parser = new VoiceTeacherStreamParser();
    let spoken = "";
    for (const token of encoded.match(/.{1,4}/gu) ?? []) spoken += parser.push(token);
    expect(parser.finish()).toEqual({ decision: { v: 1, assessment: "sufficient", nextAction: "next-topic", topic: "宏任务", note: undefined, topicPlan: undefined } });
    expect(spoken).toBe("很好。接着说说宏任务。");
    expect(spoken).not.toContain("voice_control");
  });

  it("rejects missing and invalid control headers", () => {
    const missing = new VoiceTeacherStreamParser();
    expect(missing.push("普通回复")).toBe("");
    expect(missing.finish().error).toContain("缺少");

    const invalid = new VoiceTeacherStreamParser();
    invalid.push('<voice_control>{"v":2}</voice_control>正文');
    expect(invalid.finish().error).toContain("无效");
  });
});
