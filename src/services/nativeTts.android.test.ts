import { describe, it, expect, vi } from "vitest";
const native = vi.hoisted(() => ({ synthesize: vi.fn(), cancel: vi.fn(async () => undefined) }));
vi.mock("@capacitor/core", () => ({ Capacitor: { isNativePlatform: () => true, getPlatform: () => "android" }, registerPlugin: () => native }));
import { synthesizeOnHost } from "./nativeTts";
describe("Android TTS cancellation", () => {
  it("rejects immediately and forwards the exact operation ID", async () => {
    native.synthesize.mockImplementation(() => new Promise(() => undefined));
    const controller = new AbortController();
    const pending = synthesizeOnHost({ providerId: "fish-audio", apiKey: "test-only", model: "test", voiceId: "voice", text: "你好", format: "mp3", speed: 1.2 }, controller.signal);
    const sent = native.synthesize.mock.calls[0][0];
    expect(sent.speed).toBe(1.2);
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(native.cancel).toHaveBeenCalledWith({ requestId: sent.requestId });
  });
});
