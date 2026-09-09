import { afterEach, expect, it, vi } from "vitest";
import { WebVoiceCaptureAdapter } from "./webVoiceCapture";

afterEach(() => vi.unstubAllGlobals());

it("releases a late microphone permission without creating an audio graph", async () => {
  let grant: ((stream: MediaStream) => void) | undefined;
  const stop = vi.fn();
  const getUserMedia = vi.fn(() => new Promise<MediaStream>((resolve) => { grant = resolve; }));
  vi.stubGlobal("navigator", { mediaDevices: { getUserMedia } });
  const adapter = new WebVoiceCaptureAdapter();
  const controller = new AbortController();
  const iterator = adapter.start({ inputMode: "tap-to-record", echoCancellation: true, noiseSuppression: true, autoGainControl: true, preferredFormat: { encoding: "pcm-s16le", sampleRate: 16000, channelCount: 1 } }, controller.signal)[Symbol.asyncIterator]();
  const pending = iterator.next();
  controller.abort();
  await adapter.stop();
  grant?.({ getTracks: () => [{ stop }] } as unknown as MediaStream);
  await expect(pending).resolves.toMatchObject({ done: true });
  expect(stop).toHaveBeenCalledOnce();
});
