import { Node, mergeAttributes } from "@tiptap/core";
import { NodeViewWrapper, ReactNodeViewRenderer, type NodeViewProps } from "@tiptap/react";
import { NodeSelection, TextSelection } from "@tiptap/pm/state";
import { type FocusEvent, type KeyboardEvent, type MouseEvent, useCallback, useEffect, useRef, useState } from "react";
import { Paperclip } from "lucide-react";

import type { RecordAssetRef } from "../types";
import { AssetPreview } from "./AssetPreview";
import { useDeferredKaTeX } from "./DeferredMath";

type RecordAssetNodeOptions = {
  onAssetChanged?: () => void;
  onAssetTitleChange?: (assetId: string, title: string) => Promise<void> | void;
  onOpenImage?: (assetRef: RecordAssetRef, position: number) => void;
  highlightedAssetId?: string;
};

type RecordAssetNodeViewProps = NodeViewProps & {
  extensionOptions: RecordAssetNodeOptions;
};

export type RecordReferenceTarget = {
  id: string;
  title: string;
};

type RecordReferenceNodeOptions = {
  resolveReference?: (recordId: string) => RecordReferenceTarget | undefined;
  subscribeReferenceChanges?: (listener: () => void) => () => void;
  onOpenReference?: (recordId: string) => void;
};

const asAssetKind = (value: unknown): RecordAssetRef["kind"] =>
  value === "image" || value === "audio" || value === "attachment" ? value : "attachment";

const RecordAssetNodeView = ({ node, getPos, updateAttributes, extensionOptions, editor }: RecordAssetNodeViewProps) => {
  const assetRef: RecordAssetRef = {
    id: String(node.attrs.assetId ?? ""),
    kind: asAssetKind(node.attrs.kind),
    title: String(node.attrs.title ?? "资源"),
  };

  const editable = editor.isEditable;
  const getNodePosition = (): number | undefined => {
    try {
      const position = typeof getPos === "function" ? getPos() : getPos;
      return typeof position === "number" ? position : undefined;
    } catch {
      return undefined;
    }
  };

  const openImage = () => {
    const position = getNodePosition();
    if (assetRef.kind === "image" && position !== undefined) {
      extensionOptions.onOpenImage?.(assetRef, position);
    }
  };

  const deleteImage = () => {
    const position = getNodePosition();
    const paragraph = editor.state.schema.nodes.paragraph;
    if (assetRef.kind !== "image" || position === undefined || !paragraph) {
      return;
    }
    const transaction = editor.state.tr.replaceWith(position, position + node.nodeSize, paragraph.create());
    try {
      transaction.setSelection(TextSelection.near(transaction.doc.resolve(position + 1), 1));
    } catch {
      // The replacement paragraph is still valid even if a nested container
      // maps the selection to a different boundary.
    }
    editor.view.dispatch(transaction.scrollIntoView());
  };

  return (
    <NodeViewWrapper className="record-inline-node">
      <AssetPreview
        assetRef={assetRef}
        mode={editable ? "edit" : "view"}
        editableTitle={editable ? assetRef.title : undefined}
        onTitleChange={editable ? (title) => updateAttributes({ title }) : undefined}
        onTitleCommit={editable ? (title) => void extensionOptions.onAssetTitleChange?.(assetRef.id, title) : undefined}
        onAssetChanged={extensionOptions.onAssetChanged}
        onOpenImage={assetRef.kind === "image" ? openImage : undefined}
        onDeleteImage={editable && assetRef.kind === "image" ? deleteImage : undefined}
        highlight={assetRef.id === extensionOptions.highlightedAssetId}
      />
    </NodeViewWrapper>
  );
};

const RecordFormulaNodeView = ({ node, updateAttributes, editor, getPos }: NodeViewProps) => {
  const title = String(node.attrs.title ?? "");
  const latex = String(node.attrs.latex ?? "");
  const editable = editor.isEditable;
  const [editing, setEditing] = useState(false);
  const [draftTitle, setDraftTitle] = useState(title);
  const [draftLatex, setDraftLatex] = useState(latex);
  const { hostRef, html } = useDeferredKaTeX(latex, true, editing);

  useEffect(() => {
    if (!editing) {
      setDraftTitle(title);
      setDraftLatex(latex);
    }
  }, [editing, latex, title]);

  useEffect(() => {
    if (editable && node.attrs.editing) {
      setEditing(true);
    }
  }, [editable, node.attrs.editing]);

  const commit = () => {
    updateAttributes({ title: draftTitle, latex: draftLatex, editing: false });
    setEditing(false);
  };

  const cancel = () => {
    updateAttributes({ editing: false });
    setDraftTitle(title);
    setDraftLatex(latex);
    setEditing(false);
  };

  const selectNode = () => {
    const position = getPos();
    if (typeof position !== "number" || editor.isDestroyed) {
      return;
    }
    editor.view.dispatch(
      editor.state.tr
        .setSelection(NodeSelection.create(editor.state.doc, position))
        .scrollIntoView(),
    );
  };

  const beginEditing = () => {
    if (!editable || editing) {
      return;
    }
    updateAttributes({ editing: true });
    setEditing(true);
  };

  const commitOnBlur = (event: FocusEvent<HTMLInputElement | HTMLTextAreaElement>) => {
    const nextTarget = event.relatedTarget;
    if (nextTarget instanceof globalThis.Node && event.currentTarget.parentElement?.contains(nextTarget)) {
      return;
    }
    commit();
  };

  return (
    <NodeViewWrapper
      className="record-inline-node formula-editor-card"
      contentEditable={false}
      onClick={() => {
        if (!editing) {
          selectNode();
        }
      }}
      onDoubleClick={beginEditing}
      data-latex={latex}
    >
      {editing ? (
        <>
          <input value={draftTitle} placeholder="公式标题" onChange={(event) => setDraftTitle(event.target.value)} onBlur={commitOnBlur} />
          <textarea
            autoFocus
            value={draftLatex}
            aria-label="块公式"
            onChange={(event) => setDraftLatex(event.target.value)}
            onBlur={commitOnBlur}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                event.preventDefault();
                cancel();
              }
              if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
                event.preventDefault();
                commit();
              }
            }}
          />
        </>
      ) : (
        title && <strong>{title}</strong>
      )}
      <div ref={hostRef} className="formula-preview">
        {html ? <span dangerouslySetInnerHTML={{ __html: html }} /> : <code className="formula-render-pending">{latex}</code>}
      </div>
    </NodeViewWrapper>
  );
};

const RecordInlineMathNodeView = ({ node, updateAttributes, editor }: NodeViewProps) => {
  const latex = String(node.attrs.latex ?? "");
  const editable = editor.isEditable;
  const [editing, setEditing] = useState(false);
  const [draftLatex, setDraftLatex] = useState(latex);
  const { hostRef, html } = useDeferredKaTeX(latex, false, editing);

  useEffect(() => {
    if (!editing) {
      setDraftLatex(latex);
    }
  }, [editing, latex]);

  useEffect(() => {
    if (editable && node.attrs.editing) {
      setEditing(true);
    }
  }, [editable, node.attrs.editing]);

  const commit = () => {
    updateAttributes({ latex: draftLatex, editing: false });
    setEditing(false);
  };

  const cancel = () => {
    updateAttributes({ editing: false });
    setDraftLatex(latex);
    setEditing(false);
  };

  return (
    <NodeViewWrapper as="span" className="record-inline-math" contentEditable={false} onClick={() => {
      if (editable && !editing) {
        setEditing(true);
      }
    }} data-latex={latex}>
      {editing ? (
        <input
          autoFocus
          aria-label="行内公式"
          value={draftLatex}
          onChange={(event) => setDraftLatex(event.target.value)}
          onBlur={commit}
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.preventDefault();
              cancel();
            }
            if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
              event.preventDefault();
              commit();
            }
          }}
        />
      ) : html ? (
        <span ref={hostRef} dangerouslySetInnerHTML={{ __html: html }} />
      ) : (
        <code ref={hostRef} className="formula-render-pending">{latex}</code>
      )}
    </NodeViewWrapper>
  );
};

const RecordReferenceNodeView = ({ node, editor, extensionOptions }: NodeViewProps & { extensionOptions: RecordReferenceNodeOptions }) => {
  const recordId = String(node.attrs.recordId ?? "");
  const savedTitle = String(node.attrs.title ?? "日志引用");
  const target = recordId ? extensionOptions.resolveReference?.(recordId) : undefined;
  const available = Boolean(target);
  const title = target?.title?.trim() || savedTitle;
  const label = available ? `引用日志：${title}` : `已删除的日志：${title}`;

  const [, setReferenceVersion] = useState(0);
  useEffect(() => extensionOptions.subscribeReferenceChanges?.(() => {
    setReferenceVersion((version) => version + 1);
  }), [extensionOptions]);

  const open = (event: MouseEvent<HTMLSpanElement> | KeyboardEvent<HTMLSpanElement>) => {
    if (editor.isEditable) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    if (available) {
      extensionOptions.onOpenReference?.(recordId);
    }
  };

  return (
    <NodeViewWrapper
      as="span"
      className={`record-reference-node${available ? "" : " unavailable"}`}
      contentEditable={false}
      role={!editor.isEditable && available ? "link" : undefined}
      tabIndex={!editor.isEditable && available ? 0 : undefined}
      aria-label={label}
      aria-disabled={!available || undefined}
      title={available ? title : "该日志已删除，无法打开预览"}
      onClick={open}
      onKeyDown={(event: KeyboardEvent<HTMLSpanElement>) => {
        if ((event.key === "Enter" || event.key === " ") && !editor.isEditable) {
          open(event);
        }
      }}
    >
      <Paperclip size={14} strokeWidth={2} aria-hidden="true" />
      <span>{available ? title : `已删除：${title}`}</span>
    </NodeViewWrapper>
  );
};

export const RecordAssetNode = Node.create({
  name: "recordAsset",
  addOptions() {
    return {
      onAssetChanged: undefined,
      onAssetTitleChange: undefined,
      onOpenImage: undefined,
      highlightedAssetId: undefined,
    } satisfies RecordAssetNodeOptions;
  },
  group: "block",
  atom: true,
  draggable: false,

  addAttributes() {
    return {
      assetId: {
        default: "",
        parseHTML: (element) => element.getAttribute("data-asset-id") ?? "",
        renderHTML: (attributes) => ({ "data-asset-id": attributes.assetId }),
      },
      kind: {
        default: "attachment",
        parseHTML: (element) => element.getAttribute("data-kind") ?? "attachment",
        renderHTML: (attributes) => ({ "data-kind": attributes.kind }),
      },
      title: {
        default: "资源",
        parseHTML: (element) => element.getAttribute("data-title") ?? "资源",
        renderHTML: (attributes) => ({ "data-title": attributes.title }),
      },
    };
  },

  parseHTML() {
    return [{ tag: "record-asset" }];
  },

  renderHTML({ HTMLAttributes }) {
    return ["record-asset", mergeAttributes(HTMLAttributes)];
  },

  addNodeView() {
    const extensionOptions = this.options as RecordAssetNodeOptions;
    return ReactNodeViewRenderer((props) => <RecordAssetNodeView {...props} extensionOptions={extensionOptions} />);
  },
});

export const RecordFormulaNode = Node.create({
  name: "recordFormula",
  group: "block",
  atom: true,
  draggable: false,

  addAttributes() {
    return {
      formulaId: {
        default: "",
        parseHTML: (element) => element.getAttribute("data-formula-id") ?? "",
        renderHTML: (attributes) => ({ "data-formula-id": attributes.formulaId }),
      },
      title: {
        default: "公式",
        parseHTML: (element) => element.getAttribute("data-title") ?? "公式",
        renderHTML: (attributes) => ({ "data-title": attributes.title }),
      },
      latex: {
        default: "T(n)=O(n\\log n)",
        parseHTML: (element) => element.getAttribute("data-latex") ?? "T(n)=O(n\\log n)",
        renderHTML: (attributes) => ({ "data-latex": attributes.latex }),
      },
      editing: {
        default: false,
        parseHTML: () => false,
        renderHTML: () => ({}),
      },
    };
  },

  parseHTML() {
    return [{ tag: "record-formula" }];
  },

  renderHTML({ HTMLAttributes }) {
    return ["record-formula", mergeAttributes(HTMLAttributes)];
  },

  addNodeView() {
    return ReactNodeViewRenderer(RecordFormulaNodeView);
  },

  addKeyboardShortcuts() {
    return {
      Enter: () => {
        const { selection } = this.editor.state;
        if (!(selection instanceof NodeSelection) || selection.node.type !== this.type) {
          return false;
        }
        return this.editor.commands.command(({ tr }) => {
          tr.setNodeMarkup(selection.from, undefined, { ...selection.node.attrs, editing: true });
          return true;
        });
      },
    };
  },
});

export const RecordInlineMathNode = Node.create({
  name: "recordInlineMath",
  inline: true,
  group: "inline",
  atom: true,
  selectable: true,
  draggable: false,

  addAttributes() {
    return {
      formulaId: {
        default: "",
        parseHTML: (element) => element.getAttribute("data-formula-id") ?? "",
        renderHTML: (attributes) => ({ "data-formula-id": attributes.formulaId }),
      },
      latex: {
        default: "x^2",
        parseHTML: (element) => element.getAttribute("data-latex") ?? "x^2",
        renderHTML: (attributes) => ({ "data-latex": attributes.latex }),
      },
      editing: {
        default: false,
        parseHTML: () => false,
        renderHTML: () => ({}),
      },
    };
  },

  parseHTML() {
    return [{ tag: "record-inline-math" }];
  },

  renderHTML({ HTMLAttributes }) {
    return ["record-inline-math", mergeAttributes(HTMLAttributes)];
  },

  addNodeView() {
    return ReactNodeViewRenderer(RecordInlineMathNodeView);
  },

  addKeyboardShortcuts() {
    return {
      Enter: () => {
        const { selection } = this.editor.state;
        if (!(selection instanceof NodeSelection) || selection.node.type !== this.type) {
          return false;
        }
        return this.editor.commands.command(({ tr }) => {
          tr.setNodeMarkup(selection.from, undefined, { ...selection.node.attrs, editing: true });
          return true;
        });
      },
    };
  },
});

export const RecordReferenceNode = Node.create({
  name: "recordReference",
  inline: true,
  group: "inline",
  atom: true,
  selectable: true,
  draggable: false,

  addOptions() {
    return {
      resolveReference: undefined,
      subscribeReferenceChanges: undefined,
      onOpenReference: undefined,
    } satisfies RecordReferenceNodeOptions;
  },

  addAttributes() {
    return {
      recordId: {
        default: "",
        parseHTML: (element) => element.getAttribute("data-record-id") ?? "",
        renderHTML: (attributes) => ({ "data-record-id": attributes.recordId }),
      },
      title: {
        default: "日志引用",
        parseHTML: (element) => element.getAttribute("data-title") ?? "日志引用",
        renderHTML: (attributes) => ({ "data-title": attributes.title }),
      },
    };
  },

  parseHTML() {
    return [{ tag: "record-reference" }];
  },

  renderHTML({ HTMLAttributes }) {
    return ["record-reference", mergeAttributes(HTMLAttributes)];
  },

  addNodeView() {
    const extensionOptions = this.options as RecordReferenceNodeOptions;
    return ReactNodeViewRenderer((props) => <RecordReferenceNodeView {...props} extensionOptions={extensionOptions} />);
  },
});

export const RecordTabStopNode = Node.create({
  name: "recordTabStop",
  inline: true,
  group: "inline",
  atom: true,
  selectable: true,
  draggable: false,

  parseHTML() {
    return [{ tag: "record-tab" }];
  },

  renderHTML({ HTMLAttributes }) {
    return ["record-tab", mergeAttributes(HTMLAttributes, { "data-width": "4", "aria-label": "缩进" })];
  },

  renderText() {
    return "\t";
  },
});
