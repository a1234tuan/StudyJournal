import { afterEach, describe, expect, it, vi } from "vitest";

import {
  bindNativeAutoBackupFolder,
  canUseNativeAutoBackup,
  beginNativeBackupRepositoryFileWrite,
  deleteNativeBackupRepositoryFile,
  ensureNativeBackupRepository,
  listNativeBackupRepositoryFiles,
  readNativeBackupRepositoryTextFile,
} from "./nativeAutoBackup";

const desktopBackup = {
  bindFolder: vi.fn(async () => ({ folderName: "D:/Backups/study-journal-backup" })),
  getStatus: vi.fn(async () => ({ bound: true, folderName: "D:/Backups/study-journal-backup" })),
  ensureRepository: vi.fn(async (repositoryName: string) => ({ folderName: "D:/Backups/study-journal-backup", repositoryName })),
  listFiles: vi.fn(async (_repositoryName: string, _directory: string) => [{ path: "snapshots/latest.json", displayName: "latest.json", size: 42 }]),
  beginWrite: vi.fn(async (repositoryName: string, path: string) => ({ sessionId: repositoryName, path })),
  appendWrite: vi.fn(),
  finishWrite: vi.fn(),
  cancelWrite: vi.fn(),
  readText: vi.fn(async (_repositoryName: string, _path: string) => ({ text: "{}", size: 2 })),
  readChunk: vi.fn(),
  deleteFile: vi.fn(async () => undefined),
};

describe("desktop native auto backup adapter", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it("uses the Electron backup bridge for repository operations", async () => {
    vi.stubGlobal("window", {
      studyJournalDesktop: {
        isDesktop: true,
        backup: desktopBackup,
        onBackupFlushRequested: vi.fn(() => vi.fn()),
      },
    });

    expect(canUseNativeAutoBackup()).toBe(true);
    await expect(bindNativeAutoBackupFolder()).resolves.toEqual({ folderName: "D:/Backups/study-journal-backup" });
    await expect(ensureNativeBackupRepository("study-journal-backup-owner-a")).resolves.toMatchObject({
      repositoryName: "study-journal-backup-owner-a",
    });
    await expect(listNativeBackupRepositoryFiles("study-journal-backup-owner-a", "snapshots")).resolves.toEqual([
      { path: "snapshots/latest.json", displayName: "latest.json", size: 42 },
    ]);
    await expect(beginNativeBackupRepositoryFileWrite("study-journal-backup-owner-a", "manifest.json", "application/json")).resolves.toEqual({ sessionId: "study-journal-backup-owner-a", path: "manifest.json" });
    await expect(readNativeBackupRepositoryTextFile("study-journal-backup-owner-a", "manifest.json")).resolves.toEqual({ text: "{}", size: 2 });
    await expect(deleteNativeBackupRepositoryFile("study-journal-backup-owner-a", "manifest.json")).resolves.toBeUndefined();

    expect(desktopBackup.bindFolder).toHaveBeenCalledOnce();
    expect(desktopBackup.ensureRepository).toHaveBeenCalledOnce();
    expect(desktopBackup.ensureRepository).toHaveBeenCalledWith("study-journal-backup-owner-a");
    expect(desktopBackup.listFiles).toHaveBeenCalledWith("study-journal-backup-owner-a", "snapshots");
    expect(desktopBackup.beginWrite).toHaveBeenCalledWith("study-journal-backup-owner-a", "manifest.json");
    expect(desktopBackup.readText).toHaveBeenCalledWith("study-journal-backup-owner-a", "manifest.json");
    expect(desktopBackup.deleteFile).toHaveBeenCalledWith("study-journal-backup-owner-a", "manifest.json");
  });
});
