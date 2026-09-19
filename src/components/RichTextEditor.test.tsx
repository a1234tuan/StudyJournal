import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { Editor } from "@tiptap/react";
import { closeHistory, redoDepth, undoDepth } from "@tiptap/pm/history";
import { NodeSelection } from "@tiptap/pm/state";
import { describe, expect, it, vi } from "vitest";

import {
  createDefaultComparisonTable,
  createDefaultStickyBoard,
  createDefaultStructureDiagram,
  serializeStructureData,
} from "../lib/recordStructureBlocks";
import { readClipboardTextFallback, writeNativeClipboardText } from "../lib/clipboard";
import { MAX_UNDOABLE_PASTE_BYTES } from "../lib/markdownPasteWork";
import { isDesktopPlatform, isNativePlatform } from "../lib/platform";
import { syncRecordRefsFromContent } from "../lib/recordContent";
import type { RecordBlock, SubjectConfig } from "../types";
import { RichTextEditor } from "./RichTextEditor";

vi.mock("../lib/platform", () => ({
  isNativePlatform: vi.fn(() => false),
  isDesktopPlatform: vi.fn(() => false),
}));

vi.mock("../lib/clipboard", async () => {
  const actual = await vi.importActual<typeof import("../lib/clipboard")>("../lib/clipboard");
  return {
    ...actual,
    readClipboardTextFallback: vi.fn(),
    writeNativeClipboardText: vi.fn().mockResolvedValue(true),
  };
});

vi.mock("./AssetPreview", () => ({
  AssetPreview: ({ assetRef, onDeleteImage, onOpenImage }: any) => (
    <article className="asset-card asset-card-view compact-image-card" data-testid="asset-preview" data-asset-id={assetRef?.id}>
      {onOpenImage && <button type="button" aria-label={`预览 ${assetRef.id}`} onClick={onOpenImage} />}
      {onDeleteImage && <button type="button" aria-label={`删除 ${assetRef.id}`} onClick={onDeleteImage} />}
    </article>
  ),
}));

vi.mock("./ImageLightbox", () => ({
  ImageLightbox: ({ images, initialIndex, onClose }: any) => (
    <div data-testid="image-lightbox" data-index={initialIndex} data-images={images.map((image: { id: string }) => image.id).join(",")}>
      <button type="button" aria-label="关闭" onClick={onClose} />
    </div>
  ),
}));

const setSelectionInsideText = (editor: Editor, text: string) => {
  let targetPos: number | undefined;
  editor.state.doc.descendants((node, pos) => {
    if (node.isText && node.text?.includes(text)) {
      targetPos = pos + 1;
      return false;
    }
    return true;
  });
  if (targetPos === undefined) {
    throw new Error(`Text not found: ${text}`);
  }
  editor.commands.setTextSelection(targetPos);
};

const appendHistoryEvent = (editor: Editor, text: string) => {
  const position = editor.state.doc.content.size - 1;
  editor.view.dispatch(closeHistory(editor.state.tr.insertText(text, position)));
};

const nativeInputEvent = (type: "beforeinput" | "input", inputType: string): InputEvent => {
  const event = new Event(type, { bubbles: true, cancelable: true }) as InputEvent;
  Object.defineProperty(event, "inputType", { configurable: true, value: inputType });
  Object.defineProperty(event, "isComposing", { configurable: true, value: false });
  return event;
};

const androidMarkdownSample = [
  "---",
  "",
  "### 整体规律总结",
  "",
  "- **破折号插入**：主语后紧跟一个由双破折号括起来的**名词短语同位语**。",
  "  - **被动不定式**：need **to be** encouraged",
].join("\r\n");

const inlineMathPasteSample = "$\\arcsin(\\sin\\theta)$ 真的等于 $\\theta$ 吗？";

const expectInlineMathPasteParagraph = (html: string) => {
  const document = new DOMParser().parseFromString(html, "text/html");
  const inlineMathNodes = Array.from(document.querySelectorAll("p > record-inline-math"));

  expect(inlineMathNodes).toHaveLength(2);
  expect(document.querySelectorAll("record-formula")).toHaveLength(0);
  expect(inlineMathNodes.map((node) => node.getAttribute("data-latex"))).toEqual([
    "\\arcsin(\\sin\\theta)",
    "\\theta",
  ]);
  expect(inlineMathNodes[0].nextSibling?.textContent).toBe(" 真的等于 ");
  expect(inlineMathNodes[1].nextSibling?.textContent).toBe(" 吗？");
  expect(inlineMathNodes[0].parentElement).toBe(inlineMathNodes[1].parentElement);
};

const referenceRecord = (id: string, title: string, subject = "数学"): RecordBlock => ({
  id,
  createdAt: "2026-07-21T00:00:00.000Z",
  updatedAt: "2026-07-21T00:00:00.000Z",
  type: "record",
  date: "2026-07-21",
  order: 0,
  subject,
  tags: [],
  title,
  contentHtml: "<p></p>",
  assets: [],
  formulas: [],
  mistakeRefs: [],
});

const referenceSubjects: SubjectConfig[] = [{
  id: "subject-math",
  createdAt: "2026-07-21T00:00:00.000Z",
  updatedAt: "2026-07-21T00:00:00.000Z",
  name: "数学",
  order: 0,
}];

describe("RichTextEditor", () => {
  it("renders an ordered-list toolbar action", () => {
    render(<RichTextEditor value="<p>Item</p>" onChange={vi.fn()} />);

    expect(screen.getByRole("button", { name: "撤回" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "重做" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "有序列表" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "高亮块" })).toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: "标题级别" })).toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: "代码块语言" })).toBeInTheDocument();
    const moreTools = screen.getByRole("button", { name: "展开更多编辑工具" });
    expect(moreTools).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(moreTools);
    expect(screen.getByRole("button", { name: "收起更多编辑工具" })).toHaveAttribute("aria-expanded", "true");
  });

  it("creates a decision block with a stable identity and version one", async () => {
    const onChange = vi.fn();
    render(<RichTextEditor value="<p>正文</p>" onChange={onChange} />);

    fireEvent.click(screen.getByRole("button", { name: /复习重点/ }));

    await waitFor(() => expect(onChange).toHaveBeenCalled());
    const html = onChange.mock.calls.at(-1)?.[0] as string;
    const node = new DOMParser().parseFromString(html, "text/html").querySelector("record-decision-block");
    expect(node?.getAttribute("data-decision-block-id")).toBeTruthy();
    expect(node?.getAttribute("data-content-version")).toBe("1");
    expect(node?.getAttribute("data-created-at")).toBeTruthy();
  });

  it("activates decision-block controls for a text selection inside the block", async () => {
    let editorRef: Editor | undefined;
    const { container } = render(
      <RichTextEditor
        value={'<record-decision-block data-decision-block-id="focus-block" data-content-version="1"><p>需要复习的内容</p></record-decision-block><p>普通正文</p>'}
        onChange={vi.fn()}
        renderInsertTools={(editor) => {
          editorRef = editor;
          return null;
        }}
      />,
    );
    await waitFor(() => expect(editorRef).toBeDefined());

    act(() => editorRef!.commands.setTextSelection(2));

    const block = container.querySelector(".record-decision-block");
    await waitFor(() => expect(block).toHaveClass("selection-inside"));
    const content = block?.querySelector(".decision-block-content");
    const toolbar = block?.querySelector(".decision-block-toolbar");
    expect(content?.compareDocumentPosition(toolbar!)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);

    act(() => editorRef!.commands.setTextSelection(editorRef!.state.doc.content.size - 1));
    await waitFor(() => expect(block).not.toHaveClass("selection-inside"));
  });

  it("wraps selected existing content as a decision block", async () => {
    let editorRef: Editor | undefined;
    const onChange = vi.fn();
    render(
      <RichTextEditor
        value="<p>第一段</p><p>第二段</p>"
        onChange={onChange}
        renderInsertTools={(editor) => {
          editorRef = editor;
          return null;
        }}
      />,
    );
    await waitFor(() => expect(editorRef).toBeDefined());
    act(() => {
      editorRef!.commands.setTextSelection({ from: 1, to: editorRef!.state.doc.content.size - 1 });
    });

    fireEvent.click(screen.getByRole("button", { name: /复习重点/ }));

    await waitFor(() => expect(onChange).toHaveBeenCalled());
    const html = onChange.mock.calls.at(-1)?.[0] as string;
    expect(html).toContain("<record-decision-block");
    expect(html).toContain("第一段");
    expect(html).toContain("第二段");
  });

  it("restores an archived decision block at the current selection", async () => {
    const onChange = vi.fn();
    render(
      <RichTextEditor
        value="<p>现有正文</p>"
        onChange={onChange}
        restorableDecisionBlocks={[{
          archiveId: "archive-1",
          decisionBlockId: "restored-block",
          archivedAt: "2026-09-04T00:00:00.000Z",
          contentHtml: '<record-decision-block data-decision-block-id="restored-block" data-content-version="2"><p>恢复内容</p></record-decision-block>',
        }]}
      />,
    );

    fireEvent.change(screen.getByRole("combobox", { name: "恢复复习重点" }), { target: { value: "archive-1" } });

    await waitFor(() => expect(onChange).toHaveBeenCalled());
    expect(onChange.mock.calls.at(-1)?.[0]).toContain('data-decision-block-id="restored-block"');
  });

  it("copies a decision block with a new identity and keeps the original content", async () => {
    const onChange = vi.fn();
    render(
      <RichTextEditor
        value={'<record-decision-block data-decision-block-id="original" data-content-version="4" data-created-at="2026-09-01T00:00:00.000Z" data-updated-at="2026-09-02T00:00:00.000Z"><p>需要复习的内容</p></record-decision-block>'}
        onChange={onChange}
      />,
    );

    fireEvent.click(await screen.findByRole("button", { name: "复制复习重点" }));

    await waitFor(() => expect(onChange).toHaveBeenCalled());
    const html = onChange.mock.calls.at(-1)?.[0] as string;
    const nodes = Array.from(new DOMParser().parseFromString(html, "text/html").querySelectorAll("record-decision-block"));
    expect(nodes).toHaveLength(2);
    expect(nodes.map((node) => node.getAttribute("data-decision-block-id"))).toEqual(["original", expect.any(String)]);
    expect(nodes[1].getAttribute("data-decision-block-id")).not.toBe("original");
    expect(nodes[1].getAttribute("data-content-version")).toBe("1");
    expect(nodes[1].textContent).toContain("需要复习的内容");
  });

  it("repairs duplicate decision identities from programmatic content insertion", async () => {
    let editorRef: Editor | undefined;
    const onChange = vi.fn();
    render(
      <RichTextEditor
        value={'<record-decision-block data-decision-block-id="original" data-content-version="3"><p>已有内容</p></record-decision-block>'}
        onChange={onChange}
        renderInsertTools={(editor) => {
          editorRef = editor;
          return null;
        }}
      />,
    );
    await waitFor(() => expect(editorRef).toBeDefined());

    act(() => {
      editorRef!.commands.insertContent('<record-decision-block data-decision-block-id="original" data-content-version="3"><p>模板内容</p></record-decision-block>');
    });

    await waitFor(() => expect(onChange).toHaveBeenCalled());
    const nodes = Array.from(new DOMParser().parseFromString(onChange.mock.calls.at(-1)?.[0] as string, "text/html").querySelectorAll("record-decision-block"));
    expect(nodes).toHaveLength(2);
    expect(nodes[0].getAttribute("data-decision-block-id")).toBe("original");
    expect(nodes[1].getAttribute("data-decision-block-id")).not.toBe("original");
    expect(nodes[1].getAttribute("data-content-version")).toBe("1");
  });

  it("reports the complete fragment before converting a decision block to plain content", async () => {
    const onChange = vi.fn();
    const onDecisionBlockRemoved = vi.fn();
    render(
      <RichTextEditor
        value={'<record-decision-block data-decision-block-id="original" data-content-version="2"><p>结论</p><record-asset data-asset-id="image-1" data-kind="image" data-title="图"></record-asset></record-decision-block>'}
        onChange={onChange}
        onDecisionBlockRemoved={onDecisionBlockRemoved}
      />,
    );

    fireEvent.click(await screen.findByRole("button", { name: "转为普通内容" }));

    expect(onDecisionBlockRemoved).toHaveBeenCalledWith(expect.objectContaining({
      decisionBlockId: "original",
      reason: "converted-to-plain",
      contentHtml: expect.stringContaining('data-asset-id="image-1"'),
    }));
    await waitFor(() => expect(onChange).toHaveBeenCalledWith(expect.not.stringContaining("record-decision-block")));
  });

  it("uses the toolbar to undo and redo a deleted formula node", async () => {
    let editorRef: Editor | undefined;
    render(
      <RichTextEditor
        value={'<p>结论</p><record-formula data-formula-id="formula-1" data-title="公式" data-latex="x^2"></record-formula>'}
        onChange={vi.fn()}
        renderInsertTools={(editor) => {
          editorRef = editor;
          return null;
        }}
      />,
    );

    await waitFor(() => expect(editorRef).toBeDefined());
    const scrollableView = editorRef!.view as unknown as { scrollToSelection: () => void };
    const originalScrollToSelection = scrollableView.scrollToSelection;
    scrollableView.scrollToSelection = () => undefined;
    let formulaPosition: number | undefined;
    let formulaSize = 0;
    editorRef!.state.doc.descendants((node, position) => {
      if (node.type.name === "recordFormula") {
        formulaPosition = position;
        formulaSize = node.nodeSize;
        return false;
      }
      return true;
    });
    expect(formulaPosition).toBeDefined();

    act(() => {
      editorRef!.view.dispatch(editorRef!.state.tr.delete(formulaPosition!, formulaPosition! + formulaSize));
    });

    await waitFor(() => expect(screen.getByRole("button", { name: "撤回" })).toBeEnabled());
    expect(editorRef?.getHTML()).not.toContain("record-formula");

    fireEvent.click(screen.getByRole("button", { name: "撤回" }));
    await waitFor(() => expect(editorRef?.getHTML()).toContain("record-formula"));
    expect(screen.getByRole("button", { name: "重做" })).toBeEnabled();

    fireEvent.click(screen.getByRole("button", { name: "重做" }));
    await waitFor(() => expect(editorRef?.getHTML()).not.toContain("record-formula"));
    scrollableView.scrollToSelection = originalScrollToSelection;
  });

  it("caps history at 50 entries to bound editor memory", async () => {
    let editorRef: Editor | undefined;
    render(
      <RichTextEditor
        value="<p>内容</p>"
        onChange={vi.fn()}
        renderInsertTools={(editor) => {
          editorRef = editor;
          return null;
        }}
      />,
    );

    await waitFor(() => expect(editorRef).toBeDefined());
    const history = editorRef!.extensionManager.extensions.find((extension) => extension.name === "history");

    expect(history?.options).toMatchObject({ depth: 50, newGroupDelay: 500 });
  });

  it("keeps exactly 50 history events and discards the oldest event immediately", async () => {
    let editorRef: Editor | undefined;
    render(
      <RichTextEditor
        value="<p></p>"
        onChange={vi.fn()}
        renderInsertTools={(editor) => {
          editorRef = editor;
          return null;
        }}
      />,
    );

    await waitFor(() => expect(editorRef).toBeDefined());
    const changes = Array.from({ length: 51 }, (_, index) => String.fromCharCode(65 + index));
    act(() => {
      changes.forEach((change) => appendHistoryEvent(editorRef!, change));
    });

    expect(undoDepth(editorRef!.state)).toBe(50);
    act(() => {
      Array.from({ length: 50 }).forEach(() => editorRef!.commands.undo());
    });
    expect(undoDepth(editorRef!.state)).toBe(0);
    expect(redoDepth(editorRef!.state)).toBe(50);
    expect(editorRef!.getText().trim()).toBe(changes[0]);

    act(() => {
      Array.from({ length: 50 }).forEach(() => editorRef!.commands.redo());
    });
    expect(redoDepth(editorRef!.state)).toBe(0);
    expect(editorRef!.getText().trim()).toBe(changes.join("\n\n"));
  });

  it("groups adjacent input inside 500ms and starts a new event after the delay", async () => {
    let editorRef: Editor | undefined;
    render(
      <RichTextEditor
        value="<p></p>"
        onChange={vi.fn()}
        renderInsertTools={(editor) => {
          editorRef = editor;
          return null;
        }}
      />,
    );

    await waitFor(() => expect(editorRef).toBeDefined());
    act(() => {
      editorRef!.view.dispatch(editorRef!.state.tr.insertText("A", 1).setTime(1_000));
      editorRef!.view.dispatch(editorRef!.state.tr.insertText("B", 2).setTime(1_499));
      editorRef!.view.dispatch(editorRef!.state.tr.insertText("C", 3).setTime(2_000));
    });

    expect(undoDepth(editorRef!.state)).toBe(2);
    act(() => editorRef!.commands.undo());
    expect(editorRef!.getText().trim()).toBe("AB");
  });

  it("clears undo and redo history when external content or the record changes", async () => {
    let editorRef: Editor | undefined;
    const onChange = vi.fn();
    const { rerender } = render(
      <RichTextEditor
        value="<p>本地内容</p>"
        onChange={onChange}
        currentRecordId="record-a"
        renderInsertTools={(editor) => {
          editorRef = editor;
          return null;
        }}
      />,
    );

    await waitFor(() => expect(editorRef).toBeDefined());
    act(() => appendHistoryEvent(editorRef!, "!"));
    await waitFor(() => expect(undoDepth(editorRef!.state)).toBe(1));

    rerender(
      <RichTextEditor
        value="<p>服务器内容</p>"
        onChange={onChange}
        currentRecordId="record-a"
        renderInsertTools={(editor) => {
          editorRef = editor;
          return null;
        }}
      />,
    );
    await waitFor(() => expect(editorRef!.getHTML()).toBe("<p>服务器内容</p><p></p>"));
    expect(undoDepth(editorRef!.state)).toBe(0);
    expect(redoDepth(editorRef!.state)).toBe(0);

    act(() => appendHistoryEvent(editorRef!, "!"));
    const currentHtml = editorRef!.getHTML();
    rerender(
      <RichTextEditor
        value={currentHtml}
        onChange={onChange}
        currentRecordId="record-b"
        renderInsertTools={(editor) => {
          editorRef = editor;
          return null;
        }}
      />,
    );
    await waitFor(() => expect(undoDepth(editorRef!.state)).toBe(0));
    expect(redoDepth(editorRef!.state)).toBe(0);
  });

  it("does not write a cancelled Markdown conversion into externally supplied record content", async () => {
    const onChange = vi.fn();
    const streamedMarkdown = Array.from({ length: 81 }, (_, index) => `### 第 ${index} 节\n\n转换内容`).join("\n\n");
    const { rerender } = render(
      <RichTextEditor
        value="<p></p>"
        onChange={onChange}
        currentRecordId="record-a"
      />,
    );

    fireEvent.paste(document.querySelector(".rich-editor")!, {
      clipboardData: {
        getData: (type: string) => type === "text/plain" ? streamedMarkdown : "",
        items: [],
      },
    });
    await waitFor(() => expect(screen.getByText(/正在转换 Markdown/)).toBeInTheDocument());
    onChange.mockClear();

    rerender(
      <RichTextEditor
        value="<p>服务器内容</p>"
        onChange={onChange}
        currentRecordId="record-b"
      />,
    );

    await waitFor(() => expect(document.querySelector(".rich-editor")?.textContent).toContain("服务器内容"));
    expect(onChange.mock.calls.some(([html]) => String(html).includes("第 0 节"))).toBe(false);
  });

  it("supports keyboard undo and redo without being intercepted by paste handling", async () => {
    let editorRef: Editor | undefined;
    render(
      <RichTextEditor
        value="<p></p>"
        onChange={vi.fn()}
        renderInsertTools={(editor) => {
          editorRef = editor;
          return null;
        }}
      />,
    );

    await waitFor(() => expect(editorRef).toBeDefined());
    act(() => appendHistoryEvent(editorRef!, "A"));
    const editorElement = document.querySelector(".rich-editor")!;

    fireEvent.keyDown(editorElement, { key: "z", ctrlKey: true });
    await waitFor(() => expect(editorRef!.getText().trim()).toBe(""));
    fireEvent.keyDown(editorElement, { key: "z", ctrlKey: true, shiftKey: true });
    await waitFor(() => expect(editorRef!.getText().trim()).toBe("A"));
  });

  it("restores the same image asset reference when undoing and redoing its deletion", async () => {
    let editorRef: Editor | undefined;
    render(
      <RichTextEditor
        value={'<record-asset data-asset-id="ocr-complete-image" data-kind="image" data-title="OCR 完成"></record-asset><p></p>'}
        onChange={vi.fn()}
        renderInsertTools={(editor) => {
          editorRef = editor;
          return null;
        }}
      />,
    );

    await waitFor(() => expect(editorRef).toBeDefined());
    let assetPosition: number | undefined;
    let assetSize = 0;
    editorRef!.state.doc.descendants((node, position) => {
      if (node.type.name === "recordAsset") {
        assetPosition = position;
        assetSize = node.nodeSize;
        return false;
      }
      return true;
    });

    act(() => editorRef!.view.dispatch(editorRef!.state.tr.delete(assetPosition!, assetPosition! + assetSize)));
    act(() => editorRef!.commands.undo());
    expect(editorRef!.getHTML()).toContain('data-asset-id="ocr-complete-image"');
    act(() => editorRef!.commands.redo());
    expect(editorRef!.getHTML()).not.toContain("ocr-complete-image");
  });

  it("does not retain oversized Web Markdown pastes in undo history", async () => {
    let editorRef: Editor | undefined;
    const oversizedPaste = "x".repeat(MAX_UNDOABLE_PASTE_BYTES + 1);
    render(
      <RichTextEditor
        value="<p></p>"
        onChange={vi.fn()}
        renderInsertTools={(editor) => {
          editorRef = editor;
          return null;
        }}
      />,
    );

    await waitFor(() => expect(editorRef).toBeDefined());
    expect(undoDepth(editorRef!.state)).toBe(0);
    fireEvent.paste(document.querySelector(".rich-editor")!, {
      clipboardData: {
        getData: (type: string) => type === "text/plain" ? oversizedPaste : "",
        items: [],
      },
    });

    await waitFor(() => expect(editorRef!.getText()).toContain(oversizedPaste));
    expect(undoDepth(editorRef!.state)).toBe(0);
  });

  it("does not retain oversized Android clipboard pastes in undo history", async () => {
    let editorRef: Editor | undefined;
    const oversizedPaste = "x".repeat(MAX_UNDOABLE_PASTE_BYTES + 1);
    vi.mocked(isNativePlatform).mockReturnValue(true);
    vi.mocked(readClipboardTextFallback).mockResolvedValue(oversizedPaste);

    try {
      render(
        <RichTextEditor
          value="<p></p>"
          onChange={vi.fn()}
          renderInsertTools={(editor) => {
            editorRef = editor;
            return null;
          }}
        />,
      );

      await waitFor(() => expect(editorRef).toBeDefined());
      fireEvent.paste(document.querySelector(".rich-editor")!, {
        clipboardData: {
          getData: () => "",
          items: [],
        },
      });

      await waitFor(() => expect(editorRef!.getText()).toContain(oversizedPaste));
      expect(undoDepth(editorRef!.state)).toBe(0);
    } finally {
      vi.mocked(isNativePlatform).mockReturnValue(false);
      vi.mocked(readClipboardTextFallback).mockReset();
    }
  });

  it("clears existing history for oversized Android IME pastes without a paste event", async () => {
    let editorRef: Editor | undefined;
    const oversizedPaste = "x".repeat(MAX_UNDOABLE_PASTE_BYTES + 1);
    vi.mocked(isNativePlatform).mockReturnValue(true);
    vi.mocked(readClipboardTextFallback).mockResolvedValue(oversizedPaste);

    try {
      render(
        <RichTextEditor
          value="<p></p>"
          onChange={vi.fn()}
          renderInsertTools={(editor) => {
            editorRef = editor;
            return null;
          }}
        />,
      );

      await waitFor(() => expect(editorRef).toBeDefined());
      act(() => appendHistoryEvent(editorRef!, "A"));
      expect(undoDepth(editorRef!.state)).toBe(1);

      const editorElement = document.querySelector(".rich-editor")!;
      fireEvent(editorElement, nativeInputEvent("beforeinput", "insertText"));
      act(() => editorRef!.commands.insertContent(oversizedPaste));
      fireEvent(editorElement, nativeInputEvent("input", "insertText"));

      await waitFor(() => expect(editorRef!.getText()).toContain(oversizedPaste));
      await waitFor(() => expect(undoDepth(editorRef!.state)).toBe(0));
      expect(redoDepth(editorRef!.state)).toBe(0);
    } finally {
      vi.mocked(isNativePlatform).mockReturnValue(false);
      vi.mocked(readClipboardTextFallback).mockReset();
    }
  });

  it("uses desktop heading shortcuts and preserves a visible tab stop in content", async () => {
    const onChange = vi.fn();
    let editorRef: Editor | undefined;
    vi.mocked(isDesktopPlatform).mockReturnValue(true);
    try {
      render(
        <RichTextEditor
          value="<p>桌面正文</p>"
          onChange={onChange}
          renderInsertTools={(editor) => {
            editorRef = editor;
            return null;
          }}
        />,
      );
      await waitFor(() => expect(editorRef).toBeDefined());
      act(() => setSelectionInsideText(editorRef!, "桌面正文"));
      const editorElement = document.querySelector(".rich-editor")!;

      fireEvent.keyDown(editorElement, { key: "2", ctrlKey: true });
      await waitFor(() => expect(onChange.mock.calls.at(-1)?.[0]).toContain("<h2>桌面正文</h2>"));

      fireEvent.keyDown(editorElement, { key: "0", ctrlKey: true });
      await waitFor(() => expect(onChange.mock.calls.at(-1)?.[0]).toContain("<p>桌面正文</p>"));

      fireEvent.keyDown(editorElement, { key: "Tab" });
      await waitFor(() => expect(onChange.mock.calls.at(-1)?.[0]).toContain("<record-tab"));

      fireEvent.keyDown(editorElement, { key: "Tab", shiftKey: true });
      await waitFor(() => expect(onChange.mock.calls.at(-1)?.[0]).not.toContain("<record-tab"));
    } finally {
      vi.mocked(isDesktopPlatform).mockReturnValue(false);
    }
  });

  it("inserts a literal tab in desktop code blocks", async () => {
    const onChange = vi.fn();
    let editorRef: Editor | undefined;
    vi.mocked(isDesktopPlatform).mockReturnValue(true);
    try {
      render(
        <RichTextEditor
          value="<pre><code>const value = 1;</code></pre>"
          onChange={onChange}
          renderInsertTools={(editor) => {
            editorRef = editor;
            return null;
          }}
        />,
      );
      await waitFor(() => expect(editorRef).toBeDefined());
      act(() => setSelectionInsideText(editorRef!, "const value"));
      fireEvent.keyDown(document.querySelector(".rich-editor")!, { key: "Tab" });

      await waitFor(() => expect(onChange.mock.calls.at(-1)?.[0]).toContain("\t"));
      expect(onChange.mock.calls.at(-1)?.[0]).not.toContain("record-tab");
    } finally {
      vi.mocked(isDesktopPlatform).mockReturnValue(false);
    }
  });

  it.each([
    ["/zdk ", 'data-title="折叠块"'],
    ["/ZDK ", 'data-title="折叠块"'],
    ["/glk ", 'data-tone="green"'],
    ["/GLK ", 'data-tone="green"'],
    ["/dmk ", "<pre><code"],
    ["/DMK ", "<pre><code"],
    ["/zd ", "<record-decision-block"],
    ["/ZD ", "<record-decision-block"],
  ])("inserts %s as a desktop block shortcut", async (shortcut, expectedHtml) => {
    let editorRef: Editor | undefined;
    vi.mocked(isDesktopPlatform).mockReturnValue(true);
    try {
      render(
        <RichTextEditor
          value="<p></p>"
          onChange={vi.fn()}
          renderInsertTools={(editor) => {
            editorRef = editor;
            return null;
          }}
        />,
      );

      await waitFor(() => expect(editorRef).toBeDefined());
      act(() => {
        editorRef?.commands.insertContent(shortcut, { applyInputRules: true });
      });

      await waitFor(() => expect(editorRef?.getHTML()).toContain(expectedHtml));
      expect(editorRef?.getHTML()).not.toContain(shortcut.trim());
      if (shortcut.toLowerCase() === "/dmk ") {
        expect(editorRef?.isActive("codeBlock")).toBe(true);
      }
      if (shortcut.toLowerCase() === "/zd ") {
        const $from = editorRef!.state.selection.$from;
        expect(Array.from({ length: $from.depth }, (_, index) => $from.node(index + 1).type.name)).toContain("recordDecisionBlock");
        expect($from.parent.type.name).toBe("paragraph");
      }
    } finally {
      vi.mocked(isDesktopPlatform).mockReturnValue(false);
    }
  });

  it("opens a new collapse shortcut and focuses its summary before tabbing into the body", async () => {
    let editorRef: Editor | undefined;
    vi.mocked(isDesktopPlatform).mockReturnValue(true);
    try {
      render(
        <RichTextEditor
          value="<p></p>"
          onChange={vi.fn()}
          renderInsertTools={(editor) => {
            editorRef = editor;
            return null;
          }}
        />,
      );

      await waitFor(() => expect(editorRef).toBeDefined());
      act(() => {
        editorRef?.commands.insertContent("/zdk ", { applyInputRules: true });
      });

      const summaryInput = await screen.findByPlaceholderText("摘要标签");
      await waitFor(() => expect(summaryInput).toHaveFocus());
      expect((document.querySelector(".collapse-block-content") as HTMLElement).style.display).not.toBe("none");
      expect(editorRef?.getHTML()).toContain('data-default-open="false"');
      expect(editorRef?.getHTML()).not.toContain("autofocusSummary");

      fireEvent.keyDown(summaryInput, { key: "Tab" });

      await waitFor(() => expect(editorRef?.view.hasFocus()).toBe(true));
      const $from = editorRef!.state.selection.$from;
      expect($from.parent.type.name).toBe("paragraph");
      expect(Array.from({ length: $from.depth }, (_, index) => $from.node(index + 1).type.name)).toContain("recordCollapseBlock");
    } finally {
      vi.mocked(isDesktopPlatform).mockReturnValue(false);
    }
  });

  it("moves down from the collapse trailing blank line into the paragraph after the block", async () => {
    let editorRef: Editor | undefined;
    render(
      <RichTextEditor
        value={[
          '<record-collapse data-title="折叠" data-summary="" data-default-open="true">',
          "<p>正文</p><p></p>",
          "</record-collapse>",
          "<p>块后正文</p><p></p>",
        ].join("")}
        onChange={vi.fn()}
        renderInsertTools={(editor) => {
          editorRef = editor;
          return null;
        }}
      />,
    );

    await waitFor(() => expect(editorRef).toBeDefined());
    const collapse = editorRef!.state.doc.firstChild!;
    const trailingParagraphStart = 1 + collapse.child(0).nodeSize;
    act(() => editorRef?.commands.setTextSelection(trailingParagraphStart + 1));
    vi.spyOn(editorRef!.view, "endOfTextblock").mockReturnValue(true);

    fireEvent.keyDown(document.querySelector(".rich-editor")!, { key: "ArrowDown" });

    const $from = editorRef!.state.selection.$from;
    expect($from.parent.textContent).toBe("块后正文");
    expect($from.depth).toBe(1);
    expect(editorRef?.getHTML().match(/<p><\/p>/g)).toHaveLength(2);
  });

  it("keeps ArrowDown native before the final collapse child or final visual line", async () => {
    let editorRef: Editor | undefined;
    render(
      <RichTextEditor
        value={'<record-collapse data-title="折叠" data-summary="" data-default-open="true"><p>第一段</p><p></p></record-collapse><p></p>'}
        onChange={vi.fn()}
        renderInsertTools={(editor) => {
          editorRef = editor;
          return null;
        }}
      />,
    );

    await waitFor(() => expect(editorRef).toBeDefined());
    act(() => setSelectionInsideText(editorRef!, "第一段"));
    const before = editorRef!.state.selection.from;
    vi.spyOn(editorRef!.view, "endOfTextblock").mockReturnValue(false);

    fireEvent.keyDown(document.querySelector(".rich-editor")!, { key: "ArrowDown" });

    expect(editorRef!.state.selection.from).toBe(before);
  });

  it("creates an outside paragraph when ArrowDown cannot find an editable position after a root collapse", async () => {
    let editorRef: Editor | undefined;
    render(
      <RichTextEditor
        value={'<record-collapse data-title="折叠" data-summary="" data-default-open="true"><p></p></record-collapse>'}
        onChange={vi.fn()}
        renderInsertTools={(editor) => {
          editorRef = editor;
          return null;
        }}
      />,
    );

    await waitFor(() => expect(editorRef).toBeDefined());
    const collapse = editorRef!.state.doc.firstChild!;
    act(() => editorRef?.commands.setTextSelection(2));
    vi.spyOn(editorRef!.view, "endOfTextblock").mockReturnValue(true);
    act(() => {
      const end = editorRef!.state.doc.content.size;
      editorRef!.view.dispatch(editorRef!.state.tr.delete(collapse.nodeSize, end));
    });

    fireEvent.keyDown(document.querySelector(".rich-editor")!, { key: "ArrowDown" });

    expect(editorRef!.state.selection.$from.depth).toBe(1);
    expect(editorRef?.getHTML()).toBe('<record-collapse data-title="折叠" data-summary="" data-default-open="true"><p></p></record-collapse><p></p>');
  });

  it.each(["/zdk ", "/ZDK ", "/glk ", "/GLK ", "/dmk ", "/DMK ", "/zd ", "/ZD "])("keeps %s as text outside Desktop", async (shortcut) => {
    let editorRef: Editor | undefined;
    render(
      <RichTextEditor
        value="<p></p>"
        onChange={vi.fn()}
        renderInsertTools={(editor) => {
          editorRef = editor;
          return null;
        }}
      />,
    );

    await waitFor(() => expect(editorRef).toBeDefined());
    act(() => {
      editorRef?.commands.insertContent(shortcut, { applyInputRules: true });
    });

    expect(editorRef?.getHTML()).toContain(shortcut);
  });

  it("limits desktop block shortcuts to the start of ordinary paragraphs", async () => {
    let editorRef: Editor | undefined;
    vi.mocked(isDesktopPlatform).mockReturnValue(true);
    try {
      render(
        <RichTextEditor
          value="<p>前文</p>"
          onChange={vi.fn()}
          renderInsertTools={(editor) => {
            editorRef = editor;
            return null;
          }}
        />,
      );

      await waitFor(() => expect(editorRef).toBeDefined());
      act(() => {
        setSelectionInsideText(editorRef!, "前文");
        editorRef?.commands.insertContent("/dmk ", { applyInputRules: true });
      });
      expect(editorRef?.getHTML()).toContain("/dmk ");
      expect(editorRef?.isActive("codeBlock")).toBe(false);

      act(() => {
        editorRef?.commands.setContent("<pre><code></code></pre>");
        editorRef?.commands.insertContent("/zdk ", { applyInputRules: true });
      });
      expect(editorRef?.getHTML()).toContain("/zdk ");
      expect(editorRef?.getHTML()).not.toContain("record-collapse");
    } finally {
      vi.mocked(isDesktopPlatform).mockReturnValue(false);
    }
  });

  it("keeps a Desktop code-block paste as exact plain text", async () => {
    const source = [
      "def calculate_fibonacci(n):",
      "    \"\"\"计算斐波那契数列的前 n 项\"\"\"",
      "    if n <= 0:",
      "        return []",
      "    elif n == 1:",
      "        return [0]",
      "",
      "    fib = [0, 1]",
      "    while len(fib) < n:",
      "        next_value = fib[-1] + fib[-2]",
      "        fib.append(next_value)",
      "",
      "    return fib",
      "",
      "if __name__ == \"__main__\":",
      "    n_terms = 10",
      "    print(f\"斐波那契数列前 {n_terms} 项：\")",
      "    print(calculate_fibonacci(n_terms))",
    ].join("\n");
    let editorRef: Editor | undefined;
    vi.mocked(isDesktopPlatform).mockReturnValue(true);
    try {
      render(
        <RichTextEditor
          value="<p></p>"
          onChange={vi.fn()}
          renderInsertTools={(editor) => {
            editorRef = editor;
            return null;
          }}
        />,
      );

      await waitFor(() => expect(editorRef).toBeDefined());
      act(() => {
        editorRef?.commands.setCodeBlock();
      });
      fireEvent.paste(document.querySelector(".rich-editor")!, {
        clipboardData: {
          getData: (type: string) => type === "text/plain" ? source : "",
          items: [],
        },
      });

      await waitFor(() => {
        const codeBlocks: string[] = [];
        editorRef?.state.doc.descendants((node) => {
          if (node.type.name === "codeBlock") {
            codeBlocks.push(node.textContent);
          }
          return true;
        });
        expect(codeBlocks).toEqual([source]);
      });
      expect(editorRef?.getHTML()).not.toContain("<p>return");
    } finally {
      vi.mocked(isDesktopPlatform).mockReturnValue(false);
    }
  });

  it("inserts a compact record reference at the saved editor selection", async () => {
    const onChange = vi.fn();
    const source = referenceRecord("record-source", "来源日志");
    const target = referenceRecord("record-target", "目标日志");
    render(
      <RichTextEditor
        value="<p>正文</p>"
        onChange={onChange}
        currentRecordId={source.id}
        referenceRecords={[source, target]}
        referenceSubjects={referenceSubjects}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "引用日志" }));
    fireEvent.change(screen.getByRole("textbox", { name: "搜索日志标题" }), { target: { value: "目标" } });
    fireEvent.click(await screen.findByRole("button", { name: /目标日志/ }));

    await waitFor(() => expect(onChange.mock.calls.at(-1)?.[0]).toContain("record-reference"));
    const html = onChange.mock.calls.at(-1)?.[0] ?? "";
    expect(html).toContain('data-record-id="record-target"');
    expect(html).toContain('data-title="目标日志"');
  });

  it("opens available references only in read-only preview and marks deleted targets unavailable", async () => {
    const onOpenRecordReference = vi.fn();
    const source = referenceRecord("record-source", "来源日志");
    const target = referenceRecord("record-target", "最新标题");
    const referenceHtml = '<p>见 <record-reference data-record-id="record-target" data-title="旧标题"></record-reference></p>';
    const view = render(
      <RichTextEditor
        value={referenceHtml}
        onChange={vi.fn()}
        readOnly
        currentRecordId={source.id}
        referenceRecords={[source, target]}
        referenceSubjects={referenceSubjects}
        onOpenRecordReference={onOpenRecordReference}
      />,
    );

    const referenceLink = await screen.findByRole("link", { name: "引用日志：最新标题" });
    fireEvent.click(referenceLink);
    expect(onOpenRecordReference).toHaveBeenCalledWith(target.id);

    view.rerender(
      <RichTextEditor
        value={referenceHtml}
        onChange={vi.fn()}
        readOnly
        currentRecordId={source.id}
        referenceRecords={[source]}
        referenceSubjects={referenceSubjects}
        onOpenRecordReference={onOpenRecordReference}
      />,
    );
    await waitFor(() => expect(screen.getByText("已删除：旧标题")).toBeInTheDocument());
    expect(screen.queryByRole("link", { name: /旧标题/ })).not.toBeInTheDocument();
  });

  it("converts pasted Markdown with formulas into editor nodes", async () => {
    const onChange = vi.fn();
    render(<RichTextEditor value="<p></p>" onChange={onChange} />);

    const editor = document.querySelector(".rich-editor")!;
    fireEvent.paste(editor, {
      clipboardData: {
        getData: (type: string) => type === "text/plain" ? "# 标题\n\n行内 $x^2$\n\n$$\ny=x\n$$" : "",
        items: [],
      },
    });

    await waitFor(() => expect(onChange.mock.calls.at(-1)?.[0]).toContain("record-inline-math"));
    expect(onChange.mock.calls.at(-1)?.[0]).toContain("record-formula");
    expect(onChange.mock.calls.at(-1)?.[0]).toContain("<h1>标题</h1>");
  });

  it("prefers the actual Markdown source from a Windows clipboard and accepts single-line block math", async () => {
    const onChange = vi.fn();
    render(<RichTextEditor value="<p></p>" onChange={onChange} />);

    fireEvent.paste(document.querySelector(".rich-editor")!, {
      clipboardData: {
        getData: (type: string) => {
          if (type === "text/markdown") return "Copied rich text";
          if (type === "text/plain") return "$\\lim_{x \\to 0^+} \\frac{f(x)}{ax^b} = 1$\n\n$$E=mc^2$$\n\n*斜体*";
          return "";
        },
        items: [],
      },
    });

    await waitFor(() => expect(onChange.mock.calls.at(-1)?.[0]).toContain("record-inline-math"));
    const html = onChange.mock.calls.at(-1)?.[0] ?? "";
    expect(html).toContain('data-latex="\\lim_{x \\to 0^+} \\frac{f(x)}{ax^b} = 1"');
    expect(html).toContain('data-latex="E=mc^2"');
    expect(html).toContain("<em>斜体</em>");
  });

  it("parses a standalone multiline block formula paste", async () => {
    const onChange = vi.fn();
    render(<RichTextEditor value="<p></p>" onChange={onChange} />);

    fireEvent.paste(document.querySelector(".rich-editor")!, {
      clipboardData: {
        getData: (type: string) => type === "text/plain" ? "$$\n\\int_0^1 x^2 dx\n$$" : "",
        items: [],
      },
    });

    await waitFor(() => expect(onChange.mock.calls.at(-1)?.[0]).toContain("record-formula"));
    expect(onChange.mock.calls.at(-1)?.[0]).toContain('data-latex="\\int_0^1 x^2 dx"');
  });

  it("renders the provided mixed Markdown block-formula sample as separate formula nodes", async () => {
    const onChange = vi.fn();
    const source = [
      "#### **块级公式（独立成行）**",
      "",
      "一元二次方程求根公式：",
      "$$",
      "x = \\frac{-b \\pm \\sqrt{b^2 - 4ac}}{2a}",
      "$$",
      "",
      "正态分布概率密度函数：",
      "$$",
      "f(x) = \\frac{1}{\\sigma \\sqrt{2\\pi}} \\exp\\left(-\\frac{(x-\\mu)^2}{2\\sigma^2}\\right)",
      "$$",
    ].join("\n");
    render(<RichTextEditor value="<p></p>" onChange={onChange} />);

    fireEvent.paste(document.querySelector(".rich-editor")!, {
      clipboardData: {
        getData: (type: string) => type === "text/plain" ? source : "",
        items: [],
      },
    });

    await waitFor(() => expect(onChange.mock.calls.at(-1)?.[0]).toContain("<h4><strong>块级公式（独立成行）</strong></h4>"));
    const html = onChange.mock.calls.at(-1)?.[0] ?? "";
    expect((html.match(/<record-formula\b/g) ?? [])).toHaveLength(2);
    expect(html).toContain('data-latex="x = \\frac{-b \\pm \\sqrt{b^2 - 4ac}}{2a}"');
    expect(html).not.toContain("$$");
  });

  it("renders mixed block formulas from the Android native Markdown path", async () => {
    const onChange = vi.fn();
    let editorRef: Editor | undefined;
    const source = ["#### 块公式", "", "说明", "$$", "x = y^2", "$$", "", "$$", "z = x + y", "$$"].join("\r\n");
    vi.mocked(isNativePlatform).mockReturnValue(true);
    vi.mocked(readClipboardTextFallback).mockResolvedValue(source);

    try {
      render(
        <RichTextEditor
          value="<p></p>"
          onChange={onChange}
          renderInsertTools={(editor) => {
            editorRef = editor;
            return null;
          }}
        />,
      );
      await waitFor(() => expect(editorRef).toBeDefined());
      const editor = document.querySelector(".rich-editor")!;
      fireEvent(editor, nativeInputEvent("beforeinput", "insertText"));
      act(() => {
        editorRef?.commands.insertContent(source);
      });
      fireEvent(editor, nativeInputEvent("input", "insertText"));

      await waitFor(() => expect(onChange.mock.calls.at(-1)?.[0]).toContain("<h4>块公式</h4>"));
      expect((onChange.mock.calls.at(-1)?.[0].match(/<record-formula\b/g) ?? [])).toHaveLength(2);
    } finally {
      vi.mocked(isNativePlatform).mockReturnValue(false);
      vi.mocked(readClipboardTextFallback).mockReset();
    }
  });

  it.each([
    ["c++", "int main() { return 0; }", "language-cpp"],
    ["java", "public class Main {}", "language-java"],
    ["python", "def main():\n    return 0", "language-python"],
  ])("parses and highlights %s code fences", async (language, code, expectedClass) => {
    const onChange = vi.fn();
    render(<RichTextEditor value="<p></p>" onChange={onChange} />);

    fireEvent.paste(document.querySelector(".rich-editor")!, {
      clipboardData: {
        getData: (type: string) => type === "text/plain" ? `\`\`\`${language}\n${code}\n\`\`\`` : "",
        items: [],
      },
    });

    await waitFor(() => expect(onChange.mock.calls.at(-1)?.[0]).toContain(expectedClass));
    await waitFor(() => expect(document.querySelector(".rich-editor pre .hljs-keyword, .rich-editor pre .hljs-type")).toBeInTheDocument());
  });

  it("creates a language-specific code block from the toolbar selector", async () => {
    let editorRef: Editor | undefined;
    render(
      <RichTextEditor
        value="<p></p>"
        onChange={vi.fn()}
        renderInsertTools={(editor) => {
          editorRef = editor;
          return null;
        }}
      />,
    );

    fireEvent.change(screen.getByRole("combobox", { name: "代码块语言" }), { target: { value: "java" } });
    await waitFor(() => expect(editorRef?.getHTML()).toContain('language-java'));
  });

  it("converts a Markdown table into a fixed-first-column comparison table with inline formatting", async () => {
    const onChange = vi.fn();
    const source = [
      "名称 | 代码 | 说明 | 链接",
      "| --- | --- | --- | --- |",
      "| `vector<int>` | **粗体** 和 *斜体* | a \\| b | [OpenAI](https://openai.com) |",
      "| 很长很长很长很长很长的第一列 | `printf(\"hello\")` | 普通文本 | [文档](https://example.com) |",
    ].join("\n");
    const editorView = render(<RichTextEditor value="<p></p>" onChange={onChange} />);

    fireEvent.paste(document.querySelector(".rich-editor")!, {
      clipboardData: {
        getData: (type: string) => type === "text/plain" ? source : "",
        items: [],
      },
    });

    await waitFor(() => expect(onChange.mock.calls.at(-1)?.[0]).toContain('data-format="markdown"'));
    const html = onChange.mock.calls.at(-1)?.[0] ?? "";
    expect(html).toContain("record-comparison-table");
    editorView.unmount();

    render(<RichTextEditor value={html} onChange={vi.fn()} readOnly />);
    await waitFor(() => expect(document.querySelector(".comparison-fixed-panel")).toBeInTheDocument());
    expect(document.querySelectorAll(".comparison-table-right-scroll")).toHaveLength(1);
    await waitFor(() => expect(document.querySelector(".comparison-markdown-cell strong")).toBeInTheDocument());
    expect(document.querySelector(".comparison-markdown-cell code")).toHaveTextContent("vector<int>");
    expect(document.querySelector(".comparison-markdown-cell strong")).toHaveTextContent("粗体");
    expect(document.querySelector(".comparison-markdown-cell em")).toHaveTextContent("斜体");
    await waitFor(() => expect(document.querySelector('.comparison-markdown-cell a[href="https://openai.com"]')).toBeInTheDocument());
    expect(document.querySelector('.comparison-markdown-cell a[href="https://openai.com"]')).toBeInTheDocument();
    expect(document.querySelector(".comparison-table-view")).toHaveTextContent("a | b");
  });

  it("keeps a rendered table in edit mode and commits a cell only after editing finishes", async () => {
    const onChange = vi.fn();
    const table = {
      title: "公式表",
      columns: [
        { id: "concept", label: "概念" },
        { id: "value", label: "结果" },
      ],
      rows: [{ id: "row-1", cells: { concept: "旧值", value: "$x^2$" } }],
    };
    render(
      <RichTextEditor
        value={`<record-comparison-table data-json='${serializeStructureData(table)}' data-format="markdown"></record-comparison-table>`}
        onChange={onChange}
      />,
    );

    await waitFor(() => expect(screen.getByRole("table")).toBeInTheDocument());
    await waitFor(() => expect(screen.getByText("旧值")).toBeInTheDocument());
    expect(document.querySelectorAll(".comparison-grid-cell textarea")).toHaveLength(0);

    fireEvent.click(screen.getByLabelText("第 1 行首列，点击编辑"));
    const input = screen.getByRole("textbox", { name: "第 1 行首列" });
    const callsBeforeTyping = onChange.mock.calls.length;
    fireEvent.change(input, { target: { value: "新值" } });
    expect(onChange).toHaveBeenCalledTimes(callsBeforeTyping);

    fireEvent.blur(input);
    await waitFor(() => expect(onChange.mock.calls.at(-1)?.[0]).toContain("新值"));
    expect(document.querySelectorAll(".comparison-grid-cell textarea")).toHaveLength(0);

    fireEvent.click(screen.getByLabelText("第 1 行首列，点击编辑"));
    const cancelledInput = screen.getByRole("textbox", { name: "第 1 行首列" });
    const callsBeforeCancel = onChange.mock.calls.length;
    fireEvent.change(cancelledInput, { target: { value: "不会保存" } });
    fireEvent.keyDown(cancelledInput, { key: "Escape" });
    expect(onChange).toHaveBeenCalledTimes(callsBeforeCancel);
  });

  it("renders inline and block math in Markdown table cells", async () => {
    const table = {
      title: "数学表",
      columns: [
        { id: "concept", label: "符号" },
        { id: "value", label: "表达式" },
      ],
      rows: [{
        id: "row-1",
        cells: {
          concept: "$a^2+b^2$",
          value: "$$\n\\int_0^1 x^2\\,dx\n$$",
        },
      }],
    };
    const { container } = render(
      <RichTextEditor
        value={`<record-comparison-table data-json='${serializeStructureData(table)}' data-format="markdown"></record-comparison-table>`}
        onChange={vi.fn()}
        readOnly
      />,
    );

    await waitFor(() => expect(container.querySelectorAll(".comparison-markdown-cell .katex").length).toBeGreaterThanOrEqual(2));
    expect(container.querySelector(".comparison-markdown-cell .katex-display")).toBeInTheDocument();
  });

  it("parses a complete plain-text Markdown paste with links and a horizontal rule", async () => {
    const onChange = vi.fn();
    render(<RichTextEditor value="<p></p>" onChange={onChange} />);

    fireEvent.paste(document.querySelector(".rich-editor")!, {
      clipboardData: {
        getData: (type: string) => type === "text/plain"
          ? [
            "# Markdown 标题",
            "",
            "> 引用内容",
            "",
            "- 列表项",
            "",
            "**粗体**、*斜体*、`代码`和[链接](https://example.com)",
            "",
            "---",
            "",
            "行内公式 $x^2$",
          ].join("\n")
          : "",
        items: [],
      },
    });

    await waitFor(() => expect(onChange.mock.calls.at(-1)?.[0]).toContain("<h1>Markdown 标题</h1>"));
    const html = onChange.mock.calls.at(-1)?.[0] ?? "";
    expect(html).toContain("<blockquote><p>引用内容</p></blockquote>");
    expect(html).toContain("<ul><li><p>列表项</p></li></ul>");
    expect(html).toContain("<strong>粗体</strong>");
    expect(html).toContain("<em>斜体</em>");
    expect(html).toContain("<code>代码</code>");
    expect(html).toContain('<a href="https://example.com"');
    expect(html).toContain("<hr>");
    expect(html).toContain("record-inline-math");
  });

  it("prefers Markdown source when both clipboard text formats contain markers", async () => {
    const onChange = vi.fn();
    render(<RichTextEditor value="<p></p>" onChange={onChange} />);

    fireEvent.paste(document.querySelector(".rich-editor")!, {
      clipboardData: {
        getData: (type: string) => type === "text/markdown" ? "## Markdown source" : "**Plain source**",
        items: [],
      },
    });

    await waitFor(() => expect(onChange.mock.calls.at(-1)?.[0]).toContain("<h2>Markdown source</h2>"));
    expect(onChange.mock.calls.at(-1)?.[0]).not.toContain("Plain source");
  });

  it("leaves ordinary plain text unchanged when it has no Markdown markers", () => {
    const onChange = vi.fn();
    let editorRef: Editor | undefined;
    render(
      <RichTextEditor
        value="<p></p>"
        onChange={onChange}
        renderInsertTools={(editor) => {
          editorRef = editor;
          return null;
        }}
      />,
    );

    fireEvent.paste(document.querySelector(".rich-editor")!, {
      clipboardData: {
        getData: (type: string) => type === "text/plain" ? "普通文本 1 + 1 = 2" : "",
        items: [],
      },
    });

    expect(editorRef?.getHTML()).toBe("<p>普通文本 1 + 1 = 2</p><p></p>");
    expect(editorRef?.getHTML()).not.toContain("<h1>");
    expect(editorRef?.getHTML()).not.toContain("record-inline-math");
  });

  it("parses Markdown from the native Android clipboard when DOM data is empty", async () => {
    const onChange = vi.fn();
    vi.mocked(isNativePlatform).mockReturnValue(true);
    vi.mocked(readClipboardTextFallback).mockResolvedValue("# Android Markdown\n\n**粗体**和$x^2$");

    try {
      render(<RichTextEditor value="<p></p>" onChange={onChange} />);
      fireEvent.paste(document.querySelector(".rich-editor")!, {
        clipboardData: {
          getData: () => "",
          items: [],
        },
      });

      await waitFor(() => expect(onChange.mock.calls.at(-1)?.[0]).toContain("<h1>Android Markdown</h1>"));
      expect(onChange.mock.calls.at(-1)?.[0]).toContain("record-inline-math");
    } finally {
      vi.mocked(isNativePlatform).mockReturnValue(false);
      vi.mocked(readClipboardTextFallback).mockReset();
    }
  });

  it("keeps native Android clipboard inline formulas in one paragraph when DOM data is empty", async () => {
    const onChange = vi.fn();
    vi.mocked(isNativePlatform).mockReturnValue(true);
    vi.mocked(readClipboardTextFallback).mockResolvedValue(inlineMathPasteSample);

    try {
      render(<RichTextEditor value="<p></p>" onChange={onChange} />);
      fireEvent.paste(document.querySelector(".rich-editor")!, {
        clipboardData: {
          getData: () => "",
          items: [],
        },
      });

      await waitFor(() => expect(onChange.mock.calls.at(-1)?.[0]).toContain("record-inline-math"));
      expectInlineMathPasteParagraph(onChange.mock.calls.at(-1)?.[0] ?? "");
    } finally {
      vi.mocked(isNativePlatform).mockReturnValue(false);
      vi.mocked(readClipboardTextFallback).mockReset();
    }
  });

  it("converts an Android beforeinput paste when no paste event is emitted", async () => {
    const onChange = vi.fn();
    vi.mocked(isNativePlatform).mockReturnValue(true);
    vi.mocked(readClipboardTextFallback).mockResolvedValue(androidMarkdownSample);

    try {
      render(<RichTextEditor value="<p></p>" onChange={onChange} />);
      const editor = document.querySelector(".rich-editor")!;
      const event = nativeInputEvent("beforeinput", "insertFromPaste");
      fireEvent(editor, event);

      expect(event.defaultPrevented).toBe(true);
      await waitFor(() => expect(onChange.mock.calls.at(-1)?.[0]).toContain("<h3>整体规律总结</h3>"));
      const html = onChange.mock.calls.at(-1)?.[0] ?? "";
      expect(html).toContain("<hr>");
      expect(html).toContain("<ul>");
      expect(html).toContain("<strong>破折号插入</strong>");
      expect(html).not.toContain("### 整体规律总结");
    } finally {
      vi.mocked(isNativePlatform).mockReturnValue(false);
      vi.mocked(readClipboardTextFallback).mockReset();
    }
  });

  it("uses the input fallback when Android commits text despite a canceled beforeinput", async () => {
    const onChange = vi.fn();
    let editorRef: Editor | undefined;
    let resolveClipboard: ((value: string) => void) | undefined;
    const clipboardPromise = new Promise<string>((resolve) => {
      resolveClipboard = resolve;
    });
    vi.mocked(isNativePlatform).mockReturnValue(true);
    vi.mocked(readClipboardTextFallback).mockReturnValue(clipboardPromise);

    try {
      render(
        <RichTextEditor
          value="<p></p>"
          onChange={onChange}
          renderInsertTools={(editor) => {
            editorRef = editor;
            return null;
          }}
        />,
      );
      await waitFor(() => expect(editorRef).toBeDefined());
      const editor = document.querySelector(".rich-editor")!;
      fireEvent(editor, nativeInputEvent("beforeinput", "insertFromPaste"));
      act(() => {
        editorRef?.commands.insertContent(androidMarkdownSample);
      });
      fireEvent(editor, nativeInputEvent("input", "insertFromPaste"));
      resolveClipboard?.(androidMarkdownSample);

      await waitFor(() => expect(onChange.mock.calls.at(-1)?.[0]).toContain("<h3>整体规律总结</h3>"));
      const html = onChange.mock.calls.at(-1)?.[0] ?? "";
      expect(html).toContain("<hr>");
      expect(html).not.toContain("### 整体规律总结");
    } finally {
      vi.mocked(isNativePlatform).mockReturnValue(false);
      vi.mocked(readClipboardTextFallback).mockReset();
    }
  });

  it("replaces raw Android input with Markdown when an IME omits the paste event", async () => {
    const onChange = vi.fn();
    let editorRef: Editor | undefined;
    vi.mocked(isNativePlatform).mockReturnValue(true);
    vi.mocked(readClipboardTextFallback).mockResolvedValue(androidMarkdownSample);

    try {
      render(
        <RichTextEditor
          value="<p></p>"
          onChange={onChange}
          renderInsertTools={(editor) => {
            editorRef = editor;
            return null;
          }}
        />,
      );
      await waitFor(() => expect(editorRef).toBeDefined());
      const editor = document.querySelector(".rich-editor")!;
      fireEvent(editor, nativeInputEvent("beforeinput", "insertText"));
      act(() => {
        editorRef?.commands.insertContent(androidMarkdownSample);
      });
      fireEvent(editor, nativeInputEvent("input", "insertText"));

      await waitFor(() => expect(onChange.mock.calls.at(-1)?.[0]).toContain("<h3>整体规律总结</h3>"));
      const html = onChange.mock.calls.at(-1)?.[0] ?? "";
      expect(html).toContain("<hr>");
      expect(html).toContain("<ul>");
      expect(html).toContain("<strong>名词短语同位语</strong>");
      expect(html).not.toContain("### 整体规律总结");
    } finally {
      vi.mocked(isNativePlatform).mockReturnValue(false);
      vi.mocked(readClipboardTextFallback).mockReset();
    }
  });

  it("keeps inline formulas in one paragraph when an Android IME omits the paste event", async () => {
    const onChange = vi.fn();
    let editorRef: Editor | undefined;
    vi.mocked(isNativePlatform).mockReturnValue(true);
    vi.mocked(readClipboardTextFallback).mockResolvedValue(inlineMathPasteSample);

    try {
      render(
        <RichTextEditor
          value="<p></p>"
          onChange={onChange}
          renderInsertTools={(editor) => {
            editorRef = editor;
            return null;
          }}
        />,
      );
      await waitFor(() => expect(editorRef).toBeDefined());
      const editor = document.querySelector(".rich-editor")!;
      fireEvent(editor, nativeInputEvent("beforeinput", "insertText"));
      act(() => {
        editorRef?.commands.insertContent(inlineMathPasteSample);
      });
      fireEvent(editor, nativeInputEvent("input", "insertText"));

      await waitFor(() => expect(onChange.mock.calls.at(-1)?.[0]).toContain("record-inline-math"));
      expectInlineMathPasteParagraph(onChange.mock.calls.at(-1)?.[0] ?? "");
    } finally {
      vi.mocked(isNativePlatform).mockReturnValue(false);
      vi.mocked(readClipboardTextFallback).mockReset();
    }
  });

  it("coalesces segmented Android IME commits before parsing Markdown", async () => {
    const onChange = vi.fn();
    let editorRef: Editor | undefined;
    const chunks = [
      "---\r\n\r\n### 整体规律总结\r\n\r\n",
      "- **破折号插入**：主语后的同位语。\r\n",
      "  - **被动不定式**：need **to be** encouraged",
    ];
    vi.mocked(isNativePlatform).mockReturnValue(true);
    vi.mocked(readClipboardTextFallback).mockResolvedValue(chunks.join(""));

    try {
      render(
        <RichTextEditor
          value="<p></p>"
          onChange={onChange}
          renderInsertTools={(editor) => {
            editorRef = editor;
            return null;
          }}
        />,
      );
      await waitFor(() => expect(editorRef).toBeDefined());
      const editor = document.querySelector(".rich-editor")!;
      for (const chunk of chunks) {
        fireEvent(editor, nativeInputEvent("beforeinput", "insertText"));
        act(() => {
          editorRef?.commands.insertContent(chunk);
        });
        fireEvent(editor, nativeInputEvent("input", "insertText"));
      }

      await waitFor(() => expect(onChange.mock.calls.at(-1)?.[0]).toContain("<h3>整体规律总结</h3>"));
      const html = onChange.mock.calls.at(-1)?.[0] ?? "";
      expect(html).toContain("<hr>");
      expect(html).toContain("<ul>");
      expect(html).toContain("<strong>破折号插入</strong>");
      expect(html).not.toContain("### 整体规律总结");
    } finally {
      vi.mocked(isNativePlatform).mockReturnValue(false);
      vi.mocked(readClipboardTextFallback).mockReset();
    }
  });

  it("waits for paced Android IME chunks when the first chunk has no Markdown marker", async () => {
    const onChange = vi.fn();
    let editorRef: Editor | undefined;
    const chunks = [
      "先插入一段普通说明文字。\r\n\r\n",
      "### 后续标题\r\n\r\n- **第一项**\r\n",
      "  - **第二项**",
    ];
    vi.mocked(isNativePlatform).mockReturnValue(true);
    vi.mocked(readClipboardTextFallback).mockResolvedValue(chunks.join(""));

    try {
      render(
        <RichTextEditor
          value="<p></p>"
          onChange={onChange}
          renderInsertTools={(editor) => {
            editorRef = editor;
            return null;
          }}
        />,
      );
      await waitFor(() => expect(editorRef).toBeDefined());
      const editor = document.querySelector(".rich-editor")!;
      for (const chunk of chunks) {
        fireEvent(editor, nativeInputEvent("beforeinput", "insertText"));
        act(() => {
          editorRef?.commands.insertContent(chunk);
        });
        fireEvent(editor, nativeInputEvent("input", "insertText"));
        await act(async () => {
          await new Promise((resolve) => setTimeout(resolve, 170));
        });
      }

      await waitFor(() => expect(onChange.mock.calls.at(-1)?.[0]).toContain("<h3>后续标题</h3>"));
      const html = onChange.mock.calls.at(-1)?.[0] ?? "";
      expect(html).toContain("<p>先插入一段普通说明文字。</p>");
      expect(html).toContain("<ul>");
      expect(html).toContain("<strong>第一项</strong>");
      expect(html).toContain("<strong>第二项</strong>");
      expect(html).not.toContain("### 后续标题");
      expect(readClipboardTextFallback).toHaveBeenCalledTimes(1);
    } finally {
      vi.mocked(isNativePlatform).mockReturnValue(false);
      vi.mocked(readClipboardTextFallback).mockReset();
    }
  });

  it("keeps raw Android IME text when a later chunk is not a clipboard prefix", async () => {
    let editorRef: Editor | undefined;
    vi.mocked(isNativePlatform).mockReturnValue(true);
    vi.mocked(readClipboardTextFallback).mockResolvedValue("普通开头\r\n\r\n### 正确标题");

    try {
      render(
        <RichTextEditor
          value="<p></p>"
          onChange={vi.fn()}
          renderInsertTools={(editor) => {
            editorRef = editor;
            return null;
          }}
        />,
      );
      await waitFor(() => expect(editorRef).toBeDefined());
      const editor = document.querySelector(".rich-editor")!;
      for (const chunk of ["普通开头\r\n\r\n", "### 错误标题"]) {
        fireEvent(editor, nativeInputEvent("beforeinput", "insertText"));
        act(() => {
          editorRef?.commands.insertContent(chunk);
        });
        fireEvent(editor, nativeInputEvent("input", "insertText"));
        await act(async () => {
          await new Promise((resolve) => setTimeout(resolve, 170));
        });
      }

      await waitFor(() => expect(editorRef?.getHTML()).toContain("### 错误标题"));
      expect(editorRef?.getHTML()).not.toContain("<h3>正确标题</h3>");
    } finally {
      vi.mocked(isNativePlatform).mockReturnValue(false);
      vi.mocked(readClipboardTextFallback).mockReset();
    }
  });

  it("keeps incomplete Android IME input after the two-second session expires", async () => {
    let editorRef: Editor | undefined;
    vi.useFakeTimers();
    vi.mocked(isNativePlatform).mockReturnValue(true);
    vi.mocked(readClipboardTextFallback).mockReturnValue(new Promise(() => {}));

    try {
      render(
        <RichTextEditor
          value="<p></p>"
          onChange={vi.fn()}
          renderInsertTools={(editor) => {
            editorRef = editor;
            return null;
          }}
        />,
      );
      const editor = document.querySelector(".rich-editor")!;
      fireEvent(editor, nativeInputEvent("beforeinput", "insertText"));
      act(() => {
        editorRef?.commands.insertContent("尚未完成的粘贴内容");
      });
      fireEvent(editor, nativeInputEvent("input", "insertText"));

      await act(async () => {
        await vi.advanceTimersByTimeAsync(2_000);
      });

      expect(editorRef?.getHTML()).toContain("尚未完成的粘贴内容");
    } finally {
      vi.useRealTimers();
      vi.mocked(isNativePlatform).mockReturnValue(false);
      vi.mocked(readClipboardTextFallback).mockReset();
    }
  });

  it.each([3, 5, 7])("renders Android IME Markdown when the cursor lands %i characters before the end", async (offset) => {
    const onChange = vi.fn();
    let editorRef: Editor | undefined;
    const source = [
      "---",
      "",
      "### 异常选区标题",
      "",
      "> **引用粗体**",
      "",
      "- 列表项",
    ].join("\r\n");
    vi.mocked(isNativePlatform).mockReturnValue(true);
    vi.mocked(readClipboardTextFallback).mockResolvedValue(source);

    try {
      render(
        <RichTextEditor
          value="<p></p>"
          onChange={onChange}
          renderInsertTools={(editor) => {
            editorRef = editor;
            return null;
          }}
        />,
      );
      await waitFor(() => expect(editorRef).toBeDefined());
      const editor = document.querySelector(".rich-editor")!;
      fireEvent(editor, nativeInputEvent("beforeinput", "insertText"));
      act(() => {
        editorRef?.commands.insertContent(source);
        editorRef?.commands.setTextSelection(editorRef!.state.doc.content.size - offset);
      });
      fireEvent(editor, nativeInputEvent("input", "insertText"));

      await waitFor(() => expect(onChange.mock.calls.at(-1)?.[0]).toContain("<h3>异常选区标题</h3>"));
      const html = onChange.mock.calls.at(-1)?.[0] ?? "";
      expect(html).toContain("<hr>");
      expect(html).toContain("<blockquote><p><strong>引用粗体</strong></p></blockquote>");
      expect(html).toContain("<ul>");
      expect(html).not.toContain("### 异常选区标题");
    } finally {
      vi.mocked(isNativePlatform).mockReturnValue(false);
      vi.mocked(readClipboardTextFallback).mockReset();
    }
  });

  it("uses the clipboard Markdown source when an Android IME inserts extra empty lines", async () => {
    const onChange = vi.fn();
    let editorRef: Editor | undefined;
    const source = ["### 标题", "", "- **第一项**", "- 第二项"].join("\r\n");
    const committedText = ["### 标题", "", "", "", "- **第一项**", "", "- 第二项"].join("\r\n");
    vi.mocked(isNativePlatform).mockReturnValue(true);
    vi.mocked(readClipboardTextFallback).mockResolvedValue(source);

    try {
      render(
        <RichTextEditor
          value="<p></p>"
          onChange={onChange}
          renderInsertTools={(editor) => {
            editorRef = editor;
            return null;
          }}
        />,
      );
      await waitFor(() => expect(editorRef).toBeDefined());
      const editor = document.querySelector(".rich-editor")!;
      fireEvent(editor, nativeInputEvent("beforeinput", "insertText"));
      act(() => {
        editorRef?.commands.insertContent(committedText);
      });
      fireEvent(editor, nativeInputEvent("input", "insertText"));

      await waitFor(() => expect(onChange.mock.calls.at(-1)?.[0]).toContain("<h3>标题</h3>"));
      const html = onChange.mock.calls.at(-1)?.[0] ?? "";
      expect(html).toContain("<ul>");
      expect(html).toContain("<strong>第一项</strong>");
      expect(html).toMatch(/<p><\/p>$/);
      expect(html.match(/<p><\/p>/g)).toHaveLength(1);
      expect(html).not.toContain("### 标题");
    } finally {
      vi.mocked(isNativePlatform).mockReturnValue(false);
      vi.mocked(readClipboardTextFallback).mockReset();
    }
  });

  it.each([
    ["pointer", (editor: Element) => fireEvent.pointerDown(editor)],
    ["navigation key", (editor: Element) => fireEvent.keyDown(editor, { key: "ArrowLeft" })],
  ])("keeps raw Android IME text after a user %s cancels the session", async (_kind, cancelSession) => {
    let editorRef: Editor | undefined;
    vi.mocked(isNativePlatform).mockReturnValue(true);
    vi.mocked(readClipboardTextFallback).mockResolvedValue("**候选文本**");

    try {
      render(
        <RichTextEditor
          value="<p></p>"
          onChange={vi.fn()}
          renderInsertTools={(editor) => {
            editorRef = editor;
            return null;
          }}
        />,
      );
      await waitFor(() => expect(editorRef).toBeDefined());
      const editor = document.querySelector(".rich-editor")!;
      fireEvent(editor, nativeInputEvent("beforeinput", "insertText"));
      act(() => {
        editorRef?.commands.insertContent("**候选文本**");
      });
      fireEvent(editor, nativeInputEvent("input", "insertText"));
      cancelSession(editor);

      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 170));
      });

      expect(editorRef?.getHTML()).toContain("**候选文本**");
      expect(editorRef?.getHTML()).not.toContain("<strong>候选文本</strong>");
      expect(readClipboardTextFallback).not.toHaveBeenCalled();
    } finally {
      vi.mocked(isNativePlatform).mockReturnValue(false);
      vi.mocked(readClipboardTextFallback).mockReset();
    }
  });

  it("keeps raw Android input when it does not match the native clipboard", async () => {
    let editorRef: Editor | undefined;
    vi.mocked(isNativePlatform).mockReturnValue(true);
    vi.mocked(readClipboardTextFallback).mockResolvedValue("## 剪贴板内容");

    try {
      render(
        <RichTextEditor
          value="<p></p>"
          onChange={vi.fn()}
          renderInsertTools={(editor) => {
            editorRef = editor;
            return null;
          }}
        />,
      );
      await waitFor(() => expect(editorRef).toBeDefined());
      const editor = document.querySelector(".rich-editor")!;
      fireEvent(editor, nativeInputEvent("beforeinput", "insertText"));
      act(() => {
        editorRef?.commands.insertContent("## 手工输入内容");
      });
      fireEvent(editor, nativeInputEvent("input", "insertText"));

      await waitFor(() => expect(editorRef?.getHTML()).toContain("## 手工输入内容"));
      expect(editorRef?.getHTML()).not.toContain("<h2>");
    } finally {
      vi.mocked(isNativePlatform).mockReturnValue(false);
      vi.mocked(readClipboardTextFallback).mockReset();
    }
  });

  it("falls back without parsing unsupported or oversized Markdown", () => {
    const onChange = vi.fn();
    let editorRef: Editor | undefined;
    render(
      <RichTextEditor
        value="<p></p>"
        onChange={onChange}
        renderInsertTools={(editor) => {
          editorRef = editor;
          return null;
        }}
      />,
    );
    const editor = document.querySelector(".rich-editor")!;
    const paste = (text: string) => fireEvent.paste(editor, {
      clipboardData: { getData: (type: string) => type === "text/plain" ? text : "", items: [] },
    });

    paste("# 标题\n~~不支持删除线~~");
    paste(`# 超大内容\n${"x".repeat(262144)}`);

    const html = editorRef?.getHTML() ?? "";
    expect(html).toContain("# 标题");
    expect(html).toContain("# 超大内容");
    expect(html).not.toContain("<h1>");
    expect(html).not.toContain("record-inline-math");
  });

  it("defers medium Markdown parsing while preserving the raw paste until replacement", async () => {
    const onChange = vi.fn();
    let editorRef: Editor | undefined;
    const source = Array.from({ length: 41 }, (_, index) => `# 空闲解析标题 ${index}\n\n内容 ${index}`).join("\n\n");
    render(
      <RichTextEditor
        value="<p></p>"
        onChange={onChange}
        renderInsertTools={(editor) => {
          editorRef = editor;
          return null;
        }}
      />,
    );

    fireEvent.paste(document.querySelector(".rich-editor")!, {
      clipboardData: { getData: (type: string) => type === "text/plain" ? source : "", items: [] },
    });

    expect(editorRef?.getHTML()).toContain("# 空闲解析标题");
    await waitFor(() => expect(editorRef?.getHTML()).toContain("<h1>空闲解析标题 0</h1>"));
    expect(editorRef?.getHTML()).not.toContain("# 空闲解析标题 0");
  });

  it("shows non-blocking conversion progress for a structurally large Android paste", async () => {
    let editorRef: Editor | undefined;
    const source = Array.from({ length: 25 }, (_, index) => `### 标题 ${index}\n\n- **重点 ${index}**`).join("\n\n");
    vi.mocked(isNativePlatform).mockReturnValue(true);
    vi.mocked(readClipboardTextFallback).mockResolvedValue(source);

    try {
      render(
        <RichTextEditor
          value="<p></p>"
          onChange={vi.fn()}
          renderInsertTools={(editor) => {
            editorRef = editor;
            return null;
          }}
        />,
      );

      fireEvent.paste(document.querySelector(".rich-editor")!, {
        clipboardData: { getData: () => "", items: [] },
      });

      await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("正在转换 Markdown"));
      expect(editorRef?.getHTML()).toContain("### 标题 0");
      await waitFor(() => expect(editorRef?.getHTML()).toContain("<h3>标题 0</h3>"));
    } finally {
      vi.mocked(isNativePlatform).mockReturnValue(false);
      vi.mocked(readClipboardTextFallback).mockReset();
    }
  });

  it("cancels a pending Markdown conversion without discarding raw remainder", async () => {
    let editorRef: Editor | undefined;
    const source = Array.from({ length: 121 }, (_, index) => `# 章节 ${index}\n\n内容 ${index}`).join("\n\n");
    render(
      <RichTextEditor
        value="<p></p>"
        onChange={vi.fn()}
        renderInsertTools={(editor) => {
          editorRef = editor;
          return null;
        }}
      />,
    );

    fireEvent.paste(document.querySelector(".rich-editor")!, {
      clipboardData: { getData: (type: string) => type === "text/plain" ? source : "", items: [] },
    });

    const cancel = await screen.findByRole("button", { name: "取消 Markdown 转换" });
    fireEvent.click(cancel);

    // The tail batch may have completed before the cancel click, but the
    // source content must remain regardless of whether it is raw or rendered.
    expect(editorRef?.getHTML()).toContain("章节 120");
    expect(screen.queryByRole("button", { name: "取消 Markdown 转换" })).not.toBeInTheDocument();
  });

  it("stops a streaming Android conversion when an IME emits input without beforeinput", async () => {
    let editorRef: Editor | undefined;
    const source = Array.from({ length: 25 }, (_, index) => `### 标题 ${index}\n\n内容`).join("\n\n");
    vi.mocked(isNativePlatform).mockReturnValue(true);
    vi.mocked(readClipboardTextFallback).mockResolvedValue(source);

    try {
      render(
        <RichTextEditor
          value="<p></p>"
          onChange={vi.fn()}
          renderInsertTools={(editor) => {
            editorRef = editor;
            return null;
          }}
        />,
      );
      const editorElement = document.querySelector(".rich-editor")!;
      fireEvent.paste(editorElement, { clipboardData: { getData: () => "", items: [] } });
      await screen.findByRole("button", { name: "取消 Markdown 转换" });

      act(() => {
        editorRef?.commands.insertContent("用户继续输入");
      });
      fireEvent(editorElement, nativeInputEvent("input", "insertText"));

      expect(editorRef?.getHTML()).toContain("用户继续输入");
      expect(screen.queryByRole("button", { name: "取消 Markdown 转换" })).not.toBeInTheDocument();
    } finally {
      vi.mocked(isNativePlatform).mockReturnValue(false);
      vi.mocked(readClipboardTextFallback).mockReset();
    }
  });

  it("keeps a streaming Markdown paste anchored while its image upload completes", async () => {
    let editorRef: Editor | undefined;
    let resolveUpload!: (asset: { id: string; kind: "image"; title: string }) => void;
    const imageUpload = new Promise<{ id: string; kind: "image"; title: string }>((resolve) => {
      resolveUpload = resolve;
    });
    const source = Array.from({ length: 41 }, (_, index) => `# 标题 ${index}\n\n内容`).join("\n\n");
    const image = new File(["image"], "clipboard.png", { type: "image/png" });
    render(
      <RichTextEditor
        value="<p></p>"
        onChange={vi.fn()}
        onPasteImage={() => imageUpload}
        renderInsertTools={(editor) => {
          editorRef = editor;
          return null;
        }}
      />,
    );

    fireEvent.paste(document.querySelector(".rich-editor")!, {
      clipboardData: {
        getData: (type: string) => type === "text/plain" ? source : "",
        items: [{ kind: "file", type: "image/png", getAsFile: () => image }],
      },
    });

    await screen.findByRole("button", { name: "取消 Markdown 转换" });
    await act(async () => {
      resolveUpload({ id: "asset-stream", kind: "image", title: "截图" });
    });

    await waitFor(() => expect(editorRef?.getHTML()).toContain("asset-stream"));
    await waitFor(() => expect(editorRef?.getHTML()).toContain("<h1>标题 0</h1>"));
  });

  it("keeps text when an image is pasted with Markdown that cannot be parsed", async () => {
    const onChange = vi.fn();
    const onPasteImage = vi.fn().mockResolvedValue({ id: "asset-1", kind: "image", title: "截图" });
    let editorRef: Editor | undefined;
    render(
      <RichTextEditor
        value="<p></p>"
        onChange={onChange}
        onPasteImage={onPasteImage}
        renderInsertTools={(editor) => {
          editorRef = editor;
          return null;
        }}
      />,
    );

    const image = new File(["image"], "clipboard.png", { type: "image/png" });
    fireEvent.paste(document.querySelector(".rich-editor")!, {
      clipboardData: {
        getData: (type: string) => type === "text/plain" ? "# 保留原文\n~~不支持删除线~~" : "",
        items: [{ kind: "file", type: "image/png", getAsFile: () => image }],
      },
    });

    await waitFor(() => expect(editorRef?.getHTML()).toContain("# 保留原文"));
    await waitFor(() => expect(editorRef?.getHTML()).toContain("record-asset"));
    expect(onPasteImage).toHaveBeenCalledWith(image);
  });

  it("does not insert an asynchronously uploaded paste image after the user continues editing", async () => {
    const imageUpload = new Promise<{ id: string; kind: "image"; title: string }>((resolve) => {
      setTimeout(() => resolve({ id: "asset-late", kind: "image", title: "延迟图片" }), 0);
    });
    const onPasteImage = vi.fn(() => imageUpload);
    let editorRef: Editor | undefined;
    render(
      <RichTextEditor
        value="<p></p>"
        onChange={vi.fn()}
        onPasteImage={onPasteImage}
        renderInsertTools={(editor) => {
          editorRef = editor;
          return null;
        }}
      />,
    );

    const image = new File(["image"], "late.png", { type: "image/png" });
    fireEvent.paste(document.querySelector(".rich-editor")!, {
      clipboardData: {
        getData: () => "",
        items: [{ kind: "file", type: "image/png", getAsFile: () => image }],
      },
    });
    act(() => {
      editorRef?.commands.insertContent("用户继续输入");
    });

    await imageUpload;
    await waitFor(() => expect(editorRef?.getHTML()).toContain("用户继续输入"));
    expect(editorRef?.getHTML()).not.toContain("asset-late");
  });

  it("immediately converts Markdown typed next to Chinese text", async () => {
    let editorRef: Editor | undefined;
    render(
      <RichTextEditor
        value="<p></p>"
        onChange={vi.fn()}
        renderInsertTools={(editor) => {
          editorRef = editor;
          return null;
        }}
      />,
    );

    await waitFor(() => expect(editorRef).toBeDefined());
    act(() => {
      editorRef?.commands.insertContent("中文**粗体**", { applyInputRules: true });
    });
    await waitFor(() => expect(editorRef?.getHTML()).toContain("中文<strong>粗体</strong>"));

    act(() => {
      editorRef?.commands.insertContent("以及*斜体*", { applyInputRules: true });
    });
    await waitFor(() => expect(editorRef?.getHTML()).toContain("<em>斜体</em>"));
  });

  it("creates inline and block formulas from direct Markdown input", async () => {
    let editorRef: Editor | undefined;
    render(
      <RichTextEditor
        value="<p></p>"
        onChange={vi.fn()}
        renderInsertTools={(editor) => {
          editorRef = editor;
          return null;
        }}
      />,
    );

    await waitFor(() => expect(editorRef).toBeDefined());
    act(() => {
      editorRef?.commands.insertContent("$x^2$", { applyInputRules: true });
    });
    await waitFor(() => expect(editorRef?.getHTML()).toContain("record-inline-math"));

    act(() => {
      editorRef?.commands.setContent("<p></p>");
      editorRef?.commands.insertContent("$$ ", { applyInputRules: true });
    });
    await waitFor(() => expect(editorRef?.getHTML()).toContain("record-formula"));
    expect(await screen.findByLabelText("块公式")).toBeInTheDocument();
  });

  it("converts Markdown after an Android-style composition commit", async () => {
    let editorRef: Editor | undefined;
    render(
      <RichTextEditor
        value="<p></p>"
        onChange={vi.fn()}
        renderInsertTools={(editor) => {
          editorRef = editor;
          return null;
        }}
      />,
    );

    await waitFor(() => expect(editorRef).toBeDefined());
    act(() => {
      editorRef?.commands.insertContent("中文**粗体**以及*斜体*和$\\frac{\\sin(x^2)}{x^2}$");
    });
    fireEvent.input(document.querySelector(".rich-editor")!);

    await waitFor(() => expect(editorRef?.getHTML()).toContain("中文<strong>粗体</strong>以及<em>斜体</em>和"));
    expect(editorRef?.getHTML()).toContain("record-inline-math");
  });

  it("keeps pasted inline formulas inside their surrounding paragraph", async () => {
    const onChange = vi.fn();
    render(<RichTextEditor value="<p></p>" onChange={onChange} />);

    fireEvent.paste(document.querySelector(".rich-editor")!, {
      clipboardData: {
        getData: (type: string) => type === "text/plain"
          ? "所以，式子就理所当然地变成了：\n$= \\lim_{x \\to 0^+} \\frac{-x^4}{ab x^{b-1}}$"
          : "",
        items: [],
      },
    });

    await waitFor(() => expect(onChange.mock.calls.at(-1)?.[0]).toContain("record-inline-math"));
    const html = onChange.mock.calls.at(-1)?.[0] ?? "";
    expect(html).toContain("<p>所以，式子就理所当然地变成了：");
    expect(html).toContain("<record-inline-math");
    expect(html).toContain('data-latex="= \\lim_{x \\to 0^+} \\frac{-x^4}{ab x^{b-1}}"');
    expect(html).not.toContain("</p><p><record-inline-math");
  });

  it("keeps pasted inline formulas and surrounding text inside one paragraph", async () => {
    const onChange = vi.fn();
    render(<RichTextEditor value="<p></p>" onChange={onChange} />);

    fireEvent.paste(document.querySelector(".rich-editor")!, {
      clipboardData: {
        getData: (type: string) => type === "text/plain" ? inlineMathPasteSample : "",
        items: [],
      },
    });

    await waitFor(() => expect(onChange.mock.calls.at(-1)?.[0]).toContain("record-inline-math"));
    expectInlineMathPasteParagraph(onChange.mock.calls.at(-1)?.[0] ?? "");
  });

  it("copies mixed Chinese and formulas as Markdown without writing, then restores formula nodes on paste", async () => {
    const onChange = vi.fn();
    let editorRef: Editor | undefined;
    render(
      <RichTextEditor
        value={[
          '<p>由 <record-inline-math data-formula-id="inline-source" data-latex="\\frac{a}{b}"></record-inline-math> 可得结论。</p>',
          '<record-formula data-formula-id="block-source" data-title="能量" data-latex="E=mc^2"></record-formula>',
          '<p>因此继续计算。</p>',
        ].join("")}
        onChange={onChange}
        renderInsertTools={(editor) => {
          editorRef = editor;
          return null;
        }}
      />,
    );

    await waitFor(() => expect(editorRef).toBeDefined());
    act(() => {
      editorRef!.commands.selectAll();
    });
    onChange.mockClear();

    const clipboard = new Map<string, string>();
    fireEvent.copy(document.querySelector(".rich-editor")!, {
      clipboardData: {
        clearData: vi.fn(),
        setData: (type: string, value: string) => clipboard.set(type, value),
      },
    });

    const copiedText = clipboard.get("text/plain") ?? "";
    const copiedHtml = clipboard.get("text/html") ?? "";
    expect(copiedText).toContain("由 $\\frac{a}{b}$ 可得结论。");
    expect(copiedText).toContain("\n\n$$\nE=mc^2\n$$\n\n因此继续计算。");
    expect(copiedHtml).toContain("$\\frac{a}{b}$");
    expect(copiedHtml).toContain("$$\nE=mc^2\n$$");
    expect(onChange).not.toHaveBeenCalled();

    act(() => {
      editorRef!.commands.setContent("<p></p>");
    });
    onChange.mockClear();
    fireEvent.paste(document.querySelector(".rich-editor")!, {
      clipboardData: {
        getData: (type: string) => type === "text/plain" ? copiedText : "",
        items: [],
      },
    });

    await waitFor(() => expect(editorRef?.getHTML()).toContain("record-formula"));
    const html = editorRef!.getHTML();
    const parsedDocument = new DOMParser().parseFromString(html, "text/html");
    const inlineFormula = parsedDocument.querySelector("record-inline-math");
    const blockFormula = parsedDocument.querySelector("record-formula");
    const syncedRecord = syncRecordRefsFromContent({
      ...referenceRecord("copied-formulas", "公式复制"),
      contentHtml: html,
    });

    expect(html).toContain("由 ");
    expect(html).toContain("可得结论。");
    expect(html).toContain("因此继续计算。");
    expect(inlineFormula?.getAttribute("data-latex")).toBe("\\frac{a}{b}");
    expect(blockFormula?.getAttribute("data-latex")).toBe("E=mc^2");
    expect(inlineFormula?.getAttribute("data-formula-id")).not.toBe("inline-source");
    expect(blockFormula?.getAttribute("data-formula-id")).not.toBe("block-source");
    expect(syncedRecord.formulas.map((formula) => formula.latex)).toEqual(["\\frac{a}{b}", "E=mc^2"]);
    expect(onChange).toHaveBeenCalled();
  });

  it("preserves a paragraph plus collapse block through the application clipboard", async () => {
    const onChange = vi.fn();
    let editorRef: Editor | undefined;
    render(
      <RichTextEditor
        value={[
          "<p>前面的正文</p>",
          '<record-collapse data-title="解析" data-summary="提示" data-default-open="false"><p>折叠正文</p></record-collapse>',
          "<p>后面的正文</p>",
        ].join("")}
        onChange={onChange}
        renderInsertTools={(editor) => {
          editorRef = editor;
          return null;
        }}
      />,
    );

    await waitFor(() => expect(editorRef).toBeDefined());
    act(() => editorRef!.commands.selectAll());
    const clipboard = new Map<string, string>();
    fireEvent.copy(document.querySelector(".rich-editor")!, {
      clipboardData: {
        clearData: vi.fn(),
        setData: (type: string, value: string) => clipboard.set(type, value),
      },
    });

    expect(clipboard.get("text/html")).toContain("record-collapse");
    expect(clipboard.get("text/html")).toContain("折叠正文");
    expect(clipboard.get("text/plain")).toContain("折叠正文");
    expect(clipboard.get("text/markdown")).toContain("折叠正文");

    act(() => editorRef!.commands.setContent("<p></p>"));
    fireEvent.paste(document.querySelector(".rich-editor")!, {
      clipboardData: {
        getData: (type: string) => clipboard.get(type) ?? "",
        items: [],
      },
    });

    await waitFor(() => expect(editorRef!.getHTML()).toContain("record-collapse"));
    expect(editorRef!.getHTML()).toContain("data-title=\"解析\"");
    expect(editorRef!.getHTML()).toContain("折叠正文");
  });

  it("cuts a paragraph plus collapse block as one structural selection", async () => {
    const onChange = vi.fn();
    let editorRef: Editor | undefined;
    render(
      <RichTextEditor
        value={'<p>前面的正文</p><record-collapse data-title="解析" data-summary="提示" data-default-open="false"><p>折叠正文</p></record-collapse><p>后面的正文</p>'}
        onChange={onChange}
        renderInsertTools={(editor) => {
          editorRef = editor;
          return null;
        }}
      />,
    );

    await waitFor(() => expect(editorRef).toBeDefined());
    act(() => editorRef!.commands.selectAll());
    const clipboard = new Map<string, string>();
    fireEvent.cut(document.querySelector(".rich-editor")!, {
      clipboardData: {
        clearData: vi.fn(),
        setData: (type: string, value: string) => clipboard.set(type, value),
      },
    });

    expect(clipboard.get("text/html")).toContain("record-collapse");
    await waitFor(() => expect(editorRef!.getHTML()).not.toContain("record-collapse"));
  });

  it("uses the readable HTML fallback when cutting a formula and collapse block together", async () => {
    const onChange = vi.fn();
    let editorRef: Editor | undefined;
    render(
      <RichTextEditor
        value={'<p>前面的 <record-inline-math data-formula-id="cut-inline" data-latex="x^2"></record-inline-math> 正文</p><record-collapse data-title="解析" data-summary="提示" data-default-open="false"><p>折叠正文</p></record-collapse>'}
        onChange={onChange}
        renderInsertTools={(editor) => {
          editorRef = editor;
          return null;
        }}
      />,
    );

    await waitFor(() => expect(editorRef).toBeDefined());
    act(() => editorRef!.commands.selectAll());
    const clipboard = new Map<string, string>();
    fireEvent.cut(document.querySelector(".rich-editor")!, {
      clipboardData: {
        clearData: vi.fn(),
        setData: (type: string, value: string) => clipboard.set(type, value),
      },
    });

    expect(clipboard.get("text/html")).toContain("$x^2$");
    expect(clipboard.get("text/html")).toContain("record-collapse");
    expect(clipboard.get("text/plain")).toContain("折叠正文");
    await waitFor(() => expect(editorRef!.getHTML()).not.toContain("record-collapse"));
  });

  it("keeps the collapse structure when a mixed selection also contains a formula", async () => {
    const onChange = vi.fn();
    let editorRef: Editor | undefined;
    render(
      <RichTextEditor
        value={'<p>前面的 <record-inline-math data-formula-id="mixed-inline" data-latex="x^2"></record-inline-math> 正文</p><record-collapse data-title="解析" data-summary="提示" data-default-open="false"><p>折叠正文</p></record-collapse><p>后面的正文</p>'}
        onChange={onChange}
        renderInsertTools={(editor) => {
          editorRef = editor;
          return null;
        }}
      />,
    );

    await waitFor(() => expect(editorRef).toBeDefined());
    act(() => editorRef!.commands.selectAll());
    const clipboard = new Map<string, string>();
    fireEvent.copy(document.querySelector(".rich-editor")!, {
      clipboardData: {
        clearData: vi.fn(),
        setData: (type: string, value: string) => clipboard.set(type, value),
      },
    });

    act(() => editorRef!.commands.setContent("<p></p>"));
    fireEvent.paste(document.querySelector(".rich-editor")!, {
      clipboardData: {
        getData: (type: string) => clipboard.get(type) ?? "",
        items: [],
      },
    });

    await waitFor(() => expect(editorRef!.getHTML()).toContain("record-inline-math"));
    expect(editorRef!.getHTML()).toContain("data-latex=\"x^2\"");
    expect(editorRef!.getHTML()).toContain("record-collapse");
  });

  it("copies formulas when the browser DOM selection spans their node views", async () => {
    let editorRef: Editor | undefined;
    render(
      <RichTextEditor
        value={[
          '<p>前文 <record-inline-math data-formula-id="dom-inline" data-latex="x^2"></record-inline-math> 后文</p>',
          '<record-formula data-formula-id="dom-block" data-latex="y=mx+b"></record-formula>',
          "<p>结尾</p>",
        ].join("")}
        onChange={vi.fn()}
        renderInsertTools={(editor) => {
          editorRef = editor;
          return null;
        }}
      />,
    );

    await waitFor(() => expect(editorRef).toBeDefined());
    const paragraphs = Array.from(document.querySelectorAll(".rich-editor > p"));
    const startText = paragraphs[0]?.firstChild;
    const endText = paragraphs[1]?.firstChild;
    expect(startText).toBeInstanceOf(Text);
    expect(endText).toBeInstanceOf(Text);
    const range = document.createRange();
    range.setStart(startText!, 0);
    range.setEnd(endText!, endText!.textContent?.length ?? 0);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
    document.dispatchEvent(new Event("selectionchange", { bubbles: true }));
    const clipboard = new Map<string, string>();
    fireEvent.copy(document.querySelector(".rich-editor")!, {
      clipboardData: {
        clearData: vi.fn(),
        setData: (type: string, value: string) => clipboard.set(type, value),
      },
    });

    expect(clipboard.get("text/plain")).toContain("$x^2$");
    expect(clipboard.get("text/plain")).toContain("$$\ny=mx+b\n$$");
    expect(clipboard.get("text/markdown")).toBe(clipboard.get("text/plain"));
  });

  it("copies formulas from a read-only review selection when Chromium targets body", async () => {
    render(
      <RichTextEditor
        value={[
          "<p>关于例 14.7 的通关练习题，做对这个意味着通关</p>",
          '<record-formula data-formula-id="review-formula" data-title="公式" data-latex="I=\\int_0^1 x\\arcsin\\sqrt{4x-4x^2}dx"></record-formula>',
          "<p></p>",
        ].join("")}
        onChange={vi.fn()}
        readOnly
      />,
    );

    await waitFor(() => expect(document.querySelector(".formula-editor-card")).toBeInTheDocument());
    const paragraphs = Array.from(document.querySelectorAll(".rich-editor > p"));
    const startText = paragraphs[0]?.firstChild;
    const trailingParagraph = paragraphs.at(-1);
    expect(startText).toBeInstanceOf(Text);
    expect(trailingParagraph).toBeInTheDocument();
    const range = document.createRange();
    range.setStart(startText!, 0);
    range.setEnd(trailingParagraph!, 0);
    const selection = window.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);

    const clipboard = new Map<string, string>();
    fireEvent.copy(document.body, {
      clipboardData: {
        clearData: vi.fn(),
        setData: (type: string, value: string) => clipboard.set(type, value),
      },
    });

    expect(clipboard.get("text/plain")).toContain("关于例 14.7 的通关练习题，做对这个意味着通关");
    expect(clipboard.get("text/plain")).toContain("$$\nI=\\int_0^1 x\\arcsin\\sqrt{4x-4x^2}dx\n$$");
    expect(clipboard.get("text/markdown")).toBe(clipboard.get("text/plain"));
  });

  it("keeps formulas crossed by a mixed DOM selection when endpoint mapping skips their atoms", async () => {
    let editorRef: Editor | undefined;
    render(
      <RichTextEditor
        value={[
          '<p>前文 <record-inline-math data-formula-id="skipped-inline" data-latex="x^2"></record-inline-math> 后文</p>',
          '<record-formula data-formula-id="skipped-block" data-latex="y=mx+b"></record-formula>',
          "<p>结尾</p>",
        ].join("")}
        onChange={vi.fn()}
        renderInsertTools={(editor) => {
          editorRef = editor;
          return null;
        }}
      />,
    );

    await waitFor(() => expect(editorRef).toBeDefined());
    const paragraphs = Array.from(document.querySelectorAll(".rich-editor > p"));
    const startText = paragraphs[0]?.firstChild;
    const endText = paragraphs[1]?.firstChild;
    expect(startText).toBeInstanceOf(Text);
    expect(endText).toBeInstanceOf(Text);
    const range = document.createRange();
    range.setStart(startText!, 0);
    range.setEnd(endText!, endText!.textContent?.length ?? 0);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
    document.dispatchEvent(new Event("selectionchange", { bubbles: true }));

    let firstTextFrom: number | undefined;
    let textBeforeInlineEnd: number | undefined;
    editorRef!.state.doc.descendants((node, position) => {
      if (node.isText && node.text === "前文 ") {
        firstTextFrom = position;
        textBeforeInlineEnd = position + node.nodeSize;
        return false;
      }
      return true;
    });
    expect(firstTextFrom).toBeDefined();
    expect(textBeforeInlineEnd).toBeDefined();

    // Simulate the browser bug: both endpoints resolve to text before the
    // contentEditable=false atoms, while the native range still spans them.
    const posAtDOM = vi.spyOn(editorRef!.view, "posAtDOM")
      .mockReturnValueOnce(firstTextFrom!)
      .mockReturnValueOnce(textBeforeInlineEnd!);
    try {
      const clipboard = new Map<string, string>();
      fireEvent.copy(document.querySelector(".rich-editor")!, {
        clipboardData: {
          clearData: vi.fn(),
          setData: (type: string, value: string) => clipboard.set(type, value),
        },
      });

      expect(clipboard.get("text/plain")).toContain("$x^2$");
      expect(clipboard.get("text/plain")).toContain("$$\ny=mx+b\n$$");
    } finally {
      posAtDOM.mockRestore();
    }
  });

  it("copies formula selections through the native clipboard when DOM clipboard data is unavailable", async () => {
    let editorRef: Editor | undefined;
    vi.mocked(isNativePlatform).mockReturnValue(true);
    try {
      render(
        <RichTextEditor
          value={'<p>前文 <record-inline-math data-formula-id="native-inline" data-latex="x^2"></record-inline-math> 后文</p>'}
          onChange={vi.fn()}
          renderInsertTools={(editor) => {
            editorRef = editor;
            return null;
          }}
        />,
      );

      await waitFor(() => expect(editorRef).toBeDefined());
      const paragraph = document.querySelector(".rich-editor > p")!;
      const range = document.createRange();
      range.setStart(paragraph.firstChild!, 0);
      range.setEnd(paragraph.lastChild!, paragraph.lastChild?.textContent?.length ?? 0);
      const selection = window.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(range);

      fireEvent.copy(document.querySelector(".rich-editor")!, { clipboardData: null });

      await waitFor(() => expect(writeNativeClipboardText).toHaveBeenCalledWith("前文 $x^2$ 后文"));
    } finally {
      vi.mocked(isNativePlatform).mockReturnValue(false);
      vi.mocked(writeNativeClipboardText).mockReset();
    }
  });

  it("selects a block formula on a single click so Ctrl+C includes its LaTeX", async () => {
    let editorRef: Editor | undefined;
    render(
      <RichTextEditor
        value={'<p>前文</p><record-formula data-formula-id="click-formula" data-title="公式" data-latex="y=mx+b"></record-formula><p>后文</p>'}
        onChange={vi.fn()}
        renderInsertTools={(editor) => {
          editorRef = editor;
          return null;
        }}
      />,
    );

    await waitFor(() => expect(editorRef).toBeDefined());
    const formulaCard = document.querySelector(".formula-editor-card");
    expect(formulaCard).toBeInTheDocument();
    fireEvent.click(formulaCard!);

    expect(editorRef!.state.selection).toBeInstanceOf(NodeSelection);
    expect(screen.queryByLabelText("块公式")).not.toBeInTheDocument();

    const clipboard = new Map<string, string>();
    fireEvent.copy(document.querySelector(".rich-editor")!, {
      clipboardData: {
        clearData: vi.fn(),
        setData: (type: string, value: string) => clipboard.set(type, value),
      },
    });

    expect(clipboard.get("text/plain")).toBe("$$\ny=mx+b\n$$");
    expect(clipboard.get("text/markdown")).toBe("$$\ny=mx+b\n$$");

    fireEvent.doubleClick(formulaCard!);
    expect(await screen.findByLabelText("块公式")).toBeInTheDocument();
  });

  it("recovers a formula when the browser leaves a collapsed caret inside its NodeView", async () => {
    let editorRef: Editor | undefined;
    render(
      <RichTextEditor
        value={'<p>前文</p><record-formula data-formula-id="collapsed-formula" data-latex="E=mc^2"></record-formula><p>后文</p>'}
        onChange={vi.fn()}
        renderInsertTools={(editor) => {
          editorRef = editor;
          return null;
        }}
      />,
    );

    await waitFor(() => expect(editorRef).toBeDefined());
    const formulaCard = document.querySelector(".formula-editor-card")!;
    const textNode = formulaCard.firstChild;
    expect(textNode).toBeTruthy();
    const range = document.createRange();
    range.setStart(textNode!, 0);
    range.collapse(true);
    const nativeSelection = window.getSelection()!;
    nativeSelection.removeAllRanges();
    nativeSelection.addRange(range);

    const clipboard = new Map<string, string>();
    fireEvent.copy(document.querySelector(".rich-editor")!, {
      clipboardData: {
        clearData: vi.fn(),
        setData: (type: string, value: string) => clipboard.set(type, value),
      },
    });

    expect(clipboard.get("text/plain")).toBe("$$\nE=mc^2\n$$");
  });

  it("creates a block formula on Enter and leaves Markdown literal inside code", async () => {
    let editorRef: Editor | undefined;
    render(
      <RichTextEditor
        value="<p></p>"
        onChange={vi.fn()}
        renderInsertTools={(editor) => {
          editorRef = editor;
          return null;
        }}
      />,
    );

    await waitFor(() => expect(editorRef).toBeDefined());
    act(() => {
      editorRef?.commands.insertContent("$$");
    });
    fireEvent.keyDown(document.querySelector(".rich-editor")!, { key: "Enter" });
    await waitFor(() => expect(editorRef?.getHTML()).toContain("record-formula"));

    act(() => {
      editorRef?.commands.setContent("<pre><code></code></pre>");
      editorRef?.commands.focus("end");
      editorRef?.commands.insertContent("$x$", { applyInputRules: true });
    });
    await waitFor(() => expect(editorRef?.getHTML()).toContain("$x$"));
    expect(editorRef?.getHTML()).not.toContain("record-inline-math");
  });

  it("does not convert formulas inside a double-backtick code span", async () => {
    let editorRef: Editor | undefined;
    render(
      <RichTextEditor
        value="<p></p>"
        onChange={vi.fn()}
        renderInsertTools={(editor) => {
          editorRef = editor;
          return null;
        }}
      />,
    );

    await waitFor(() => expect(editorRef).toBeDefined());
    act(() => editorRef?.commands.insertContent("``$x$``"));
    fireEvent.input(document.querySelector(".rich-editor")!);

    await waitFor(() => expect(editorRef?.getHTML()).toContain("``$x$``"));
    expect(editorRef?.getHTML()).not.toContain("record-inline-math");
  });

  it("renders formulas in edit mode and opens a source input only when selected", async () => {
    const onChange = vi.fn();
    render(
      <RichTextEditor
        value='<p>结论 <record-inline-math data-formula-id="f1" data-latex="x^2"></record-inline-math></p>'
        onChange={onChange}
      />,
    );

    let formula: Element | null = null;
    await waitFor(() => {
      formula = document.querySelector(".record-inline-math");
      expect(formula).toBeInTheDocument();
      expect(formula?.querySelector(".katex")).toBeInTheDocument();
    });
    expect(screen.queryByLabelText("行内公式")).not.toBeInTheDocument();

    fireEvent.click(formula!);
    const input = await screen.findByLabelText("行内公式");
    fireEvent.change(input, { target: { value: "y^2" } });
    fireEvent.blur(input);

    await waitFor(() => expect(onChange.mock.calls.at(-1)?.[0]).toContain('data-latex="y^2"'));
    expect(screen.queryByLabelText("行内公式")).not.toBeInTheDocument();
  });

  it("converts Markdown lists, quote, code and inline marks with the Tiptap schema", async () => {
    const onChange = vi.fn();
    render(<RichTextEditor value="<p></p>" onChange={onChange} />);

    const editor = document.querySelector(".rich-editor")!;
    fireEvent.paste(editor, {
      clipboardData: {
        getData: (type: string) => type === "text/plain"
          ? [
            "### 第三级标题",
            "",
            "> 引用内容",
            "",
            "- 无序项",
            "",
            "3. 有序项",
            "",
            "**加粗**和*斜体*以及`行内代码`",
            "",
            "```javascript",
            "const total = 1;",
            "```",
          ].join("\n")
          : "",
        items: [],
      },
    });

    await waitFor(() => expect(onChange.mock.calls.at(-1)?.[0]).toContain("<h3>第三级标题</h3>"));
    const html = onChange.mock.calls.at(-1)?.[0] ?? "";
    expect(html).toContain("<blockquote><p>引用内容</p></blockquote>");
    expect(html).toContain("<ul><li><p>无序项</p></li></ul>");
    expect(html).toContain('<ol start="3"><li><p>有序项</p></li></ol>');
    expect(html).toContain("<strong>加粗</strong>");
    expect(html).toContain("<em>斜体</em>");
    expect(html).toContain("<code>行内代码</code>");
    expect(html).toContain('language-javascript');
  });

  it("inserts a highlight block from the toolbar", async () => {
    const onChange = vi.fn();
    render(<RichTextEditor value="<p>Item</p>" onChange={onChange} />);

    fireEvent.click(screen.getByRole("button", { name: "高亮块" }));
    fireEvent.click(await screen.findByRole("button", { name: "浅粉色" }));

    await waitFor(() => expect(onChange).toHaveBeenCalledWith(expect.stringContaining("record-highlight-block")));
    expect(onChange.mock.calls.at(-1)?.[0]).toContain('data-tone="pink"');
  });

  it("replaces a deleted middle image with an editable paragraph", async () => {
    const onChange = vi.fn();
    let editorRef: Editor | undefined;
    render(
      <RichTextEditor
        value={[
          '<record-asset data-asset-id="image-1" data-kind="image" data-title="第一张"></record-asset>',
          '<record-asset data-asset-id="image-2" data-kind="image" data-title="第二张"></record-asset>',
          '<record-asset data-asset-id="image-3" data-kind="image" data-title="第三张"></record-asset>',
        ].join("")}
        onChange={onChange}
        renderInsertTools={(editor) => {
          editorRef = editor;
          return null;
        }}
      />,
    );

    fireEvent.click(await screen.findByRole("button", { name: "删除 image-2" }));

    await waitFor(() => expect(editorRef?.getHTML()).not.toContain("image-2"));
    const html = editorRef?.getHTML() ?? "";
    expect(html).toContain('data-asset-id="image-1"');
    expect(html).toContain('data-asset-id="image-3"');
    expect(html).toContain('</record-asset><p></p><record-asset');
    expect(onChange.mock.calls.at(-1)?.[0]).toBe(html);
  });

  it("keeps image deletion available inside nested blocks without exposing it for non-images", async () => {
    let editorRef: Editor | undefined;
    render(
      <RichTextEditor
        value={[
          '<record-collapse data-title="折叠" data-summary="" data-default-open="true">',
          '<record-highlight-block data-tone="yellow"><record-asset data-asset-id="nested-image" data-kind="image" data-title="图片"></record-asset></record-highlight-block>',
          '<record-asset data-asset-id="audio-1" data-kind="audio" data-title="录音"></record-asset>',
          "</record-collapse>",
        ].join("")}
        onChange={vi.fn()}
        renderInsertTools={(editor) => {
          editorRef = editor;
          return null;
        }}
      />,
    );

    fireEvent.click(await screen.findByRole("button", { name: "删除 nested-image" }));
    await waitFor(() => expect(editorRef?.getHTML()).not.toContain("nested-image"));
    expect(screen.queryByRole("button", { name: "删除 audio-1" })).not.toBeInTheDocument();
    expect(editorRef?.getHTML()).toContain('data-asset-id="audio-1"');
  });

  it("opens a record-wide image queue in document order from a nested preview", async () => {
    render(
      <RichTextEditor
        value={[
          '<record-asset data-asset-id="image-1" data-kind="image" data-title="第一张"></record-asset>',
          '<record-collapse data-title="折叠" data-summary="" data-default-open="true">',
          '<record-asset data-asset-id="image-2" data-kind="image" data-title="第二张"></record-asset>',
          '<record-highlight-block data-tone="yellow"><record-asset data-asset-id="image-3" data-kind="image" data-title="第三张"></record-asset></record-highlight-block>',
          "</record-collapse>",
          '<record-asset data-asset-id="image-1" data-kind="image" data-title="重复"></record-asset>',
        ].join("")}
        onChange={vi.fn()}
        readOnly
      />,
    );

    fireEvent.click(await screen.findByRole("button", { name: "预览 image-2" }));

    const lightbox = await screen.findByTestId("image-lightbox");
    expect(lightbox).toHaveAttribute("data-index", "1");
    expect(lightbox).toHaveAttribute("data-images", "image-1,image-2,image-3,image-1");
  });

  it("changes the active highlight tone instead of nesting another block", async () => {
    const onChange = vi.fn();
    let editorRef: Editor | undefined;

    render(
      <RichTextEditor
        value='<record-highlight-block data-tone="yellow"><p>重要内容</p></record-highlight-block><p>后文</p>'
        onChange={onChange}
        renderInsertTools={(editor) => {
          editorRef = editor;
          return null;
        }}
      />,
    );

    await waitFor(() => expect(editorRef).toBeDefined());
    act(() => setSelectionInsideText(editorRef as Editor, "重要内容"));
    fireEvent.click(screen.getByRole("button", { name: "高亮块" }));
    fireEvent.click(await screen.findByRole("button", { name: "浅粉色" }));

    await waitFor(() => {
      const html = onChange.mock.calls.at(-1)?.[0] ?? "";
      expect(html).toContain('data-tone="pink"');
      expect(html.match(/<record-highlight-block/g) ?? []).toHaveLength(1);
    });
  });

  it("renders highlight block tone choices without clipping inside the editor", async () => {
    render(
      <RichTextEditor
        value='<record-highlight-block data-tone="yellow"><p>重要内容</p></record-highlight-block>'
        onChange={vi.fn()}
      />,
    );

    await waitFor(() => expect(document.querySelector(".record-highlight-block.highlight-yellow")).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: "高亮颜色" }));

    expect(await screen.findByText("浅绿色")).toBeInTheDocument();
    expect(screen.getByText("浅黄色")).toBeInTheDocument();
    expect(screen.getByText("浅粉色")).toBeInTheDocument();
  });

  it("renders all highlight block tone classes and data attributes", async () => {
    render(
      <RichTextEditor
        value={[
          '<record-highlight-block data-tone="green"><p>绿色重点</p></record-highlight-block>',
          '<record-highlight-block data-tone="yellow"><p>黄色重点</p></record-highlight-block>',
          '<record-highlight-block data-tone="pink"><p>粉色重点</p></record-highlight-block>',
        ].join("")}
        onChange={vi.fn()}
      />,
    );

    await waitFor(() => expect(document.querySelectorAll(".record-highlight-block")).toHaveLength(3));
    for (const tone of ["green", "yellow", "pink"]) {
      expect(document.querySelector(`.record-highlight-block.highlight-${tone}[data-tone="${tone}"]`)).toBeInTheDocument();
    }
  });

  it("deletes only the targeted nested highlight block", async () => {
    const onChange = vi.fn();
    render(
      <RichTextEditor
        value={[
          '<record-highlight-block data-tone="green"><p>外层</p>',
          '<record-highlight-block data-tone="pink"><p>内层</p></record-highlight-block>',
          "</record-highlight-block>",
        ].join("")}
        onChange={onChange}
      />,
    );

    await waitFor(() => expect(document.querySelectorAll(".record-highlight-block")).toHaveLength(2));
    fireEvent.click(screen.getAllByRole("button", { name: "删除高亮块" })[1]);

    await waitFor(() => {
      const html = onChange.mock.calls.at(-1)?.[0] ?? "";
      expect(html).toContain("外层");
      expect(html).not.toContain("内层");
      expect(html.match(/<record-highlight-block/g) ?? []).toHaveLength(1);
    });
  });

  it("renders mixed media, collapse and structure blocks inside bounded editor nodes in read-only mode", async () => {
    const diagram = createDefaultStructureDiagram();
    diagram.title = "Layers";
    diagram.chain[0] = {
      ...diagram.chain[0],
      title: "Parent",
      branches: [[{ ...diagram.chain[0], id: "branch", title: "Branch child", branches: [] }]],
    };
    const comparison = createDefaultComparisonTable();
    comparison.columns = comparison.columns.map((column, index) => ({
      ...column,
      label: ["Concept", "Role", "Analogy", "Pitfall"][index] ?? column.label,
    }));
    comparison.rows[0].cells[comparison.columns[0].id] = "Logical file system";
    const sticky = createDefaultStickyBoard();
    sticky.notes[0].text = "A long local-search note should wrap inside the sticky card instead of widening the record page.";

    render(
      <RichTextEditor
        value={[
          '<record-asset data-asset-id="asset-1" data-kind="image" data-title="diagram.png"></record-asset>',
          '<record-collapse data-title="折叠块" data-summary="包含宽内容" data-default-open="true">',
          `<record-structure-diagram data-json='${serializeStructureData(diagram)}'></record-structure-diagram>`,
          "<p></p>",
          `<record-comparison-table data-json='${serializeStructureData(comparison)}'></record-comparison-table>`,
          `<record-sticky-board data-json='${serializeStructureData(sticky)}'></record-sticky-board>`,
          "</record-collapse>",
        ].join("")}
        onChange={vi.fn()}
        readOnly
      />,
    );

    await waitFor(() => expect(document.querySelector(".structure-flow-view")).toBeInTheDocument());
    await waitFor(() => expect(document.querySelector(".structure-flow-branch")).toBeInTheDocument());
    await waitFor(() => expect(document.querySelector(".comparison-table-view")).toBeInTheDocument());
    await waitFor(() => expect(document.querySelector(".comparison-panel-view")).toBeInTheDocument());
    await waitFor(() => expect(document.querySelector(".collapse-block-content")).toBeInTheDocument());
    await waitFor(() => expect(document.querySelector(".sticky-board-view")).toBeInTheDocument());
    expect(document.querySelector(".record-inline-node")).toBeInTheDocument();
    expect(document.querySelector(".comparison-fixed-panel")).toBeInTheDocument();
    expect(document.querySelector(".comparison-table-right-scroll")).toBeInTheDocument();
    expect(document.querySelector('[role="columnheader"].sticky-column')).toHaveTextContent("Concept");
    expect(document.querySelector('[role="cell"].sticky-column')).toHaveTextContent("Logical file system");
    expect(document.querySelectorAll(".comparison-table-right-scroll")).toHaveLength(1);
  });

  it("persists a selectable trailing paragraph for root, collapse, and highlight containers", async () => {
    const comparison = createDefaultComparisonTable();
    const sticky = createDefaultStickyBoard();
    const onChange = vi.fn();
    let editorRef: Editor | undefined;
    render(
      <RichTextEditor
        value={[
          '<record-collapse data-title="折叠块" data-summary="" data-default-open="true">',
          '<record-highlight-block data-tone="yellow"><record-asset data-asset-id="asset-1" data-kind="image" data-title="图片"></record-asset></record-highlight-block>',
          `<record-comparison-table data-json='${serializeStructureData(comparison)}'></record-comparison-table>`,
          `<record-sticky-board data-json='${serializeStructureData(sticky)}'></record-sticky-board>`,
          "</record-collapse>",
        ].join("")}
        onChange={onChange}
        renderInsertTools={(editor) => {
          editorRef = editor;
          return null;
        }}
      />,
    );

    await waitFor(() => expect(onChange).toHaveBeenCalled());
    const html = editorRef?.getHTML() ?? "";
    const content = new DOMParser().parseFromString(html, "text/html");
    const collapse = content.querySelector("record-collapse");
    const highlight = collapse?.querySelector("record-highlight-block");

    expect(highlight?.lastElementChild?.tagName).toBe("P");
    expect(collapse?.lastElementChild?.tagName).toBe("P");
    expect(content.body.lastElementChild?.tagName).toBe("P");
    expect(onChange.mock.calls.at(-1)?.[0]).toContain("</record-collapse><p></p>");
  });

  it("restores the trailing paragraph after deletion without growing duplicate blank lines", async () => {
    let editorRef: Editor | undefined;
    render(
      <RichTextEditor
        value="<p>末行文字</p><p></p>"
        onChange={vi.fn()}
        renderInsertTools={(editor) => {
          editorRef = editor;
          return null;
        }}
      />,
    );

    await waitFor(() => expect(editorRef).toBeDefined());
    act(() => {
      const end = editorRef!.state.doc.content.size;
      editorRef!.view.dispatch(editorRef!.state.tr.delete(end - 2, end));
    });

    expect(editorRef?.getHTML()).toBe("<p>末行文字</p><p></p>");
    expect(editorRef?.getHTML().match(/<p><\/p>/g)).toHaveLength(1);

    act(() => {
      editorRef?.commands.undo();
    });

    expect(editorRef?.getHTML()).toBe("<p>末行文字</p><p></p>");
    expect(editorRef?.getHTML().match(/<p><\/p>/g)).toHaveLength(1);
  });

  it("does not normalize or write back while rendering read-only content", () => {
    const onChange = vi.fn();
    render(
      <RichTextEditor
        value="<p>只读内容</p>"
        onChange={onChange}
        readOnly
      />,
    );

    expect(onChange).not.toHaveBeenCalledWith("<p>只读内容</p><p></p>");
  });

  it("uses a single right-side scroller for read-only comparison table columns", async () => {
    const comparison = createDefaultComparisonTable();
    comparison.columns = comparison.columns.map((column, index) => ({
      ...column,
      label: ["Concept", "Role", "Analogy", "Pitfall"][index] ?? column.label,
    }));

    render(
      <RichTextEditor
        value={`<record-comparison-table data-json='${serializeStructureData(comparison)}'></record-comparison-table>`}
        onChange={vi.fn()}
        readOnly
      />,
    );

    await waitFor(() => expect(document.querySelector(".comparison-table-right-scroll")).toBeInTheDocument());
    expect(document.querySelector(".comparison-fixed-panel")).toBeInTheDocument();
    expect(document.querySelectorAll(".comparison-table-right-scroll")).toHaveLength(1);
    expect(document.querySelectorAll(".comparison-scroll-grid-row")).toHaveLength(comparison.rows.length + 1);

    const rightScroller = document.querySelector<HTMLDivElement>(".comparison-table-right-scroll")!;
    rightScroller.scrollLeft = 96;
    fireEvent.scroll(rightScroller);

    expect(rightScroller.scrollLeft).toBe(96);
  });
});
