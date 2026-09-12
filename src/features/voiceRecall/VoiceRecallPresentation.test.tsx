import { fireEvent, render, screen } from "@testing-library/react";
import { Mic } from "lucide-react";
import { describe, expect, it, vi } from "vitest";

import { createVoiceRecallState } from "./domain";
import { VoiceRecallCallView } from "./VoiceRecallPresentation";

describe("VoiceRecallCallView completion controls", () => {
  it("replaces capture controls with three explicit completion choices", () => {
    const onContinueSupplement = vi.fn();
    const onViewSummary = vi.fn();
    const onFinishReturn = vi.fn();
    const noop = vi.fn();
    render(<VoiceRecallCallView
      state={{ ...createVoiceRecallState(), status: "paused" }}
      theme="reading"
      callPalette="bright"
      reduceMotion
      captionsVisible={false}
      transcriptEditorOpen={false}
      active={false}
      elapsed="已暂停"
      selectedModeLabel="自动讲话"
      title="本次复述先到这里。"
      contextLabel="自由主题"
      questionLabel="第 2 个问题"
      interactionHint="麦克风已暂停"
      mainControl={{ label: "继续", icon: Mic }}
      transcript=""
      teachingComplete
      onBack={noop}
      onMainClick={noop}
      onPressStart={noop}
      onPressEnd={noop}
      onMute={noop}
      onToggleCaptions={noop}
      onToggleTranscriptEditor={noop}
      onOpenDetails={noop}
      onEnd={noop}
      onRetry={noop}
      onResume={noop}
      onTranscriptChange={noop}
      onSubmitTranscript={noop}
      onContinueSupplement={onContinueSupplement}
      onViewSummary={onViewSummary}
      onFinishReturn={onFinishReturn}
    />);

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
