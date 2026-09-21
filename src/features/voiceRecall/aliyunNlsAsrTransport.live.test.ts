// @vitest-environment node
/**
 * Opt-in live acceptance for Alibaba Cloud NLS SpeechTranscriber.
 *
 * The project AppKey and temporary token must be supplied at runtime. They are
 * never persisted by this test and ordinary validation always skips it.
 */
import { describe, expect, it } from "vitest";

import type { VoiceAudioFrame } from "./contracts";
import type { AsrProviderProfile } from "./providerProfiles";
import { createAliyunNlsAsrTransport } from "./aliyunNlsAsrTransport";

const appKey = process.env.VOICE_ASR_ALIYUN_NLS_APP_KEY;
const accessToken = process.env.VOICE_ASR_ALIYUN_NLS_TOKEN;
const live = appKey && accessToken ? describe : describe.skip;

const profile: AsrProviderProfile = {
  id: "voice-asr-aliyun-nls-shiyinshi-v1",
  providerId: "aliyun-nls",
  providerName: "阿里云 识音石 V1 实时 ASR",
  endpoint: "wss://nls-gateway-cn-shanghai.aliyuncs.com/ws/v1",
  transport: "websocket",
  language: "zh-CN",
  acceptedSampleRates: [16_000],
  acceptedFormats: ["pcm-s16le"],
  punctuation: true,
  inverseTextNormalization: true,
  browserDirectSupported: true,
};

const format = { encoding: "pcm-s16le" as const, sampleRate: 16_000, channelCount: 1 as const };

live("Aliyun NLS ASR live acceptance", () => {
  it("opens the published project, streams PCM and finishes cleanly", async () => {
    const transport = createAliyunNlsAsrTransport({ appKey: appKey!, accessToken: accessToken! });
    const session = await transport.open({
      profile,
      sessionId: "live-session",
      turnId: crypto.randomUUID(),
      operationId: "live-operation",
      language: "zh-CN",
      format,
      signal: new AbortController().signal,
    });
    for (let index = 0; index < 10; index += 1) {
      const frame: VoiceAudioFrame = { sequence: index, capturedAtMonotonicMs: index * 100, format, data: new Uint8Array(3_200) };
      await session.send(frame);
    }
    await session.finish();
    const events: string[] = [];
    for await (const event of session.events) events.push(event.type);
    await session.close();
    expect(events).toContain("completed");
  }, 30_000);
});
