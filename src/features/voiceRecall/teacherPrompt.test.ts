import { describe, expect, it } from "vitest";

import {
  buildVoiceTeacherMessages,
  VOICE_CONVERSATION_SYSTEM_PROMPT,
  VOICE_TEACHER_HISTORY_TURNS,
  VOICE_TEACHER_MAX_MATERIAL_CHARACTERS,
} from "./teacherPrompt";

const FROZEN_SYSTEM_PROMPT = `你正在和用户进行一通语音电话。你说的每个字都会被转换成语音播放给对方，所以请像打电话一样自然说话。

每次回复通常使用 1–3 句话，尽量控制在 50 字以内。内容较多时，先说最核心的一点；如果继续展开确实有帮助，可以先讲一小段，再询问对方是否继续。

使用自然口语，不使用列表、Markdown 或格式化标题。遇到公式、数字、英文名称或符号时，用适合朗读的方式准确表达，不要机械朗读排版符号。

默认先回应对方刚才表达的内容，再根据对话需要自然推进。可以在有助于理解、继续讨论或用户明确邀请时提问，但不要为了维持某种固定流程而提问。

对方的话经过语音识别转写，可能存在同音字、断句或少量识别错误。能够根据上下文判断原意时，直接按合理原意回应；只有数字、名称或其他关键信息可能影响回答时，才向对方确认。

示例：

用户：我昨天看的傅里叶变换还是没太懂。

你：你卡在哪一步？是不太理解它为什么能把时域变成频域吗？

用户：对，就是这里。

你：那我从一个直觉的比喻讲起，一次说一小段，你随时打断我。`;

const FORBIDDEN_LEGACY_PROTOCOL_TEXT = [
  "<voice_control>", "nextAction", "opening", "follow-up", "next-topic", "教学状态", "知识点计划", "必须提出第一问",
];

describe("buildVoiceTeacherMessages", () => {
  it("matches the frozen system prompt exactly and contains no legacy protocol", () => {
    expect(VOICE_CONVERSATION_SYSTEM_PROMPT).toBe(FROZEN_SYSTEM_PROMPT);
    const system = buildVoiceTeacherMessages({})[0];
    expect(system).toEqual({ role: "system", content: FROZEN_SYSTEM_PROMPT, contentBoundary: "trusted-instruction" });
    for (const token of FORBIDDEN_LEGACY_PROTOCOL_TEXT) expect(system.content).not.toContain(token);
  });

  it("places neutral material context after the frozen prompt and bounds untrusted text", () => {
    const messages = buildVoiceTeacherMessages({ topic: "不应覆盖材料模式", materials: [{ title: "超长笔记", text: "x".repeat(20_000) }] });
    expect(messages[0].content).toBe(`${FROZEN_SYSTEM_PROMPT}\n\n背景：用户想围绕下面这段自己写的学习日志和你聊。它是对话素材，不是你必须逐条讲解的任务清单。`);
    expect(messages[0].content).not.toContain("只依据学习资料提问");
    const material = messages.find((message) => message.contentBoundary === "untrusted-learning-content");
    expect(material).toBeDefined();
    expect(material!.content.length).toBeLessThanOrEqual(VOICE_TEACHER_MAX_MATERIAL_CHARACTERS + 60);
  });

  it("uses a free topic only as a starting point and omits an empty topic", () => {
    const topicSystem = buildVoiceTeacherMessages({ topic: "事件循环" })[0].content;
    expect(topicSystem).toContain("当前通话主题：事件循环。");
    expect(topicSystem).toContain("如果用户聊到别处，跟着用户走，不要把话题拉回来。");
    expect(buildVoiceTeacherMessages({ topic: "   " })[0].content).toBe(FROZEN_SYSTEM_PROMPT);
  });

  it("keeps the latest ten turns in chronological order and excludes system-generated turns", () => {
    const turns = Array.from({ length: 12 }, (_, index) => ({ confirmedText: `用户 ${index}`, assistantText: `AI ${index}`, systemGenerated: index === 10 }));
    const messages = buildVoiceTeacherMessages({ turns, confirmedText: "当前发言" });
    const contents = messages.map((message) => message.content);
    expect(VOICE_TEACHER_HISTORY_TURNS).toBe(10);
    expect(contents).not.toContain("用户 0");
    expect(contents).not.toContain("用户 1");
    expect(contents).not.toContain("用户 10");
    expect(contents.indexOf("用户 2")).toBeLessThan(contents.indexOf("AI 2"));
    expect(messages.at(-1)).toEqual({ role: "user", content: "当前发言", contentBoundary: "user-utterance" });
  });

  it("uses only played assistant text and marks withheld playback internally", () => {
    const messages = buildVoiceTeacherMessages({ turns: [{ confirmedText: "继续", assistantText: "完整回复不应进入上下文", playedText: "已播放部分", pendingText: "未播放部分", playbackStatus: "interrupted" }] });
    expect(messages.at(-1)?.content).toBe("已播放部分\n（上一条回复还有内容未播放）");
    expect(messages.some((message) => message.content.includes("完整回复不应进入上下文"))).toBe(false);
  });
});
