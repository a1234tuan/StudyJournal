import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const nativeAudioMock = vi.hoisted(() => ({
  canUseNativeAudioRecorder: vi.fn(() => true),
  getNativeAudioRecordingStatus: vi.fn(async () => ({ recording: false })),
  startNativeAudioRecording: vi.fn(async () => undefined),
  stopNativeAudioRecording: vi.fn(async () => new File(["audio"], "recording.m4a", { type: "audio/mp4" })),
}));

vi.mock("../services/nativeAudioRecorder", () => nativeAudioMock);

import { AudioRecorder } from "./AudioRecorder";

describe("AudioRecorder", () => {
  beforeEach(() => {
    nativeAudioMock.canUseNativeAudioRecorder.mockReset().mockReturnValue(true);
    nativeAudioMock.getNativeAudioRecordingStatus.mockReset().mockResolvedValue({ recording: false });
    nativeAudioMock.startNativeAudioRecording.mockReset().mockResolvedValue(undefined);
    nativeAudioMock.stopNativeAudioRecording.mockReset().mockResolvedValue(new File(["audio"], "recording.m4a", { type: "audio/mp4" }));
  });

  it("uses an icon-only accessible control in compact mode", async () => {
    render(<AudioRecorder compact onRecorded={vi.fn()} />);

    const button = await screen.findByRole("button", { name: "开始录音" });
    expect(button).toHaveAttribute("aria-pressed", "false");
    expect(button).not.toHaveTextContent("开始录音");
    expect(button.querySelector("svg")).toBeInTheDocument();

    fireEvent.click(button);
    await waitFor(() => expect(screen.getByRole("button", { name: "停止录音" })).toBeInTheDocument());
    expect(screen.getByRole("button", { name: "停止录音" })).toHaveAttribute("aria-pressed", "true");
  });

  it("keeps the full text control when compact mode is not requested", async () => {
    render(<AudioRecorder onRecorded={vi.fn()} />);

    const button = await screen.findByRole("button", { name: "开始录音" });
    expect(button).toHaveTextContent("开始录音");
  });
});
