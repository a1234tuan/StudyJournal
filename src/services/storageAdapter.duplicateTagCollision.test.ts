import Dexie from "dexie";
import { IDBKeyRange, indexedDB } from "fake-indexeddb";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { RecordBlock, StorageSnapshot, StreamableBackupSnapshot, Tag } from "../types";
import { StudyJournalDatabase } from "../db/database";

// 真实 IndexedDB（fake-indexeddb）才能触发与生产一致的唯一索引约束。
Dexie.dependencies.indexedDB = indexedDB;
Dexie.dependencies.IDBKeyRange = IDBKeyRange;

const stamp = "2026-09-01T00:00:00.000Z";

const createTag = (id: string, name: string): Tag => ({
  id,
  name,
  createdAt: stamp,
  updatedAt: stamp,
});

const localBlock: RecordBlock = {
  id: "local-record",
  createdAt: stamp,
  updatedAt: stamp,
  type: "record",
  date: "2026-09-01",
  order: 0,
  subject: "数学",
  tags: [],
  title: "同步前的本地日志",
  contentHtml: "<p>快照应用后由快照内容决定了这块的去留</p>",
  assets: [],
  formulas: [],
  mistakeRefs: [],
};

/** 模拟云端合并结果：两台设备各创建了一条同名标签（不同 ID），两行同时出现在快照里。 */
const buildSnapshotWithDuplicateNameTags = (tags: Tag[]): StorageSnapshot => ({
  payload: {
    manifest: {
      format: "study-journal",
      version: 4,
      exportedAt: stamp,
      appVersion: "0.1.0",
      counts: { entries: 0, blocks: 0, mistakes: 0, assets: 0, tags: tags.length, reviews: 0, studySessions: 0 },
    },
    entries: [],
    blocks: [],
    templates: [],
    recordDrafts: [],
    mistakes: [],
    tags,
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
});

const createdDbNames = new Set<string>();

afterEach(async () => {
  await Promise.all([...createdDbNames].map((name) => Dexie.delete(name)));
  createdDbNames.clear();
});

/** 用真实 schema 的 StudyJournalDatabase + 真实 DexieStorageAdapter 跑恢复路径。 */
const createAdapterWithRealDb = async () => {
  const database = new StudyJournalDatabase(`dup-tag-restore-${crypto.randomUUID()}`);
  createdDbNames.add(database.name);
  await database.open();
  vi.resetModules();
  vi.doMock("../db/database", () => ({ db: database }));
  const { DexieStorageAdapter } = await import("./storageAdapter");
  return { database, adapter: new DexieStorageAdapter() };
};

const duplicateTags = [
  createTag("tag-device-a", "重点"),
  createTag("tag-device-b", "重点"),
];

const tagNames = (database: StudyJournalDatabase) => database.tags.toArray().then((tags) => tags.map((tag) => ({ id: tag.id, name: tag.name })));

describe("同名标签跨端并发（tag 同名收敛）", () => {
  it("schema 层面：同名列拥有 &name 唯一索引 —— 这正是恢复要去重的原因", async () => {
    const db = new Dexie(`dup-tag-schema-${crypto.randomUUID()}`);
    createdDbNames.add(db.name);
    db.version(1).stores({ tags: "id, &name, parent" });

    // 若不去重，两条同名行直接 bulkPut 会命中唯一索引。
    await expect(db.table<Tag, string>("tags").bulkPut(duplicateTags)).rejects.toThrow(/ConstraintError/);
  });

  it("云同步 apply：双设备同名标签收敛为一行，恢复事务不再被唯一索引中断", async () => {
    const { database, adapter } = await createAdapterWithRealDb();
    await database.tags.put(createTag("local-tag", "本地标签"));
    await database.blocks.put(localBlock);

    const snapshot = buildSnapshotWithDuplicateNameTags(duplicateTags);

    await expect(adapter.restoreCloudSyncSnapshot(snapshot)).resolves.toBeUndefined();

    // 恢复成功且收敛：同名只保留一个确定胜者（最小 id），未被快照覆盖的本地行按整体替换语义清空。
    expect(await tagNames(database)).toEqual([{ id: "tag-device-a", name: "重点" }]);
    expect(await database.blocks.toArray()).toEqual([]);
  });

  it("手动恢复（restoreSnapshot）：同名标签同样收敛为一行", async () => {
    const { database, adapter } = await createAdapterWithRealDb();

    const snapshot = buildSnapshotWithDuplicateNameTags(duplicateTags);

    await expect(adapter.restoreSnapshot(snapshot)).resolves.toBeUndefined();

    expect(await tagNames(database)).toEqual([{ id: "tag-device-a", name: "重点" }]);
  });

  it("流式恢复（restoreStreamableSnapshot）：同名标签同样收敛为一行", async () => {
    const { database, adapter } = await createAdapterWithRealDb();

    const snapshot = buildSnapshotWithDuplicateNameTags(duplicateTags);

    await expect(
      adapter.restoreStreamableSnapshot(snapshot as unknown as StreamableBackupSnapshot, async () => undefined),
    ).resolves.toBeUndefined();

    expect(await tagNames(database)).toEqual([{ id: "tag-device-a", name: "重点" }]);
  });
});