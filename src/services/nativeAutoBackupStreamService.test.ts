import { beforeEach, describe, expect, it, vi } from "vitest";
import { sha256 } from "@noble/hashes/sha256";
import { bytesToHex } from "@noble/hashes/utils";

import type { StreamableBackupSnapshot } from "../types";
import { BackupArchiveIntegrityError } from "./backup";
import {
  appendNativeAutoBackupZipEntry,
  beginNativeAutoBackupZipEntry,
  cancelNativeAutoBackupZip,
  finishNativeAutoBackupZip,
} from "./nativeAutoBackup";
import { writeNativeAutoBackupStreamSnapshot } from "./nativeAutoBackupStreamService";

vi.mock("./nativeAutoBackup", () => ({
  appendNativeAutoBackupZipEntry: vi.fn(),
  beginNativeAutoBackupZip: vi.fn(async () => ({ sessionId: "auto-1", folderName: "backup" })),
  beginNativeAutoBackupZipEntry: vi.fn(),
  cancelNativeAutoBackupZip: vi.fn(async () => undefined),
  canUseNativeAutoBackup: vi.fn(() => true),
  finishNativeAutoBackupZip: vi.fn(async () => ({ uri: "content://backup/latest.zip", folderName: "backup", size: 1 })),
  finishNativeAutoBackupZipEntry: vi.fn(),
}));

const decodeTextEntry = (data: string): string => decodeURIComponent(escape(atob(data)));

const stamp = "2026-06-21T00:00:00.000Z";

const snapshot: StreamableBackupSnapshot = {
  payload: {
    manifest: {
      format: "study-journal",
      version: 4,
      exportedAt: stamp,
      appVersion: "0.1.0",
      counts: {
        entries: 1,
        blocks: 1,
        mistakes: 0,
        assets: 0,
        tags: 0,
        reviews: 0,
        studySessions: 0,
      },
    },
    entries: [
      {
        id: "e1",
        createdAt: stamp,
        updatedAt: stamp,
        date: "2026-06-21",
        title: "2026-06-21",
        tags: [],
        pinned: false,
        favorite: false,
      },
    ],
    blocks: [
      {
        id: "r1",
        createdAt: stamp,
        updatedAt: stamp,
        type: "record",
        date: "2026-06-21",
        order: 0,
        subject: "数据结构",
        tags: [],
        title: "结构内容",
        contentHtml: "<p>正文内容</p>",
        assets: [],
        formulas: [],
        mistakeRefs: [],
      },
    ],
    recordDrafts: [],
    mistakes: [],
    tags: [],
    reviews: [],
    recordReviews: [],
    recordReviewLogs: [],
    recordReviewDayStats: [],
    studySessions: [],
    settings: {
      id: "settings",
      examDate: "2026-12-27",
      theme: "system",
      accentColor: "#2f6f5e",
      backupReminderDays: 7,
      fontScale: 1,
      lineHeight: 1.7,
      schemaVersion: 4,
    },
  },
  assets: [],
  recordDrafts: [],
};

const assetMeta = {
  id: "asset-1",
  createdAt: stamp,
  updatedAt: stamp,
  fileName: "asset-1.png",
  mimeType: "image/png",
  size: 3,
  kind: "image" as const,
};

const snapshotWithAsset = (): StreamableBackupSnapshot => ({
  ...snapshot,
  payload: {
    ...snapshot.payload,
    manifest: {
      ...snapshot.payload.manifest,
      counts: { ...snapshot.payload.manifest.counts, assets: 1 },
    },
  },
  assets: [assetMeta],
});

const assetBlob = () => new Blob([new Uint8Array([1, 2, 3])], { type: "image/png" });

const captureWrittenEntries = () => {
  const written = new Map<string, string>();
  let currentPath = "";
  vi.mocked(beginNativeAutoBackupZipEntry).mockImplementation(async (_sessionId, path) => {
    currentPath = path;
  });
  vi.mocked(appendNativeAutoBackupZipEntry).mockImplementation(async (_sessionId, data) => {
    written.set(currentPath, `${written.get(currentPath) ?? ""}${decodeTextEntry(data)}`);
  });
  return written;
};

describe("native auto backup stream", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("writes the full backup zip structure into the dedicated auto backup session", async () => {
    const writtenEntries = new Map<string, string>();
    let currentPath = "";
    vi.mocked(beginNativeAutoBackupZipEntry).mockImplementation(async (_sessionId, path) => {
      currentPath = path;
    });
    vi.mocked(appendNativeAutoBackupZipEntry).mockImplementation(async (_sessionId, data) => {
      writtenEntries.set(currentPath, `${writtenEntries.get(currentPath) ?? ""}${decodeTextEntry(data)}`);
    });

    const result = await writeNativeAutoBackupStreamSnapshot(snapshot, vi.fn());

    expect(result.size).toBe(1);
    expect(writtenEntries.get("manifest.json")).toContain("\"format\": \"study-journal\"");
    expect(writtenEntries.get("data.json")).toContain("\"assets\": []");
    expect(writtenEntries.get("entries/2026-06-21.md")).toContain("正文内容");
  });

  it("cancels the dedicated session when native finish returns an empty file", async () => {
    vi.mocked(finishNativeAutoBackupZip).mockResolvedValueOnce({
      uri: "content://backup/latest.zip",
      folderName: "backup",
      size: 0,
    });

    await expect(writeNativeAutoBackupStreamSnapshot(snapshot, vi.fn())).rejects.toThrow("自动备份写入结果为空");

    expect(cancelNativeAutoBackupZip).toHaveBeenCalledWith("auto-1");
  });

  it("AB-01 refuses to write the archive when a referenced asset is missing locally", async () => {
    const written = captureWrittenEntries();

    await expect(writeNativeAutoBackupStreamSnapshot(snapshotWithAsset(), async () => undefined))
      .rejects.toBeInstanceOf(BackupArchiveIntegrityError);

    // Assets are written before the manifest, so a failed pack can never leave a manifest that
    // advertises a resource the archive does not contain.
    expect(written.has("manifest.json")).toBe(false);
    expect(written.has("data.json")).toBe(false);
    expect(cancelNativeAutoBackupZip).toHaveBeenCalledWith("auto-1");
    expect(finishNativeAutoBackupZip).not.toHaveBeenCalled();
  });

  it("AB-02 declares the real bytes of every packed asset instead of trusting the metadata", async () => {
    const written = captureWrittenEntries();

    await writeNativeAutoBackupStreamSnapshot(
      snapshotWithAsset(),
      async (id) => ({ ...assetMeta, id, data: assetBlob() }),
    );

    expect(written.has("assets/asset-1-asset-1.png")).toBe(true);
    const declared = JSON.parse(written.get("data.json")!) as {
      assetChecksums: Array<{ id: string; hash: string; size: number }>;
    };
    expect(declared.assetChecksums).toEqual([
      { id: "asset-1", hash: bytesToHex(sha256(new Uint8Array([1, 2, 3]))), size: 3 },
    ]);
  });
});
