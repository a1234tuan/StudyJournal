import { Capacitor, registerPlugin } from "@capacitor/core";

import type { ExportOptions } from "../types";
import { isDesktopPlatform } from "../lib/platform";
import { blobToBase64Chunks } from "./nativeFileWriter";

export interface NativeAutoBackupWriteResult {
  folderName?: string;
  size: number;
  uri?: string;
  displayName?: string;
  verifiedAt?: number;
  lastModified?: number;
  warning?: string;
}

export interface NativeAutoBackupFolderFile {
  displayName?: string;
  size?: number;
  lastModified?: number;
}

export interface NativeRepositoryFile {
  path: string;
  displayName: string;
  size: number;
  lastModified?: number;
}

export interface NativeRepositoryWriteResult {
  path: string;
  displayName: string;
  size: number;
  uri?: string;
  lastModified?: number;
}

interface NativeAutoBackupPlugin {
  bindFolder(): Promise<{ folderName: string }>;
  isBound(): Promise<{ bound: boolean; folderName?: string }>;
  writeLatest(options: {
    data: string;
    fileName: string;
    mimeType: string;
  }): Promise<{ folderName?: string; size: number; uri?: string }>;
  beginWriteLatest(options: {
    fileName: string;
    mimeType: string;
  }): Promise<{ sessionId: string; folderName?: string; uri?: string }>;
  appendWriteLatest(options: {
    sessionId: string;
    data: string;
  }): Promise<{ size: number }>;
  finishWriteLatest(options: {
    sessionId: string;
  }): Promise<NativeAutoBackupWriteResult>;
  cancelWriteLatest(options: {
    sessionId: string;
  }): Promise<void>;
  beginZipLatest(options: {
    fileName: string;
    mimeType: string;
  }): Promise<{ sessionId: string; folderName?: string; uri?: string }>;
  beginZipEntry(options: {
    sessionId: string;
    path: string;
  }): Promise<void>;
  appendZipEntry(options: {
    sessionId: string;
    data: string;
  }): Promise<void>;
  finishZipEntry(options: {
    sessionId: string;
  }): Promise<void>;
  finishZipLatest(options: {
    sessionId: string;
  }): Promise<NativeAutoBackupWriteResult>;
  cancelZipLatest(options: {
    sessionId: string;
  }): Promise<void>;
  diagnoseFolder(options: {
    limit: number;
  }): Promise<{ folderName?: string; files: NativeAutoBackupFolderFile[] }>;
  ensureRepository(options: {
    repositoryName: string;
  }): Promise<{ folderName?: string; repositoryName: string }>;
  listRepositoryFiles(options: {
    repositoryName: string;
    directory: string;
  }): Promise<{ files: NativeRepositoryFile[] }>;
  beginRepositoryFileWrite(options: {
    repositoryName: string;
    path: string;
    mimeType: string;
  }): Promise<{ sessionId: string; path: string; uri?: string }>;
  appendRepositoryFileWrite(options: {
    sessionId: string;
    data: string;
  }): Promise<{ size: number }>;
  finishRepositoryFileWrite(options: {
    sessionId: string;
  }): Promise<NativeRepositoryWriteResult>;
  cancelRepositoryFileWrite(options: {
    sessionId: string;
  }): Promise<void>;
  readRepositoryTextFile(options: {
    repositoryName: string;
    path: string;
  }): Promise<{ text: string; size: number }>;
  readRepositoryFileChunk(options: {
    repositoryName: string;
    path: string;
    offset: number;
    length: number;
  }): Promise<{ data: string; bytesRead: number; done: boolean }>;
  deleteRepositoryFile(options: {
    repositoryName: string;
    path: string;
  }): Promise<void>;
}

const NativeAutoBackup = registerPlugin<NativeAutoBackupPlugin>("NativeAutoBackup");

const desktopBackup = () => window.studyJournalDesktop?.backup;

const requireDesktopBackup = () => {
  const backup = desktopBackup();
  if (!backup) {
    throw new Error("桌面自动备份服务尚未就绪，请重新打开应用后重试。");
  }
  return backup;
};

export const canUseNativeAutoBackup = (): boolean =>
  (Capacitor.isNativePlatform() && Capacitor.getPlatform() === "android") ||
  (isDesktopPlatform() && Boolean(desktopBackup()));

export const bindNativeAutoBackupFolder = async (): Promise<{ folderName: string }> =>
  isDesktopPlatform() ? requireDesktopBackup().bindFolder() : NativeAutoBackup.bindFolder();

export const getNativeAutoBackupStatus = async (): Promise<{ bound: boolean; folderName?: string }> =>
  isDesktopPlatform() ? requireDesktopBackup().getStatus() : NativeAutoBackup.isBound();

export const writeNativeLatestBackup = async (
  blob: Blob,
  options: ExportOptions = {},
): Promise<NativeAutoBackupWriteResult> => {
  const session = await NativeAutoBackup.beginWriteLatest({
    fileName: "study-journal-latest.zip",
    mimeType: "application/zip",
  });

  let written = 0;
  try {
    for await (const chunk of blobToBase64Chunks(blob)) {
      const result = await NativeAutoBackup.appendWriteLatest({
        sessionId: session.sessionId,
        data: chunk.data,
      });
      written = result.size;
      options.onProgress?.({
        stage: "writing",
        message: `正在更新自动备份 ${blob.size > 0 ? Math.min(100, Math.round((written / blob.size) * 100)) : 100}% 。`,
        current: written,
        total: blob.size,
      });
    }

    return NativeAutoBackup.finishWriteLatest({ sessionId: session.sessionId });
  } catch (error) {
    await NativeAutoBackup.cancelWriteLatest({ sessionId: session.sessionId }).catch(() => undefined);
    throw error;
  }
};

export const beginNativeAutoBackupZip = async (): Promise<{ sessionId: string; folderName?: string; uri?: string }> =>
  NativeAutoBackup.beginZipLatest({
    fileName: "study-journal-latest.zip",
    mimeType: "application/zip",
  });

export const beginNativeAutoBackupZipEntry = async (sessionId: string, path: string): Promise<void> =>
  NativeAutoBackup.beginZipEntry({ sessionId, path });

export const appendNativeAutoBackupZipEntry = async (sessionId: string, data: string): Promise<void> =>
  NativeAutoBackup.appendZipEntry({ sessionId, data });

export const finishNativeAutoBackupZipEntry = async (sessionId: string): Promise<void> =>
  NativeAutoBackup.finishZipEntry({ sessionId });

export const finishNativeAutoBackupZip = async (
  sessionId: string,
): Promise<NativeAutoBackupWriteResult> =>
  NativeAutoBackup.finishZipLatest({ sessionId });

export const cancelNativeAutoBackupZip = async (sessionId: string): Promise<void> =>
  NativeAutoBackup.cancelZipLatest({ sessionId });

export const diagnoseNativeAutoBackupFolder = async (
  limit = 20,
): Promise<{ folderName?: string; files: NativeAutoBackupFolderFile[] }> =>
  NativeAutoBackup.diagnoseFolder({ limit });

export const ensureNativeBackupRepository = async (
  repositoryName: string,
): Promise<{ folderName?: string; repositoryName: string }> =>
  isDesktopPlatform()
    ? requireDesktopBackup().ensureRepository(repositoryName)
    : NativeAutoBackup.ensureRepository({ repositoryName });

export const listNativeBackupRepositoryFiles = async (
  repositoryName: string,
  directory: string,
): Promise<NativeRepositoryFile[]> =>
  isDesktopPlatform()
    ? requireDesktopBackup().listFiles(repositoryName, directory)
    : (await NativeAutoBackup.listRepositoryFiles({ repositoryName, directory })).files;

export const beginNativeBackupRepositoryFileWrite = async (
  repositoryName: string,
  path: string,
  mimeType: string,
): Promise<{ sessionId: string; path: string; uri?: string }> =>
  isDesktopPlatform()
    ? requireDesktopBackup().beginWrite(repositoryName, path)
    : NativeAutoBackup.beginRepositoryFileWrite({ repositoryName, path, mimeType });

export const appendNativeBackupRepositoryFileWrite = async (
  sessionId: string,
  data: string,
): Promise<{ size: number }> =>
  isDesktopPlatform()
    ? requireDesktopBackup().appendWrite(sessionId, data)
    : NativeAutoBackup.appendRepositoryFileWrite({ sessionId, data });

export const finishNativeBackupRepositoryFileWrite = async (
  sessionId: string,
): Promise<NativeRepositoryWriteResult> =>
  isDesktopPlatform()
    ? requireDesktopBackup().finishWrite(sessionId)
    : NativeAutoBackup.finishRepositoryFileWrite({ sessionId });

export const cancelNativeBackupRepositoryFileWrite = async (sessionId: string): Promise<void> =>
  isDesktopPlatform()
    ? requireDesktopBackup().cancelWrite(sessionId)
    : NativeAutoBackup.cancelRepositoryFileWrite({ sessionId });

export const readNativeBackupRepositoryTextFile = async (
  repositoryName: string,
  path: string,
): Promise<{ text: string; size: number }> =>
  isDesktopPlatform()
    ? requireDesktopBackup().readText(repositoryName, path)
    : NativeAutoBackup.readRepositoryTextFile({ repositoryName, path });

export const readNativeBackupRepositoryFileChunk = async (
  repositoryName: string,
  path: string,
  offset: number,
  length: number,
): Promise<{ data: string; bytesRead: number; done: boolean }> =>
  isDesktopPlatform()
    ? requireDesktopBackup().readChunk(repositoryName, path, offset, length)
    : NativeAutoBackup.readRepositoryFileChunk({ repositoryName, path, offset, length });

export const deleteNativeBackupRepositoryFile = async (
  repositoryName: string,
  path: string,
): Promise<void> =>
  isDesktopPlatform()
    ? requireDesktopBackup().deleteFile(repositoryName, path)
    : NativeAutoBackup.deleteRepositoryFile({ repositoryName, path });
