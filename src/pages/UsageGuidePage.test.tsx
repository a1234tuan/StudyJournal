import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { UsageGuidePage } from "./UsageGuidePage";

describe("UsageGuidePage", () => {
  it("renders the document structure and chapter index", () => {
    render(<UsageGuidePage />);

    expect(screen.getByRole("heading", { name: "使用教程" })).toBeInTheDocument();
    for (const heading of [
      "把学过的内容留下，再在需要的时候重新想起来",
      "先完成一次最短闭环",
      "让一条日志成为可复习的学习单元",
      "评分决定下一次出现，而不是宣布永久掌握",
      "把“哪里不会”变成一次具体训练",
      "同一份资料，选择不同的学习动作",
      "在需要时快速找回，而不是记住每个入口",
      "先知道什么会保存，再配置长期使用方式",
      "你现在想做什么？",
    ]) {
      expect(screen.getByRole("heading", { name: heading })).toBeInTheDocument();
    }

    expect(screen.getByRole("navigation", { name: "教程目录" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /01.*理解产品/ })).toHaveAttribute("href", "#understand");
    expect(screen.getByRole("link", { name: /09.*按任务查找/ })).toHaveAttribute("href", "#find");
  });

  it("renders all five semantic illustrations without stale setup copy", () => {
    render(<UsageGuidePage />);

    const images = screen.getAllByRole("img");
    expect(images).toHaveLength(5);
    expect(images.map((image) => image.getAttribute("src"))).toEqual([
      "/guide/learning-loop.png",
      "/guide/record-structure.png",
      "/guide/review-spacing.png",
      "/guide/coach-flow.png",
      "/guide/ai-learning-modes.png",
    ]);
    expect(images.every((image) => image.getAttribute("alt")?.trim())).toBe(true);
    expect(screen.getByText(/更多 → AI 问答/)).toBeInTheDocument();
    expect(screen.getByText(/复习 → 学习助教/)).toBeInTheDocument();
    expect(screen.queryByText(/qwen3\.7-plus|阿里云百炼|每日约 20000 张/)).not.toBeInTheDocument();
    expect(screen.queryByText(/AI 工具 -&gt; AI 问答与聊天记录/)).not.toBeInTheDocument();
  });

  it("keeps practical data boundaries and details collapsed by default", () => {
    render(<UsageGuidePage />);

    expect(screen.getByText(/完整备份用于恢复；AI 材料导出用于阅读和问答/)).toBeInTheDocument();
    expect(screen.getByText(/语音复述的临时会话和主动保留的本机历史/)).toBeInTheDocument();
    expect(document.querySelectorAll("details:not([open])").length).toBeGreaterThanOrEqual(4);
  });
});
