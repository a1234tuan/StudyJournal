import type { VoiceTeacherMessage } from "./contracts";

export const VOICE_TEACHER_MAX_MATERIAL_CHARACTERS = 6_000;
export const VOICE_TEACHER_MAX_RECORD_CHARACTERS = 1_200;
export const VOICE_TEACHER_HISTORY_TURNS = 10;
export const VOICE_CONVERSATION_PROMPT_VERSION = "voice-conversation-prompt@1.0";

export const VOICE_CONVERSATION_SYSTEM_PROMPT = [
  "你正在和用户进行一通语音电话。你说的每个字都会被转换成语音播放给对方，所以请像打电话一样自然说话。",
  "每次回复通常使用 1–3 句话，尽量控制在 50 字以内。内容较多时，先说最核心的一点；如果继续展开确实有帮助，可以先讲一小段，再询问对方是否继续。",
  "使用自然口语，不使用列表、Markdown 或格式化标题。遇到公式、数字、英文名称或符号时，用适合朗读的方式准确表达，不要机械朗读排版符号。",
  "默认先回应对方刚才表达的内容，再根据对话需要自然推进。可以在有助于理解、继续讨论或用户明确邀请时提问，但不要为了维持某种固定流程而提问。",
  "对方的话经过语音识别转写，可能存在同音字、断句或少量识别错误。能够根据上下文判断原意时，直接按合理原意回应；只有数字、名称或其他关键信息可能影响回答时，才向对方确认。",
  "示例：",
  "用户：我昨天看的傅里叶变换还是没太懂。",
  "你：你卡在哪一步？是不太理解它为什么能把时域变成频域吗？",
  "用户：对，就是这里。",
  "你：那我从一个直觉的比喻讲起，一次说一小段，你随时打断我。",
].join("\n\n");

export interface VoiceTeacherMaterial {
  title: string;
  text: string;
}

export interface VoiceTeacherTurn {
  confirmedText?: string;
  teacherText?: string;
  assistantText?: string;
  playedText?: string;
  pendingText?: string;
  playbackStatus?: import("./localTypes").VoicePlaybackStatus;
  systemGenerated?: boolean;
}

export const buildVoiceTeacherMessages = (input: {
  topic?: string;
  confirmedText?: string;
  materials?: readonly VoiceTeacherMaterial[];
  turns?: readonly VoiceTeacherTurn[];
  maxMaterialCharacters?: number;
}): VoiceTeacherMessage[] => {
  const maxMaterial = input.maxMaterialCharacters ?? VOICE_TEACHER_MAX_MATERIAL_CHARACTERS;

  const materialBlocks: string[] = [];
  let used = 0;
  for (const material of input.materials ?? []) {
    if (used >= maxMaterial) break;
    const text = material.text.trim().slice(0, Math.min(VOICE_TEACHER_MAX_RECORD_CHARACTERS, maxMaterial - used));
    if (!text) continue;
    used += text.length;
    materialBlocks.push(`《${material.title}》\n${text}`);
  }

  const inputTruncated = used < (input.materials ?? []).reduce((total, material) => total + material.text.trim().length, 0);
  const conversationContext = materialBlocks.length
    ? "背景：用户想围绕下面这段自己写的学习日志和你聊。它是对话素材，不是你必须逐条讲解的任务清单。"
    : input.topic?.trim()
      ? `当前通话主题：${input.topic.trim()}。\n主题只是对话的起点。如果用户聊到别处，跟着用户走，不要把话题拉回来。`
      : "";
  const messages: VoiceTeacherMessage[] = [{
    role: "system",
    content: [VOICE_CONVERSATION_SYSTEM_PROMPT, conversationContext].filter(Boolean).join("\n\n"),
    contentBoundary: "trusted-instruction",
  }];

  if (materialBlocks.length) {
    messages.push({
      role: "user",
      content: `【日志内容${inputTruncated ? "（已截断）" : ""}】\n${materialBlocks.join("\n\n")}`,
      contentBoundary: "untrusted-learning-content",
    });
  }

  for (const turn of (input.turns ?? []).slice(-VOICE_TEACHER_HISTORY_TURNS)) {
    if (turn.systemGenerated) continue;
    if (turn.confirmedText?.trim()) {
      messages.push({ role: "user", content: turn.confirmedText.trim(), contentBoundary: "user-utterance" });
    }
    const assistantText = (turn.playedText ?? turn.assistantText ?? turn.teacherText)?.trim();
    if (assistantText) {
      const playbackNote = turn.pendingText || ["pending", "interrupted", "failed", "truncated"].includes(turn.playbackStatus ?? "")
        ? "\n（上一条回复还有内容未播放）"
        : "";
      messages.push({ role: "assistant", content: assistantText + playbackNote });
    }
  }

  if (input.confirmedText?.trim()) {
    messages.push({ role: "user", content: input.confirmedText.trim(), contentBoundary: "user-utterance" });
  }
  return messages;
};
