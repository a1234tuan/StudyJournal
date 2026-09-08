import { describe, expect, it, vi } from "vitest";

import type { Asset, KnowledgePodcast, RecordBlock, StorageSnapshot, StreamableBackupSnapshot } from "../types";

type StoredRow = object;

class MemoryTable<T extends StoredRow> {
  private rows = new Map<string, T>();

  constructor(rows: T[] = [], private readonly key = "id") {
    for (const row of rows) {
      this.rows.set(String((row as Record<string, unknown>)[this.key]), row);
    }
  }

  async get(id: string): Promise<T | undefined> {
    return this.rows.get(id);
  }

  async put(row: T): Promise<string> {
    const id = String((row as Record<string, unknown>)[this.key]);
    this.rows.set(id, row);
    return id;
  }

  async bulkPut(rows: T[]): Promise<void> {
    for (const row of rows) {
      await this.put(row);
    }
  }

  async clear(): Promise<void> {
    this.rows.clear();
  }

  async toArray(): Promise<T[]> {
    return Array.from(this.rows.values());
  }

  where(index: string) {
    return {
      equals: (value: string) => ({
        toArray: async () => Array.from(this.rows.values()).filter((row) => (row as Record<string, unknown>)[index] === value),
        delete: async () => {
          for (const [id, row] of this.rows.entries()) {
            if ((row as Record<string, unknown>)[index] === value) {
              this.rows.delete(id);
            }
          }
        },
      }),
    };
  }

  filter(predicate: (row: T) => boolean) {
    return {
      toArray: async () => Array.from(this.rows.values()).filter(predicate),
    };
  }
}

const stamp = "2026-06-21T00:00:00.000Z";

const oldRecord: RecordBlock = {
  id: "old-record",
  createdAt: stamp,
  updatedAt: stamp,
  type: "record",
  date: "2026-06-21",
  order: 0,
  subject: "数学",
  tags: [],
  title: "恢复前记录",
  contentHtml: "<p>保留的旧数据</p>",
  assets: [],
  formulas: [],
  mistakeRefs: [],
};

const oldAsset: Asset = {
  id: "old-asset",
  createdAt: stamp,
  updatedAt: stamp,
  fileName: "old.png",
  title: "旧图片",
  mimeType: "image/png",
  size: 1,
  kind: "image",
  data: new Blob(["old"], { type: "image/png" }),
};

const podcastAudioAsset: Asset = {
  id: "podcast-audio",
  createdAt: stamp,
  updatedAt: stamp,
  fileName: "episode-01.mp3",
  title: "第一章",
  mimeType: "audio/mpeg",
  size: 3,
  kind: "audio",
  generatedBy: "knowledge-podcast",
  generatedForPodcastId: "podcast-1",
  generatedForAudioUnitId: "unit-1",
  durationSeconds: 12,
  data: new Blob(["mp3"], { type: "audio/mpeg" }),
};

const podcastWithAudio: KnowledgePodcast = {
  id: "podcast-1",
  createdAt: stamp,
  updatedAt: stamp,
  title: "测试播客",
  mode: "summary",
  targetMinutes: 3,
  scope: { kind: "date", date: "2026-06-21" },
  sourceRecordIds: [],
  contextHash: "context",
  scriptStatus: "ready",
  audioStatus: "ready",
  opening: "开场",
  segments: [{
    id: "segment-1",
    order: 0,
    title: "第一章",
    text: "正文",
    sourceRecordIds: [],
    textHash: "text",
    audioAssetId: "podcast-audio",
    audioStatus: "ready",
    durationSeconds: 12,
  }],
  closing: "结尾",
  audioLayoutVersion: 2,
  audioUnits: [{
    id: "unit-1",
    kind: "segment",
    order: 0,
    title: "第一章",
    segmentId: "segment-1",
    textHash: "text",
    audioAssetId: "podcast-audio",
    audioStatus: "ready",
    durationSeconds: 12,
  }],
  ttsConfig: { providerId: "google", model: "default", voiceId: "default", format: "mp3" },
};

const restorePayload = {
  manifest: {
    format: "study-journal" as const,
    version: 5 as const,
    exportedAt: stamp,
    appVersion: "0.1.0",
    counts: { entries: 0, blocks: 0, mistakes: 0, assets: 0, tags: 0, reviews: 0, studySessions: 0 },
  },
  entries: [],
  blocks: [],
  templates: [],
  recordDrafts: [],
  mistakes: [],
  tags: [],
  reviews: [],
  recordReviews: [],
  recordReviewLogs: [],
  recordReviewDayStats: [],
  studySessions: [],
  settings: {
    id: "settings" as const,
    examDate: "2026-12-27" as const,
    theme: "system" as const,
    accentColor: "#2f6f5e",
    backupReminderDays: 7,
    fontScale: 1,
    lineHeight: 1.7,
    schemaVersion: 4 as const,
  },
};

const createReviewCoachMemoryTables = () => ({
  decisionBlocks: new MemoryTable(),
  decisionBlockArchives: new MemoryTable(),
  decisionBlockFeedback: new MemoryTable(),
  feedbackInterpretations: new MemoryTable(),
  analysisQueueItems: new MemoryTable(),
  analysisBatches: new MemoryTable(),
  sessionBlueprints: new MemoryTable(),
  adaptiveReviewTasks: new MemoryTable(),
  adaptiveQuizTurns: new MemoryTable(),
  taskOutcomeEvents: new MemoryTable(),
  delayedVerifications: new MemoryTable(),
  decisionBlockStates: new MemoryTable(),
  interventionEffectSummaries: new MemoryTable(),
  aiRoleConfigs: new MemoryTable(),
  learningEvidence: new MemoryTable(),
  knowledgePoints: new MemoryTable(),
  recordKnowledgePointLinks: new MemoryTable(),
  knowledgeRelations: new MemoryTable(),
  learningCoachSettings: new MemoryTable(),
  learningCoachSnapshots: new MemoryTable(),
  learningCoachTasks: new MemoryTable(),
  learningCoachAiRuns: new MemoryTable(),
  knowledgePointExtractionRuns: new MemoryTable(),
  knowledgePointCoachSnapshots: new MemoryTable(),
});

const createRestoreDb = (podcasts: KnowledgePodcast[] = [], assets: Asset[] = [podcastAudioAsset]) => ({
  ...createReviewCoachMemoryTables(),
  entries: new MemoryTable(),
  blocks: new MemoryTable(),
  templates: new MemoryTable(),
  recordDrafts: new MemoryTable(),
  recordReviews: new MemoryTable(),
  recordReviewLogs: new MemoryTable(),
  recordReviewDayStats: new MemoryTable(),
  mistakes: new MemoryTable(),
  tags: new MemoryTable(),
  reviews: new MemoryTable(),
  studySessions: new MemoryTable(),
  settings: new MemoryTable<StoredRow>([restorePayload.settings]),
  assets: new MemoryTable<StoredRow>(assets),
  knowledgePodcasts: new MemoryTable<StoredRow>(podcasts),
  cloudSyncMutation: new MemoryTable<StoredRow>([{ id: "local", epoch: 0 }]),
  restoreStagingAssets: new MemoryTable<StoredRow>([], "stagingId"),
  reviewAnnotationDrafts: new MemoryTable(),
  voiceRecallSessions: new MemoryTable(),
  voiceRecallTurns: new MemoryTable(),
  voiceRecallLocalHistory: new MemoryTable(),
  transaction: async (_mode: string, ...args: unknown[]) => {
    const callback = args.at(-1) as () => Promise<unknown>;
    return callback();
  },
});

const snapshot: StreamableBackupSnapshot = {
  payload: {
    manifest: {
      format: "study-journal",
      version: 4,
      exportedAt: stamp,
      appVersion: "0.1.0",
      counts: { entries: 0, blocks: 1, mistakes: 0, assets: 2, tags: 0, reviews: 0, studySessions: 0 },
    },
    entries: [],
    blocks: [{
      ...oldRecord,
      id: "new-record",
      title: "恢复中的新记录",
      contentHtml: '<record-asset data-asset-id="new-asset-1" data-kind="image" data-title="one.png"></record-asset>',
    }],
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
      schemaVersion: 4,
    },
  },
  assets: [
    { ...oldAsset, id: "new-asset-1", fileName: "one.png", title: "one", data: undefined as never },
    { ...oldAsset, id: "new-asset-2", fileName: "two.png", title: "two", data: undefined as never },
  ].map(({ data: _data, ...asset }) => asset),
};

describe("DexieStorageAdapter stream restore", () => {
  it("keeps current data when resource staging fails and removes staged assets", async () => {
    vi.resetModules();
    const fakeDb = {
      entries: new MemoryTable(),
      blocks: new MemoryTable<StoredRow>([oldRecord]),
      templates: new MemoryTable(),
      recordDrafts: new MemoryTable(),
      recordReviews: new MemoryTable(),
      recordReviewLogs: new MemoryTable(),
      recordReviewDayStats: new MemoryTable(),
      mistakes: new MemoryTable(),
      tags: new MemoryTable(),
      reviews: new MemoryTable(),
      studySessions: new MemoryTable(),
      settings: new MemoryTable(),
      assets: new MemoryTable<StoredRow>([oldAsset]),
      restoreStagingAssets: new MemoryTable<StoredRow>([], "stagingId"),
      transaction: async (_mode: string, ...args: unknown[]) => {
        const callback = args.at(-1) as () => Promise<unknown>;
        return callback();
      },
    };
    vi.doMock("../db/database", () => ({ db: fakeDb }));
    const { DexieStorageAdapter } = await import("./storageAdapter");
    const adapter = new DexieStorageAdapter();

    await expect(adapter.restoreStreamableSnapshot(snapshot, async (meta) => {
      if (meta.id === "new-asset-2") {
        return undefined;
      }
      return { ...oldAsset, id: meta.id, fileName: meta.fileName, title: meta.title };
    })).rejects.toThrow("无法读取资源 two.png");

    expect(await fakeDb.blocks.get("old-record")).toEqual(oldRecord);
    expect(await fakeDb.assets.get("old-asset")).toEqual(oldAsset);
    expect(await fakeDb.restoreStagingAssets.toArray()).toEqual([]);
  });

  it("appends imported records with a conflict-safe title and no review state", async () => {
    vi.resetModules();
    const settings = {
      id: "settings",
      examDate: "2026-12-27",
      theme: "system",
      accentColor: "#2f6f5e",
      backupReminderDays: 7,
      fontScale: 1,
      lineHeight: 1.7,
      schemaVersion: 4,
    };
    const imported: RecordBlock = {
      ...oldRecord,
      id: "imported-record",
      title: oldRecord.title,
      contentHtml: '<p><record-asset data-asset-id="imported-asset" data-kind="image" data-title="one.png"></record-asset></p>',
    };
    const importedAsset = { ...oldAsset, id: "imported-asset", fileName: "one.png" };
    const fakeDb = {
      entries: new MemoryTable(),
      blocks: new MemoryTable<StoredRow>([oldRecord]),
      templates: new MemoryTable(),
      assets: new MemoryTable<StoredRow>([oldAsset]),
      settings: new MemoryTable<StoredRow>([settings]),
      restoreStagingAssets: new MemoryTable<StoredRow>([], "stagingId"),
      transaction: async (_mode: string, ...args: unknown[]) => {
        const callback = args.at(-1) as () => Promise<unknown>;
        return callback();
      },
    };
    vi.doMock("../db/database", () => ({ db: fakeDb }));
    const { DexieStorageAdapter } = await import("./storageAdapter");
    const adapter = new DexieStorageAdapter();

    await adapter.stageRecordTransferAsset("transfer", importedAsset);
    const summary = await adapter.commitRecordTransfer("transfer", [imported]);
    const blocks = await fakeDb.blocks.toArray() as RecordBlock[];
    const inserted = blocks.find((block) => block.id === imported.id);
    const nextSettings = await fakeDb.settings.get("settings") as typeof settings & { subjects?: Array<{ name: string }> };

    expect(summary).toMatchObject({ records: 1, assets: 1, images: 1 });
    expect(inserted).toMatchObject({ title: "恢复前记录（导入副本）", order: 1, assets: [{ id: "imported-asset", kind: "image", title: "one.png" }] });
    expect(nextSettings.schemaVersion).toBe(4);
    expect(nextSettings.subjects?.some((subject) => subject.name === "数学")).toBe(true);
    expect(await fakeDb.restoreStagingAssets.toArray()).toEqual([]);
  });
});

describe("DexieStorageAdapter cloud restore", () => {
  it("repairs podcast references that were cleared by an earlier restore", async () => {
    vi.resetModules();
    const damagedPodcast: KnowledgePodcast = {
      ...podcastWithAudio,
      audioStatus: "idle",
      segments: podcastWithAudio.segments.map((segment) => ({ ...segment, audioAssetId: undefined, audioStatus: "pending", durationSeconds: undefined })),
      audioUnits: podcastWithAudio.audioUnits?.map((unit) => ({ ...unit, audioAssetId: undefined, audioStatus: "pending", durationSeconds: undefined })),
    };
    const fakeDb = createRestoreDb([damagedPodcast]);
    vi.doMock("../db/database", () => ({ db: fakeDb }));
    const { DexieStorageAdapter } = await import("./storageAdapter");
    const adapter = new DexieStorageAdapter();

    await (adapter as unknown as { restoreKnowledgePodcastAudioReferences: () => Promise<void> }).restoreKnowledgePodcastAudioReferences();

    expect(await fakeDb.knowledgePodcasts.get("podcast-1")).toMatchObject({
      audioStatus: "ready",
      audioUnits: [{ audioAssetId: "podcast-audio", audioStatus: "ready", durationSeconds: 12 }],
      segments: [{ audioAssetId: "podcast-audio", audioStatus: "ready", durationSeconds: 12 }],
    });
  });

  it("preserves local podcast audio references and assets", async () => {
    vi.resetModules();
    const fakeDb = createRestoreDb([podcastWithAudio]);
    vi.doMock("../db/database", () => ({ db: fakeDb }));
    const { DexieStorageAdapter } = await import("./storageAdapter");
    const adapter = new DexieStorageAdapter();
    const snapshot = {
      payload: { ...restorePayload, podcasts: [] },
      assets: [],
    } as StorageSnapshot;

    await adapter.restoreCloudSyncSnapshot(snapshot);

    expect(await fakeDb.knowledgePodcasts.get("podcast-1")).toMatchObject({
      audioStatus: "ready",
      audioUnits: [{ audioAssetId: "podcast-audio", audioStatus: "ready" }],
      segments: [{ audioAssetId: "podcast-audio", audioStatus: "ready" }],
    });
    expect(await fakeDb.assets.get("podcast-audio")).toEqual(podcastAudioAsset);
  });

  it("reads local-only podcasts inside the restore transaction so a concurrent save is retained", async () => {
    vi.resetModules();
    const newerPodcast = { ...podcastWithAudio, title: "同步期间新标题", updatedAt: "2026-09-07T09:00:00.000Z" };
    const fakeDb = createRestoreDb([podcastWithAudio]);
    let injected = false;
    fakeDb.transaction = async (_mode: string, ...args: unknown[]) => {
      const callback = args.at(-1) as () => Promise<unknown>;
      if (!injected) {
        injected = true;
        await fakeDb.knowledgePodcasts.put(newerPodcast);
      }
      return callback();
    };
    vi.doMock("../db/database", () => ({ db: fakeDb }));
    const { DexieStorageAdapter } = await import("./storageAdapter");
    const adapter = new DexieStorageAdapter();

    await adapter.restoreCloudSyncSnapshot({ payload: { ...restorePayload, podcasts: [] }, assets: [] } as StorageSnapshot);

    expect(await fakeDb.knowledgePodcasts.get("podcast-1")).toMatchObject({ title: "同步期间新标题" });
  });

  it("keeps ordinary backup restore normalization unchanged", async () => {
    vi.resetModules();
    const fakeDb = createRestoreDb();
    await fakeDb.voiceRecallSessions.put({ id: "voice-session", status: "paused" });
    await fakeDb.voiceRecallTurns.put({ id: "voice-turn", sessionId: "voice-session" });
    await fakeDb.voiceRecallLocalHistory.put({ id: "voice-history", title: "本机摘要" });
    vi.doMock("../db/database", () => ({ db: fakeDb }));
    const { DexieStorageAdapter } = await import("./storageAdapter");
    const adapter = new DexieStorageAdapter();
    const snapshot = {
      payload: { ...restorePayload, podcasts: [podcastWithAudio] },
      assets: [],
    } as StorageSnapshot;

    await adapter.restoreSnapshot(snapshot);

    const restored = await fakeDb.knowledgePodcasts.get("podcast-1") as unknown as KnowledgePodcast;
    expect(restored).toMatchObject({ audioStatus: "idle", audioUnits: [{ audioStatus: "pending" }], segments: [{ audioStatus: "pending" }] });
    expect(restored.audioUnits?.[0].audioAssetId).toBeUndefined();
    expect(restored.segments[0].audioAssetId).toBeUndefined();
    expect(await fakeDb.voiceRecallSessions.get("voice-session")).toBeUndefined();
    expect(await fakeDb.voiceRecallTurns.get("voice-turn")).toBeUndefined();
    expect(await fakeDb.voiceRecallLocalHistory.get("voice-history")).toMatchObject({ title: "本机摘要" });
  });

  it("preserves every local voice store while applying a cloud pull", async () => {
    vi.resetModules();
    const fakeDb = createRestoreDb();
    await fakeDb.voiceRecallSessions.put({ id: "voice-session", status: "paused" });
    await fakeDb.voiceRecallTurns.put({ id: "voice-turn", sessionId: "voice-session" });
    await fakeDb.voiceRecallLocalHistory.put({ id: "voice-history", title: "本机摘要" });
    vi.doMock("../db/database", () => ({ db: fakeDb }));
    const { DexieStorageAdapter } = await import("./storageAdapter");
    const adapter = new DexieStorageAdapter();

    await adapter.restoreCloudSyncSnapshot({ payload: { ...restorePayload, podcasts: [] }, assets: [] } as StorageSnapshot);

    expect(await fakeDb.voiceRecallSessions.get("voice-session")).toMatchObject({ status: "paused" });
    expect(await fakeDb.voiceRecallTurns.get("voice-turn")).toMatchObject({ sessionId: "voice-session" });
    expect(await fakeDb.voiceRecallLocalHistory.get("voice-history")).toMatchObject({ title: "本机摘要" });
  });
});
