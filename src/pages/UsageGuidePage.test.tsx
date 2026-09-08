import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { UsageGuidePage } from "./UsageGuidePage";

describe("UsageGuidePage", () => {
  it("renders the core guide sections and external setup references", () => {
    render(<UsageGuidePage />);

    expect(screen.getByRole("heading", { name: "使用教程" })).toBeInTheDocument();
    for (const heading of ["推荐使用流", "AI 学习用法", "语音主动回忆", "AI 配置", "OCR 配置", "备份与导出", "常见问题"]) {
      expect(screen.getByRole("heading", { name: heading })).toBeInTheDocument();
    }

    expect(screen.getByRole("link", { name: "阿里云百炼" })).toHaveAttribute("href", "https://www.aliyun.com/product/bailian");
    expect(screen.getByRole("link", { name: "PaddleOCR 官网" })).toHaveAttribute("href", "https://aistudio.baidu.com/paddleocr");
    expect(screen.getByText("qwen3.7-plus-2026-05-26")).toBeInTheDocument();
    expect(screen.getByText("微信：A6472589")).toBeInTheDocument();
  });

  it("explains learning flows without exposing editable configuration controls", () => {
    render(<UsageGuidePage />);

    expect(screen.getByText("请根据今天的日志，用白纸复述的方式考我。")).toBeInTheDocument();
    expect(screen.getByText(/按学科 Markdown、知识库 JSON、纯文本 TXT/)).toBeInTheDocument();
    expect(screen.getByText(/ASR 接收麦克风音频/)).toBeInTheDocument();
    expect(screen.getByText(/临时会话和主动保存的通话摘要只保存在本机/)).toBeInTheDocument();
    expect(screen.queryByLabelText("API Key")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("PaddleOCR Token")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /保存/ })).not.toBeInTheDocument();
  });
});
