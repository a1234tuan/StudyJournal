import { beforeEach, describe, expect, it, vi } from "vitest";

const secrets = vi.hoisted(() => ({
  store: new Map<string, { id: string; apiKey: string; updatedAt: string }>(),
}));
vi.mock("../../services/storageAdapter", () => ({
  storage: {
    getAiSecret: vi.fn(async (id = "default") => secrets.store.get(id)),
  },
}));

import { isVoiceChainReady, resolveVoiceSecret, voiceAsrSecretId } from "./credentials";

describe("voice credentials", () => {
  beforeEach(() => secrets.store.clear());

  it("maps each ASR provider family to its device-local secret slot", () => {
    expect(voiceAsrSecretId({ providerId: "aliyun-bailian" } as never)).toBe("voice-asr-aliyun");
    expect(voiceAsrSecretId({ providerId: "doubao" } as never)).toBe("voice-asr-doubao");
    expect(voiceAsrSecretId({ providerId: "mock" } as never)).toBeUndefined();
  });

  it("prefers the exact profile id, then the provider family, then explicit fallbacks", async () => {
    secrets.store.set("voice-tts-fish-s21", { id: "voice-tts-fish-s21", apiKey: "profile-key", updatedAt: "" });
    await expect(resolveVoiceSecret({ profileId: "voice-tts-fish-s21", providerId: "fish-audio" }))
      .resolves.toMatchObject({ apiKey: "profile-key" });

    secrets.store.set("fish-audio", { id: "fish-audio", apiKey: "family-key", updatedAt: "" });
    await expect(resolveVoiceSecret({ profileId: "missing", providerId: "fish-audio" }))
      .resolves.toMatchObject({ apiKey: "family-key" });

    await expect(resolveVoiceSecret({ profileId: "missing", providerId: "missing", fallbackIds: ["fish-audio"] }))
      .resolves.toMatchObject({ apiKey: "family-key" });
  });

  it("never returns a blank credential", async () => {
    secrets.store.set("blank", { id: "blank", apiKey: "   ", updatedAt: "" });
    await expect(resolveVoiceSecret({ profileId: "blank" })).resolves.toBeUndefined();
  });

  it("requires every stage of the chain before a session may start", () => {
    expect(isVoiceChainReady({ asr: true, llm: true, tts: true })).toBe(true);
    expect(isVoiceChainReady({ asr: true, llm: false, tts: true })).toBe(false);
  });
});
