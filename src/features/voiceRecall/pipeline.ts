import type {
  AsrStreamAdapter,
  AsrStreamEvent,
  AsrStreamRequest,
  LlmStreamAdapter,
  LlmStreamEvent,
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

const emptyUsage = (): VoiceUsageTotals => ({ asrSeconds: 0, llmInputTokens: 0, llmOutputTokens: 0, ttsCharacters: 0 });

const mergeUsage = (...totals: VoiceUsageTotals[]): VoiceUsageTotals => totals.reduce<VoiceUsageTotals>(
  (merged, item) => ({
    asrSeconds: merged.asrSeconds + item.asrSeconds,
    llmInputTokens: merged.llmInputTokens + item.llmInputTokens,
    llmOutputTokens: merged.llmOutputTokens + item.llmOutputTokens,
    ttsCharacters: merged.ttsCharacters + item.ttsCharacters,
  }),
  emptyUsage(),
);

/**
 * ASR -> LLM -> sentence-level TTS. Split into `transcribe` and `respond` so the
 * UI can let the user confirm the transcript before the model sees it; `runTurn`
 * keeps the single-shot behaviour for callers that do not need that pause.
 */
export class VoiceRecallPipeline {
  constructor(
    private readonly asr: AsrStreamAdapter,
    private readonly llm: LlmStreamAdapter,
    private readonly tts: TtsStreamAdapter,
  ) {}

  async transcribe(input: {
    sessionId: string;
    turnId: string;
    operationId: string;
    frames: AsyncIterable<VoiceAudioFrame>;
    format: AsrStreamRequest["format"];
    signal: AbortSignal;
    onEvent?: (event: AsrStreamEvent) => void;
  }): Promise<{ transcript: string; usage: VoiceUsageTotals }> {
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
      input.onEvent?.(event);
      if (event.type === "final") transcript = event.text.trim();
      if (event.type === "completed") usage.add({ asrSeconds: event.usageSeconds });
    }
    if (!transcript) throw new Error("ASR 没有返回可确认的最终转写");
    return { transcript, usage: usage.snapshot() };
  }

  async respond(input: {
    sessionId: string;
    turnId: string;
    operationId: string;
    messages: readonly VoiceTeacherMessage[];
    voice: string;
    generation: number;
    signal: AbortSignal;
    events?: Pick<VoiceRecallPipelineEvents, "onTeacherToken" | "onAudio">;
  }): Promise<{ teacherText: string; usage: VoiceUsageTotals }> {
    const usage = new VoiceUsageMeter();
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
      messages: input.messages,
    } satisfies Parameters<LlmStreamAdapter["complete"]>[0])) {
      const llmEvent = event as LlmStreamEvent;
      if (llmEvent.type === "token") {
        teacherText += llmEvent.text;
        input.events?.onTeacherToken?.(llmEvent.text);
        for (const sentence of sentenceBuffer.append(llmEvent.text)) speak(sentence);
      } else if (llmEvent.type === "usage") {
        usage.add({ llmInputTokens: llmEvent.inputTokens, llmOutputTokens: llmEvent.outputTokens });
      }
    }
    const trailing = sentenceBuffer.flush();
    if (trailing) speak(trailing);
    await ttsTail;
    return { teacherText, usage: usage.snapshot() };
  }

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
    const asr = await this.transcribe({
      sessionId: input.sessionId,
      turnId: input.turnId,
      operationId: input.operationId,
      frames: input.frames,
      format: input.format,
      signal: input.signal,
      onEvent: input.events?.onAsrEvent,
    });
    const llm = await this.respond({
      sessionId: input.sessionId,
      turnId: input.turnId,
      operationId: input.operationId,
      messages: [...input.messages, { role: "user", content: asr.transcript, contentBoundary: "untrusted-learning-content" }],
      voice: input.voice,
      generation: input.generation,
      signal: input.signal,
      events: input.events,
    });
    return { transcript: asr.transcript, teacherText: llm.teacherText, usage: mergeUsage(asr.usage, llm.usage) };
  }
}
