export type VoiceTeacherAssessment = "opening" | "sufficient" | "partial" | "incorrect" | "unclear";

export type VoiceTeacherNextAction = "follow-up" | "next-topic" | "finish";

export interface VoiceTeacherDecision {
  v: 1;
  assessment: VoiceTeacherAssessment;
  nextAction: VoiceTeacherNextAction;
  topic?: string;
  note?: string;
  topicPlan?: string[];
}

export interface VoiceTeacherControlledReply {
  decision: VoiceTeacherDecision;
  spokenReply: string;
}

export const VOICE_TEACHER_CONTROL_OPEN = "<voice_control>";
export const VOICE_TEACHER_CONTROL_CLOSE = "</voice_control>";
const MAX_CONTROL_CHARACTERS = 1_200;
const MAX_TOPIC_CHARACTERS = 48;
const MAX_NOTE_CHARACTERS = 80;
const MAX_TOPICS = 6;

const assessments = new Set<VoiceTeacherAssessment>(["opening", "sufficient", "partial", "incorrect", "unclear"]);
const actions = new Set<VoiceTeacherNextAction>(["follow-up", "next-topic", "finish"]);

const cleanText = (value: unknown, maximum: number): string | undefined => {
  if (typeof value !== "string") return undefined;
  const cleaned = value.replace(/\s+/g, " ").trim().slice(0, maximum);
  return cleaned || undefined;
};

const cleanTopics = (value: unknown): string[] | undefined => {
  if (!Array.isArray(value)) return undefined;
  const seen = new Set<string>();
  const topics: string[] = [];
  for (const item of value) {
    const topic = cleanText(item, MAX_TOPIC_CHARACTERS);
    const key = topic?.toLocaleLowerCase();
    if (!topic || !key || seen.has(key)) continue;
    seen.add(key);
    topics.push(topic);
    if (topics.length >= MAX_TOPICS) break;
  }
  return topics.length ? topics : undefined;
};

export const parseVoiceTeacherDecision = (value: string): VoiceTeacherDecision | undefined => {
  try {
    const parsed = JSON.parse(value) as Record<string, unknown>;
    if (parsed.v !== 1 || !assessments.has(parsed.assessment as VoiceTeacherAssessment) || !actions.has(parsed.nextAction as VoiceTeacherNextAction)) {
      return undefined;
    }
    return {
      v: 1,
      assessment: parsed.assessment as VoiceTeacherAssessment,
      nextAction: parsed.nextAction as VoiceTeacherNextAction,
      topic: cleanText(parsed.topic, MAX_TOPIC_CHARACTERS),
      note: cleanText(parsed.note, MAX_NOTE_CHARACTERS),
      topicPlan: cleanTopics(parsed.topicPlan),
    };
  } catch {
    return undefined;
  }
};

export const formatVoiceTeacherControlledReply = ({ decision, spokenReply }: VoiceTeacherControlledReply): string =>
  `${VOICE_TEACHER_CONTROL_OPEN}${JSON.stringify(decision)}${VOICE_TEACHER_CONTROL_CLOSE}\n${spokenReply.trim()}`;

export class VoiceTeacherStreamParser {
  private buffer = "";
  private resolved = false;
  private invalidReason?: string;
  decision?: VoiceTeacherDecision;

  push(token: string): string {
    if (this.resolved) return token;
    if (this.invalidReason) return "";
    this.buffer += token;
    const candidate = this.buffer.trimStart();
    if (!candidate) return "";

    if (!VOICE_TEACHER_CONTROL_OPEN.startsWith(candidate) && !candidate.startsWith(VOICE_TEACHER_CONTROL_OPEN)) {
      this.invalidReason = "缺少语音教学控制头";
      return "";
    }
    if (candidate.length > MAX_CONTROL_CHARACTERS && !candidate.includes(VOICE_TEACHER_CONTROL_CLOSE)) {
      this.invalidReason = "语音教学控制头过长";
      return "";
    }

    const closeIndex = candidate.indexOf(VOICE_TEACHER_CONTROL_CLOSE);
    if (closeIndex < 0) return "";
    const json = candidate.slice(VOICE_TEACHER_CONTROL_OPEN.length, closeIndex);
    const decision = parseVoiceTeacherDecision(json);
    if (!decision) {
      this.invalidReason = "语音教学控制头格式无效";
      return "";
    }
    this.decision = decision;
    this.resolved = true;
    return candidate.slice(closeIndex + VOICE_TEACHER_CONTROL_CLOSE.length).replace(/^\s+/, "");
  }

  finish(): { decision?: VoiceTeacherDecision; error?: string } {
    if (this.invalidReason) return { error: this.invalidReason };
    if (!this.resolved || !this.decision) return { error: "语音教学控制头不完整" };
    return { decision: this.decision };
  }
}
