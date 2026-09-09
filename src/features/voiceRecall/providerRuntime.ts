export type VoiceProviderKind = "asr" | "llm" | "tts";

export interface VoiceProviderDiagnostic {
  providerKind: VoiceProviderKind;
  profileId: string;
  operationId: string;
  attempt: number;
  durationMs: number;
  outcome: "completed" | "cancelled" | "timeout" | "failed";
  httpStatus?: number;
  requestId?: string;
  message?: string;
}

export interface VoiceProviderRetryPolicy {
  maxAttempts: number;
  timeoutMs: number;
  baseDelayMs: number;
  circuitFailureThreshold: number;
  circuitResetMs: number;
}

export const DEFAULT_VOICE_PROVIDER_POLICY: VoiceProviderRetryPolicy = {
  maxAttempts: 1,
  timeoutMs: 20_000,
  baseDelayMs: 350,
  circuitFailureThreshold: 3,
  circuitResetMs: 30_000,
};

export class VoiceProviderError extends Error {
  constructor(
    message: string,
    readonly code: "unsupported" | "unauthorized" | "rate-limited" | "timeout" | "network" | "invalid-response" | "circuit-open",
    readonly retryable: boolean,
    readonly httpStatus?: number,
  ) {
    super(message);
    this.name = "VoiceProviderError";
  }
}

const redactUrl = (value: string): string => {
  try {
    const url = new URL(value);
    url.search = url.search ? "?redacted" : "";
    return url.toString();
  } catch {
    return value;
  }
};

export const redactVoiceDiagnostic = (value: unknown): string => {
  const text = value instanceof Error ? value.message : String(value ?? "未知错误");
  return redactUrl(text)
    .replace(/(bearer\s+|api[-_ ]?key[=:]\s*|token[=:]\s*)[A-Za-z0-9._~+\/-]{8,}/gi, "$1[redacted]")
    .replace(/[A-Za-z0-9_-]{32,}/g, "[redacted]")
    .replace(/\s+/g, " ")
    .slice(0, 240);
};

export class VoiceProviderCircuitBreaker {
  private failures = 0;
  private openedAt?: number;

  constructor(private readonly policy: VoiceProviderRetryPolicy = DEFAULT_VOICE_PROVIDER_POLICY) {}

  assertAvailable(now = Date.now()) {
    if (this.openedAt === undefined) return;
    if (now - this.openedAt >= this.policy.circuitResetMs) {
      this.failures = 0;
      this.openedAt = undefined;
      return;
    }
    throw new VoiceProviderError("供应商暂时不可用，请稍后重试或切换备用链路。", "circuit-open", false);
  }

  recordSuccess() {
    this.failures = 0;
    this.openedAt = undefined;
  }

  recordFailure(now = Date.now()) {
    this.failures += 1;
    if (this.failures >= this.policy.circuitFailureThreshold) this.openedAt = now;
  }
}

export const createTimeoutSignal = (parent: AbortSignal, timeoutMs: number) => {
  const controller = new AbortController();
  let timedOut = false;
  const abort = () => controller.abort(parent.reason);
  parent.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort(new DOMException("Voice provider timeout", "TimeoutError"));
  }, timeoutMs);
  return {
    signal: controller.signal,
    didTimeout: () => timedOut,
    dispose: () => { clearTimeout(timer); parent.removeEventListener("abort", abort); },
  };
};

export interface VoiceUsageTotals {
  asrSeconds: number;
  llmInputTokens: number;
  llmOutputTokens: number;
  ttsCharacters: number;
}

export class VoiceUsageMeter {
  private totals: VoiceUsageTotals = { asrSeconds: 0, llmInputTokens: 0, llmOutputTokens: 0, ttsCharacters: 0 };

  add(patch: Partial<VoiceUsageTotals>) {
    for (const key of Object.keys(patch) as Array<keyof VoiceUsageTotals>) {
      this.totals[key] += Math.max(0, patch[key] ?? 0);
    }
  }

  snapshot(): VoiceUsageTotals {
    return { ...this.totals };
  }
}

const delay = (ms: number, signal: AbortSignal) => new Promise<void>((resolve, reject) => {
  const complete = () => { signal.removeEventListener("abort", abort); resolve(); };
  const timer = setTimeout(complete, ms);
  const abort = () => { clearTimeout(timer); reject(new DOMException("Retry cancelled", "AbortError")); };
  signal.addEventListener("abort", abort, { once: true });
});

export async function* retryVoiceProviderStream<T>(options: {
  providerKind: VoiceProviderKind;
  profileId: string;
  operationId: string;
  signal: AbortSignal;
  createStream: () => AsyncIterable<T>;
  circuit: VoiceProviderCircuitBreaker;
  policy?: VoiceProviderRetryPolicy;
  onDiagnostic?: (diagnostic: VoiceProviderDiagnostic) => void;
}): AsyncIterable<T> {
  const policy = options.policy ?? DEFAULT_VOICE_PROVIDER_POLICY;
  options.circuit.assertAvailable();
  for (let attempt = 1; attempt <= policy.maxAttempts; attempt += 1) {
    const startedAt = performance.now();
    let emitted = false;
    try {
      for await (const event of options.createStream()) {
        emitted = true;
        yield event;
      }
      options.circuit.recordSuccess();
      options.onDiagnostic?.({ providerKind: options.providerKind, profileId: options.profileId, operationId: options.operationId, attempt, durationMs: performance.now() - startedAt, outcome: "completed" });
      return;
    } catch (error) {
      const cancelled = options.signal.aborted || (error instanceof DOMException && error.name === "AbortError");
      const providerError = error instanceof VoiceProviderError ? error : undefined;
      const retryable = !emitted && !cancelled && (providerError?.retryable ?? true) && attempt < policy.maxAttempts;
      options.circuit.recordFailure();
      options.onDiagnostic?.({
        providerKind: options.providerKind,
        profileId: options.profileId,
        operationId: options.operationId,
        attempt,
        durationMs: performance.now() - startedAt,
        outcome: cancelled ? "cancelled" : providerError?.code === "timeout" ? "timeout" : "failed",
        httpStatus: providerError?.httpStatus,
        message: redactVoiceDiagnostic(error),
      });
      if (!retryable) throw error;
      await delay(policy.baseDelayMs * attempt, options.signal);
    }
  }
}
