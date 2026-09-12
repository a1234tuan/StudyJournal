import { describe, expect, it } from "vitest";

import {
  applyVoiceTeacherDecision,
  createVoiceTeacherFallback,
  deriveVoiceRecallTopicSeeds,
  detectVoiceUserControl,
  validateVoiceTeacherDecision,
  type VoiceTeacherPolicyContext,
} from "./dialoguePolicy";
import type { VoiceRecallStructuredMemory } from "./localTypes";

const memory = (patch: Partial<VoiceRecallStructuredMemory> = {}): VoiceRecallStructuredMemory => ({
  learningGoal: "复述事件循环",
  coveredPoints: [],
  misconceptions: [],
  pendingTopics: ["宏任务", "微任务"],
  currentTopic: "调用栈",
  currentTopicFollowUpCount: 0,
  currentQuestion: "调用栈如何影响任务执行？",
  ...patch,
});

const context = (patch: Partial<VoiceTeacherPolicyContext> = {}): VoiceTeacherPolicyContext => ({
  stage: "turn",
  memory: memory(),
  userControl: { kind: "none" },
  allowExternalTopic: true,
  ...patch,
});

describe("voice recall user controls", () => {
  it.each([
    ["结束", { kind: "stop" }],
    ["结束会话", { kind: "stop" }],
    ["这次先到这里吧", { kind: "stop" }],
    ["跳过", { kind: "skip" }],
    ["跳过这个问题", { kind: "skip" }],
    ["下一个知识点", { kind: "skip" }],
    ["换个知识点", { kind: "switch" }],
    ["换到微任务吧", { kind: "switch", target: "微任务" }],
  ])("detects the explicit control %s", (utterance, expected) => {
    expect(detectVoiceUserControl(utterance)).toEqual(expected);
  });

  it.each(["这个算法的结束条件是什么", "下一步是清空调用栈", "停止条件由计数器决定"]) (
    "does not treat ordinary learning content as a command: %s",
    (utterance) => expect(detectVoiceUserControl(utterance)).toEqual({ kind: "none" }),
  );
});

describe("voice teacher progression policy", () => {
  it("permits one focused follow-up for partial, incorrect, or unclear answers", () => {
    for (const assessment of ["partial", "incorrect", "unclear"] as const) {
      expect(validateVoiceTeacherDecision(
        { v: 1, assessment, nextAction: "follow-up", topic: "调用栈" },
        context(),
      )).toBeUndefined();
    }
  });

  it("advances sufficient answers and finishes after the final topic", () => {
    expect(validateVoiceTeacherDecision(
      { v: 1, assessment: "sufficient", nextAction: "next-topic", topic: "宏任务" },
      context(),
    )).toBeUndefined();
    expect(validateVoiceTeacherDecision(
      { v: 1, assessment: "sufficient", nextAction: "finish" },
      context({ memory: memory({ pendingTopics: [] }) }),
    )).toBeUndefined();
  });

  it("forces progression after the current topic has already been followed up once", () => {
    const bounded = context({ memory: memory({ currentTopicFollowUpCount: 1 }) });
    expect(validateVoiceTeacherDecision(
      { v: 1, assessment: "incorrect", nextAction: "follow-up", topic: "调用栈" },
      bounded,
    )).toContain("next-topic");
    expect(validateVoiceTeacherDecision(
      { v: 1, assessment: "incorrect", nextAction: "next-topic", topic: "宏任务" },
      bounded,
    )).toBeUndefined();
  });

  it("forces switch, skip, and stop controls ahead of model-selected follow-ups", () => {
    const switching = context({ userControl: { kind: "switch" } });
    expect(validateVoiceTeacherDecision(
      { v: 1, assessment: "incorrect", nextAction: "follow-up", topic: "调用栈" },
      switching,
    )).toContain("必须进入另一个");
    expect(validateVoiceTeacherDecision(
      { v: 1, assessment: "incorrect", nextAction: "next-topic", topic: "宏任务" },
      switching,
    )).toBeUndefined();
    expect(validateVoiceTeacherDecision(
      { v: 1, assessment: "incorrect", nextAction: "next-topic", topic: "微任务" },
      context({ userControl: { kind: "switch", target: "宏任务" } }),
    )).toContain("指定了主题");
    expect(validateVoiceTeacherDecision(
      { v: 1, assessment: "incorrect", nextAction: "next-topic", topic: "宏任务" },
      context({ userControl: { kind: "switch", target: "宏任务" } }),
    )).toBeUndefined();
    expect(validateVoiceTeacherDecision(
      { v: 1, assessment: "incorrect", nextAction: "finish" },
      context({ userControl: { kind: "stop" } }),
    )).toBeUndefined();
  });

  it("updates bounded memory and rotates an explicitly switched topic to the queue", () => {
    const switched = applyVoiceTeacherDecision(memory(), {
      decision: { v: 1, assessment: "unclear", nextAction: "next-topic", topic: "宏任务" },
      spokenReply: "换到宏任务。它何时进入队列？",
    }, { kind: "switch" });
    expect(switched).toMatchObject({ currentTopic: "宏任务", currentTopicFollowUpCount: 0 });
    expect(switched.pendingTopics).toContain("调用栈");

    const followed = applyVoiceTeacherDecision(memory(), {
      decision: { v: 1, assessment: "partial", nextAction: "follow-up", topic: "调用栈", note: "缺少出栈条件" },
      spokenReply: "还缺少出栈条件。什么时候出栈？",
    }, { kind: "none" });
    expect(followed).toMatchObject({ currentTopicFollowUpCount: 1, nextQuestionPurpose: "缺少出栈条件" });
  });

  it("creates deterministic progression and completion fallbacks", () => {
    const next = createVoiceTeacherFallback(context({ memory: memory({ currentTopicFollowUpCount: 1 }) }));
    expect(next.decision).toMatchObject({ nextAction: "next-topic", topic: "宏任务" });
    const done = createVoiceTeacherFallback(context({ memory: memory({ currentTopicFollowUpCount: 1, pendingTopics: [] }) }));
    expect(done.decision.nextAction).toBe("finish");
    expect(done.spokenReply).not.toContain("？");
  });

  it("accepts a material-derived opening plan even under a strict knowledge boundary", () => {
    const strictContext = context({ stage: "opening", allowExternalTopic: false, allowGeneratedTopicPlan: true, memory: memory({ pendingTopics: ["材料标题"] }) });
    const reply = {
      decision: { v: 1 as const, assessment: "opening" as const, nextAction: "next-topic" as const, topic: "材料结构", topicPlan: ["材料结构", "关键关系"] },
      spokenReply: "先说说材料结构。",
    };
    expect(validateVoiceTeacherDecision(
      reply.decision,
      strictContext,
    )).toBeUndefined();
    expect(applyVoiceTeacherDecision(strictContext.memory, reply, { kind: "none" }, strictContext.allowExternalTopic, strictContext.allowGeneratedTopicPlan).pendingTopics).toEqual(["关键关系"]);
  });

  it("does not fall back to the current topic when a switch target repeats it", () => {
    const switched = createVoiceTeacherFallback(context({
      userControl: { kind: "switch", target: "调用栈" },
      memory: memory({ pendingTopics: ["宏任务"] }),
    }));
    expect(switched.decision).toMatchObject({ nextAction: "next-topic", topic: "宏任务" });
  });
});

it("derives at most six stable topic seeds from record structure", () => {
  expect(deriveVoiceRecallTopicSeeds({
    records: [{ title: "事件循环", contentHtml: "<h2>调用栈</h2><h2>宏任务</h2><h2>微任务</h2>" }],
  })).toEqual(["调用栈", "宏任务", "微任务", "事件循环"]);
  expect(deriveVoiceRecallTopicSeeds({ topic: "自由主题" })).toEqual(["自由主题"]);
});
