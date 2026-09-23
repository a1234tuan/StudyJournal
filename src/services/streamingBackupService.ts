import { containerForPayload, KNOWLEDGE_PAYLOAD_ENTRY, validateBackupContainer, validateBackupPayloadVersion } from "../features/knowledgeLibrary/backupContainer";
import { sha256 } from "@noble/hashes/sha256";
import { bytesToHex } from "@noble/hashes/utils";
import type {
  Asset,
  BackupAssetChecksum,
  BackupAssetMeta,
  ExportOptions,
  ImportOptions,
  ImportSummary,
  StorageAdapter,
  StreamableBackupSnapshot,
} from "../types";
import {
  archiveAssetDeclarations,
  assertArchiveAssetBytes,
  BackupArchiveIntegrityError,
  base64ToBlob,
  requireArchiveEntry,
  summarizeSnapshot,
} from "./backup";
import { blobToBase64Chunks } from "./nativeFileWriter";
import { canUseNativeZipArchive, NativeZipArchive, type NativeZipExportDestination } from "./nativeZipArchive";
import { migrateBlocksToRecords } from "../lib/recordMigration";
import { ensureSettingsSubjects } from "../lib/subjects";
import type { RecordBlock } from "../types";
import { entryToMarkdown } from "../lib/markdown";
import { sanitizeStreamableSnapshotForExport } from "./exportPrivacy";

const ENTRY_CHUNK_BYTES = 768 * 1024;

const textToBase64 = (text: string): string => btoa(unescape(encodeURIComponent(text)));

const base64ToText = (base64: string): string => decodeURIComponent(escape(atob(base64)));

const base64ToBytes = (base64: string): Uint8Array => {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
};

const fileNameForSnapshot = (snapshot: StreamableBackupSnapshot): string =>
  `study-journal-${snapshot.payload.manifest.exportedAt.slice(0, 10)}.zip`;

const assetPath = (asset: BackupAssetMeta): string => `assets/${asset.id}-${asset.fileName}`;

const metaToAsset = (meta: BackupAssetMeta, blob: Blob): Asset =>
  ({
    ...meta,
    data: new File([blob], meta.fileName, { type: meta.mimeType }),
  });

const writeTextEntry = async (sessionId: string, path: string, text: string) => {
  await NativeZipArchive.beginEntry({ sessionId, path });
  await NativeZipArchive.appendEntry({ sessionId, data: textToBase64(text) });
  await NativeZipArchive.finishEntry({ sessionId });
};

export const writeNativeStreamableBackupSnapshot = async (
  snapshot: StreamableBackupSnapshot,
  destination: NativeZipExportDestination["kind"],
  getAsset: (assetId: string) => Promise<Asset | undefined>,
  options: ExportOptions = {},
) => {
  if (!canUseNativeZipArchive()) {
    throw new Error("原生流式备份只在 Android App 内可用。");
  }

  const portableSnapshot = sanitizeStreamableSnapshotForExport(snapshot);
  options.onProgress?.({ stage: "preparing", message: "正在准备备份数据。" });
  const session = await NativeZipArchive.beginExport({
    destination,
    fileName: destination === "auto-latest" ? "study-journal-latest.zip" : fileNameForSnapshot(portableSnapshot),
    mimeType: "application/zip",
  });

  try {
    validateBackupPayloadVersion(portableSnapshot.payload);
    const markdownAssets = portableSnapshot.assets.map((meta) => metaToAsset(meta, new Blob()));

    /**
     * Assets are written before the manifest for two reasons: the manifest must not promise a
     * resource the archive does not contain, and hashing each chunk while it is written avoids a
     * second full read of a large attachment just to declare its bytes.
     */
    const assetHashes = new Map<string, string>();
    for (const [index, meta] of portableSnapshot.assets.entries()) {
      options.onProgress?.({
        stage: "asset",
        message: `正在写入资源 ${index + 1}/${portableSnapshot.assets.length}。`,
        current: index + 1,
        total: portableSnapshot.assets.length,
      });
      const asset = await getAsset(meta.id);
      if (!asset || !(asset.data instanceof Blob)) {
        throw new BackupArchiveIntegrityError(
          `完整备份未能生成：资源“${meta.fileName}”（ID ${meta.id}）在本机缺失或无法读取。`
          + "请先确认该资源可正常打开后重试；本次没有生成任何备份文件。",
        );
      }
      const hasher = sha256.create();
      await NativeZipArchive.beginEntry({ sessionId: session.sessionId, path: assetPath(meta) });
      for await (const chunk of blobToBase64Chunks(asset.data, ENTRY_CHUNK_BYTES)) {
        hasher.update(base64ToBytes(chunk.data));
        await NativeZipArchive.appendEntry({ sessionId: session.sessionId, data: chunk.data });
      }
      await NativeZipArchive.finishEntry({ sessionId: session.sessionId });
      assetHashes.set(meta.id, bytesToHex(hasher.digest()));
    }

    const payload = {
      ...portableSnapshot.payload,
      blocks: portableSnapshot.payload.blocks.map((block) =>
        block.type === "record" ? { ...block, mistakeRefs: [] } : block,
      ),
      mistakes: [],
      reviews: [],
      recordDrafts: portableSnapshot.payload.recordDrafts ?? portableSnapshot.recordDrafts ?? [],
      assetChecksums: portableSnapshot.assets.map((meta): BackupAssetChecksum => ({
        id: meta.id,
        hash: assetHashes.get(meta.id)!,
        size: meta.size,
      })),
    };
    const archivePayload = { ...payload, assets: portableSnapshot.assets };
    await writeTextEntry(session.sessionId, "manifest.json", JSON.stringify(payload.manifest.version === 7 ? containerForPayload(archivePayload) : payload.manifest, null, 2));
    await writeTextEntry(
      session.sessionId,
      payload.manifest.version === 7 ? KNOWLEDGE_PAYLOAD_ENTRY : "data.json",
      JSON.stringify({ ...payload, assets: portableSnapshot.assets }, null, 2),
    );

    for (const entry of payload.entries) {
      const blocks = payload.blocks.filter((block) => block.date === entry.date);
      await writeTextEntry(
        session.sessionId,
        `entries/${entry.date}.md`,
        entryToMarkdown(entry, blocks, markdownAssets),
      );
    }

    options.onProgress?.({ stage: "writing", message: "正在完成 zip 写入。" });
    const result = await NativeZipArchive.finishExport({ sessionId: session.sessionId });
    options.onProgress?.({ stage: "done", message: "备份 zip 已生成。" });
    return result;
  } catch (error) {
    await NativeZipArchive.cancelExport({ sessionId: session.sessionId }).catch(() => undefined);
    throw error;
  }
};

export const writeNativeStreamableBackup = async (
  store: StorageAdapter,
  destination: NativeZipExportDestination["kind"],
  options: ExportOptions = {},
) => {
  const snapshot = await store.createStreamableSnapshot();
  return writeNativeStreamableBackupSnapshot(snapshot, destination, (id) => store.getAsset(id), options);
};

export const exportNativeStreamableBackupForShare = async (
  store: StorageAdapter,
  options: ExportOptions = {},
): Promise<string> => {
  const result = await writeNativeStreamableBackup(store, "cache-share", options);
  options.onProgress?.({ stage: "sharing", message: "正在打开系统分享面板。" });
  const { Share } = await import("@capacitor/share");
  await Share.share({
    title: "学习日志备份",
    text: "这是学习日志的完整 zip 备份。",
    files: [result.uri],
    dialogTitle: "导出或分享备份",
  });
  options.onProgress?.({ stage: "done", message: "备份已交给系统分享面板。" });
  return "已打开系统保存/分享面板。";
};

const readJsonEntry = async <T>(sessionId: string, path: string): Promise<T> => {
  const result = await NativeZipArchive.readEntry({ sessionId, path });
  return JSON.parse(base64ToText(result.data)) as T;
};

const readAssetEntry = async (
  sessionId: string,
  path: string,
  mimeType: string,
): Promise<Blob> => {
  const parts: Blob[] = [];
  let offset = 0;
  while (true) {
    const chunk = await NativeZipArchive.readEntryChunk({
      sessionId,
      path,
      offset,
      length: ENTRY_CHUNK_BYTES,
    });
    if (chunk.data) {
      parts.push(base64ToBlob(chunk.data, mimeType));
    }
    offset += chunk.bytesRead;
    if (chunk.done) {
      break;
    }
  }
  return new Blob(parts, { type: mimeType });
};

export const importNativeStreamableBackupAndRestore = async (
  path: string,
  store: StorageAdapter,
  options: ImportOptions = {},
): Promise<ImportSummary> => {
  if (!canUseNativeZipArchive()) {
    throw new Error("原生流式导入只在 Android App 内可用。");
  }

  options.onProgress?.({ stage: "indexing", message: "正在索引备份 zip。" });
  const session = await NativeZipArchive.beginImport({ path });
  try {
    const versioned = session.entries.includes(KNOWLEDGE_PAYLOAD_ENTRY);
    const data = await readJsonEntry<StreamableBackupSnapshot["payload"] & { assets?: BackupAssetMeta[] }>(
      session.sessionId,
      versioned ? KNOWLEDGE_PAYLOAD_ENTRY : "data.json",
    );
    validateBackupPayloadVersion(data);
    if (versioned) validateBackupContainer(await readJsonEntry(session.sessionId, "manifest.json"), data);
    else if (data.manifest.version === 7) throw new Error("新版完整备份不能使用旧 data.json 入口。");
    const declarations = archiveAssetDeclarations(data.assetChecksums);
    const blocks = migrateBlocksToRecords(data.blocks ?? []);
    const recordBlocks = blocks.filter((block): block is RecordBlock => block.type === "record");
    const snapshot: StreamableBackupSnapshot = {
      payload: {
        manifest: data.manifest,
        ...(data.knowledge !== undefined ? { knowledge: data.knowledge } : {}),
        // Carried through so the importer can state which assets were verified and which were
        // taken on trust; never synthesised for a legacy archive.
        ...(data.assetChecksums !== undefined ? { assetChecksums: data.assetChecksums } : {}),
        templates: data.templates ?? [],
        podcasts: data.podcasts,
        reviewCoach: data.reviewCoach,
        entries: data.entries ?? [],
        blocks,
        recordDrafts: data.recordDrafts ?? [],
        mistakes: [],
        tags: data.tags ?? [],
        reviews: [],
        recordReviews: data.recordReviews ?? [],
        recordReviewLogs: data.recordReviewLogs ?? [],
        recordReviewDayStats: data.recordReviewDayStats ?? [],
        studySessions: data.studySessions ?? [],
        settings: ensureSettingsSubjects({ ...data.settings, schemaVersion: 4 }, recordBlocks),
        // Passed through only when the archive carries the key, so an archive
        // written before daily plans existed still means "leave local plans
        // alone" instead of "this device has none". See backup.ts `zipToSnapshot`.
        ...(data.dailyPlans !== undefined ? { dailyPlans: data.dailyPlans } : {}),
      },
      assets: data.assets ?? [],
      recordDrafts: data.recordDrafts ?? [],
    };
    const summary = summarizeSnapshot({ ...snapshot, assets: snapshot.assets.map((meta) => metaToAsset(meta, new Blob())) });
    // `restoreStreamableSnapshot` only stages until every asset has been read and verified, so an
    // integrity failure here still lands before the destructive transaction.
    await store.restoreStreamableSnapshot(snapshot, async (meta, index, total) => {
      options.onProgress?.({
        stage: "assets",
        message: `正在恢复资源 ${index + 1}/${total}。`,
        current: index + 1,
        total,
      });
      const entry = requireArchiveEntry(meta, session.entries.find((item) => item.startsWith(assetPath(meta))));
      const blob = await readAssetEntry(session.sessionId, entry, meta.mimeType);
      await assertArchiveAssetBytes(meta, declarations.get(meta.id), blob);
      return metaToAsset(meta, blob);
    }, options);
    await NativeZipArchive.finishImport({ sessionId: session.sessionId });
    options.onProgress?.({ stage: "done", message: "备份恢复完成。" });
    return summary;
  } catch (error) {
    await NativeZipArchive.cancelImport({ sessionId: session.sessionId }).catch(() => undefined);
    throw error;
  }
};
