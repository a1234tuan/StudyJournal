// @vitest-environment node
/**
 * Live acceptance against the real DashScope endpoint.
 *
 * Skipped unless VOICE_ASR_ALIYUN_KEY is set, so CI stays deterministic:
 *   VOICE_ASR_ALIYUN_KEY=sk-... npx vitest run src/features/voiceRecall/aliyunAsrTransport.live.test.ts
 * Never commit the key; the app reads it from device-local storage at runtime.
 */
import { describe, expect, it } from "vitest";

import type { VoiceAudioFrame } from "./contracts";
import type { AsrProviderProfile } from "./providerProfiles";
import { createAliyunAsrTransport } from "./aliyunAsrTransport";

const apiKey = process.env.VOICE_ASR_ALIYUN_KEY;
const live = apiKey ? describe : describe.skip;

const profile: AsrProviderProfile = {
  id: "voice-asr-aliyun-paraformer",
  providerId: "aliyun-bailian",
  providerName: "阿里云 Paraformer 实时 ASR",
  endpoint: "wss://dashscope.aliyuncs.com/api-ws/v1/inference",
  transport: "websocket",
  model: "paraformer-realtime-v2",
  language: "zh-CN",
  acceptedSampleRates: [16_000],
  acceptedFormats: ["pcm-s16le"],
  punctuation: true,
  inverseTextNormalization: true,
  browserDirectSupported: false,
};

const format = { encoding: "pcm-s16le" as const, sampleRate: 16_000, channelCount: 1 as const };

live("Aliyun ASR live acceptance", () => {
  it("opens a real session, streams audio and finishes cleanly", async () => {
    const transport = createAliyunAsrTransport({ apiKey: apiKey! });
    const controller = new AbortController();
    const session = await transport.open({
      profile,
      sessionId: "live-session",
      turnId: crypto.randomUUID(),
      operationId: "live-operation",
      language: "zh-CN",
      format,
      signal: controller.signal,
    });

    // 1s of 100ms silence frames — enough to exercise the full duplex lifecycle.
    for (let index = 0; index < 10; index += 1) {
      const frame: VoiceAudioFrame = { sequence: index, capturedAtMonotonicMs: index * 100, format, data: new Uint8Array(3_200) };
      await session.send(frame);
    }
    await session.finish();

    const events: string[] = [];
    for await (const event of session.events) events.push(event.type);
    await session.close();

    expect(events).toContain("completed");
  }, 45_000);
});
