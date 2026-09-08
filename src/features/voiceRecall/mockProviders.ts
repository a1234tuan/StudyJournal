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
  constructor(private readonly response = "回答抓住了提取练习。再举一个你自己的例子。") {}

  async *complete(request: LlmStreamRequest): AsyncIterable<LlmStreamEvent> {
    for (const token of this.response.match(/.{1,6}/gu) ?? []) {
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
