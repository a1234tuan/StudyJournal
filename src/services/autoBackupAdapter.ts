import { createNativeRepository } from "./nativeRepositoryBackupService";
import type { KnowledgeBackupToken } from "../features/knowledgeLibrary/scope";
import { currentKnowledgeOwner, knowledgeContextGeneration, assertKnowledgeOwner } from "../features/knowledgeLibrary/context";
import type { AutoBackupVerification, StorageAdapter, StorageSnapshot } from "../types";
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
  /**
   * What was actually proven about the file that was just written, so `verifiedAt` can never be
   * read as a stronger guarantee than the platform gave us.
   */
  verification?: AutoBackupVerification;
}

export type { AutoBackupVerification };

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
    /**
     * `createWritable()` writes to a swap file, so the previous `latest.zip` survives an interrupted
     * write. The read-back below is the other half: the provider's view of the file must match the
     * bytes we handed it, otherwise a silent truncation would be reported as a verified backup.
     */
    const writable = await fileHandle.createWritable();
    await writable.write(zip);
    await writable.close();
    const file = await fileHandle.getFile();
    if (zip.size <= 0 || file.size !== zip.size) {
      throw new Error(
        `自动备份写入后核对失败：写入 ${zip.size} 字节，但备份文件夹中的 ${LATEST_FILE_NAME} 为 ${file.size} 字节。`
        + "为避免把不完整的备份当成成功结果，本次没有更新备份状态；上一份备份没有被改动。",
      );
    }
    return {
      folderName: webDirectoryHandle.name,
      size: file.size,
      displayName: file.name,
      lastModified: file.lastModified,
      verifiedAt: Date.now(),
      verification: "destination-readback",
    };
    } finally { destinationBusy = false; }
  },
};
