import { afterEach, describe, expect, it, vi } from "vitest";

import { synthesizeOnHost, type TtsSynthesisOptions } from "./nativeTts";

const options: TtsSynthesisOptions = {
  providerId: "fish-audio",
  apiKey: "key",
  model: "s2.1-pro-free",
  voiceId: "voice",
  text: "你好",
  format: "mp3",
};

afterEach(() => {
  delete (window as unknown as { studyJournalDesktop?: unknown }).studyJournalDesktop;
});

describe("synthesizeOnHost (desktop)", () => {
  it("asks the main process to abort the in-flight request when the caller aborts", async () => {
    let rejectSynthesis: (reason: unknown) => void = () => undefined;
    const cancel = vi.fn(async () => ({ cancelled: true }));
    const synthesize = vi.fn((_options: TtsSynthesisOptions & { requestId?: string }) => new Promise<{ data: string; mimeType?: string }>((_resolve, reject) => {
      rejectSynthesis = reject;
    }));
    cancel.mockImplementation(async () => {
      rejectSynthesis(new DOMException("aborted", "AbortError"));
      return { cancelled: true };
    });
    (window as unknown as { studyJournalDesktop: unknown }).studyJournalDesktop = { tts: { synthesize, cancel } };

    const controller = new AbortController();
    const pending = synthesizeOnHost(options, controller.signal);
    await Promise.resolve();

    const requestId = synthesize.mock.calls[0][0].requestId;
    expect(requestId).toMatch(/^tts-/);

    controller.abort();
    await expect(pending).rejects.toThrow();
    expect(cancel).toHaveBeenCalledWith(requestId);
  });

  it("does not start a request that was already cancelled", async () => {
    const synthesize = vi.fn();
    (window as unknown as { studyJournalDesktop: unknown }).studyJournalDesktop = { tts: { synthesize, cancel: vi.fn() } };

    const controller = new AbortController();
    controller.abort();
    await expect(synthesizeOnHost(options, controller.signal)).rejects.toThrow();
    expect(synthesize).not.toHaveBeenCalled();
  });
});
