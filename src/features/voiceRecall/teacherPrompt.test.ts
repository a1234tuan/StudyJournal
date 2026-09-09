import { describe, expect, it } from "vitest";

import { buildVoiceTeacherMessages, VOICE_TEACHER_MAX_MATERIAL_CHARACTERS } from "./teacherPrompt";

describe("buildVoiceTeacherMessages", () => {
  it("keeps voice replies short and asks for exactly one question", () => {
    const messages = buildVoiceTeacherMessages({ learningGoal: "复述事件循环" });
    const system = messages[0];
    expect(system.role).toBe("system");
    expect(system.contentBoundary).toBe("trusted-instruction");
    expect(system.content).toContain("不超过 80 个汉字");
    expect(system.content).toContain("只问一个问题");
    expect(system.content).toContain("复述事件循环");
  });

  it("marks learning material as untrusted and bounds the injected text", () => {
    const messages = buildVoiceTeacherMessages({
      learningGoal: "复述",
      materials: [{ title: "超长笔记", text: "x".repeat(20_000) }],
    });
    const material = messages.find((message) => message.contentBoundary === "untrusted-learning-content");
    expect(material).toBeDefined();
    expect(material!.content.length).toBeLessThanOrEqual(VOICE_TEACHER_MAX_MATERIAL_CHARACTERS + 60);
  });

  it("carries only the most recent turns as context", () => {
    const turns = Array.from({ length: 6 }, (_, index) => ({
      confirmedText: `回答 ${index}`,
      teacherText: `反馈 ${index}`,
    }));
    const messages = buildVoiceTeacherMessages({ learningGoal: "复述", turns });
    const texts = messages.map((message) => message.content);
    expect(texts).toContain("回答 3");
    expect(texts).not.toContain("回答 2");
    expect(texts.at(-1)).toBe("反馈 5");
  });

  it("switches to a strict boundary when requested", () => {
    const messages = buildVoiceTeacherMessages({ learningGoal: "复述", knowledgeBoundary: "strict" });
    expect(messages[0].content).toContain("只依据学习资料提问");
  });
});
