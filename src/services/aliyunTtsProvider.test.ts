import { afterEach, describe, expect, it, vi } from "vitest";
import { transferableAbortController } from "node:util";
import { AliyunTtsProvider } from "./knowledgePodcastService";
import { synthesizeOnHost } from "./nativeTts";
import { aliyunTtsAudioUrl, aliyunTtsEndpoint, buildAliyunTtsRequest } from "../lib/aliyunTts";
import { BUILT_IN_VOICE_TTS_PROFILES, createVoiceTtsProfiles } from "../features/voiceRecall/providerProfiles";

vi.mock("./nativeTts", () => ({ synthesizeOnHost: vi.fn() }));

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.mocked(synthesizeOnHost).mockReset(); });

const cases = [
  { model: "qwen-audio-3.1-tts-flash", voice: "longanfengyue_v3.1", path: "audio/tts/SpeechSynthesizer", mime: "audio/mpeg" },
  { model: "qwen-audio-3.0-tts-flash", voice: "longanfengyue", path: "audio/tts/SpeechSynthesizer", mime: "audio/mpeg" },
  { model: "qwen3-tts-flash", voice: "Cherry", path: "aigc/multimodal-generation/generation", mime: "audio/wav" },
];

describe("Aliyun TTS protocol families", () => {
  it.each(cases)("routes $model without mixing voice or output parameters", async ({ model, voice, path, mime }) => {
    vi.mocked(synthesizeOnHost).mockResolvedValue(undefined);
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ output: { audio: { url: "https://audio.example.test/result" } } })))
      .mockResolvedValueOnce(new Response(new Uint8Array([1, 2, 3]), { headers: { "Content-Type": mime } }));
    vi.stubGlobal("fetch", fetchMock);
    const profile = { id: "aliyun-test", providerId: "aliyun" as const, providerName: "Aliyun", model, voice };
    const audio = await new AliyunTtsProvider(profile, "test-key").synthesize("连接测试。", {});
    expect(fetchMock.mock.calls[0][0]).toBe(`https://dashscope.aliyuncs.com/api/v1/services/${path}`);
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body).toEqual({ model, input: { text: "连接测试。", voice, ...(model.startsWith("qwen-audio-") ? { format: "mp3", sample_rate: 16000 } : {}) } });
    expect(body).not.toHaveProperty("parameters");
    expect(audio.type).toBe(mime);
    expect(audio.size).toBe(3);
    expect(createVoiceTtsProfiles([profile])[0].endpoint).toBe(aliyunTtsEndpoint(model));
  });

  it("exposes separate Qwen Audio presets with model-specific voices", () => {
    for (const { model, voice } of cases.slice(0, 2)) {
      expect(BUILT_IN_VOICE_TTS_PROFILES.find(profile => profile.model === model)).toMatchObject({ voice, endpoint: aliyunTtsEndpoint(model) });
    }
    expect(buildAliyunTtsRequest("qwen3-tts-flash", "Cherry", "原有配置").input).toEqual({ text: "原有配置", voice: "Cherry" });
  });

  it("upgrades signed OSS downloads to HTTPS without changing the signature", async () => {
    const url = "http://dashscope-result-bj.oss-cn-beijing.aliyuncs.com/result.mp3?Expires=123&Signature=a%2Bb%3D";
    const secureUrl = url.replace("http:", "https:");
    expect(aliyunTtsAudioUrl(url)).toBe(secureUrl);
    expect(aliyunTtsAudioUrl(secureUrl)).toBe(secureUrl);
    vi.mocked(synthesizeOnHost).mockResolvedValue(undefined);
    const fetchMock = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({ output: { audio: { url } } })))
      .mockResolvedValueOnce(new Response(new Uint8Array([1])));
    vi.stubGlobal("fetch", fetchMock);
    await new AliyunTtsProvider({ id: "test", providerId: "aliyun", providerName: "Aliyun", model: cases[0].model, voice: cases[0].voice }, "test-key").synthesize("测试", {});
    expect(fetchMock.mock.calls[1][0]).toBe(secureUrl);
  });

  it("keeps host audio and cancellation instead of making a duplicate request", async () => {
    const nativeController = transferableAbortController();
    vi.stubGlobal("AbortSignal", nativeController.signal.constructor);
    const audio = new Blob(["audio"], { type: "audio/mpeg" });
    vi.mocked(synthesizeOnHost).mockResolvedValue(audio);
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const controller = nativeController;
    const provider = new AliyunTtsProvider({ id: "test", providerId: "aliyun", providerName: "Aliyun", model: cases[0].model, voice: cases[0].voice }, "test-key");
    expect(await provider.synthesize("测试", { signal: controller.signal })).toBe(audio);
    const hostSignal = vi.mocked(synthesizeOnHost).mock.calls[0][1]!;
    controller.abort();
    expect(hostSignal.aborted).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each(["missing-url", "empty-audio"])("rejects %s rather than reporting synthesis success", async (failure) => {
    vi.mocked(synthesizeOnHost).mockResolvedValue(undefined);
    const fetchMock = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({ output: { audio: failure === "missing-url" ? {} : { url: "https://audio.example.test/result" } } })))
      .mockResolvedValueOnce(new Response(new Uint8Array()));
    vi.stubGlobal("fetch", fetchMock);
    const provider = new AliyunTtsProvider({ id: "test", providerId: "aliyun", providerName: "Aliyun", model: cases[0].model, voice: cases[0].voice }, "test-key");
    await expect(provider.synthesize("测试", {})).rejects.toThrow(failure === "missing-url" ? "未返回音频地址" : "空音频");
  });
});
