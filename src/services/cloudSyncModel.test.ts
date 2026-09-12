import { describe, expect, it, vi } from "vitest";

import type { CloudSyncEntityType, RecordBlock, StorageSnapshot, Tag } from "../types";
import { completeCoachTestSnapshot } from "../features/reviewCoach/reviewCoachTestFixtures";
import { EMPTY_REVIEW_COACH_FORMAL_SNAPSHOT } from "../features/reviewCoach/domain";
import { DEFAULT_SETTINGS, DEFAULT_TAGS } from "../db/defaults";
import {
  CLOUD_DOCUMENT_THRESHOLD_BYTES,
  ASSET_CONTENT_HASH_VERSION,
  BLOCK_CONTENT_HASH_VERSION,
  createCloudPayloadDocument,
  exportCloudSync,
  findConflictingChanges,
  hashValue,
  hasConflictingChanges,
  isBootstrapOnlyCloudData,
  legacyBlockHashPayload,
  legacyEntityHashPayload,
  legacyFnvHashValue,
  materializeCloudSyncSnapshot,
  mergeCloudSyncSmallEntity,
  mergeCloudSyncEntities,
  NON_CONFLICTING_ENTITY_TYPES,
  preserveAssetOperationalFields,
  preserveLocalChangesForCloudWins,
  stripUpdatedAt,
  syncHashPayload,
  withCloudPayloadDocument,
  withDecisionBlockConflictCopies,
} from "./cloudSyncModel";

const stamp = "2026-08-05T00:00:00.000Z";

describe("content hashing", () => {
  it("uses SHA-256 when Web Crypto is unavailable instead of the legacy FNV fallback", async () => {
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, "crypto");
    try {
      Object.defineProperty(globalThis, "crypto", { configurable: true, value: {} });
      const hash = await hashValue({ stable: "payload" });
      expect(hash).toMatch(/^[0-9a-f]{64}$/);
      expect(hash).not.toMatch(/^fnv-/);
    } finally {
      if (descriptor) Object.defineProperty(globalThis, "crypto", descriptor);
      else Reflect.deleteProperty(globalThis, "crypto");
    }
  });

  it("retains a deterministic helper only for legacy FNV migration", () => {
    expect(legacyFnvHashValue({ stable: "payload" })).toMatch(/^fnv-/);
  });
});

const record: RecordBlock = {
  id: "record-1",
  createdAt: stamp,
  updatedAt: stamp,
  type: "record",
  date: "2026-08-05",
  order: 0,
  subject: "OS",
  title: "进程",
  contentHtml: "<p>上下文切换</p>",
  assets: [{ id: "asset-1", title: "diagram", kind: "image" }],
  formulas: [],
  mistakeRefs: [],
  tags: ["重点"],
};

const snapshot: StorageSnapshot = {
  payload: {
    manifest: {
      format: "study-journal",
      version: 5,
      exportedAt: stamp,
      appVersion: "0.1.0",
      counts: { entries: 0, blocks: 1, mistakes: 0, assets: 1, tags: 0, reviews: 0, studySessions: 0 },
    },
    entries: [],
    blocks: [record],
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
  assets: [{
    id: "asset-1",
    createdAt: stamp,
    updatedAt: stamp,
    fileName: "diagram.png",
    mimeType: "image/png",
    size: 12,
    kind: "image",
    data: new Blob(["diagram-data"], { type: "image/png" }),
  }],
};

describe("cloud sync model", () => {
  it("ignores local voice stores when deriving a publish or no-op plan", async () => {
    const baseline = await exportCloudSync(snapshot);
    const withLocalVoiceData = await exportCloudSync({
      ...snapshot,
      voiceRecallSessions: [{ id: "local-session", partial: "private partial" }],
      voiceRecallTurns: [{ id: "local-turn", audio: "private audio" }],
      voiceRecallLocalHistory: [{ id: "local-history", summary: "private summary" }],
    } as never);

    expect(withLocalVoiceData.entities).toEqual(baseline.entities);
    expect(withLocalVoiceData.reviewEvents).toEqual(baseline.reviewEvents);
    expect(JSON.stringify(withLocalVoiceData)).not.toContain("local-session");
  });

  it("round-trips formal review-coach entities without derived projections or AI secrets", async () => {
    const coach = completeCoachTestSnapshot();
    coach.aiRoleConfigs = [{
      id: "ai-role-planner",
      role: "session-planner",
      providerId: "provider-1",
      model: "deep-model",
      enabled: true,
      promptVersion: "session-blueprint-v1",
      policyVersion: "review-coach-policy-v1",
      schemaVersion: 1,
      timeoutMs: 60_000,
      maxRetries: 1,
      maxConcurrency: 1,
      createdAt: stamp,
      updatedAt: stamp,
    }];
    Object.assign(coach.aiRoleConfigs[0], { apiKey: "must-not-sync", systemPrompt: "private prompt", rawResponse: "private response" });
    const withCoach: StorageSnapshot = {
      ...snapshot,
      payload: { ...snapshot.payload, reviewCoach: coach },
    };

    const exported = await exportCloudSync(withCoach);
    const restored = materializeCloudSyncSnapshot(exported.entities, exported.reviewEvents, exported.assetBlobs);

    expect(exported.entities.some((entity) => entity.entityType === "decision-block")).toBe(true);
    expect(exported.entities.some((entity) => entity.entityType === "task-outcome-event")).toBe(true);
    expect(exported.entities.map((entity) => String(entity.entityType))).not.toContain("decision-block-state");
    expect(JSON.stringify(exported.entities)).not.toContain("apiKey");
    expect(JSON.stringify(exported.entities)).not.toContain("private prompt");
    expect(JSON.stringify(exported.entities)).not.toContain("private response");
    expect(restored.payload.reviewCoach).toEqual({
      ...coach,
      aiRoleConfigs: [expect.not.objectContaining({ apiKey: expect.anything(), systemPrompt: expect.anything(), rawResponse: expect.anything() })],
    });
  });

  it("maps every Stage 1-8 formal coach entity type and no derived projection type", async () => {
    const formalTypes = [
      "decision-block",
      "decision-block-archive",
      "decision-block-feedback",
      "feedback-interpretation",
      "analysis-queue-item",
      "analysis-batch",
      "session-blueprint",
      "adaptive-review-task",
      "adaptive-quiz-turn",
      "task-outcome-event",
      "delayed-verification",
      "ai-role-config",
      "legacy-learning-evidence",
      "legacy-knowledge-point",
      "legacy-record-kp-link",
      "legacy-knowledge-relation",
    ] satisfies CloudSyncEntityType[];
    const coach = Object.fromEntries([
      "decisionBlocks", "decisionBlockArchives", "decisionBlockFeedback", "feedbackInterpretations",
      "analysisQueueItems", "analysisBatches", "sessionBlueprints", "adaptiveReviewTasks",
      "adaptiveQuizTurns", "taskOutcomeEvents", "delayedVerifications", "aiRoleConfigs",
      "legacyLearningEvidence", "legacyKnowledgePoints", "legacyRecordKnowledgePointLinks", "legacyKnowledgeRelations",
    ].map((key, index) => [key, [{ id: `formal-${index}`, createdAt: stamp, updatedAt: stamp }]]));

    const exported = await exportCloudSync({
      ...snapshot,
      payload: { ...snapshot.payload, reviewCoach: coach as unknown as typeof EMPTY_REVIEW_COACH_FORMAL_SNAPSHOT },
    });
    const formalTypeSet = new Set<CloudSyncEntityType>(formalTypes);
    const exportedTypes = exported.entities
      .map((entity) => entity.entityType)
      .filter((type) => formalTypeSet.has(type));

    expect(exportedTypes).toEqual(formalTypes);
    expect(exported.entities.map((entity) => String(entity.entityType))).not.toContain("decision-block-state");
    expect(exported.entities.map((entity) => String(entity.entityType))).not.toContain("intervention-effect-summary");
  });

  it("keeps full prompts and knowledge-podcast audio out of cloud payloads", async () => {
    const privateSettings = {
      ...structuredClone(DEFAULT_SETTINGS),
      syncFolderName: "D:/private",
      ai: {
        ...structuredClone(DEFAULT_SETTINGS.ai!),
        presets: [{ ...structuredClone(DEFAULT_SETTINGS.ai!.presets[0]), prompt: "private full prompt" }],
      },
    };
    const exported = await exportCloudSync({
      ...snapshot,
      payload: { ...snapshot.payload, settings: privateSettings },
      assets: [
        ...snapshot.assets,
        {
          ...snapshot.assets[0],
          id: "podcast-audio",
          generatedBy: "knowledge-podcast",
          generatedForPodcastId: "podcast-1",
        },
      ],
    });

    expect(JSON.stringify(exported.entities)).not.toContain("private full prompt");
    expect(JSON.stringify(exported.entities)).not.toContain("D:/private");
    expect(exported.entities.some((entity) => entity.key === "asset:podcast-audio")).toBe(false);
    expect(exported.assetBlobs.size).toBe(1);
  });

  it("retains a full review-coach soft-delete tombstone needed by its archive", async () => {
    const deletedAt = "2026-08-06T00:00:00.000Z";
    const coach = structuredClone(EMPTY_REVIEW_COACH_FORMAL_SNAPSHOT);
    coach.decisionBlocks = [{
      id: "decision-block-deleted",
      recordId: record.id,
      contentVersion: 1,
      position: 0,
      contentUpdatedAt: stamp,
      createdAt: stamp,
      updatedAt: deletedAt,
      deletedAt,
    }];
    coach.decisionBlockArchives = [{
      id: "archive-deleted",
      decisionBlockId: "decision-block-deleted",
      recordId: record.id,
      contentVersion: 1,
      contentHtml: "<p>recoverable</p>",
      archivedAt: deletedAt,
      reason: "deleted",
      idempotencyKey: "archive-delete-operation",
      createdAt: deletedAt,
      updatedAt: deletedAt,
    }];
    const exported = await exportCloudSync({ ...snapshot, payload: { ...snapshot.payload, reviewCoach: coach } });

    const restored = materializeCloudSyncSnapshot(exported.entities, exported.reviewEvents, exported.assetBlobs);

    expect(restored.payload.reviewCoach?.decisionBlocks[0]).toMatchObject({ id: "decision-block-deleted", deletedAt });
    expect(restored.payload.reviewCoach?.decisionBlockArchives[0].contentHtml).toBe("<p>recoverable</p>");
  });

  it("keeps the losing local decision-block body as a formal conflict archive", async () => {
    const localHtml = `<record-decision-block data-decision-block-id="decision-block-1" data-content-version="2" data-created-at="${stamp}" data-updated-at="${stamp}"><p>本机版本</p></record-decision-block>`;
    const remoteHtml = localHtml.replace("本机版本", "云端版本");
    const coach = structuredClone(EMPTY_REVIEW_COACH_FORMAL_SNAPSHOT);
    coach.decisionBlocks = [{
      id: "decision-block-1",
      recordId: record.id,
      contentVersion: 2,
      position: 0,
      contentUpdatedAt: stamp,
      createdAt: stamp,
      updatedAt: stamp,
    }];
    const local = await exportCloudSync({
      ...snapshot,
      payload: { ...snapshot.payload, blocks: [{ ...record, contentHtml: localHtml }], reviewCoach: coach },
    });
    const remote = await exportCloudSync({
      ...snapshot,
      payload: { ...snapshot.payload, blocks: [{ ...record, contentHtml: remoteHtml }], reviewCoach: coach },
    });
    const restored = materializeCloudSyncSnapshot(remote.entities, remote.reviewEvents, remote.assetBlobs);
    const withCopy = withDecisionBlockConflictCopies(restored, local.entities, new Set([`block:${record.id}`]), "2026-09-07T10:00:00.000Z");

    expect(withCopy.payload.blocks[0]).toMatchObject({ contentHtml: remoteHtml });
    expect(withCopy.payload.reviewCoach?.decisionBlockArchives).toEqual([expect.objectContaining({
      decisionBlockId: "decision-block-1",
      contentVersion: 2,
      contentHtml: localHtml,
      reason: "content-conflict",
    })]);
  });

  it("keeps asset bytes out of entity payloads and restores them by content hash", async () => {
    const exported = await exportCloudSync(snapshot);
    const asset = exported.entities.find((entity) => entity.entityType === "asset");

    expect(asset?.payload.data).toBeUndefined();
    expect(typeof asset?.payload.contentHash).toBe("string");
    expect(exported.assetBlobs.size).toBe(1);

    const restored = materializeCloudSyncSnapshot(exported.entities, exported.reviewEvents, exported.assetBlobs);
    expect(restored.assets[0].data).toBe(snapshot.assets[0].data);
    expect(restored.payload.blocks).toEqual([record]);
  });

  it("does not restore an entity marked as deleted by the cloud", async () => {
    const exported = await exportCloudSync(snapshot);
    const block = exported.entities.find((entity) => entity.entityType === "block");
    if (!block) throw new Error("expected block entity");

    const merged = mergeCloudSyncEntities(exported.entities, [{ ...block, deleted: true, payload: {} }]);
    const restored = materializeCloudSyncSnapshot(merged, exported.reviewEvents, exported.assetBlobs);

    expect(restored.payload.blocks).toEqual([]);
  });

  it("moves oversized structured payloads into a content-addressed document reference", async () => {
    const exported = await exportCloudSync(snapshot);
    const block = exported.entities.find((entity) => entity.entityType === "block");
    if (!block) throw new Error("expected block entity");
    const large = { ...block, payload: { ...block.payload, contentHtml: "x".repeat(CLOUD_DOCUMENT_THRESHOLD_BYTES + 1) } };
    // contentHash must be computed the same way entity() computes it (updatedAt stripped first) —
    // createCloudPayloadDocument() re-derives the hash the same way and checks it against this value.
    large.contentHash = await hashValue(stripUpdatedAt(large.payload));

    const document = await createCloudPayloadDocument(large);
    expect(document?.hash).toBe(large.contentHash);
    expect(document?.byteSize).toBeGreaterThan(CLOUD_DOCUMENT_THRESHOLD_BYTES);

    const referenced = withCloudPayloadDocument(large, document!);
    expect(referenced.payload).toEqual({});
    expect(referenced.payloadDocumentHash).toBe(document?.hash);
  });

  it("accepts a legacy FNV large-payload reference only for compatibility migration", async () => {
    const exported = await exportCloudSync(snapshot);
    const block = exported.entities.find((entity) => entity.entityType === "block");
    if (!block) throw new Error("expected block entity");
    const large = {
      ...block,
      payload: { ...block.payload, contentHtml: "x".repeat(CLOUD_DOCUMENT_THRESHOLD_BYTES + 1) },
      contentHashAlgorithm: "fnv1a" as const,
    };
    large.contentHash = legacyFnvHashValue(syncHashPayload("block", large.payload));

    const document = await createCloudPayloadDocument(large);
    expect(document?.hash).toBe(large.contentHash);
  });

  it("computes the same contentHash for an entity re-saved with only updatedAt different", async () => {
    // Simulates re-saving a record where the visible content is identical but updatedAt ticked
    // forward (e.g. before the storageAdapter.ts guard runs, or any future save path that doesn't
    // itself compare old/new content). The sync layer must not see this as a real edit.
    const laterSnapshot: StorageSnapshot = {
      ...snapshot,
      payload: { ...snapshot.payload, blocks: [{ ...record, updatedAt: "2026-08-06T00:00:00.000Z" }] },
    };
    const exportedNow = await exportCloudSync(snapshot);
    const exportedLater = await exportCloudSync(laterSnapshot);
    const blockNow = exportedNow.entities.find((entity) => entity.entityType === "block");
    const blockLater = exportedLater.entities.find((entity) => entity.entityType === "block");

    expect(blockNow?.payload.updatedAt).not.toBe(blockLater?.payload.updatedAt);
    expect(blockNow?.contentHash).toBe(blockLater?.contentHash);
  });

  it("computes a different contentHash when content actually changes even with the same updatedAt", async () => {
    const editedSnapshot: StorageSnapshot = {
      ...snapshot,
      payload: { ...snapshot.payload, blocks: [{ ...record, title: "上下文切换（修订）" }] },
    };
    const exportedOriginal = await exportCloudSync(snapshot);
    const exportedEdited = await exportCloudSync(editedSnapshot);
    const blockOriginal = exportedOriginal.entities.find((entity) => entity.entityType === "block");
    const blockEdited = exportedEdited.entities.find((entity) => entity.entityType === "block");

    expect(blockOriginal?.payload.updatedAt).toBe(blockEdited?.payload.updatedAt);
    expect(blockOriginal?.contentHash).not.toBe(blockEdited?.contentHash);
  });

  it("ignores OCR operational state but keeps OCR results in the asset hash", async () => {
    const running = await exportCloudSync({
      ...snapshot,
      assets: [{
        ...snapshot.assets[0],
        ocrStatus: "running",
        ocrError: "正在识别",
        ocrJobId: "job-1",
        ocrUpdatedAt: "2026-08-06T00:00:00.000Z",
      }],
    });
    const failed = await exportCloudSync({
      ...snapshot,
      assets: [{
        ...snapshot.assets[0],
        ocrStatus: "failed",
        ocrError: "上次 OCR 识别中断，可重新识别。",
        ocrJobId: "job-2",
        ocrUpdatedAt: "2026-08-07T00:00:00.000Z",
      }],
    });
    const summarized = await exportCloudSync({
      ...snapshot,
      assets: [{ ...snapshot.assets[0], ocrResultSummary: { textLength: 12, includedInAi: false, parserVersion: "v1" } }],
    });
    const withText = await exportCloudSync({
      ...snapshot,
      assets: [{ ...snapshot.assets[0], ocrStatus: "done", ocrText: "图片中的文字" }],
    });
    const runningAsset = running.entities.find((entity) => entity.entityType === "asset")!;
    const failedAsset = failed.entities.find((entity) => entity.entityType === "asset")!;
    const summarizedAsset = summarized.entities.find((entity) => entity.entityType === "asset")!;
    const textAsset = withText.entities.find((entity) => entity.entityType === "asset")!;

    expect(runningAsset.contentHashVersion).toBe(ASSET_CONTENT_HASH_VERSION);
    expect(runningAsset.contentHash).toBe(failedAsset.contentHash);
    expect(runningAsset.contentHash).toBe(summarizedAsset.contentHash);
    expect(runningAsset.contentHash).not.toBe(textAsset.contentHash);
  });

  it("normalizes legacy record favorite omission without changing its content hash", async () => {
    const withoutFavorite = { ...record };
    delete (withoutFavorite as Partial<RecordBlock>).favorite;
    const legacyExport = await exportCloudSync({ ...snapshot, payload: { ...snapshot.payload, blocks: [withoutFavorite] } });
    const currentExport = await exportCloudSync({ ...snapshot, payload: { ...snapshot.payload, blocks: [{ ...record, favorite: false }] } });
    const legacyBlock = legacyExport.entities.find((entity) => entity.entityType === "block")!;
    const currentBlock = currentExport.entities.find((entity) => entity.entityType === "block")!;

    expect(currentBlock.contentHashVersion).toBe(BLOCK_CONTENT_HASH_VERSION);
    expect(currentBlock.contentHash).toBe(legacyBlock.contentHash);
    expect(await hashValue(legacyBlockHashPayload(currentBlock.payload))).not.toBe(currentBlock.contentHash);
  });

  it("recognizes a fresh device containing only deterministic bootstrap data", async () => {
    const tags: Tag[] = DEFAULT_TAGS.map((name, index) => ({
      id: `tag-${index}`,
      name,
      createdAt: "2026-08-05T00:00:00.000Z",
      updatedAt: "2026-08-05T00:00:00.000Z",
    }));
    const exported = await exportCloudSync({
      ...snapshot,
      payload: { ...snapshot.payload, blocks: [], tags, settings: { ...DEFAULT_SETTINGS, schemaVersion: 4 } },
      assets: [],
    });
    expect(isBootstrapOnlyCloudData(exported)).toBe(true);
    const edited = await exportCloudSync({
      ...snapshot,
      payload: { ...snapshot.payload, blocks: [], tags, settings: { ...DEFAULT_SETTINGS, theme: "dark", schemaVersion: 4 } },
      assets: [],
    });
    expect(isBootstrapOnlyCloudData(edited)).toBe(false);
  });

  it("can derive the legacy asset hash for old ledger migration", async () => {
    const asset = snapshot.assets[0];
    const payload = { ...asset, data: undefined, ocrStatus: "running", ocrUpdatedAt: "2026-08-06T00:00:00.000Z" };
    const legacy = await hashValue(legacyEntityHashPayload(payload));
    const canonical = await hashValue(syncHashPayload("asset", payload));
    expect(legacy).not.toBe(canonical);
  });

  it("keeps device-local OCR queue state while applying a remote OCR result", async () => {
    const local = (await exportCloudSync({
      ...snapshot,
      assets: [{ ...snapshot.assets[0], ocrStatus: "running", ocrJobId: "desktop-job" }],
    })).entities.find((entity) => entity.entityType === "asset")!;
    const remote = (await exportCloudSync({
      ...snapshot,
      assets: [{ ...snapshot.assets[0], ocrStatus: "done", ocrText: "手机识别结果" }],
    })).entities.find((entity) => entity.entityType === "asset")!;

    const merged = preserveAssetOperationalFields(local, remote);
    expect(merged.payload.ocrText).toBe("手机识别结果");
    expect(merged.payload.ocrStatus).toBe("running");
    expect(merged.payload.ocrJobId).toBe("desktop-job");
    expect(merged.contentHash).toBe(remote.contentHash);
  });

  it("three-way merges settings changes made to different fields", () => {
    const base = { id: "settings", examDate: "2026-12-27", theme: "system", accentColor: "#2f6f5e", lastBackupAt: "old" };
    const local = { entityType: "settings" as const, payload: { ...base, theme: "dark" }, deleted: false };
    const remote = { entityType: "settings" as const, payload: { ...base, accentColor: "#aa0000", lastBackupAt: "new" }, deleted: false };
    const result = mergeCloudSyncSmallEntity(local, remote, base);
    expect(result.conflicts).toEqual([]);
    expect(result.payload.theme).toBe("dark");
    expect(result.payload.accentColor).toBe("#aa0000");
    expect(result.payload.lastBackupAt).toBeUndefined();
  });

  it("ignores legacy AI and TTS payloads when merging settings", () => {
    const base = {
      id: "settings",
      examDate: "2026-12-27",
      theme: "system",
      ai: { currentProviderId: "old-ai", providers: [{ id: "old-ai", model: "old" }] },
      tts: { currentProviderId: "old-tts", providers: [{ id: "old-tts", voice: "old" }] },
    };
    const result = mergeCloudSyncSmallEntity(
      {
        entityType: "settings",
        payload: {
          ...base,
          ai: { currentProviderId: "desktop-ai", providers: [{ id: "desktop-ai", model: "desktop" }] },
          tts: { currentProviderId: "desktop-tts", providers: [{ id: "desktop-tts", voice: "desktop" }] },
        },
        deleted: false,
      },
      {
        entityType: "settings",
        payload: {
          ...base,
          ai: { currentProviderId: "android-ai", providers: [{ id: "android-ai", model: "android" }] },
          tts: { currentProviderId: "android-tts", providers: [{ id: "android-tts", voice: "android" }] },
        },
        deleted: false,
      },
      base,
    );

    expect(result.conflicts).toEqual([]);
    expect(result.payload.ai).toBeUndefined();
    expect(result.payload.tts).toBeUndefined();
    expect(mergeCloudSyncSmallEntity(
      { entityType: "settings", payload: { ...base, tts: { currentProviderId: "desktop" } }, deleted: false },
      { entityType: "settings", payload: { ...base, tts: { currentProviderId: "android" } }, deleted: false },
      undefined,
    )).toEqual({
      payload: expect.not.objectContaining({ ai: expect.anything(), tts: expect.anything() }),
      deleted: false,
      conflicts: [],
    });
  });

  it("reports a field conflict when both sides change the same template field", () => {
    const base = { id: "template-1", createdAt: stamp, title: "原题", contentHtml: "<p>基线</p>" };
    const local = { entityType: "template" as const, payload: { ...base, contentHtml: "<p>本机</p>" }, deleted: false };
    const remote = { entityType: "template" as const, payload: { ...base, contentHtml: "<p>云端</p>" }, deleted: false };
    expect(mergeCloudSyncSmallEntity(local, remote, base).conflicts).toEqual(["contentHtml"]);
  });

  it("applies a remote-only deletion without creating an empty live entity", () => {
    const base = { id: "template-1", createdAt: stamp, title: "原题", contentHtml: "<p>基线</p>" };
    const result = mergeCloudSyncSmallEntity(
      { entityType: "template", payload: base, deleted: false },
      { entityType: "template", payload: {}, deleted: true },
      base,
    );
    expect(result).toEqual({ payload: {}, deleted: true, conflicts: [] });
  });

  it("reports a deletion conflict when the other side edits content", () => {
    const base = { id: "template-1", createdAt: stamp, title: "原题", contentHtml: "<p>基线</p>" };
    const result = mergeCloudSyncSmallEntity(
      { entityType: "template", payload: { ...base, contentHtml: "<p>本机</p>" }, deleted: false },
      { entityType: "template", payload: {}, deleted: true },
      base,
    );
    expect(result.conflicts).toEqual(["contentHtml", "deletedAt"]);
  });

  it("treats template identity edits as conflicts and missing bases conservatively", () => {
    const base = { id: "template-1", createdAt: stamp, title: "原题", contentHtml: "<p>基线</p>" };
    const changedId = mergeCloudSyncSmallEntity(
      { entityType: "template", payload: { ...base, id: "other" }, deleted: false },
      { entityType: "template", payload: { ...base, title: "云端" }, deleted: false },
      base,
    );
    expect(changedId.conflicts).toContain("id");
    expect(mergeCloudSyncSmallEntity(
      { entityType: "settings", payload: { ...base }, deleted: false },
      { entityType: "settings", payload: { ...base, theme: "dark" }, deleted: false },
      undefined,
    ).conflicts).toEqual(["entity"]);
  });

  it("keeps local additions when choosing the cloud version", () => {
    const localAddition = {
      key: "block:local-only",
      entityType: "block" as const,
      entityId: "local-only",
      contentHash: "local-hash",
      payload: { id: "local-only" },
    };
    expect(preserveLocalChangesForCloudWins(
      [localAddition],
      [{ key: "block:cloud", entityType: "block", entityId: "cloud", contentHash: "cloud-hash", payload: { id: "cloud" } }],
      new Set(),
    )).toEqual([localAddition]);
  });

  it("does not carry a local tombstone into an unchanged cloud entity", () => {
    const localDelete = {
      key: "block:record-a",
      entityType: "block" as const,
      entityId: "record-a",
      contentHash: "deleted:old-hash",
      payload: {},
      deleted: true,
    };
    const remoteEntity = {
      key: "block:record-a",
      entityType: "block" as const,
      entityId: "record-a",
      contentHash: "old-hash",
      payload: { id: "record-a", title: "云端记录" },
    };
    expect(preserveLocalChangesForCloudWins([localDelete], [remoteEntity], new Set())).toEqual([]);
  });

  it("ignores device-local sync folder changes during settings merge", () => {
    const base = { id: "settings", theme: "system", syncFolderName: "D:/old" };
    const result = mergeCloudSyncSmallEntity(
      { entityType: "settings", payload: { ...base, syncFolderName: "D:/desktop" }, deleted: false },
      { entityType: "settings", payload: { ...base, syncFolderName: "Android/local" }, deleted: false },
      base,
    );

    expect(result.conflicts).toEqual([]);
  });

  it("converges independent offline formal facts and remains idempotent on duplicate replay", async () => {
    const coachA = structuredClone(EMPTY_REVIEW_COACH_FORMAL_SNAPSHOT);
    coachA.legacyKnowledgePoints = [{
      id: "kp-a", subject: "OS", name: "进程", normalizedKey: "进程", status: "active", createdAt: stamp, updatedAt: stamp,
    }];
    const coachB = structuredClone(EMPTY_REVIEW_COACH_FORMAL_SNAPSHOT);
    coachB.legacyKnowledgePoints = [{
      id: "kp-b", subject: "OS", name: "线程", normalizedKey: "线程", status: "active", createdAt: stamp, updatedAt: stamp,
    }];
    const deviceA = await exportCloudSync({ ...snapshot, payload: { ...snapshot.payload, reviewCoach: coachA } });
    const deviceB = await exportCloudSync({ ...snapshot, payload: { ...snapshot.payload, reviewCoach: coachB } });
    const remote = deviceB.entities.filter((entity) => entity.entityType === "legacy-knowledge-point");
    const once = mergeCloudSyncEntities(deviceA.entities, remote);
    const twice = mergeCloudSyncEntities(once, remote);
    const restored = materializeCloudSyncSnapshot(twice, deviceA.reviewEvents, deviceA.assetBlobs);

    expect(restored.payload.reviewCoach?.legacyKnowledgePoints.map((item) => item.id).sort()).toEqual(["kp-a", "kp-b"]);
    expect(twice.filter((entity) => entity.entityType === "legacy-knowledge-point")).toHaveLength(2);
  });

  it("reports an edit versus delete conflict on the same formal fact", async () => {
    const coach = structuredClone(EMPTY_REVIEW_COACH_FORMAL_SNAPSHOT);
    coach.legacyKnowledgePoints = [{
      id: "kp-conflict", subject: "OS", name: "进程", normalizedKey: "进程", status: "active", createdAt: stamp, updatedAt: stamp,
    }];
    const edited = await exportCloudSync({
      ...snapshot,
      payload: { ...snapshot.payload, reviewCoach: { ...coach, legacyKnowledgePoints: [{ ...coach.legacyKnowledgePoints[0], name: "进程模型" }] } },
    });
    const deleted = await exportCloudSync({
      ...snapshot,
      payload: { ...snapshot.payload, reviewCoach: { ...coach, legacyKnowledgePoints: [{ ...coach.legacyKnowledgePoints[0], deletedAt: stamp }] } },
    });
    const local = edited.entities.filter((entity) => entity.entityType === "legacy-knowledge-point");
    const remote = deleted.entities.filter((entity) => entity.entityType === "legacy-knowledge-point");

    expect(findConflictingChanges(local, remote)).toEqual([{ key: "legacy-knowledge-point:kp-conflict", entityType: "legacy-knowledge-point" }]);
  });

  it("does not preserve a local change for a key changed by the cloud", () => {
    const localEdit = {
      key: "block:record-b",
      entityType: "block" as const,
      entityId: "record-b",
      contentHash: "local-hash",
      payload: { id: "record-b", title: "本机" },
    };
    expect(preserveLocalChangesForCloudWins([localEdit], [localEdit], new Set([localEdit.key]))).toEqual([]);
  });
});

describe("per-entity-key conflict detection", () => {
  // contentHash has no default — every call site must state whether the two sides agree or
  // disagree, so a test can't accidentally pass by relying on a hidden shared default.
  const ent = (key: string, contentHash: string, entityType: CloudSyncEntityType = "block") => ({ key, entityType, contentHash });

  const detectConflict = (
    local: { key: string; entityType: CloudSyncEntityType; contentHash: string }[],
    remote: { key: string; entityType: CloudSyncEntityType; contentHash: string }[],
  ) => {
    const normalLocal = local.filter((e) => !NON_CONFLICTING_ENTITY_TYPES.has(e.entityType));
    const normalRemote = remote.filter((e) => !NON_CONFLICTING_ENTITY_TYPES.has(e.entityType));
    return hasConflictingChanges(normalLocal, normalRemote);
  };

  it("no conflict when both sides edit entirely different entities", () => {
    expect(detectConflict([ent("block:a", "h1")], [ent("block:b", "h2")])).toBe(false);
  });

  it("conflict when the same entity key is modified on both sides with different content", () => {
    expect(detectConflict(
      [ent("block:a", "local-hash")],
      [ent("block:a", "remote-hash"), ent("block:b", "h2")],
    )).toBe(true);
  });

  it("no conflict when local has no normal changes", () => {
    expect(detectConflict([], [ent("block:a", "h1")])).toBe(false);
  });

  it("no conflict when remote has no normal changes", () => {
    expect(detectConflict([ent("block:a", "h1")], [])).toBe(false);
  });

  it("conflict when the overlapping key is not the first entry on either side", () => {
    expect(detectConflict(
      [ent("block:x", "h1"), ent("block:y", "local-y")],
      [ent("block:z", "h2"), ent("block:y", "remote-y")],
    )).toBe(true);
  });

  it("no conflict when only settings is touched on both sides (e.g. autoBackup bookkeeping)", () => {
    expect(detectConflict(
      [ent("settings:settings", "local-settings", "settings")],
      [ent("settings:settings", "remote-settings", "settings")],
    )).toBe(false);
  });

  it("no conflict when only review-state/review-day-stat overlap on both sides", () => {
    expect(detectConflict(
      [ent("review-state:r1", "local-1", "review-state"), ent("review-day-stat:2026-08-05", "local-2", "review-day-stat")],
      [ent("review-state:r1", "remote-1", "review-state"), ent("review-day-stat:2026-08-05", "remote-2", "review-day-stat")],
    )).toBe(false);
  });

  it("still conflicts on a real content overlap even if settings also overlaps", () => {
    expect(detectConflict(
      [ent("block:a", "local-a"), ent("settings:settings", "local-settings", "settings")],
      [ent("block:a", "remote-a"), ent("settings:settings", "remote-settings", "settings")],
    )).toBe(true);
  });

  it("no conflict when the same key has matching hashes on both sides (self-heal after an interrupted publish)", () => {
    // Targets the publish() reordering fix: headRevision can advance before this device's own
    // ledger write for that same publish completes. The next sync then sees its own upload
    // reflected back as a "remote change" with an identical hash — not a real edit conflict, and
    // it must fall through to the normal merge/download path so the ledger gets re-derived.
    expect(detectConflict(
      [ent("block:a", "same-hash")],
      [ent("block:a", "same-hash")],
    )).toBe(false);
  });

  it("conflict when the same key has different hashes on both sides (a genuine concurrent edit)", () => {
    expect(detectConflict(
      [ent("block:a", "local-hash")],
      [ent("block:a", "remote-hash")],
    )).toBe(true);
  });

  it("returns the concrete entity key and type for a content conflict", () => {
    expect(findConflictingChanges(
      [ent("asset:a1", "local-hash", "asset")],
      [ent("asset:a1", "remote-hash", "asset")],
    )).toEqual([{ key: "asset:a1", entityType: "asset" }]);
  });
});
