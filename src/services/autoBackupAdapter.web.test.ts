import { beforeEach, describe, expect, it, vi } from "vitest";

import type { StorageAdapter, StorageSnapshot } from "../types";

/**
 * The Web adapter is the only channel that overwrites a single `study-journal-latest.zip`.
 *
 * The File System Access API gives us a swap-file semantics through `createWritable()`, so an
 * interrupted write cannot destroy the previous file. What it does *not* give us is proof that the
 * file we read back is the file we meant to write — a provider that truncates on `close()` would
 * otherwise be reported as a successful, verified backup. These tests pin the read-back contract.
 */

const zipBytes = { size: 3 };
let readBackSize: number | undefined;
let writtenBlobSize: number | undefined;
let createWritableCalled = false;
let writes: Blob[] = [];

vi.mock("./nativeAutoBackup", () => ({
  bindNativeAutoBackupFolder: vi.fn(async () => ({ folderName: "native" })),
  canUseNativeAutoBackup: vi.fn(() => false),
  getNativeAutoBackupStatus: vi.fn(async () => ({ bound: false })),
}));

vi.mock("./nativeRepositoryBackupService", () => ({
  createNativeRepository: vi.fn(),
  writeNativeRepositoryBackup: vi.fn(),
}));

vi.mock("./backup", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./backup")>();
  return {
    ...actual,
    snapshotToZip: vi.fn(async () => new Blob([new Uint8Array(zipBytes.size)], { type: "application/zip" })),
  };
});

const stamp = "2026-06-21T00:00:00.000Z";

const snapshot = (): StorageSnapshot => ({
  payload: {
    manifest: {
      format: "study-journal",
      version: 4,
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
      schemaVersion: 4,
    },
  },
  assets: [],
});

const makeStore = (): StorageAdapter =>
  ({
    createSnapshot: vi.fn(async () => snapshot()),
    createStreamableSnapshot: vi.fn(async () => ({ payload: snapshot().payload, assets: [], recordDrafts: [] })),
    getAsset: vi.fn(async () => undefined),
  } as unknown as StorageAdapter);

/**
 * Minimal stand-in for a `FileSystemDirectoryHandle` whose `getFile()` answer is driven by the test,
 * so truncation, empty files and honest files can each be produced on demand.
 */
const createWebDirectoryHandle = () => {
  const name = "web-backup";
  const handle: Record<string, unknown> = {
    name,
    getDirectoryHandle: vi.fn(async () => handle),
    getFileHandle: vi.fn(async (fileName: string) => {
      const stored = { size: 0 };
      return {
        name: fileName,
        createWritable: vi.fn(async () => {
          createWritableCalled = true;
          return {
            write: vi.fn(async (blob: Blob) => {
              writes.push(blob);
              writtenBlobSize = blob.size;
              stored.size = blob.size;
            }),
            close: vi.fn(async () => undefined),
          };
        }),
        getFile: vi.fn(async () => ({
          name: fileName,
          // `readBackSize` is what the provider claims is on disk; `undefined` means "honest".
          size: readBackSize ?? stored.size,
          lastModified: 1_700_000_000_000,
        })),
      };
    }),
  };
  return handle;
};

const loadAdapter = async () => {
  vi.resetModules();
  const adapter = await import("./autoBackupAdapter");
  return adapter.autoBackupAdapter;
};

describe("autoBackupAdapter web destination", () => {
  beforeEach(() => {
    readBackSize = undefined;
    writtenBlobSize = undefined;
    createWritableCalled = false;
    writes = [];
    vi.stubGlobal("window", {
      showDirectoryPicker: vi.fn(async () => createWebDirectoryHandle()),
    });
  });

  it("W1 reports a read-back verified write when the destination returns the written byte count", async () => {
    const adapter = await loadAdapter();
    await adapter.bindFolder();

    const result = await adapter.writeLatest(makeStore());

    expect(createWritableCalled).toBe(true);
    expect(writtenBlobSize).toBe(zipBytes.size);
    expect(result.size).toBe(zipBytes.size);
    expect(result.displayName).toBe("study-journal-latest.zip");
    expect(result.verifiedAt).toBeTypeOf("number");
    expect(result.verification).toBe("destination-readback");
  });

  it("W2 refuses to report success when the destination read-back size differs from the bytes written", async () => {
    readBackSize = zipBytes.size - 1;
    const adapter = await loadAdapter();
    await adapter.bindFolder();

    await expect(adapter.writeLatest(makeStore())).rejects.toThrow(/写入后核对失败/);
  });

  it("W3 refuses to report success when the destination reports an empty file", async () => {
    readBackSize = 0;
    const adapter = await loadAdapter();
    await adapter.bindFolder();

    await expect(adapter.writeLatest(makeStore())).rejects.toThrow(/写入后核对失败/);
  });

  it("W4 does not claim a backup exists when the folder was only bound", async () => {
    const adapter = await loadAdapter();
    const writeSpy = vi.spyOn(adapter, "writeLatest");

    const before = await adapter.isBound();
    await adapter.bindFolder();
    const after = await adapter.isBound();

    expect(before).toEqual({ bound: false, folderName: undefined });
    expect(after).toEqual({ bound: true, folderName: "web-backup" });
    expect(writeSpy).not.toHaveBeenCalled();
  });
});
