import JSZip from "jszip";
import { describe, expect, it } from "vitest";

import type { Asset, BackupPayload, ContentTemplate, DailyPlan, RecordBlock, StorageSnapshot } from "../types";
import { createKnowledgeEnvelope } from "../features/knowledgeLibrary/backup";
import { containerForPayload } from "../features/knowledgeLibrary/backupContainer";
import { completeCoachTestSnapshot } from "../features/reviewCoach/reviewCoachTestFixtures";
import { snapshotToZip, summarizeSnapshot, zipToSnapshot } from "./backup";
import { hashBlob } from "./cloudSyncModel";

const stamp = "2026-06-21T00:00:00.000Z";

const record = (subject: string): RecordBlock => ({
  id: `record-${subject}`,
  createdAt: stamp,
  updatedAt: stamp,
  type: "record",
  date: "2026-06-21",
  order: 0,
  subject,
  tags: [],
  title: `${subject}记录`,
  contentHtml: "<p></p>",
  assets: [],
  formulas: [],
  mistakeRefs: [],
});

const payload = (blocks: RecordBlock[]): BackupPayload => ({
  manifest: {
    format: "study-journal",
    version: 4,
    exportedAt: stamp,
    appVersion: "0.1.0",
    counts: {
      entries: 0,
      blocks: blocks.length,
      mistakes: 0,
      assets: 0,
      tags: 0,
      reviews: 0,
      studySessions: 0,
    },
  },
  entries: [],
  blocks,
  recordDrafts: [],
  mistakes: [],
  tags: [],
  reviews: [],
  recordReviews: [],
  recordReviewLogs: [],
  recordReviewDayStats: [],
  studySessions: [],
  dailyPlans: [],
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
});

describe("backup import", () => {
  it("creates subject configs for unknown subjects in imported records", async () => {
    const zip = new JSZip();
    zip.file("data.json", JSON.stringify(payload([record("物理")]), null, 2));
    const file = new File([await zip.generateAsync({ type: "blob" })], "backup.zip", { type: "application/zip" });

    const snapshot = await zipToSnapshot(file);

    expect(snapshot.payload.settings.subjects?.map((subject) => subject.name)).toContain("物理");
    expect(snapshot.payload.templates).toEqual([]);
  });

  it("round-trips rich templates through a version 5 full backup", async () => {
    const template: ContentTemplate = {
      id: "template-translation",
      createdAt: stamp,
      updatedAt: stamp,
      title: "翻译复盘",
      contentHtml: "<blockquote>原句</blockquote><ul><li>我的翻译</li></ul><record-formula data-formula-id=\"formula-1\" data-title=\"公式\" data-latex=\"x^2\"></record-formula>",
    };
    const payloadWithTemplate: BackupPayload = {
      ...payload([]),
      manifest: {
        ...payload([]).manifest,
        version: 5,
        counts: { ...payload([]).manifest.counts, templates: 1 },
      },
      templates: [template],
    };
    const snapshot: StorageSnapshot = { payload: payloadWithTemplate, assets: [] };
    const zip = await snapshotToZip(snapshot);
    const file = new File([zip], "backup.zip", { type: "application/zip" });

    const restored = await zipToSnapshot(file);

    expect(restored.payload.manifest.version).toBe(5);
    expect(restored.payload.templates).toEqual([template]);
  });

  it("round-trips schema 17 formal review-coach facts in a version 6 backup", async () => {
    const coach = completeCoachTestSnapshot();
    const sourceRecord = { ...record("Data Structures"), id: "record-1" };
    const reviewCoachPayload: BackupPayload = {
      ...payload([sourceRecord]),
      manifest: {
        ...payload([sourceRecord]).manifest,
        version: 6,
        counts: {
          ...payload([sourceRecord]).manifest.counts,
          reviewCoach: { decisionBlocks: 1, taskOutcomeEvents: 3, delayedVerifications: 1 },
        },
      },
      reviewCoach: coach,
    };
    const zip = await snapshotToZip({ payload: reviewCoachPayload, assets: [] });
    const file = new File([zip], "backup.zip", { type: "application/zip" });

    const restored = await zipToSnapshot(file);

    expect(restored.payload.manifest.version).toBe(6);
    expect(restored.payload.reviewCoach).toEqual(coach);
    expect(restored.payload.reviewCoach).not.toHaveProperty("decisionBlockStates");
    expect(restored.payload.reviewCoach).not.toHaveProperty("interventionEffectSummaries");
  });

  it("strips prompts, raw provider data, local paths, and podcast audio at the zip boundary", async () => {
    const coach = completeCoachTestSnapshot();
    Object.assign(coach.feedbackInterpretations[0], { systemPrompt: "private system prompt", rawResponse: "private raw response" });
    const privatePayload: BackupPayload = {
      ...payload([]),
      settings: {
        ...payload([]).settings,
        syncFolderName: "D:/private-backups",
        ai: {
          currentProviderId: "provider",
          providers: [{ id: "provider", providerName: "test", baseUrl: "https://example.invalid", model: "test", temperature: 0, maxTokens: 100 }],
          presets: [{ id: "preset", title: "private", prompt: "private full prompt", order: 0, createdAt: stamp, updatedAt: stamp }],
        },
      },
      reviewCoach: coach,
    };
    const podcastAsset = {
      id: "podcast-audio",
      createdAt: stamp,
      updatedAt: stamp,
      fileName: "podcast.mp3",
      mimeType: "audio/mpeg",
      size: 5,
      kind: "audio" as const,
      generatedBy: "knowledge-podcast" as const,
      data: new Blob(["audio"]),
    };
    const zipBlob = await snapshotToZip({ payload: privatePayload, assets: [podcastAsset] });
    const zip = await JSZip.loadAsync(zipBlob);
    const raw = await zip.file("data.json")!.async("string");

    expect(raw).not.toContain("private full prompt");
    expect(raw).not.toContain("private system prompt");
    expect(raw).not.toContain("private raw response");
    expect(raw).not.toContain("D:/private-backups");
    expect(raw).not.toContain("podcast-audio");
    expect(zip.file(/podcast\.mp3$/)).toEqual([]);
  });

  it("round-trips daily plans through a full backup, and preserves their attribution on records", async () => {
    const plan: DailyPlan = {
      id: "plan-1",
      createdAt: stamp,
      updatedAt: stamp,
      date: "2026-06-21",
      subject: "物理",
      title: "力学 10 题",
      order: 0,
      linkedRecordId: "record-物理",
    };
    const withPlan: BackupPayload = {
      ...payload([{ ...record("物理"), planId: plan.id }]),
      manifest: { ...payload([]).manifest, counts: { ...payload([]).manifest.counts, dailyPlans: 1 } },
      dailyPlans: [plan],
    };
    const zipBlob = await snapshotToZip({ payload: withPlan, assets: [] });

    const data = JSON.parse(await (await JSZip.loadAsync(zipBlob)).file("data.json")!.async("string"));

    expect(data.dailyPlans).toEqual([plan]);
    expect(data.manifest.counts.dailyPlans).toBe(1);

    const restored = await zipToSnapshot(new File([zipBlob], "backup.zip", { type: "application/zip" }));
    expect(restored.payload.dailyPlans).toEqual([plan]);
    // The record's own `planId` has to survive too: it is what keeps the
    // "来自计划" label working after the archive is opened elsewhere.
    const restoredRecord = restored.payload.blocks.find(
      (block): block is RecordBlock => block.type === "record" && block.id === "record-物理",
    );
    expect(restoredRecord?.planId).toBe("plan-1");
  });

  it("leaves the daily-plans field absent when the archive predates the feature", async () => {
    const legacy = new JSZip();
    const legacyPayload = { ...payload([record("物理")]) };
    delete (legacyPayload as { dailyPlans?: DailyPlan[] }).dailyPlans;
    legacy.file("data.json", JSON.stringify(legacyPayload, null, 2));

    const restored = await zipToSnapshot(new File([await legacy.generateAsync({ type: "blob" })], "legacy.zip", { type: "application/zip" }));

    // Absent, not `[]`. The restore path reads the difference as "leave this
    // device's plans alone" versus "this snapshot says there are none, delete
    // them", so turning absence into an empty array here would silently wipe
    // every plan on import.
    expect(restored.payload.dailyPlans).toBeUndefined();
    expect("dailyPlans" in restored.payload).toBe(false);
  });
});

const imageAsset = (id: string, bytes: string, overrides: Partial<Asset> = {}): Asset => ({
  id,
  createdAt: stamp,
  updatedAt: stamp,
  fileName: `${id}.png`,
  title: id,
  mimeType: "image/png",
  size: bytes.length,
  kind: "image",
  data: new File([bytes], `${id}.png`, { type: "image/png" }),
  ...overrides,
});

const v7Payload = (): BackupPayload => ({
  ...payload([record("物理")]),
  manifest: {
    ...payload([]).manifest,
    version: 7,
    counts: { ...payload([]).manifest.counts, blocks: 1 },
  },
  knowledge: createKnowledgeEnvelope([]),
});

const assetMeta = (id: string, bytes: string): Omit<Asset, "data"> => {
  const { data: _data, ...meta } = imageAsset(id, bytes);
  return meta;
};

/** Build a v7 archive by hand so a specific defect can be introduced. */
const handcraftV7Archive = async (
  meta: Omit<Asset, "data">,
  options: { bytes?: string; entryBytes?: string; omitEntry?: boolean; breakContainer?: boolean } = {},
) => {
  const bytes = options.bytes ?? "original-image-bytes";
  const declared = JSON.parse(JSON.stringify({
    ...v7Payload(),
    assets: [meta],
    assetChecksums: [{ id: meta.id, hash: await hashBlob(new Blob([bytes], { type: meta.mimeType })), size: meta.size }],
  })) as Record<string, unknown>;
  const zip = new JSZip();
  // `containerForPayload` hashes `{...payload, assets}` exactly as the writer does.
  zip.file("manifest.json", JSON.stringify(containerForPayload(declared as never), null, 2));
  // The checksum is computed from the honest payload; the written payload can then be tampered with
  // on its own, so the mismatch is the defect the reader has to catch.
  const written = options.breakContainer
    ? { ...(JSON.parse(JSON.stringify(declared)) as Record<string, unknown>), blocks: [] }
    : declared;
  zip.file("snapshot-v7.json", JSON.stringify(written, null, 2));
  if (!options.omitEntry) {
    zip.file(`assets/${meta.id}-${meta.fileName}`, new File([options.entryBytes ?? bytes], meta.fileName, { type: meta.mimeType }));
  }
  return new File([await zip.generateAsync({ type: "blob" })], "backup.zip", { type: "application/zip" });
};

describe("backup archive asset integrity", () => {
  it("ZIP-01: a new archive declares every packed asset's bytes and imports with nothing unverified", async () => {
    const asset = imageAsset("a1", "original-image-bytes");
    const zip = await snapshotToZip({ payload: v7Payload(), assets: [asset] });

    const declared = JSON.parse(await (await JSZip.loadAsync(zip)).file("snapshot-v7.json")!.async("string"));
    expect(declared.assetChecksums).toHaveLength(1);
    expect(declared.assetChecksums[0]).toMatchObject({ id: "a1", size: "original-image-bytes".length });

    const restored = await zipToSnapshot(new File([zip], "backup.zip", { type: "application/zip" }));
    expect(restored.assets).toHaveLength(1);
    expect(summarizeSnapshot(restored).unverifiedAssets).toBe(0);
  });

  it("ZIP-02: a declared asset with no archive entry is rejected with its identity", async () => {
    const meta = assetMeta("missing-1", "original-image-bytes");
    const file = await handcraftV7Archive(meta, { omitEntry: true });

    await expect(zipToSnapshot(file)).rejects.toThrow(/资源“missing-1\.png”（ID missing-1）.*缺少对应文件/);
  });

  it("ZIP-03: bytes that no longer match the declaration are rejected even at the same size", async () => {
    const meta = assetMeta("a2", "original-image-bytes");
    const file = await handcraftV7Archive(meta, { entryBytes: "tampered-image-bytes" });

    await expect(zipToSnapshot(file)).rejects.toThrow(/字节内容与声明不一致/);
  });

  it("ZIP-04: a legacy archive without declarations still imports and reports what could not be verified", async () => {
    const meta = assetMeta("legacy-1", "legacy-image-bytes");
    const legacyZip = new JSZip();
    const legacyPayload = { ...payload([record("物理")]), assets: [meta] };
    legacyZip.file("data.json", JSON.stringify(legacyPayload, null, 2));
    legacyZip.file(`assets/${meta.id}-${meta.fileName}`, new File(["legacy-image-bytes"], meta.fileName, { type: meta.mimeType }));

    const restored = await zipToSnapshot(new File([await legacyZip.generateAsync({ type: "blob" })], "legacy.zip", { type: "application/zip" }));

    expect(restored.payload.assetChecksums).toBeUndefined();
    expect(restored.assets).toHaveLength(1);
    expect(summarizeSnapshot(restored).unverifiedAssets).toBe(1);
  });

  it("ZIP-05: generation fails instead of writing an archive that promises a resource it cannot pack", async () => {
    const asset = imageAsset("a3", "original-image-bytes");
    await expect(snapshotToZip({
      payload: v7Payload(),
      assets: [{ ...asset, data: undefined as unknown as Blob }],
    })).rejects.toThrow(/资源“a3\.png”（ID a3）在本机没有可写入的内容/);
  });

  it("ZIP-06: payload bytes that disagree with the container checksum are rejected", async () => {
    const meta = assetMeta("a4", "original-image-bytes");
    const file = await handcraftV7Archive(meta, { breakContainer: true });

    await expect(zipToSnapshot(file)).rejects.toThrow(/校验和不一致/);
  });
});
