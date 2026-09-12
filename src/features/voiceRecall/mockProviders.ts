import type {
  AsrStreamAdapter,
  AsrStreamEvent,
  AsrStreamRequest,
  LlmStreamAdapter,
  LlmStreamEvent,
  LlmStreamRequest,
  TtsStreamAdapter,
  TtsStreamEvent,
  TtsStreamRequest,
} from "./contracts";
import { formatVoiceTeacherControlledReply } from "./teacherProtocol";

const throwIfAborted = (signal: AbortSignal) => {
  if (signal.aborted) throw new DOMException("Voice operation cancelled", "AbortError");
};

export class MockAsrStreamAdapter implements AsrStreamAdapter {
  readonly profileId = "voice-asr-mock";
  constructor(private readonly finalText = "主动回忆通过提取练习强化长期记忆。") {}

  async *transcribe(request: AsrStreamRequest): AsyncIterable<AsrStreamEvent> {
    let byteCount = 0;
    for await (const frame of request.frames) {
      throwIfAborted(request.signal);
      byteCount += frame.data.byteLength;
      if (byteCount > 0) yield { type: "partial", text: this.finalText.slice(0, Math.ceil(this.finalText.length / 2)), confidence: 0.99 };
    }
    throwIfAborted(request.signal);
    yield { type: "final", text: this.finalText, confidence: 0.99 };
    yield { type: "completed", usageSeconds: byteCount / request.format.sampleRate / 2 };
  }
}

export class MockLlmStreamAdapter implements LlmStreamAdapter {
  readonly profileId = "voice-llm-mock";
  constructor(private readonly response?: string, private readonly openingTopicPlan?: readonly string[]) {}

  async *complete(request: LlmStreamRequest): AsyncIterable<LlmStreamEvent> {
    const controlled = request.messages[0]?.content.includes("<voice_control>");
    const opening = request.messages[0]?.content.includes("当前阶段：开场");
    const memoryLine = request.messages[0]?.content.split("\n").find((line) => line.startsWith("应用维护的教学状态："));
    let promptTopics = ["主动回忆"];
    let currentTopic: string | undefined;
    let pendingTopics: string[] = [];
    let currentTopicFollowUpCount = 0;
    try {
      const memory = JSON.parse(memoryLine?.slice("应用维护的教学状态：".length) ?? "{}") as { currentTopic?: string; currentTopicFollowUpCount?: number; pendingTopics?: string[] };
      currentTopic = memory.currentTopic;
      currentTopicFollowUpCount = memory.currentTopicFollowUpCount ?? 0;
      pendingTopics = memory.pendingTopics ?? [];
      promptTopics = memory.currentTopic ? [memory.currentTopic] : memory.pendingTopics?.length ? memory.pendingTopics : promptTopics;
    } catch { /* deterministic default */ }
    if (opening && this.openingTopicPlan?.length) promptTopics = [...this.openingTopicPlan];
    const promptTopic = promptTopics[0];
    const latestUserText = [...request.messages].reverse().find((message) => message.role === "user" && message.contentBoundary === "user-utterance")?.content ?? "";
    const switchTarget = /应用已确认用户要求切换到“([^”]+)”/.exec(request.messages[0]?.content ?? "")?.[1];
    const skipRequested = request.messages[0]?.content.includes("应用已确认用户要求跳过");
    const switchRequested = Boolean(switchTarget) || request.messages[0]?.content.includes("应用已确认用户要求换个知识点");
    const response = this.response ?? (controlled
      ? formatVoiceTeacherControlledReply(opening ? {
        decision: { v: 1, assessment: "opening", nextAction: "next-topic", topic: promptTopic, topicPlan: promptTopics },
        spokenReply: `先说说你对“${promptTopic}”的整体理解。`,
      } : switchRequested && (switchTarget || pendingTopics[0]) ? {
        decision: { v: 1, assessment: "unclear", nextAction: "next-topic", topic: switchTarget ?? pendingTopics[0] },
        spokenReply: `按你的要求，换到“${switchTarget ?? pendingTopics[0]}”。说说它的核心作用。`,
      } : skipRequested ? pendingTopics.length ? {
        decision: { v: 1, assessment: "unclear", nextAction: "next-topic", topic: pendingTopics[0] },
        spokenReply: `先跳过这个问题。换到“${pendingTopics[0]}”，说说它的整体过程。`,
      } : {
        decision: { v: 1, assessment: "unclear", nextAction: "finish" },
        spokenReply: "先跳过这个问题，主要内容已经覆盖。",
      } : latestUserText.includes("只说了一部分") && currentTopicFollowUpCount < 1 ? {
        decision: { v: 1, assessment: "partial", nextAction: "follow-up", topic: currentTopic ?? promptTopic, note: "还缺一个关键联系" },
        spokenReply: `还缺一个关键联系。“${currentTopic ?? promptTopic}”为什么会产生这个结果？`,
      } : {
        decision: pendingTopics.length
          ? { v: 1, assessment: "sufficient", nextAction: "next-topic", topic: pendingTopics[0] }
          : { v: 1, assessment: "sufficient", nextAction: "finish", topic: currentTopic ?? promptTopic },
        spokenReply: pendingTopics.length ? `这部分已经覆盖。接着说说“${pendingTopics[0]}”。` : "回答抓住了核心内容，这部分已经覆盖。",
      })
      : "回答抓住了提取练习。再举一个你自己的例子。");
    for (const token of response.match(/.{1,6}/gu) ?? []) {
      throwIfAborted(request.signal);
      yield { type: "token", text: token };
    }
    yield { type: "usage", inputTokens: 24, outputTokens: 16 };
    yield { type: "completed" };
  }
}

export class MockTtsStreamAdapter implements TtsStreamAdapter {
  readonly profileId = "voice-tts-mock";

  async *synthesize(request: TtsStreamRequest): AsyncIterable<TtsStreamEvent> {
    throwIfAborted(request.signal);
    yield {
      type: "audio",
      chunk: new TextEncoder().encode(request.text),
      format: { encoding: "pcm-s16le", sampleRate: 16_000, channelCount: 1 },
    };
    yield { type: "usage", characters: request.text.length };
    yield { type: "completed" };
  }
}
