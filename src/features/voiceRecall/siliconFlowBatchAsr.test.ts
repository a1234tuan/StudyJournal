import { describe, it, expect, vi } from "vitest";
import { SiliconFlowBatchAsrAdapter } from "./siliconFlowBatchAsr";

const input = (signal = new AbortController().signal) => ({ sessionId: "session", turnId: "turn", operationId: "operation", signal, language: "zh-CN", format: { encoding: "pcm-s16le" as const, sampleRate: 16000, channelCount: 1 as const }, frames: (async function* () { yield { sequence: 0, capturedAtMonotonicMs: 0, data: new Uint8Array(320), format: { encoding: "pcm-s16le" as const, sampleRate: 16000, channelCount: 1 as const } }; })() });
const config = { model: "FunAudioLLM/SenseVoiceSmall", apiKey: "deterministic-test-key", endpoint: "https://api.siliconflow.com/v1/audio/transcriptions" };
describe("SiliconFlow batch candidate (no network)", () => {
  it("uploads a WAV file and preserves final text without inventing usage", async () => {
    const mock = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ text: "TCP 与 UDP。" })));
    const events = [];
    for await (const event of new SiliconFlowBatchAsrAdapter(config, mock).transcribe(input())) events.push(event);
    const form = mock.mock.calls[0][1]?.body as FormData;
    expect(form.get("model")).toBe(config.model);
    expect((form.get("file") as Blob).size).toBe(364);
    expect(events).toEqual([{ type: "final", text: "TCP 与 UDP。", cumulative: true }, { type: "completed" }]);
  });
  it("does not send cancelled audio or retry authentication errors", async () => {
    const controller = new AbortController(); controller.abort();
    const mock = vi.fn<typeof fetch>().mockResolvedValue(new Response("", { status: 401 }));
    await expect(new SiliconFlowBatchAsrAdapter(config, mock).transcribe(input(controller.signal))[Symbol.asyncIterator]().next()).rejects.toThrow();
    expect(mock).not.toHaveBeenCalled();
    await expect(new SiliconFlowBatchAsrAdapter(config, mock).transcribe(input())[Symbol.asyncIterator]().next()).rejects.toThrow();
    expect(mock).toHaveBeenCalledOnce();
  });
});
