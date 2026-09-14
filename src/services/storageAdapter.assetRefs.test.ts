import Dexie from "dexie";
import { IDBKeyRange, indexedDB } from "fake-indexeddb";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { StudyJournalDatabase } from "../db/database";
import { syncRecordRefsFromContent } from "../lib/recordContent";
import type { Asset, ContentTemplate, KnowledgePodcast, RecordBlock, RecordDraft, StorageSnapshot } from "../types";

Dexie.dependencies.indexedDB = indexedDB;
Dexie.dependencies.IDBKeyRange = IDBKeyRange;

const STAMP = "2026-09-14T00:00:00.000Z";

const imageAsset = (id: string): Asset => ({
  id,
  createdAt: STAMP,
  updatedAt: STAMP,
  fileName: `${id}.png`,
  title: id,
  mimeType: "image/png",
  size: 4,
  kind: "image",
  data: new Blob(["img"], { type: "image/png" }),
});

const podcastAudioAsset = (id: string): Asset => ({
  id,
  createdAt: STAMP,
  updatedAt: STAMP,
  fileName: `${id}.mp3`,
  title: "第一章",
  mimeType: "audio/mpeg",
  size: 3,
  kind: "audio",
  generatedBy: "knowledge-podcast",
  generatedForPodcastId: "podcast-1",
  generatedForAudioUnitId: "unit-1",
  durationSeconds: 12,
  data: new Blob(["mp3"], { type: "audio/mpeg" }),
});

const assetNode = (id: string, kind: "image" | "audio" = "image"): string =>
  `<record-asset data-asset-id="${id}" data-kind="${kind}" data-title="${id}"></record-asset>`;

const record = (id: string, contentHtml: string): RecordBlock =>
  syncRecordRefsFromContent({
    id,
    createdAt: STAMP,
    updatedAt: STAMP,
    type: "record",
    date: "2026-09-14",
    order: 0,
    subject: "数学",
    tags: [],
    title: id,
    contentHtml,
    assets: [],
    formulas: [],
    mistakeRefs: [],
  });

const template = (id: string, contentHtml: string): ContentTemplate => ({
  id,
  createdAt: STAMP,
  updatedAt: STAMP,
  title: id,
  contentHtml,
});

const draftFor = (recordId: string, contentHtml: string): RecordDraft => ({
  id: recordId,
  recordId,
  baseUpdatedAt: STAMP,
  draft: record(recordId, contentHtml),
  updatedAt: STAMP,
});

const podcast = (): KnowledgePodcast => ({
  id: "podcast-1",
  createdAt: STAMP,
  updatedAt: STAMP,
  title: "测试播客",
  mode: "summary",
  targetMinutes: 3,
  scope: { kind: "date", date: "2026-09-14" },
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
    audioAssetId: "pod-asset",
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
    audioAssetId: "pod-asset",
    audioStatus: "ready",
    durationSeconds: 12,
  }],
  ttsConfig: { providerId: "google", model: "default", voiceId: "default", format: "mp3" },
});

let database: StudyJournalDatabase;
let adapter: InstanceType<typeof import("./storageAdapter").DexieStorageAdapter>;

beforeEach(async () => {
  vi.resetModules();
  database = new StudyJournalDatabase(`storage-asset-refs-${crypto.randomUUID()}`);
  await database.open();
  vi.doMock("../db/database", () => ({ db: database }));
  const { DexieStorageAdapter } = await import("./storageAdapter");
  adapter = new DexieStorageAdapter();
});

afterEach(async () => {
  const name = database.name;
  database.close();
  await Dexie.delete(name);
});

const exportedBlocks = (snapshot: { payload: { blocks: StorageSnapshot["payload"]["blocks"] } }): RecordBlock[] =>
  snapshot.payload.blocks.filter((block): block is RecordBlock => block.type === "record");

describe("export reconciles asset references", () => {
  it("exports a record that references generated podcast audio instead of failing forever", async () => {
    const content = `<p>讲解</p>${assetNode("pod-asset", "audio")}${assetNode("img-1")}`;
    await database.assets.bulkPut([podcastAudioAsset("pod-asset"), imageAsset("img-1")]);
    await database.blocks.put(record("rec-1", content));
    await database.knowledgePodcasts.put(podcast());

    const snapshot = await adapter.createSnapshot();

    // Podcast audio is deliberately excluded from every backup channel.
    expect(snapshot.assets.map((asset) => asset.id)).toEqual(["img-1"]);
    const [exported] = exportedBlocks(snapshot);
    expect(exported.contentHtml).not.toContain("pod-asset");
    expect(exported.contentHtml).toContain("img-1");
    expect(exported.assets.map((ref) => ref.id)).toEqual(["img-1"]);
  });

  it("applies the same rule to the streaming export channel", async () => {
    await database.assets.bulkPut([podcastAudioAsset("pod-asset"), imageAsset("img-1")]);
    await database.blocks.put(record("rec-1", `<p>讲解</p>${assetNode("pod-asset", "audio")}`));

    const snapshot = await adapter.createStreamableSnapshot();

    expect(snapshot.assets.map((asset) => asset.id)).toEqual(["img-1"]);
    expect(exportedBlocks(snapshot)[0].contentHtml).not.toContain("pod-asset");
  });

  it("excludes a podcast reference held by a template as well", async () => {
    await database.assets.put(podcastAudioAsset("pod-asset"));
    await database.templates.put(template("tpl-1", `<p>模板</p>${assetNode("pod-asset", "audio")}`));

    const snapshot = await adapter.createSnapshot();

    expect(snapshot.payload.templates?.[0].contentHtml).not.toContain("pod-asset");
  });

  it("drops a reference whose asset no longer exists locally so pre-existing damage cannot block export", async () => {
    await database.blocks.put(record("rec-1", `<p>只剩占位</p>${assetNode("ghost")}`));

    const snapshot = await adapter.createSnapshot();

    expect(exportedBlocks(snapshot)[0].contentHtml).not.toContain("ghost");
    expect(exportedBlocks(snapshot)[0].assets).toEqual([]);
  });

  it("leaves fully resolvable content byte-identical", async () => {
    const content = `<p>正常记录</p>${assetNode("img-1")}`;
    await database.assets.put(imageAsset("img-1"));
    await database.blocks.put(record("rec-1", content));

    const snapshot = await adapter.createSnapshot();

    expect(exportedBlocks(snapshot)[0].contentHtml).toBe(content);
  });

  it("keeps the integrity assertion strict on restore", async () => {
    const broken: StorageSnapshot = {
      payload: {
        manifest: {
          format: "study-journal",
          version: 6,
          exportedAt: STAMP,
          appVersion: "0.1.0",
          counts: { entries: 0, blocks: 1, mistakes: 0, assets: 0, tags: 0, reviews: 0, studySessions: 0 },
        },
        entries: [],
        blocks: [record("rec-1", assetNode("missing"))],
        templates: [],
        recordDrafts: [],
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
      assets: [],
    };

    await expect(adapter.restoreSnapshot(broken)).rejects.toThrow("备份数据不完整");
  });
});

describe("orphan asset cleanup after a permanent delete", () => {
  it("keeps an asset that a template still references", async () => {
    await database.assets.put(imageAsset("img-1"));
    await database.blocks.put(record("rec-1", assetNode("img-1")));
    await database.templates.put(template("tpl-1", `<p>模板</p>${assetNode("img-1")}`));

    await adapter.permanentlyDeleteBlock("rec-1");

    expect(await database.assets.get("img-1")).toBeDefined();
    // The causal pair from the audit: a dangling template reference used to make every export fail.
    await expect(adapter.createSnapshot()).resolves.toBeTruthy();
  });

  it("keeps an asset that another record still references", async () => {
    await database.assets.put(imageAsset("img-1"));
    await database.blocks.bulkPut([
      record("rec-1", assetNode("img-1")),
      record("rec-2", assetNode("img-1")),
    ]);

    await adapter.permanentlyDeleteBlock("rec-1");

    expect(await database.assets.get("img-1")).toBeDefined();
  });

  it("keeps an asset that an unsaved draft still references", async () => {
    await database.assets.put(imageAsset("img-1"));
    await database.blocks.put(record("rec-1", assetNode("img-1")));
    await database.recordDrafts.put(draftFor("rec-2", assetNode("img-1")));

    await adapter.permanentlyDeleteBlock("rec-1");

    expect(await database.assets.get("img-1")).toBeDefined();
  });

  it("keeps generated podcast audio that an episode still uses", async () => {
    await database.assets.put(podcastAudioAsset("pod-asset"));
    await database.blocks.put(record("rec-1", assetNode("pod-asset", "audio")));
    await database.knowledgePodcasts.put(podcast());

    await adapter.permanentlyDeleteBlock("rec-1");

    expect(await database.assets.get("pod-asset")).toBeDefined();
  });

  it("still deletes an asset that nothing references any more", async () => {
    await database.assets.put(imageAsset("img-1"));
    await database.blocks.put(record("rec-1", assetNode("img-1")));

    await adapter.permanentlyDeleteBlock("rec-1");

    expect(await database.assets.get("img-1")).toBeUndefined();
  });
});
