import JSZip from "jszip";
import { containerForPayload, KNOWLEDGE_PAYLOAD_ENTRY, validateBackupContainer, validateBackupPayloadVersion } from "../features/knowledgeLibrary/backupContainer";
import { saveAs } from "file-saver";

import type {
  Asset,
  BackupAssetChecksum,
  BackupAssetMeta,
  BackupPayload,
  ExportOptions,
  ImportOptions,
  ImportSummary,
  RecordBlock,
  StorageSnapshot,
} from "../types";
import { EMPTY_REVIEW_COACH_FORMAL_SNAPSHOT } from "../features/reviewCoach/domain";
import { entryToMarkdown } from "../lib/markdown";
import { migrateBlocksToRecords } from "../lib/recordMigration";
import { ensureSettingsSubjects } from "../lib/subjects";
import { ActionableError } from "../lib/uiError";
import { assetByteFailure, describeAssetByteFailure } from "./assetIntegrity";
import { hashBlob } from "./cloudSyncModel";
import { sanitizeSettingsForExport, stripPrivateExportFields } from "./exportPrivacy";

/**
 * An archive that cannot be proven complete must never be handed to the restore path.
 *
 * The message is shown verbatim (the class is actionable), because the user has to know *which*
 * resource is broken to decide whether another backup file would help.
 */
export class BackupArchiveIntegrityError extends ActionableError {
  constructor(message: string) {
    super(message);
    this.name = "BackupArchiveIntegrityError";
  }
}

const blobToFile = (blob: Blob, fileName: string, mimeType: string): File =>
  new File([blob], fileName, { type: mimeType });

const serializeAssetMeta = (asset: Asset) => {
  const { data: _data, ...meta } = asset;
  return meta;
};

/** An asset whose bytes are missing locally cannot be packed, so the backup must not claim success. */
const requireAssetBytes = (asset: Asset): Blob => {
  const data = (asset as { data?: unknown }).data;
  if (!(data instanceof Blob)) {
    throw new BackupArchiveIntegrityError(
      `完整备份未能生成：资源“${asset.fileName}”（ID ${asset.id}）在本机没有可写入的内容。`
      + "请先确认该资源可正常打开，或移除该资源后重试；本次没有生成任何备份文件。",
    );
  }
  return data;
};

/**
 * Byte declarations for every asset a complete backup packs.
 *
 * Callers put the result in `payload.assetChecksums`, which the v7 container checksum covers — that
 * is what puts the *asset bytes* inside the verified range instead of only the metadata.
 */
export const assetChecksumsFor = async (assets: Asset[]): Promise<BackupAssetChecksum[]> =>
  Promise.all(assets.map(async (asset) => {
    const data = requireAssetBytes(asset);
    return { id: asset.id, hash: await hashBlob(data), size: data.size };
  }));

/**
 * Read the declarations an archive carries. Absent means "a legacy archive with no per-asset
 * proof" and is allowed; present but malformed is a corruption signal and fails closed.
 */
export const archiveAssetDeclarations = (value: unknown): Map<string, BackupAssetChecksum> => {
  const declarations = new Map<string, BackupAssetChecksum>();
  if (value === undefined) return declarations;
  if (!Array.isArray(value)) {
    throw new BackupArchiveIntegrityError("备份包校验失败：资源完整性清单的格式不正确，已拒绝恢复。请改用其他备份文件。");
  }
  for (const item of value) {
    const entry = item as Partial<BackupAssetChecksum> | null;
    if (!entry || typeof entry !== "object" || Array.isArray(entry) || typeof entry.id !== "string" || !entry.id
      || typeof entry.hash !== "string" || !entry.hash) {
      throw new BackupArchiveIntegrityError("备份包校验失败：资源完整性清单包含无法识别的条目，已拒绝恢复。请改用其他备份文件。");
    }
    if (declarations.has(entry.id)) {
      throw new BackupArchiveIntegrityError(`备份包校验失败：资源 ${entry.id} 的完整性声明重复，已拒绝恢复。请改用其他备份文件。`);
    }
    declarations.set(entry.id, {
      id: entry.id,
      hash: entry.hash,
      size: typeof entry.size === "number" ? entry.size : -1,
    });
  }
  return declarations;
};

/**
 * A resource listed in the archive's own manifest but absent from the archive is corruption, not a
 * "partial backup". Both the web zip and the native stream import must fail on it before any local
 * table is touched.
 */
export const requireArchiveEntry = <T>(meta: BackupAssetMeta, path: T | undefined): T => {
  if (path === undefined || path === null || path === "") {
    throw new BackupArchiveIntegrityError(
      `备份包不完整：资源“${meta.fileName}”（ID ${meta.id}）在备份清单中有记录，但压缩包内缺少对应文件。`
      + "为避免写入不完整的数据，已拒绝恢复；请改用其他备份文件。",
    );
  }
  return path;
};

/** Verify one archive entry against its declaration, when the archive declares one. */
export const assertArchiveAssetBytes = async (
  meta: BackupAssetMeta,
  declaration: BackupAssetChecksum | undefined,
  blob: Blob,
): Promise<void> => {
  if (!declaration) return;
  const failure = await assetByteFailure({
    hash: declaration.hash,
    blob,
    declaredSize: declaration.size,
    declaredMimeType: meta.mimeType,
  });
  if (!failure) return;
  throw new BackupArchiveIntegrityError(
    `备份包校验失败：${describeAssetByteFailure(meta.fileName, failure)}`
    + "为避免写入损坏的数据，已拒绝恢复；请改用其他备份文件。",
  );
};

export const snapshotToZip = async (snapshot: StorageSnapshot, options: ExportOptions = {}): Promise<Blob> => {
  const zip = new JSZip();
  options.onProgress?.({ stage: "zipping", message: "正在生成完整备份 zip。" });
  const portableAssets = snapshot.assets.filter((asset) => asset.generatedBy !== "knowledge-podcast");
  // Declared before the zip is built, so a missing local blob aborts the export instead of writing
  // an archive whose manifest promises a resource it does not contain.
  const assetChecksums = await assetChecksumsFor(portableAssets);
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
    // Inside the container checksum for v7, so the bytes of every packed asset are covered by the
    // one declaration the archive already verifies.
    assetChecksums,
  };

  validateBackupPayloadVersion(payload);
  const archivePayload = { ...payload, recordDrafts: snapshot.payload.recordDrafts ?? snapshot.recordDrafts ?? [], assets: portableAssets.map(serializeAssetMeta) };
  zip.file("manifest.json", JSON.stringify(payload.manifest.version === 7 ? containerForPayload(archivePayload) : payload.manifest, null, 2));
  zip.file(
    payload.manifest.version === 7 ? KNOWLEDGE_PAYLOAD_ENTRY : "data.json",
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
  // Assets an old archive packs without a byte declaration: imported (historical capability) but
  // never claimed to be verified, so the UI can say exactly which part is unproven.
  const declaredAssetIds = new Set((snapshot.payload.assetChecksums ?? []).map((entry) => entry.id));

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
    unverifiedAssets: snapshot.assets.filter((asset) => !declaredAssetIds.has(asset.id)).length,
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
  const versioned = zip.file(KNOWLEDGE_PAYLOAD_ENTRY);
  const dataFile = versioned ?? zip.file("data.json");
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
    ![1, 2, 3, 4, 5, 6, 7].includes(data.manifest.version)
  ) {
    const format = data.manifest?.format ?? "未知";
    const version = data.manifest?.version ?? "未知";
    throw new Error(`备份格式不兼容：format=${format}，version=${version}。`);
  }

  validateBackupPayloadVersion(data);
  if (versioned) {
    const manifest = zip.file("manifest.json");
    if (!manifest) throw new Error("新版备份缺少外层校验清单。");
    validateBackupContainer(JSON.parse(await manifest.async("string")), data);
  } else if (data.manifest.version === 7) throw new Error("新版完整备份不能使用旧 data.json 入口。");

  const migratedBlocks = migrateBlocksToRecords(data.blocks ?? []);
  const recordBlocks = migratedBlocks.filter((block) => block.type === "record");

  const declarations = archiveAssetDeclarations(data.assetChecksums);
  const assets: Asset[] = [];
  const assetMetas = data.assets ?? [];
  for (const [index, assetMeta] of assetMetas.entries()) {
    options.onProgress?.({
      stage: "assets",
      message: `正在读取资源 ${index + 1}/${assetMetas.length}。`,
      current: index + 1,
      total: assetMetas.length,
    });
    /**
     * Resolve the exact path the writer should have produced, then fall back to the historical
     * prefix match for archives whose `fileName` was rewritten after the entry was written.
     */
    const expected = `assets/${assetMeta.id}-${assetMeta.fileName}`;
    const path = zip.file(expected)
      ? expected
      : Object.keys(zip.files).find((name) => name.startsWith(`assets/${assetMeta.id}-`));
    requireArchiveEntry(assetMeta, path);
    const file = zip.file(path!);
    const blob = file ? await file.async("blob") : undefined;
    if (!blob) {
      throw new BackupArchiveIntegrityError(
        `备份包不完整：资源“${assetMeta.fileName}”（ID ${assetMeta.id}）在压缩包内无法读取。`
        + "为避免写入不完整的数据，已拒绝恢复；请改用其他备份文件。",
      );
    }
    // Fails before this function returns, so the caller cannot reach the destructive transaction.
    await assertArchiveAssetBytes(assetMeta, declarations.get(assetMeta.id), blob);
    assets.push({
      ...assetMeta,
      data: blobToFile(blob, assetMeta.fileName, assetMeta.mimeType),
    });
  }
  options.onProgress?.({ stage: "done", message: "备份解析完成。" });

  return {
    payload: {
      manifest: data.manifest,
      ...(data.knowledge !== undefined ? { knowledge: data.knowledge } : {}),
      // Carried through so the importer can state which assets were verified and which were taken
      // on trust. Never synthesised for a legacy archive.
      ...(data.assetChecksums !== undefined ? { assetChecksums: data.assetChecksums } : {}),
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
