// @vitest-environment node
/**
 * Opt-in comparison using the same 16 kHz mono PCM input for both providers.
 * The report contains timing/count metadata only; transcript text and secrets
 * are deliberately never printed.
 *
 * Required: VOICE_ASR_AB_RUN=1, VOICE_ASR_AB_PCM, VOICE_ASR_AB_ALIYUN_KEY,
 * VOICE_ASR_AB_DOUBAO_KEY. VOICE_ASR_AB_DOUBAO_TOKEN is optional for legacy
 * App-ID + Access-Token accounts.
 */
import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import WebSocket from "ws";

import type { VoiceAudioFrame } from "./contracts";
import { createAliyunAsrTransport, type VoiceSocketFactory } from "./aliyunAsrTransport";
import { createDoubaoAsrTransport } from "./doubaoAsrTransport";
import { BUILT_IN_ASR_PROFILES } from "./providerProfiles";
import type { VoiceAsrTransport } from "./transportAsrAdapter";

const pcmPath = process.env.VOICE_ASR_AB_PCM;
const aliyunKey = process.env.VOICE_ASR_AB_ALIYUN_KEY;
const doubaoKey = process.env.VOICE_ASR_AB_DOUBAO_KEY;
const doubaoToken = process.env.VOICE_ASR_AB_DOUBAO_TOKEN;
const enabled = process.env.VOICE_ASR_AB_RUN === "1" && pcmPath && aliyunKey && doubaoKey;
const live = enabled ? describe : describe.skip;
const format = { encoding: "pcm-s16le" as const, sampleRate: 16_000, channelCount: 1 as const };
const frameBytes = 3_200;

const nodeSocketFactory: VoiceSocketFactory = (url, headers) => new WebSocket(url, { headers }) as never;
const profile = (id: string) => {
  const value = BUILT_IN_ASR_PROFILES.find((item) => item.id === id);
  if (!value) throw new Error(`ASR profile is missing: ${id}`);
  return value;
};

interface ComparisonResult {
  provider: string;
  openMs: number;
  firstPartialMs?: number;
  finalMs?: number;
  completedMs?: number;
  finalCharacters: number;
  completed: boolean;
}

const compareOne = async (transport: VoiceAsrTransport, profileId: string, pcm: Uint8Array): Promise<ComparisonResult> => {
  const provider = profile(profileId);
  const controller = new AbortController();
  const startedAt = performance.now();
  const session = await transport.open({
    profile: provider,
    sessionId: "voice-asr-ab",
    turnId: crypto.randomUUID(),
    operationId: crypto.randomUUID(),
    language: "zh-CN",
    format,
    signal: controller.signal,
  });
  const result: ComparisonResult = {
    provider: profileId,
    openMs: performance.now() - startedAt,
    finalCharacters: 0,
    completed: false,
  };
  const consume = (async () => {
    for await (const event of session.events) {
      const elapsed = performance.now() - startedAt;
      if (event.type === "partial" && result.firstPartialMs === undefined) result.firstPartialMs = elapsed;
      if (event.type === "final") {
        result.finalMs = elapsed;
        result.finalCharacters = event.text.length;
      }
      if (event.type === "completed") {
        result.completed = true;
        result.completedMs = elapsed;
      }
    }
  })();
  try {
    for (let offset = 0, sequence = 0; offset < pcm.byteLength; offset += frameBytes, sequence += 1) {
      const data = pcm.slice(offset, Math.min(offset + frameBytes, pcm.byteLength));
      const frame: VoiceAudioFrame = { sequence, capturedAtMonotonicMs: sequence * 100, format, data };
      await session.send(frame);
      if (offset + frameBytes < pcm.byteLength) await new Promise((resolve) => setTimeout(resolve, 100));
    }
    await session.finish();
    await consume;
    return result;
  } finally {
    await session.close();
  }
};

live("Aliyun Paraformer vs Doubao ASR 2.0 live comparison", () => {
  it("processes the same PCM sample and reports text-free latency metadata", async () => {
    const pcm = new Uint8Array(await readFile(pcmPath!));
    if (!pcm.byteLength || pcm.byteLength % 2 !== 0) throw new Error("VOICE_ASR_AB_PCM must be non-empty pcm-s16le audio.");
    if (pcm.byteLength > 16000 * 2 * 120) throw new Error("VOICE_ASR_AB_PCM must not exceed 120 seconds.");

    const results = await Promise.all([
      compareOne(createAliyunAsrTransport({ apiKey: aliyunKey!, socketFactory: nodeSocketFactory }), "voice-asr-aliyun-paraformer", pcm),
      compareOne(createDoubaoAsrTransport({
        secret: { apiKey: doubaoKey!, ...(doubaoToken ? { apiKeySecondary: doubaoToken } : {}) },
        socketFactory: nodeSocketFactory,
      }), "voice-asr-doubao-seed-streaming", pcm),
    ]);

    console.info("VOICE_ASR_AB_RESULT", JSON.stringify(results));
    expect(results).toHaveLength(2);
    for (const result of results) {
      expect(result.completed).toBe(true);
      expect(result.finalCharacters).toBeGreaterThan(0);
      expect(result.finalMs).toBeTypeOf("number");
    }
  }, 180_000);
});
