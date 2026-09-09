import { beforeEach, describe, expect, it, vi } from "vitest";

import type { AppSettings } from "../../types";
import { DEFAULT_SETTINGS } from "../../db/defaults";

const secrets = vi.hoisted(() => ({ store: new Map<string, { id: string; apiKey: string; updatedAt: string }>() }));
vi.mock("../../services/storageAdapter", () => ({
  storage: {
    getAiSecret: vi.fn(async (id = "default") => secrets.store.get(id)),
  },
}));

import { createProductionVoiceSession } from "./productionPipeline";

const settings = (): AppSettings => ({
  ...DEFAULT_SETTINGS,
  tts: { currentProviderId: "fish-audio", providers: [{ id: "fish-audio", providerId: "fish-audio", providerName: "Fish Audio", model: "s2-pro", voice: "test-voice" }] },
  ai: {
    currentProviderId: "default",
    presets: [],
    providers: [{
      id: "default",
      providerName: "DeepSeek",
      baseUrl: "https://api.deepseek.com",
      model: "deepseek-v4-pro",
      temperature: 0.7,
      maxTokens: 4096,
      contextWindowTokens: 65_536,
    }],
  },
});

const seedAllSecrets = () => {
  secrets.store.set("voice-asr-aliyun", { id: "voice-asr-aliyun", apiKey: "asr-key", updatedAt: "" });
  secrets.store.set("default", { id: "default", apiKey: "llm-key", updatedAt: "" });
  secrets.store.set("fish-audio", { id: "fish-audio", apiKey: "tts-key", updatedAt: "" });
};

describe("createProductionVoiceSession", () => {
  beforeEach(() => secrets.store.clear());

  it("refuses to build a session when a stage has no credential", async () => {
    await expect(createProductionVoiceSession({ settings: settings(), platform: "desktop", socketFactory: () => { throw new Error("unused"); } }))
      .rejects.toThrow("缺少 阿里云 Paraformer 实时 ASR 的密钥");
  });

  it("refuses on web instead of silently falling back to a simulated call", async () => {
    seedAllSecrets();
    await expect(createProductionVoiceSession({ settings: settings(), platform: "web" }))
      .rejects.toThrow("浏览器无法直连语音服务");
  });

  it("resolves the configured template and credentials into a real pipeline", async () => {
    seedAllSecrets();
    const session = await createProductionVoiceSession({
      settings: settings(),
      platform: "desktop",
      asrTransportFactory: () => ({ open: async () => { throw new Error("not opened in this test"); } }),
    });

    expect(session.summary.asr).toBe("阿里云 Paraformer 实时 ASR");
    expect(session.summary.llm).toContain("deepseek-v4-pro");
    expect(session.summary.tts).toContain("Fish Audio");
    expect(session.asrFormat).toEqual({ encoding: "pcm-s16le", sampleRate: 16_000, channelCount: 1 });
    expect(session.ttsEncoding).toBe("provider-native");
    expect(session.ttsVoice).toBeTruthy();
  });

  it("prefers a device-local ASR override from the voice service config", async () => {
    seedAllSecrets();
    const session = await createProductionVoiceSession({
      settings: settings(),
      platform: "desktop",
      config: {
        templateId: "voice-default-cn",
        asrEndpoint: "wss://relay.example/asr",
        asrModel: "paraformer-realtime-v2",
        asrResourceId: "",
        llmBaseUrl: "",
        llmModel: "",
        ttsEndpoint: "",
        ttsModel: "",
        ttsVoice: "",
      },
      asrTransportFactory: (profile) => {
        expect(profile.endpoint).toBe("wss://relay.example/asr");
        return { open: async () => { throw new Error("not opened in this test"); } };
      },
    });
    expect(session.pipeline).toBeDefined();
  });
});
