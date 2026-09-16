import type {
  Asset,
  BackupAssetMeta,
  ExportOptions,
  ImportOptions,
  ImportSummary,
  RecordBlock,
  StorageAdapter,
  StreamableBackupSnapshot,
} from "../types";
import { EMPTY_REVIEW_COACH_FORMAL_SNAPSHOT } from "../features/reviewCoach/domain";
import { migrateBlocksToRecords } from "../lib/recordMigration";
import { ensureSettingsSubjects } from "../lib/subjects";
import { withRestoreLock } from "./restoreLockService";
import { base64ToBlob, summarizeSnapshot } from "./backup";
import { blobToBase64Chunks } from "./nativeFileWriter";
import { sanitizeStreamableSnapshotForExport } from "./exportPrivacy";
import {
  appendNativeBackupRepositoryFileWrite,
  beginNativeBackupRepositoryFileWrite,
  cancelNativeBackupRepositoryFileWrite,
  canUseNativeAutoBackup,
  deleteNativeBackupRepositoryFile,
  ensureNativeBackupRepository,
  finishNativeBackupRepositoryFileWrite,
  listNativeBackupRepositoryFiles,
  readNativeBackupRepositoryFileChunk,
  readNativeBackupRepositoryTextFile,
  type NativeRepositoryFile,
} from "./nativeAutoBackup";

const REPOSITORY_NAME = "study-journal-backup";
const REPOSITORY_FORMAT = "folder-repository-v1" as const;
const REPOSITORY_MANIFEST_FORMAT = "study-journal-folder-repository";
const REPOSITORY_SNAPSHOT_FORMAT = "study-journal-folder-snapshot";
const SNAPSHOT_KEEP_COUNT = 5;
const ENTRY_CHUNK_BYTES = 768 * 1024;

interface RepositoryManifestSnapshot {
  id: string;
  path: string;
  exportedAt: string;
  assetCount: number;
  totalAssetBytes: number;
}

type NativeRepositoryRestoreOptions = ImportOptions & {
  onRestored?: () => Promise<void> | void;
};

interface RepositoryManifest {
  format: typeof REPOSITORY_MANIFEST_FORMAT;
  version: 1;
  updatedAt: string;
  latestSnapshotId?: string;
  snapshots: RepositoryManifestSnapshot[];
}

interface RepositorySnapshotFile extends StreamableBackupSnapshot {
  format?: typeof REPOSITORY_SNAPSHOT_FORMAT;
  version?: 1;
  exportedAt?: string;
  assetPaths?: Record<string, string>;
}

interface RepositoryWriteSummary {
  folderName?: string;
  format: typeof REPOSITORY_FORMAT;
  size: number;
  bytesWritten: number;
  repositorySize: number;
  assetCount: number;
  snapshotId: string;
  displayName: string;
  verifiedAt: number;
  lastModified?: number;
  warning?: string;
}

type LoadedRepositorySnapshot = {
  snapshot: StreamableBackupSnapshot;
  assetPaths: Record<string, string>;
  snapshotId: string;
};

const textBlob = (text: string, type = "application/json") =>
  new Blob([text], { type });

const nowSnapshotId = () =>
  new Date().toISOString().replace(/[-:.]/g, "").replace("Z", "Z");

const sanitizeFileName = (value: string) => {
  const cleaned = value.replace(/[\\/:*?"<>|]+/g, "_").replace(/\s+/g, " ").trim();
  return cleaned || "asset";
};

const assetPath = (asset: BackupAssetMeta): string =>
  `assets/${asset.id}-${sanitizeFileName(asset.fileName)}`;

const metaToAsset = (meta: BackupAssetMeta, blob: Blob): Asset =>
  ({
    ...meta,
    data: new File([blob], meta.fileName, { type: meta.mimeType }),
  });

const fileMapByPath = (files: NativeRepositoryFile[]) =>
  new Map(files.map((file) => [file.path, file]));

const totalPositiveSize = (files: NativeRepositoryFile[]) =>
  files.reduce((total, file) => total + (file.size > 0 ? file.size : 0), 0);

const writeRepositoryBlob = async (
  path: string,
  blob: Blob,
  mimeType: string,
): Promise<{ size: number; lastModified?: number }> => {
  const session = await beginNativeBackupRepositoryFileWrite(REPOSITORY_NAME, path, mimeType);
  try {
    for await (const chunk of blobToBase64Chunks(blob, ENTRY_CHUNK_BYTES)) {
      await appendNativeBackupRepositoryFileWrite(session.sessionId, chunk.data);
    }
    return finishNativeBackupRepositoryFileWrite(session.sessionId);
  } catch (error) {
    await cancelNativeBackupRepositoryFileWrite(session.sessionId).catch(() => undefined);
    throw error;
  }
};

const readRepositoryBlob = async (path: string, mimeType: string): Promise<Blob> => {
  const parts: Blob[] = [];
  let offset = 0;
  while (true) {
    const chunk = await readNativeBackupRepositoryFileChunk(
      REPOSITORY_NAME,
      path,
      offset,
      ENTRY_CHUNK_BYTES,
    );
    if (chunk.data) {
      parts.push(base64ToBlob(chunk.data, mimeType));
    }
    offset += chunk.bytesRead;
    if (chunk.done || chunk.bytesRead === 0) {
      break;
    }
  }
  return new Blob(parts, { type: mimeType });
};

const readManifest = async (): Promise<RepositoryManifest | undefined> => {
  try {
    const result = await readNativeBackupRepositoryTextFile(REPOSITORY_NAME, "manifest.json");
    const parsed = JSON.parse(result.text) as RepositoryManifest;
    if (parsed.format !== REPOSITORY_MANIFEST_FORMAT || parsed.version !== 1) {
      return undefined;
    }
    return { ...parsed, snapshots: parsed.snapshots ?? [] };
  } catch {
    return undefined;
  }
};

const normalizeSnapshot = (parsed: RepositorySnapshotFile): StreamableBackupSnapshot => {
  const payload = parsed.payload;
  if (
    !payload?.manifest ||
    !["408-study-journal", "study-journal"].includes(payload.manifest.format) ||
    ![1, 2, 3, 4, 5, 6].includes(payload.manifest.version)
  ) {
    throw new Error("自动备份仓库快照格式不兼容或已损坏。");
  }
  const blocks = migrateBlocksToRecords(payload.blocks ?? []);
  const recordBlocks = blocks.filter((block): block is RecordBlock => block.type === "record");
  return {
    payload: {
      manifest: payload.manifest,
      entries: payload.entries ?? [],
      blocks,
      recordDrafts: payload.recordDrafts ?? parsed.recordDrafts ?? [],
      mistakes: [],
      tags: payload.tags ?? [],
      reviews: [],
      recordReviews: payload.recordReviews ?? [],
      recordReviewLogs: payload.recordReviewLogs ?? [],
      recordReviewDayStats: payload.recordReviewDayStats ?? [],
      studySessions: payload.studySessions ?? [],
      settings: ensureSettingsSubjects({ ...payload.settings, schemaVersion: 4 }, recordBlocks),
      // Same absent-vs-empty rule as the other import paths: a repository file
      // written before daily plans existed must not be read as "no plans".
      ...(payload.dailyPlans !== undefined ? { dailyPlans: payload.dailyPlans } : {}),
      reviewCoach: payload.reviewCoach ?? structuredClone(EMPTY_REVIEW_COACH_FORMAL_SNAPSHOT),
    },
    assets: parsed.assets ?? [],
    recordDrafts: payload.recordDrafts ?? parsed.recordDrafts ?? [],
  };
};

const parseSnapshotFile = (text: string): { snapshot: StreamableBackupSnapshot; assetPaths: Record<string, string> } => {
  const parsed = JSON.parse(text) as RepositorySnapshotFile;
  const snapshot = normalizeSnapshot(parsed);
  const assetPaths = parsed.assetPaths ?? Object.fromEntries(snapshot.assets.map((asset) => [asset.id, assetPath(asset)]));
  return { snapshot, assetPaths };
};

const snapshotSummary = (snapshot: StreamableBackupSnapshot): ImportSummary =>
  summarizeSnapshot({
    payload: snapshot.payload,
    assets: snapshot.assets.map((meta) => metaToAsset(meta, new Blob())),
    recordDrafts: snapshot.recordDrafts,
  });

const hasRecoverableData = (snapshot: StreamableBackupSnapshot): boolean => {
  const summary = snapshotSummary(snapshot);
  return summary.records > 0 || summary.deletedRecords > 0 || summary.assets > 0;
};

const listRepositorySize = async () => {
  const [root, assets, snapshots] = await Promise.all([
    listNativeBackupRepositoryFiles(REPOSITORY_NAME, ""),
    listNativeBackupRepositoryFiles(REPOSITORY_NAME, "assets"),
    listNativeBackupRepositoryFiles(REPOSITORY_NAME, "snapshots"),
  ]);
  return totalPositiveSize(root) + totalPositiveSize(assets) + totalPositiveSize(snapshots);
};

const loadKeptAssetPaths = async (
  snapshots: RepositoryManifestSnapshot[],
  currentSnapshotId: string,
  currentAssetPaths: Record<string, string>,
) => {
  const paths = new Set(Object.values(currentAssetPaths));
  for (const snapshot of snapshots) {
    if (snapshot.id === currentSnapshotId) {
      continue;
    }
    try {
      const text = (await readNativeBackupRepositoryTextFile(REPOSITORY_NAME, snapshot.path)).text;
      const parsed = JSON.parse(text) as RepositorySnapshotFile;
      const snapshotAssetPaths = parsed.assetPaths ?? Object.fromEntries((parsed.assets ?? []).map((asset) => [asset.id, assetPath(asset)]));
      Object.values(snapshotAssetPaths).forEach((path) => paths.add(path));
    } catch {
      // Cleanup is best-effort; a broken old snapshot should not make a completed backup fail.
    }
  }
  return paths;
};

const cleanupRepository = async (
  keptSnapshots: RepositoryManifestSnapshot[],
  currentSnapshotId: string,
  currentAssetPaths: Record<string, string>,
): Promise<string | undefined> => {
  try {
    const keptSnapshotPaths = new Set(keptSnapshots.map((snapshot) => snapshot.path));
    const keptAssetPaths = await loadKeptAssetPaths(keptSnapshots, currentSnapshotId, currentAssetPaths);
    const [snapshots, assets] = await Promise.all([
      listNativeBackupRepositoryFiles(REPOSITORY_NAME, "snapshots"),
      listNativeBackupRepositoryFiles(REPOSITORY_NAME, "assets"),
    ]);
    await Promise.all(
      snapshots
        .filter((file) => !keptSnapshotPaths.has(file.path))
        .map((file) => deleteNativeBackupRepositoryFile(REPOSITORY_NAME, file.path).catch(() => undefined)),
    );
    await Promise.all(
      assets
        .filter((file) => !keptAssetPaths.has(file.path))
        .map((file) => deleteNativeBackupRepositoryFile(REPOSITORY_NAME, file.path).catch(() => undefined)),
    );
    return undefined;
  } catch (error) {
    return error instanceof Error ? `自动备份已完成，但清理旧资源失败：${error.message}` : "自动备份已完成，但清理旧资源失败。";
  }
};

export const writeNativeRepositoryBackupSnapshot = async (
  snapshot: StreamableBackupSnapshot,
  getAsset: (assetId: string) => Promise<Asset | undefined>,
  options: ExportOptions = {},
): Promise<RepositoryWriteSummary> => {
  if (!canUseNativeAutoBackup()) {
    throw new Error("增量文件夹备份只在 Android 或 Windows 桌面应用内可用。");
  }

  const portableSnapshot = sanitizeStreamableSnapshotForExport(snapshot);
  options.onProgress?.({ stage: "preparing", message: "正在准备增量备份仓库。" });
  const repository = await ensureNativeBackupRepository(REPOSITORY_NAME);
  const existingAssets = fileMapByPath(await listNativeBackupRepositoryFiles(REPOSITORY_NAME, "assets"));
  const assetPaths: Record<string, string> = {};
  let bytesWritten = 0;

  for (const [index, meta] of portableSnapshot.assets.entries()) {
    const path = assetPath(meta);
    assetPaths[meta.id] = path;
    const existing = existingAssets.get(path);
    if (existing && existing.size === meta.size) {
      continue;
    }
    options.onProgress?.({
      stage: "asset",
      message: `正在写入新增资源 ${index + 1}/${portableSnapshot.assets.length}。`,
      current: index + 1,
      total: portableSnapshot.assets.length,
    });
    const asset = await getAsset(meta.id);
    if (!asset) {
      throw new Error(`自动备份缺少资源：${meta.fileName}`);
    }
    const result = await writeRepositoryBlob(path, asset.data, meta.mimeType);
    if (result.size !== meta.size) {
      throw new Error(`自动备份资源写入大小不匹配：${meta.fileName}`);
    }
    bytesWritten += result.size;
  }

  const snapshotId = nowSnapshotId();
  const snapshotPath = `snapshots/${snapshotId}.json`;
  const snapshotFile: RepositorySnapshotFile = {
    format: REPOSITORY_SNAPSHOT_FORMAT,
    version: 1,
    exportedAt: portableSnapshot.payload.manifest.exportedAt,
    payload: portableSnapshot.payload,
    assets: portableSnapshot.assets,
    recordDrafts: portableSnapshot.recordDrafts ?? portableSnapshot.payload.recordDrafts ?? [],
    assetPaths,
  };
  const snapshotWrite = await writeRepositoryBlob(
    snapshotPath,
    textBlob(JSON.stringify(snapshotFile)),
    "application/json",
  );
  if (snapshotWrite.size <= 0) {
    throw new Error("自动备份仓库快照写入结果为空。");
  }
  bytesWritten += snapshotWrite.size;

  const previousManifest = await readManifest();
  const currentRef: RepositoryManifestSnapshot = {
    id: snapshotId,
    path: snapshotPath,
    exportedAt: portableSnapshot.payload.manifest.exportedAt,
    assetCount: portableSnapshot.assets.length,
    totalAssetBytes: portableSnapshot.assets.reduce((total, asset) => total + Math.max(0, asset.size), 0),
  };
  const keptSnapshots = [currentRef, ...(previousManifest?.snapshots ?? []).filter((item) => item.id !== snapshotId)]
    .sort((a, b) => b.exportedAt.localeCompare(a.exportedAt))
    .slice(0, SNAPSHOT_KEEP_COUNT);
  const manifest: RepositoryManifest = {
    format: REPOSITORY_MANIFEST_FORMAT,
    version: 1,
    updatedAt: new Date().toISOString(),
    latestSnapshotId: snapshotId,
    snapshots: keptSnapshots,
  };
  const manifestWrite = await writeRepositoryBlob(
    "manifest.json",
    textBlob(JSON.stringify(manifest)),
    "application/json",
  );
  if (manifestWrite.size <= 0) {
    throw new Error("自动备份仓库 manifest 写入结果为空。");
  }
  bytesWritten += manifestWrite.size;

  const cleanupWarning = await cleanupRepository(keptSnapshots, snapshotId, assetPaths);
  const repositorySize = await listRepositorySize();
  options.onProgress?.({ stage: "done", message: "增量备份仓库已更新。" });
  return {
    folderName: repository.folderName,
    format: REPOSITORY_FORMAT,
    size: repositorySize,
    bytesWritten,
    repositorySize,
    assetCount: portableSnapshot.assets.length,
    snapshotId,
    displayName: REPOSITORY_NAME,
    verifiedAt: Date.now(),
    lastModified: manifestWrite.lastModified,
    warning: cleanupWarning,
  };
};

export const writeNativeRepositoryBackup = async (
  store: StorageAdapter,
  options: ExportOptions = {},
): Promise<RepositoryWriteSummary> => {
  const snapshot = await store.createStreamableSnapshot();
  return writeNativeRepositoryBackupSnapshot(snapshot, (id) => store.getAsset(id), options);
};

const loadSnapshotFromManifest = async (
  manifest: RepositoryManifest,
): Promise<LoadedRepositorySnapshot> => {
  const candidates = [
    ...manifest.snapshots.filter((snapshot) => snapshot.id === manifest.latestSnapshotId),
    ...manifest.snapshots.filter((snapshot) => snapshot.id !== manifest.latestSnapshotId),
  ];
  if (!candidates.length) {
    throw new Error("自动备份仓库没有可恢复的快照。");
  }

  let firstLoaded: LoadedRepositorySnapshot | undefined;
  for (const candidate of candidates) {
    const text = (await readNativeBackupRepositoryTextFile(REPOSITORY_NAME, candidate.path)).text;
    const parsed = parseSnapshotFile(text);
    const loaded = { ...parsed, snapshotId: candidate.id };
    firstLoaded ??= loaded;
    if (hasRecoverableData(loaded.snapshot)) {
      return loaded;
    }
  }

  if (firstLoaded) {
    return firstLoaded;
  }
  throw new Error("自动备份仓库没有可恢复的快照。");
};

const scanLatestSnapshot = async (): Promise<LoadedRepositorySnapshot> => {
  const files = (await listNativeBackupRepositoryFiles(REPOSITORY_NAME, "snapshots"))
    .filter((file) => file.displayName.endsWith(".json"))
    .sort((a, b) => (b.lastModified ?? 0) - (a.lastModified ?? 0) || b.displayName.localeCompare(a.displayName));
  let firstLoaded: LoadedRepositorySnapshot | undefined;
  for (const file of files) {
    try {
      const text = (await readNativeBackupRepositoryTextFile(REPOSITORY_NAME, file.path)).text;
      const parsed = parseSnapshotFile(text);
      const loaded = { ...parsed, snapshotId: file.displayName.replace(/\.json$/i, "") };
      firstLoaded ??= loaded;
      if (hasRecoverableData(loaded.snapshot)) {
        return loaded;
      }
    } catch {
      // Try the next snapshot; this path is used when manifest.json is broken.
    }
  }
  if (firstLoaded) {
    return firstLoaded;
  }
  throw new Error("自动备份仓库没有可解析的快照。");
};

const loadLatestSnapshot = async () => {
  const manifest = await readManifest();
  if (manifest?.snapshots.length) {
    try {
      return await loadSnapshotFromManifest(manifest);
    } catch {
      return scanLatestSnapshot();
    }
  }
  return scanLatestSnapshot();
};

const verifyRepositoryAssets = async (
  assets: BackupAssetMeta[],
  assetPaths: Record<string, string>,
) => {
  const files = fileMapByPath(await listNativeBackupRepositoryFiles(REPOSITORY_NAME, "assets"));
  for (const meta of assets) {
    const path = assetPaths[meta.id] ?? assetPath(meta);
    const file = files.get(path);
    if (!file) {
      throw new Error(`自动备份仓库缺少资源文件：${meta.fileName}`);
    }
    if (file.size <= 0 && meta.size > 0) {
      throw new Error(`自动备份仓库资源文件大小异常：${meta.fileName}`);
    }
    if (file.size > 0 && meta.size > 0 && file.size !== meta.size) {
      throw new Error(`自动备份仓库资源文件大小不匹配：${meta.fileName}`);
    }
  }
};

export const restoreNativeRepositoryBackup = async (
  store: StorageAdapter,
  options: NativeRepositoryRestoreOptions = {},
): Promise<ImportSummary> =>
  withRestoreLock(async () => {
    if (!canUseNativeAutoBackup()) {
      throw new Error("增量文件夹恢复只在 Android 或 Windows 桌面应用内可用。");
    }

    options.onProgress?.({ stage: "indexing", message: "正在检查自动备份仓库。" });
    const { snapshot, assetPaths } = await loadLatestSnapshot();
    await verifyRepositoryAssets(snapshot.assets, assetPaths);
    const summary = snapshotSummary(snapshot);
    if (!hasRecoverableData(snapshot)) {
      throw new Error("自动备份仓库中没有可恢复的数据。");
    }

    options.onProgress?.({ stage: "restoring", message: "仓库快照已通过校验，正在覆盖当前本地数据。" });
    await store.restoreStreamableSnapshot(snapshot, async (meta, index, total) => {
      options.onProgress?.({
        stage: "assets",
        message: `正在恢复资源 ${index + 1}/${total}。`,
        current: index + 1,
        total,
      });
      const blob = await readRepositoryBlob(assetPaths[meta.id] ?? assetPath(meta), meta.mimeType);
      return metaToAsset(meta, blob);
    }, options);
    options.onProgress?.({ stage: "done", message: "自动备份仓库恢复完成。" });
    await options.onRestored?.();
    return summary;
  });

export const diagnoseNativeRepositoryBackup = async () => {
  await ensureNativeBackupRepository(REPOSITORY_NAME);
  const [root, assets, snapshots] = await Promise.all([
    listNativeBackupRepositoryFiles(REPOSITORY_NAME, ""),
    listNativeBackupRepositoryFiles(REPOSITORY_NAME, "assets"),
    listNativeBackupRepositoryFiles(REPOSITORY_NAME, "snapshots"),
  ]);
  return {
    repositoryName: REPOSITORY_NAME,
    root,
    assets,
    snapshots,
    repositorySize: totalPositiveSize(root) + totalPositiveSize(assets) + totalPositiveSize(snapshots),
  };
};
