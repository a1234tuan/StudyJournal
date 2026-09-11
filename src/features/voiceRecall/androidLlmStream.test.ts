import { describe, it, expect, vi } from "vitest";
import { streamAndroidLlm } from "./androidLlmStream";
import type { LlmStreamEvent } from "./contracts";
import { createVoiceLlmProfile } from "./providerProfiles";

const profile = createVoiceLlmProfile({ id: "test", providerName: "Test", baseUrl: "https://example.test", model: "test", temperature: 0.5, maxTokens: 320, contextWindowTokens: 4096 });
const request = (signal = new AbortController().signal) => ({ sessionId: "session", turnId: "turn", operationId: "op", signal, messages: [{ role: "user" as const, content: "测试回答", contentBoundary: "untrusted-learning-content" as const }] });
describe("Android voice LLM bridge", () => {
  it("delivers tokens before completion, isolates request IDs and releases listeners", async () => {
    let listener: (event: LlmStreamEvent & { requestId: string }) => void = () => undefined;
    let finish: () => void = () => undefined;
    const remove = vi.fn(async () => undefined);
    const host = { addListener: vi.fn(async (_name, callback) => { listener = callback; return { remove }; }), cancel: vi.fn(async () => undefined), stream: vi.fn((options) => {
      expect(options.messagesJson).toContain("UNTRUSTED_LEARNING_CONTENT_JSON");
      listener({ requestId: "stale", type: "token", text: "旧结果" });
      listener({ requestId: options.requestId, type: "token", text: "新结果" });
      return new Promise<void>((resolve) => { finish = () => { listener({ requestId: options.requestId, type: "completed" }); resolve(); }; });
    }) };
    const iterator = streamAndroidLlm(profile, "test-only", request(), host)[Symbol.asyncIterator]();
    expect((await iterator.next()).value).toMatchObject({ type: "token", text: "新结果" });
    finish();
    expect((await iterator.next()).value).toMatchObject({ type: "completed" });
    expect((await iterator.next()).done).toBe(true);
    expect(remove).toHaveBeenCalledOnce();
  });
  it("cancels native work and rejects a stream without completion", async () => {
    const remove = vi.fn(async () => undefined);
    const host = { addListener: vi.fn(async () => ({ remove })), cancel: vi.fn(async () => undefined), stream: vi.fn(async () => undefined) };
    await expect(streamAndroidLlm(profile, "test-only", request(), host)[Symbol.asyncIterator]().next()).rejects.toThrow("提前结束");
    const controller = new AbortController();
    host.stream.mockImplementation(() => new Promise(() => undefined));
    const pending = streamAndroidLlm(profile, "test-only", request(controller.signal), host)[Symbol.asyncIterator]().next();
    await Promise.resolve(); await Promise.resolve();
    controller.abort();
    await expect(pending).rejects.toThrow();
    expect(host.cancel).toHaveBeenCalled();
  });
});
