import {
  ArrowDown,
  ArrowLeft,
  BookOpen,
  Camera,
  Bot,
  ChevronDown,
  CircleAlert,
  CircleStop,
  Clock3,
  Copy,
  Download,
  Ellipsis,
  History,
  Headphones,
  ImagePlus,
  MessageSquarePlus,
  RefreshCw,
  Send,
  Settings,
  Sparkles,
  Trash2,
  User,
  X,
} from "lucide-react";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

import { AiMarkdown } from "../components/AiMarkdown";
import type { AiChatAttachment, AiChatMessage, AiChatSession, AiKnowledgeScope, AppSettings, Asset, Block } from "../types";
import { AiKnowledgeScopePicker } from "../components/AiKnowledgeScopePicker";
import { copyTextToClipboard } from "../lib/clipboard";
import { createBaseEntity } from "../lib/entity";
import { isNativePlatform } from "../lib/platform";
import { resolveViewportHeight } from "../lib/viewport";
import { formatUiError } from "../lib/uiError";
import { storage } from "../services/storageAdapter";
import { buildSessionMemorySummary, calculateAiRequestBudget, sendChatCompletion } from "../services/aiClientService";
import {
  aiKnowledgeScopeTitle,
  buildAiKnowledgeContextPackAsync,
  compactAiContextPack,
  sessionKnowledgeScope,
} from "../services/aiContextService";
import { createAiImageAttachment, runLocalOcrForAiAttachment } from "../services/aiChatAttachmentService";
import { createAiSessionForScope, titleFromFirstPrompt } from "../services/aiSessionService";
import { DEFAULT_AI_MEMORY_TURNS, getCurrentAiProvider } from "../lib/aiProviders";
import { pickNativeCameraImageFile, pickNativeGalleryImageFile } from "../lib/nativeImagePicker";

interface AiChatPageProps {
  sessionId: string | null;
  scopeScreenOpen: boolean;
  settings: AppSettings;
  blocks: Block[];
  assets: Asset[];
  onBack: () => void;
  onOpenSession: (sessionId: string) => void;
  onDeletedSession: () => void;
  onOpenSettings: () => void;
  onOpenAiExport: () => void;
  onOpenScopeScreen: () => void;
  onBackFromScopeScreen: () => void;
  onOpenPodcastForScope: (scope: AiKnowledgeScope) => void;
}

const sortedPresets = (settings: AppSettings) =>
  [...(settings.ai?.presets ?? [])]
    .filter((preset) => preset.title.trim() && preset.prompt.trim())
    .sort((a, b) => a.order - b.order || a.createdAt.localeCompare(b.createdAt));

const formatBytes = (size: number): string => {
  if (size < 1024) {
    return `${size} B`;
  }
  if (size < 1024 * 1024) {
    return `${(size / 1024).toFixed(1)} KB`;
  }
  return `${(size / 1024 / 1024).toFixed(1)} MB`;
};

const modeLabel = (mode?: string): string => {
  switch (mode) {
    case "recall":
      return "等待你白纸复述";
    case "application":
      return "出变形题";
    case "trap":
      return "挖盲区";
    case "feynman":
      return "费曼追问";
    case "correction":
      return "等你输入理解";
    default:
      return "自定义";
  }
};

const RANGE_QUIZ_PROMPT = "请抽测此范围：跨不同记录挑选核心知识点，每次只出 1 题，不要先给答案，等我作答后再批改。";
const AiChatImageThumb = ({
  image,
  onRemove,
}: {
  image: AiChatAttachment;
  onRemove?: () => void;
}) => {
  const [url, setUrl] = useState("");

  useEffect(() => {
    const objectUrl = URL.createObjectURL(image.data);
    setUrl(objectUrl);
    return () => URL.revokeObjectURL(objectUrl);
  }, [image.data]);

  const statusText = image.sentMode === "vision"
    ? "已直发给 AI"
    : image.ocrStatus === "done"
      ? `OCR ${image.ocrText?.trim().length ?? 0} 字`
      : image.ocrStatus === "running" || image.ocrStatus === "queued"
        ? "OCR 中"
        : image.ocrStatus === "failed"
          ? "OCR 失败"
          : "待发送";

  return (
    <figure className={`ai-image-thumb ${image.ocrStatus === "failed" ? "error" : ""}`}>
      {url && <img src={url} alt={image.fileName} />}
      <figcaption>
        <strong>{image.fileName}</strong>
        <span>{formatBytes(image.size)} · {statusText}</span>
        {image.ocrError && <small>{image.ocrError}</small>}
      </figcaption>
      {onRemove && (
        <button type="button" onClick={onRemove} aria-label="移除图片">
          <X size={14} />
        </button>
      )}
    </figure>
  );
};

export const AiChatPage = ({
  sessionId,
  scopeScreenOpen,
  settings,
  blocks,
  assets,
  onBack,
  onOpenSession,
  onDeletedSession,
  onOpenSettings,
  onOpenAiExport,
  onOpenScopeScreen,
  onBackFromScopeScreen,
  onOpenPodcastForScope,
}: AiChatPageProps) => {
  const [sessions, setSessions] = useState<AiChatSession[]>([]);
  const [session, setSession] = useState<AiChatSession | null>(null);
  const [messages, setMessages] = useState<AiChatMessage[]>([]);
  const [messageAttachments, setMessageAttachments] = useState<Record<string, AiChatAttachment[]>>({});
  const [pendingImages, setPendingImages] = useState<AiChatAttachment[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("");
  const [historyOpen, setHistoryOpen] = useState(false);
  const [contextDetailsOpen, setContextDetailsOpen] = useState(false);
  const [moreActionsOpen, setMoreActionsOpen] = useState(false);
  const [learningActionsOpen, setLearningActionsOpen] = useState(false);
  const [imageActionsOpen, setImageActionsOpen] = useState(false);
  const [scopePickerVersion, setScopePickerVersion] = useState(0);
  const scopeDraftRef = useRef<AiKnowledgeScope>();
  const [hasUnreadLatest, setHasUnreadLatest] = useState(false);
  const threadRef = useRef<HTMLElement | null>(null);
  const nearThreadBottomRef = useRef(true);
  const forceThreadBottomRef = useRef(false);
  const lastThreadSessionIdRef = useRef<string | null>(null);
  const lastThreadMessageCountRef = useRef(0);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const sendAbortRef = useRef<AbortController>();

  useEffect(() => () => { sendAbortRef.current?.abort(); }, []);
  const presets = useMemo(() => sortedPresets(settings), [settings]);
  const recommendedPresets = useMemo(() => presets.slice(0, 2), [presets]);
  const imageInputMode = settings.ai?.imageInputMode ?? "local-ocr";
  const native = isNativePlatform();
  const provider = useMemo(() => getCurrentAiProvider(settings.ai), [settings.ai]);

  const refresh = async () => {
    const nextSessions = await storage.listAiSessions?.() ?? [];
    setSessions(nextSessions);
    if (!sessionId) {
      setSession(null);
      setMessages([]);
      return;
    }
    const nextSession = await storage.getAiSession?.(sessionId);
    setSession(nextSession ?? null);
    const nextMessages = nextSession ? await storage.listAiMessages?.(nextSession.id) ?? [] : [];
    const nextAttachments = nextSession ? await storage.listAiAttachments?.(nextSession.id) ?? [] : [];
    setMessages(nextMessages);
    setMessageAttachments(
      nextAttachments.reduce<Record<string, AiChatAttachment[]>>((grouped, attachment) => {
        if (attachment.messageId) {
          grouped[attachment.messageId] = [...(grouped[attachment.messageId] ?? []), attachment];
        }
        return grouped;
      }, {}),
    );
  };

  useEffect(() => {
    setPendingImages([]);
    setContextDetailsOpen(false);
    setMoreActionsOpen(false);
    setLearningActionsOpen(false);
    setImageActionsOpen(false);
    void refresh();
  }, [sessionId]);

  const isNearThreadBottom = (thread: HTMLElement): boolean =>
    thread.scrollHeight - thread.scrollTop - thread.clientHeight <= 72;

  const scrollThreadToBottom = (behavior: ScrollBehavior = "smooth") => {
    const thread = threadRef.current;
    if (!thread) return;
    thread.scrollTo({ top: thread.scrollHeight, behavior });
    nearThreadBottomRef.current = true;
    setHasUnreadLatest(false);
  };

  const handleThreadScroll = () => {
    const thread = threadRef.current;
    if (!thread) return;
    const nearBottom = isNearThreadBottom(thread);
    nearThreadBottomRef.current = nearBottom;
    if (nearBottom) {
      setHasUnreadLatest(false);
    }
  };

  useEffect(() => {
    const sessionChanged = lastThreadSessionIdRef.current !== sessionId;
    const messageCountIncreased = messages.length > lastThreadMessageCountRef.current;
    lastThreadSessionIdRef.current = sessionId;
    lastThreadMessageCountRef.current = messages.length;

    if (!sessionChanged && !messageCountIncreased) return;
    if (sessionChanged || forceThreadBottomRef.current || nearThreadBottomRef.current) {
      scrollThreadToBottom(sessionChanged ? "auto" : "smooth");
    } else if (messageCountIncreased) {
      setHasUnreadLatest(true);
    }
    forceThreadBottomRef.current = false;
  }, [messages.length, sessionId]);

  useLayoutEffect(() => {
    const root = document.documentElement;
    const visualViewport = window.visualViewport;
    let settleTimer: number | null = null;
    const updateViewportHeight = () => {
      const height = resolveViewportHeight({
        native,
        innerHeight: window.innerHeight,
        visualViewportHeight: visualViewport?.height,
      });
      if (height > 0) {
        root.style.setProperty("--ai-chat-viewport-height", `${height}px`);
      }
    };

    const remeasureAfterKeyboardTransition = () => {
      updateViewportHeight();
      if (settleTimer) {
        window.clearTimeout(settleTimer);
      }
      settleTimer = window.setTimeout(updateViewportHeight, 180);
    };

    updateViewportHeight();
    settleTimer = window.setTimeout(updateViewportHeight, 180);
    visualViewport?.addEventListener("resize", remeasureAfterKeyboardTransition);
    visualViewport?.addEventListener("scroll", remeasureAfterKeyboardTransition);
    window.addEventListener("resize", remeasureAfterKeyboardTransition);
    window.addEventListener("focus", remeasureAfterKeyboardTransition);
    window.addEventListener("focusin", remeasureAfterKeyboardTransition);
    window.addEventListener("focusout", remeasureAfterKeyboardTransition);
    const handleVisibilityChange = () => {
      if (document.visibilityState === "visible") {
        remeasureAfterKeyboardTransition();
      }
    };
    document.addEventListener("visibilitychange", handleVisibilityChange);
    return () => {
      if (settleTimer) {
        window.clearTimeout(settleTimer);
      }
      visualViewport?.removeEventListener("resize", remeasureAfterKeyboardTransition);
      visualViewport?.removeEventListener("scroll", remeasureAfterKeyboardTransition);
      window.removeEventListener("resize", remeasureAfterKeyboardTransition);
      window.removeEventListener("focus", remeasureAfterKeyboardTransition);
      window.removeEventListener("focusin", remeasureAfterKeyboardTransition);
      window.removeEventListener("focusout", remeasureAfterKeyboardTransition);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      root.style.removeProperty("--ai-chat-viewport-height");
    };
  }, [native]);

  useEffect(() => {
    const textarea = inputRef.current;
    if (!textarea) return;
    const maxHeight = 132;
    textarea.style.height = "0px";
    textarea.style.height = `${Math.min(textarea.scrollHeight, maxHeight)}px`;
    textarea.style.overflowY = textarea.scrollHeight > maxHeight ? "auto" : "hidden";
  }, [input]);

  const copy = async (text: string) => {
    const copied = await copyTextToClipboard(text);
    setStatus(copied ? "已复制。" : "复制失败，请长按选择文本后手动复制。");
  };

  const openNewChat = async () => {
    if (!session?.attachment) {
      return;
    }
    const scope = sessionKnowledgeScope(session);
    if (!scope) return;
    const nextSession = await createAiSessionForScope(
      scope,
      await buildAiKnowledgeContextPackAsync(scope, blocks, assets),
    );
    if (nextSession) {
      setHistoryOpen(false);
      onOpenSession(nextSession.id);
    }
  };

  const updateTitleFromFirstPrompt = async (prompt: string, currentSession: AiChatSession, messageCount: number) => {
    if (messageCount > 0) {
      return currentSession;
    }
    const nextTitle = titleFromFirstPrompt(prompt);
    if (!nextTitle || currentSession.title === nextTitle) {
      return currentSession;
    }
    const saved = await storage.saveAiSession?.({ ...currentSession, title: nextTitle });
    if (saved) {
      setSession(saved);
      return saved;
    }
    return currentSession;
  };

  const updatePendingImage = (updated: AiChatAttachment) => {
    setPendingImages((current) => current.map((item) => item.id === updated.id ? updated : item));
  };

  const addImageFile = async (file: File) => {
    if (!session || busy) {
      return;
    }
    if (!file.type.startsWith("image/")) {
      setStatus("请选择图片文件。");
      return;
    }
    const attachment = await createAiImageAttachment(session.id, file);
    setPendingImages((current) => [...current, attachment]);
    setStatus(imageInputMode === "local-ocr" ? "图片已加入，发送时会先进行本地 OCR。" : "图片已加入。");
  };

  const pickNativeImage = async (picker: () => Promise<File | undefined>) => {
    try {
      const file = await picker();
      if (file) {
        await addImageFile(file);
      }
    } catch (error) {
      setStatus(formatUiError(error, "ai-request"));
    }
  };

  const removePendingImage = async (id: string) => {
    await storage.deleteAiAttachment?.(id);
    setPendingImages((current) => current.filter((item) => item.id !== id));
  };

  const chooseLearningPrompt = (prompt: string) => {
    setInput(prompt);
    setLearningActionsOpen(false);
  };

  const prepareImagesForSend = async (images: AiChatAttachment[]): Promise<AiChatAttachment[]> => {
    if (images.length === 0) {
      return [];
    }
    if (imageInputMode === "disabled") {
      throw new Error("AI 图片发送已关闭，请在 AI 设置中开启图片问答方式。");
    }
    if (imageInputMode === "vision") {
      const saved = await Promise.all(images.map((image) =>
        storage.saveAiAttachment?.({ ...image, sentMode: "vision" }) ?? image,
      ));
      saved.forEach(updatePendingImage);
      return saved;
    }
    const prepared: AiChatAttachment[] = [];
    for (const image of images) {
      setStatus(`正在 OCR：${image.fileName}`);
      const updated = await runLocalOcrForAiAttachment(image, { onChanged: updatePendingImage });
      prepared.push(updated);
    }
    return prepared;
  };

  const send = async () => {
    const prompt = input.trim();
    const imagesToSend = pendingImages;
    if ((!prompt && imagesToSend.length === 0) || !session || busy) {
      return;
    }
    forceThreadBottomRef.current = true;
    setHasUnreadLatest(false);
    setBusy(true);
    setStatus("");
    setInput("");

    let preparedImages: AiChatAttachment[] = [];
    try {
      preparedImages = await prepareImagesForSend(imagesToSend);
    } catch (error) {
      setBusy(false);
      setStatus(formatUiError(error, "ai-request"));
      return;
    }

    const effectivePrompt = prompt || "请根据我上传的图片内容进行回答或批改。";
    let requestBudget: ReturnType<typeof calculateAiRequestBudget>;
    try {
      requestBudget = calculateAiRequestBudget({
        provider,
        history: messages,
        prompt: effectivePrompt,
        memorySummary: session.memorySummary,
      });
    } catch (error) {
      setBusy(false);
      setStatus(formatUiError(error, "ai-request"));
      return;
    }
    const titleSession = await updateTitleFromFirstPrompt(effectivePrompt, session, messages.length);
    const scope = sessionKnowledgeScope(titleSession);
    const freshAttachment = scope
      ? await buildAiKnowledgeContextPackAsync(scope, blocks, assets, effectivePrompt, undefined, {
        maxTokens: requestBudget.retrievalTokens,
        retrievalMode: requestBudget.retrievalMode,
        preferDiverse: requestBudget.retrievalMode === "coverage",
      })
      : undefined;
    if (freshAttachment) {
      requestBudget = calculateAiRequestBudget({
        provider,
        history: messages,
        prompt: effectivePrompt,
        memorySummary: titleSession.memorySummary,
        attachment: freshAttachment,
      });
    }
    const contextSession = freshAttachment
      ? await storage.saveAiSession?.({
        ...titleSession,
        scope,
        scopeTitle: freshAttachment.scopeTitle,
        attachment: compactAiContextPack(freshAttachment),
        lastContextHash: freshAttachment.contextHash,
      }) ?? {
        ...titleSession,
        scope,
        scopeTitle: freshAttachment.scopeTitle,
        attachment: compactAiContextPack(freshAttachment),
        lastContextHash: freshAttachment.contextHash,
      }
      : titleSession;
    const userMessage: AiChatMessage = {
      ...createBaseEntity(),
      sessionId: contextSession.id,
      role: "user",
      content: effectivePrompt,
      attachmentIds: preparedImages.map((image) => image.id),
    };
    await storage.saveAiMessage?.(userMessage);
    const savedPreparedImages = await Promise.all(preparedImages.map((image) =>
      storage.saveAiAttachment?.({ ...image, messageId: userMessage.id }) ?? { ...image, messageId: userMessage.id },
    ));
    setPendingImages([]);
    const visibleHistory = [...messages, userMessage];
    setMessages(visibleHistory);
    setMessageAttachments((current) => ({
      ...current,
      [userMessage.id]: savedPreparedImages,
    }));

    const controller = new AbortController();
    sendAbortRef.current = controller;
    try {
      const apiKey = provider ? (await storage.getAiSecret?.(provider.id))?.apiKey : undefined;
      const content = await sendChatCompletion({
        provider,
        apiKey,
        attachment: freshAttachment ?? contextSession.attachment,
        history: messages,
        prompt: effectivePrompt,
        memorySummary: contextSession.memorySummary,
        imageInputMode,
        imageAttachments: savedPreparedImages,
        budget: requestBudget,
        signal: controller.signal,
      });
      const assistantMessage: AiChatMessage = {
        ...createBaseEntity(),
        sessionId: contextSession.id,
        role: "assistant",
        content,
      };
      await storage.saveAiMessage?.(assistantMessage);
      const memorySummary = buildSessionMemorySummary([...visibleHistory, assistantMessage], provider?.memoryTurns ?? DEFAULT_AI_MEMORY_TURNS);
      if (memorySummary && memorySummary !== contextSession.memorySummary) {
        await storage.saveAiSession?.({ ...contextSession, memorySummary });
      }
      setMessages([...visibleHistory, assistantMessage]);
      await refresh();
    } catch (error) {
      if (!controller.signal.aborted) {
        const errorText = formatUiError(error, "ai-request");
        const assistantMessage: AiChatMessage = {
          ...createBaseEntity(),
          sessionId: contextSession.id,
          role: "assistant",
          content: errorText,
          error: errorText,
        };
        await storage.saveAiMessage?.(assistantMessage);
        setMessages([...visibleHistory, assistantMessage]);
      }
    } finally {
      if (sendAbortRef.current === controller) {
        sendAbortRef.current = undefined;
      }
      setBusy(false);
      setStatus(controller.signal.aborted ? "已停止生成。" : "");
    }
  };

  const deleteSession = async (id: string) => {
    const ok = window.confirm("删除这段 AI 聊天记录？日志本身不会被删除。");
    if (!ok) {
      return;
    }
    await storage.deleteAiSession?.(id);
    if (sessionId === id) {
      setHistoryOpen(false);
      onDeletedSession();
    } else {
      await refresh();
    }
  };

  const attachment = session?.attachment;
  const selectedChunkCount = attachment?.selectedChunks?.length ?? 0;
  const totalChunkCount = attachment?.totalChunks ?? attachment?.selectedChunks?.length ?? 0;
  const skippedAssetCount = attachment?.skippedAssets.length ?? 0;
  const composerBudget = (() => {
    if (!session || !provider) return undefined;
    try {
      return calculateAiRequestBudget({ provider, history: messages, prompt: input, memorySummary: session.memorySummary, attachment });
    } catch {
      return undefined;
    }
  })();
  const scopeLabel = attachment?.scopeTitle ?? session?.scopeTitle ?? (session ? aiKnowledgeScopeTitle(sessionKnowledgeScope(session) ?? { kind: "date", date: attachment?.date ?? session.updatedAt.slice(0, 10) }) : "AI Chat");
  const includedImages = attachment?.ocrSummary?.includedImages ?? 0;
  const skippedImages = attachment?.ocrSummary?.skippedImages ?? 0;
  const contextWarning = attachment?.warnings[0]
    ?? (skippedImages > 0 ? `${skippedImages} 张图片没有可用 OCR 文本` : skippedAssetCount > 0 ? `${skippedAssetCount} 个资源未参与问答` : "");
  const hasContextWarning = Boolean(contextWarning);
  const emptyConversation = Boolean(session && messages.length === 0);
  if (scopeScreenOpen) {
    return (
      <AiKnowledgeScopePicker
        key={scopePickerVersion}
        blocks={blocks}
        assets={assets}
        initialScope={scopeDraftRef.current}
        title="新建知识库问答"
        ariaLabel="新建知识库问答"
        confirmLabel="创建问答"
        secondaryAction={{ label: "生成知识播客", icon: <Headphones size={18} />, onClick: onOpenPodcastForScope }}
        backLabel="返回 AI 问答"
        onBack={onBackFromScopeScreen}
        onCancel={() => {
          if (scopeDraftRef.current?.kind === "records") {
            scopeDraftRef.current = { kind: "records", recordIds: [] };
          }
          setScopePickerVersion((current) => current + 1);
          onBackFromScopeScreen();
        }}
        onScopeChange={(scope) => { scopeDraftRef.current = scope; }}
        onConfirm={async (scope) => {
          setStatus("");
          const nextSession = await createAiSessionForScope(scope, await buildAiKnowledgeContextPackAsync(scope, blocks, assets));
          if (nextSession) onOpenSession(nextSession.id);
        }}
      />
    );
  }

  return (
    <main className="page ai-chat-page immersive">
      <section className="ai-chat-shell">
        <header className="ai-topbar">
          <button type="button" className="icon-button" onClick={onBack} aria-label="返回" title="返回">
            <ArrowLeft size={18} />
          </button>
          <div className="ai-topbar-title">
            <p>{session ? scopeLabel : "学习助手"}</p>
            <h1>{session?.title ?? "AI 问答"}</h1>
          </div>
          <div className="ai-topbar-actions">
            {attachment && (
              <button
                type="button"
                className="ai-context-trigger"
                onClick={() => setContextDetailsOpen(true)}
                aria-label="打开范围详情"
                title="范围详情"
              >
                <span>范围详情</span>
                <ChevronDown size={15} />
              </button>
            )}
            <button type="button" className="icon-button" onClick={() => setHistoryOpen(true)} aria-label="打开历史聊天">
              <History size={18} />
            </button>
            <button type="button" className="icon-button" onClick={() => setMoreActionsOpen(true)} aria-label="更多 AI 操作" title="更多 AI 操作">
              <Ellipsis size={20} />
            </button>
          </div>
        </header>

        <section className="ai-conversation-area">
          <section
            ref={threadRef}
            className={`ai-thread ${!session ? "is-start-state" : emptyConversation ? "is-empty-conversation" : ""}`}
            role="log"
            aria-label="聊天消息"
            aria-live="polite"
            onScroll={handleThreadScroll}
          >
            {attachment && hasContextWarning && (
              <button type="button" className="ai-context-warning" onClick={() => setContextDetailsOpen(true)}>
                <CircleAlert size={16} />
                <span>{contextWarning}</span>
                <ChevronDown size={15} />
              </button>
            )}
          {!session ? (
            <div className="ai-no-session">
              <div>
                <h2>从一个学习范围开始</h2>
                <p>选择学科标签，或最近 7、14、30 天的学习记录。</p>
              </div>
              <button type="button" className="primary-button" onClick={onOpenScopeScreen}>
                <Sparkles size={18} />
                新建知识库问答
              </button>
            </div>
          ) : emptyConversation ? (
            <div className="ai-empty-conversation">
              <div className="ai-empty-conversation-copy">
                <p className="eyebrow">准备就绪</p>
                <h2>从这里开始提问</h2>
                <p>直接输入问题，或选择一种学习方式。</p>
              </div>
              <div className="ai-recommendation-grid" aria-label="推荐学习方式">
                {recommendedPresets.map((preset) => (
                  <button key={preset.id} type="button" className="ai-recommendation-card" onClick={() => chooseLearningPrompt(preset.prompt)}>
                    <strong>{preset.title}</strong>
                    <small>{modeLabel(preset.mode)}</small>
                  </button>
                ))}
                <button type="button" className="ai-recommendation-card quiz" onClick={() => chooseLearningPrompt(RANGE_QUIZ_PROMPT)}>
                  <Sparkles size={17} />
                  <span>
                    <strong>抽测此范围</strong>
                    <small>跨记录出题，等待作答后批改</small>
                  </span>
                </button>
              </div>
              <button type="button" className="ai-more-learning-link" onClick={() => setLearningActionsOpen(true)}>
                <BookOpen size={16} />
                更多学习方式
              </button>
            </div>
          ) : (
            messages.map((message) => (
              <article key={message.id} className={`ai-bubble-row ${message.role} ${message.error ? "error" : ""}`}>
                {message.role === "assistant" && (
                  <span className="ai-avatar">
                    <Bot size={17} />
                  </span>
                )}
                <div className="ai-bubble">
                  <header>
                    <span>{message.role === "user" ? "你" : "AI"}</span>
                    <button type="button" onClick={() => void copy(message.content)}>
                      <Copy size={14} />
                      复制
                    </button>
                  </header>
                  <div className="ai-markdown">
                    {(messageAttachments[message.id] ?? []).length > 0 && (
                      <div className="ai-message-images">
                        {(messageAttachments[message.id] ?? []).map((image) => (
                          <AiChatImageThumb key={image.id} image={image} />
                        ))}
                      </div>
                    )}
                    <AiMarkdown content={message.content} />
                  </div>
                </div>
                {message.role === "user" && (
                  <span className="ai-avatar user">
                    <User size={17} />
                  </span>
                )}
              </article>
            ))
          )}
          {busy && (
            <article className="ai-bubble-row assistant">
              <span className="ai-avatar">
                <Bot size={17} />
              </span>
              <div className="ai-bubble typing">
                <RefreshCw size={16} className="spin" />
                正在思考...
              </div>
            </article>
          )}
          </section>

          {hasUnreadLatest && session && (
            <div className="ai-scroll-to-latest">
              <button type="button" onClick={() => scrollThreadToBottom()}>
                <ArrowDown size={16} />
                回到最新消息
              </button>
            </div>
          )}
        </section>

        {session && (
          <footer className="ai-composer">
            {pendingImages.length > 0 && (
              <div className="ai-pending-images">
                {pendingImages.map((image) => (
                  <AiChatImageThumb key={image.id} image={image} onRemove={() => void removePendingImage(image.id)} />
                ))}
              </div>
            )}
            <form
              className="ai-input-bar"
              onSubmit={(event) => {
                event.preventDefault();
                void send();
              }}
            >
              <div className="ai-input-tools">
                <button type="button" className="icon-button" disabled={busy} onClick={() => setLearningActionsOpen(true)} aria-label="选择学习方式" title="选择学习方式">
                  <BookOpen size={18} />
                </button>
                <button
                  type="button"
                  className="icon-button"
                  disabled={busy}
                  onClick={() => native ? setImageActionsOpen(true) : fileInputRef.current?.click()}
                  aria-label="添加图片"
                  title="添加图片"
                >
                  <ImagePlus size={18} />
                </button>
                <input
                  ref={fileInputRef}
                  type="file"
                  accept="image/*"
                  hidden
                  onChange={(event) => {
                    const file = event.target.files?.[0];
                    if (file) {
                      void addImageFile(file);
                    }
                    event.target.value = "";
                  }}
                />
              </div>
              <textarea
                ref={inputRef}
                value={input}
                onChange={(event) => setInput(event.target.value)}
                onKeyDown={(event) => {
                  if (!native && !busy && event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
                    event.preventDefault();
                    void send();
                  }
                }}
                placeholder="问问 AI..."
                rows={1}
              />
              {busy ? (
                <button type="button" className="ai-send-button" onClick={() => sendAbortRef.current?.abort()} aria-label="停止生成" title="停止生成">
                  <CircleStop size={18} />
                </button>
              ) : (
                <button type="submit" className="ai-send-button" disabled={!input.trim() && pendingImages.length === 0} aria-label="发送" title="发送">
                  <Send size={18} />
                </button>
              )}
            </form>
            {status && <p className="status-message">{status}</p>}
          </footer>
        )}
      </section>

      {contextDetailsOpen && attachment && (
        <div className="ai-action-backdrop ai-context-details-backdrop" onClick={() => setContextDetailsOpen(false)}>
          <section className="ai-context-details" onClick={(event) => event.stopPropagation()} role="dialog" aria-modal="true" aria-label="范围详情">
            <header>
              <div>
                <p className="eyebrow">Knowledge scope</p>
                <h2>范围详情</h2>
              </div>
              <button type="button" className="icon-button" onClick={() => setContextDetailsOpen(false)} aria-label="关闭范围详情">
                <X size={18} />
              </button>
            </header>
            <div className="ai-context-detail-groups">
              <section>
                <h3>范围与来源</h3>
                <dl>
                  <div><dt>当前范围</dt><dd>{attachment.scopeTitle ?? `${attachment.date} 日志附件`}</dd></div>
                  <div><dt>命中记录</dt><dd>{attachment.recordIds.length} 条</dd></div>
                  <div><dt>检索片段</dt><dd>{selectedChunkCount}/{totalChunkCount}</dd></div>
                </dl>
              </section>
              <section>
                <h3>图片与 OCR</h3>
                <dl>
                  <div><dt>可用图片文字</dt><dd>{includedImages} 张</dd></div>
                  <div><dt>未纳入图片</dt><dd>{skippedImages} 张</dd></div>
                  <div><dt>跳过资源</dt><dd>{skippedAssetCount} 个</dd></div>
                </dl>
              </section>
              {composerBudget && (
                <section>
                  <h3>检索与 Token</h3>
                  <dl>
                    <div><dt>检索策略</dt><dd>{composerBudget.retrievalMode === "coverage" ? "覆盖检索" : "聚焦检索"} {Math.round(composerBudget.retrievalTargetTokens / 1000)}K</dd></div>
                    <div><dt>预计输入</dt><dd>{composerBudget.estimatedInputTokens.toLocaleString()} token</dd></div>
                    <div><dt>最大输出</dt><dd>{composerBudget.outputTokens.toLocaleString()} token</dd></div>
                  </dl>
                </section>
              )}
              <section>
                <h3>会话状态</h3>
                <dl>
                  <div><dt>内容更新</dt><dd>每轮自动刷新</dd></div>
                  <div><dt>长对话记忆</dt><dd>{session?.memorySummary ? "已启用" : "尚未生成"}</dd></div>
                </dl>
              </section>
            </div>
            {attachment.warnings.length > 0 && (
              <div className="ai-context-detail-warnings" role="status">
                {attachment.warnings.map((warning) => <p key={warning}>{warning}</p>)}
              </div>
            )}
            <p className="ai-context-detail-note">AI 会优先使用命中片段，并在回答末尾标注依据来源。</p>
          </section>
        </div>
      )}

      {moreActionsOpen && (
        <div className="ai-action-backdrop" onClick={() => setMoreActionsOpen(false)}>
          <section className="ai-action-sheet ai-more-actions" onClick={(event) => event.stopPropagation()} role="dialog" aria-modal="true" aria-label="更多 AI 操作">
            <header>
              <h2>更多操作</h2>
              <button type="button" className="icon-button" onClick={() => setMoreActionsOpen(false)} aria-label="关闭更多操作">
                <X size={18} />
              </button>
            </header>
            <div className="ai-action-list">
              <button type="button" onClick={() => {
                setMoreActionsOpen(false);
                onOpenScopeScreen();
              }}>
                <Sparkles size={18} />
                <span><strong>新建知识库问答</strong><small>选择新的学习范围</small></span>
              </button>
              {session?.attachment && (
                <button type="button" onClick={() => {
                  setMoreActionsOpen(false);
                  void openNewChat();
                }}>
                  <MessageSquarePlus size={18} />
                  <span><strong>开启新对话</strong><small>复用当前学习范围</small></span>
                </button>
              )}
              <button type="button" onClick={() => {
                setMoreActionsOpen(false);
                onOpenSettings();
              }}>
                <Settings size={18} />
                <span><strong>AI 设置</strong><small>模型、预设与图片方式</small></span>
              </button>
              <button type="button" onClick={() => {
                setMoreActionsOpen(false);
                onOpenAiExport();
              }}>
                <Download size={18} />
                <span><strong>AI 材料导出</strong><small>导出为 Markdown / JSON / TXT</small></span>
              </button>
            </div>
          </section>
        </div>
      )}

      {learningActionsOpen && (
        <div className="ai-action-backdrop" onClick={() => setLearningActionsOpen(false)}>
          <section className="ai-action-sheet ai-learning-panel" onClick={(event) => event.stopPropagation()} role="dialog" aria-modal="true" aria-label="选择学习方式">
            <header>
              <div>
                <p className="eyebrow">Study mode</p>
                <h2>学习方式</h2>
              </div>
              <button type="button" className="icon-button" onClick={() => setLearningActionsOpen(false)} aria-label="关闭学习方式">
                <X size={18} />
              </button>
            </header>
            <div className="ai-learning-options">
              <button type="button" className="featured" onClick={() => chooseLearningPrompt(RANGE_QUIZ_PROMPT)}>
                <Sparkles size={18} />
                <span><strong>抽测此范围</strong><small>跨不同记录出题，作答后再批改</small></span>
              </button>
              {presets.map((preset) => (
                <button key={preset.id} type="button" onClick={() => chooseLearningPrompt(preset.prompt)}>
                  <BookOpen size={18} />
                  <span><strong>{preset.title}</strong><small>{modeLabel(preset.mode)}</small></span>
                </button>
              ))}
              {presets.length === 0 && <p className="helper-text">还没有保存学习预设，可以直接输入你的问题。</p>}
            </div>
          </section>
        </div>
      )}

      {imageActionsOpen && native && (
        <div className="ai-action-backdrop" onClick={() => setImageActionsOpen(false)}>
          <section className="ai-action-sheet ai-image-action-sheet" onClick={(event) => event.stopPropagation()} role="dialog" aria-modal="true" aria-label="添加图片">
            <header>
              <h2>添加图片</h2>
              <button type="button" className="icon-button" onClick={() => setImageActionsOpen(false)} aria-label="关闭添加图片">
                <X size={18} />
              </button>
            </header>
            <div className="ai-action-list">
              <button type="button" onClick={() => {
                setImageActionsOpen(false);
                void pickNativeImage(() => pickNativeCameraImageFile("ai-camera-image"));
              }}>
                <Camera size={18} />
                <span><strong>拍照</strong><small>拍摄后加入本轮对话</small></span>
              </button>
              <button type="button" onClick={() => {
                setImageActionsOpen(false);
                void pickNativeImage(() => pickNativeGalleryImageFile("ai-gallery-image"));
              }}>
                <ImagePlus size={18} />
                <span><strong>从相册选择</strong><small>选择一张图片加入对话</small></span>
              </button>
            </div>
          </section>
        </div>
      )}

      {historyOpen && (
        <div className="ai-history-backdrop" onClick={() => setHistoryOpen(false)}>
          <aside className="ai-history-drawer" onClick={(event) => event.stopPropagation()}>
            <header>
              <div>
                <p className="eyebrow">History</p>
                <h2>聊天记录</h2>
              </div>
              <button type="button" className="icon-button" onClick={() => setHistoryOpen(false)} aria-label="关闭历史记录">
                <X size={18} />
              </button>
            </header>
            <div className="ai-history-list">
              {sessions.length === 0 ? (
                <p className="helper-text">还没有 AI 聊天记录。</p>
              ) : (
                sessions.map((item) => (
                  <button
                    key={item.id}
                    type="button"
                    className={item.id === sessionId ? "active" : ""}
                    onClick={() => {
                      setHistoryOpen(false);
                      onOpenSession(item.id);
                    }}
                  >
                    <span>
                      <strong>{item.title}</strong>
                      <small>
                        <Clock3 size={13} />
                        {item.scopeTitle ?? item.attachment?.scopeTitle ?? item.sourceDate ?? item.updatedAt.slice(0, 10)} / {item.updatedAt.slice(11, 16)}
                      </small>
                    </span>
                    <Trash2
                      size={16}
                      onClick={(event) => {
                        event.stopPropagation();
                        void deleteSession(item.id);
                      }}
                    />
                  </button>
                ))
              )}
            </div>
          </aside>
        </div>
      )}
    </main>
  );
};
