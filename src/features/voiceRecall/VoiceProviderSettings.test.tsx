import { fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";

import type { VoiceRecallProviderSetup } from "./VoiceRecallPresentation";
import { VoiceProviderSettings } from "./VoiceProviderSettings";
import { BUILT_IN_ASR_PROFILES, BUILT_IN_VOICE_TTS_PROFILES, USER_VOICE_TEMPLATES, type VoiceProviderEditableConfig } from "./providerProfiles";

vi.mock("./VoiceAsrCredentialSettings", () => ({
  VoiceAsrCredentialSettings: ({ profile }: { profile: { providerName: string } }) => <span>凭据：{profile.providerName}</span>,
}));

describe("VoiceProviderSettings", () => {
  it("switches ASR, LLM, and TTS independently and applies each profile defaults", () => {
    const aliyun = BUILT_IN_ASR_PROFILES.find((profile) => profile.id === "voice-asr-aliyun-paraformer")!;
    const llmProfiles = [
      { id: "llm-a", providerName: "模型 A", baseUrl: "https://a.example/v1", model: "a", temperature: 0.2, maxTokens: 1024 },
      { id: "llm-b", providerName: "模型 B", baseUrl: "https://b.example/v1", model: "b", temperature: 0.2, maxTokens: 1024 },
    ];
    const fish = BUILT_IN_VOICE_TTS_PROFILES.find((profile) => profile.id === "voice-tts-fish-s21")!;
    const initial: VoiceProviderEditableConfig = {
      templateId: USER_VOICE_TEMPLATES[0].templateId,
      asrProfileId: aliyun.id,
      llmProfileId: llmProfiles[0].id,
      ttsProfileId: fish.id,
      asrEndpoint: aliyun.endpoint,
      asrModel: aliyun.model ?? "",
      asrResourceId: "",
      llmBaseUrl: llmProfiles[0].baseUrl,
      llmModel: llmProfiles[0].model,
      ttsEndpoint: fish.endpoint,
      ttsModel: fish.model,
      ttsVoice: fish.voice,
    };
    const Harness = () => {
      const [config, setConfig] = useState(initial);
      const setup: VoiceRecallProviderSetup = {
        templates: USER_VOICE_TEMPLATES,
        asrProfiles: BUILT_IN_ASR_PROFILES.filter((profile) => profile.providerId !== "mock"),
        llmProfiles,
        ttsProfiles: BUILT_IN_VOICE_TTS_PROFILES.filter((profile) => profile.id !== "voice-tts-mock"),
        selectedTemplateId: USER_VOICE_TEMPLATES[0].templateId,
        summaries: {},
        onTemplateChange: vi.fn(),
        config,
        onConfigChange: setConfig,
      };
      return <VoiceProviderSettings setup={setup} />;
    };
    render(<Harness />);

    fireEvent.change(screen.getByLabelText("语音识别服务"), { target: { value: "voice-asr-doubao-seed-streaming" } });
    expect(screen.getByDisplayValue("volc.seedasr.sauc.duration")).toBeInTheDocument();
    expect(screen.getByText("凭据：豆包流式语音识别 2.0")).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("大语言模型服务"), { target: { value: "llm-b" } });
    expect(screen.getByDisplayValue("https://b.example/v1")).toBeInTheDocument();
    expect(screen.getByDisplayValue("b")).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("语音合成服务"), { target: { value: "voice-tts-doubao-small" } });
    expect(screen.getByDisplayValue("volcano_tts")).toBeInTheDocument();
    expect(screen.getByLabelText("旧版控制台 App ID")).toBeInTheDocument();
    expect(screen.getByText(/端到端实时语音/)).toBeInTheDocument();
  });
});
