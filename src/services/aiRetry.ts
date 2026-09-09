import type { AiRequestError } from "./aiClientService";

export const waitAiRetry = (error: unknown, attempt: number, signal?: AbortSignal): Promise<void> => {
  if (signal?.aborted) return Promise.reject(new DOMException("AI request cancelled", "AbortError"));
  const retryAfter = (error as Partial<AiRequestError> | undefined)?.retryAfterMs;
  const delay = Math.max(Math.min(2000, 350 * 2 ** (attempt - 1)), Number.isFinite(retryAfter) ? retryAfter! : 0);
  return new Promise((resolve, reject) => {
    const abort = () => { clearTimeout(timer); signal?.removeEventListener("abort", abort); reject(new DOMException("AI request cancelled", "AbortError")); };
    const timer = setTimeout(() => { signal?.removeEventListener("abort", abort); resolve(); }, delay);
    signal?.addEventListener("abort", abort, { once: true });
  });
};
