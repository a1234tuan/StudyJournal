import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { AppSettings } from "../types";
import { DEFAULT_SETTINGS } from "../db/defaults";
import { MorePage } from "./MorePage";

const renderMorePage = (settings = DEFAULT_SETTINGS) => {
  const props = {
    onOpenBackup: vi.fn(),
    onOpenAi: vi.fn(),
    onOpenOcrSettings: vi.fn(),
    onOpenPodcasts: vi.fn(),
    onOpenStats: vi.fn(),
    onOpenSettings: vi.fn(),
    onOpenTrash: vi.fn(),
    onOpenTemplates: vi.fn(),
    onOpenCategories: vi.fn(),
    onOpenGuide: vi.fn(),
    onOpenDailyPlan: vi.fn(),
    settings,
  };

  render(<MorePage {...props} />);
  return props;
};

describe("MorePage", () => {
  it("renders compact tool and app entries without expanded heavy panels", () => {
    renderMorePage();

    expect(screen.getByText("备份与恢复")).toBeInTheDocument();
    expect(screen.getByText("AI 问答")).toBeInTheDocument();
    expect(screen.getByText("OCR 设置")).toBeInTheDocument();
    expect(screen.getByText("使用教程")).toBeInTheDocument();
    expect(screen.getByText("回收站")).toBeInTheDocument();
    expect(screen.getByText("模板")).toBeInTheDocument();
    expect(screen.getByText("统计")).toBeInTheDocument();
    expect(screen.getByText("今日计划")).toBeInTheDocument();
    expect(screen.getByText("设置")).toBeInTheDocument();

    expect(screen.queryByRole("heading", { name: "完整备份" })).not.toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "导入恢复" })).not.toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "自动备份" })).not.toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "AI 材料导出" })).not.toBeInTheDocument();
    expect(screen.queryByText("AI 聊天记录")).not.toBeInTheDocument();
  });

  it("opens backup, AI tool, OCR settings and guide subpages from the root entries", () => {
    const props = renderMorePage();

    fireEvent.click(screen.getByRole("button", { name: /备份与恢复/ }));
    fireEvent.click(screen.getByRole("button", { name: /AI 问答/ }));
    fireEvent.click(screen.getByRole("button", { name: /OCR 设置/ }));
    fireEvent.click(screen.getByRole("button", { name: /模板/ }));
    fireEvent.click(screen.getByRole("button", { name: /使用教程/ }));

    expect(props.onOpenBackup).toHaveBeenCalledTimes(1);
    expect(props.onOpenAi).toHaveBeenCalledTimes(1);
    expect(props.onOpenOcrSettings).toHaveBeenCalledTimes(1);
    expect(props.onOpenTemplates).toHaveBeenCalledTimes(1);
    expect(props.onOpenGuide).toHaveBeenCalledTimes(1);
  });

  it("places a long AI model summary below the AI tools title", () => {
    const ai = DEFAULT_SETTINGS.ai!;
    const settings: AppSettings = {
      ...DEFAULT_SETTINGS,
      ai: {
        ...ai,
        providers: ai.providers.map((provider) => ({
          ...provider,
          providerName: "阿里云百炼",
          model: "qwen3.7-plus-2026-05-26",
        })),
      },
    };

    renderMorePage(settings);

    const row = screen.getByRole("button", { name: /AI 问答/ });
    expect(row).toHaveClass("more-summary-row");
    expect(screen.getByText("阿里云百炼 · qwen3.7-plus-2026-05-26")).toBeInTheDocument();
  });

  it("places the AI tools entry at the top of the tool list", () => {
    renderMorePage();

    const toolRows = screen.getAllByRole("button");
    expect(toolRows[0]).toHaveTextContent("AI 问答");
  });

  /**
   * The daily-plan workspace is the one entry here that leaves the "更多" tab, so
   * its handler is the today page's entry path rather than a `more` sub-route.
   * This guards the row's presence and that it is wired to that handler.
   */
  it("reaches the daily-plan workspace from the app list", () => {
    const props = renderMorePage();

    fireEvent.click(screen.getByRole("button", { name: "今日计划" }));

    expect(props.onOpenDailyPlan).toHaveBeenCalledTimes(1);
  });
});
