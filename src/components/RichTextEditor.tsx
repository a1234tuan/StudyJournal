import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { EditorContent, useEditor, type Editor } from "@tiptap/react";
import { Extension, type JSONContent } from "@tiptap/core";
import { Fragment, Slice, type Node as ProseMirrorNode, type ResolvedPos } from "@tiptap/pm/model";
import * as pmView from "@tiptap/pm/view";
import type { EditorView } from "@tiptap/pm/view";
import { redoDepth, undoDepth } from "@tiptap/pm/history";
import { TextSelection, type SelectionBookmark, type Transaction } from "@tiptap/pm/state";
import { search as searchPlugin } from "prosemirror-search";
import { Check, ChevronDown, Highlighter, List, ListOrdered, MoreHorizontal, Paperclip, Redo2, RotateCcw, Target, Undo2, X } from "lucide-react";
import StarterKit from "@tiptap/starter-kit";
import Placeholder from "@tiptap/extension-placeholder";
import TaskList from "@tiptap/extension-task-list";
import TaskItem from "@tiptap/extension-task-item";
import CodeBlockLowlight from "@tiptap/extension-code-block-lowlight";
import { createLowlight } from "lowlight";
import bash from "highlight.js/lib/languages/bash";
import c from "highlight.js/lib/languages/c";
import cpp from "highlight.js/lib/languages/cpp";
import csharp from "highlight.js/lib/languages/csharp";
import css from "highlight.js/lib/languages/css";
import go from "highlight.js/lib/languages/go";
import java from "highlight.js/lib/languages/java";
import javascript from "highlight.js/lib/languages/javascript";
import json from "highlight.js/lib/languages/json";
import kotlin from "highlight.js/lib/languages/kotlin";
import php from "highlight.js/lib/languages/php";
import python from "highlight.js/lib/languages/python";
import ruby from "highlight.js/lib/languages/ruby";
import rust from "highlight.js/lib/languages/rust";
import sql from "highlight.js/lib/languages/sql";
import swift from "highlight.js/lib/languages/swift";
import typescript from "highlight.js/lib/languages/typescript";
import xml from "highlight.js/lib/languages/xml";
import yaml from "highlight.js/lib/languages/yaml";
import { RecordAssetNode, RecordFormulaNode, RecordInlineMathNode, RecordReferenceNode, RecordTabStopNode, type RecordReferenceTarget } from "./RecordEditorNodes";
import { ImageLightbox } from "./ImageLightbox";
import { MotionPresence } from "./MotionPresence";
import { RecordReferencePicker } from "./RecordReferencePicker";
import {
  RecordCollapseBlockNode,
  RecordComparisonTableNode,
  RecordStickyBoardNode,
  RecordStructureDiagramNode,
} from "./RecordStructureNodes";
import { RecordMermaidNode } from "./RecordMermaidNode";
import {
  highlightToneOptions,
  normalizeHighlightTone,
  RecordHighlightBlockNode,
  type HighlightTone,
} from "./RecordHighlightBlockNode";
import { SearchReplacePanel } from "./SearchReplacePanel";
import { RecordDecisionBlockNode } from "./RecordDecisionBlockNode";
import {
  decisionBlockPreview,
  newDecisionBlockId,
  type PendingDecisionBlockRemoval,
} from "../features/reviewCoach/decisionBlockContent";
import { nowISO } from "../lib/date";
import { computePopoverPosition, type PopoverPosition } from "../lib/popoverPosition";
import { createPortal } from "react-dom";
import {
  clipboardImageFiles,
  normalizeClipboardText,
  readClipboardImageFallback,
  readClipboardTextFallback,
  readNativeClipboardText,
  writeNativeClipboardText,
} from "../lib/clipboard";
import {
  MAX_MARKDOWN_PASTE_LENGTH,
  markdownToTiptapContent,
  normalizeCodeLanguage,
  selectMarkdownPasteSources,
} from "../lib/markdownEditor";
import { applyComposedMarkdownTransform, MarkdownTypingExtension } from "../lib/markdownInputRules";
import { MarkdownLinkMark } from "../lib/markdownLinkMark";
import { isDesktopPlatform, isNativePlatform } from "../lib/platform";
import { TrailingEditableParagraph } from "../lib/trailingEditableParagraph";
import {
  MARKDOWN_PASTE_LIMITS,
  assessMarkdownPaste,
  isUndoablePasteSource,
  type MarkdownPasteChunk,
} from "../lib/markdownPasteWork";
import type { RecordAssetRef, RecordBlock, SubjectConfig } from "../types";

const lowlight = createLowlight();
lowlight.register("bash", bash);
lowlight.register("c", c);
lowlight.register("cpp", cpp);
lowlight.register("csharp", csharp);
lowlight.register("css", css);
lowlight.register("go", go);
lowlight.register("java", java);
lowlight.register("javascript", javascript);
lowlight.register("json", json);
lowlight.register("kotlin", kotlin);
lowlight.register("php", php);
lowlight.register("python", python);
lowlight.register("ruby", ruby);
lowlight.register("rust", rust);
lowlight.register("sql", sql);
lowlight.register("swift", swift);
lowlight.register("typescript", typescript);
lowlight.register("xml", xml);
lowlight.register("yaml", yaml);

const HIGHLIGHT_MENU_WIDTH = 188;
const HIGHLIGHT_MENU_ESTIMATED_HEIGHT = 142;
const codeLanguageOptions = [
  { value: "", label: "纯文本" },
  { value: "javascript", label: "JavaScript" },
  { value: "typescript", label: "TypeScript" },
  { value: "python", label: "Python" },
  { value: "java", label: "Java" },
  { value: "cpp", label: "C++" },
  { value: "c", label: "C" },
  { value: "csharp", label: "C#" },
  { value: "go", label: "Go" },
  { value: "rust", label: "Rust" },
  { value: "kotlin", label: "Kotlin" },
  { value: "swift", label: "Swift" },
  { value: "php", label: "PHP" },
  { value: "ruby", label: "Ruby" },
  { value: "sql", label: "SQL" },
  { value: "bash", label: "Bash" },
  { value: "json", label: "JSON" },
  { value: "yaml", label: "YAML" },
  { value: "xml", label: "HTML/XML" },
  { value: "css", label: "CSS" },
];

type QueuedRecordImage = RecordAssetRef & {
  position: number;
};

type ImageGalleryState = {
  images: RecordAssetRef[];
  initialIndex: number;
};

type ReferencePickerState = {
  bookmark: SelectionBookmark;
};

const recordReferenceTargetMap = (records: readonly RecordBlock[]): Map<string, RecordReferenceTarget> =>
  new Map(
    records
      .filter((record) => !record.deletedAt)
      .map((record) => [record.id, { id: record.id, title: record.title || "未命名日志" }]),
  );

const collectRecordImageQueue = (doc: ProseMirrorNode): QueuedRecordImage[] => {
  const images: QueuedRecordImage[] = [];
  doc.descendants((node, position) => {
    if (node.type.name !== "recordAsset" || node.attrs.kind !== "image") {
      return true;
    }
    const id = String(node.attrs.assetId ?? "");
    if (!id) {
      return true;
    }
    images.push({
      id,
      kind: "image",
      title: String(node.attrs.title ?? "图片"),
      position,
    });
    return true;
  });
  return images;
};

const parseMarkdownPaste = (view: EditorView, source: string | undefined): unknown[] | undefined => {
  if (!source) {
    return undefined;
  }
  try {
    return markdownToTiptapContent(view.state.schema as never, source);
  } catch {
    return undefined;
  }
};

type InternalClipboardParser = (
  view: EditorView,
  text: string,
  html: string | null,
  plainText: boolean,
  context: ResolvedPos,
) => Slice | null;

type ClipboardSnapshot = {
  markdown: string;
  plainText: string;
  htmlText: string;
  files: File[];
  hasImageClipboardItem: boolean;
};

const ANDROID_IME_PASTE_DEBOUNCE_MS = 120;
const ANDROID_IME_PASTE_GUARD_MS = 2_000;
const EDITOR_HISTORY_DEPTH = 50;
const EDITOR_HISTORY_GROUP_DELAY_MS = 500;
const RECORD_EDITOR_RESET_HISTORY_META = "recordEditorResetHistory";
const ANDROID_IME_SESSION_CANCEL_KEYS = new Set([
  "ArrowDown",
  "ArrowLeft",
  "ArrowRight",
  "ArrowUp",
  "Backspace",
  "Delete",
  "End",
  "Home",
  "PageDown",
  "PageUp",
]);

type ChangedDocumentRange = {
  from: number;
  to: number;
};

type NativeInputPasteSession = {
  id: number;
  initialDoc: ProseMirrorNode;
  changedRange?: ChangedDocumentRange;
  isPaste: boolean;
  revision: number;
  expectedMarkdown: string | null | undefined;
  clipboardReadPending: boolean;
};

type PasteAnchor = {
  requestId: number;
  doc: ProseMirrorNode;
  bookmark: SelectionBookmark;
};

type MarkdownConversionProgress = {
  completed: number;
  total: number;
  retainedRaw?: boolean;
};

type MarkdownPasteConversionSession = {
  id: number;
  chunks: readonly MarkdownPasteChunk[];
  positions: number[];
  nextIndex: number;
  completed: number;
  skipped: number;
  cancelScheduledStep?: () => void;
};

type MarkdownPasteConversionOptions = {
  onCancel: () => void;
};

type MarkdownPasteInsertOptions = {
  bookmark?: SelectionBookmark;
  range?: ChangedDocumentRange;
  native: boolean;
  resetHistory?: boolean;
};

type PasteHistoryMode = "record" | "skip" | "reset";

const pasteHistoryMode = (source: string, resetHistory = false): PasteHistoryMode => {
  if (isUndoablePasteSource(source)) {
    return "record";
  }
  return resetHistory ? "reset" : "skip";
};

const selectHistoryBoundedPasteSource = (candidates: readonly (string | undefined)[]): string | undefined => {
  const markdownSource = selectMarkdownPasteSources(candidates)[0];
  if (markdownSource) {
    return markdownSource;
  }
  for (const candidate of candidates) {
    if (!candidate) {
      continue;
    }
    const normalized = normalizeClipboardText(candidate);
    if (normalized && !isUndoablePasteSource(normalized)) {
      return normalized;
    }
  }
  return undefined;
};

const applyPasteHistoryMode = (transaction: Transaction, mode: PasteHistoryMode): Transaction => {
  if (mode === "record") {
    return transaction;
  }
  transaction.setMeta("addToHistory", false);
  if (mode === "reset") {
    transaction.setMeta(RECORD_EDITOR_RESET_HISTORY_META, true);
  }
  return transaction;
};

const resetEditorHistory = (view: EditorView) => {
  const transaction = view.state.tr
    .setMeta("addToHistory", false)
    .setMeta(RECORD_EDITOR_RESET_HISTORY_META, true);
  view.dispatch(transaction);
};

declare module "@tiptap/core" {
  interface Commands<ReturnType> {
    markdownPasteConversion: {
      cancelMarkdownPasteConversion: () => ReturnType;
    };
  }
}

const MarkdownPasteConversionExtension = Extension.create<MarkdownPasteConversionOptions>({
  name: "markdownPasteConversion",

  addOptions() {
    return { onCancel: () => undefined };
  },

  addCommands() {
    return {
      cancelMarkdownPasteConversion: () => () => {
        this.options.onCancel();
        return true;
      },
    };
  },
});

const desktopEditorControlHasFocus = (): boolean => {
  const active = document.activeElement;
  return active instanceof HTMLElement && Boolean(active.closest("input, textarea, select, button"));
};

const DesktopEditorShortcuts = Extension.create({
  name: "desktopEditorShortcuts",

  addKeyboardShortcuts() {
    const setHeading = (level: 1 | 2 | 3 | 4) => () => {
      if (!isDesktopPlatform() || desktopEditorControlHasFocus()) {
        return false;
      }
      return this.editor.commands.setHeading({ level });
    };
    const setParagraph = () => {
      if (!isDesktopPlatform() || desktopEditorControlHasFocus()) {
        return false;
      }
      return this.editor.commands.setParagraph();
    };
    const insertTab = () => {
      if (!isDesktopPlatform() || desktopEditorControlHasFocus()) {
        return false;
      }
      const { state } = this.editor;
      if (state.selection.$from.parent.type.name === "codeBlock") {
        return this.editor.commands.insertContent("\t");
      }
      const tabStop = state.schema.nodes.recordTabStop;
      if (!tabStop) {
        return false;
      }
      return this.editor.commands.command(({ tr, dispatch }) => {
        if (dispatch) {
          dispatch(tr.replaceSelectionWith(tabStop.create()).scrollIntoView());
        }
        return true;
      });
    };
    const removeTab = () => {
      if (!isDesktopPlatform() || desktopEditorControlHasFocus()) {
        return false;
      }
      const { state } = this.editor;
      if (!state.selection.empty) {
        return true;
      }
      const { $from } = state.selection;
      const previousNode = $from.nodeBefore;
      if ($from.parent.type.name === "codeBlock" && previousNode?.isText && previousNode.text?.endsWith("\t")) {
        return this.editor.commands.command(({ tr, dispatch }) => {
          if (dispatch) {
            dispatch(tr.delete($from.pos - 1, $from.pos).scrollIntoView());
          }
          return true;
        });
      }
      if (previousNode?.type.name !== "recordTabStop") {
        return true;
      }
      return this.editor.commands.command(({ tr, dispatch }) => {
        if (dispatch) {
          dispatch(tr.delete($from.pos - previousNode.nodeSize, $from.pos).scrollIntoView());
        }
        return true;
      });
    };

    return {
      "Ctrl-1": setHeading(1),
      "Ctrl-2": setHeading(2),
      "Ctrl-3": setHeading(3),
      "Ctrl-4": setHeading(4),
      "Ctrl-0": setParagraph,
      Tab: insertTab,
      "Shift-Tab": removeTab,
    };
  },
});

const SearchReplaceExtension = Extension.create({
  name: "searchReplace",

  addProseMirrorPlugins() {
    return [searchPlugin()];
  },
});

const keepDesktopSelectionAboveViewportBottom = (view: EditorView): boolean => {
  if (!isDesktopPlatform() || !view.hasFocus() || view.composing) {
    return false;
  }
  window.requestAnimationFrame(() => {
    if (!view.hasFocus() || view.isDestroyed) {
      return;
    }
    const viewport = window.visualViewport;
    const viewportHeight = viewport?.height ?? window.innerHeight;
    const lineHeight = Number.parseFloat(window.getComputedStyle(view.dom).lineHeight) || 26;
    const safeBottom = Math.max(0, viewportHeight - lineHeight * 5 - 24);
    const caret = view.coordsAtPos(view.state.selection.head);
    if (caret.bottom > safeBottom) {
      window.scrollBy({ top: Math.ceil(caret.bottom - safeBottom), behavior: "auto" });
    }
  });
  return false;
};

const snapshotClipboardData = (clipboardData: DataTransfer | null | undefined): ClipboardSnapshot => ({
  markdown: clipboardData?.getData("text/markdown") || "",
  plainText: clipboardData?.getData("text/plain") || "",
  htmlText: clipboardData?.getData("text/html") || "",
  files: clipboardImageFiles(clipboardData),
  hasImageClipboardItem: Array.from(clipboardData?.items ?? []).some((item) => item.type.startsWith("image/")),
});

const serializeClipboardText = (slice: Slice): string =>
  slice.content.textBetween(0, slice.content.size, "\n\n", (node) => {
    const latex = String(node.attrs.latex ?? "");
    if (node.type.name === "recordInlineMath") {
      return `$${latex}$`;
    }
    if (node.type.name === "recordFormula") {
      return `$$\n${latex}\n$$`;
    }
    return node.type.spec.leafText?.(node) ?? "";
  });

// A native drag selection can cross a contentEditable=false atom NodeView
// without being reflected in ProseMirror's state selection. Read that range
// directly when copying so atom nodes (including formulas) remain in the slice.
const sliceFromNativeSelection = (view: EditorView): Slice | undefined => {
  const selection = view.dom.ownerDocument.defaultView?.getSelection?.();
  if (!selection || selection.rangeCount === 0 || selection.isCollapsed) {
    return undefined;
  }
  const range = selection.getRangeAt(0);
  const containsEndpoint = (node: Node | null): boolean => {
    if (!node) {
      return false;
    }
    const target = node.nodeType === 3 ? node.parentNode : node;
    return target ? view.dom.contains(target) : false;
  };
  if (!containsEndpoint(range.startContainer) || !containsEndpoint(range.endContainer)) {
    return undefined;
  }
  const start = view.posAtDOM(range.startContainer, range.startOffset, 1);
  const end = view.posAtDOM(range.endContainer, range.endOffset, -1);
  let from = Math.min(start, end);
  let to = Math.max(start, end);
  if (from < 0 || to <= from || to > view.state.doc.content.size) {
    return undefined;
  }

  // Chromium's range-to-editor-position conversion can step over a
  // contentEditable=false NodeView during a drag selection. The DOM range
  // still knows the atom was crossed, so expand the document slice to cover it.
  view.state.doc.descendants((node, position) => {
    if (node.type.name !== "recordInlineMath" && node.type.name !== "recordFormula") {
      return true;
    }
    const nodeDOM = view.nodeDOM(position);
    try {
      if (nodeDOM && range.intersectsNode(nodeDOM)) {
        from = Math.min(from, position);
        to = Math.max(to, position + node.nodeSize);
      }
    } catch {
      // Detached NodeViews cannot belong to the active editor selection.
    }
    return false;
  });

  try {
    return view.state.doc.slice(from, to);
  } catch {
    return undefined;
  }
};

const clipboardTextsMatch = (left: string, right: string): boolean =>
  normalizeClipboardText(left).replace(/\n+$/, "") === normalizeClipboardText(right).replace(/\n+$/, "");

const isClipboardTextPrefix = (partial: string, full: string): boolean => {
  const normalizedPartial = normalizeClipboardText(partial);
  const normalizedFull = normalizeClipboardText(full);
  return clipboardTextsMatch(normalizedPartial, normalizedFull) || normalizedFull.startsWith(normalizedPartial);
};

const withoutEmptyLines = (value: string): string =>
  normalizeClipboardText(value)
    .split("\n")
    .filter((line) => line.length > 0)
    .join("\n");

const clipboardTextsMatchWithImeLineBreaks = (left: string, right: string): boolean =>
  clipboardTextsMatch(left, right) || clipboardTextsMatch(withoutEmptyLines(left), withoutEmptyLines(right));

const isClipboardTextPrefixWithImeLineBreaks = (partial: string, full: string): boolean =>
  isClipboardTextPrefix(partial, full) || isClipboardTextPrefix(withoutEmptyLines(partial), withoutEmptyLines(full));

const findChangedDocumentRange = (
  initialDoc: ProseMirrorNode,
  currentDoc: ProseMirrorNode,
): ChangedDocumentRange | undefined => {
  const from = initialDoc.content.findDiffStart(currentDoc.content);
  const end = initialDoc.content.findDiffEnd(currentDoc.content);
  if (from === null || !end || end.b < from) {
    return undefined;
  }
  return { from, to: end.b };
};

const parseClipboardSlice = (
  view: EditorView,
  text: string,
  html: string,
  plainText: boolean,
): Slice | undefined => {
  const parser = (pmView as unknown as { __parseFromClipboard?: InternalClipboardParser }).__parseFromClipboard;
  if (!parser || (!text && !html)) {
    return undefined;
  }
  try {
    return parser(view, text, html || null, plainText, view.state.selection.$from) ?? undefined;
  } catch {
    return undefined;
  }
};

const findActiveHighlightBlock = (editor: Editor): { pos: number; node: ProseMirrorNode } | null => {
  const { selection } = editor.state;
  const selectedNode = "node" in selection ? (selection as { node?: ProseMirrorNode }).node : undefined;
  if (selectedNode?.type.name === "recordHighlightBlock") {
    return { pos: selection.from, node: selectedNode };
  }

  for (let depth = selection.$from.depth; depth > 0; depth -= 1) {
    const node = selection.$from.node(depth);
    if (node.type.name === "recordHighlightBlock") {
      return { pos: selection.$from.before(depth), node };
    }
  }

  return null;
};

const applyHighlightTone = (editor: Editor, tone: HighlightTone) => {
  const activeHighlight = findActiveHighlightBlock(editor);
  if (activeHighlight) {
    editor
      .chain()
      .focus()
      .command(({ tr }) => {
        tr.setNodeMarkup(activeHighlight.pos, undefined, {
          ...activeHighlight.node.attrs,
          tone,
        });
        return true;
      })
      .run();
    return;
  }

  editor
    .chain()
    .focus()
    .insertContent({
      type: "recordHighlightBlock",
      attrs: { tone },
      content: [{ type: "paragraph" }],
    })
    .run();
};

const HighlightInsertMenu = ({ editor }: { editor: Editor }) => {
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState<PopoverPosition | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const popoverRef = useRef<HTMLDivElement | null>(null);
  const pointerHandledRef = useRef(false);
  const activeTone = normalizeHighlightTone(findActiveHighlightBlock(editor)?.node.attrs.tone);

  const updatePosition = useCallback(() => {
    const trigger = triggerRef.current;
    if (!trigger) {
      return;
    }
    setPosition(computePopoverPosition(trigger.getBoundingClientRect(), {
      width: window.innerWidth,
      height: window.innerHeight,
    }, {
      width: HIGHLIGHT_MENU_WIDTH,
      height: popoverRef.current?.offsetHeight ?? HIGHLIGHT_MENU_ESTIMATED_HEIGHT,
      align: "right",
    }));
  }, []);

  const toggleOpen = () => setOpen((value) => !value);
  const selectTone = (tone: HighlightTone) => {
    applyHighlightTone(editor, tone);
    setOpen(false);
  };

  useLayoutEffect(() => {
    if (open) {
      updatePosition();
      const frame = window.requestAnimationFrame(updatePosition);
      return () => window.cancelAnimationFrame(frame);
    }
    return undefined;
  }, [open, updatePosition]);

  useEffect(() => {
    if (!open) {
      return undefined;
    }
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) {
        return;
      }
      if (triggerRef.current?.contains(target) || popoverRef.current?.contains(target)) {
        return;
      }
      setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setOpen(false);
      }
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    window.addEventListener("resize", updatePosition);
    window.addEventListener("scroll", updatePosition, true);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("resize", updatePosition);
      window.removeEventListener("scroll", updatePosition, true);
    };
  }, [open, updatePosition]);

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className={editor.isActive("recordHighlightBlock") ? "active" : ""}
        title="高亮块"
        aria-label="高亮块"
        aria-expanded={open}
        onPointerDown={(event) => {
          event.preventDefault();
          pointerHandledRef.current = true;
          toggleOpen();
        }}
        onMouseDown={(event) => event.preventDefault()}
        onClick={(event) => {
          event.preventDefault();
          if (pointerHandledRef.current) {
            pointerHandledRef.current = false;
            return;
          }
          toggleOpen();
        }}
      >
        <Highlighter size={16} />
        <ChevronDown size={12} />
      </button>
      {open && position && createPortal(
        <div
          ref={popoverRef}
          className="highlight-tone-popover highlight-insert-popover"
          data-placement={position.placement}
          style={{
            position: "fixed",
            top: position.top,
            left: position.left,
            width: HIGHLIGHT_MENU_WIDTH,
            maxHeight: position.maxHeight,
          }}
        >
          {highlightToneOptions.map((option) => (
            <button
              key={option.tone}
              type="button"
              className={`highlight-tone-option highlight-${option.tone}`}
              aria-pressed={activeTone === option.tone}
              onPointerDown={(event) => {
                event.preventDefault();
                pointerHandledRef.current = true;
                selectTone(option.tone);
              }}
              onMouseDown={(event) => event.preventDefault()}
              onClick={(event) => {
                event.preventDefault();
                if (pointerHandledRef.current) {
                  pointerHandledRef.current = false;
                  return;
                }
                selectTone(option.tone);
              }}
            >
              <span className={`highlight-tone-swatch highlight-${option.tone}`} />
              <span>{option.label}</span>
              {activeTone === option.tone && <Check size={14} />}
            </button>
          ))}
        </div>,
        document.body,
      )}
    </>
  );
};

interface RichTextEditorProps {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  renderInsertTools?: (editor: Editor) => React.ReactNode;
  readOnly?: boolean;
  highlightedAssetId?: string;
  onAssetChanged?: () => void;
  onAssetTitleChange?: (assetId: string, title: string) => Promise<void> | void;
  onPasteImage?: (file: File) => Promise<{ id: string; kind: "image"; title: string } | undefined> | { id: string; kind: "image"; title: string } | undefined;
  currentRecordId?: string;
  referenceRecords?: readonly RecordBlock[];
  referenceSubjects?: readonly SubjectConfig[];
  onOpenRecordReference?: (recordId: string) => void;
  findReplaceOpen?: boolean;
  onFindReplaceOpen?: () => void;
  onFindReplaceClose?: () => void;
  restorableDecisionBlocks?: readonly RestorableDecisionBlock[];
  onDecisionBlockRemoved?: (removal: PendingDecisionBlockRemoval) => void;
  onDecisionBlockRestored?: (archive: RestorableDecisionBlock) => void;
}

export interface RestorableDecisionBlock {
  archiveId: string;
  decisionBlockId: string;
  contentHtml: string;
  archivedAt: string;
}

const renewDecisionBlockIdentities = (slice: Slice): Slice => {
  const stamp = nowISO();
  const mapFragment = (fragment: Fragment): Fragment => {
    const nodes: ProseMirrorNode[] = [];
    fragment.forEach((node) => {
      const content = node.content.size > 0 ? mapFragment(node.content) : node.content;
      if (node.type.name === "recordDecisionBlock") {
        nodes.push(node.type.create({
          ...node.attrs,
          decisionBlockId: newDecisionBlockId(),
          contentVersion: 1,
          createdAt: stamp,
          updatedAt: stamp,
        }, content, node.marks));
      } else {
        nodes.push(node.copy(content));
      }
    });
    return Fragment.fromArray(nodes);
  };
  return new Slice(mapFragment(slice.content), slice.openStart, slice.openEnd);
};

const rawMarkdownChunkNode = (source: string): JSONContent => {
  const content: JSONContent[] = [];
  source.split("\n").forEach((line, index, lines) => {
    if (line) {
      content.push({ type: "text", text: line });
    }
    if (index < lines.length - 1) {
      content.push({ type: "hardBreak" });
    }
  });
  return content.length > 0 ? { type: "paragraph", content } : { type: "paragraph" };
};

const rawMarkdownText = (node: ProseMirrorNode): string =>
  node.textBetween(0, node.content.size, "\n", "\n");

const findRawMarkdownChunkPositions = (
  doc: ProseMirrorNode,
  chunks: readonly MarkdownPasteChunk[],
): number[] | undefined => {
  const positions: number[] = [];
  let searchFrom = 0;
  for (const chunk of chunks) {
    let matchedPosition: number | undefined;
    doc.descendants((node, pos) => {
      if (matchedPosition !== undefined || pos < searchFrom || node.type.name !== "paragraph") {
        return true;
      }
      if (rawMarkdownText(node) === chunk.source) {
        matchedPosition = pos;
        return false;
      }
      return true;
    });
    if (matchedPosition === undefined) {
      return undefined;
    }
    positions.push(matchedPosition);
    searchFrom = matchedPosition + 1;
  }
  return positions;
};

const insertRawMarkdownChunks = (
  view: EditorView,
  chunks: readonly MarkdownPasteChunk[],
  bookmark?: SelectionBookmark,
  range?: ChangedDocumentRange,
  historyMode: PasteHistoryMode = "record",
): number[] | undefined => {
  const nodes = chunks.map((chunk) => view.state.schema.nodeFromJSON(rawMarkdownChunkNode(chunk.source)));
  const transaction = view.state.tr;
  if (range) {
    const from = Math.max(0, Math.min(range.from, transaction.doc.content.size));
    const to = Math.max(from, Math.min(range.to, transaction.doc.content.size));
    let blockFrom = from;
    let blockTo = to;
    try {
      const $from = transaction.doc.resolve(from);
      const $to = transaction.doc.resolve(to);
      const sharedDepth = $from.sharedDepth(to);
      if ($from.depth > sharedDepth) {
        blockFrom = $from.before(sharedDepth + 1);
      }
      if ($to.depth > sharedDepth) {
        blockTo = $to.after(sharedDepth + 1);
      }
    } catch {
      // Native IMEs can report a range at a block edge. The clamped range is safe.
    }
    transaction.replace(blockFrom, blockTo, new Slice(Fragment.fromArray(nodes), 0, 0));
  } else {
    if (bookmark) {
      transaction.setSelection(bookmark.resolve(transaction.doc));
    }
    transaction.replaceSelection(new Slice(Fragment.fromArray(nodes), 0, 0));
  }
  view.dispatch(applyPasteHistoryMode(transaction, historyMode).scrollIntoView());
  return findRawMarkdownChunkPositions(view.state.doc, chunks);
};

const replaceSelectionWithContent = (
  view: EditorView,
  content: unknown[],
  bookmark?: SelectionBookmark,
  historyMode: PasteHistoryMode = "record",
) => {
  const nodes = content.map((item) => view.state.schema.nodeFromJSON(item));
  const transaction = view.state.tr;
  if (bookmark) {
    transaction.setSelection(bookmark.resolve(view.state.doc));
  }
  transaction.replaceSelection(Slice.maxOpen(Fragment.fromArray(nodes)));
  view.dispatch(applyPasteHistoryMode(transaction, historyMode).scrollIntoView());
};

const replaceRangeWithContent = (
  view: EditorView,
  content: unknown[],
  from: number,
  to: number,
  historyMode: PasteHistoryMode = "record",
) => {
  const nodes = content.map((item) => view.state.schema.nodeFromJSON(item));
  const docSize = view.state.doc.content.size;
  const rawFrom = Math.max(0, Math.min(from, docSize));
  const rawTo = Math.max(rawFrom, Math.min(to, docSize));
  let safeFrom = rawFrom;
  let safeTo = rawTo;
  try {
    const $from = view.state.doc.resolve(rawFrom);
    const $to = view.state.doc.resolve(rawTo);
    const sharedDepth = $from.sharedDepth(rawTo);
    if ($from.depth > sharedDepth) {
      safeFrom = $from.before(sharedDepth + 1);
    }
    if ($to.depth > sharedDepth) {
      safeTo = $to.after(sharedDepth + 1);
    }
  } catch {
    // Keep the clamped diff range when a native editor reports an invalid end.
  }
  const replacement = Slice.maxOpen(Fragment.fromArray(nodes));
  const transaction = view.state.tr.replace(safeFrom, safeTo, replacement);
  try {
    const cursor = Math.max(1, Math.min(transaction.doc.content.size, safeFrom + replacement.size));
    transaction.setSelection(TextSelection.near(transaction.doc.resolve(cursor), -1));
  } catch {
    // A block-only replacement can leave no inline endpoint. ProseMirror's
    // mapped selection remains the safest fallback in that case.
  }
  view.dispatch(applyPasteHistoryMode(transaction, historyMode).scrollIntoView());
};

const replaceSelectionWithSlice = (
  view: EditorView,
  slice: Slice,
  bookmark?: SelectionBookmark,
  historyMode: PasteHistoryMode = "record",
) => {
  const transaction = view.state.tr;
  if (bookmark) {
    transaction.setSelection(bookmark.resolve(view.state.doc));
  }
  transaction.replaceSelection(slice);
  view.dispatch(applyPasteHistoryMode(transaction, historyMode).scrollIntoView());
};

export const RichTextEditor = ({
  value,
  onChange,
  placeholder,
  renderInsertTools,
  readOnly = false,
  highlightedAssetId,
  onAssetChanged,
  onAssetTitleChange,
  onPasteImage,
  currentRecordId,
  referenceRecords = [],
  referenceSubjects = [],
  onOpenRecordReference,
  findReplaceOpen = false,
  onFindReplaceOpen,
  onFindReplaceClose,
  restorableDecisionBlocks = [],
  onDecisionBlockRemoved,
  onDecisionBlockRestored,
}: RichTextEditorProps) => {
  const [historyAvailability, setHistoryAvailability] = useState({ canUndo: false, canRedo: false });
  const [mobileToolbarExpanded, setMobileToolbarExpanded] = useState(false);
  const historyAvailabilityRef = useRef(historyAvailability);
  const onPasteImageRef = useRef(onPasteImage);
  const onChangeRef = useRef(onChange);
  const recordReferenceTargetsRef = useRef<Map<string, RecordReferenceTarget>>(recordReferenceTargetMap(referenceRecords));
  const recordReferenceListenersRef = useRef(new Set<() => void>());
  const onOpenRecordReferenceRef = useRef(onOpenRecordReference);
  const onFindReplaceOpenRef = useRef(onFindReplaceOpen);
  const onDecisionBlockRemovedRef = useRef(onDecisionBlockRemoved);
  const editorViewRef = useRef<EditorView | undefined>();
  const editorInstanceRef = useRef<Editor | undefined>();
  const currentRecordIdRef = useRef(currentRecordId);
  const pasteRequestRef = useRef(0);
  const pasteAnchorRef = useRef<PasteAnchor | undefined>();
  const bulkMarkdownConversionRef = useRef<MarkdownPasteConversionSession | undefined>();
  const markdownConversionSequenceRef = useRef(0);
  const mountedRef = useRef(true);
  const nativeInputSessionRef = useRef<NativeInputPasteSession | undefined>();
  const nativeInputSequenceRef = useRef(0);
  const nativeTypingTransformSuppressedRef = useRef(false);
  const nativeTypingTransformSkipOnceRef = useRef(false);
  const nativeTypingTransformSkipTimeoutRef = useRef<ReturnType<typeof setTimeout> | undefined>();
  const nativeInputGuardTimeoutRef = useRef<ReturnType<typeof setTimeout> | undefined>();
  const nativeInputDebounceTimeoutRef = useRef<ReturnType<typeof setTimeout> | undefined>();
  const [markdownConversionProgress, setMarkdownConversionProgress] = useState<MarkdownConversionProgress | undefined>();
  const [imageGallery, setImageGallery] = useState<ImageGalleryState | undefined>();
  const [referencePicker, setReferencePicker] = useState<ReferencePickerState | undefined>();

  const updateHistoryAvailability = useCallback((target: Editor) => {
    const next = {
      canUndo: undoDepth(target.state) > 0,
      canRedo: redoDepth(target.state) > 0,
    };
    const current = historyAvailabilityRef.current;
    if (current.canUndo === next.canUndo && current.canRedo === next.canRedo) {
      return;
    }
    historyAvailabilityRef.current = next;
    setHistoryAvailability(next);
  }, []);

  useEffect(() => {
    onPasteImageRef.current = onPasteImage;
  }, [onPasteImage]);
  useEffect(() => {
    onChangeRef.current = onChange;
  }, [onChange]);
  useEffect(() => {
    recordReferenceTargetsRef.current = recordReferenceTargetMap(referenceRecords);
    for (const listener of recordReferenceListenersRef.current) {
      listener();
    }
  }, [referenceRecords]);
  useEffect(() => {
    onOpenRecordReferenceRef.current = onOpenRecordReference;
  }, [onOpenRecordReference]);
  useEffect(() => {
    onFindReplaceOpenRef.current = onFindReplaceOpen;
  }, [onFindReplaceOpen]);
  useEffect(() => {
    onDecisionBlockRemovedRef.current = onDecisionBlockRemoved;
  }, [onDecisionBlockRemoved]);

  const openImageGallery = useCallback((assetRef: RecordAssetRef, position: number) => {
    const currentEditor = editorInstanceRef.current;
    if (!currentEditor || currentEditor.isDestroyed) {
      return;
    }
    const queue = collectRecordImageQueue(currentEditor.state.doc);
    const initialIndex = queue.findIndex((item) => item.position === position && item.id === assetRef.id);
    if (initialIndex < 0) {
      return;
    }
    setImageGallery({
      images: queue.map(({ position: _position, ...image }) => image),
      initialIndex,
    });
  }, []);
  useEffect(() => () => {
    mountedRef.current = false;
    pasteRequestRef.current += 1;
    pasteAnchorRef.current = undefined;
    const conversion = bulkMarkdownConversionRef.current;
    conversion?.cancelScheduledStep?.();
    bulkMarkdownConversionRef.current = undefined;
    if (nativeInputGuardTimeoutRef.current) {
      clearTimeout(nativeInputGuardTimeoutRef.current);
    }
    if (nativeInputDebounceTimeoutRef.current) {
      clearTimeout(nativeInputDebounceTimeoutRef.current);
    }
    if (nativeTypingTransformSkipTimeoutRef.current) {
      clearTimeout(nativeTypingTransformSkipTimeoutRef.current);
    }
  }, []);

  const emitCurrentEditorHtml = (view?: EditorView) => {
    const instance = editorInstanceRef.current;
    if (instance && !instance.isDestroyed) {
      onChangeRef.current(instance.getHTML());
      return;
    }
    // This fallback is only used while Tiptap is being mounted. In normal
    // operation the editor instance above is always available.
    if (view) {
      onChangeRef.current(view.dom.innerHTML);
    }
  };

  const refreshPasteAnchor = (view: EditorView, requestId: number) => {
    const anchor: PasteAnchor = {
      requestId,
      doc: view.state.doc,
      bookmark: view.state.selection.getBookmark(),
    };
    pasteAnchorRef.current = anchor;
    return anchor;
  };

  const mapActiveMarkdownConversionPositions = (mapping: { map: (position: number, assoc?: number) => number }) => {
    const conversion = bulkMarkdownConversionRef.current;
    if (!conversion) {
      return;
    }
    conversion.positions = conversion.positions.map((position) => mapping.map(position, -1));
  };

  const cancelMarkdownPasteConversion = (view = editorViewRef.current, emit = true) => {
    const conversion = bulkMarkdownConversionRef.current;
    if (!conversion) {
      setMarkdownConversionProgress((progress) => progress?.retainedRaw ? undefined : progress);
      return;
    }
    conversion.cancelScheduledStep?.();
    bulkMarkdownConversionRef.current = undefined;
    setMarkdownConversionProgress(undefined);
    if (emit) {
      emitCurrentEditorHtml(view);
    }
  };

  const scheduleMarkdownConversionStep = (view: EditorView, conversion: MarkdownPasteConversionSession) => {
    const run = () => {
      conversion.cancelScheduledStep = undefined;
      processMarkdownConversionBatch(view, conversion);
    };
    const idle = (window as Window & {
      requestIdleCallback?: (callback: () => void, options?: { timeout: number }) => number;
      cancelIdleCallback?: (handle: number) => void;
    }).requestIdleCallback;
    if (idle) {
      const handle = idle(run, { timeout: 80 });
      conversion.cancelScheduledStep = () => (window as Window & {
        cancelIdleCallback?: (handle: number) => void;
      }).cancelIdleCallback?.(handle);
      return;
    }
    const handle = window.setTimeout(run, 16);
    conversion.cancelScheduledStep = () => window.clearTimeout(handle);
  };

  const finishMarkdownConversion = (view: EditorView, conversion: MarkdownPasteConversionSession) => {
    if (bulkMarkdownConversionRef.current?.id !== conversion.id) {
      return;
    }
    bulkMarkdownConversionRef.current = undefined;
    setMarkdownConversionProgress(undefined);
    emitCurrentEditorHtml(view);
  };

  const processMarkdownConversionBatch = (view: EditorView, conversion: MarkdownPasteConversionSession) => {
    if (!mountedRef.current || bulkMarkdownConversionRef.current?.id !== conversion.id) {
      return;
    }
    if (conversion.nextIndex < 0) {
      finishMarkdownConversion(view, conversion);
      return;
    }

    const budget = isNativePlatform() ? MARKDOWN_PASTE_LIMITS.native : MARKDOWN_PASTE_LIMITS.web;
    const batch: number[] = [];
    let sourceLength = 0;
    let formulaCount = 0;
    while (conversion.nextIndex >= 0 && batch.length < budget.batchBlocks) {
      const index = conversion.nextIndex;
      const chunk = conversion.chunks[index];
      const exceedsBudget = batch.length > 0 && (
        sourceLength + chunk.source.length > budget.batchLength
        || formulaCount + chunk.formulaCount > budget.batchFormulas
      );
      if (exceedsBudget) {
        break;
      }
      batch.push(index);
      conversion.nextIndex -= 1;
      sourceLength += chunk.source.length;
      formulaCount += chunk.formulaCount;
    }

    if (batch.length === 0) {
      finishMarkdownConversion(view, conversion);
      return;
    }

    const transaction = view.state.tr;
    for (const index of batch) {
      const position = conversion.positions[index];
      const rawNode = transaction.doc.nodeAt(position);
      const chunk = conversion.chunks[index];
      if (!rawNode || rawNode.type.name !== "paragraph" || rawMarkdownText(rawNode) !== chunk.source) {
        conversion.skipped += 1;
        continue;
      }
      const parsed = parseMarkdownPaste(view, chunk.source);
      if (!parsed) {
        conversion.skipped += 1;
        continue;
      }
      try {
        const nodes = parsed.map((item) => view.state.schema.nodeFromJSON(item));
        transaction.replace(position, position + rawNode.nodeSize, new Slice(Fragment.fromArray(nodes), 0, 0));
      } catch {
        conversion.skipped += 1;
      }
    }

    transaction.setMeta("addToHistory", false);
    transaction.setMeta("markdownPasteConversion", true);
    mapActiveMarkdownConversionPositions(transaction.mapping);
    if (transaction.docChanged) {
      view.dispatch(transaction.scrollIntoView());
      const anchor = pasteAnchorRef.current;
      if (anchor) {
        refreshPasteAnchor(view, anchor.requestId);
      }
    }
    conversion.completed += batch.length;
    setMarkdownConversionProgress({ completed: conversion.completed, total: conversion.chunks.length });

    if (conversion.nextIndex < 0) {
      finishMarkdownConversion(view, conversion);
      return;
    }
    scheduleMarkdownConversionStep(view, conversion);
  };

  const startMarkdownPasteConversion = (
    view: EditorView,
    chunks: readonly MarkdownPasteChunk[],
    positions: number[],
  ) => {
    if (chunks.length === 0 || positions.length !== chunks.length) {
      return false;
    }
    cancelMarkdownPasteConversion(view, false);
    const conversion: MarkdownPasteConversionSession = {
      id: ++markdownConversionSequenceRef.current,
      chunks,
      positions,
      nextIndex: chunks.length - 1,
      completed: 0,
      skipped: 0,
    };
    bulkMarkdownConversionRef.current = conversion;
    setMarkdownConversionProgress({ completed: 0, total: chunks.length });
    scheduleMarkdownConversionStep(view, conversion);
    return true;
  };

  const beginPasteOperation = (view: EditorView): PasteAnchor => {
    cancelMarkdownPasteConversion(view);
    const requestId = ++pasteRequestRef.current;
    const anchor: PasteAnchor = {
      requestId,
      doc: view.state.doc,
      bookmark: view.state.selection.getBookmark(),
    };
    pasteAnchorRef.current = anchor;
    return anchor;
  };

  const isPasteAnchorCurrent = (view: EditorView, anchor: PasteAnchor): boolean => {
    if (!mountedRef.current || pasteAnchorRef.current?.requestId !== anchor.requestId || view.state.doc !== anchor.doc) {
      return false;
    }
    try {
      const expected = anchor.bookmark.resolve(view.state.doc);
      return view.state.selection.from === expected.from && view.state.selection.to === expected.to;
    } catch {
      return false;
    }
  };

  const cancelPendingPaste = (view?: EditorView, emitMarkdown = true) => {
    pasteRequestRef.current += 1;
    pasteAnchorRef.current = undefined;
    cancelMarkdownPasteConversion(view, emitMarkdown);
    const session = nativeInputSessionRef.current;
    if (session && view) {
      releaseNativeInputSession(session, false, view);
    }
  };

  const insertPastedAsset = async (view: EditorView, file: File, anchor?: PasteAnchor) => {
    if (anchor && !isPasteAnchorCurrent(view, anchor)) {
      return;
    }
    const anchorRequestId = anchor?.requestId;
    const asset = await onPasteImageRef.current?.(file);
    const currentAnchor = anchorRequestId === undefined
      ? undefined
      : pasteAnchorRef.current?.requestId === anchorRequestId
        ? pasteAnchorRef.current
        : undefined;
    if (
      !asset ||
      !mountedRef.current ||
      (anchorRequestId !== undefined && (!currentAnchor || !isPasteAnchorCurrent(view, currentAnchor)))
    ) {
      return;
    }
    const nodes = [
      {
        type: "recordAsset",
        attrs: { assetId: asset.id, kind: "image", title: asset.title },
      },
      { type: "paragraph" },
    ].map((item) => view.state.schema.nodeFromJSON(item));
    const transaction = view.state.tr;
    if (currentAnchor) {
      transaction.setSelection(currentAnchor.bookmark.resolve(view.state.doc));
    }
    transaction.replaceSelection(Slice.maxOpen(Fragment.fromArray(nodes)));
    mapActiveMarkdownConversionPositions(transaction.mapping);
    view.dispatch(transaction.scrollIntoView());
    if (anchorRequestId !== undefined) {
      const nextAnchor: PasteAnchor = {
        requestId: anchorRequestId,
        doc: view.state.doc,
        bookmark: view.state.selection.getBookmark(),
      };
      pasteAnchorRef.current = nextAnchor;
    }
  };

  const insertPastedAssets = async (view: EditorView, files: readonly File[], anchor?: PasteAnchor) => {
    for (const file of files) {
      await insertPastedAsset(view, file, anchor);
      if (anchor) {
        const currentAnchor = pasteAnchorRef.current;
        if (!currentAnchor || currentAnchor.requestId !== anchor.requestId) {
          return;
        }
        anchor = currentAnchor;
      }
    }
  };

  const readNativeText = async (): Promise<string | undefined> => {
    let timeout: number | undefined;
    const nativeText = await new Promise<string | undefined>((resolve) => {
      timeout = window.setTimeout(() => resolve(undefined), 1_500);
      void readNativeClipboardText().then(resolve, () => resolve(undefined));
    });
    if (timeout) {
      window.clearTimeout(timeout);
    }
    return nativeText || readClipboardTextFallback({ skipNative: true });
  };

  const insertMarkdownPaste = (
    view: EditorView,
    source: string,
    options: MarkdownPasteInsertOptions,
  ): boolean => {
    const normalizedSource = normalizeClipboardText(source);
    const historyMode = pasteHistoryMode(normalizedSource, options.resetHistory);
    const assessment = assessMarkdownPaste(normalizedSource, options.native);
    if (assessment.retainRaw) {
      const rawOnly: MarkdownPasteChunk[] = [{
        source: normalizedSource,
        kind: "paragraph",
        formulaCount: assessment.formulaCount,
      }];
      const positions = insertRawMarkdownChunks(view, rawOnly, options.bookmark, options.range, historyMode);
      if (positions) {
        setMarkdownConversionProgress({ completed: 0, total: 0, retainedRaw: true });
        return true;
      }
      return false;
    }

    if (assessment.shouldStream) {
      const positions = insertRawMarkdownChunks(view, assessment.chunks, options.bookmark, options.range, historyMode);
      return positions ? startMarkdownPasteConversion(view, assessment.chunks, positions) : false;
    }

    const parsedMarkdown = parseMarkdownPaste(view, normalizedSource);
    if (!parsedMarkdown) {
      return false;
    }
    if (options.range) {
      replaceRangeWithContent(view, parsedMarkdown, options.range.from, options.range.to, historyMode);
    } else {
      replaceSelectionWithContent(view, parsedMarkdown, options.bookmark, historyMode);
    }
    return true;
  };

  const processNativePaste = async (
    view: EditorView,
    clipboard: ClipboardSnapshot,
    inputSession?: NativeInputPasteSession,
  ) => {
    const anchor = beginPasteOperation(view);
    const requestId = anchor.requestId;
    const initialDoc = view.state.doc;
    let nativeText: string | undefined;
    try {
      nativeText = await readNativeText();
    } catch {
      nativeText = undefined;
    }

    if (!isPasteAnchorCurrent(view, anchor)) {
      return;
    }

    // Some Android WebViews report beforeinput as cancelable but still commit
    // the text. The input fallback will replace that raw range as one unit.
    if (inputSession && view.state.doc !== initialDoc) {
      return;
    }

    const targetBookmark = view.state.doc === initialDoc ? anchor.bookmark : undefined;
    if (!targetBookmark) {
      return;
    }
    const markdownSource = selectHistoryBoundedPasteSource([nativeText, clipboard.markdown, clipboard.plainText]);
    if (!isPasteAnchorCurrent(view, anchor)) {
      return;
    }
    const handledMarkdown = markdownSource
      ? insertMarkdownPaste(view, markdownSource, { bookmark: targetBookmark, native: true })
      : false;
    if (!handledMarkdown) {
      const normalizedNativeText = nativeText ? normalizeClipboardText(nativeText) : "";
      const fallbackText = clipboard.plainText ? normalizeClipboardText(clipboard.plainText) : normalizedNativeText;
      const historyMode = pasteHistoryMode(fallbackText);
      const slice = (clipboard.htmlText || fallbackText.length <= MAX_MARKDOWN_PASTE_LENGTH)
        ? parseClipboardSlice(view, fallbackText, clipboard.htmlText, !clipboard.htmlText)
        : undefined;
      if (slice) {
        replaceSelectionWithSlice(view, slice, targetBookmark, historyMode);
      } else if (fallbackText) {
        const transaction = view.state.tr;
        if (targetBookmark) {
          transaction.setSelection(targetBookmark.resolve(view.state.doc));
        }
        transaction.insertText(fallbackText);
        view.dispatch(applyPasteHistoryMode(transaction, historyMode).scrollIntoView());
      }
    }

    if (inputSession) {
      releaseNativeInputSession(inputSession, false, view);
    }

    const assetAnchor = refreshPasteAnchor(view, requestId);

    if (clipboard.files.length > 0) {
      await insertPastedAssets(view, clipboard.files, assetAnchor);
      return;
    }
    if (
      onPasteImageRef.current &&
      (clipboard.hasImageClipboardItem || (!nativeText && !clipboard.plainText && !clipboard.htmlText))
    ) {
      const image = await readClipboardImageFallback();
      if (image && isPasteAnchorCurrent(view, assetAnchor)) {
        await insertPastedAsset(view, image, assetAnchor);
      }
    }
  };

  const releaseNativeInputSession = (session: NativeInputPasteSession, replayTypingTransform: boolean, view: EditorView) => {
    if (nativeInputSessionRef.current?.id !== session.id) {
      return;
    }
    nativeInputSessionRef.current = undefined;
    nativeTypingTransformSuppressedRef.current = false;
    if (nativeInputGuardTimeoutRef.current) {
      clearTimeout(nativeInputGuardTimeoutRef.current);
      nativeInputGuardTimeoutRef.current = undefined;
    }
    if (nativeInputDebounceTimeoutRef.current) {
      clearTimeout(nativeInputDebounceTimeoutRef.current);
      nativeInputDebounceTimeoutRef.current = undefined;
    }
    if (replayTypingTransform) {
      applyComposedMarkdownTransform(view);
      return;
    }
    nativeTypingTransformSkipOnceRef.current = true;
    if (nativeTypingTransformSkipTimeoutRef.current) {
      clearTimeout(nativeTypingTransformSkipTimeoutRef.current);
    }
    nativeTypingTransformSkipTimeoutRef.current = setTimeout(() => {
      nativeTypingTransformSkipOnceRef.current = false;
      nativeTypingTransformSkipTimeoutRef.current = undefined;
    }, 0);
  };

  const captureNativeInputSession = (view: EditorView, isPaste = false): NativeInputPasteSession | undefined => {
    if (!(view.state.selection instanceof TextSelection)) {
      return undefined;
    }
    const current = nativeInputSessionRef.current;
    if (current) {
      current.isPaste ||= isPaste;
      current.revision += 1;
      return current;
    }
    const session: NativeInputPasteSession = {
      id: ++nativeInputSequenceRef.current,
      initialDoc: view.state.doc,
      isPaste,
      revision: 0,
      expectedMarkdown: undefined,
      clipboardReadPending: false,
    };
    nativeInputSessionRef.current = session;
    nativeTypingTransformSuppressedRef.current = true;
    if (nativeInputGuardTimeoutRef.current) {
      clearTimeout(nativeInputGuardTimeoutRef.current);
    }
    nativeInputGuardTimeoutRef.current = setTimeout(() => {
      releaseNativeInputSession(session, false, view);
    }, ANDROID_IME_PASTE_GUARD_MS);
    return session;
  };

  const finalizeNativeInputSession = (view: EditorView, session: NativeInputPasteSession) => {
    const revision = ++session.revision;
    if (nativeInputDebounceTimeoutRef.current) {
      clearTimeout(nativeInputDebounceTimeoutRef.current);
    }
    nativeInputDebounceTimeoutRef.current = setTimeout(() => {
      nativeInputDebounceTimeoutRef.current = undefined;
      void (async () => {
        if (
          !mountedRef.current ||
          nativeInputSessionRef.current?.id !== session.id ||
          session.revision !== revision
        ) {
          return;
        }

        const changedRange = findChangedDocumentRange(session.initialDoc, view.state.doc);
        if (!changedRange) {
          return;
        }
        session.changedRange = changedRange;

        if (session.expectedMarkdown === undefined) {
          if (session.clipboardReadPending) {
            return;
          }
          session.clipboardReadPending = true;
          let nativeText: string | undefined;
          try {
            nativeText = await readNativeText();
          } catch {
            nativeText = undefined;
          }
          if (!mountedRef.current || nativeInputSessionRef.current?.id !== session.id) {
            return;
          }
          session.clipboardReadPending = false;
          session.expectedMarkdown = selectHistoryBoundedPasteSource([nativeText]) ?? null;
          finalizeNativeInputSession(view, session);
          return;
        }

        const expectedMarkdown = session.expectedMarkdown;
        if (!expectedMarkdown) {
          releaseNativeInputSession(session, true, view);
          return;
        }

        const insertedText = normalizeClipboardText(view.state.doc.textBetween(changedRange.from, changedRange.to, "\n"));
        if (!isClipboardTextPrefixWithImeLineBreaks(insertedText, expectedMarkdown)) {
          releaseNativeInputSession(session, true, view);
          return;
        }

        if (!clipboardTextsMatchWithImeLineBreaks(insertedText, expectedMarkdown)) {
          return;
        }

        if (nativeInputSessionRef.current?.id !== session.id || session.revision !== revision) {
          return;
        }
        const handledMarkdown = insertMarkdownPaste(view, expectedMarkdown, {
          native: true,
          range: changedRange,
          resetHistory: true,
        });
        if (!handledMarkdown) {
          if (!isUndoablePasteSource(expectedMarkdown)) {
            resetEditorHistory(view);
          }
          releaseNativeInputSession(session, true, view);
          return;
        }
        releaseNativeInputSession(session, false, view);
      })();
    }, ANDROID_IME_PASTE_DEBOUNCE_MS);
  };

  const editor = useEditor({
    editable: !readOnly,
    extensions: [
      StarterKit.configure({
        codeBlock: false,
        history: {
          depth: EDITOR_HISTORY_DEPTH,
          newGroupDelay: EDITOR_HISTORY_GROUP_DELAY_MS,
        },
      }),
      MarkdownLinkMark,
      MarkdownTypingExtension.configure({
        shouldSkipInputTransform: () => nativeTypingTransformSuppressedRef.current || nativeTypingTransformSkipOnceRef.current,
        shouldEnableDesktopShortcuts: isDesktopPlatform,
      }),
      CodeBlockLowlight.configure({ lowlight }),
      TaskList,
      TaskItem.configure({ nested: true }),
      RecordAssetNode.configure({
        highlightedAssetId,
        onAssetChanged,
        onAssetTitleChange,
        onOpenImage: openImageGallery,
      }),
      RecordFormulaNode,
      RecordInlineMathNode,
      RecordTabStopNode,
      RecordReferenceNode.configure({
        resolveReference: (recordId: string) => recordReferenceTargetsRef.current.get(recordId),
        subscribeReferenceChanges: (listener: () => void) => {
          recordReferenceListenersRef.current.add(listener);
          return () => recordReferenceListenersRef.current.delete(listener);
        },
        onOpenReference: (recordId: string) => onOpenRecordReferenceRef.current?.(recordId),
      }),
      RecordStructureDiagramNode,
      RecordComparisonTableNode,
      RecordStickyBoardNode,
      RecordCollapseBlockNode,
      RecordMermaidNode,
      RecordHighlightBlockNode,
      RecordDecisionBlockNode.configure({
        onRemove: (removal) => onDecisionBlockRemovedRef.current?.(removal),
      }),
      TrailingEditableParagraph,
      DesktopEditorShortcuts,
      SearchReplaceExtension,
      MarkdownPasteConversionExtension.configure({
        onCancel: () => cancelMarkdownPasteConversion(),
      }),
      Placeholder.configure({
        placeholder: placeholder ?? "写下今天的学习、卡点、截图、公式或一点心得...",
      }),
    ],
    content: value,
    editorProps: {
      clipboardTextSerializer: serializeClipboardText,
      transformPasted: renewDecisionBlockIdentities,
      attributes: {
        class: "rich-editor",
        draggable: "false",
      },
      handleDOMEvents: {
        copy: (view, event) => {
          const slice = sliceFromNativeSelection(view)
            ?? (view.state.selection.empty ? undefined : view.state.selection.content());
          const clipboardData = (event as ClipboardEvent).clipboardData;
          if (!slice) {
            return false;
          }
          const { dom, text } = view.serializeForClipboard(slice);
          event.preventDefault();
          if (clipboardData) {
            clipboardData.clearData();
            clipboardData.setData("text/html", dom.innerHTML);
            clipboardData.setData("text/markdown", text);
            clipboardData.setData("text/plain", text);
          }
          if (isNativePlatform()) {
            void writeNativeClipboardText(text);
          }
          return true;
        },
        dragstart: (_view, event) => {
          event.preventDefault();
          return true;
        },
        pointerdown: (view) => {
          cancelPendingPaste(view);
          return false;
        },
        touchstart: (view) => {
          cancelPendingPaste(view);
          return false;
        },
        keydown: (view, event) => {
          if (isDesktopPlatform() && (event as KeyboardEvent).key === "f" && ((event as KeyboardEvent).ctrlKey || (event as KeyboardEvent).metaKey)) {
            event.preventDefault();
            onFindReplaceOpenRef.current?.();
            return true;
          }
          if (bulkMarkdownConversionRef.current || pasteAnchorRef.current || (isNativePlatform() && ANDROID_IME_SESSION_CANCEL_KEYS.has((event as KeyboardEvent).key))) {
            cancelPendingPaste(view);
          }
          return false;
        },
        beforeinput: (view, event) => {
          const inputEvent = event as InputEvent;
          if (!isNativePlatform()) {
            if ((bulkMarkdownConversionRef.current || pasteAnchorRef.current) && inputEvent.inputType !== "insertFromPaste" && inputEvent.inputType !== "insertFromPasteAsPlainText") {
              cancelPendingPaste(view);
            }
            return false;
          }
          if (inputEvent.isComposing || view.composing) {
            return false;
          }
          if (inputEvent.inputType === "insertFromPaste" || inputEvent.inputType === "insertFromPasteAsPlainText") {
            if (event.cancelable) {
              const session = captureNativeInputSession(view, true);
              event.preventDefault();
              void processNativePaste(view, snapshotClipboardData(inputEvent.dataTransfer), session);
              return true;
            }
            captureNativeInputSession(view, true);
            return false;
          }
          if (inputEvent.inputType === "insertText" || inputEvent.inputType === "insertReplacementText") {
            if (bulkMarkdownConversionRef.current || pasteAnchorRef.current) {
              cancelPendingPaste(view);
            }
            captureNativeInputSession(view);
          }
          return false;
        },
        input: (view, event) => {
          if (!isNativePlatform() || (event as InputEvent).isComposing) {
            return false;
          }
          const session = nativeInputSessionRef.current;
          const pendingPaste = pasteAnchorRef.current;
          if (pendingPaste && view.state.doc !== pendingPaste.doc && !session) {
            cancelPendingPaste(view);
          }
          if (bulkMarkdownConversionRef.current && !session) {
            // Some Android IMEs commit ordinary typing through input only. The
            // document has already changed at this point, so preserve it and
            // stop using positions captured for the older paste session.
            cancelPendingPaste(view);
          }
          if (session) {
            finalizeNativeInputSession(view, session);
          }
          return false;
        },
      },
      handleScrollToSelection: (view) => keepDesktopSelectionAboveViewportBottom(view),
      handlePaste: (view, event) => {
        if (isNativePlatform()) {
          event.preventDefault();
          const activeSession = nativeInputSessionRef.current;
          const session = activeSession?.isPaste ? activeSession : undefined;
          if (activeSession && !activeSession.isPaste) {
            releaseNativeInputSession(activeSession, false, view);
          }
          void processNativePaste(view, snapshotClipboardData(event.clipboardData), session);
          return true;
        }

        const clipboard = snapshotClipboardData(event.clipboardData);
        if (isDesktopPlatform() && view.state.selection.$from.parent.type.spec.code && clipboard.plainText) {
          event.preventDefault();
          cancelPendingPaste(view);
          const transaction = view.state.tr.insertText(clipboard.plainText);
          view.dispatch(applyPasteHistoryMode(transaction, pasteHistoryMode(clipboard.plainText)).scrollIntoView());
          return true;
        }
        const markdownSource = selectHistoryBoundedPasteSource([clipboard.markdown, clipboard.plainText]);
        if (markdownSource) {
          event.preventDefault();
          const anchor = beginPasteOperation(view);
          const handledMarkdown = insertMarkdownPaste(view, markdownSource, {
            bookmark: anchor.bookmark,
            native: false,
          });
          if (!handledMarkdown) {
            const transaction = view.state.tr;
            transaction.setSelection(anchor.bookmark.resolve(view.state.doc));
            transaction.insertText(normalizeClipboardText(markdownSource));
            const historyMode = pasteHistoryMode(normalizeClipboardText(markdownSource));
            view.dispatch(applyPasteHistoryMode(transaction, historyMode).scrollIntoView());
          }
          const assetAnchor = refreshPasteAnchor(view, anchor.requestId);
          void insertPastedAssets(view, clipboard.files, assetAnchor);
          return true;
        }

        if (clipboard.files.length > 0) {
          const hasTextOrHtml = Boolean(clipboard.markdown || clipboard.plainText || clipboard.htmlText);
          const anchor = beginPasteOperation(view);
          // Keep the browser's native text/HTML paste when Markdown parsing was
          // skipped or failed, then anchor image insertion after that paste.
          if (hasTextOrHtml) {
            window.setTimeout(() => {
              if (pasteRequestRef.current !== anchor.requestId || !mountedRef.current) {
                return;
              }
              const postPasteAnchor: PasteAnchor = {
                requestId: anchor.requestId,
                doc: view.state.doc,
                bookmark: view.state.selection.getBookmark(),
              };
              pasteAnchorRef.current = postPasteAnchor;
              void insertPastedAssets(view, clipboard.files, postPasteAnchor);
            }, 0);
            return false;
          }
          void insertPastedAssets(view, clipboard.files, anchor);
          event.preventDefault();
          return true;
        }

        const shouldReadClipboardImage = Boolean(
          onPasteImageRef.current &&
          !clipboard.markdown &&
          !clipboard.plainText &&
          ((event.clipboardData?.items?.length ?? 0) === 0 || clipboard.hasImageClipboardItem),
        );
        if (shouldReadClipboardImage) {
          const anchor = beginPasteOperation(view);
          void readClipboardImageFallback().then((file) => {
            if (file && isPasteAnchorCurrent(view, anchor)) {
              return insertPastedAsset(view, file, anchor);
            }
            return undefined;
          });
        }
        return false;
      },
    },
    onCreate: ({ editor }) => {
      editorInstanceRef.current = editor;
      editorViewRef.current = editor.view;
      updateHistoryAvailability(editor);
    },
    onTransaction: ({ editor }) => {
      updateHistoryAvailability(editor);
    },
    onUpdate: ({ editor }) => {
      if (!bulkMarkdownConversionRef.current) {
        onChangeRef.current(editor.getHTML());
      }
    },
  });

  useEffect(() => {
    if (!editor) {
      return;
    }
    const recordChanged = currentRecordIdRef.current !== currentRecordId;
    const contentChanged = value !== editor.getHTML();
    const shouldSync = recordChanged || (!bulkMarkdownConversionRef.current && contentChanged);
    if (shouldSync) {
      cancelPendingPaste(editor.view, false);
      const chain = editor.chain()
        .setMeta("addToHistory", false)
        .setMeta(RECORD_EDITOR_RESET_HISTORY_META, true);
      if (contentChanged) {
        chain.setContent(value, false);
      }
      chain.run();
    }
    if (!readOnly) {
      editor.commands.ensureTrailingEditableParagraph();
    }
    if (shouldSync) {
      resetEditorHistory(editor.view);
    }
    currentRecordIdRef.current = currentRecordId;
  }, [currentRecordId, editor, readOnly, value]);

  useEffect(() => {
    editor?.setEditable(!readOnly);
  }, [editor, readOnly]);

  if (!editor) {
    return null;
  }

  const codeLanguage = normalizeCodeLanguage(String(editor.getAttributes("codeBlock").language ?? "")) ?? "";

  const undo = () => {
    cancelPendingPaste(editor.view);
    editor.chain().focus().undo().run();
  };

  const redo = () => {
    cancelPendingPaste(editor.view);
    editor.chain().focus().redo().run();
  };

  const insertRecordReference = (record: RecordBlock) => {
    const referenceNode = editor.schema.nodes.recordReference;
    const pickerBookmark = referencePicker?.bookmark;
    if (!referenceNode || !pickerBookmark) {
      return;
    }
    try {
      const selection = pickerBookmark.resolve(editor.state.doc);
      const node = referenceNode.create({ recordId: record.id, title: record.title || "未命名日志" });
      const transaction = editor.state.tr.setSelection(selection).replaceSelectionWith(node).scrollIntoView();
      editor.view.dispatch(transaction);
      editor.commands.focus();
    } catch {
      // If the editor was replaced while the picker was open, closing it is
      // safer than inserting a reference at an unrelated fallback position.
    } finally {
      setReferencePicker(undefined);
    }
  };

  return (
    <div className={readOnly ? "editor-shell read-only" : "editor-shell"}>
      {!readOnly && (
        <div className={`editor-toolbar${mobileToolbarExpanded ? " mobile-tools-expanded" : ""}`} aria-label="编辑工具栏">
          <div className="editor-toolbar-primary">
            <button
              type="button"
              title="撤回（Ctrl+Z）"
              aria-label="撤回"
              disabled={!historyAvailability.canUndo}
              onClick={undo}
            >
              <Undo2 size={16} />
            </button>
            <button
              type="button"
              title="重做（Ctrl+Y）"
              aria-label="重做"
              disabled={!historyAvailability.canRedo}
              onClick={redo}
            >
              <Redo2 size={16} />
            </button>
            <button type="button" title="加粗" aria-label="加粗" onClick={() => editor.chain().focus().toggleBold().run()}>
              B
            </button>
            <select
              className="editor-heading-select"
              aria-label="标题级别"
              value={[1, 2, 3, 4, 5, 6].find((level) => editor.isActive("heading", { level })) ?? 0}
              onChange={(event) => {
                const level = Number(event.target.value);
                if (level === 0) {
                  editor.chain().focus().setParagraph().run();
                  return;
                }
                editor.chain().focus().toggleHeading({ level: level as 1 | 2 | 3 | 4 | 5 | 6 }).run();
              }}
            >
              <option value={0}>正文</option>
              {[1, 2, 3, 4, 5, 6].map((level) => <option key={level} value={level}>H{level}</option>)}
            </select>
            <button
              type="button"
              className={editor.isActive("bulletList") ? "active" : ""}
              title="无序列表"
              aria-label="无序列表"
              onClick={() => editor.chain().focus().toggleBulletList().run()}
            >
              <List size={16} />
            </button>
            <button
              type="button"
              className="editor-mobile-more-trigger"
              title={mobileToolbarExpanded ? "收起更多编辑工具" : "展开更多编辑工具"}
              aria-label={mobileToolbarExpanded ? "收起更多编辑工具" : "展开更多编辑工具"}
              aria-expanded={mobileToolbarExpanded}
              onClick={() => setMobileToolbarExpanded((expanded) => !expanded)}
            >
              <MoreHorizontal size={18} />
            </button>
          </div>
          <div className="editor-toolbar-secondary" aria-label="更多格式工具">
            <span className="editor-toolbar-group-label">格式</span>
            <button type="button" title="斜体" aria-label="斜体" onClick={() => editor.chain().focus().toggleItalic().run()}>
              I
            </button>
            <button type="button" title="二级标题" aria-label="二级标题" onClick={() => editor.chain().focus().toggleHeading({ level: 2 }).run()}>
              H
            </button>
            <button
              type="button"
              className={editor.isActive("orderedList") ? "active" : ""}
              title="有序列表"
              aria-label="有序列表"
              onClick={() => editor.chain().focus().toggleOrderedList().run()}
            >
              <ListOrdered size={16} />
            </button>
            <button type="button" className={editor.isActive("blockquote") ? "active" : ""} title="引用" aria-label="引用" onClick={() => editor.chain().focus().toggleBlockquote().run()}>
              “”
            </button>
            <button type="button" className={editor.isActive("codeBlock") ? "active" : ""} title="代码块" aria-label="代码块" onClick={() => editor.chain().focus().toggleCodeBlock().run()}>
              &lt;/&gt;
            </button>
            <select
              className="editor-code-language-select"
              aria-label="代码块语言"
              value={codeLanguage}
              onChange={(event) => {
                const language = normalizeCodeLanguage(event.target.value);
                const codeBlockLanguage = language ?? "plaintext";
                if (editor.isActive("codeBlock")) {
                  editor.chain().focus().updateAttributes("codeBlock", { language: codeBlockLanguage }).run();
                  return;
                }
                editor.chain().focus().setCodeBlock({ language: codeBlockLanguage }).run();
              }}
            >
              {codeLanguageOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
            </select>
            {currentRecordId && (
              <button
                type="button"
                title="引用日志"
                aria-label="引用日志"
                onClick={() => setReferencePicker({ bookmark: editor.state.selection.getBookmark() })}
              >
                <Paperclip size={16} />
              </button>
            )}
            <HighlightInsertMenu editor={editor} />
            <button
              type="button"
              className={editor.isActive("recordDecisionBlock") ? "active" : ""}
              title={editor.state.selection.empty ? "新建复习重点" : "标记为复习重点"}
              aria-label={editor.state.selection.empty ? "新建复习重点" : "标记为复习重点"}
              disabled={editor.isActive("recordDecisionBlock")}
              onClick={() => {
                const chain = editor.chain().focus();
                if (editor.state.selection.empty) {
                  chain.insertDecisionBlock().run();
                } else {
                  chain.wrapSelectionInDecisionBlock().run();
                }
              }}
            >
              <Target size={16} />
            </button>
            {restorableDecisionBlocks.length > 0 && (
              <label className="decision-block-restore-control" title="恢复已删除或已转为普通内容的复习重点">
                <RotateCcw size={15} />
                <select
                  aria-label="恢复复习重点"
                  value=""
                  onChange={(event) => {
                    const archive = restorableDecisionBlocks.find((item) => item.archiveId === event.target.value);
                    if (archive) {
                      editor.chain().focus().insertContent(archive.contentHtml).run();
                      onDecisionBlockRestored?.(archive);
                    }
                  }}
                >
                  <option value="">恢复</option>
                  {restorableDecisionBlocks.map((archive) => (
                    <option key={archive.archiveId} value={archive.archiveId}>
                      {decisionBlockPreview(archive.contentHtml)}
                    </option>
                  ))}
                </select>
              </label>
            )}
          </div>
          <div className="editor-toolbar-insert" aria-label="插入工具">
            <span className="editor-toolbar-group-label">插入</span>
            {renderInsertTools?.(editor)}
          </div>
        </div>
      )}
      {!readOnly && markdownConversionProgress && (
        <div className="markdown-conversion-status" role="status">
          {markdownConversionProgress.retainedRaw
            ? <span>内容过大，已保留 Markdown 原文。</span>
            : <span>正在转换 Markdown（{markdownConversionProgress.completed}/{markdownConversionProgress.total}）</span>}
          {!markdownConversionProgress.retainedRaw && (
            <button
              type="button"
              className="markdown-conversion-cancel"
              title="取消 Markdown 转换"
              aria-label="取消 Markdown 转换"
              onClick={() => editor.commands.cancelMarkdownPasteConversion()}
            >
              <X size={15} />
            </button>
          )}
        </div>
      )}
      {findReplaceOpen && editor && (
        <SearchReplacePanel editor={editor} readOnly={readOnly} onClose={() => onFindReplaceClose?.()} />
      )}
      <EditorContent editor={editor} />
      <MotionPresence present={Boolean(imageGallery)} variant="modal" className="image-lightbox-presence">
        {imageGallery && <ImageLightbox
          images={imageGallery.images}
          initialIndex={imageGallery.initialIndex}
          onClose={() => setImageGallery(undefined)}
        />}
      </MotionPresence>
      <MotionPresence present={Boolean(referencePicker && currentRecordId)} variant="modal" className="record-reference-presence">
        {referencePicker && currentRecordId && <RecordReferencePicker
          currentRecordId={currentRecordId}
          records={referenceRecords}
          subjects={referenceSubjects}
          onSelect={insertRecordReference}
          onClose={() => setReferencePicker(undefined)}
        />}
      </MotionPresence>
    </div>
  );
};
