import { afterEach, describe, expect, it, vi } from "vitest";

describe("DexieStorageAdapter initialization", () => {
  afterEach(() => {
    vi.doUnmock("../db/database");
    vi.resetModules();
  });

  it("does not create today's entry as a startup side effect", async () => {
    vi.resetModules();
    const db = {
      open: vi.fn(async () => undefined),
      restoreStagingAssets: { clear: vi.fn(async () => undefined) },
      settings: {
        get: vi.fn(async () => ({ id: "settings" })),
        put: vi.fn(async () => undefined),
      },
    };
    vi.doMock("../db/database", () => ({ db }));
    const { DexieStorageAdapter } = await import("./storageAdapter");
    const adapter = new DexieStorageAdapter();
    const methods = [
      "upsertTag",
      "migrateLegacyBlocks",
      "migrateRecordsToLinearContent",
      "migrateRecordTags",
      "migrateSettingsToDynamicSubjects",
      "migrateAiSettings",
      "migrateTtsSettings",
      "migrateAutoBackupToLocalTable",
      "purgeMistakeAndReviewData",
      "migrateRecordReviewsToMixedSystem",
      "rebuildReviewProjectionFromEvents",
      "compactOldReviewLogs",
      "restoreKnowledgePodcastAudioReferences",
      "resetStaleOcrJobs",
      "getOrCreateEntry",
    ] as const;
    const spies = methods.map((method) => vi.spyOn(adapter as never, method).mockResolvedValue(undefined));

    await adapter.initialize();

    expect(spies[spies.length - 1]).not.toHaveBeenCalled();
    expect(db.open).toHaveBeenCalledOnce();
    expect(spies[spies.length - 2]).toHaveBeenCalledWith(10 * 60 * 1000);
  });

  it("coalesces concurrent initialization and permits a later explicit run", async () => {
    vi.resetModules();
    let releaseOpen!: () => void;
    const openGate = new Promise<void>((resolve) => { releaseOpen = resolve; });
    const db = {
      open: vi.fn(() => openGate),
      restoreStagingAssets: { clear: vi.fn(async () => undefined) },
      settings: {
        get: vi.fn(async () => ({ id: "settings" })),
        put: vi.fn(async () => undefined),
      },
    };
    vi.doMock("../db/database", () => ({ db }));
    const { DexieStorageAdapter } = await import("./storageAdapter");
    const adapter = new DexieStorageAdapter();
    const upsertTag = vi.spyOn(adapter, "upsertTag").mockResolvedValue({ id: "tag", name: "tag", createdAt: "", updatedAt: "" });
    const methods = [
      "migrateLegacyBlocks",
      "migrateRecordsToLinearContent",
      "migrateRecordTags",
      "migrateSettingsToDynamicSubjects",
      "migrateAiSettings",
      "migrateTtsSettings",
      "migrateAutoBackupToLocalTable",
      "purgeMistakeAndReviewData",
      "migrateRecordReviewsToMixedSystem",
      "rebuildReviewProjectionFromEvents",
      "compactOldReviewLogs",
      "restoreKnowledgePodcastAudioReferences",
      "resetStaleOcrJobs",
    ] as const;
    const spies = methods.map((method) => vi.spyOn(adapter as never, method).mockResolvedValue(undefined));

    const first = adapter.initialize();
    const second = adapter.initialize();
    expect(db.open).toHaveBeenCalledOnce();
    releaseOpen();
    await Promise.all([first, second]);

    expect(upsertTag).toHaveBeenCalledTimes(13);
    expect(spies.every((spy) => spy.mock.calls.length === 1)).toBe(true);

    await adapter.initialize();
    expect(db.open).toHaveBeenCalledTimes(2);
    expect(upsertTag).toHaveBeenCalledTimes(26);
    expect(spies.every((spy) => spy.mock.calls.length === 2)).toBe(true);
  });

  it("allows initialization to retry after a failure", async () => {
    vi.resetModules();
    const db = {
      open: vi.fn()
        .mockRejectedValueOnce(new Error("open failed"))
        .mockResolvedValue(undefined),
      restoreStagingAssets: { clear: vi.fn(async () => undefined) },
      settings: {
        get: vi.fn(async () => ({ id: "settings" })),
        put: vi.fn(async () => undefined),
      },
    };
    vi.doMock("../db/database", () => ({ db }));
    const { DexieStorageAdapter } = await import("./storageAdapter");
    const adapter = new DexieStorageAdapter();
    vi.spyOn(adapter, "upsertTag").mockResolvedValue({ id: "tag", name: "tag", createdAt: "", updatedAt: "" });
    const methods = [
      "migrateLegacyBlocks",
      "migrateRecordsToLinearContent",
      "migrateRecordTags",
      "migrateSettingsToDynamicSubjects",
      "migrateAiSettings",
      "migrateTtsSettings",
      "migrateAutoBackupToLocalTable",
      "purgeMistakeAndReviewData",
      "migrateRecordReviewsToMixedSystem",
      "rebuildReviewProjectionFromEvents",
      "compactOldReviewLogs",
      "restoreKnowledgePodcastAudioReferences",
      "resetStaleOcrJobs",
    ] as const;
    methods.forEach((method) => vi.spyOn(adapter as never, method).mockResolvedValue(undefined));

    await expect(adapter.initialize()).rejects.toThrow("open failed");
    await expect(adapter.initialize()).resolves.toBeUndefined();
    expect(db.open).toHaveBeenCalledTimes(2);
  });
});
