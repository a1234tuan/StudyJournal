import { containerForPayload, validateBackupContainer, validateBackupPayloadVersion, type KnowledgeContainer } from "../features/knowledgeLibrary/backupContainer";
import type {
  Asset,
  BackupAssetChecksum,
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
import {
  archiveAssetDeclarations,
  assertArchiveAssetBytes,
  base64ToBlob,
  BackupArchiveIntegrityError,
  summarizeSnapshot,
} from "./backup";
import { hashBlob } from "./cloudSyncModel";
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
  container?: KnowledgeContainer;
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
  /** Always `archive-verified`: the snapshot is read back and re-validated before it is promoted. */
  verification: "archive-verified";
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

/** The historical path layout, still used to resolve snapshots written before generation paths. */
const assetPath = (asset: BackupAssetMeta): string =>
  `assets/${asset.id}-${sanitizeFileName(asset.fileName)}`;

/**
 * The generation path of an asset: one file per distinct content.
 *
 * Naming the file after the content is what makes an interrupted write harmless. Rewriting a shared
 * file in place would damage *every* snapshot that points at it — including older, already verified
 * ones — so a byte-level interruption could leave the user with no restorable archive at all. With
 * a generation path, changed content lands on a new file and older snapshots keep their own intact
 * bytes, while unchanged content resolves to the same path and is still written only once.
 *
 * A prefix collision would make the writer skip a write and then declare a hash the file does not
 * have, which the restore path rejects loudly; it can never silently serve the wrong bytes.
 */
const assetGenerationPath = (asset: BackupAssetMeta, contentHash: string): string =>
  `assets/${asset.id}-${contentHash}-${sanitizeFileName(asset.fileName)}`;

const metaToAsset = (meta: BackupAssetMeta, blob: Blob): Asset =>
  ({
    ...meta,
    data: new File([blob], meta.fileName, { type: meta.mimeType }),
  });

const fileMapByPath = (files: NativeRepositoryFile[]) =>
  new Map(files.map((file) => [file.path, file]));

const totalPositiveSize = (files: NativeRepositoryFile[]) =>
  files.reduce((total, file) => total + (file.size > 0 ? file.size : 0), 0);

export const createNativeRepository = (repositoryName = REPOSITORY_NAME) => {
  if (!/^study-journal-backup(?:-[a-f0-9-]{1,80})?$/.test(repositoryName)) throw new Error("备份仓库身份无效。");
const writeRepositoryBlob = async (
  path: string,
  blob: Blob,
  mimeType: string,
): Promise<{ size: number; lastModified?: number }> => {
  const session = await beginNativeBackupRepositoryFileWrite(repositoryName, path, mimeType);
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
      repositoryName,
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
    const result = await readNativeBackupRepositoryTextFile(repositoryName, "manifest.json");
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
    ![1, 2, 3, 4, 5, 6, 7].includes(payload.manifest.version)
  ) {
    throw new Error("自动备份仓库快照格式不兼容或已损坏。");
  }
  validateBackupPayloadVersion(payload);
  if (payload.manifest.version === 7) validateBackupContainer(parsed.container, { ...payload, assets: parsed.assets } as typeof payload);
  const blocks = migrateBlocksToRecords(payload.blocks ?? []);
  const recordBlocks = blocks.filter((block): block is RecordBlock => block.type === "record");
  return {
    payload: {
      manifest: payload.manifest,
      ...(payload.knowledge !== undefined ? { knowledge: payload.knowledge } : {}),
      // Carried through so a restore can say which assets were verified and which were taken on
      // trust; never synthesised for a snapshot written before declarations existed.
      ...(payload.assetChecksums !== undefined ? { assetChecksums: payload.assetChecksums } : {}),
      templates: payload.templates ?? [],
      podcasts: payload.podcasts,
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
  return summary.records > 0 || summary.deletedRecords > 0 || summary.assets > 0 || snapshot.payload.knowledge !== undefined;
};

const listRepositorySize = async () => {
  const [root, assets, snapshots] = await Promise.all([
    listNativeBackupRepositoryFiles(repositoryName, ""),
    listNativeBackupRepositoryFiles(repositoryName, "assets"),
    listNativeBackupRepositoryFiles(repositoryName, "snapshots"),
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
      const text = (await readNativeBackupRepositoryTextFile(repositoryName, snapshot.path)).text;
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
      listNativeBackupRepositoryFiles(repositoryName, "snapshots"),
      listNativeBackupRepositoryFiles(repositoryName, "assets"),
    ]);
    await Promise.all(
      snapshots
        .filter((file) => !keptSnapshotPaths.has(file.path))
        .map((file) => deleteNativeBackupRepositoryFile(repositoryName, file.path).catch(() => undefined)),
    );
    await Promise.all(
      assets
        .filter((file) => !keptAssetPaths.has(file.path))
        .map((file) => deleteNativeBackupRepositoryFile(repositoryName, file.path).catch(() => undefined)),
    );
    return undefined;
  } catch (error) {
    return error instanceof Error ? `自动备份已完成，但清理旧资源失败：${error.message}` : "自动备份已完成，但清理旧资源失败。";
  }
};

/**
 * The last verified copy of each asset, from the snapshot the manifest currently points at.
 *
 * Only used as a fallback for an asset whose bytes are no longer readable locally: that
 * declaration and that file were verified together when the snapshot was written, and the asset's
 * local content is gone, so there is no newer content to serve. Nothing is invented for an asset
 * that has no previous verified copy.
 */
const loadPreviousVerifiedAssets = async (
  manifest: RepositoryManifest | undefined,
): Promise<{ declarations: Map<string, BackupAssetChecksum>; paths: Record<string, string> }> => {
  const latest = manifest?.snapshots.find((item) => item.id === manifest.latestSnapshotId);
  if (!latest) return { declarations: new Map(), paths: {} };
  try {
    const parsed = JSON.parse(
      (await readNativeBackupRepositoryTextFile(repositoryName, latest.path)).text,
    ) as RepositorySnapshotFile;
    return {
      declarations: new Map((parsed.payload?.assetChecksums ?? []).map((entry) => [entry.id, entry])),
      paths: parsed.assetPaths ?? {},
    };
  } catch {
    return { declarations: new Map(), paths: {} };
  }
};

/**
 * Read the archive back before it is promoted.
 *
 * `manifest.json` is the pointer every restore follows, so it is only updated once the snapshot it
 * would point at has been re-read from the destination and its own structure and checksums
 * re-validated. A provider that reports a successful write but keeps different bytes — truncated,
 * altered, or with a container that no longer covers its payload — therefore leaves the previous
 * verified snapshot as `latest` instead of promoting a broken one.
 */
const readBackSnapshot = async (snapshotPath: string, expectedSize: number): Promise<void> => {
  const fail = (detail: string) => new BackupArchiveIntegrityError(
    `自动备份仓库回读校验失败：${detail}。上一份已验证的备份仍然可用，本次没有更新仓库的 manifest。`,
  );

  let text: string;
  try {
    text = (await readNativeBackupRepositoryTextFile(repositoryName, snapshotPath)).text;
  } catch (error) {
    throw fail(`无法重新读取刚写入的快照 ${snapshotPath}${error instanceof Error ? `（${error.message}）` : ""}`);
  }
  if (expectedSize > 0 && text.length === 0) {
    throw fail(`刚写入的快照 ${snapshotPath} 回读为空`);
  }

  let parsed: RepositorySnapshotFile;
  try {
    parsed = JSON.parse(text) as RepositorySnapshotFile;
  } catch {
    throw fail(`刚写入的快照 ${snapshotPath} 无法解析`);
  }
  if (!parsed.payload?.manifest) {
    throw fail(`刚写入的快照 ${snapshotPath} 缺少备份清单`);
  }
  if (parsed.payload.manifest.version === 7) {
    try {
      validateBackupContainer(parsed.container, { ...parsed.payload, assets: parsed.assets } as typeof parsed.payload);
    } catch (error) {
      throw fail(
        `刚写入的快照 ${snapshotPath} 的外层校验与内容不一致`
        + (error instanceof Error ? `（${error.message}）` : ""),
      );
    }
  }
  try {
    archiveAssetDeclarations(parsed.payload.assetChecksums);
  } catch (error) {
    throw fail(
      `刚写入的快照 ${snapshotPath} 的资源完整性清单无效`
      + (error instanceof Error ? `（${error.message}）` : ""),
    );
  }
};

const writeNativeRepositoryBackupSnapshot = async (
  snapshot: StreamableBackupSnapshot,
  getAsset: (assetId: string) => Promise<Asset | undefined>,
  options: ExportOptions = {},
): Promise<RepositoryWriteSummary> => {
  if (!canUseNativeAutoBackup()) {
    throw new Error("增量文件夹备份只在 Android 或 Windows 桌面应用内可用。");
  }

  const portableSnapshot = sanitizeStreamableSnapshotForExport(snapshot);
  options.onProgress?.({ stage: "preparing", message: "正在准备增量备份仓库。" });
  const repository = await ensureNativeBackupRepository(repositoryName);
  const existingAssets = fileMapByPath(await listNativeBackupRepositoryFiles(repositoryName, "assets"));
  const previousManifest = await readManifest();
  const previousVerified = await loadPreviousVerifiedAssets(previousManifest);
  const declarations = new Map<string, BackupAssetChecksum>();
  const assetPaths: Record<string, string> = {};
  let bytesWritten = 0;

  for (const [index, meta] of portableSnapshot.assets.entries()) {
    const asset = await getAsset(meta.id);
    if (asset) {
      const hash = await hashBlob(asset.data);
      const path = assetGenerationPath(meta, hash);
      assetPaths[meta.id] = path;
      declarations.set(meta.id, { id: meta.id, hash, size: asset.data.size });
      // Identical content already has its own generation file, so the write is skipped rather than
      // repeated — this is what keeps the second and later backups incremental.
      if (existingAssets.has(path)) continue;
      options.onProgress?.({
        stage: "asset",
        message: `正在写入新增资源 ${index + 1}/${portableSnapshot.assets.length}。`,
        current: index + 1,
        total: portableSnapshot.assets.length,
      });
      const result = await writeRepositoryBlob(path, asset.data, meta.mimeType);
      if (result.size !== meta.size) {
        throw new BackupArchiveIntegrityError(
          `自动备份资源写入大小不匹配：${meta.fileName}。为避免留下无法恢复的仓库，本次没有更新备份仓库。`,
        );
      }
      bytesWritten += result.size;
      continue;
    }

    /**
     * The bytes are not readable locally. Re-using the last verified copy keeps the backup working
     * for an asset whose local content was purged, and is honest: that file and that declaration
     * were verified together, and there is no newer content to serve.
     */
    const previous = previousVerified.declarations.get(meta.id);
    const previousPath = previousVerified.paths[meta.id];
    if (previous && previousPath && existingAssets.has(previousPath)) {
      assetPaths[meta.id] = previousPath;
      declarations.set(meta.id, previous);
      continue;
    }
    throw new BackupArchiveIntegrityError(
      `自动备份未能生成：资源“${meta.fileName}”（ID ${meta.id}）在本机缺失，且仓库中没有可复用的已验证副本。`
      + "请先确认该资源可正常打开后重试；本次没有更新备份仓库。",
    );
  }

  const snapshotId = nowSnapshotId();
  const snapshotPath = `snapshots/${snapshotId}.json`;
  const payload = {
    ...portableSnapshot.payload,
    // Declared inside the payload, so the v7 container checksum covers the bytes as well.
    assetChecksums: portableSnapshot.assets
      .map((meta) => declarations.get(meta.id))
      .filter((entry): entry is BackupAssetChecksum => Boolean(entry)),
  };
  const snapshotFile: RepositorySnapshotFile = {
    ...(payload.manifest.version === 7 ? { container: containerForPayload({ ...payload, assets: portableSnapshot.assets }) } : {}),
    format: REPOSITORY_SNAPSHOT_FORMAT,
    version: 1,
    exportedAt: payload.manifest.exportedAt,
    payload,
    assets: portableSnapshot.assets,
    recordDrafts: portableSnapshot.recordDrafts ?? payload.recordDrafts ?? [],
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
  await readBackSnapshot(snapshotPath, snapshotWrite.size);

  const currentRef: RepositoryManifestSnapshot = {
    id: snapshotId,
    path: snapshotPath,
    exportedAt: payload.manifest.exportedAt,
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
    displayName: repositoryName,
    verifiedAt: Date.now(),
    lastModified: manifestWrite.lastModified,
    warning: cleanupWarning,
    verification: "archive-verified",
  };
};

const writeNativeRepositoryBackup = async (
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
    const text = (await readNativeBackupRepositoryTextFile(repositoryName, candidate.path)).text;
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
  const files = (await listNativeBackupRepositoryFiles(repositoryName, "snapshots"))
    .filter((file) => file.displayName.endsWith(".json"))
    .sort((a, b) => (b.lastModified ?? 0) - (a.lastModified ?? 0) || b.displayName.localeCompare(a.displayName));
  let firstLoaded: LoadedRepositorySnapshot | undefined;
  for (const file of files) {
    try {
      const text = (await readNativeBackupRepositoryTextFile(repositoryName, file.path)).text;
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
  declarations: Map<string, BackupAssetChecksum>,
) => {
  const files = fileMapByPath(await listNativeBackupRepositoryFiles(repositoryName, "assets"));
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
    // Verified before the destructive transaction so a damaged repository cannot half-apply.
    const declaration = declarations.get(meta.id);
    if (!declaration) continue;
    await assertArchiveAssetBytes(meta, declaration, await readRepositoryBlob(path, meta.mimeType));
  }
};

const restoreNativeRepositoryBackup = async (
  store: StorageAdapter,
  options: NativeRepositoryRestoreOptions = {},
): Promise<ImportSummary> =>
  withRestoreLock(async () => {
    if (!canUseNativeAutoBackup()) {
      throw new Error("增量文件夹恢复只在 Android 或 Windows 桌面应用内可用。");
    }

    options.onProgress?.({ stage: "indexing", message: "正在检查自动备份仓库。" });
    const { snapshot, assetPaths } = await loadLatestSnapshot();
    await verifyRepositoryAssets(snapshot.assets, assetPaths, archiveAssetDeclarations(snapshot.payload.assetChecksums));
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

const diagnoseNativeRepositoryBackup = async () => {
  await ensureNativeBackupRepository(repositoryName);
  const [root, assets, snapshots] = await Promise.all([
    listNativeBackupRepositoryFiles(repositoryName, ""),
    listNativeBackupRepositoryFiles(repositoryName, "assets"),
    listNativeBackupRepositoryFiles(repositoryName, "snapshots"),
  ]);
  return {
    repositoryName: repositoryName,
    root,
    assets,
    snapshots,
    repositorySize: totalPositiveSize(root) + totalPositiveSize(assets) + totalPositiveSize(snapshots),
  };
};

  return { writeNativeRepositoryBackupSnapshot, writeNativeRepositoryBackup, restoreNativeRepositoryBackup, diagnoseNativeRepositoryBackup };
};

export const { writeNativeRepositoryBackupSnapshot, writeNativeRepositoryBackup, restoreNativeRepositoryBackup, diagnoseNativeRepositoryBackup } = createNativeRepository();
