import { createKnowledgeEnvelope } from "../features/knowledgeLibrary/backup";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { Asset, StorageAdapter, StreamableBackupSnapshot } from "../types";
import {
  restoreNativeRepositoryBackup,
  writeNativeRepositoryBackupSnapshot,
} from "./nativeRepositoryBackupService";
import {
  beginNativeBackupRepositoryFileWrite,
  deleteNativeBackupRepositoryFile,
  ensureNativeBackupRepository,
  readNativeBackupRepositoryTextFile,
} from "./nativeAutoBackup";

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
      const lastModified = Date.now();
      files.set(session.path, { data, lastModified });
      sessions.delete(sessionId);
      return {
        path: session.path,
        displayName: session.path.split("/").pop() ?? session.path,
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

const nextMillisecond = () => new Promise((resolve) => setTimeout(resolve, 2));

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
    vi.clearAllMocks();
  });

  it("writes assets, snapshot and manifest on first sync", async () => {
    const result = await writeNativeRepositoryBackupSnapshot(snapshot(), async (id) => asset(id));

    expect(result.format).toBe("folder-repository-v1");
    expect(result.assetCount).toBe(1);
    expect(nativeMock.__repositoryFiles.has("assets/asset-1-asset-1.png")).toBe(true);
    expect(Array.from(nativeMock.__repositoryFiles.keys()).some((path) => path.startsWith("snapshots/"))).toBe(true);
    expect(nativeMock.__repositoryFiles.has("manifest.json")).toBe(true);
  });

  it("skips unchanged assets on the second sync and only writes metadata", async () => {
    await writeNativeRepositoryBackupSnapshot(snapshot(), async (id) => asset(id));
    vi.mocked(beginNativeBackupRepositoryFileWrite).mockClear();

    await writeNativeRepositoryBackupSnapshot(snapshot(), async (id) => asset(id));

    const writtenPaths = vi.mocked(beginNativeBackupRepositoryFileWrite).mock.calls.map((call) => call[1]);
    expect(writtenPaths).not.toContain("assets/asset-1-asset-1.png");
    expect(writtenPaths.some((path) => path.startsWith("snapshots/"))).toBe(true);
    expect(writtenPaths).toContain("manifest.json");
  });

  it("rejects restore before overwriting local data when an asset is missing", async () => {
    await writeNativeRepositoryBackupSnapshot(snapshot(), async (id) => asset(id));
    nativeMock.__repositoryFiles.delete("assets/asset-1-asset-1.png");
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
    await writeNativeRepositoryBackupSnapshot(snapshot(["asset-1"]), async (id) => asset(id));
    await writeNativeRepositoryBackupSnapshot(snapshot(["asset-1", "asset-2"]), async (id) => asset(id));

    expect(nativeMock.__repositoryFiles.has("assets/asset-1-asset-1.png")).toBe(true);
    expect(nativeMock.__repositoryFiles.has("assets/asset-2-asset-2.png")).toBe(true);
    expect(deleteNativeBackupRepositoryFile).not.toHaveBeenCalledWith("study-journal-backup", "assets/asset-1-asset-1.png");
  });

  it("stores a readable manifest with the latest snapshot id", async () => {
    const result = await writeNativeRepositoryBackupSnapshot(snapshot(), async (id) => asset(id));

    const manifest = JSON.parse((await readNativeBackupRepositoryTextFile("study-journal-backup", "manifest.json")).text);

    expect(manifest.latestSnapshotId).toBe(result.snapshotId);
    expect(manifest.snapshots[0].path).toBe(`snapshots/${result.snapshotId}.json`);
  });
});
