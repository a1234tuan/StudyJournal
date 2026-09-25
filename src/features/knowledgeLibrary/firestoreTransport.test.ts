import { afterEach, expect, it, vi } from "vitest";
import { withKnowledgeTimeout } from "./firestoreTransport";
afterEach(() => vi.useRealTimers());
it("distinguishes an unknown timeout from a missing cloud head without pretending the request was cancelled", async () => {
  vi.useFakeTimers();
  let finish!: (value: string) => void;
  const remote = new Promise<string>(resolve => { finish = resolve; });
  const result = withKnowledgeTimeout(remote);
  const assertion = expect(result).rejects.toMatchObject({ code: "timeout" });
  await vi.advanceTimersByTimeAsync(30000);
  await assertion;
  finish("committed later");
  await expect(remote).resolves.toBe("committed later");
  expect(vi.getTimerCount()).toBe(0);
});
it("clears the timeout for completed requests and preserves permission error identity", async () => {
  vi.useFakeTimers();
  await expect(withKnowledgeTimeout(Promise.resolve(3))).resolves.toBe(3);
  const denied = { code: "permission-denied" };
  await expect(withKnowledgeTimeout(Promise.reject(denied))).rejects.toBe(denied);
  expect(vi.getTimerCount()).toBe(0);
});
