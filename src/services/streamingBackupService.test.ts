import { createKnowledgeEnvelope } from "../features/knowledgeLibrary/backup";
import { validateBackupContainer } from "../features/knowledgeLibrary/backupContainer";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { Asset, BackupAssetMeta, StorageAdapter, StreamableBackupSnapshot } from "../types";
import { hashBlob } from "./cloudSyncModel";
import { NativeZipArchive } from "./nativeZipArchive";
import { importNativeStreamableBackupAndRestore, writeNativeStreamableBackupSnapshot } from "./streamingBackupService";

vi.mock("./nativeZipArchive", () => ({
  canUseNativeZipArchive: () => true,
  NativeZipArchive: {
    beginExport: vi.fn(async () => ({ sessionId: "s1", uri: "file:///backup.zip" })),
    beginEntry: vi.fn(),
    appendEntry: vi.fn(),
    finishEntry: vi.fn(),
    finishExport: vi.fn(async () => ({ uri: "file:///backup.zip", size: 1 })),
    cancelExport: vi.fn(async () => undefined),
    beginImport: vi.fn(async () => ({ sessionId: "import-1", entries: ["data.json"] })),
    readEntry: vi.fn(),
    readEntryChunk: vi.fn(),
    finishImport: vi.fn(),
    cancelImport: vi.fn(async () => undefined),
  },
}));

const decodeTextEntry = (data: string): string => decodeURIComponent(escape(atob(data)));
const encodeTextEntry = (text: string): string => btoa(unescape(encodeURIComponent(text)));

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
        contentHtml: [
          "<p>正文内容</p>",
          '<record-comparison-table data-json=\'{"title":"链路表","columns":[{"id":"c1","label":"概念"},{"id":"c2","label":"作用"}],"rows":[{"id":"row1","cells":{"c1":"高亮块","c2":"写入 Markdown"}}]}\'></record-comparison-table>',
          '<record-highlight-block data-tone="yellow"><p>黄色重点</p></record-highlight-block>',
        ].join(""),
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

describe("streaming backup", () => {
  it("writes and validates the v7 container and imports an explicitly empty knowledge range", async () => {
    const versioned = structuredClone(snapshot);
    versioned.payload.manifest.version = 7;
    versioned.payload.knowledge = createKnowledgeEnvelope([]);
    const entries = new Map<string, string>();
    let path = "";
    vi.mocked(NativeZipArchive.beginEntry).mockImplementation(async entry => { path = entry.path; });
    vi.mocked(NativeZipArchive.appendEntry).mockImplementation(async entry => { entries.set(path, (entries.get(path) ?? "") + decodeTextEntry(entry.data)); });
    await writeNativeStreamableBackupSnapshot(versioned, "cache-share", vi.fn());
    expect(entries.has("data.json")).toBe(false);
    const payload = JSON.parse(entries.get("snapshot-v7.json")!);
    expect(() => validateBackupContainer(JSON.parse(entries.get("manifest.json")!), payload)).not.toThrow();
    vi.mocked(NativeZipArchive.beginImport).mockResolvedValueOnce({ sessionId: "v7", entries: [...entries.keys()] });
    vi.mocked(NativeZipArchive.readEntry).mockImplementation(async entry => ({ data: encodeTextEntry(entries.get(entry.path)!) }));
    const store = { restoreStreamableSnapshot: vi.fn(async () => undefined) } as unknown as StorageAdapter;
    await importNativeStreamableBackupAndRestore("content://v7.zip", store);
    expect(vi.mocked(store.restoreStreamableSnapshot).mock.calls[0][0].payload.knowledge).toEqual(versioned.payload.knowledge);
    entries.set("manifest.json", JSON.stringify({ ...JSON.parse(entries.get("manifest.json")!), checksum: "invalid" }));
    vi.mocked(NativeZipArchive.beginImport).mockResolvedValueOnce({ sessionId: "bad", entries: [...entries.keys()] });
    await expect(importNativeStreamableBackupAndRestore("content://bad.zip", store)).rejects.toThrow();
    expect(store.restoreStreamableSnapshot).toHaveBeenCalledTimes(1);
  });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("writes readable record body markdown into Android streamable entry files", async () => {
    const writtenEntries = new Map<string, string>();
    let currentPath = "";
    vi.mocked(NativeZipArchive.beginEntry).mockImplementation(async ({ path }) => {
      currentPath = path;
    });
    vi.mocked(NativeZipArchive.appendEntry).mockImplementation(async ({ data }) => {
      writtenEntries.set(currentPath, `${writtenEntries.get(currentPath) ?? ""}${decodeTextEntry(data)}`);
    });

    await writeNativeStreamableBackupSnapshot(snapshot, "cache-share", vi.fn());

    const markdown = writtenEntries.get("entries/2026-06-21.md");
    expect(markdown).toContain("正文内容");
    expect(markdown).toContain("| 概念 | 作用 |");
    expect(markdown).toContain("| 高亮块 | 写入 Markdown |");
    expect(markdown).toContain("> 浅黄色高亮");
    expect(markdown).toContain("> 黄色重点");
  });

  it("creates subject configs for unknown subjects during Android streamable import", async () => {
    const importedPayload = {
      ...snapshot.payload,
      blocks: [
        {
          ...snapshot.payload.blocks[0],
          subject: "物理",
          tags: [],
          title: "物理记录",
        },
      ],
      settings: {
        ...snapshot.payload.settings,
        subjects: [],
      },
      assets: [],
    };
    vi.mocked(NativeZipArchive.readEntry).mockResolvedValue({
      data: encodeTextEntry(JSON.stringify(importedPayload)),
    });
    const store = {
      restoreStreamableSnapshot: vi.fn(async () => undefined),
    } as unknown as StorageAdapter;

    await importNativeStreamableBackupAndRestore("content://backup.zip", store);

    const restoredSnapshot = vi.mocked(store.restoreStreamableSnapshot).mock.calls[0][0];
    expect(restoredSnapshot.payload.settings.subjects?.map((subject) => subject.name)).toContain("物理");
  });
});

const streamAsset = (id: string, bytes: string): BackupAssetMeta => ({
  id,
  createdAt: stamp,
  updatedAt: stamp,
  fileName: `${id}.png`,
  title: id,
  mimeType: "image/png",
  size: bytes.length,
  kind: "image",
});

const assetBlob = (meta: BackupAssetMeta, bytes: string): Asset =>
  ({ ...meta, data: new File([bytes], meta.fileName, { type: meta.mimeType }) });

/** Capture the entries a stream export writes so they can be replayed as an import. */
const captureExport = () => {
  const entries = new Map<string, string>();
  let path = "";
  vi.mocked(NativeZipArchive.beginEntry).mockImplementation(async entry => { path = entry.path; });
  vi.mocked(NativeZipArchive.appendEntry).mockImplementation(async entry => {
    entries.set(path, (entries.get(path) ?? "") + decodeTextEntry(entry.data));
  });
  return entries;
};

const replayImport = (entries: Map<string, string>, assetBytes: Map<string, string>) => {
  vi.mocked(NativeZipArchive.beginImport).mockResolvedValueOnce({ sessionId: "replay", entries: [...entries.keys()] });
  vi.mocked(NativeZipArchive.readEntry).mockImplementation(async entry => ({ data: encodeTextEntry(entries.get(entry.path)!) }));
  vi.mocked(NativeZipArchive.readEntryChunk).mockImplementation(async ({ path: entryPath }) => {
    const bytes = assetBytes.get(entryPath);
    if (bytes === undefined) throw new Error(`unexpected chunk read: ${entryPath}`);
    return { data: encodeTextEntry(bytes), bytesRead: bytes.length, done: true };
  });
};

describe("streaming backup asset integrity", () => {
  it("S3-01: the writer refuses to produce an archive when a declared asset is missing", async () => {
    const versioned = structuredClone(snapshot);
    versioned.payload.manifest.version = 7;
    versioned.payload.knowledge = createKnowledgeEnvelope([]);
    versioned.assets = [streamAsset("a1", "asset-bytes")];

    await expect(writeNativeStreamableBackupSnapshot(versioned, "cache-share", async () => undefined))
      .rejects.toThrow(/资源“a1\.png”（ID a1）在本机缺失或无法读取/);
    expect(vi.mocked(NativeZipArchive.cancelExport)).toHaveBeenCalled();
    // Nothing was written after the defect, so no archive can be mistaken for a good one.
    expect(vi.mocked(NativeZipArchive.finishExport)).not.toHaveBeenCalled();
  });

  it("S3-02: a declared asset is verified on import, and a missing entry is rejected with its identity", async () => {
    const versioned = structuredClone(snapshot);
    versioned.payload.manifest.version = 7;
    versioned.payload.knowledge = createKnowledgeEnvelope([]);
    versioned.assets = [streamAsset("a1", "asset-bytes")];
    const entries = captureExport();
    await writeNativeStreamableBackupSnapshot(versioned, "cache-share", async (id) =>
      id === "a1" ? assetBlob(streamAsset("a1", "asset-bytes"), "asset-bytes") : undefined);

    const payload = JSON.parse(entries.get("snapshot-v7.json")!);
    expect(payload.assetChecksums).toEqual([
      { id: "a1", hash: await hashBlob(new Blob(["asset-bytes"], { type: "image/png" })), size: 11 },
    ]);

    // Stands in for the real adapter, which stages every asset through this reader.
    const readAllAssets = vi.fn(async (_s: unknown, readAsset: (meta: BackupAssetMeta, index: number, total: number) => Promise<unknown>) => {
      for (const [index, meta] of versioned.assets.entries()) await readAsset(meta, index, versioned.assets.length);
    });
    const store = { restoreStreamableSnapshot: readAllAssets } as unknown as StorageAdapter;
    const assetEntry = `assets/a1-a1.png`;

    // Positive control: identical bytes import with the asset verified.
    replayImport(entries, new Map([[assetEntry, "asset-bytes"]]));
    await importNativeStreamableBackupAndRestore("content://ok.zip", store);
    expect(readAllAssets).toHaveBeenCalledTimes(1);

    // Tampered bytes of the same length are caught by the declaration.
    replayImport(entries, new Map([[assetEntry, "tampered-xy"]]));
    await expect(importNativeStreamableBackupAndRestore("content://bad.zip", store)).rejects.toThrow(/字节内容与声明不一致/);

    // An archive whose manifest declares an asset it does not contain is rejected with its identity.
    const withoutEntry = new Map([...entries.keys()].filter((key) => key !== assetEntry).map((key) => [key, entries.get(key)!]));
    replayImport(withoutEntry, new Map());
    await expect(importNativeStreamableBackupAndRestore("content://missing.zip", store)).rejects.toThrow(/资源“a1\.png”（ID a1）.*缺少对应文件/);
  });
});
