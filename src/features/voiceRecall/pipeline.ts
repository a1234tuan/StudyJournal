import type {
  AsrStreamAdapter,
  AsrStreamEvent,
  AsrStreamRequest,
  LlmStreamAdapter,
  TtsStreamAdapter,
  VoiceAudioFrame,
  VoiceTeacherMessage,
} from "./contracts";
import { SpeakableSentenceBuffer } from "./sentenceBuffer";
import { VoiceUsageMeter, type VoiceUsageTotals } from "./providerRuntime";

export interface VoiceRecallPipelineResult {
  transcript: string;
  teacherText: string;
  usage: VoiceUsageTotals;
}

export interface VoiceRecallPipelineEvents {
  onAsrEvent?: (event: AsrStreamEvent) => void;
  onTeacherToken?: (token: string) => void;
  onAudio?: (chunk: Uint8Array, generation: number) => void | Promise<void>;
}

export class VoiceRecallPipeline {
  constructor(
    private readonly asr: AsrStreamAdapter,
    private readonly llm: LlmStreamAdapter,
    private readonly tts: TtsStreamAdapter,
  ) {}

  async runTurn(input: {
    sessionId: string;
    turnId: string;
    operationId: string;
    frames: AsyncIterable<VoiceAudioFrame>;
    format: AsrStreamRequest["format"];
    messages: readonly VoiceTeacherMessage[];
    voice: string;
    generation: number;
    signal: AbortSignal;
    events?: VoiceRecallPipelineEvents;
  }): Promise<VoiceRecallPipelineResult> {
    const usage = new VoiceUsageMeter();
    let transcript = "";
    for await (const event of this.asr.transcribe({
      sessionId: input.sessionId,
      turnId: input.turnId,
      operationId: `${input.operationId}:asr`,
      signal: input.signal,
      language: "zh-CN",
      format: input.format,
      frames: input.frames,
    })) {
      input.events?.onAsrEvent?.(event);
      if (event.type === "final") transcript = event.text.trim();
      if (event.type === "completed") usage.add({ asrSeconds: event.usageSeconds });
    }
    if (!transcript) throw new Error("ASR 没有返回可确认的最终转写");

    const messages: VoiceTeacherMessage[] = [
      ...input.messages,
      { role: "user", content: transcript, contentBoundary: "untrusted-learning-content" },
    ];
    const sentenceBuffer = new SpeakableSentenceBuffer();
    let teacherText = "";
    let ttsTail = Promise.resolve();
    const speak = (text: string) => {
      ttsTail = ttsTail.then(async () => {
        for await (const event of this.tts.synthesize({
          sessionId: input.sessionId,
          turnId: input.turnId,
          operationId: `${input.operationId}:tts:${crypto.randomUUID()}`,
          signal: input.signal,
          text,
          voice: input.voice,
        })) {
          if (event.type === "audio") await input.events?.onAudio?.(event.chunk, input.generation);
          if (event.type === "usage") usage.add({ ttsCharacters: event.characters });
        }
      });
    };

    for await (const event of this.llm.complete({
      sessionId: input.sessionId,
      turnId: input.turnId,
      operationId: `${input.operationId}:llm`,
      signal: input.signal,
      messages,
    })) {
      if (event.type === "token") {
        teacherText += event.text;
        input.events?.onTeacherToken?.(event.text);
        for (const sentence of sentenceBuffer.append(event.text)) speak(sentence);
      } else if (event.type === "usage") {
        usage.add({ llmInputTokens: event.inputTokens, llmOutputTokens: event.outputTokens });
      }
    }
    const trailing = sentenceBuffer.flush();
    if (trailing) speak(trailing);
    await ttsTail;
    return { transcript, teacherText, usage: usage.snapshot() };
  }
}
