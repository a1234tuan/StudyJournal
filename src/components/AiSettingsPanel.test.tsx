import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DEFAULT_SETTINGS } from "../db/defaults";
import type { AiProviderProfile, AppSettings } from "../types";
import { AiSettingsPanel } from "./AiSettingsPanel";

const storageMock = vi.hoisted(() => ({
  clearAiSecret: vi.fn(),
  getAiSecret: vi.fn(),
  saveAiSecret: vi.fn(),
  saveSettings: vi.fn(),
}));

const aiClientMock = vi.hoisted(() => ({
  testAiProviderConnection: vi.fn(),
}));

vi.mock("../services/storageAdapter", () => ({
  storage: storageMock,
}));

vi.mock("../services/aiClientService", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/aiClientService")>();
  return {
    ...actual,
    testAiProviderConnection: aiClientMock.testAiProviderConnection,
  };
});

const customProvider = (patch: Partial<AiProviderProfile> = {}): AiProviderProfile => ({
  id: "custom",
  providerName: "自定义中转 API",
  baseUrl: "https://chatapi.onechats.top",
  model: "gpt-test",
  temperature: 0.7,
  maxTokens: 4096,
  memoryTurns: 12,
  builtIn: "custom-proxy",
  ...patch,
});

const settingsWithProvider = (provider: AiProviderProfile): AppSettings => ({
  ...DEFAULT_SETTINGS,
  ai: {
    ...DEFAULT_SETTINGS.ai!,
    currentProviderId: provider.id,
    providers: [provider],
  },
});

const openSettingsPanel = async (settings = settingsWithProvider(customProvider())) => {
  render(<AiSettingsPanel settings={settings} onChanged={vi.fn()} />);
  fireEvent.click(screen.getByRole("button", { name: /AI 设置/ }));
  return screen.findByLabelText(/Base URL/);
};

describe("AiSettingsPanel", () => {
  beforeEach(() => {
    storageMock.getAiSecret.mockResolvedValue(undefined);
    storageMock.saveSettings.mockResolvedValue(undefined);
    storageMock.saveAiSecret.mockResolvedValue(undefined);
    storageMock.clearAiSecret.mockResolvedValue(undefined);
    aiClientMock.testAiProviderConnection.mockResolvedValue({
      requestUrl: "https://chatapi.onechats.top/chat/completions",
      content: "OK",
    });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("does not restore DeepSeek while the user clears the Base URL field", async () => {
    const baseUrlInput = await openSettingsPanel();

    fireEvent.change(baseUrlInput, { target: { value: "" } });

    expect(baseUrlInput).toHaveValue("");
    expect(baseUrlInput).not.toHaveValue("https://api.deepseek.com");
  });

  it("blocks saving when required provider fields are empty", async () => {
    const baseUrlInput = await openSettingsPanel();
    fireEvent.change(baseUrlInput, { target: { value: "" } });

    fireEvent.click(screen.getByRole("button", { name: /保存 AI 设置/ }));

    expect(await screen.findByText(/请补齐.*Base URL.*模型名称/)).toBeInTheDocument();
    expect(storageMock.saveSettings).not.toHaveBeenCalled();
  });

  it("shows the actual request URL and /v1 hint for root custom proxy URLs", async () => {
    await openSettingsPanel();

    expect(screen.getByText("实际请求地址：https://chatapi.onechats.top/chat/completions")).toBeInTheDocument();
    expect(screen.getByText(/多数中转站需要在 Base URL 末尾加 \/v1/)).toBeInTheDocument();
  });

  it("does not clear a stored key when saving before the key load resolves", async () => {
    storageMock.getAiSecret.mockImplementation(() => new Promise(() => undefined));
    const baseUrlInput = await openSettingsPanel();
    fireEvent.change(baseUrlInput, { target: { value: "https://chatapi.onechats.top" } });

    fireEvent.click(screen.getByRole("button", { name: /保存 AI 设置/ }));

    await waitFor(() => expect(storageMock.saveSettings).toHaveBeenCalled());
    expect(storageMock.clearAiSecret).not.toHaveBeenCalled();
    expect(storageMock.saveAiSecret).not.toHaveBeenCalled();
  });

  it("saves an edited key without clearing it", async () => {
    storageMock.getAiSecret.mockResolvedValue({ id: "custom", apiKey: "old-key", updatedAt: "2026-01-01T00:00:00.000Z" });
    await openSettingsPanel();
    const keyInput = await screen.findByLabelText(/API Key/);
    await waitFor(() => expect(keyInput).toHaveValue("old-key"));

    fireEvent.change(keyInput, { target: { value: "new-key" } });
    fireEvent.click(screen.getByRole("button", { name: /保存 AI 设置/ }));

    await waitFor(() => expect(storageMock.saveAiSecret).toHaveBeenCalledWith("new-key", "custom"));
    expect(storageMock.clearAiSecret).not.toHaveBeenCalled();
  });

  it("tests the current provider connection without saving settings first", async () => {
    await openSettingsPanel();
    fireEvent.change(screen.getByLabelText(/API Key/), { target: { value: "sk-test" } });

    fireEvent.click(screen.getByRole("button", { name: /测试连接/ }));

    await waitFor(() => expect(aiClientMock.testAiProviderConnection).toHaveBeenCalledTimes(1));
    expect(aiClientMock.testAiProviderConnection).toHaveBeenCalledWith({
      provider: expect.objectContaining({
        baseUrl: "https://chatapi.onechats.top",
        model: "gpt-test",
      }),
      apiKey: "sk-test",
    });
    expect(await screen.findByText(/连接成功。请求地址：https:\/\/chatapi.onechats.top\/chat\/completions/)).toBeInTheDocument();
  });
});
