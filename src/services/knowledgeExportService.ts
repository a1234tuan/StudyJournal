import JSZip from "jszip";
import { Share } from "@capacitor/share";
import { saveAs } from "file-saver";

import type {
  Asset,
  BackupAssetMeta,
  ExportKind,
  ExportOptions,
  KnowledgeExportPayload,
  KnowledgeRecord,
  RecordBlock,
  StorageAdapter,
  StorageSnapshot,
} from "../types";
import { isKnowledgeVisible, valueOf } from "../features/knowledgeLibrary/protocol";
import { knowledgeChildren, knowledgeLabel } from "../features/knowledgeLibrary/query";
import { ROOT_NODE, type KnowledgeEntity, type KnowledgePosition, type KnowledgeState } from "../features/knowledgeLibrary/domain";
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

export interface KnowledgeOutlineExportInput {
  state: KnowledgeState;
  records: readonly RecordBlock[];
  assets?: readonly Asset[] | readonly BackupAssetMeta[];
  libraryTitle?: string;
  exportedAt?: string;
}

export interface KnowledgeOutlineExportSummary {
  workspaces: number;
  nodes: number;
  records: number;
  unorganizedRecords: number;
}

const outlineSegment = (value: string, fallback: string): string => sanitizeFileName(value.trim() || fallback);

const liveRecords = (records: readonly RecordBlock[]): RecordBlock[] =>
  records.filter((record): record is RecordBlock => record.type === "record" && !record.deletedAt);

const visibleEntities = (state: KnowledgeState): KnowledgeEntity[] =>
  Object.values(state.entities).filter((entity) => isKnowledgeVisible(state, entity));

const visibleReferences = (state: KnowledgeState): KnowledgeEntity[] =>
  visibleEntities(state).filter((entity) => entity.kind === "reference");

const knowledgeOutlineSummary = (input: KnowledgeOutlineExportInput): KnowledgeOutlineExportSummary => {
  const records = liveRecords(input.records);
  const recordIds = new Set(records.map((record) => record.id));
  const entities = visibleEntities(input.state);
  const references = visibleReferences(input.state).filter((reference) => recordIds.has(reference.recordId));
  const organized = new Set(references.map((reference) => reference.recordId));
  return {
    workspaces: entities.filter((entity) => entity.kind === "workspace").length,
    nodes: entities.filter((entity) => entity.kind === "node").length,
    records: references.length,
    unorganizedRecords: records.filter((record) => !organized.has(record.id)).length,
  };
};

const nodeNoteMarkdown = (state: KnowledgeState, entity: KnowledgeEntity, label: string): string => {
  const note = valueOf(state, entity, "note");
  return typeof note === "string" && note.trim()
    ? [`# ${label}`, "", note.trim(), ""].join("\n")
    : "";
};

const uniqueRecordFileName = (record: RecordBlock, used: Map<string, number>): string => {
  const base = outlineSegment(`${record.date}-${record.title}`, `${record.date}-未命名日志`);
  const count = used.get(base) ?? 0;
  used.set(base, count + 1);
  return `${base}${count ? `-${record.id.slice(0, 8)}` : ""}.md`;
};

const recordMarkdownForFolder = (record: RecordBlock, assets: Asset[], folderPath: string, rootFolder: string): string => {
  const belowRootSegments = folderPath.split("/").length - rootFolder.split("/").length;
  const assetPrefix = `${"../".repeat(Math.max(1, belowRootSegments))}assets/`;
  return recordToLinearMarkdown(record, assets).replaceAll("../assets/", assetPrefix).trim() + "\n";
};

export const createKnowledgeOutlineZip = async (input: KnowledgeOutlineExportInput): Promise<Blob> => {
  const records = liveRecords(input.records);
  const recordMap = new Map(records.map((record) => [record.id, record]));
  const entities = visibleEntities(input.state);
  const workspaces = entities
    .filter((entity) => entity.kind === "workspace")
    .sort((left, right) => knowledgeLabel(input.state, left).localeCompare(knowledgeLabel(input.state, right), "zh-CN") || left.id.localeCompare(right.id));
  const references = entities.filter((entity) => entity.kind === "reference");
  const referencesByNode = new Map<string, KnowledgeEntity[]>();
  for (const reference of references) {
    const list = referencesByNode.get(reference.nodeId) ?? [];
    list.push(reference);
    referencesByNode.set(reference.nodeId, list);
  }
  const assets = (input.assets ?? []).filter((asset): asset is Asset => "data" in asset);
  const zip = new JSZip();
  const rootFolder = outlineSegment(input.libraryTitle ?? "知识库", "知识库");
  const organizedRecordIds = new Set<string>();
  let workspaceCount = 0;
  let nodeCount = 0;
  let recordCount = 0;

  const writeNode = (workspaceId: string, node: KnowledgeEntity, parentPath: string): void => {
    const label = knowledgeLabel(input.state, node);
    const path = `${parentPath}/${outlineSegment(label, "未命名节点")}`;
    zip.folder(path);
    nodeCount += 1;
    const note = nodeNoteMarkdown(input.state, node, label);
    if (note) zip.file(`${path}/_节点说明.md`, note);

    const usedNames = new Map<string, number>();
    for (const reference of referencesByNode.get(node.id) ?? []) {
      const record = recordMap.get(reference.recordId);
      if (!record) continue;
      organizedRecordIds.add(record.id);
      recordCount += 1;
      zip.file(`${path}/${uniqueRecordFileName(record, usedNames)}`, recordMarkdownForFolder(record, assets, path, rootFolder));
    }

    for (const child of knowledgeChildren(input.state, workspaceId, node.id).filter((entity) => isKnowledgeVisible(input.state, entity))) {
      writeNode(workspaceId, child, path);
    }
  };

  for (const workspace of workspaces) {
    workspaceCount += 1;
    const workspacePath = `${rootFolder}/${outlineSegment(knowledgeLabel(input.state, workspace), "未命名专题")}`;
    zip.folder(workspacePath);
    const note = nodeNoteMarkdown(input.state, workspace, knowledgeLabel(input.state, workspace));
    if (note) zip.file(`${workspacePath}/_专题说明.md`, note);
    for (const node of knowledgeChildren(input.state, workspace.id, ROOT_NODE).filter((entity) => isKnowledgeVisible(input.state, entity))) {
      writeNode(workspace.id, node, workspacePath);
    }
  }

  const unorganized = records.filter((record) => !organizedRecordIds.has(record.id));
  if (unorganized.length > 0) {
    const path = `${rootFolder}/_未归类`;
    const usedNames = new Map<string, number>();
    zip.folder(path);
    for (const record of unorganized) {
      recordCount += 1;
      zip.file(`${path}/${uniqueRecordFileName(record, usedNames)}`, recordMarkdownForFolder(record, assets, path, rootFolder));
    }
  }

  const exportedAt = input.exportedAt ?? new Date().toISOString();
  const summary = knowledgeOutlineSummary(input);
  for (const asset of assets) {
    const fileName = sanitizeFileName(asset.fileName || asset.title || asset.id);
    zip.file(`${rootFolder}/assets/${asset.id}-${fileName}`, asset.data);
  }
  zip.file(`${rootFolder}/README.md`, [
    `# ${input.libraryTitle?.trim() || "知识库"}`,
    "",
    `导出时间：${exportedAt}`,
    `专题：${summary.workspaces}`,
    `节点：${summary.nodes}`,
    `Markdown 日志：${recordCount}`,
    `未归类日志：${summary.unorganizedRecords}`,
    `附件资源：${assets.length}`,
    "",
    "本 ZIP 按知识库目录树导出。节点对应文件夹，日志对应 Markdown 文件；它不是 StudyJournal 的完整恢复备份。",
    "",
  ].join("\n"));
  return zip.generateAsync({ type: "blob" });
};

export const exportKnowledgeOutline = async (
  input: KnowledgeOutlineExportInput,
  options: ExportOptions = {},
): Promise<string> => {
  const date = (input.exportedAt ?? new Date().toISOString()).slice(0, 10);
  const summary = knowledgeOutlineSummary(input);
  const zip = await createKnowledgeOutlineZip(input);
  const message = await writeOrDownload(zip, `study-journal-knowledge-tree-${date}.zip`, "学习日志知识库目录树", options);
  return `${message} 共生成 ${summary.records + summary.unorganizedRecords} 个 Markdown 日志文件。`;
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
