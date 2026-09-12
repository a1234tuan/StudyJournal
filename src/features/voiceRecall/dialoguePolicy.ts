import type { VoiceRecallStructuredMemory } from "./localTypes";
import type { VoiceTeacherControlledReply, VoiceTeacherDecision } from "./teacherProtocol";

export type VoiceUserControl =
  | { kind: "none" }
  | { kind: "stop" }
  | { kind: "skip" }
  | { kind: "switch"; target?: string };

export interface VoiceTeacherPolicyContext {
  stage: "opening" | "turn";
  memory: VoiceRecallStructuredMemory;
  userControl: VoiceUserControl;
  allowExternalTopic: boolean;
  allowGeneratedTopicPlan?: boolean;
}

const MAX_MEMORY_ITEMS = 12;
const MAX_TOPIC_CHARACTERS = 48;

const normalizedKey = (value: string) => value.replace(/[\s，。！？!?、；;：“”‘’"']/g, "").toLocaleLowerCase();

export const normalizeVoiceTopics = (values: readonly string[], maximum = 6): string[] => {
  const topics: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    const topic = value.replace(/\s+/g, " ").trim().slice(0, MAX_TOPIC_CHARACTERS);
    const key = normalizedKey(topic);
    if (!topic || !key || seen.has(key)) continue;
    seen.add(key);
    topics.push(topic);
    if (topics.length >= maximum) break;
  }
  return topics;
};

export const detectVoiceUserControl = (input: string): VoiceUserControl => {
  const text = input.trim().replace(/[。！？!?]+$/g, "").trim();
  const compact = text.replace(/\s+/g, "");
  if (/^(?:请)?(?:结束|停止)(?:(?:本次|这次))?(?:复述|练习|通话|会话)?(?:吧|了)?$/.test(compact) || /^(?:今天|这次)?(?:就)?先到这里(?:吧)?$/.test(compact) || /^不(?:想)?练了$/.test(compact)) {
    return { kind: "stop" };
  }

  const target = /^(?:请)?(?:换到|切换到|改聊|聊聊)(.+?)(?:吧)?$/.exec(compact)?.[1]?.trim();
  if (target) return { kind: "switch", target: target.slice(0, MAX_TOPIC_CHARACTERS) };
  if (/^(?:请)?(?:换一个|换个|切换)(?:问题|知识点|话题)(?:吧)?$/.test(compact)) return { kind: "switch" };
  if (/^(?:请)?(?:(?:这个|这道)(?:问题|知识点|话题))?(?:先)?(?:跳过|略过)(?:吧)?$/.test(compact)
    || /^(?:请)?(?:先)?(?:跳过|略过)(?:(?:这个|这道)(?:问题|知识点|话题))?(?:吧)?$/.test(compact)
    || /^(?:请)?下一个(?:问题|知识点|话题)?(?:吧)?$/.test(compact)) {
    return { kind: "skip" };
  }
  return { kind: "none" };
};

const extractHeadingText = (contentHtml: string): string[] => {
  if (typeof DOMParser === "undefined") return [];
  const doc = new DOMParser().parseFromString(contentHtml, "text/html");
  return Array.from(doc.querySelectorAll("h1, h2, h3, record-collapse[data-title], record-decision-block[data-title], record-structure-diagram[data-title], record-comparison-table[data-title], record-sticky-board[data-title]"))
    .map((node) => node.getAttribute("data-title") ?? node.textContent ?? "")
    .map((value) => value.trim())
    .filter(Boolean);
};

export const deriveVoiceRecallTopicSeeds = (input: {
  topic?: string;
  learningGoal?: string;
  records?: readonly { title: string; contentHtml: string }[];
}): string[] => {
  if (input.topic?.trim()) return normalizeVoiceTopics([input.topic]);
  const records = input.records ?? [];
  const values = records.length === 1
    ? [...extractHeadingText(records[0].contentHtml), records[0].title]
    : records.flatMap((record) => [record.title, ...extractHeadingText(record.contentHtml)]);
  const topics = normalizeVoiceTopics(values);
  return topics.length ? topics : normalizeVoiceTopics([input.learningGoal ?? "本次学习内容"]);
};

const hasTopic = (topics: readonly string[], target?: string): boolean => {
  if (!target) return false;
  const key = normalizedKey(target);
  return topics.some((topic) => normalizedKey(topic) === key);
};

const availableTopics = (context: VoiceTeacherPolicyContext, decision?: VoiceTeacherDecision): string[] => {
  if (context.stage === "opening") {
    return normalizeVoiceTopics(context.allowGeneratedTopicPlan !== false && decision?.topicPlan?.length ? decision.topicPlan : context.memory.pendingTopics);
  }
  if (context.userControl.kind === "switch" && context.userControl.target && context.allowExternalTopic) {
    return normalizeVoiceTopics([context.userControl.target, ...context.memory.pendingTopics]);
  }
  return normalizeVoiceTopics(context.memory.pendingTopics);
};

export const validateVoiceTeacherDecision = (decision: VoiceTeacherDecision, context: VoiceTeacherPolicyContext): string | undefined => {
  const topics = availableTopics(context, decision);
  if (context.stage === "opening") {
    if (decision.assessment !== "opening" || decision.nextAction !== "next-topic") return "开场必须选择一个知识点并提出第一问";
    if (!decision.topic || !hasTopic(topics, decision.topic)) return "开场知识点必须来自本次知识点计划";
    return undefined;
  }

  if (context.userControl.kind === "stop") return decision.nextAction === "finish" ? undefined : "结束指令必须立即停止追问";
  if (context.userControl.kind === "skip" || context.userControl.kind === "switch") {
    if (!topics.length) return decision.nextAction === "finish" ? undefined : "没有可切换的知识点时应结束当前教学轮次";
    if (decision.nextAction !== "next-topic" || !decision.topic || !hasTopic(topics, decision.topic)) return "切换或跳过后必须进入另一个可用知识点";
    if (context.memory.currentTopic && normalizedKey(decision.topic) === normalizedKey(context.memory.currentTopic)) return "切换后不能继续原知识点";
    if (context.userControl.kind === "switch" && context.userControl.target && context.allowExternalTopic
      && normalizedKey(decision.topic) !== normalizedKey(context.userControl.target)) return "用户指定了主题，必须优先切换到该主题";
    return undefined;
  }

  const needsFollowUp = decision.assessment !== "sufficient" && (context.memory.currentTopicFollowUpCount ?? 0) < 1;
  const expectedAction = needsFollowUp ? "follow-up" : topics.length ? "next-topic" : "finish";
  if (decision.nextAction !== expectedAction) return `当前回答应执行 ${expectedAction}`;
  if (expectedAction === "follow-up" && (!decision.topic || normalizedKey(decision.topic) !== normalizedKey(context.memory.currentTopic ?? ""))) {
    return "追问必须保持在当前知识点";
  }
  if (expectedAction === "next-topic" && (!decision.topic || !hasTopic(topics, decision.topic))) return "下一问必须来自待讨论知识点";
  return undefined;
};

const pickNextTopic = (context: VoiceTeacherPolicyContext): string | undefined => {
  const target = context.userControl.kind === "switch" ? context.userControl.target : undefined;
  if (target && context.allowExternalTopic && normalizedKey(target) !== normalizedKey(context.memory.currentTopic ?? "")) return target;
  return context.memory.pendingTopics[0];
};

export const createVoiceTeacherFallback = (context: VoiceTeacherPolicyContext): VoiceTeacherControlledReply => {
  if (context.stage === "opening") {
    const topic = context.memory.pendingTopics[0] ?? "本次学习内容";
    return {
      decision: { v: 1, assessment: "opening", nextAction: "next-topic", topic, topicPlan: context.memory.pendingTopics },
      spokenReply: `先不看笔记，说说你对“${topic}”的整体理解。`,
    };
  }
  if (context.userControl.kind === "stop") {
    return { decision: { v: 1, assessment: "unclear", nextAction: "finish" }, spokenReply: "好，本次复述先到这里。" };
  }
  const nextTopic = pickNextTopic(context);
  if (context.userControl.kind === "skip" || context.userControl.kind === "switch" || (context.memory.currentTopicFollowUpCount ?? 0) >= 1) {
    return nextTopic
      ? { decision: { v: 1, assessment: "unclear", nextAction: "next-topic", topic: nextTopic }, spokenReply: `先换到“${nextTopic}”。说说你对它的整体理解。` }
      : { decision: { v: 1, assessment: "unclear", nextAction: "finish" }, spokenReply: "主要内容已经覆盖，本次复述可以先到这里。" };
  }
  const topic = context.memory.currentTopic ?? "这个知识点";
  return {
    decision: { v: 1, assessment: "unclear", nextAction: "follow-up", topic },
    spokenReply: `请再用一句话说明“${topic}”最关键的因果关系。`,
  };
};

const appendBounded = (values: readonly string[] | undefined, value?: string): string[] =>
  normalizeVoiceTopics([...(values ?? []), ...(value ? [value] : [])], MAX_MEMORY_ITEMS);

const removeTopic = (topics: readonly string[], topic?: string): string[] => {
  if (!topic) return [...topics];
  const key = normalizedKey(topic);
  return topics.filter((item) => normalizedKey(item) !== key);
};

export const applyVoiceTeacherDecision = (
  memory: VoiceRecallStructuredMemory,
  reply: VoiceTeacherControlledReply,
  userControl: VoiceUserControl,
  allowExternalTopic = true,
  allowGeneratedTopicPlan = allowExternalTopic,
): VoiceRecallStructuredMemory => {
  const { decision, spokenReply } = reply;
  if (decision.assessment === "opening") {
    const planned = normalizeVoiceTopics(allowGeneratedTopicPlan && decision.topicPlan?.length ? decision.topicPlan : memory.pendingTopics);
    const currentTopic = decision.topic ?? planned[0];
    return {
      ...memory,
      currentTopic,
      currentTopicFollowUpCount: 0,
      currentQuestion: spokenReply,
      pendingTopics: removeTopic(planned, currentTopic),
      nextQuestionPurpose: "建立整体回忆",
      completionReason: undefined,
    };
  }

  let pendingTopics = [...memory.pendingTopics];
  let coveredPoints = [...memory.coveredPoints];
  let misconceptions = [...memory.misconceptions];
  let unresolvedPoints = [...(memory.unresolvedPoints ?? [])];
  let skippedPoints = [...(memory.skippedPoints ?? [])];
  const previousTopic = memory.currentTopic;

  if (userControl.kind === "skip") skippedPoints = appendBounded(skippedPoints, previousTopic);
  if (userControl.kind === "switch" && previousTopic) pendingTopics = appendBounded(pendingTopics, previousTopic);
  if (userControl.kind === "switch" && userControl.target && allowExternalTopic) pendingTopics = appendBounded([userControl.target, ...pendingTopics]);

  if (userControl.kind === "none" && previousTopic) {
    if (decision.assessment === "sufficient") coveredPoints = appendBounded(coveredPoints, previousTopic);
    if (decision.nextAction !== "follow-up" && decision.assessment === "incorrect") {
      misconceptions = appendBounded(misconceptions, decision.note ? `${previousTopic}：${decision.note}` : previousTopic);
    }
    if (decision.nextAction !== "follow-up" && (decision.assessment === "partial" || decision.assessment === "unclear")) {
      unresolvedPoints = appendBounded(unresolvedPoints, decision.note ? `${previousTopic}：${decision.note}` : previousTopic);
    }
  }

  if (decision.nextAction === "follow-up") {
    return {
      ...memory,
      coveredPoints,
      misconceptions,
      unresolvedPoints,
      skippedPoints,
      currentTopicFollowUpCount: (memory.currentTopicFollowUpCount ?? 0) + 1,
      currentQuestion: spokenReply,
      nextQuestionPurpose: decision.note ?? "补齐一个关键缺口",
      completionReason: undefined,
    };
  }

  if (decision.nextAction === "next-topic") {
    const currentTopic = decision.topic;
    pendingTopics = removeTopic(pendingTopics, currentTopic);
    return {
      ...memory,
      coveredPoints,
      misconceptions,
      unresolvedPoints,
      skippedPoints,
      pendingTopics,
      currentTopic,
      currentTopicFollowUpCount: 0,
      currentQuestion: spokenReply,
      nextQuestionPurpose: "推进到下一个知识点",
      completionReason: undefined,
    };
  }

  return {
    ...memory,
    coveredPoints,
    misconceptions,
    unresolvedPoints,
    skippedPoints,
    currentQuestion: undefined,
    nextQuestionPurpose: undefined,
    completionReason: userControl.kind === "stop" ? "user-requested" : "covered",
  };
};
