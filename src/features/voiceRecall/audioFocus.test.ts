import { describe, expect, it, vi } from "vitest";
import { VoiceAudioFocusManager } from "./audioFocus";
import { NativeVoiceCapture } from "./nativeVoiceCapture";

vi.mock("./nativeVoiceCapture", () => ({
  canUseNativeVoiceCapture: () => true,
  NativeVoiceCapture: {
    addListener: vi.fn(async () => ({ remove: vi.fn(async () => undefined) })),
    acquireFocus: vi.fn(async () => undefined),
    releaseFocus: vi.fn(async () => undefined),
  },
}));

describe("voice audio focus ownership", () => {
  it("serializes a late acquisition, release and new acquisition", async () => {
    const calls: string[] = [];
    let finish: () => void = () => undefined;
    vi.mocked(NativeVoiceCapture.acquireFocus).mockImplementationOnce(() => {
      calls.push("old-acquire");
      return new Promise<void>((resolve) => { finish = resolve; });
    }).mockImplementationOnce(async () => { calls.push("new-acquire"); });
    vi.mocked(NativeVoiceCapture.releaseFocus).mockImplementation(async () => { calls.push("release"); });
    const manager = new VoiceAudioFocusManager(vi.fn());
    const previous = manager.acquire();
    const rejected = expect(previous).rejects.toMatchObject({ name: "AbortError" });
    await vi.waitFor(() => expect(calls).toEqual(["old-acquire"]));
    const released = manager.release();
    const next = manager.acquire();
    finish();
    await rejected;
    await released;
    await next;
    expect(calls).toEqual(["old-acquire", "release", "new-acquire"]);
    await manager.release();
  });
});
