import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { BUILT_IN_ASR_PROFILES } from "./providerProfiles";

const storageMock = vi.hoisted(() => ({
  getAiSecret: vi.fn(),
  saveAiSecret: vi.fn(),
}));

vi.mock("../../services/storageAdapter", () => ({ storage: storageMock }));

import { VoiceAsrCredentialSettings } from "./VoiceAsrCredentialSettings";

describe("VoiceAsrCredentialSettings", () => {
  beforeEach(() => {
    storageMock.getAiSecret.mockReset().mockResolvedValue(undefined);
    storageMock.saveAiSecret.mockReset().mockResolvedValue(undefined);
  });

  it("stores legacy Doubao App ID and Access Token in the device-local ASR slot", async () => {
    const profile = BUILT_IN_ASR_PROFILES.find((item) => item.id === "voice-asr-doubao-seed-streaming")!;
    render(<VoiceAsrCredentialSettings profile={profile} />);
    await screen.findByText(/尚未配置 豆包流式语音识别 2.0 凭据/);

    fireEvent.change(screen.getByLabelText("API Key / 旧版 App ID"), { target: { value: "test-app-id" } });
    fireEvent.change(screen.getByLabelText(/^旧版 Access Token（可选）/), { target: { value: "test-access-token" } });
    fireEvent.click(screen.getByRole("button", { name: "保存 ASR 凭据" }));

    await waitFor(() => expect(storageMock.saveAiSecret).toHaveBeenCalledWith(
      "test-app-id",
      "voice-asr-doubao",
      "test-access-token",
    ));
  });

  it("uses the original Aliyun credential slot", async () => {
    const profile = BUILT_IN_ASR_PROFILES.find((item) => item.id === "voice-asr-aliyun-paraformer")!;
    render(<VoiceAsrCredentialSettings profile={profile} />);
    fireEvent.change(screen.getByLabelText("阿里云 API Key"), { target: { value: "test-key" } });
    fireEvent.click(screen.getByRole("button", { name: "保存 ASR 凭据" }));
    await waitFor(() => expect(storageMock.saveAiSecret).toHaveBeenCalledWith("test-key", "voice-asr-aliyun", undefined));
  });
});
