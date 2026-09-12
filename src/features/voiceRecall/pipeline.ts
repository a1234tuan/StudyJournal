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
import { recordVoiceStage, stageFailure } from "./diagnostics";
import { VoiceUsageMeter, type VoiceUsageTotals } from "./providerRuntime";
import {
  VoiceTeacherStreamParser,
  type VoiceTeacherControlledReply,
  type VoiceTeacherDecision,
} from "./teacherProtocol";

export interface VoiceRecallPipelineResult {
  transcript: string;
  teacherText: string;
  decision?: VoiceTeacherDecision;
  usage: VoiceUsageTotals;
}

export interface VoiceTeacherResponsePolicy {
  validateDecision: (decision: VoiceTeacherDecision) => string | undefined;
  fallback: VoiceTeacherControlledReply;
}

export interface VoiceRecallPipelineEvents {
  waitForAudioCapacity?: () => Promise<void>;
  onAsrEvent?: (event: AsrStreamEvent) => void;
  onUsage?: (usage: Partial<VoiceUsageTotals>) => void;
  onTeacherToken?: (token: string) => void;
  onAudio?: (chunk: Uint8Array, generation: number, segmentId?: string) => void | Promise<void>;
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
    onUsage?: (usage: Partial<VoiceUsageTotals>) => void;
  }): Promise<{ transcript: string; usage: VoiceUsageTotals }> {
    const usage = new VoiceUsageMeter();
    let transcript = "";
    recordVoiceStage(input.operationId, "asr", "start");
    try {
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
      if (event.type === "final") transcript = event.cumulative ? event.text.trim() : transcript + event.text.trim();
      if ((event.type === "completed" || event.type === "final") && event.usageSeconds !== undefined) {
        usage.add({ asrSeconds: Math.max(0, event.usageSeconds - usage.snapshot().asrSeconds) });
        input.onUsage?.({ asrSeconds: usage.snapshot().asrSeconds });
      }
    }
    if (!transcript) throw new Error("ASR 没有返回可确认的最终转写");
    recordVoiceStage(input.operationId, "asr", "completed");
    return { transcript, usage: usage.snapshot() };
    } catch (error) {
      recordVoiceStage(input.operationId, "asr", input.signal.aborted ? "cancelled" : "failed");
      throw stageFailure("asr", error);
    }
  }

  async respond(input: {
    rate?: number;
    sessionId: string;
    turnId: string;
    operationId: string;
    messages: readonly VoiceTeacherMessage[];
    voice: string;
    generation: number;
    signal: AbortSignal;
    policy?: VoiceTeacherResponsePolicy;
    events?: Pick<VoiceRecallPipelineEvents, "onTeacherToken" | "onAudio" | "onUsage" | "waitForAudioCapacity">;
  }): Promise<{ teacherText: string; decision?: VoiceTeacherDecision; usage: VoiceUsageTotals }> {
    const usage = new VoiceUsageMeter();
    const sentenceBuffer = new SpeakableSentenceBuffer(18);
    const controller = new AbortController();
    const abort = () => controller.abort(input.signal.reason);
    input.signal.addEventListener("abort", abort, { once: true });
    if (input.signal.aborted) abort();
    let teacherText = "";
    let decision: VoiceTeacherDecision | undefined;
    let sentenceIndex = 0;
    let failure: unknown;
    const ttsTasks: Promise<void>[] = [];
    let activeTts = 0;
    const ttsWaiters: Array<() => void> = [];
    const acquireTtsSlot = async () => {
      while (activeTts >= 2) await new Promise<void>((resolve) => ttsWaiters.push(resolve));
      activeTts += 1;
    };
    const releaseTtsSlot = () => { activeTts -= 1; ttsWaiters.shift()?.(); };
    const speak = (text: string) => {
      const index = sentenceIndex++;
      const task = (async () => {
        await acquireTtsSlot();
        try {
          await input.events?.waitForAudioCapacity?.();
          controller.signal.throwIfAborted();
          const segmentId = input.operationId + ":tts:" + index;
          recordVoiceStage(segmentId, "tts", "start");
          for await (const event of this.tts.synthesize({
            sessionId: input.sessionId, turnId: input.turnId,
            operationId: segmentId, signal: controller.signal, text, voice: input.voice, rate: input.rate,
          })) {
            if (event.type === "usage" && event.characters !== undefined) {
              usage.add({ ttsCharacters: event.characters });
              input.events?.onUsage?.({ ttsCharacters: usage.snapshot().ttsCharacters });
            }
            controller.signal.throwIfAborted();
            if (event.type === "audio") { recordVoiceStage(segmentId, "tts", "audio-ready"); await input.events?.onAudio?.(event.chunk, input.generation, segmentId); }
          }
          recordVoiceStage(segmentId, "tts", "completed");
        } catch (error: unknown) {
          recordVoiceStage(input.operationId + ":tts:" + index, "tts", input.signal.aborted ? "cancelled" : "failed");
          failure ??= stageFailure("tts", error);
          controller.abort(error);
        } finally { releaseTtsSlot(); }
      })();
      ttsTasks.push(task);
    };
    const emitTeacherText = (text: string) => {
      if (!text) return;
      teacherText += text;
      input.events?.onTeacherToken?.(text);
      for (const sentence of sentenceBuffer.append(text)) speak(sentence);
    };
    const completeLlmAttempt = async (messages: readonly VoiceTeacherMessage[], repair: boolean) => {
      const parser = input.policy ? new VoiceTeacherStreamParser() : undefined;
      let invalidReason: string | undefined;
      let firstToken = true;
      for await (const event of this.llm.complete({
        sessionId: input.sessionId,
        turnId: input.turnId,
        operationId: input.operationId + (repair ? ":llm:repair" : ":llm"),
        signal: controller.signal,
        messages,
      })) {
        if (event.type === "usage") {
          usage.add({ llmInputTokens: event.inputTokens, llmOutputTokens: event.outputTokens });
          input.events?.onUsage?.({
            ...(event.inputTokens !== undefined ? { llmInputTokens: usage.snapshot().llmInputTokens } : {}),
            ...(event.outputTokens !== undefined ? { llmOutputTokens: usage.snapshot().llmOutputTokens } : {}),
          });
        }
        controller.signal.throwIfAborted();
        if (event.type !== "token") continue;
        if (firstToken) {
          firstToken = false;
          recordVoiceStage(input.operationId, "llm", "first-token");
        }
        if (!parser) {
          emitTeacherText(event.text);
          continue;
        }
        const spoken = parser.push(event.text);
        if (!invalidReason && parser.decision) invalidReason = input.policy?.validateDecision(parser.decision);
        if (!invalidReason && parser.decision) emitTeacherText(spoken);
      }
      if (!parser) return undefined;
      const parsed = parser.finish();
      invalidReason ??= parsed.error;
      if (!invalidReason && parsed.decision) invalidReason = input.policy?.validateDecision(parsed.decision);
      return invalidReason ? { error: invalidReason } : { decision: parsed.decision };
    };
    try {
      controller.signal.throwIfAborted();
      recordVoiceStage(input.operationId, "llm", "start");
      let attempt = await completeLlmAttempt(input.messages, false);
      if (input.policy && attempt?.error) {
        attempt = await completeLlmAttempt([
          ...input.messages,
          {
            role: "system",
            content: `上一回复未通过应用校验：${attempt.error}。请重新输出完整控制头和口语回复，并严格服从应用维护的教学状态。`,
            contentBoundary: "trusted-instruction",
          },
        ], true);
      }
      if (input.policy && attempt?.error) {
        decision = input.policy.fallback.decision;
        emitTeacherText(input.policy.fallback.spokenReply);
      } else {
        decision = attempt?.decision;
      }
      const trailing = sentenceBuffer.flush();
      if (!teacherText.trim()) throw new Error("AI 返回空正文");
      recordVoiceStage(input.operationId, "llm", "completed");
      if (trailing) speak(trailing);
      await Promise.all(ttsTasks);
      if (failure) throw failure;
      controller.signal.throwIfAborted();
      return { teacherText, decision, usage: usage.snapshot() };
    } catch (error) {
      recordVoiceStage(input.operationId, "llm", input.signal.aborted ? "cancelled" : "failed");
      throw failure ?? stageFailure("llm", error);
    } finally {
      controller.abort();
      input.signal.removeEventListener("abort", abort);
      await Promise.allSettled(ttsTasks);
    }
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
      messages: [...input.messages, { role: "user", content: asr.transcript, contentBoundary: "user-utterance" }],
      voice: input.voice,
      generation: input.generation,
      signal: input.signal,
      events: input.events,
    });
    return { transcript: asr.transcript, teacherText: llm.teacherText, decision: llm.decision, usage: mergeUsage(asr.usage, llm.usage) };
  }
}
