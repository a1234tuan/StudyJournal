import JSZip from "jszip";
import { Share } from "@capacitor/share";
import { saveAs } from "file-saver";

import type {
  Asset,
  ExportKind,
  ExportOptions,
  KnowledgeExportPayload,
  KnowledgeRecord,
  RecordBlock,
  StorageAdapter,
  StorageSnapshot,
} from "../types";
import { getAllVisibleSubjects } from "../lib/subjects";
import { snapshotToZip } from "./backup";
import { isNativePlatform } from "../lib/platform";
import { sanitizeFileName } from "./assetDownloadService";
import { parseLinearRecordContent, recordToLinearMarkdown, recordToPlainText } from "../lib/recordContent";
import { normalizeNativeShareError, writeBlobToNativeShareCache } from "./nativeFileWriter";
import { canUseNativeZipArchive } from "./nativeZipArchive";
import { exportNativeStreamableBackupForShare } from "./streamingBackupService";
import MarkdownIt from "markdown-it";

const assetLabel = (asset: Asset | undefined, fallbackTitle: string): string => {
  if (!asset) {
    return fallbackTitle;
  }
  return [fallbackTitle, asset.title, asset.fileName].filter(Boolean).join(" / ");
};

const getRecords = (snapshot: StorageSnapshot): RecordBlock[] =>
  snapshot.payload.blocks
    .filter((block): block is RecordBlock => block.type === "record" && !block.deletedAt)
    .sort((a, b) => b.date.localeCompare(a.date) || a.order - b.order);

const getAssetMap = (snapshot: StorageSnapshot): Map<string, Asset> =>
  new Map(snapshot.assets.map((asset) => [asset.id, asset]));

export const createKnowledgeRecords = (snapshot: StorageSnapshot): KnowledgeRecord[] => {
  const assets = getAssetMap(snapshot);
  const assetList = Array.from(assets.values());
  return getRecords(snapshot).map((record) => {
    const nodes = parseLinearRecordContent(record, assetList);

    return {
      id: record.id,
      date: record.date,
      subject: record.subject,
      title: record.title,
      tags: record.tags,
      contentText: recordToPlainText(record, assetList),
      contentMarkdown: recordToLinearMarkdown(record, assetList),
      formulas: record.formulas.map((formula) => formula.latex),
      assetTexts: nodes
        .filter((node) => node.kind === "asset")
        .map((node) => assetLabel(node.asset, node.ref.title)),
      ocrTexts: nodes
        .filter((node) => node.kind === "asset")
        .map((node) => node.asset?.ocrText?.trim() ?? "")
        .filter(Boolean),
      updatedAt: record.updatedAt,
    };
  });
};

export const createKnowledgeJsonPayload = (snapshot: StorageSnapshot): KnowledgeExportPayload => ({
  format: "study-journal-knowledge",
  version: 1,
  exportedAt: snapshot.payload.manifest.exportedAt,
  records: createKnowledgeRecords(snapshot),
});

const recordToMarkdown = (record: KnowledgeRecord): string => {
  const sections = [
    `## ${record.date} ${record.title}`,
    "",
    `- 学科：${record.subject}`,
    record.tags.length > 0 ? `- 标签：${record.tags.join("、")}` : "",
    `- 更新时间：${record.updatedAt}`,
    "",
    record.contentMarkdown || record.contentText,
  ];

  if (record.formulas.length > 0) {
    sections.push("", "### 公式", ...record.formulas.map((formula) => `\n$$\n${formula}\n$$`));
  }
  if (record.assetTexts.length > 0) {
    sections.push("", "### 资源", ...record.assetTexts.map((asset) => `- ${asset}`));
  }
  if (record.ocrTexts.length > 0) {
    sections.push("", "### 图片 OCR", ...record.ocrTexts.map((text) => `\n${text}`));
  }

  return sections.join("\n").trim();
};

const subjectMarkdown = (subject: string, records: KnowledgeRecord[]): string => {
  const body = records.filter((record) => record.subject === subject).map(recordToMarkdown);
  return [`# ${subject}`, "", body.length > 0 ? body.join("\n\n---\n\n") : "暂无记录", ""].join("\n");
};

export const createSubjectMarkdownZip = async (snapshot: StorageSnapshot): Promise<Blob> => {
  const records = createKnowledgeRecords(snapshot);
  const zip = new JSZip();
  const folder = zip.folder("subjects");
  const recordBlocks = getRecords(snapshot);
  const subjects = getAllVisibleSubjects(snapshot.payload.settings, recordBlocks);
  for (const subject of subjects) {
    folder?.file(`${sanitizeFileName(subject.name)}.md`, subjectMarkdown(subject.name, records));
  }
  return zip.generateAsync({ type: "blob" });
};

export const createPlainText = (snapshot: StorageSnapshot): string => {
  const records = createKnowledgeRecords(snapshot);
  return [
    "学习日志知识库",
    `导出时间：${snapshot.payload.manifest.exportedAt}`,
    "",
    ...records.map((record) =>
      [
        `${record.date}｜${record.subject}｜${record.title}`,
        record.tags.length > 0 ? `标签：${record.tags.join("、")}` : "",
        record.contentText,
        record.formulas.length > 0 ? `公式：\n${record.formulas.join("\n\n")}` : "",
        record.assetTexts.length > 0 ? `资源：${record.assetTexts.join("；")}` : "",
        record.ocrTexts.length > 0 ? `图片文字：\n${record.ocrTexts.join("\n\n")}` : "",
      ]
        .filter(Boolean)
        .join("\n"),
    ),
    "",
  ].join("\n\n---\n\n");
};

export const writeOrDownload = async (
  blob: Blob,
  fileName: string,
  title: string,
  options: ExportOptions = {},
): Promise<string> => {
  const safeName = sanitizeFileName(fileName);
  if (!isNativePlatform()) {
    saveAs(blob, safeName);
    return "已开始下载。";
  }

  const writeResult = await writeBlobToNativeShareCache({
    blob,
    fileName: safeName,
    mimeType: blob.type || "application/octet-stream",
    onProgress: options.onProgress,
  });

  options.onProgress?.({ stage: "sharing", message: "正在打开系统保存/分享面板。" });
  try {
    await Share.share({
      title,
      text: title,
      files: [writeResult.uri],
      dialogTitle: "保存或分享导出文件",
    });
  } catch (error) {
    throw normalizeNativeShareError(error);
  }
  options.onProgress?.({ stage: "done", message: "导出文件已交给系统分享面板。" });

  return "已打开系统保存/分享面板。";
};

export type ReadableRecordExportFormat = "markdown" | "html" | "plain-text";

const readableRecordBodyMarkdown = (record: RecordBlock, assets: Asset[]): string => {
  const content = recordToLinearMarkdown(record, assets);
  const lines = content.split("\n");
  // recordToLinearMarkdown already starts with a title and subject. The
  // single-record wrapper below owns that metadata so it is not duplicated.
  if (lines[0]?.startsWith("## ")) {
    lines.shift();
  }
  if (lines[0] === "") {
    lines.shift();
  }
  if (lines[0]?.startsWith("学科：")) {
    lines.splice(0, 1);
  }
  while (lines[0] === "") {
    lines.shift();
  }
  return lines
    .join("\n")
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, (_match, label: string) => `**图片：${label}**`)
    .trim();
};

export const createReadableRecordMarkdown = (record: RecordBlock, assets: Asset[] = []): string => {
  const metadata = [
    `# ${record.title}`,
    "",
    `- 日期：${record.date}`,
    `- 学科：${record.subject}`,
    record.tags.length > 0 ? `- 标签：${record.tags.join("、")}` : "",
    "",
  ].filter(Boolean);
  const body = readableRecordBodyMarkdown(record, assets);
  return [...metadata, body, ""].join("\n");
};

export const createReadableRecordPlainText = (record: RecordBlock, assets: Asset[] = []): string => {
  const lines = [
    record.title,
    `日期：${record.date}`,
    `学科：${record.subject}`,
    record.tags.length > 0 ? `标签：${record.tags.join("、")}` : "",
    "",
    recordToPlainText(record, assets),
  ];
  return lines.filter(Boolean).join("\n").trim() + "\n";
};

export const createReadableRecordHtml = (record: RecordBlock, assets: Asset[] = []): string => {
  const markdown = createReadableRecordMarkdown(record, assets);
  const renderer = new MarkdownIt({ html: true, breaks: true, linkify: true });
  const body = renderer.render(markdown);
  return `<!doctype html>\n<html lang="zh-CN"><head><meta charset="utf-8"><title>${record.title.replace(/[<&>\"]/g, "")}</title><style>body{font-family:system-ui,-apple-system,"Segoe UI",sans-serif;max-width:860px;margin:40px auto;padding:0 24px;line-height:1.75;color:#202124}h1{line-height:1.25}blockquote{border-left:4px solid #9aa0a6;padding-left:16px;color:#4b5563}pre{white-space:pre-wrap;background:#f5f6f7;padding:12px;border-radius:8px}table{border-collapse:collapse;width:100%}th,td{border:1px solid #d7dbe0;padding:6px 8px;text-align:left}details{margin:12px 0;padding:8px 12px;border:1px solid #d7dbe0;border-radius:8px}</style></head><body>${body}</body></html>`;
};

export const exportReadableRecord = async (
  store: StorageAdapter,
  recordId: string,
  format: ReadableRecordExportFormat,
  options: ExportOptions = {},
): Promise<string> => {
  const snapshot = await store.createSnapshot();
  const record = snapshot.payload.blocks.find(
    (block): block is RecordBlock => block.type === "record" && block.id === recordId && !block.deletedAt,
  );
  if (!record) {
    throw new Error("找不到要导出的日志。");
  }
  const assets = snapshot.assets;
  const baseName = `study-journal-record-${sanitizeFileName(`${record.date}-${record.title}`)}`;
  if (format === "markdown") {
    return writeOrDownload(
      new Blob([createReadableRecordMarkdown(record, assets)], { type: "text/markdown;charset=utf-8" }),
      `${baseName}.md`,
      "日志可读导出（Markdown）",
      options,
    );
  }
  if (format === "html") {
    return writeOrDownload(
      new Blob([createReadableRecordHtml(record, assets)], { type: "text/html;charset=utf-8" }),
      `${baseName}.html`,
      "日志可读导出（HTML）",
      options,
    );
  }
  return writeOrDownload(
    new Blob([createReadableRecordPlainText(record, assets)], { type: "text/plain;charset=utf-8" }),
    `${baseName}.txt`,
    "日志可读导出（纯文本）",
    options,
  );
};

export const exportFullBackup = async (snapshot: StorageSnapshot, options: ExportOptions = {}): Promise<string> => {
  const date = snapshot.payload.manifest.exportedAt.slice(0, 10);
  const zip = await snapshotToZip(snapshot, options);
  return writeOrDownload(zip, `study-journal-${date}.zip`, "学习日志完整备份", options);
};

export const exportFullBackupFromStorage = async (
  store: StorageAdapter,
  options: ExportOptions = {},
): Promise<string> => {
  if (canUseNativeZipArchive()) {
    return exportNativeStreamableBackupForShare(store, options);
  }
  return exportFullBackup(await store.createSnapshot(), options);
};

export const exportSubjectMarkdown = async (snapshot: StorageSnapshot, options: ExportOptions = {}): Promise<string> => {
  const date = snapshot.payload.manifest.exportedAt.slice(0, 10);
  const zip = await createSubjectMarkdownZip(snapshot);
  return writeOrDownload(zip, `study-journal-subjects-${date}.zip`, "学习日志学科 Markdown", options);
};

export const exportKnowledgeJson = async (snapshot: StorageSnapshot, options: ExportOptions = {}): Promise<string> => {
  const date = snapshot.payload.manifest.exportedAt.slice(0, 10);
  const blob = new Blob([JSON.stringify(createKnowledgeJsonPayload(snapshot), null, 2)], {
    type: "application/json;charset=utf-8",
  });
  return writeOrDownload(blob, `study-journal-knowledge-${date}.json`, "学习日志知识库 JSON", options);
};

export const exportPlainText = async (snapshot: StorageSnapshot, options: ExportOptions = {}): Promise<string> => {
  const date = snapshot.payload.manifest.exportedAt.slice(0, 10);
  const blob = new Blob([createPlainText(snapshot)], { type: "text/plain;charset=utf-8" });
  return writeOrDownload(blob, `study-journal-knowledge-${date}.txt`, "学习日志纯文本", options);
};

export const exportKnowledge = async (
  kind: ExportKind,
  snapshot: StorageSnapshot,
  options: ExportOptions = {},
): Promise<string> => {
  switch (kind) {
    case "full-backup":
      return exportFullBackup(snapshot, options);
    case "subject-markdown":
      return exportSubjectMarkdown(snapshot, options);
    case "knowledge-json":
      return exportKnowledgeJson(snapshot, options);
    case "plain-text":
      return exportPlainText(snapshot, options);
  }
};
