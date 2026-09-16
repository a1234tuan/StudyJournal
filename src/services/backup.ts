import JSZip from "jszip";
import { saveAs } from "file-saver";

import type { Asset, BackupPayload, ExportOptions, ImportOptions, ImportSummary, RecordBlock, StorageSnapshot } from "../types";
import { EMPTY_REVIEW_COACH_FORMAL_SNAPSHOT } from "../features/reviewCoach/domain";
import { entryToMarkdown } from "../lib/markdown";
import { migrateBlocksToRecords } from "../lib/recordMigration";
import { ensureSettingsSubjects } from "../lib/subjects";
import { sanitizeSettingsForExport, stripPrivateExportFields } from "./exportPrivacy";

const blobToFile = (blob: Blob, fileName: string, mimeType: string): File =>
  new File([blob], fileName, { type: mimeType });

const serializeAssetMeta = (asset: Asset) => {
  const { data: _data, ...meta } = asset;
  return meta;
};

export const snapshotToZip = async (snapshot: StorageSnapshot, options: ExportOptions = {}): Promise<Blob> => {
  const zip = new JSZip();
  options.onProgress?.({ stage: "zipping", message: "正在生成完整备份 zip。" });
  const portableAssets = snapshot.assets.filter((asset) => asset.generatedBy !== "knowledge-podcast");
  const payload = {
    ...snapshot.payload,
    settings: sanitizeSettingsForExport(snapshot.payload.settings),
    reviewCoach: stripPrivateExportFields(snapshot.payload.reviewCoach),
    blocks: snapshot.payload.blocks.map((block) =>
      block.type === "record" ? { ...block, mistakeRefs: [] } : block,
    ),
    mistakes: [],
    reviews: [],
    manifest: {
      ...snapshot.payload.manifest,
      counts: {
        ...snapshot.payload.manifest.counts,
        mistakes: 0,
        assets: portableAssets.length,
        reviews: 0,
      },
    },
  };

  zip.file("manifest.json", JSON.stringify(payload.manifest, null, 2));
  zip.file(
    "data.json",
    JSON.stringify(
      {
        ...payload,
        recordDrafts: snapshot.payload.recordDrafts ?? snapshot.recordDrafts ?? [],
        assets: portableAssets.map(serializeAssetMeta),
      },
      null,
      2,
    ),
  );

  const entriesFolder = zip.folder("entries");
  for (const entry of payload.entries) {
    const blocks = payload.blocks.filter((block) => block.date === entry.date);
    entriesFolder?.file(`${entry.date}.md`, entryToMarkdown(entry, blocks, portableAssets));
  }

  const assetsFolder = zip.folder("assets");
  for (const asset of portableAssets) {
    assetsFolder?.file(`${asset.id}-${asset.fileName}`, asset.data);
  }

  return zip.generateAsync({ type: "blob" }, (metadata) => {
    options.onProgress?.({
      stage: "zipping",
      message: `正在生成完整备份 zip ${Math.round(metadata.percent)}% 。`,
      current: Math.round(metadata.percent),
      total: 100,
    });
  });
};

export const blobToBase64 = (blob: Blob): Promise<string> =>
  new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error);
    reader.onload = () => {
      const result = String(reader.result);
      resolve(result.includes(",") ? result.split(",")[1] : result);
    };
    reader.readAsDataURL(blob);
  });

export const base64ToBlob = (base64: string, mimeType = "application/zip"): Blob => {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return new Blob([bytes], { type: mimeType });
};

const isRecordBlock = (block: StorageSnapshot["payload"]["blocks"][number]): block is RecordBlock =>
  block.type === "record";

export const summarizeSnapshot = (snapshot: StorageSnapshot): ImportSummary => {
  const records = snapshot.payload.blocks.filter(isRecordBlock);
  const activeRecords = records.filter((record) => !record.deletedAt);
  const deletedRecords = records.filter((record) => record.deletedAt);
  const days = new Set(activeRecords.map((record) => record.date)).size;
  const assetIds = new Set(snapshot.assets.map((asset) => asset.id));
  const referencedAssetIds = new Set(records.flatMap((record) => record.assets.map((asset) => asset.id)));
  const missingAssets = Array.from(referencedAssetIds).filter((id) => !assetIds.has(id)).length;
  const images = snapshot.assets.filter((asset) => asset.kind === "image").length;
  const audio = snapshot.assets.filter((asset) => asset.kind === "audio").length;
  const attachments = snapshot.assets.filter((asset) => asset.kind === "attachment").length;

  return {
    records: activeRecords.length,
    days,
    deletedRecords: deletedRecords.length,
    assets: snapshot.assets.length,
    images,
    audio,
    attachments,
    version: snapshot.payload.manifest.version,
    missingAssets,
  };
};

export const zipToSnapshot = async (file: File, options: ImportOptions = {}): Promise<StorageSnapshot> => {
  const looksLikeZip = file.name.toLocaleLowerCase().endsWith(".zip") || file.type.includes("zip");
  if (!looksLikeZip) {
    throw new Error("不支持的文件格式：只支持完整备份 zip。Markdown、JSON 和 TXT 仅用于 AI 阅读，不能恢复数据。");
  }

  let zip: JSZip;
  try {
    options.onProgress?.({ stage: "loading", message: "正在载入 zip 备份文件。" });
    zip = await JSZip.loadAsync(file);
  } catch {
    throw new Error("文件不是有效 zip 或已损坏，请重新选择完整备份文件。");
  }

  options.onProgress?.({ stage: "parsing", message: "正在检查备份结构和 data.json。" });
  const dataFile = zip.file("data.json");
  if (!dataFile) {
    throw new Error("不是学习日志完整备份：备份包缺少 data.json。");
  }

  let data: BackupPayload & {
    assets?: Array<Omit<Asset, "data">>;
  };
  try {
    data = JSON.parse(await dataFile.async("string")) as BackupPayload & {
      assets?: Array<Omit<Asset, "data">>;
    };
  } catch {
    throw new Error("备份数据损坏：data.json 不是有效 JSON。");
  }

  if (
    !data.manifest ||
    !["408-study-journal", "study-journal"].includes(data.manifest.format) ||
    ![1, 2, 3, 4, 5, 6].includes(data.manifest.version)
  ) {
    const format = data.manifest?.format ?? "未知";
    const version = data.manifest?.version ?? "未知";
    throw new Error(`备份格式不兼容：format=${format}，version=${version}。`);
  }

  const migratedBlocks = migrateBlocksToRecords(data.blocks ?? []);
  const recordBlocks = migratedBlocks.filter((block) => block.type === "record");

  const assets: Asset[] = [];
  const assetMetas = data.assets ?? [];
  for (const [index, assetMeta] of assetMetas.entries()) {
    options.onProgress?.({
      stage: "assets",
      message: `正在读取资源 ${index + 1}/${assetMetas.length}。`,
      current: index + 1,
      total: assetMetas.length,
    });
    const path = Object.keys(zip.files).find((name) => name.startsWith(`assets/${assetMeta.id}-`));
    if (!path) {
      continue;
    }
    const blob = await zip.file(path)?.async("blob");
    if (!blob) {
      continue;
    }
    assets.push({
      ...assetMeta,
      data: blobToFile(blob, assetMeta.fileName, assetMeta.mimeType),
    });
  }
  options.onProgress?.({ stage: "done", message: "备份解析完成。" });

  return {
    payload: {
      manifest: data.manifest,
      entries: data.entries ?? [],
      blocks: migratedBlocks,
      templates: data.templates ?? [],
      recordDrafts: data.recordDrafts ?? [],
      mistakes: [],
      tags: data.tags ?? [],
      reviews: [],
      recordReviews: data.recordReviews ?? [],
      recordReviewLogs: data.recordReviewLogs ?? [],
      recordReviewDayStats: data.recordReviewDayStats ?? [],
      studySessions: data.studySessions ?? [],
      settings: ensureSettingsSubjects({ ...data.settings, schemaVersion: 4 }, recordBlocks),
      /**
       * Deliberately *not* `?? []`.
       *
       * An archive written before daily plans existed has no `dailyPlans` key,
       * and the restore path reads "key absent" as "leave the local plans
       * alone" precisely so importing an old backup cannot wipe them. Filling in
       * `[]` here would rewrite that absence into an explicit "this snapshot
       * contains no plans", and the import would then delete every plan on the
       * device. Passing the key through only when the archive really has it
       * keeps the distinction intact end to end.
       */
      ...(data.dailyPlans !== undefined ? { dailyPlans: data.dailyPlans } : {}),
      reviewCoach: data.reviewCoach ?? structuredClone(EMPTY_REVIEW_COACH_FORMAL_SNAPSHOT),
    },
    assets,
  };
};

export const downloadSnapshot = async (snapshot: StorageSnapshot, options: ExportOptions = {}): Promise<void> => {
  const zip = await snapshotToZip(snapshot, options);
  const date = snapshot.payload.manifest.exportedAt.slice(0, 10);
  saveAs(zip, `study-journal-${date}.zip`);
};
