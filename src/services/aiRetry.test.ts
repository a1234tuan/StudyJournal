import { afterEach, expect, it, vi } from "vitest";
import { AiRequestError, AiSchemaError } from "./aiClientService";
import { waitAiRetry } from "./aiRetry";

afterEach(() => vi.useRealTimers());

it("respects Retry-After and aborts waiting immediately", async () => {
  vi.useFakeTimers();
  const controller = new AbortController();
  const waiting = waitAiRetry(new AiRequestError("limited", true, 429, false, 5000), 1, controller.signal);
  let done = false;
  void waiting.then(() => { done = true; }, () => undefined);
  await vi.advanceTimersByTimeAsync(4999);
  expect(done).toBe(false);
  const rejected = expect(waiting).rejects.toMatchObject({ name: "AbortError" });
  controller.abort();
  await rejected;
  expect(vi.getTimerCount()).toBe(0);
});
it("marks schema failures as non-retryable", () => {
  expect(new AiSchemaError("invalid schema")).toMatchObject({ category: "schema", retryable: false });
});
