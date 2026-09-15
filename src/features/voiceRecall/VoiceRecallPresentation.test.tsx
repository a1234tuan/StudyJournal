import { fireEvent, render, screen } from "@testing-library/react";
import { Mic } from "lucide-react";
import { describe, expect, it, vi } from "vitest";

import { createVoiceRecallState } from "./domain";
import { VoiceRecallCallView, type VoiceRecallCallViewProps } from "./VoiceRecallPresentation";

const callViewProps = (overrides: Partial<VoiceRecallCallViewProps> = {}): VoiceRecallCallViewProps => {
  const noop = vi.fn();
  return {
    state: { ...createVoiceRecallState(), status: "listening" },
    theme: "reading",
    callPalette: "bright",
    reduceMotion: true,
    captionsVisible: false,
    transcriptEditorOpen: false,
    active: false,
    elapsed: "进行中",
    selectedModeLabel: "自动讲话",
    title: "已接通，你可以直接说。",
    contextLabel: "自由主题",
    questionLabel: "第 1 轮对话",
    interactionHint: "点击主按钮开始说话",
    mainControl: { label: "开始说话", icon: Mic },
    transcript: "",
    teachingComplete: false,
    onBack: noop,
    onMainClick: noop,
    onPressStart: noop,
    onPressEnd: noop,
    onMute: noop,
    onToggleCaptions: noop,
    onToggleTranscriptEditor: noop,
    onOpenDetails: noop,
    onEnd: noop,
    onRetry: noop,
    onResume: noop,
    onTranscriptChange: noop,
    onSubmitTranscript: noop,
    onContinueSupplement: noop,
    onViewSummary: noop,
    onFinishReturn: noop,
    ...overrides,
  };
};

describe("VoiceRecallCallView completion controls", () => {
  it("replaces capture controls with three explicit completion choices", () => {
    const onContinueSupplement = vi.fn();
    const onViewSummary = vi.fn();
    const onFinishReturn = vi.fn();
    render(<VoiceRecallCallView {...callViewProps({
      state: { ...createVoiceRecallState(), status: "paused" },
      elapsed: "已暂停",
      title: "本次复述先到这里。",
      questionLabel: "第 2 轮对话",
      interactionHint: "麦克风已暂停",
      mainControl: { label: "继续", icon: Mic },
      teachingComplete: true,
      onContinueSupplement,
      onViewSummary,
      onFinishReturn,
    })} />);

    expect(screen.getByRole("heading", { name: "要继续补充，还是查看总结？" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "字幕与键盘输入" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "继续补充" }));
    fireEvent.click(screen.getByRole("button", { name: "查看总结" }));
    fireEvent.click(screen.getByRole("button", { name: "结束会话" }));
    expect(onContinueSupplement).toHaveBeenCalledOnce();
    expect(onViewSummary).toHaveBeenCalledOnce();
    expect(onFinishReturn).toHaveBeenCalledOnce();
  });
});

describe("VoiceRecallCallView keyboard captions", () => {
  it.each([
    { name: "keeps visible captions on while opening input", captionsVisible: true, transcriptEditorOpen: false, captionCalls: 0 },
    { name: "turns hidden captions on while opening input", captionsVisible: false, transcriptEditorOpen: false, captionCalls: 1 },
    { name: "turns captions off when the user closes input", captionsVisible: true, transcriptEditorOpen: true, captionCalls: 1 },
  ])("$name", ({ captionsVisible, transcriptEditorOpen, captionCalls }) => {
    const onToggleCaptions = vi.fn();
    const onToggleTranscriptEditor = vi.fn();
    render(<VoiceRecallCallView {...callViewProps({
      captionsVisible,
      transcriptEditorOpen,
      onToggleCaptions,
      onToggleTranscriptEditor,
    })} />);

    fireEvent.click(screen.getByRole("button", { name: "字幕与键盘输入" }));

    expect(onToggleCaptions).toHaveBeenCalledTimes(captionCalls);
    expect(onToggleTranscriptEditor).toHaveBeenCalledOnce();
  });
});
