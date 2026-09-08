import { describe, expect, it, vi } from "vitest";

import { VoiceRecallCancellationTree } from "./cancellation";
import { VoicePlaybackQueue } from "./playbackQueue";
import { TurnEndpointController } from "./turnEndpointController";

describe("voice recall runtime primitives", () => {
  it("waits longer for an incomplete utterance and merges resumed speech", () => {
    vi.useFakeTimers();
    const endpoint = vi.fn();
    const controller = new TurnEndpointController(
      { onEndpoint: endpoint, onLongTurn: vi.fn() },
      { likelyCompleteSilenceMs: 100, incompleteUtteranceSilenceMs: 250, longTurnWarningMs: 1000 },
    );
    controller.startTurn();
    controller.updatePartial("我认为原因包括");
    controller.onSpeechEnd();
    vi.advanceTimersByTime(120);
    expect(endpoint).not.toHaveBeenCalled();
    controller.onSpeechStart();
    vi.advanceTimersByTime(300);
    expect(endpoint).not.toHaveBeenCalled();
    controller.updatePartial("提取练习更费力");
    controller.onSpeechEnd();
    vi.advanceTimersByTime(100);
    expect(endpoint).toHaveBeenCalledOnce();
    vi.useRealTimers();
  });

  it("manual completion has priority over silence timers", () => {
    vi.useFakeTimers();
    const endpoint = vi.fn();
    const controller = new TurnEndpointController(
      { onEndpoint: endpoint, onLongTurn: vi.fn() },
      { likelyCompleteSilenceMs: 100, incompleteUtteranceSilenceMs: 250, longTurnWarningMs: 1000 },
    );
    controller.startTurn();
    controller.onSpeechEnd();
    controller.finishManually();
    vi.runAllTimers();
    expect(endpoint).toHaveBeenCalledOnce();
    vi.useRealTimers();
  });

  it("cancels provider requests when their active turn is cancelled", () => {
    const tree = new VoiceRecallCancellationTree();
    tree.beginTurn();
    const request = tree.beginRequest();
    tree.cancelTurn("user-interrupted");
    expect(request.signal.aborted).toBe(true);
    expect(request.signal.reason).toBe("user-interrupted");
  });

  it("drops late audio from an interrupted playback generation", async () => {
    const played: number[] = [];
    const queue = new VoicePlaybackQueue({
      play: async (chunk) => { played.push(chunk[0]); },
      stop: vi.fn(),
    });
    const oldGeneration = queue.currentGeneration;
    await queue.interrupt();
    expect(queue.enqueue(new Uint8Array([1]), oldGeneration)).toBe(false);
    expect(queue.enqueue(new Uint8Array([2]), queue.currentGeneration)).toBe(true);
    await queue.waitUntilIdle();
    expect(played).toEqual([2]);
  });
});
