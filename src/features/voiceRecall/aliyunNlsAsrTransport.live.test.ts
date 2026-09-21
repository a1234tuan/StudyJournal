// @vitest-environment node
/**
 * Opt-in live acceptance for Alibaba Cloud NLS SpeechTranscriber.
 *
 * The project AppKey and temporary token must be supplied at runtime. They are
 * never persisted by this test and ordinary validation always skips it.
 */
import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";

import type { VoiceAudioFrame } from "./contracts";
import type { AsrProviderProfile } from "./providerProfiles";
import { createAliyunNlsAsrTransport } from "./aliyunNlsAsrTransport";

const appKey = process.env.VOICE_ASR_ALIYUN_NLS_APP_KEY;
const accessToken = process.env.VOICE_ASR_ALIYUN_NLS_TOKEN;
const pcmFile = process.env.VOICE_ASR_ALIYUN_NLS_PCM_FILE;
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
    const audio = pcmFile ? new Uint8Array(await readFile(pcmFile)) : new Uint8Array(32_000);
    let sequence = 0;
    for (let offset = 0; offset < audio.byteLength; offset += 3_200) {
      const frame: VoiceAudioFrame = { sequence, capturedAtMonotonicMs: sequence * 100, format, data: audio.slice(offset, Math.min(offset + 3_200, audio.byteLength)) };
      await session.send(frame);
      sequence += 1;
      if (pcmFile) await new Promise((resolve) => setTimeout(resolve, 100));
    }
    await session.finish();
    const events: Array<{ type: string; text?: string }> = [];
    for await (const event of session.events) events.push(event);
    await session.close();
    expect(events.some((event) => event.type === "completed")).toBe(true);
    if (pcmFile) expect(events.some((event) => event.type === "final" && Boolean(event.text?.trim()))).toBe(true);
  }, 30_000);
});
