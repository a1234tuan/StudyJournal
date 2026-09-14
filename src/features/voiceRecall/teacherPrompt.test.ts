import { describe, expect, it, vi } from "vitest";

import {
  buildVoiceTeacherMessages,
  buildVoiceTeacherTurn,
  planVoiceMaterials,
  resolveVoiceMaterialBudget,
  resolveVoiceMaterialCharacterCap,
  VOICE_CONVERSATION_SYSTEM_PROMPT,
  VOICE_MATERIAL_ALLOCATION,
  VOICE_MATERIAL_WINDOW_RATIO,
  VOICE_TEACHER_HISTORY_TURNS,
  VOICE_TEACHER_MAX_MATERIAL_CHARACTERS,
  VOICE_TEACHER_MAX_RECORD_CHARACTERS,
} from "./teacherPrompt";
import { estimateAiTokens } from "../../lib/aiTokens";

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

  it("places neutral material context after the frozen prompt", () => {
    const messages = buildVoiceTeacherMessages({ topic: "不应覆盖材料模式", materials: [{ title: "超长笔记", nodes: ["x".repeat(20_000)] }] });
    expect(messages[0].content).toBe(`${FROZEN_SYSTEM_PROMPT}\n\n背景：用户想围绕下面这段自己写的学习日志和你聊。它是对话素材，不是你必须逐条讲解的任务清单。`);
    expect(messages[0].content).not.toContain("只依据学习资料提问");
    const material = messages.find((message) => message.contentBoundary === "untrusted-learning-content");
    expect(material).toBeDefined();
  });

  it("sends a record whole once it fits the context window, instead of stopping at a fixed character count", () => {
    const marker = "【这一步以前会被截断，现在必须完整送达】";
    const text = `${"前".repeat(3_500)}${marker}${"后".repeat(3_500)}`;

    const built = buildVoiceTeacherTurn({ materials: [{ title: "长日志", nodes: [text] }], contextWindowTokens: 65_536 });
    const material = built.messages.find((message) => message.contentBoundary === "untrusted-learning-content")!;

    expect(material.content).toContain(marker);
    expect(material.content).toContain(text);
    expect(built.materialPlan.stats.truncated).toBe(false);
    expect(material.content).toContain("【日志内容】");
    expect(material.content).not.toContain("不要假设已看全");
    expect(built.materialPlan.stats.sentChars).toBe(built.materialPlan.stats.totalChars);
    // The deprecated constants are retained but no longer applied.
    expect(VOICE_TEACHER_MAX_RECORD_CHARACTERS).toBe(1_200);
    expect(VOICE_TEACHER_MAX_MATERIAL_CHARACTERS).toBe(6_000);
    expect(text.length).toBeGreaterThan(VOICE_TEACHER_MAX_RECORD_CHARACTERS);
    expect(built.materialPlan.stats.sentChars).toBeGreaterThan(VOICE_TEACHER_MAX_MATERIAL_CHARACTERS);
  });

  it("D1: the material budget is the tighter of the remaining window and 70% of it", () => {
    // Large window: the 70% share binds, because the free remainder is larger.
    expect(resolveVoiceMaterialBudget({ contextWindowTokens: 65_536, fixedTokens: 1_000 }))
      .toBe(Math.floor(65_536 * VOICE_MATERIAL_WINDOW_RATIO));
    // Small window with heavy history: the free remainder binds instead of the 70% share.
    // Taking the minimum is what keeps real head-room at 8k instead of filling the window to its brim.
    const tight = resolveVoiceMaterialBudget({ contextWindowTokens: 8_192, fixedTokens: 2_000, outputReserveTokens: 224 });
    expect(tight).toBe(8_192 - 224 - 2_000 - 512);
    expect(tight).toBeLessThan(Math.floor(8_192 * VOICE_MATERIAL_WINDOW_RATIO));
    // A window already consumed by fixed parts yields no material rather than a negative number.
    expect(resolveVoiceMaterialBudget({ contextWindowTokens: 1_024, outputReserveTokens: 224, fixedTokens: 5_000 })).toBe(0);
  });

  it("D2: an over-limit record is truncated on a node boundary, declared, and warned about", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const text = "字".repeat(5_000);
      const built = buildVoiceTeacherTurn({ materials: [{ title: "长日志", nodes: [text] }], contextWindowTokens: 2_048 });
      const material = built.messages.find((message) => message.contentBoundary === "untrusted-learning-content")!;

      expect(built.materialPlan.stats.truncated).toBe(true);
      expect(built.materialPlan.stats.truncatedRecords).toBe(1);
      // The prompt states the exact shortfall instead of a bare "（已截断）".
      expect(material.content).toContain("【日志内容（本次发送 1/1 条");
      expect(material.content).toContain("未发送部分未提供，不要假设已看全");
      expect(material.content).toContain("本条内容过长，已截断");
      expect(built.materialPlan.stats.reasonCodes).toContain("budget");
      expect(built.materialPlan.stats.sentChars).toBeLessThan(text.length);
      // The derived character cap can never bind before the token budget, so the aggregate that
      // actually travels stays under it.
      expect(built.materialPlan.stats.sentChars).toBeLessThanOrEqual(built.materialCharacterCap);
      expect(built.materialCharacterCap).toBe(resolveVoiceMaterialCharacterCap(built.materialBudgetTokens));
    } finally {
      warn.mockRestore();
    }
  });

  it("truncates on a node boundary rather than cutting through a formula", () => {
    const nodes = [
      "第一段：题目背景说明。",
      "第二段：核心条件 $1 + \\square$ 的构造过程。",
      "第三段：代入求值的完整推导。",
      "第四段：最终答案与复盘。",
    ];
    const extra = "第五段：这一段很长，用于把预算吃满，从而触发截断。".repeat(40);
    const built = buildVoiceTeacherTurn({
      materials: [{ title: "日志", nodes: [...nodes, extra] }],
      contextWindowTokens: 2_048,
    });
    const material = built.messages.find((message) => message.contentBoundary === "untrusted-learning-content")!;

    expect(built.materialPlan.stats.truncated).toBe(true);
    // Whole segments are kept, so nothing is ever cut inside a formula.
    expect(material.content).toContain("$1 + \\square$");
    expect(material.content).toContain("代入求值的完整推导");
    // The oversized trailing segment is the one that gets cut.
    expect(material.content).not.toContain(extra);
  });

  it("D3: N equal records over a k×N budget are all truncated to about 1/k", () => {
    const unit = "这是一段学习日志正文，".repeat(100);
    const perRecord = estimateAiTokens(unit);

    const plan = planVoiceMaterials({
      materials: Array.from({ length: 8 }, (_, index) => ({ title: `日志 ${index + 1}`, nodes: [unit] })),
      materialBudgetTokens: perRecord * 2.5,
    });

    expect(plan.stats.allocation).toBe(VOICE_MATERIAL_ALLOCATION);
    expect(plan.stats.sentRecords).toBe(8);
    expect(plan.stats.truncatedRecords).toBe(8);
    // Equal share with unified recycle converges on 1/2.5 = 40%; the truncation marker and the
    // per-string overhead keep it a little below that.
    for (const block of plan.blocks) {
      const ratio = block.tokens / perRecord;
      expect(ratio).toBeGreaterThan(0.28);
      expect(ratio).toBeLessThan(0.42);
    }
  });

  it("D3: records that fit are kept whole and release their share to the oversized ones", () => {
    const small = "短".repeat(20);
    const plan = planVoiceMaterials({
      materials: [
        { title: "短日志", nodes: [small] },
        { title: "长日志", nodes: ["长".repeat(4_000)] },
      ],
      materialBudgetTokens: 2_000,
    });

    expect(plan.blocks.find((block) => block.title === "短日志")?.truncated).toBe(false);
    expect(plan.blocks.find((block) => block.title === "短日志")?.text).toBe(small);
    // The long record still receives far more than a naive half of the budget.
    expect(plan.blocks.find((block) => block.title === "长日志")?.tokens).toBeGreaterThan(1_000);
  });

  it("D3: drops records that cannot receive a usable share instead of looping forever", () => {
    const plan = planVoiceMaterials({
      materials: Array.from({ length: 40 }, (_, index) => ({ title: `日志 ${index}`, nodes: ["内容".repeat(400)] })),
      materialBudgetTokens: 100,
    });

    expect(plan.blocks).toEqual([]);
    expect(plan.stats.sentRecords).toBe(0);
    expect(plan.stats.droppedRecords).toHaveLength(40);
    expect(plan.stats.droppedRecords[0].reason).toBe("insufficient-share");
    expect(plan.stats.reasonCodes).toEqual(["insufficient-share"]);
    expect(plan.stats.reasons.join("")).toContain("篇幅不足");
  });

  it("D4: the plan is a pure function, so the call-details panel can recompute it on demand", () => {
    const input = {
      materials: [{ title: "甲", nodes: ["甲".repeat(400)] }, { title: "乙", nodes: ["乙".repeat(400)] }],
      materialBudgetTokens: 300,
    } as const;
    expect(planVoiceMaterials(input)).toEqual(planVoiceMaterials(input));
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
