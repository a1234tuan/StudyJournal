// @vitest-environment node
/**
 * Live acceptance for the voice reply chain (LLM -> sentence-level TTS).
 *
 * Skipped unless the keys are provided, so CI stays deterministic:
 *   VOICE_LIVE_DEEPSEEK_KEY=sk-... VOICE_LIVE_FISH_KEY=sk-... \
 *   VOICE_LIVE_TTS=1 npx vitest run src/features/voiceRecall/voicePipeline.live.test.ts
 *
 * The ASR leg has its own live test (aliyunAsrTransport.live.test.ts).
 * Never commit keys; the app reads them from device-local storage at runtime.
 */
import { describe, expect, it } from "vitest";

import { OpenAiCompatibleLlmStreamAdapter } from "./openAiLlmStreamAdapter";
import { BufferedTtsFallbackAdapter } from "./ttsFallbackAdapters";
import { VoiceRecallPipeline } from "./pipeline";
import { BUILT_IN_ASR_PROFILES, BUILT_IN_VOICE_TTS_PROFILES } from "./providerProfiles";

const deepseekKey = process.env.VOICE_LIVE_DEEPSEEK_KEY;
const fishKey = process.env.VOICE_LIVE_FISH_KEY;
const runTts = process.env.VOICE_LIVE_TTS === "1";
const live = deepseekKey ? describe : describe.skip;

const aliyunAsr = BUILT_IN_ASR_PROFILES.find((profile) => profile.id === "voice-asr-aliyun-paraformer")!;
const fishTts = BUILT_IN_VOICE_TTS_PROFILES.find((profile) => profile.id === "voice-tts-fish-s21")!;

const buildPipeline = () => {
  const llm = new OpenAiCompatibleLlmStreamAdapter({
    id: "live-deepseek",
    providerName: "DeepSeek",
    baseUrl: "https://api.deepseek.com",
    model: "deepseek-v4-pro",
    temperature: 0.7,
    maxTokens: 320,
    contextWindowTokens: 65_536,
  }, deepseekKey!);
  const tts = runTts && fishKey ? new BufferedTtsFallbackAdapter(fishTts, fishKey) : undefined;
  return new VoiceRecallPipeline(
    // The ASR adapter is never invoked in this test; the reply leg is what runs.
    { profileId: aliyunAsr.id, transcribe: async function* () { yield { type: "completed" as const }; } },
    llm,
    tts ?? { profileId: "none", synthesize: async function* () { yield { type: "completed" as const }; } },
  );
};

live("voice reply chain live acceptance", () => {
  it("streams a short spoken reply from the real model", async () => {
    const pipeline = buildPipeline();
    const tokens: string[] = [];
    const audio: number[] = [];
    const result = await pipeline.respond({
      sessionId: "live-session",
      turnId: crypto.randomUUID(),
      operationId: crypto.randomUUID(),
      messages: [
        { role: "system", content: "你是学习复述教练。回复不超过 40 个汉字，只问一个问题。", contentBoundary: "trusted-instruction" },
        { role: "user", content: "我的回答：间隔复习通过拉长复习间隔来强化提取练习。", contentBoundary: "untrusted-learning-content" },
      ],
      voice: fishTts.voice,
      generation: 1,
      signal: AbortSignal.timeout(120_000),
      events: {
        onTeacherToken: (token) => tokens.push(token),
        onAudio: (chunk) => { audio.push(chunk.byteLength); },
      },
    });

    expect(result.teacherText.trim().length).toBeGreaterThan(0);
    expect(tokens.join("")).toBe(result.teacherText);
    // The teacher prompt caps the reply, which keeps TTS cost bounded.
    expect(result.teacherText.length).toBeLessThanOrEqual(200);
    expect(result.usage.llmOutputTokens).toBeGreaterThan(0);

    if (runTts && fishKey) {
      expect(audio.length).toBeGreaterThan(0);
      expect(audio.reduce((sum, size) => sum + size, 0)).toBeGreaterThan(1_000);
      expect(result.usage.ttsCharacters).toBeGreaterThan(0);
    }
  }, 150_000);
});
