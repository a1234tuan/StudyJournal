import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DEFAULT_SETTINGS } from "../db/defaults";
import { copyTextToClipboard } from "../lib/clipboard";
import { storage } from "../services/storageAdapter";
import type { AiChatMessage, AiChatSession, AiContextPack, RecordBlock } from "../types";
import { AiChatPage } from "./AiChatPage";

vi.mock("../lib/clipboard", () => ({
  copyTextToClipboard: vi.fn(),
}));

const stamp = "2026-06-22T00:00:00.000Z";

const session: AiChatSession = {
  id: "session-1",
  createdAt: stamp,
  updatedAt: stamp,
  title: "公式问答",
};

const assistantMessage: AiChatMessage = {
  id: "message-1",
  sessionId: session.id,
  createdAt: stamp,
  updatedAt: stamp,
  role: "assistant",
  content: "公式：$a^2+b^2=c^2$",
};

const contextAttachment: AiContextPack = {
  date: "2026-06-22",
  scopeTitle: "数学 / #专项突破",
  recordIds: ["record-1"],
  markdown: "# 数学",
  summary: "学习摘要",
  selectedChunks: [],
  allChunks: [],
  totalChunks: 0,
  estimatedChars: 0,
  contextHash: "context",
  warnings: [],
  skippedAssets: [],
  missingOcrAssetIds: [],
};

const scopeRecord = (id: string, subject: string, title: string, order = 0): RecordBlock => ({
  id,
  createdAt: stamp,
  updatedAt: stamp,
  type: "record",
  date: "2026-06-22",
  order,
  subject,
  title,
  contentHtml: "<p>日志正文</p>",
  assets: [],
  formulas: [],
  mistakeRefs: [],
  tags: [],
});

const scrollIntoViewMock = vi.fn();
const scrollToMock = vi.fn();

const renderAiChatPage = () => {
  vi.spyOn(storage, "listAiSessions").mockResolvedValue([session]);
  vi.spyOn(storage, "getAiSession").mockResolvedValue(session);
  vi.spyOn(storage, "listAiMessages").mockResolvedValue([assistantMessage]);
  vi.spyOn(storage, "listAiAttachments").mockResolvedValue([]);

  return render(
    <AiChatPage
      sessionId={session.id}
      scopeScreenOpen={false}
      settings={DEFAULT_SETTINGS}
      blocks={[]}
      assets={[]}
      onBack={vi.fn()}
      onOpenSession={vi.fn()}
      onDeletedSession={vi.fn()}
      onOpenSettings={vi.fn()}
      onOpenAiExport={vi.fn()}
      onOpenScopeScreen={vi.fn()}
      onBackFromScopeScreen={vi.fn()}
      onOpenPodcastForScope={vi.fn()}
    />,
  );
};

const AiScopePageHarness = ({ blocks = [] }: { blocks?: RecordBlock[] }) => {
  const [scopeScreenOpen, setScopeScreenOpen] = useState(false);
  return (
    <AiChatPage
      sessionId={null}
      scopeScreenOpen={scopeScreenOpen}
      settings={DEFAULT_SETTINGS}
      blocks={blocks}
      assets={[]}
      onBack={vi.fn()}
      onOpenSession={vi.fn()}
      onDeletedSession={vi.fn()}
      onOpenSettings={vi.fn()}
      onOpenAiExport={vi.fn()}
      onOpenScopeScreen={() => setScopeScreenOpen(true)}
      onBackFromScopeScreen={() => setScopeScreenOpen(false)}
      onOpenPodcastForScope={vi.fn()}
    />
  );
};

describe("AiChatPage", () => {
  beforeEach(() => {
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
      configurable: true,
      value: scrollIntoViewMock,
    });
    Object.defineProperty(HTMLElement.prototype, "scrollTo", {
      configurable: true,
      value: scrollToMock,
    });
    scrollIntoViewMock.mockReset();
    scrollToMock.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.mocked(copyTextToClipboard).mockReset();
  });

  it("copies the original Markdown message and shows success status", async () => {
    vi.mocked(copyTextToClipboard).mockResolvedValue(true);
    renderAiChatPage();

    const copyButton = await screen.findByRole("button", { name: "复制" });
    fireEvent.click(copyButton);

    await waitFor(() => expect(copyTextToClipboard).toHaveBeenCalledWith(assistantMessage.content));
    expect(await screen.findByText("已复制。")).toBeInTheDocument();
  });

  it("shows a manual-copy hint when clipboard fallback fails", async () => {
    vi.mocked(copyTextToClipboard).mockResolvedValue(false);
    renderAiChatPage();

    const copyButton = await screen.findByRole("button", { name: "复制" });
    fireEvent.click(copyButton);

    expect(await screen.findByText("复制失败，请长按选择文本后手动复制。")).toBeInTheDocument();
  });

  it("keeps automatic scrolling inside the chat thread", async () => {
    renderAiChatPage();

    expect(await screen.findByRole("log", { name: "聊天消息" })).toBeInTheDocument();
    await waitFor(() => expect(scrollToMock).toHaveBeenCalled());
    expect(scrollIntoViewMock).not.toHaveBeenCalled();
  });

  it("uses a fixed three-zone chat workspace with the message thread as the scroll area", async () => {
    renderAiChatPage();

    const thread = await screen.findByRole("log", { name: "聊天消息" });
    const conversationArea = thread.closest(".ai-conversation-area");
    const shell = conversationArea?.parentElement;

    expect(conversationArea).not.toBeNull();
    expect(shell).toHaveClass("ai-chat-shell");
    expect(shell?.querySelector(":scope > .ai-topbar")).not.toBeNull();
    expect(shell?.querySelector(":scope > .ai-conversation-area")).toBe(conversationArea);
    expect(shell?.querySelector(":scope > .ai-composer")).not.toBeNull();
  });

  it("offers a recent knowledge-range picker when no session is selected", async () => {
    vi.spyOn(storage, "listAiSessions").mockResolvedValue([]);
    render(<AiScopePageHarness />);

    fireEvent.click(screen.getAllByRole("button", { name: "新建知识库问答" })[0]);
    expect(await screen.findByRole("main", { name: "新建知识库问答" })).toBeInTheDocument();
    expect(screen.queryByRole("dialog", { name: "新建知识库问答" })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("tab", { name: "近期学习" }));
    fireEvent.click(screen.getByRole("tab", { name: "14 天" }));

    expect(screen.getByText(/最近 14 天/)).toBeInTheDocument();
  });

  it("selects at least two records across subjects and keeps selections after a title search", async () => {
    vi.spyOn(storage, "listAiSessions").mockResolvedValue([]);
    render(<AiScopePageHarness blocks={[
      scopeRecord("math", "数学", "极限专题"),
      scopeRecord("physics", "物理", "力学专题"),
    ]} />);

    fireEvent.click(screen.getAllByRole("button", { name: "新建知识库问答" })[0]);
    fireEvent.click(await screen.findByRole("tab", { name: "选择日志" }));
    expect(screen.getByRole("main", { name: "新建知识库问答" })).toHaveClass("ai-scope-page");
    const createButton = screen.getByRole("button", { name: "创建问答" });
    expect(createButton).toBeDisabled();

    fireEvent.click(screen.getByRole("button", { name: /数学/ }));
    fireEvent.click(screen.getByRole("checkbox", { name: "选择日志 极限专题" }));

    const searchInput = screen.getByRole("textbox", { name: "按日志标题搜索" });
    fireEvent.change(searchInput, { target: { value: "力学专题" } });
    expect(await screen.findByRole("checkbox", { name: "选择日志 力学专题" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("checkbox", { name: "选择日志 力学专题" }));
    expect(createButton).toBeEnabled();

    fireEvent.change(searchInput, { target: { value: "" } });
    expect(screen.getByRole("checkbox", { name: "选择日志 极限专题" })).toBeChecked();

    fireEvent.click(screen.getByRole("button", { name: "返回 AI 问答" }));
    expect(screen.getAllByRole("button", { name: "新建知识库问答" })[0]).toBeInTheDocument();
    fireEvent.click(screen.getAllByRole("button", { name: "新建知识库问答" })[0]);
    expect(screen.getByRole("checkbox", { name: "选择日志 极限专题" })).toBeChecked();

    fireEvent.click(screen.getByRole("button", { name: "取消本次选择" }));
    fireEvent.click(screen.getAllByRole("button", { name: "新建知识库问答" })[0]);
    fireEvent.click(screen.getByRole("button", { name: /数学/ }));
    expect(screen.getByRole("checkbox", { name: "选择日志 极限专题" })).not.toBeChecked();
  });

  it("prevents selecting more than ten records and allows selection after deselecting one", async () => {
    vi.spyOn(storage, "listAiSessions").mockResolvedValue([]);
    const records = Array.from({ length: 11 }, (_, index) => scopeRecord(`record-${index + 1}`, "数学", `日志 ${index + 1}`, index));
    render(<AiScopePageHarness blocks={records} />);

    fireEvent.click(screen.getAllByRole("button", { name: "新建知识库问答" })[0]);
    fireEvent.click(await screen.findByRole("tab", { name: "选择日志" }));
    fireEvent.click(screen.getByRole("button", { name: /数学/ }));

    for (let index = 1; index <= 10; index += 1) {
      fireEvent.click(screen.getByRole("checkbox", { name: `选择日志 日志 ${index}` }));
    }

    const eleventh = screen.getByRole("checkbox", { name: "选择日志 日志 11" });
    expect(eleventh).toBeDisabled();
    fireEvent.click(screen.getByRole("checkbox", { name: "选择日志 日志 1" }));
    expect(eleventh).toBeEnabled();
    fireEvent.click(eleventh);
    expect(eleventh).toBeChecked();
  });

  it("keeps retrieval parameters inside the expandable scope details", async () => {
    const scopedSession: AiChatSession = { ...session, attachment: contextAttachment };
    vi.spyOn(storage, "listAiSessions").mockResolvedValue([scopedSession]);
    vi.spyOn(storage, "getAiSession").mockResolvedValue(scopedSession);
    vi.spyOn(storage, "listAiMessages").mockResolvedValue([]);
    vi.spyOn(storage, "listAiAttachments").mockResolvedValue([]);
    render(
      <AiChatPage
        sessionId={scopedSession.id}
        scopeScreenOpen={false}
        settings={DEFAULT_SETTINGS}
        blocks={[]}
        assets={[]}
        onBack={vi.fn()}
        onOpenSession={vi.fn()}
        onDeletedSession={vi.fn()}
        onOpenSettings={vi.fn()}
        onOpenAiExport={vi.fn()}
        onOpenScopeScreen={vi.fn()}
        onBackFromScopeScreen={vi.fn()}
        onOpenPodcastForScope={vi.fn()}
      />,
    );

    expect(screen.queryByText("聚焦检索 16K")).not.toBeInTheDocument();
    fireEvent.click(await screen.findByRole("button", { name: "打开范围详情" }));
    expect(await screen.findByText("聚焦检索 16K")).toBeInTheDocument();
  });

  it("shows only two preset recommendations before the first message and fills the composer", async () => {
    const scopedSession: AiChatSession = { ...session, attachment: contextAttachment };
    const firstPreset = DEFAULT_SETTINGS.ai!.presets[0];
    vi.spyOn(storage, "listAiSessions").mockResolvedValue([scopedSession]);
    vi.spyOn(storage, "getAiSession").mockResolvedValue(scopedSession);
    vi.spyOn(storage, "listAiMessages").mockResolvedValue([]);
    vi.spyOn(storage, "listAiAttachments").mockResolvedValue([]);
    render(
      <AiChatPage
        sessionId={scopedSession.id}
        scopeScreenOpen={false}
        settings={DEFAULT_SETTINGS}
        blocks={[]}
        assets={[]}
        onBack={vi.fn()}
        onOpenSession={vi.fn()}
        onDeletedSession={vi.fn()}
        onOpenSettings={vi.fn()}
        onOpenAiExport={vi.fn()}
        onOpenScopeScreen={vi.fn()}
        onBackFromScopeScreen={vi.fn()}
        onOpenPodcastForScope={vi.fn()}
      />,
    );

    fireEvent.click(await screen.findByRole("button", { name: new RegExp(firstPreset.title) }));

    expect(screen.getByRole("textbox")).toHaveValue(firstPreset.prompt);
    expect(screen.getByRole("button", { name: "更多学习方式" })).toBeInTheDocument();
  });

  it("keeps all learning modes available from the composer", async () => {
    const scopedSession: AiChatSession = { ...session, attachment: contextAttachment };
    vi.spyOn(storage, "listAiSessions").mockResolvedValue([scopedSession]);
    vi.spyOn(storage, "getAiSession").mockResolvedValue(scopedSession);
    vi.spyOn(storage, "listAiMessages").mockResolvedValue([assistantMessage]);
    vi.spyOn(storage, "listAiAttachments").mockResolvedValue([]);
    render(
      <AiChatPage
        sessionId={scopedSession.id}
        scopeScreenOpen={false}
        settings={DEFAULT_SETTINGS}
        blocks={[]}
        assets={[]}
        onBack={vi.fn()}
        onOpenSession={vi.fn()}
        onDeletedSession={vi.fn()}
        onOpenSettings={vi.fn()}
        onOpenAiExport={vi.fn()}
        onOpenScopeScreen={vi.fn()}
        onBackFromScopeScreen={vi.fn()}
        onOpenPodcastForScope={vi.fn()}
      />,
    );

    fireEvent.click(await screen.findByRole("button", { name: "选择学习方式" }));
    expect(await screen.findByRole("dialog", { name: "选择学习方式" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /抽测此范围/ })).toBeInTheDocument();
  });

  it("keeps the history drawer mounted but inert during its exit", async () => {
    renderAiChatPage();
    fireEvent.click(await screen.findByRole("button", { name: "打开历史聊天" }));
    const title = await screen.findByRole("heading", { name: "聊天记录" });
    const presence = title.closest(".motion-presence");

    expect(presence).toHaveAttribute("data-motion-variant", "drawer");
    fireEvent.click(screen.getByRole("button", { name: "关闭历史记录" }));

    expect(presence).toHaveAttribute("data-motion-phase", "exiting");
    expect(presence).toHaveAttribute("aria-hidden", "true");
    expect(presence).toHaveAttribute("inert");
    await waitFor(() => expect(document.querySelector(".ai-history-backdrop")).toBeNull());
  });
});
