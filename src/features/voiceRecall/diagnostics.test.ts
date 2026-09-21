import { describe, expect, it } from "vitest";

import { describeVoiceStage, VoiceStageError } from "./diagnostics";

describe("voice stage diagnostics", () => {
  it("shows an actionable provider cause without exposing credentials", () => {
    const message = describeVoiceStage(new VoiceStageError("asr", new Error(
      "AppKey project123456789 Access Token abcdefghijklmnopqrstuvwxyz123456 expired at wss://example.test/ws?token=abcdefghijklmnopqrstuvwxyz123456&appkey=project123456789",
    )));
    expect(message).toContain("AppKey [已隐藏]");
    expect(message).toContain("Access Token [已隐藏] expired");
    expect(message).toContain("token=[已隐藏]");
    expect(message).toContain("appkey=[已隐藏]");
    expect(message).not.toContain("project123456789");
    expect(message).not.toContain("abcdefghijklmnopqrstuvwxyz123456");
  });

  it("keeps the generic recovery guidance when no safe cause exists", () => {
    expect(describeVoiceStage(new VoiceStageError("asr", undefined))).toBe(
      "语音识别没有完成。请检查该阶段的配置或网络后重试。已确认的本机学习数据不会因此被删除。",
    );
  });
});
