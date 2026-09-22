import { createNativeRepository } from "./nativeRepositoryBackupService";
import type { KnowledgeBackupToken } from "../features/knowledgeLibrary/scope";
import { currentKnowledgeOwner, knowledgeContextGeneration, assertKnowledgeOwner } from "../features/knowledgeLibrary/context";
import type { StorageAdapter, StorageSnapshot } from "../types";
import { snapshotToZip } from "./backup";
import {
  bindNativeAutoBackupFolder,
  canUseNativeAutoBackup,
  getNativeAutoBackupStatus,
} from "./nativeAutoBackup";
import { writeNativeRepositoryBackup } from "./nativeRepositoryBackupService";

interface DirectoryPickerWindow extends Window {
  showDirectoryPicker?: () => Promise<FileSystemDirectoryHandle>;
}

const LATEST_FILE_NAME = "study-journal-latest.zip";
let webDirectoryHandle: FileSystemDirectoryHandle | undefined;

export interface AutoBackupWriteResult {
  folderName?: string;
  size: number;
  format?: "zip-latest" | "folder-repository-v1";
  bytesWritten?: number;
  repositorySize?: number;
  assetCount?: number;
  snapshotId?: string;
  uri?: string;
  displayName?: string;
  verifiedAt?: number;
  lastModified?: number;
  warning?: string;
}

export interface AutoBackupAdapter {
  isAvailable(): boolean;
  bindFolder(): Promise<{ folderName: string }>;
  isBound(): Promise<{ bound: boolean; folderName?: string }>;
  writeLatest(store: StorageAdapter, scope?: KnowledgeBackupToken, capturedSnapshot?: StorageSnapshot): Promise<AutoBackupWriteResult>;
}

let destinationBusy = false;
const webFolderName = (handle: FileSystemDirectoryHandle | undefined): string | undefined =>
  handle?.name;

export const autoBackupAdapter: AutoBackupAdapter = {
  isAvailable(): boolean {
    return canUseNativeAutoBackup() || typeof (window as DirectoryPickerWindow).showDirectoryPicker === "function";
  },

  async bindFolder(): Promise<{ folderName: string }> {
    if (destinationBusy) throw new Error("正在写入备份，暂时不能更换目的地。");
    destinationBusy = true;
    try {
    if (canUseNativeAutoBackup()) {
      return await bindNativeAutoBackupFolder();
    }
    const picker = (window as DirectoryPickerWindow).showDirectoryPicker;
    if (!picker) {
      throw new Error("当前环境不支持绑定备份文件夹，请使用手动导出 zip。");
    }
    webDirectoryHandle = await picker();
    return { folderName: webDirectoryHandle.name };
    } finally { destinationBusy = false; }
  },

  async isBound(): Promise<{ bound: boolean; folderName?: string }> {
    if (canUseNativeAutoBackup()) {
      return getNativeAutoBackupStatus();
    }
    return { bound: Boolean(webDirectoryHandle), folderName: webFolderName(webDirectoryHandle) };
  },

  async writeLatest(store: StorageAdapter, scope?: KnowledgeBackupToken, capturedSnapshot?: StorageSnapshot): Promise<AutoBackupWriteResult> {
    if (destinationBusy) throw new Error("备份目的地正在使用，请稍后重试。");
    destinationBusy = true;
    try {
    const owner = currentKnowledgeOwner();
    const generation = knowledgeContextGeneration();
    if (scope && scope.ownerScope !== owner) throw new Error("备份账号已变化。");
    if (scope && !capturedSnapshot) throw new Error("范围备份必须使用同一事务捕获的快照。");
    const snapshot = capturedSnapshot;
    assertKnowledgeOwner(owner, generation);
    const scopedStore = snapshot ? new Proxy(store, { get(target, property) {
      if (property === "createSnapshot") return async () => snapshot;
      if (property === "createStreamableSnapshot") return async () => ({ ...snapshot, assets: snapshot.assets.map(({ data: _data, ...meta }) => meta) });
      if (property === "getAsset") return async (id: string) => snapshot.assets.find(asset => asset.id === id);
      const value = Reflect.get(target, property);
      return typeof value === "function" ? value.bind(target) : value;
    } }) : store;
    if (canUseNativeAutoBackup()) {
      return await (scope ? createNativeRepository("study-journal-backup-" + scope.destinationId).writeNativeRepositoryBackup(scopedStore) : writeNativeRepositoryBackup(store));
    }
    if (!webDirectoryHandle) {
      throw new Error("尚未绑定自动备份文件夹。");
    }
    const directory = scope ? await webDirectoryHandle.getDirectoryHandle("study-journal-backup-" + scope.destinationId, { create: true }) : webDirectoryHandle;
    const zip = await snapshotToZip(await scopedStore.createSnapshot());
    const fileHandle = await directory.getFileHandle(LATEST_FILE_NAME, { create: true });
    const writable = await fileHandle.createWritable();
    await writable.write(zip);
    await writable.close();
    const file = await fileHandle.getFile();
    return {
      folderName: webDirectoryHandle.name,
      size: file.size,
      displayName: file.name,
      lastModified: file.lastModified,
      verifiedAt: Date.now(),
    };
    } finally { destinationBusy = false; }
  },
};
