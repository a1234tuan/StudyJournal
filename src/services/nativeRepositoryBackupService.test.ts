import { createKnowledgeEnvelope } from "../features/knowledgeLibrary/backup";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { Asset, StorageAdapter, StreamableBackupSnapshot } from "../types";
import {
  restoreNativeRepositoryBackup,
  writeNativeRepositoryBackupSnapshot,
} from "./nativeRepositoryBackupService";
import { BackupArchiveIntegrityError } from "./backup";
import { hashBlob } from "./cloudSyncModel";
import {
  beginNativeBackupRepositoryFileWrite,
  deleteNativeBackupRepositoryFile,
  ensureNativeBackupRepository,
  finishNativeBackupRepositoryFileWrite,
  readNativeBackupRepositoryTextFile,
} from "./nativeAutoBackup";

/**
 * Injection point for the provider's write step.
 *
 * Tests need to be able to say "the provider reported success but stored different bytes" without
 * swapping mock implementations: a swapped implementation leaks into the next test and makes the
 * result order-dependent (which it did, and which hid a real failure).
 */
const repoWrite = vi.hoisted(() => ({
  snapshotWrites: [] as string[],
  rewriteSnapshot: undefined as undefined | ((path: string, text: string) => string | undefined),
}));

vi.mock("./nativeAutoBackup", () => {
  const files = new Map<string, { data: Uint8Array; lastModified: number }>();
  const sessions = new Map<string, { path: string; chunks: Uint8Array[] }>();
  let sessionIndex = 0;

  const decode = (base64: string) => Uint8Array.from(atob(base64), (char) => char.charCodeAt(0));
  const encode = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));
  const text = (bytes: Uint8Array) => new TextDecoder().decode(bytes);

  return {
    __repositoryFiles: files,
    __repositorySessions: sessions,
    canUseNativeAutoBackup: vi.fn(() => true),
    ensureNativeBackupRepository: vi.fn(async () => ({ folderName: "backup", repositoryName: "study-journal-backup" })),
    listNativeBackupRepositoryFiles: vi.fn(async (_repositoryName: string, directory: string) => {
      const normalizedDirectory = directory ? `${directory}/` : "";
      return Array.from(files.entries())
        .filter(([path]) => {
          if (!normalizedDirectory) {
            return !path.includes("/");
          }
          return path.startsWith(normalizedDirectory) && !path.slice(normalizedDirectory.length).includes("/");
        })
        .map(([path, file]) => ({
          path,
          displayName: path.split("/").pop() ?? path,
          size: file.data.byteLength,
          lastModified: file.lastModified,
        }));
    }),
    beginNativeBackupRepositoryFileWrite: vi.fn(async (_repositoryName: string, path: string) => {
      const sessionId = `s${sessionIndex += 1}`;
      sessions.set(sessionId, { path, chunks: [] });
      return { sessionId, path };
    }),
    appendNativeBackupRepositoryFileWrite: vi.fn(async (sessionId: string, data: string) => {
      const session = sessions.get(sessionId);
      if (!session) {
        throw new Error("missing session");
      }
      session.chunks.push(decode(data));
      const size = session.chunks.reduce((total, chunk) => total + chunk.byteLength, 0);
      return { size };
    }),
    finishNativeBackupRepositoryFileWrite: vi.fn(async (sessionId: string) => {
      const session = sessions.get(sessionId);
      if (!session) {
        throw new Error("missing session");
      }
      const size = session.chunks.reduce((total, chunk) => total + chunk.byteLength, 0);
      const data = new Uint8Array(size);
      let offset = 0;
      for (const chunk of session.chunks) {
        data.set(chunk, offset);
        offset += chunk.byteLength;
      }
      let stored = data;
      if (session.path.startsWith("snapshots/")) {
        repoWrite.snapshotWrites.push(session.path);
        const rewritten = repoWrite.rewriteSnapshot?.(session.path, text(data));
        if (rewritten !== undefined) stored = new TextEncoder().encode(rewritten);
      }
      const lastModified = Date.now();
      files.set(session.path, { data: stored, lastModified });
      sessions.delete(sessionId);
      return {
        path: session.path,
        displayName: session.path.split("/").pop() ?? session.path,
        // The provider's own report stays independent of what it actually kept, which is exactly
        // the situation the writer has to defend against with a read-back.
        size,
        lastModified,
      };
    }),
    cancelNativeBackupRepositoryFileWrite: vi.fn(async (sessionId: string) => {
      sessions.delete(sessionId);
    }),
    readNativeBackupRepositoryTextFile: vi.fn(async (_repositoryName: string, path: string) => {
      const file = files.get(path);
      if (!file) {
        throw new Error(`missing ${path}`);
      }
      return { text: text(file.data), size: file.data.byteLength };
    }),
    readNativeBackupRepositoryFileChunk: vi.fn(async (_repositoryName: string, path: string, offset: number, length: number) => {
      const file = files.get(path);
      if (!file) {
        throw new Error(`missing ${path}`);
      }
      const data = file.data.slice(offset, offset + length);
      return {
        data: encode(data),
        bytesRead: data.byteLength,
        done: offset + data.byteLength >= file.data.byteLength,
      };
    }),
    deleteNativeBackupRepositoryFile: vi.fn(async (_repositoryName: string, path: string) => {
      files.delete(path);
    }),
  };
});

const nativeMock = await import("./nativeAutoBackup") as typeof import("./nativeAutoBackup") & {
  __repositoryFiles: Map<string, { data: Uint8Array; lastModified: number }>;
  __repositorySessions: Map<string, { path: string; chunks: Uint8Array[] }>;
};
const stamp = "2026-06-21T00:00:00.000Z";

const snapshot = (assetIds: string[] = ["asset-1"]): StreamableBackupSnapshot => ({
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
        assets: assetIds.length,
        tags: 0,
        reviews: 0,
        studySessions: 0,
      },
    },
    entries: [
      {
        id: "entry-1",
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
        id: "record-1",
        createdAt: stamp,
        updatedAt: stamp,
        type: "record",
        date: "2026-06-21",
        order: 0,
        subject: "数学",
        tags: [],
        title: "测试记录",
        contentHtml: "<p>内容</p>",
        assets: assetIds.map((id) => ({ id, title: id, kind: "image" as const })),
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
      subjects: [],
      schemaVersion: 4,
    },
  },
  assets: assetIds.map((id) => ({
    id,
    createdAt: stamp,
    updatedAt: stamp,
    fileName: `${id}.png`,
    mimeType: "image/png",
    size: 3,
    kind: "image" as const,
  })),
  recordDrafts: [],
});

const emptySnapshot = (): StreamableBackupSnapshot => {
  const base = snapshot([]);
  return {
    ...base,
    payload: {
      ...base.payload,
      manifest: {
        ...base.payload.manifest,
        counts: { entries: 0, blocks: 0, mistakes: 0, assets: 0, tags: 0, reviews: 0, studySessions: 0 },
      },
      entries: [],
      blocks: [],
    },
    assets: [],
  };
};

const asset = (id: string): Asset => ({
  id,
  createdAt: stamp,
  updatedAt: stamp,
  fileName: `${id}.png`,
  mimeType: "image/png",
  size: 3,
  kind: "image",
  data: new Blob([new Uint8Array([1, 2, 3])], { type: "image/png" }),
});

/** Same metadata and same byte length as `asset`, but different content. */
const assetWithBytes = (id: string, bytes: number[]): Asset => ({
  ...asset(id),
  data: new Blob([new Uint8Array(bytes)], { type: "image/png" }),
});

const readRepositoryJson = (path: string) =>
  JSON.parse(new TextDecoder().decode(nativeMock.__repositoryFiles.get(path)!.data));

const latestSnapshot = () => {
  const manifest = readRepositoryJson("manifest.json") as { latestSnapshotId: string };
  return readRepositoryJson(`snapshots/${manifest.latestSnapshotId}.json`);
};

/** The path a snapshot actually points at for an asset (a content generation since phase 4b). */
const assetPathIn = (snapshotId: string, assetId: string): string =>
  (readRepositoryJson(`snapshots/${snapshotId}.json`) as { assetPaths: Record<string, string> })
    .assetPaths[assetId];

const latestSnapshotId = (): string =>
  (readRepositoryJson("manifest.json") as { latestSnapshotId: string }).latestSnapshotId;

const nextMillisecond = () => new Promise((resolve) => setTimeout(resolve, 2));

const ASSET_PATH = "assets/asset-1-asset-1.png";

const writeRepositoryFile = (path: string, bytes: Uint8Array) => {
  nativeMock.__repositoryFiles.set(path, { data: bytes, lastModified: Date.now() });
};

const restoreStore = () =>
  ({ restoreStreamableSnapshot: vi.fn(async () => undefined) } as unknown as StorageAdapter);

const importableLegacySnapshot = (): string =>
  JSON.stringify({
    format: "study-journal-folder-snapshot",
    version: 1,
    exportedAt: stamp,
    payload: snapshot().payload,
    assets: snapshot().assets,
    assetPaths: { "asset-1": ASSET_PATH },
  });

describe("native repository backup service", () => {
  it("round-trips a v7 empty knowledge library without falling back to an older nonempty snapshot", async () => {
    await writeNativeRepositoryBackupSnapshot(snapshot(), async id => asset(id));
    await nextMillisecond();
    const versioned = emptySnapshot();
    versioned.payload.manifest.version = 7;
    versioned.payload.knowledge = createKnowledgeEnvelope([]);
    const written = await writeNativeRepositoryBackupSnapshot(versioned, async () => undefined);
    const file = JSON.parse((await readNativeBackupRepositoryTextFile("study-journal-backup", "snapshots/" + written.snapshotId + ".json")).text);
    expect(file.container.version).toBe(7);
    expect(file.payload.knowledge).toEqual(versioned.payload.knowledge);
    const store = { restoreStreamableSnapshot: vi.fn(async () => undefined) } as unknown as StorageAdapter;
    await restoreNativeRepositoryBackup(store);
    const restored = vi.mocked(store.restoreStreamableSnapshot).mock.calls[0][0];
    expect(restored.payload.blocks).toHaveLength(0);
    expect(restored.payload.knowledge).toEqual(versioned.payload.knowledge);
  });
  beforeEach(() => {
    nativeMock.__repositoryFiles.clear();
    nativeMock.__repositorySessions.clear();
    repoWrite.snapshotWrites.length = 0;
    repoWrite.rewriteSnapshot = undefined;
    vi.clearAllMocks();
  });

  it("writes assets, snapshot and manifest on first sync", async () => {
    const result = await writeNativeRepositoryBackupSnapshot(snapshot(), async (id) => asset(id));

    expect(result.format).toBe("folder-repository-v1");
    expect(result.assetCount).toBe(1);
    expect(nativeMock.__repositoryFiles.has(assetPathIn(result.snapshotId, "asset-1"))).toBe(true);
    expect(Array.from(nativeMock.__repositoryFiles.keys()).some((path) => path.startsWith("snapshots/"))).toBe(true);
    expect(nativeMock.__repositoryFiles.has("manifest.json")).toBe(true);
  });

  it("skips unchanged assets on the second sync and only writes metadata", async () => {
    await writeNativeRepositoryBackupSnapshot(snapshot(), async (id) => asset(id));
    vi.mocked(beginNativeBackupRepositoryFileWrite).mockClear();

    await writeNativeRepositoryBackupSnapshot(snapshot(), async (id) => asset(id));

    const writtenPaths = vi.mocked(beginNativeBackupRepositoryFileWrite).mock.calls.map((call) => call[1]);
    expect(writtenPaths.some((path) => path.startsWith("assets/"))).toBe(false);
    expect(writtenPaths.some((path) => path.startsWith("snapshots/"))).toBe(true);
    expect(writtenPaths).toContain("manifest.json");
  });

  it("rejects restore before overwriting local data when an asset is missing", async () => {
    const written = await writeNativeRepositoryBackupSnapshot(snapshot(), async (id) => asset(id));
    nativeMock.__repositoryFiles.delete(assetPathIn(written.snapshotId, "asset-1"));
    const store = {
      restoreStreamableSnapshot: vi.fn(async () => undefined),
    } as unknown as StorageAdapter;

    await expect(restoreNativeRepositoryBackup(store)).rejects.toThrow("缺少资源文件");

    expect(store.restoreStreamableSnapshot).not.toHaveBeenCalled();
  });

  it("does not create or initialize a repository before restore", async () => {
    await writeNativeRepositoryBackupSnapshot(snapshot(), async (id) => asset(id));
    vi.mocked(ensureNativeBackupRepository).mockClear();
    const store = {
      restoreStreamableSnapshot: vi.fn(async () => undefined),
    } as unknown as StorageAdapter;

    await restoreNativeRepositoryBackup(store);

    expect(ensureNativeBackupRepository).not.toHaveBeenCalled();
  });

  it("falls back to scanning snapshots when manifest is broken", async () => {
    await writeNativeRepositoryBackupSnapshot(snapshot(), async (id) => asset(id));
    nativeMock.__repositoryFiles.set("manifest.json", {
      data: new TextEncoder().encode("{bad json"),
      lastModified: Date.now(),
    });
    const store = {
      restoreStreamableSnapshot: vi.fn(async () => undefined),
    } as unknown as StorageAdapter;

    const summary = await restoreNativeRepositoryBackup(store);

    expect(summary.records).toBe(1);
    expect(store.restoreStreamableSnapshot).toHaveBeenCalledTimes(1);
  });

  it("restores the newest non-empty snapshot when the manifest latest snapshot is empty", async () => {
    const nonEmpty = await writeNativeRepositoryBackupSnapshot(snapshot(), async (id) => asset(id));
    await nextMillisecond();
    const empty = await writeNativeRepositoryBackupSnapshot(emptySnapshot(), async () => undefined);
    const store = {
      restoreStreamableSnapshot: vi.fn(async () => undefined),
    } as unknown as StorageAdapter;

    const summary = await restoreNativeRepositoryBackup(store);

    expect(empty.snapshotId).not.toBe(nonEmpty.snapshotId);
    expect(summary.records).toBe(1);
    expect(summary.assets).toBe(1);
    expect(store.restoreStreamableSnapshot).toHaveBeenCalledTimes(1);
    const restored = vi.mocked(store.restoreStreamableSnapshot).mock.calls[0][0];
    expect(restored.payload.blocks).toHaveLength(1);
  });

  it("rejects an all-empty repository instead of reporting a successful restore with zeros", async () => {
    await writeNativeRepositoryBackupSnapshot(emptySnapshot(), async () => undefined);
    const store = {
      restoreStreamableSnapshot: vi.fn(async () => undefined),
    } as unknown as StorageAdapter;

    await expect(restoreNativeRepositoryBackup(store)).rejects.toThrow("没有可恢复的数据");

    expect(store.restoreStreamableSnapshot).not.toHaveBeenCalled();
  });

  it("skips an empty newer snapshot when scanning after a broken manifest", async () => {
    await writeNativeRepositoryBackupSnapshot(snapshot(), async (id) => asset(id));
    await nextMillisecond();
    await writeNativeRepositoryBackupSnapshot(emptySnapshot(), async () => undefined);
    nativeMock.__repositoryFiles.set("manifest.json", {
      data: new TextEncoder().encode("{bad json"),
      lastModified: Date.now() + 10,
    });
    const store = {
      restoreStreamableSnapshot: vi.fn(async () => undefined),
    } as unknown as StorageAdapter;

    const summary = await restoreNativeRepositoryBackup(store);

    expect(summary.records).toBe(1);
    expect(summary.assets).toBe(1);
  });

  it("does not delete assets referenced by retained snapshots during cleanup", async () => {
    const first = await writeNativeRepositoryBackupSnapshot(snapshot(["asset-1"]), async (id) => asset(id));
    await nextMillisecond();
    await writeNativeRepositoryBackupSnapshot(snapshot(["asset-1", "asset-2"]), async (id) => asset(id));

    const firstAssetPath = assetPathIn(first.snapshotId, "asset-1");
    const secondAssetPath = assetPathIn(latestSnapshotId(), "asset-2");
    expect(nativeMock.__repositoryFiles.has(firstAssetPath)).toBe(true);
    expect(nativeMock.__repositoryFiles.has(secondAssetPath)).toBe(true);
    expect(deleteNativeBackupRepositoryFile).not.toHaveBeenCalledWith("study-journal-backup", firstAssetPath);
  });

  it("stores a readable manifest with the latest snapshot id", async () => {
    const result = await writeNativeRepositoryBackupSnapshot(snapshot(), async (id) => asset(id));

    const manifest = JSON.parse((await readNativeBackupRepositoryTextFile("study-journal-backup", "manifest.json")).text);

    expect(manifest.latestSnapshotId).toBe(result.snapshotId);
    expect(manifest.snapshots[0].path).toBe(`snapshots/${result.snapshotId}.json`);
  });

  describe("phase 3 archive asset integrity", () => {
    it("R3-01 refuses to update the repository when a referenced asset is missing locally", async () => {
      await expect(writeNativeRepositoryBackupSnapshot(snapshot(), async () => undefined))
        .rejects.toBeInstanceOf(BackupArchiveIntegrityError);

      // The failure happens while packing assets, i.e. before the snapshot and manifest are
      // written, so a failed backup can never leave a repository that looks complete.
      expect(nativeMock.__repositoryFiles.has("manifest.json")).toBe(false);
      expect(Array.from(nativeMock.__repositoryFiles.keys()).some((path) => path.startsWith("snapshots/"))).toBe(false);
      expect(Array.from(nativeMock.__repositoryFiles.keys())).toHaveLength(0);
    });

    it("R3-02 declares asset bytes so a freshly written snapshot restores with zero unverified assets", async () => {
      await writeNativeRepositoryBackupSnapshot(snapshot(), async (id) => asset(id));
      const store = restoreStore();

      const summary = await restoreNativeRepositoryBackup(store);

      expect(summary.assets).toBe(1);
      expect(summary.unverifiedAssets).toBe(0);
      const restored = vi.mocked(store.restoreStreamableSnapshot).mock.calls[0][0];
      expect(restored.payload.assetChecksums).toEqual([
        { id: "asset-1", hash: await hashBlob(asset("asset-1").data), size: 3 },
      ]);
    });

    it("R3-03 rejects tampered asset bytes of the same size before the destructive transaction", async () => {
      const written = await writeNativeRepositoryBackupSnapshot(snapshot(), async (id) => asset(id));
      // Same length, different content: only the declared hash can catch this.
      writeRepositoryFile(assetPathIn(written.snapshotId, "asset-1"), new Uint8Array([9, 9, 9]));
      const store = restoreStore();

      await expect(restoreNativeRepositoryBackup(store)).rejects.toBeInstanceOf(BackupArchiveIntegrityError);
      await expect(restoreNativeRepositoryBackup(restoreStore())).rejects.toThrow(/字节内容与声明不一致/);

      expect(store.restoreStreamableSnapshot).not.toHaveBeenCalled();
    });

    it("R3-04 rejects a malformed declaration list instead of importing on trust", async () => {
      const parsed = JSON.parse(importableLegacySnapshot()) as Record<string, unknown>;
      parsed.payload = { ...(parsed.payload as Record<string, unknown>), assetChecksums: "not-an-array" };
      writeRepositoryFile("snapshots/legacy.json", new TextEncoder().encode(JSON.stringify(parsed)));
      writeRepositoryFile(ASSET_PATH, new Uint8Array([1, 2, 3]));
      const store = restoreStore();

      await expect(restoreNativeRepositoryBackup(store)).rejects.toBeInstanceOf(BackupArchiveIntegrityError);

      expect(store.restoreStreamableSnapshot).not.toHaveBeenCalled();
    });

    it("R3-05 imports a legacy repository snapshot but reports its assets as unverified", async () => {
      writeRepositoryFile("snapshots/legacy.json", new TextEncoder().encode(importableLegacySnapshot()));
      writeRepositoryFile(ASSET_PATH, new Uint8Array([1, 2, 3]));
      const store = restoreStore();

      const summary = await restoreNativeRepositoryBackup(store);

      expect(summary.records).toBe(1);
      expect(summary.assets).toBe(1);
      expect(summary.unverifiedAssets).toBe(1);
      expect(store.restoreStreamableSnapshot).toHaveBeenCalledTimes(1);
      const restored = vi.mocked(store.restoreStreamableSnapshot).mock.calls[0][0];
      expect(restored.payload.assetChecksums).toBeUndefined();
    });
  });

  describe("phase 4 write verification and last-known-good", () => {
    const manifestText = () => {
      const file = nativeMock.__repositoryFiles.get("manifest.json");
      return file ? new TextDecoder().decode(file.data) : "";
    };

    it("R4-01 reads the snapshot back and reports archive-level verification", async () => {
      const result = await writeNativeRepositoryBackupSnapshot(snapshot(), async (id) => asset(id));

      expect(result.verification).toBe("archive-verified");
      expect(result.snapshotId).toBeTruthy();
    });

    it("R4-02 refuses to promote a snapshot whose bytes cannot be read back, keeping the previous one latest", async () => {
      const first = await writeNativeRepositoryBackupSnapshot(snapshot(), async (id) => asset(id));
      await nextMillisecond();
      const manifestBefore = manifestText();
      const firstSnapshotPath = `snapshots/${first.snapshotId}.json`;

      // Damage only the *new* snapshot, so the previous one stays a valid last-known-good.
      repoWrite.rewriteSnapshot = () => (repoWrite.snapshotWrites.length >= 2 ? '{"format":"study-journal-folder-snapshot","payload":{' : undefined);

      await expect(writeNativeRepositoryBackupSnapshot(snapshot(), async (id) => asset(id)))
        .rejects.toThrow(/回读/);

      // The manifest is the promotion step: it must still point at the last verified snapshot.
      expect(manifestText()).toBe(manifestBefore);
      expect(JSON.parse(manifestText()).latestSnapshotId).toBe(first.snapshotId);
      expect(nativeMock.__repositoryFiles.has(firstSnapshotPath)).toBe(true);
      const store = restoreStore();
      expect((await restoreNativeRepositoryBackup(store)).records).toBe(1);
      expect(store.restoreStreamableSnapshot).toHaveBeenCalledTimes(1);
    });

    it("R4-03 rejects a snapshot whose container checksum does not match its own payload", async () => {
      repoWrite.rewriteSnapshot = (_path, fileText) => {
        const parsed = JSON.parse(fileText) as { payload: { manifest: Record<string, unknown> } };
        // Keep the container, change the payload it is supposed to cover.
        parsed.payload.manifest = { ...parsed.payload.manifest, exportedAt: "2099-01-01T00:00:00.000Z" };
        return JSON.stringify(parsed);
      };

      const versioned = snapshot();
      versioned.payload.manifest.version = 7;
      versioned.payload.knowledge = createKnowledgeEnvelope([]);

      await expect(writeNativeRepositoryBackupSnapshot(versioned, async (id) => asset(id)))
        .rejects.toThrow(/回读/);

      expect(nativeMock.__repositoryFiles.has("manifest.json")).toBe(false);
    });
  });

  describe("phase 4b content-addressed asset generations", () => {
    it("R5-01 stores a same-size content change at a new path and keeps the old snapshot's bytes intact", async () => {
      const first = await writeNativeRepositoryBackupSnapshot(snapshot(), async (id) => assetWithBytes(id, [1, 2, 3]));
      const firstSnapshot = readRepositoryJson(`snapshots/${first.snapshotId}.json`) as {
        assetPaths: Record<string, string>;
        payload: { assetChecksums: Array<{ id: string; hash: string; size: number }> };
      };
      const firstAssetPath = firstSnapshot.assetPaths["asset-1"];
      const firstBytes = nativeMock.__repositoryFiles.get(firstAssetPath)!.data;
      await nextMillisecond();

      await writeNativeRepositoryBackupSnapshot(snapshot(), async (id) => assetWithBytes(id, [9, 8, 7]));
      const secondSnapshot = latestSnapshot() as {
        assetPaths: Record<string, string>;
        payload: { assetChecksums: Array<{ id: string; hash: string; size: number }> };
      };

      // A same-length edit must not reuse the old file, or the old snapshot would silently start
      // serving the new bytes.
      expect(secondSnapshot.assetPaths["asset-1"]).not.toBe(firstAssetPath);
      expect(Array.from(nativeMock.__repositoryFiles.get(firstAssetPath)!.data)).toEqual(Array.from(firstBytes));
      // The old snapshot's declaration still describes the file it points at, so it stays restorable.
      expect(firstSnapshot.payload.assetChecksums).toEqual([
        { id: "asset-1", hash: await hashBlob(new Blob([new Uint8Array(firstBytes)])), size: 3 },
      ]);
      expect(secondSnapshot.payload.assetChecksums).toEqual([
        { id: "asset-1", hash: await hashBlob(assetWithBytes("asset-1", [9, 8, 7]).data), size: 3 },
      ]);
    });

    it("R5-02 does not rewrite an asset whose content is unchanged", async () => {
      await writeNativeRepositoryBackupSnapshot(snapshot(), async (id) => assetWithBytes(id, [1, 2, 3]));
      vi.mocked(beginNativeBackupRepositoryFileWrite).mockClear();

      await writeNativeRepositoryBackupSnapshot(snapshot(), async (id) => assetWithBytes(id, [1, 2, 3]));

      const writtenPaths = vi.mocked(beginNativeBackupRepositoryFileWrite).mock.calls.map((call) => call[1]);
      expect(writtenPaths.some((path) => path.startsWith("assets/"))).toBe(false);
      expect(writtenPaths.some((path) => path.startsWith("snapshots/"))).toBe(true);
    });

    it("R5-03 keeps the previously verified copy when the local bytes are gone", async () => {
      await writeNativeRepositoryBackupSnapshot(snapshot(), async (id) => assetWithBytes(id, [1, 2, 3]));
      await nextMillisecond();

      const second = await writeNativeRepositoryBackupSnapshot(snapshot(), async () => undefined);
      const secondSnapshot = readRepositoryJson(`snapshots/${second.snapshotId}.json`) as {
        assetPaths: Record<string, string>;
        payload: { assetChecksums: Array<{ id: string; hash: string; size: number }> };
      };

      expect(secondSnapshot.payload.assetChecksums).toEqual([
        { id: "asset-1", hash: await hashBlob(new Blob([new Uint8Array([1, 2, 3])])), size: 3 },
      ]);
      const store = restoreStore();
      const summary = await restoreNativeRepositoryBackup(store);
      expect(summary.assets).toBe(1);
      expect(summary.unverifiedAssets).toBe(0);
      expect(store.restoreStreamableSnapshot).toHaveBeenCalledTimes(1);
    });

    it("R5-04 refuses when the local bytes are gone and the previously verified copy was deleted too", async () => {
      const first = await writeNativeRepositoryBackupSnapshot(snapshot(), async (id) => assetWithBytes(id, [1, 2, 3]));
      const firstSnapshot = readRepositoryJson(`snapshots/${first.snapshotId}.json`) as {
        assetPaths: Record<string, string>;
      };
      nativeMock.__repositoryFiles.delete(firstSnapshot.assetPaths["asset-1"]);
      await nextMillisecond();

      await expect(writeNativeRepositoryBackupSnapshot(snapshot(), async () => undefined))
        .rejects.toBeInstanceOf(BackupArchiveIntegrityError);
    });
  });
});
