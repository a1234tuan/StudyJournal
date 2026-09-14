import type { Asset, RecordAssetRef, RecordBlock, RecordFormula } from "../types";
import { normalizeRecordTags } from "./recordTags";
import { structureBlockMarkdownFromElement, structureBlockPlainTextFromElement } from "./recordStructureBlocks";

export type LinearNode =
  | { kind: "text"; text: string; markdown?: string }
  | { kind: "asset"; ref: RecordAssetRef; asset?: Asset; ocrText?: string }
  | { kind: "formula"; formula: RecordFormula; inline: boolean }
  | { kind: "highlight"; text: string; markdown: string }
  | { kind: "structure"; text: string; markdown: string }
  | { kind: "mermaid"; text: string; markdown: string };

type RecordContentSyncOptions = {
  preserveLegacyRefs?: boolean;
};

// Preserve editor indentation through the existing whitespace normalization.
const RECORD_TAB_PLACEHOLDER = "\uE000";

const escapeHtml = (value: string): string =>
  value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

const decodeHtml = (value: string): string => {
  if (typeof document !== "undefined") {
    const textarea = document.createElement("textarea");
    textarea.innerHTML = value;
    return textarea.value;
  }
  return value
    .replace(/&quot;/g, '"')
    .replace(/&gt;/g, ">")
    .replace(/&lt;/g, "<")
    .replace(/&amp;/g, "&");
};

const htmlAttribute = (attributes: string, name: string): string => {
  const match = new RegExp(`\\b${name}=(?:"([^"]*)"|'([^']*)')`, "i").exec(attributes);
  return decodeHtml(match?.[1] ?? match?.[2] ?? "").trim();
};

const stripHtml = (html: string): string =>
  html
    .replace(/<record-tab\b[^>]*>(?:<\/record-tab>)?/gi, RECORD_TAB_PLACEHOLDER)
    .replace(/<record-reference\b[^>]*data-title=(?:"([^"]*)"|'([^']*)')[^>]*>(?:<\/record-reference>)?/gi, (_match, doubleQuoted, singleQuoted) =>
      `📎 ${decodeHtml(doubleQuoted ?? singleQuoted ?? "日志引用")}`,
    )
    .replace(/<record-reference\b[^>]*>(?:<\/record-reference>)?/gi, "📎 日志引用")
    // Block formulas render in place, matching the top-level `recordToPlainText` formula node
    // (`title\nlatex`). Previously they were dropped here and re-appended at the end of the
    // enclosing collapse/highlight block, which both detached them from their explanation and
    // duplicated every nested inline formula.
    .replace(/<record-formula\b([^>]*)>(?:<\/record-formula>)?/gi, (_match, attributes: string) =>
      [htmlAttribute(attributes, "data-title"), htmlAttribute(attributes, "data-latex")].filter(Boolean).join("\n"),
    )
    .replace(/<record-inline-math\b[^>]*data-latex=(?:"([^"]*)"|'([^']*)')[^>]*>(?:<\/record-inline-math>)?/gi, (_match, doubleQuoted, singleQuoted) =>
      `$${decodeHtml(doubleQuoted ?? singleQuoted ?? "")}$`,
    )
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|h[1-6]|li|blockquote)>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
    .replaceAll(RECORD_TAB_PLACEHOLDER, "\t");

const parseElement = (html: string): Document => new DOMParser().parseFromString(html, "text/html");

const recordReferenceMarkdown = (html: string): string =>
  html.replace(/<record-reference\b([^>]*)>(?:<\/record-reference>)?/gi, (_match, attributes: string) => {
    const recordId = /\bdata-record-id=(?:"([^"]*)"|'([^']*)')/i.exec(attributes);
    const title = /\bdata-title=(?:"([^"]*)"|'([^']*)')/i.exec(attributes);
    const id = decodeHtml(recordId?.[1] ?? recordId?.[2] ?? "").trim();
    const label = decodeHtml(title?.[1] ?? title?.[2] ?? "日志引用").trim() || "日志引用";
    return id ? `[📎 ${label}](record://${id})` : `📎 ${label}`;
  });

const inlineMarkdownText = (html: string): string => decodeHtml(stripHtml(recordReferenceMarkdown(html)));

const serializeAssetNode = (asset: RecordAssetRef): string =>
  `<record-asset data-asset-id="${escapeHtml(asset.id)}" data-kind="${escapeHtml(asset.kind)}" data-title="${escapeHtml(asset.title)}"></record-asset>`;

const serializeFormulaNode = (formula: RecordFormula): string =>
  `<record-formula data-formula-id="${escapeHtml(formula.id)}" data-title="${escapeHtml(formula.title ?? "")}" data-latex="${escapeHtml(formula.latex)}"></record-formula>`;

export const hasLinearRecordNodes = (contentHtml: string): boolean =>
  /<record-(asset|formula|inline-math|reference|tab|structure-diagram|comparison-table|sticky-board|collapse|highlight-block|mermaid-diagram|decision-block)\b/i.test(contentHtml);

export const normalizeRecordContent = (record: RecordBlock, options: RecordContentSyncOptions = {}): string => {
  if (hasLinearRecordNodes(record.contentHtml)) {
    return record.contentHtml || "<p></p>";
  }

  const baseContent = record.contentHtml?.trim() || "<p></p>";
  if (options.preserveLegacyRefs === false) {
    return baseContent;
  }

  const appended = [
    ...record.assets.map(serializeAssetNode),
    ...record.formulas.map(serializeFormulaNode),
  ];
  if (appended.length === 0) {
    return baseContent;
  }
  return [baseContent, ...appended, "<p></p>"].join("");
};

export const extractRecordRefsFromContent = (
  contentHtml: string,
): { assets: RecordAssetRef[]; formulas: RecordFormula[] } => {
  const doc = parseElement(contentHtml);
  const assets: RecordAssetRef[] = Array.from(doc.querySelectorAll("record-asset")).map((node) => ({
    id: node.getAttribute("data-asset-id") ?? "",
    kind: (node.getAttribute("data-kind") as RecordAssetRef["kind"]) ?? "attachment",
    title: node.getAttribute("data-title") ?? "资源",
  })).filter((asset) => Boolean(asset.id));

  const formulas: RecordFormula[] = Array.from(doc.querySelectorAll("record-formula, record-inline-math")).map((node) => ({
    id: node.getAttribute("data-formula-id") ?? "",
    title: node.getAttribute("data-title") || undefined,
    latex: node.getAttribute("data-latex") ?? "",
  })).filter((formula) => Boolean(formula.id));

  return { assets, formulas };
};

export const syncRecordRefsFromContent = (record: RecordBlock, options: RecordContentSyncOptions = {}): RecordBlock => {
  const contentHtml = normalizeRecordContent(record, options);
  const refs = extractRecordRefsFromContent(contentHtml);
  return {
    ...record,
    tags: normalizeRecordTags(record.tags),
    contentHtml,
    assets: refs.assets,
    formulas: refs.formulas,
    mistakeRefs: [],
  };
};

export const renameAssetTitleInContent = (
  contentHtml: string,
  assetId: string,
  title: string,
): { contentHtml: string; changed: boolean } => {
  const doc = parseElement(contentHtml);
  let changed = false;

  for (const node of Array.from(doc.querySelectorAll("record-asset"))) {
    if (node.getAttribute("data-asset-id") === assetId && node.getAttribute("data-title") !== title) {
      node.setAttribute("data-title", title);
      changed = true;
    }
  }

  return { contentHtml: doc.body.innerHTML, changed };
};

/**
 * Remove `<record-asset>` nodes that the export deliberately leaves out of a snapshot.
 *
 * Two kinds of reference can never be packed into a backup: generated podcast audio (the backup
 * format intentionally omits it, exactly as `normalizeSnapshotPodcasts` already strips
 * `audioAssetId` from podcast rows) and references left dangling by data that was already broken
 * locally. Writing either of them into a snapshot made `assertSnapshotIntegrity` treat the whole
 * snapshot as corrupt, which permanently blocked every backup channel — so the export drops the
 * node instead, and the caller decides which ids are droppable.
 *
 * Nested nodes are handled too, since asset references may live inside collapse / highlight /
 * decision blocks.
 */
export const stripRecordAssetRefs = (
  contentHtml: string,
  shouldDrop: (assetId: string) => boolean,
): { contentHtml: string; dropped: string[] } => {
  if (!contentHtml || !contentHtml.includes("record-asset")) {
    return { contentHtml, dropped: [] };
  }
  const doc = parseElement(contentHtml);
  const dropped: string[] = [];
  for (const node of Array.from(doc.querySelectorAll("record-asset"))) {
    const id = node.getAttribute("data-asset-id") ?? "";
    if (!id || !shouldDrop(id)) {
      continue;
    }
    dropped.push(id);
    node.remove();
  }
  return dropped.length === 0 ? { contentHtml, dropped } : { contentHtml: doc.body.innerHTML, dropped };
};

export const renameRecordAssetTitle = (
  record: RecordBlock,
  assetId: string,
  title: string,
): { record: RecordBlock; changed: boolean } => {
  const content = renameAssetTitleInContent(normalizeRecordContent(record), assetId, title);
  let changed = content.changed;

  const renamedAssets = record.assets.map((asset) => {
    if (asset.id !== assetId || asset.title === title) {
      return asset;
    }
    changed = true;
    return { ...asset, title };
  });

  if (!changed) {
    return { record, changed: false };
  }

  return {
    record: syncRecordRefsFromContent({
      ...record,
      contentHtml: content.contentHtml,
      assets: renamedAssets,
    }),
    changed: true,
  };
};

const isStructureBlockTag = (tag: string): boolean =>
  tag === "record-structure-diagram" || tag === "record-comparison-table" || tag === "record-sticky-board";

const collapseElementText = (element: Element, assetMap: Map<string, Asset>, useReferenceMarkdown = false): string => {
  const title = element.getAttribute("data-title") ?? "折叠块";
  const summary = element.getAttribute("data-summary") ?? "";
  const bodyText = useReferenceMarkdown ? inlineMarkdownText(element.innerHTML) : decodeHtml(stripHtml(element.innerHTML));
  const structures = Array.from(element.querySelectorAll("record-structure-diagram, record-comparison-table, record-sticky-board"))
    .map(structureBlockPlainTextFromElement);
  const assets = Array.from(element.querySelectorAll("record-asset")).map((node) => {
    const id = node.getAttribute("data-asset-id") ?? "";
    const asset = assetMap.get(id);
    return [node.getAttribute("data-title"), asset?.title, asset?.fileName, asset?.ocrText].filter(Boolean).join("\n");
  });
  return [title, summary, bodyText, ...structures, ...assets].filter(Boolean).join("\n");
};

const collapseElementMarkdown = (element: Element, assetMap: Map<string, Asset>): string => {
  const open = element.getAttribute("data-default-open") === "true" ? " open" : "";
  const title = element.getAttribute("data-title") ?? "折叠块";
  const summary = element.getAttribute("data-summary");
  const body = collapseElementText(element, assetMap, true)
    .split("\n")
    .filter((line) => line !== title && line !== summary)
    .join("\n");
  return [`<details${open}>`, `<summary>${[title, summary].filter(Boolean).join(" · ")}</summary>`, "", body, "</details>"].join("\n");
};

const highlightToneLabel = (tone: string | null): string => {
  switch (tone) {
    case "yellow":
      return "浅黄色高亮";
    case "pink":
      return "浅粉色高亮";
    default:
      return "浅绿色高亮";
  }
};

const highlightElementText = (
  element: Element,
  assetMap: Map<string, Asset> = new Map(),
  useReferenceMarkdown = false,
): string => {
  const body = useReferenceMarkdown ? inlineMarkdownText(element.innerHTML) : decodeHtml(stripHtml(element.innerHTML));
  const assets = Array.from(element.querySelectorAll("record-asset")).map((node) => {
    const id = node.getAttribute("data-asset-id") ?? "";
    const asset = assetMap.get(id);
    return [node.getAttribute("data-title"), asset?.title, asset?.fileName, asset?.ocrText].filter(Boolean).join("\n");
  });
  return [body, ...assets].filter(Boolean).join("\n");
};

const highlightElementMarkdown = (element: Element, assetMap: Map<string, Asset> = new Map()): string => {
  const text = highlightElementText(element, assetMap, true);
  const lines = text.split("\n").filter(Boolean);
  return [`> ${highlightToneLabel(element.getAttribute("data-tone"))}`, ...lines.map((line) => `> ${line}`)].join("\n");
};

export const parseLinearRecordContent = (record: RecordBlock, assets: Asset[] = []): LinearNode[] => {
  const contentHtml = normalizeRecordContent(record);
  const doc = parseElement(contentHtml);
  const assetMap = new Map(assets.map((asset) => [asset.id, asset]));
  const nodes: LinearNode[] = [];

  for (const child of Array.from(doc.body.childNodes)) {
    if (child.nodeType === 1) {
      const element = child as HTMLElement;
      const tag = element.tagName.toLowerCase();
      if (tag === "record-decision-block") {
        nodes.push(...parseLinearRecordContent({ ...record, contentHtml: element.innerHTML }, assets));
        continue;
      }
      if (tag === "record-asset") {
        const id = element.getAttribute("data-asset-id") ?? "";
        const asset = assetMap.get(id);
        nodes.push({
          kind: "asset",
          ref: {
            id,
            kind: (element.getAttribute("data-kind") as RecordAssetRef["kind"]) ?? asset?.kind ?? "attachment",
            title: element.getAttribute("data-title") ?? asset?.title ?? asset?.fileName ?? "资源",
          },
          asset,
          ocrText: asset?.ocrText,
        });
        continue;
      }
      if (tag === "record-formula" || tag === "record-inline-math") {
        nodes.push({
          kind: "formula",
          inline: tag === "record-inline-math",
          formula: {
            id: element.getAttribute("data-formula-id") ?? "",
            title: element.getAttribute("data-title") || undefined,
            latex: element.getAttribute("data-latex") ?? "",
          },
        });
        continue;
      }
      if (isStructureBlockTag(tag)) {
        nodes.push({
          kind: "structure",
          text: structureBlockPlainTextFromElement(element),
          markdown: structureBlockMarkdownFromElement(element),
        });
        continue;
      }
      if (tag === "record-collapse") {
        nodes.push({
          kind: "structure",
          text: collapseElementText(element, assetMap),
          markdown: collapseElementMarkdown(element, assetMap),
        });
        continue;
      }
      if (tag === "record-highlight-block") {
        nodes.push({
          kind: "highlight",
          text: highlightElementText(element, assetMap),
          markdown: highlightElementMarkdown(element, assetMap),
        });
        continue;
      }
      if (tag === "record-mermaid-diagram") {
        const source = element.getAttribute("data-source") ?? "";
        nodes.push({
          kind: "mermaid",
          text: source,
          markdown: ["```mermaid", source, "```"].join("\n"),
        });
        continue;
      }
    }

    const wrapper = document.createElement("div");
    wrapper.append(child.cloneNode(true));
    const html = wrapper.innerHTML;
    const text = decodeHtml(stripHtml(html));
    if (text) {
      nodes.push({ kind: "text", text, markdown: inlineMarkdownText(html) });
    }
  }

  return nodes;
};

const linearNodeToPlainText = (node: LinearNode): string => {
  if (node.kind === "text") {
    return node.text;
  }
  if (node.kind === "formula") {
    const formula = [node.formula.title, node.formula.latex].filter(Boolean).join("\n");
    return node.inline ? `$${formula}$` : formula;
  }
  if (node.kind === "structure") {
    return node.text;
  }
  if (node.kind === "highlight") {
    return node.text;
  }
  if (node.kind === "mermaid") {
    return node.text;
  }
  const assetLabel = [node.ref.title, node.asset?.title, node.asset?.fileName].filter(Boolean).join(" / ");
  return [assetLabel, node.ocrText].filter(Boolean).join("\n");
};

/**
 * Plain-text projection of the record, one entry per linear node, in reading order.
 *
 * Callers that have to fit a record into a token budget use this instead of `recordToPlainText`
 * so they can truncate on node boundaries and never cut through a formula or a sentence.
 */
export const recordToPlainTextNodes = (record: RecordBlock, assets: Asset[] = []): string[] =>
  parseLinearRecordContent(record, assets)
    .map(linearNodeToPlainText)
    .filter(Boolean);

export const recordToPlainText = (record: RecordBlock, assets: Asset[] = []): string =>
  recordToPlainTextNodes(record, assets).join("\n\n");

export const recordToLinearMarkdown = (record: RecordBlock, assets: Asset[] = []): string =>
  [
    `## ${record.title}`,
    "",
    `学科：${record.subject}`,
    "",
    ...parseLinearRecordContent(record, assets).map((node) => {
      if (node.kind === "text") {
        return node.markdown ?? node.text;
      }
      if (node.kind === "formula") {
        if (node.inline) {
          return `$${node.formula.latex}$`;
        }
        return [
          node.formula.title ? `### ${node.formula.title}` : "",
          `$$\n${node.formula.latex}\n$$`,
        ].filter(Boolean).join("\n");
      }
      if (node.kind === "structure") {
        return node.markdown;
      }
      if (node.kind === "highlight") {
        return node.markdown;
      }
      if (node.kind === "mermaid") {
        return node.markdown;
      }
      const assetName = node.asset?.fileName ?? node.ref.title;
      const assetText = node.ref.kind === "image"
        ? `![${node.ref.title}](../assets/${node.ref.id}-${assetName})`
        : `[${node.ref.title}](../assets/${node.ref.id}-${assetName})`;
      return [assetText, node.ocrText ? `\n> 图片 OCR：${node.ocrText}` : ""].filter(Boolean).join("");
    }),
    "",
  ].join("\n");
