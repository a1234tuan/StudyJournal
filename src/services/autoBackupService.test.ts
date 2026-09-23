import { beforeEach, describe, expect, it, vi } from "vitest";

import type { AutoBackupSettings, StorageAdapter, StorageSnapshot } from "../types";
import type { AutoBackupAdapter, AutoBackupWriteResult } from "./autoBackupAdapter";
import {
  bindAutoBackupFolder,
  flushAutoBackupNow,
  markAutoBackupDirty,
  onAppBackgroundAutoBackup,
  setAutoBackupEnabled,
} from "./autoBackupService";

const stamp = "2026-06-21T00:00:00.000Z";

const autoBackupState = (
  enabled = true,
  patch: Partial<AutoBackupSettings> = {},
): AutoBackupSettings => ({
  enabled,
  folderName: "backup",
  debounceMs: 600_000,
  ...patch,
});

const snapshot: StorageSnapshot = {
  payload: {
    manifest: {
      format: "study-journal",
      version: 3,
      exportedAt: stamp,
      appVersion: "0.1.0",
      counts: { entries: 0, blocks: 0, mistakes: 0, assets: 0, tags: 0, reviews: 0, studySessions: 0 },
    },
    entries: [],
    blocks: [],
    mistakes: [],
    tags: [],
    reviews: [],
    studySessions: [],
    settings: {
      id: "settings",
      examDate: "2026-12-27",
      theme: "system",
      accentColor: "#2f6f5e",
      backupReminderDays: 7,
      fontScale: 1,
      lineHeight: 1.7,
      subjects: [],
      schemaVersion: 3,
    },
  },
  assets: [],
};

const makeStore = (initial = autoBackupState()): StorageAdapter => {
  let current = initial;
  return {
    initialize: vi.fn(),
    getSettings: vi.fn(async () => ({
      id: "settings",
      examDate: "2026-12-27",
      theme: "system" as const,
      accentColor: "#2f6f5e",
      backupReminderDays: 7,
      fontScale: 1,
      lineHeight: 1.7,
      subjects: [],
      schemaVersion: 3 as const,
    })),
    saveSettings: vi.fn(async () => undefined),
    getAutoBackupState: vi.fn(async () => current),
    saveAutoBackupState: vi.fn(async (next: AutoBackupSettings) => {
      current = next;
    }),
    getOrCreateEntry: vi.fn(),
    listEntries: vi.fn(),
    saveEntry: vi.fn(),
    listBlocks: vi.fn(),
    saveBlock: vi.fn(),
    deleteBlock: vi.fn(),
    reorderBlocks: vi.fn(),
    listMistakes: vi.fn(),
    saveMistake: vi.fn(),
    listDueMistakes: vi.fn(),
    listReviews: vi.fn(),
    saveReview: vi.fn(),
    listTags: vi.fn(),
    upsertTag: vi.fn(),
    listStudySessions: vi.fn(),
    saveStudySession: vi.fn(),
    saveAsset: vi.fn(),
    patchAsset: vi.fn(),
    listAssets: vi.fn(),
    getAsset: vi.fn(),
    createSnapshot: vi.fn(async () => snapshot),
    restoreSnapshot: vi.fn(),
    clearAll: vi.fn(),
  } as unknown as StorageAdapter;
};

const makeAdapter = (
  bound = true,
  writeResult: AutoBackupWriteResult = { folderName: "backup", size: 1234 },
): AutoBackupAdapter => ({
  isAvailable: vi.fn(() => true),
  bindFolder: vi.fn(async () => ({ folderName: "backup" })),
  isBound: vi.fn(async () => ({ bound, folderName: bound ? "backup" : undefined })),
  writeLatest: vi.fn(async () => writeResult),
});

describe("autoBackupService", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  it("debounces automatic writes during normal editing", async () => {
    const store = makeStore();
    const adapter = makeAdapter();

    await markAutoBackupDirty("record", adapter, store);
    await markAutoBackupDirty("asset", adapter, store);
    await vi.advanceTimersByTimeAsync(600_000);

    expect(adapter.writeLatest).toHaveBeenCalledTimes(1);
  });

  it("flushes dirty changes when the app goes to the background", async () => {
    const store = makeStore();
    const adapter = makeAdapter();

    await markAutoBackupDirty("record", adapter, store);
    await onAppBackgroundAutoBackup(adapter, store);

    expect(adapter.writeLatest).toHaveBeenCalledTimes(1);
  });

  it("manual flush writes immediately", async () => {
    const store = makeStore();
    const adapter = makeAdapter(true, {
      folderName: "backup",
      size: 1234,
      displayName: "study-journal-latest.zip",
      uri: "content://backup/latest",
      verifiedAt: new Date("2026-06-21T01:00:00.000Z").getTime(),
      lastModified: new Date("2026-06-21T00:59:00.000Z").getTime(),
    });

    const next = await flushAutoBackupNow("manual", adapter, store);

    expect(adapter.writeLatest).toHaveBeenCalledTimes(1);
    expect(next.lastBackupSize).toBe(1234);
    expect(next.lastBackupFileName).toBe("study-journal-latest.zip");
    expect(next.lastBackupUri).toBe("content://backup/latest");
    expect(next.lastBackupVerifiedAt).toBe("2026-06-21T01:00:00.000Z");
    expect(next.lastBackupFileModifiedAt).toBe("2026-06-21T00:59:00.000Z");
    expect(store.saveAutoBackupState).toHaveBeenCalledWith(expect.objectContaining({ lastBackupSize: 1234 }));
  });

  it("app-start flush writes once when automatic backup is enabled", async () => {
    const store = makeStore();
    const adapter = makeAdapter(true, { folderName: "backup", size: 4321 });

    const next = await flushAutoBackupNow("app-start", adapter, store);

    expect(adapter.writeLatest).toHaveBeenCalledTimes(1);
    expect(next.lastBackupSize).toBe(4321);
  });

  it("records the provider's actual file name and warning when native verification reports a renamed file", async () => {
    const store = makeStore();
    const adapter = makeAdapter(true, {
      folderName: "backup",
      size: 1234,
      displayName: "study-journal-latest (1).zip",
      warning: "系统文件提供器返回的实际文件名不是 study-journal-latest.zip，请在备份文件夹中查找：study-journal-latest (1).zip",
    });

    const next = await flushAutoBackupNow("manual", adapter, store);

    expect(next.lastBackupFileName).toBe("study-journal-latest (1).zip");
    expect(next.lastBackupWarning).toContain("study-journal-latest (1).zip");
    expect(next.lastError).toBeUndefined();
  });

  it("persists repository backup metadata from Android incremental sync", async () => {
    const store = makeStore();
    const adapter = makeAdapter(true, {
      folderName: "backup",
      size: 12_345,
      format: "folder-repository-v1",
      bytesWritten: 456,
      repositorySize: 12_345,
      assetCount: 7,
      snapshotId: "20260621T010000000Z",
      displayName: "study-journal-backup",
    });

    const next = await flushAutoBackupNow("manual", adapter, store);

    expect(next).toMatchObject({
      backupFormat: "folder-repository-v1",
      lastBackupSize: 12_345,
      lastBackupBytesWritten: 456,
      lastBackupRepositorySize: 12_345,
      lastBackupAssetCount: 7,
      lastBackupSnapshotId: "20260621T010000000Z",
      lastBackupFileName: "study-journal-backup",
      lastError: undefined,
    });
  });

  it("does not advance last backup time when the write result is empty", async () => {
    const previousBackupAt = "2026-06-20T00:00:00.000Z";
    const store = makeStore(autoBackupState(true, { lastBackupAt: previousBackupAt, lastBackupSize: 999 }));
    const adapter = makeAdapter(true, { folderName: "backup", size: 0 });

    const next = await flushAutoBackupNow("manual", adapter, store);

    expect(next.lastBackupAt).toBe(previousBackupAt);
    expect(next.lastBackupSize).toBe(999);
    expect(next.lastError).toBe("自动备份写入结果为空。");
  });

  it("waits for an in-flight flush instead of returning stale state", async () => {
    let resolveWrite: (value: AutoBackupWriteResult) => void = () => undefined;
    const writePromise = new Promise<AutoBackupWriteResult>((resolve) => {
      resolveWrite = resolve;
    });
    const store = makeStore();
    const adapter = makeAdapter();
    vi.mocked(adapter.writeLatest).mockImplementation(async () => writePromise);

    const first = flushAutoBackupNow("manual", adapter, store);
    const second = flushAutoBackupNow("manual", adapter, store);

    await Promise.resolve();
    await Promise.resolve();
    expect(adapter.writeLatest).toHaveBeenCalledTimes(1);

    resolveWrite({ folderName: "backup", size: 2222 });
    const [firstResult, secondResult] = await Promise.all([first, second]);

    expect(firstResult.lastBackupSize).toBe(2222);
    expect(secondResult.lastBackupSize).toBe(2222);
    expect(adapter.writeLatest).toHaveBeenCalledTimes(1);
  });

  it("does not write when folder is not bound and records an error", async () => {
    const store = makeStore();
    const adapter = makeAdapter(false);

    await flushAutoBackupNow("manual", adapter, store);

    expect(adapter.writeLatest).not.toHaveBeenCalled();
    expect(store.saveAutoBackupState).toHaveBeenCalledWith(expect.objectContaining({
      lastError: "尚未绑定自动备份文件夹。",
    }));
  });

  it("binds a folder without forcing automatic writes on for a fresh install", async () => {
    const store = makeStore(autoBackupState(false));
    const adapter = makeAdapter();

    const next = await bindAutoBackupFolder(adapter, store);

    expect(store.saveAutoBackupState).toHaveBeenCalledWith(expect.objectContaining({
      enabled: false,
      folderName: "backup",
    }));
    expect(next.enabled).toBe(false);
  });

  it("keeps automatic writes enabled when rebinding an already enabled folder", async () => {
    const store = makeStore(autoBackupState(true));
    const adapter = makeAdapter();

    const next = await bindAutoBackupFolder(adapter, store);

    expect(next.enabled).toBe(true);
    expect(next.folderName).toBe("backup");
  });

  it("rejects enabling when no adapter is available", async () => {
    const store = makeStore(autoBackupState(false));
    const adapter = { ...makeAdapter(), isAvailable: vi.fn(() => false) };

    await expect(setAutoBackupEnabled(true, adapter, store)).rejects.toThrow("不支持自动备份");
  });

  describe("verification status contract", () => {
    it("does not claim a verification time when the adapter verified nothing", async () => {
      const store = makeStore();
      const adapter = makeAdapter(true, { folderName: "backup", size: 1234 });

      const next = await flushAutoBackupNow("manual", adapter, store);

      expect(next.lastBackupAt).toBeTruthy();
      expect(next.lastBackupVerifiedAt).toBeUndefined();
      expect(next.lastBackupVerification).toBeUndefined();
    });

    it("records exactly the verification level the adapter proved", async () => {
      const store = makeStore();
      const adapter = makeAdapter(true, {
        folderName: "backup",
        size: 1234,
        verifiedAt: new Date("2026-06-21T01:00:00.000Z").getTime(),
        verification: "archive-verified",
      });

      const next = await flushAutoBackupNow("manual", adapter, store);

      expect(next.lastBackupVerification).toBe("archive-verified");
      expect(next.lastBackupVerifiedAt).toBe("2026-06-21T01:00:00.000Z");
    });

    it("does not report a backup at all when the folder was only bound", async () => {
      const store = makeStore(autoBackupState(false));
      const adapter = makeAdapter();

      const next = await bindAutoBackupFolder(adapter, store);

      expect(next.folderName).toBe("backup");
      expect(next.enabled).toBe(false);
      expect(next.lastBackupAt).toBeUndefined();
      expect(next.lastBackupVerifiedAt).toBeUndefined();
      expect(next.lastBackupVerification).toBeUndefined();
      expect(next.lastBackupSize).toBeUndefined();
    });

    it("keeps the previous verified status when a later write is interrupted", async () => {
      const store = makeStore(autoBackupState(true, {
        lastBackupAt: "2026-06-20T00:00:00.000Z",
        lastBackupSize: 999,
        lastBackupVerifiedAt: "2026-06-20T00:00:00.000Z",
        lastBackupVerification: "archive-verified",
      }));
      const adapter = makeAdapter(true, { folderName: "backup", size: 1234, verification: "archive-verified" });
      vi.mocked(adapter.writeLatest).mockRejectedValueOnce(new Error("写入过程中断。"));

      const next = await flushAutoBackupNow("manual", adapter, store);

      expect(next.lastBackupAt).toBe("2026-06-20T00:00:00.000Z");
      expect(next.lastBackupSize).toBe(999);
      expect(next.lastBackupVerifiedAt).toBe("2026-06-20T00:00:00.000Z");
      expect(next.lastBackupVerification).toBe("archive-verified");
      expect(next.lastError).toBe("写入过程中断。");
    });

    it("does not regress a verified status when a subsequent write fails", async () => {
      const store = makeStore();
      const adapter = makeAdapter(true, {
        folderName: "backup",
        size: 1234,
        verifiedAt: new Date("2026-06-21T01:00:00.000Z").getTime(),
        verification: "archive-verified",
      });
      const first = await flushAutoBackupNow("manual", adapter, store);
      expect(first.lastBackupVerifiedAt).toBe("2026-06-21T01:00:00.000Z");

      vi.mocked(adapter.writeLatest).mockRejectedValueOnce(new Error("写入过程中断。"));
      const next = await flushAutoBackupNow("manual", adapter, store);

      expect(next.lastBackupAt).toBe(first.lastBackupAt);
      expect(next.lastBackupVerifiedAt).toBe("2026-06-21T01:00:00.000Z");
      expect(next.lastBackupVerification).toBe("archive-verified");
      expect(next.lastError).toBe("写入过程中断。");
    });
  });
});