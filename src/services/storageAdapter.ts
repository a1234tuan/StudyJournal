import { capturePortableKnowledge, restorePortableKnowledge, validateKnowledgeEnvelope } from "../features/knowledgeLibrary/backup";
import { initialKnowledgeScope, knowledgeTables } from "../features/knowledgeLibrary/repository";
import { currentKnowledgeOwner, knowledgeContextGeneration, assertKnowledgeOwner } from "../features/knowledgeLibrary/context";
import { validateBackupPayloadVersion } from "../features/knowledgeLibrary/backupContainer";
import Dexie, { liveQuery } from "dexie";

import { StaleRecordError } from "../lib/uiError";

import type {
  AiChatAttachment,
  AiChatMessage,
  AiChatSession,
  AiSecret,
  AppSettings,
  Asset,
  AutoBackupSettings,
  BackupAssetMeta,
  Block,
  ContentTemplate,
  DailyPlan,
  DayEntry,
  KnowledgePodcast,
  MistakeCard,
  RecordDraft,
  RecordBlock,
  RecordReviewBulkResult,
  RecordReviewDayStat,
  RecordReviewDecisionBlockFeedbackInput,
  RecordReviewLog,
  RecordReviewKind,
  RecordReviewRateResult,
  RecordReviewRating,
  RecordReviewState,
  RecordReviewStats,
  RecordReviewUndoToken,
  RecordSaveOptions,
  ReviewSchedule,
  StorageAdapter,
  RecordTransferSummary,
  StorageSnapshot,
  StreamableBackupSnapshot,
  StreamedAssetReader,
  StreamingImportOptions,
  Subject,
  SubjectConfig,
  StudySession,
  Tag,
} from "../types";
import { db } from "../db/database";
import {
  DEFAULT_SETTINGS,
  DEFAULT_AUTO_BACKUP_STATE,
  DEFAULT_TAGS,
  createDayEntry,
  isCodeBiasedDefaultAiPresetSet,
  isCurrentDefaultAiPresetSet,
  isCurrentDefaultAiPresetSetWithoutModes,
  isLegacyDefaultAiPresetSet,
} from "../db/defaults";
import { addDaysISO, isoDateTimeToLocalDate, nowISO, todayISO } from "../lib/date";
import { hasPlanRecordContent } from "../lib/dailyPlan";
import { createBaseEntity, deepEqualIgnoring, newId, shallowEqual, touch } from "../lib/entity";
import { migrateBlocksToRecords } from "../lib/recordMigration";
import {
  extractRecordRefsFromContent,
  hasLinearRecordNodes,
  renameAssetTitleInContent,
  renameRecordAssetTitle,
  stripRecordAssetRefs,
  syncRecordRefsFromContent,
} from "../lib/recordContent";
import { normalizeRecordTags, sameRecordTags } from "../lib/recordTags";
import { ensureSettingsSubjects, normalizeSubjectName } from "../lib/subjects";
import { normalizeAiConfig } from "../lib/aiProviders";
import { normalizeTtsConfig } from "../lib/ttsProviders";
import {
  EMPTY_REVIEW_COACH_FORMAL_SNAPSHOT,
  type AnalysisQueueItem,
  type DecisionBlockFeedback,
  type ReviewCoachFormalSnapshot,
} from "../features/reviewCoach/domain";
import {
  DexieReviewCoachRepository,
  getReviewCoachFormalSnapshot,
  persistDecisionBlockFeedbackInTransaction,
  rebuildReviewCoachProjectionsInTransaction,
  restoreReviewCoachFormalSnapshot,
  reviewCoachFormalTables,
  reviewCoachRestoreTables,
  purgeReviewCoachFactsForRecord,
  tombstoneDecisionBlockFeedbackInTransaction,
} from "../features/reviewCoach/repository";
import { validateReviewCoachFormalSnapshot } from "../features/reviewCoach/validation";
import { preserveLocalSettings, sanitizeSettingsForExport, stripPrivateExportFields } from "./exportPrivacy";
import { restoreAssetOcrState } from "./assetOcrState";
import { extractDecisionBlocks, prepareDecisionBlockContentForSave } from "../features/reviewCoach/decisionBlockContent";
import {
  DEFAULT_REVIEW_EASE,
  DEFAULT_REVIEW_KIND,
  FSRS_REVIEW_SCHEDULER,
  OVERVIEW_REVIEW_SCHEDULER,
  applyRecordReview,
  createInitialFsrsCard,
  isReviewDueOn,
  normalizeLegacyRating,
  schedulerForKind,
} from "../lib/reviewScheduler";

const assetToMeta = (asset: Asset): BackupAssetMeta => {
  const { data: _data, ...meta } = asset;
  return meta;
};

const normalizeSnapshotRecords = (blocks: Block[]): Block[] =>
  blocks.map((block) => block.type === "record"
    ? syncRecordRefsFromContent({ ...block, mistakeRefs: [] })
    : block,
  );

const normalizeSnapshotRecordDrafts = (drafts: RecordDraft[]): RecordDraft[] =>
  drafts.map((draft) => ({
    ...draft,
    draft: syncRecordRefsFromContent({ ...draft.draft, mistakeRefs: [] }),
  }));

const normalizeSnapshotTemplates = (templates: ContentTemplate[] | undefined): ContentTemplate[] =>
  (templates ?? []).map((template) => ({
    ...template,
    title: template.title?.trim() || "未命名模板",
    contentHtml: template.contentHtml?.trim() || "<p></p>",
  }));

const normalizeSnapshotPodcasts = (podcasts: KnowledgePodcast[] | undefined): KnowledgePodcast[] =>
  (podcasts ?? []).map((podcast) => ({
    ...podcast,
    audioStatus: podcast.generation?.kind === "audio" && podcast.generation.status === "running" ? "partial" : "idle",
    ...(podcast.generation?.status === "running" ? {
      scriptStatus: podcast.generation.kind === "script" ? "failed" as const : podcast.scriptStatus,
      lastError: "上次生成因 APP 关闭或恢复备份而中断，请重新生成。",
      generation: {
        ...podcast.generation,
        status: "failed" as const,
        stage: "failed" as const,
        message: "上次生成因 APP 关闭或恢复备份而中断，请重新生成。",
        updatedAt: nowISO(),
      },
    } : {}),
    segments: podcast.segments.map(({ audioAssetId: _audioAssetId, durationSeconds: _durationSeconds, ...segment }) => ({
      ...segment,
      audioStatus: "pending",
      error: undefined,
    })),
    audioUnits: podcast.audioUnits?.map(({ audioAssetId: _audioAssetId, durationSeconds: _durationSeconds, ...unit }) => ({
      ...unit,
      audioStatus: "pending" as const,
      error: undefined,
    })),
  }));

const reviewCoachCounts = (snapshot: ReviewCoachFormalSnapshot) => Object.fromEntries(
  Object.entries(snapshot).map(([key, values]) => [key, values.length]),
) as Partial<Record<keyof ReviewCoachFormalSnapshot, number>>;

const assertSnapshotIntegrity = (
  blocks: Block[],
  templates: ContentTemplate[],
  assets: Array<Pick<Asset, "id">>,
  drafts: RecordDraft[] = [],
) => {
  const assetIds = new Set<string>();
  for (const asset of assets) {
    if (assetIds.has(asset.id)) {
      throw new Error(`备份数据不完整：资源 ID ${asset.id} 重复。`);
    }
    assetIds.add(asset.id);
  }
  for (const block of blocks) {
    if (block.type !== "record") {
      continue;
    }
    const synced = syncRecordRefsFromContent(block);
    for (const ref of synced.assets) {
      if (!assetIds.has(ref.id)) {
        throw new Error(`备份数据不完整：记录“${block.title}”引用的资源 ${ref.id} 缺失。`);
      }
    }
    if (synced.formulas.length !== block.formulas.length) {
      throw new Error(`备份数据不一致：记录“${block.title}”的公式索引需要重新同步。`);
    }
  }
  for (const template of templates) {
    for (const ref of extractRecordRefsFromContent(template.contentHtml).assets) {
      if (!assetIds.has(ref.id)) {
        throw new Error(`备份数据不完整：模板“${template.title}”引用的资源 ${ref.id} 缺失。`);
      }
    }
  }
  /**
   * Drafts are packed in the archive and their references are reconciled at export exactly like a
   * record's, so an unreconciled draft reference means the archive is inconsistent. Only the asset
   * references are checked: a draft's `formulas` mirror index is rebuilt on normalisation and is not
   * part of what "the archive is complete" means.
   */
  for (const draft of drafts) {
    const block = draft.draft;
    if (!block || block.type !== "record") {
      continue;
    }
    for (const ref of syncRecordRefsFromContent(block).assets) {
      if (!assetIds.has(ref.id)) {
        throw new Error(`备份数据不完整：草稿“${block.title}”引用的资源 ${ref.id} 缺失。`);
      }
    }
  }
};

/**
 * A snapshot may only reference assets it actually packs.
 *
 * Export deliberately omits generated podcast audio, and historical data can also reference assets
 * that no longer exist locally. Either kind of reference made `assertSnapshotIntegrity` reject the
 * snapshot, which permanently blocked every backup channel (manual zip, streaming export, folder
 * backup, repository backup and cloud snapshot all share this code). The exported copy is
 * reconciled instead: a reference whose asset is not packed is dropped from the exported content.
 *
 * The assertion still runs afterwards as a final guard, and it stays fully strict on restore, where
 * the input is untrusted.
 */
const reconcileRecordAssetRefs = (
  record: RecordBlock,
  shouldDrop: (assetId: string) => boolean,
): RecordBlock => {
  const { contentHtml, dropped } = stripRecordAssetRefs(record.contentHtml, shouldDrop);
  if (dropped.length === 0) {
    return record;
  }
  const droppedIds = new Set(dropped);
  // The refs list has to shrink with the content, otherwise re-syncing would re-append the very
  // node that was just dropped (normalizeRecordContent rebuilds refs from `assets` when the
  // content carries no linear record nodes at all).
  return syncRecordRefsFromContent({
    ...record,
    contentHtml,
    assets: record.assets.filter((ref) => !droppedIds.has(ref.id)),
  });
};

const reconcileSnapshotAssetRefs = (params: {
  blocks: Block[];
  templates: ContentTemplate[];
  drafts: RecordDraft[];
  packedAssetIds: ReadonlySet<string>;
  excludedAssetIds: ReadonlySet<string>;
}): { blocks: Block[]; templates: ContentTemplate[]; drafts: RecordDraft[] } => {
  const { packedAssetIds, excludedAssetIds } = params;
  const droppedExcluded: string[] = [];
  const droppedDangling: string[] = [];
  const shouldDrop = (assetId: string): boolean => {
    if (packedAssetIds.has(assetId)) {
      return false;
    }
    (excludedAssetIds.has(assetId) ? droppedExcluded : droppedDangling).push(assetId);
    return true;
  };

  const blocks = params.blocks.map((block) =>
    block.type === "record" ? reconcileRecordAssetRefs(block, shouldDrop) : block,
  );
  const templates = params.templates.map((template) => {
    const { contentHtml, dropped } = stripRecordAssetRefs(template.contentHtml, shouldDrop);
    return dropped.length === 0 ? template : { ...template, contentHtml };
  });
  const drafts = params.drafts.map((draft) => {
    const reconciled = reconcileRecordAssetRefs(draft.draft, shouldDrop);
    return reconciled === draft.draft ? draft : { ...draft, draft: reconciled };
  });

  if (droppedExcluded.length > 0 || droppedDangling.length > 0) {
    console.warn(
      `[backup] 导出已移除 ${droppedExcluded.length} 处播客音频引用（备份格式不包含播客音频）`
      + `、${droppedDangling.length} 处失效资源引用（本机已不存在对应资源）。`,
    );
  }
  return { blocks, templates, drafts };
};

/**
 * Normalize stored rows and reconcile asset references in one step, so the in-memory export
 * (`createSnapshot`) and the streaming export (`createStreamableSnapshot`) cannot drift apart.
 */
const prepareExportContent = (
  blocks: Block[],
  templates: ContentTemplate[],
  drafts: RecordDraft[],
  assets: Asset[],
): { blocks: Block[]; templates: ContentTemplate[]; drafts: RecordDraft[]; backupAssets: Asset[] } => {
  const excludedAssetIds = new Set(
    assets.filter((asset) => asset.generatedBy === "knowledge-podcast").map((asset) => asset.id),
  );
  const backupAssets = assets.filter((asset) => !excludedAssetIds.has(asset.id));
  const reconciled = reconcileSnapshotAssetRefs({
    blocks: normalizeSnapshotRecords(blocks),
    templates: normalizeSnapshotTemplates(templates),
    drafts: normalizeSnapshotRecordDrafts(drafts),
    packedAssetIds: new Set(backupAssets.map((asset) => asset.id)),
    excludedAssetIds,
  });
  return { ...reconciled, backupAssets };
};

export class CloudSyncLocalMutationError extends Error {
  constructor() {
    super("同步期间本机发生了新编辑，未覆盖本地内容，请重新同步。");
    this.name = "CloudSyncLocalMutationError";
  }
}

const cloudSyncMutationEpoch = async (): Promise<number> => {
  const table = (db as typeof db & { cloudSyncMutation?: typeof db.cloudSyncMutation }).cloudSyncMutation;
  if (!table) return 0;
  const record = await table.get("local");
  return record?.epoch ?? 0;
};

const bumpCloudSyncMutationInTransaction = async (): Promise<number> => {
  const table = (db as typeof db & { cloudSyncMutation?: typeof db.cloudSyncMutation }).cloudSyncMutation;
  if (!table) return 0;
  const current = await table.get("local");
  const epoch = (current?.epoch ?? 0) + 1;
  await table.put({ id: "local", epoch });
  return epoch;
};

const markCloudSyncMutation = async (): Promise<number> => {
  const table = (db as typeof db & { cloudSyncMutation?: typeof db.cloudSyncMutation }).cloudSyncMutation;
  if (!table) return 0;
  return typeof db.transaction === "function"
    ? db.transaction("rw", table, bumpCloudSyncMutationInTransaction)
    : bumpCloudSyncMutationInTransaction();
};

const isSuccessfulRecordReviewRating = (rating: RecordReviewRating): boolean => {
  const normalized = normalizeLegacyRating(rating);
  return normalized === "good" || normalized === "easy";
};

const adjustCount = (value: number | undefined, delta: number): number =>
  Math.max(0, (value ?? 0) + delta);

const updateDayStatForRatingCorrection = (
  stat: RecordReviewDayStat,
  previousRating: RecordReviewRating,
  nextRating: RecordReviewRating,
): RecordReviewDayStat => {
  const previous = normalizeLegacyRating(previousRating);
  const next = normalizeLegacyRating(nextRating);
  const rememberedDelta = (isSuccessfulRecordReviewRating(next) ? 1 : 0) - (isSuccessfulRecordReviewRating(previous) ? 1 : 0);
  return {
    ...stat,
    rememberedCount: adjustCount(stat.rememberedCount, rememberedDelta),
    fuzzyCount: adjustCount(stat.fuzzyCount, (next === "fuzzy" ? 1 : 0) - (previous === "fuzzy" ? 1 : 0)),
    forgotCount: adjustCount(stat.forgotCount, (next === "forgot" ? 1 : 0) - (previous === "forgot" ? 1 : 0)),
    goodCount: adjustCount(stat.goodCount, (next === "good" ? 1 : 0) - (previous === "good" ? 1 : 0)),
    easyCount: adjustCount(stat.easyCount, (next === "easy" ? 1 : 0) - (previous === "easy" ? 1 : 0)),
    updatedAt: nowISO(),
  };
};

const normalizeReviewEvaluationText = (value: string | undefined): string | undefined => {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
};

const reviewStateBeforeLog = (current: RecordReviewState, log: RecordReviewLog): RecordReviewState => {
  const previousRating = normalizeLegacyRating(log.normalizedRating ?? log.rating);
  const previousConsecutiveRemembered = log.previousConsecutiveRemembered ??
    (isSuccessfulRecordReviewRating(previousRating)
      ? Math.max(0, current.consecutiveRemembered - 1)
      : current.consecutiveRemembered);
  return {
    ...current,
    easeFactor: log.previousEaseFactor,
    repetition: log.previousRepetition,
    intervalDays: log.previousIntervalDays,
    nextReviewDate: log.previousNextReviewDate,
    lastReviewDate: log.previousLastReviewDate,
    lastReviewedAt: log.previousLastReviewedAt,
    consecutiveRemembered: previousConsecutiveRemembered,
    totalReviews: log.previousTotalReviews ?? Math.max(0, current.totalReviews - 1),
    fsrsCard: log.previousFsrsCard,
  };
};

const isRatingReviewLog = (log: RecordReviewLog) => !log.eventType || log.eventType === "rating";

const isRatingUndoReviewLog = (log: RecordReviewLog) =>
  log.eventType === "rating-undone" && typeof log.revertedEventId === "string";

const activeRatingReviewLogs = (logs: RecordReviewLog[]): RecordReviewLog[] => {
  const undone = new Set(logs.filter(isRatingUndoReviewLog).map((log) => log.revertedEventId));
  return logs.filter((log) => isRatingReviewLog(log) && !undone.has(log.id));
};

const reviewActionLog = (
  eventType: Exclude<NonNullable<RecordReviewLog["eventType"]>, "rating">,
  previous: RecordReviewState | undefined,
  next: RecordReviewState,
): RecordReviewLog => {
  const base = previous ?? next;
  const reviewedAt = nowISO();
  return {
    ...createBaseEntity(),
    recordId: next.recordId,
    rating: "remembered",
    eventType,
    normalizedRating: "good",
    reviewKind: next.reviewKind,
    scheduler: next.scheduler,
    reviewedAt,
    previousEaseFactor: base.easeFactor,
    nextEaseFactor: next.easeFactor,
    previousRepetition: base.repetition,
    nextRepetition: next.repetition,
    previousIntervalDays: base.intervalDays,
    nextIntervalDays: next.intervalDays,
    previousNextReviewDate: base.nextReviewDate,
    nextReviewDate: next.nextReviewDate,
    previousLastReviewDate: base.lastReviewDate,
    previousLastReviewedAt: base.lastReviewedAt,
    previousConsecutiveRemembered: base.consecutiveRemembered,
    previousTotalReviews: base.totalReviews,
    previousFsrsCard: base.fsrsCard,
    nextFsrsCard: next.fsrsCard,
    stateAfter: next,
    updatedAt: reviewedAt,
  };
};

/** A tag name must stay unique locally (&name index). When the cloud merges two
 * same-name rows (two devices created the tag concurrently), keep one deterministic
 * winner so snapshot restores never trip the unique index. */
const dedupeSnapshotTags = (tags: Tag[]): Tag[] => {
  const byName = new Map<string, Tag>();
  for (const tag of tags) {
    const current = byName.get(tag.name);
    if (!current) {
      byName.set(tag.name, tag);
    } else if (current.deletedAt !== undefined && tag.deletedAt === undefined) {
      // Prefer a live row when a soft-deleted row shares the same name.
      byName.set(tag.name, tag);
    } else if (current.deletedAt === undefined && tag.deletedAt !== undefined) {
      // Keep the live row.
    } else if (tag.id < current.id) {
      // Same liveness: smallest id wins so every device picks the same row.
      byName.set(tag.name, tag);
    }
  }
  return [...byName.values()];
};

export class DexieStorageAdapter implements StorageAdapter {
  private initializationPromise?: Promise<void>;

  async getCloudSyncMutationEpoch(): Promise<number> {
    return cloudSyncMutationEpoch();
  }

  async initialize(): Promise<void> {
    if (this.initializationPromise) return this.initializationPromise;
    const initialization = this.initializeOnce();
    this.initializationPromise = initialization;
    try {
      await initialization;
    } finally {
      if (this.initializationPromise === initialization) this.initializationPromise = undefined;
    }
  }

  private async initializeOnce(): Promise<void> {
    await db.open();
    // Staging is only meaningful while the current JS process is committing a
    // restore/import. A previous process cannot resume it safely.
    await db.restoreStagingAssets.clear();
    const settings = await db.settings.get("settings");
    if (!settings) {
      await db.settings.put(DEFAULT_SETTINGS);
    }

    for (const tagName of DEFAULT_TAGS) {
      await this.upsertTag(tagName);
    }

    await this.migrateLegacyBlocks();
    await this.migrateRecordsToLinearContent();
    await this.migrateRecordTags();
    await this.migrateSettingsToDynamicSubjects();
    await this.migrateAiSettings();
    await this.migrateTtsSettings();
    await this.migrateAutoBackupToLocalTable();
    await this.purgeMistakeAndReviewData();
    await this.migrateRecordReviewsToMixedSystem();
    await this.rebuildReviewProjectionFromEvents();
    await this.compactOldReviewLogs();
    await this.restoreKnowledgePodcastAudioReferences();
    // Do not create today's entry during startup. A sync check must observe the
    // last confirmed local snapshot; the entry is created lazily by user flows.
    await this.resetStaleOcrJobs(10 * 60 * 1000);
  }

  /**
   * Cloud sync deliberately excludes generated podcast audio. If an older
   * restore cleared the references on the podcast rows, reconnect them to the
   * local audio assets while keeping the asset data itself untouched.
   */
  private async restoreKnowledgePodcastAudioReferences(): Promise<void> {
    const [podcasts, podcastAssets] = await Promise.all([
      db.knowledgePodcasts.toArray(),
      db.assets.filter((asset) => asset.generatedBy === "knowledge-podcast").toArray(),
    ]);
    if (podcasts.length === 0 || podcastAssets.length === 0) return;

    const assetsByUnit = new Map<string, Asset>();
    for (const asset of podcastAssets) {
      if (asset.generatedForPodcastId && asset.generatedForAudioUnitId) {
        const key = `${asset.generatedForPodcastId}:${asset.generatedForAudioUnitId}`;
        const current = assetsByUnit.get(key);
        if (!current || asset.updatedAt > current.updatedAt) assetsByUnit.set(key, asset);
      }
    }
    if (assetsByUnit.size === 0) return;

    const repaired = podcasts.flatMap((podcast) => {
      let changed = false;
      const audioUnits = podcast.audioUnits?.map((unit) => {
        const asset = assetsByUnit.get(`${podcast.id}:${unit.id}`);
        if (!asset || (unit.audioAssetId === asset.id && unit.audioStatus === "ready")) return unit;
        changed = true;
        return {
          ...unit,
          audioAssetId: asset.id,
          audioStatus: "ready" as const,
          durationSeconds: unit.durationSeconds ?? asset.durationSeconds,
          error: undefined,
        };
      });
      const segments = podcast.segments.map((segment) => {
        const unit = audioUnits?.find((item) => item.kind === "segment" && item.segmentId === segment.id);
        if (!unit?.audioAssetId || (segment.audioAssetId === unit.audioAssetId && segment.audioStatus === "ready")) return segment;
        changed = true;
        return {
          ...segment,
          audioAssetId: unit.audioAssetId,
          audioStatus: "ready" as const,
          durationSeconds: segment.durationSeconds ?? unit.durationSeconds,
          error: undefined,
        };
      });
      if (!changed) return [];
      const readyUnitCount = audioUnits?.filter((unit) => unit.audioStatus === "ready" && unit.audioAssetId).length ?? 0;
      const derivedAudioStatus = audioUnits && audioUnits.length > 0 && readyUnitCount === audioUnits.length
        ? "ready" as const
        : readyUnitCount > 0 ? "partial" as const : podcast.audioStatus;
      const audioStatus = podcast.audioStatus === "generating" || podcast.generation?.status === "running"
        ? podcast.audioStatus
        : derivedAudioStatus;
      return [{ ...podcast, audioUnits, segments, audioStatus, updatedAt: nowISO() }];
    });
    if (repaired.length > 0) await db.knowledgePodcasts.bulkPut(repaired);
  }

  async recoverInterruptedKnowledgePodcastJobs(activePodcastIds: Set<string> = new Set()): Promise<void> {
    const interruptedPodcasts = await db.knowledgePodcasts
      .filter((podcast) => (podcast.scriptStatus === "generating" || podcast.audioStatus === "generating") && !activePodcastIds.has(podcast.id))
      .toArray();
    if (interruptedPodcasts.length === 0) return;
    await db.knowledgePodcasts.bulkPut(interruptedPodcasts.map((podcast) => ({
      ...podcast,
      scriptStatus: podcast.scriptStatus === "generating" ? "failed" as const : podcast.scriptStatus,
      audioStatus: podcast.audioStatus === "generating" ? "partial" as const : podcast.audioStatus,
      segments: podcast.segments.map((segment) => segment.audioStatus === "generating" ? { ...segment, audioStatus: "failed" as const, error: "上次生成被中断，请重试。" } : segment),
      audioUnits: podcast.audioUnits?.map((unit) => unit.audioStatus === "generating" ? { ...unit, audioStatus: "failed" as const, error: "上次生成被中断，请重试。" } : unit),
      lastError: "任务可能已中断，请继续生成或重试失败章节。",
      generation: podcast.generation ? {
        ...podcast.generation,
        status: "failed" as const,
        stage: "failed" as const,
        message: "任务可能已中断，请重新开始。",
        updatedAt: nowISO(),
        heartbeatAt: nowISO(),
      } : undefined,
      updatedAt: nowISO(),
    })));
  }

  private async recordBlocks(): Promise<RecordBlock[]> {
    return (await db.blocks.toArray()).filter((block): block is RecordBlock => block.type === "record");
  }

  private async activeRecord(recordId: string): Promise<RecordBlock | undefined> {
    const block = await db.blocks.get(recordId);
    return block?.type === "record" && !block.deletedAt ? block : undefined;
  }

  private reviewStateForNewCycle(recordId: string, existing?: RecordReviewState, kind: RecordReviewKind = DEFAULT_REVIEW_KIND): RecordReviewState {
    const now = nowISO();
    const nextReviewDate = addDaysISO(todayISO(), 1);
    return {
      ...(existing ?? createBaseEntity()),
      id: recordId,
      recordId,
      status: "active",
      reviewKind: kind,
      scheduler: schedulerForKind(kind),
      easeFactor: DEFAULT_REVIEW_EASE,
      repetition: 0,
      intervalDays: 1,
      nextReviewDate,
      lastReviewDate: existing?.lastReviewDate,
      lastReviewedAt: existing?.lastReviewedAt,
      consecutiveRemembered: 0,
      totalReviews: existing?.totalReviews ?? 0,
      fsrsCard: kind === "memory" ? createInitialFsrsCard(nextReviewDate) : undefined,
      updatedAt: now,
    };
  }

  private async saveRecordReviewAction(
    eventType: Exclude<NonNullable<RecordReviewLog["eventType"]>, "rating">,
    previous: RecordReviewState | undefined,
    next: RecordReviewState,
  ): Promise<void> {
    await markCloudSyncMutation();
    await db.transaction("rw", db.recordReviews, db.recordReviewLogs, async () => {
      await db.recordReviews.put(next);
      await db.recordReviewLogs.put(reviewActionLog(eventType, previous, next));
    });
  }

  private async migrateRecordReviewsToMixedSystem(): Promise<void> {
    const reviews = await db.recordReviews.toArray();
    if (reviews.length === 0) {
      return;
    }

    const logs = activeRatingReviewLogs(await db.recordReviewLogs.toArray());
    const latestLogByRecord = new Map<string, RecordReviewLog>();
    for (const log of logs) {
      const current = latestLogByRecord.get(log.recordId);
      if (!current || current.reviewedAt < log.reviewedAt) {
        latestLogByRecord.set(log.recordId, log);
      }
    }

    const migrated = reviews.map((review) => {
      const reviewKind = review.reviewKind ?? DEFAULT_REVIEW_KIND;
      const scheduler = review.scheduler ?? schedulerForKind(reviewKind);
      const latestLog = latestLogByRecord.get(review.recordId);
      const lastReviewDate = review.lastReviewDate ?? (latestLog ? isoDateTimeToLocalDate(latestLog.reviewedAt) : undefined);
      const fuzzyRepairDate = lastReviewDate ? addDaysISO(lastReviewDate, 21) : undefined;
      const shouldRepairFuzzy =
        review.status === "active" &&
        normalizeLegacyRating(latestLog?.rating ?? "good") === "fuzzy" &&
        Boolean(fuzzyRepairDate) &&
        typeof review.nextReviewDate === "string" &&
        review.nextReviewDate > fuzzyRepairDate!;
      const repairedNextReviewDate = shouldRepairFuzzy && lastReviewDate ? addDaysISO(lastReviewDate, 7) : review.nextReviewDate;
      const nextReviewDate = review.status === "active" && reviewKind === "memory" && !repairedNextReviewDate
        ? addDaysISO(todayISO(), 1)
        : repairedNextReviewDate;
      const intervalDays = shouldRepairFuzzy ? 7 : review.intervalDays;
      const fsrsCard = reviewKind === "memory"
        ? review.fsrsCard ?? (review.status === "active" ? createInitialFsrsCard(nextReviewDate ?? addDaysISO(todayISO(), 1)) : undefined)
        : undefined;

      if (
        review.reviewKind === reviewKind &&
        review.scheduler === scheduler &&
        review.nextReviewDate === nextReviewDate &&
        review.intervalDays === intervalDays &&
        review.fsrsCard === fsrsCard
      ) {
        return review;
      }

      return {
        ...review,
        reviewKind,
        scheduler,
        nextReviewDate,
        intervalDays,
        fsrsCard,
        updatedAt: nowISO(),
      };
    });

    const changed = migrated.some((review, index) => review !== reviews[index]);
    if (changed) {
      await db.recordReviews.bulkPut(migrated);
    }
  }

  /** Rebuild projections from immutable cloud review events without exposing actions as ratings. */
  private async rebuildReviewProjectionFromEvents(): Promise<void> {
    const logs = await db.recordReviewLogs.toArray();
    const undone = new Set(logs.filter(isRatingUndoReviewLog).map((log) => log.revertedEventId));
    const projected = logs.filter((log) => log.stateAfter && (!isRatingReviewLog(log) || !undone.has(log.id)));
    if (projected.length === 0) return;

    const latestStateByRecord = new Map<string, RecordReviewLog>();
    for (const log of projected) {
      const current = latestStateByRecord.get(log.recordId);
      if (!current || `${current.reviewedAt}:${current.updatedAt}` < `${log.reviewedAt}:${log.updatedAt}`) {
        latestStateByRecord.set(log.recordId, log);
      }
    }
    await db.recordReviews.bulkPut([...latestStateByRecord.values()]
      .map((log) => log.stateAfter)
      .filter((state): state is RecordReviewState => Boolean(state)));

    const existingStats = new Map((await db.recordReviewDayStats.toArray()).map((stat) => [stat.date, stat]));
    const finalRatingByRecordDay = new Map<string, RecordReviewLog>();
    for (const log of activeRatingReviewLogs(logs)) {
      const date = isoDateTimeToLocalDate(log.reviewedAt);
      const key = `${log.recordId}:${date}`;
      const current = finalRatingByRecordDay.get(key);
      if (!current || `${current.reviewedAt}:${current.updatedAt}` < `${log.reviewedAt}:${log.updatedAt}`) {
        finalRatingByRecordDay.set(key, log);
      }
    }
    const ratingsByDate = new Map<string, RecordReviewLog[]>();
    for (const log of finalRatingByRecordDay.values()) {
      const date = isoDateTimeToLocalDate(log.reviewedAt);
      ratingsByDate.set(date, [...(ratingsByDate.get(date) ?? []), log]);
    }
    const rebuiltStats = [...ratingsByDate.entries()].map(([date, ratings]) => {
      const existing = existingStats.get(date);
      const count = (rating: RecordReviewRating) => ratings.filter((log) => normalizeLegacyRating(log.normalizedRating ?? log.rating) === rating).length;
      const goodCount = count("good");
      const easyCount = count("easy");
      return {
        ...(existing ?? createBaseEntity()),
        id: date,
        date,
        dueCountAtFirstOpen: existing?.dueCountAtFirstOpen ?? 0,
        reviewedCount: ratings.length,
        rememberedCount: goodCount + easyCount,
        fuzzyCount: count("fuzzy"),
        forgotCount: count("forgot"),
        goodCount,
        easyCount,
        completedAt: existing?.completedAt,
        updatedAt: nowISO(),
      };
    });
    if (rebuiltStats.length > 0) {
      await db.recordReviewDayStats.bulkPut(rebuiltStats);
    }
  }

  private async compactOldReviewLogs(retentionDays = 90): Promise<void> {
    const cutoff = addDaysISO(todayISO(), -retentionDays);
    await db.recordReviewLogs
      .filter((log) => isoDateTimeToLocalDate(log.reviewedAt) < cutoff)
      .delete();
  }

  /**
   * Drop the assets that became unreachable after a record was permanently deleted.
   *
   * Every store that can reference an asset has to be scanned before an asset is declared an
   * orphan. Templates were missing from that list, so an image referenced by both a record and a
   * template was deleted as soon as the record was purged, and the template was left with a
   * dangling reference that blocked export. Podcast audio rows are scanned too: deleting a record
   * that embedded generated audio must not silently break an episode.
   */
  private async cleanupOrphanAssetsForRecord(record: RecordBlock, draft?: RecordDraft): Promise<void> {
    const candidateAssetIds = new Set([
      ...record.assets.map((asset) => asset.id),
      ...(draft?.draft.assets.map((asset) => asset.id) ?? []),
    ]);
    if (candidateAssetIds.size === 0) {
      return;
    }

    const [blocks, drafts, templates, podcasts] = await Promise.all([
      db.blocks.toArray(),
      db.recordDrafts.toArray(),
      db.templates.toArray(),
      db.knowledgePodcasts.toArray(),
    ]);
    const stillReferencedAssetIds = new Set<string>();
    for (const block of blocks) {
      if (block.type !== "record" || block.id === record.id) {
        continue;
      }
      for (const asset of block.assets) {
        if (candidateAssetIds.has(asset.id)) {
          stillReferencedAssetIds.add(asset.id);
        }
      }
    }
    for (const otherDraft of drafts) {
      if (otherDraft.recordId === record.id) {
        continue;
      }
      for (const asset of otherDraft.draft.assets) {
        if (candidateAssetIds.has(asset.id)) {
          stillReferencedAssetIds.add(asset.id);
        }
      }
    }
    for (const template of templates) {
      for (const ref of extractRecordRefsFromContent(template.contentHtml).assets) {
        if (candidateAssetIds.has(ref.id)) {
          stillReferencedAssetIds.add(ref.id);
        }
      }
    }
    for (const podcast of podcasts) {
      const podcastAssetIds = [
        ...podcast.segments.map((segment) => segment.audioAssetId),
        ...(podcast.audioUnits?.map((unit) => unit.audioAssetId) ?? []),
        ...(podcast.pendingAudioCleanupAssetIds ?? []),
      ];
      for (const assetId of podcastAssetIds) {
        if (assetId && candidateAssetIds.has(assetId)) {
          stillReferencedAssetIds.add(assetId);
        }
      }
    }

    const orphanIds = Array.from(candidateAssetIds).filter((id) => !stillReferencedAssetIds.has(id));
    if (orphanIds.length > 0) {
      await db.assets.bulkDelete(orphanIds);
    }
  }

  private async migrateSettingsToDynamicSubjects(): Promise<void> {
    const settings = await this.getSettings();
    const records = await this.recordBlocks();
    const migrated = ensureSettingsSubjects(settings, records);
    const oldSubjects = JSON.stringify(settings.subjects ?? []);
    const nextSubjects = JSON.stringify(migrated.subjects ?? []);
    if (settings.schemaVersion !== 3 || oldSubjects !== nextSubjects) {
      await db.settings.put(migrated);
    }
  }

  private async migrateAiSettings(): Promise<void> {
    const settings = await this.getSettings();
    const defaultAi = DEFAULT_SETTINGS.ai;
    if (!defaultAi) {
      return;
    }
    const currentAi = settings.ai;
    const shouldReplacePresets = !currentAi?.presets?.length ||
      isLegacyDefaultAiPresetSet(currentAi.presets) ||
      isCurrentDefaultAiPresetSetWithoutModes(currentAi.presets) ||
      isCodeBiasedDefaultAiPresetSet(currentAi.presets) ||
      isCurrentDefaultAiPresetSet(currentAi.presets);
    const legacyAi = currentAi as typeof currentAi & { baseUrl?: string; model?: string; providerName?: string };
    const legacyCompatibleAi = legacyAi?.baseUrl === "https://api.deepseek.com/v1" || legacyAi?.model === "deepseek-chat"
      ? {
        ...legacyAi,
        baseUrl: legacyAi.baseUrl === "https://api.deepseek.com/v1" ? "https://api.deepseek.com" : legacyAi.baseUrl,
        model: legacyAi.model === "deepseek-chat" ? "deepseek-v4-flash" : legacyAi.model,
      }
      : legacyAi;
    const nextAi = normalizeAiConfig(
      legacyCompatibleAi,
      shouldReplacePresets ? defaultAi.presets : currentAi?.presets ?? defaultAi.presets,
    );
    if (JSON.stringify(currentAi ?? {}) === JSON.stringify(nextAi)) {
      return;
    }
    await db.settings.put({
      ...settings,
      ai: nextAi,
    });
  }

  private async migrateTtsSettings(): Promise<void> {
    const settings = await this.getSettings();
    const normalized = normalizeTtsConfig(settings.tts);
    if (JSON.stringify(settings.tts ?? {}) !== JSON.stringify(normalized)) {
      await db.settings.put({ ...settings, tts: normalized });
    }

    // Before multi-provider TTS, Fish Audio credentials were stored under the
    // provider id `fish-audio`. Legacy settings now normalize to `default`,
    // while newer profiles may use a generated id. Preserve that local secret
    // when the normalized Fish profile does not have one yet.
    const fishProfile = normalized.providers.find((provider) => provider.providerId === "fish-audio");
    if (!fishProfile || fishProfile.id === "fish-audio") return;
    const [targetSecret, legacySecret] = await Promise.all([
      db.aiSecrets.get(fishProfile.id),
      db.aiSecrets.get("fish-audio"),
    ]);
    if (!targetSecret?.apiKey && legacySecret?.apiKey) {
      await db.aiSecrets.put({ ...legacySecret, id: fishProfile.id });
    }
  }

  private async migrateRecordsToLinearContent(): Promise<void> {
    const blocks = await db.blocks.toArray();
    const migrated = blocks.map((block) => {
      if (block.type !== "record") {
        return block;
      }
      const needsLinearNodes = !hasLinearRecordNodes(block.contentHtml) && (block.assets.length > 0 || block.formulas.length > 0);
      const needsRefSync = hasLinearRecordNodes(block.contentHtml);
      return needsLinearNodes || needsRefSync ? syncRecordRefsFromContent(block) : block;
    });
    const changed = migrated.some((block, index) => block !== blocks[index]);
    if (!changed) {
      return;
    }
    await db.blocks.bulkPut(migrated);
  }

  private async migrateLegacyBlocks(): Promise<void> {
    const settings = await this.getSettings();
    const allBlocks = await db.blocks.toArray();
    const needsMigration = settings.schemaVersion === 1 || allBlocks.some((block) => block.type !== "record");
    if (!needsMigration) {
      return;
    }

    const migratedBlocks = migrateBlocksToRecords(allBlocks);
    await db.transaction("rw", db.blocks, db.settings, async () => {
      await db.blocks.clear();
      await db.blocks.bulkPut(migratedBlocks);
      await db.settings.put({ ...settings, schemaVersion: Math.max(settings.schemaVersion ?? 2, 2) as AppSettings["schemaVersion"] });
    });
  }

  private async purgeMistakeAndReviewData(): Promise<void> {
    const blocks = await db.blocks.toArray();
    const cleanedBlocks = blocks.map((block) =>
      block.type === "record" && (block.mistakeRefs?.length ?? 0) > 0 ? { ...block, mistakeRefs: [] } : block,
    );
    const hasDirtyRecordRefs = cleanedBlocks.some((block, index) => block !== blocks[index]);

    await db.transaction("rw", db.blocks, db.mistakes, db.reviews, async () => {
      await db.mistakes.clear();
      await db.reviews.clear();
      if (hasDirtyRecordRefs) {
        await db.blocks.bulkPut(cleanedBlocks);
      }
    });
  }

  async getSettings(): Promise<AppSettings> {
    return (await db.settings.get("settings")) ?? DEFAULT_SETTINGS;
  }

  async saveSettings(settings: AppSettings): Promise<void> {
    await markCloudSyncMutation();
    await db.settings.put(ensureSettingsSubjects(settings, await this.recordBlocks()));
  }

  async getAutoBackupState(): Promise<AutoBackupSettings> {
    const owner = currentKnowledgeOwner();
    const scope = await db.knowledgeBackupScopes.get(owner);
    if (scope?.autoBackupState) return scope.autoBackupState;
    const row = owner === "deviceGuest" ? await db.autoBackupState.get("autoBackup") : undefined;
    if (row) {
      const { id: _id, ...state } = row;
      return state;
    }
    return { ...DEFAULT_AUTO_BACKUP_STATE };
  }

  async saveAutoBackupState(state: AutoBackupSettings): Promise<void> {
    const owner = currentKnowledgeOwner();
    const generation = knowledgeContextGeneration();
    await db.transaction("rw", [db.knowledgeBackupScopes, db.autoBackupState], async () => {
      const scope = await db.knowledgeBackupScopes.get(owner) ?? initialKnowledgeScope(owner);
      assertKnowledgeOwner(owner, generation);
      await db.knowledgeBackupScopes.put({ ...scope, autoBackupState: state });
      if (owner === "deviceGuest") await db.autoBackupState.put({ id: "autoBackup", ...state });
    });
  }

  private async migrateAutoBackupToLocalTable(): Promise<void> {
    const existing = await db.autoBackupState.get("autoBackup");
    if (existing) return;
    const settings = await db.settings.get("settings") as (AppSettings & { autoBackup?: AutoBackupSettings }) | undefined;
    if (!settings) return;
    const legacy = settings.autoBackup;
    if (!legacy) return;
    await db.autoBackupState.put({ id: "autoBackup", ...legacy });
    const { autoBackup: _removed, ...stripped } = settings as typeof settings & { autoBackup?: unknown };
    await db.settings.put(stripped as AppSettings);
  }

  async saveSubjects(subjects: SubjectConfig[]): Promise<void> {
    const settings = await this.getSettings();
    await this.saveSettings({ ...settings, subjects, schemaVersion: 3 });
  }

  async renameSubject(oldName: Subject, newName: Subject): Promise<void> {
    const normalizedOld = normalizeSubjectName(oldName);
    const normalizedNew = normalizeSubjectName(newName);
    const settings = await this.getSettings();
    const subjects = (settings.subjects ?? []).map((subject) =>
      subject.name === normalizedOld ? { ...subject, name: normalizedNew, updatedAt: nowISO() } : subject,
    );
    const blocks = await db.blocks.toArray();
    const renamedBlocks = blocks.map((block) => {
      if (block.type === "record" && block.subject === normalizedOld) {
        return { ...block, subject: normalizedNew, updatedAt: nowISO() };
      }
      if (block.type === "studySession" && block.subject === normalizedOld) {
        return { ...block, subject: normalizedNew, updatedAt: nowISO() };
      }
      return block;
    });
    const studySessions = await db.studySessions.toArray();
    const renamedStudySessions = studySessions.map((session) =>
      session.subject === normalizedOld ? { ...session, subject: normalizedNew, updatedAt: nowISO() } : session,
    );

    await markCloudSyncMutation();
    await db.transaction("rw", db.settings, db.blocks, db.studySessions, async () => {
      await db.blocks.bulkPut(renamedBlocks);
      await db.studySessions.bulkPut(renamedStudySessions);
      await db.settings.put(
        ensureSettingsSubjects(
          { ...settings, subjects, schemaVersion: 3 },
          renamedBlocks.filter((block): block is RecordBlock => block.type === "record"),
        ),
      );
    });
  }

  async getOrCreateEntry(date: string): Promise<DayEntry> {
    const existing = await db.entries.where("date").equals(date).first();
    if (existing) {
      return existing;
    }
    const entry = createDayEntry(date);
    await markCloudSyncMutation();
    await db.entries.put(entry);
    return entry;
  }

  async listEntries(): Promise<DayEntry[]> {
    return db.entries.orderBy("date").reverse().filter((entry) => !entry.deletedAt).toArray();
  }

  async saveEntry(entry: DayEntry): Promise<DayEntry> {
    const existing = await db.entries.get(entry.id);
    if (
      existing &&
      shallowEqual(
        { date: existing.date, title: existing.title, pinned: existing.pinned, favorite: existing.favorite, summary: existing.summary },
        { date: entry.date, title: entry.title, pinned: entry.pinned, favorite: entry.favorite, summary: entry.summary },
      ) &&
      JSON.stringify(existing.tags) === JSON.stringify(entry.tags)
    ) {
      return existing;
    }
    const saved = touch(entry);
    await markCloudSyncMutation();
    await db.entries.put(saved);
    return saved;
  }

  async listBlocks(date?: string): Promise<Block[]> {
    const collection = date ? db.blocks.where("date").equals(date) : db.blocks.toCollection();
    const blocks = await collection.filter((block) => !block.deletedAt).toArray();
    return blocks.sort((a, b) => a.order - b.order);
  }

  async saveBlock(block: Block, options: RecordSaveOptions = {}): Promise<Block> {
    // Compare against the post-normalization value (after syncRecordRefsFromContent), not the raw
    // incoming param — otherwise the auto-derived assets/formulas would make an unchanged save look
    // "different" and vice versa.
    let normalized = block.type === "record" ? syncRecordRefsFromContent({ ...block, mistakeRefs: [] }) : block;
    const existingBlock = await db.blocks.get(normalized.id);
    const decisionBlockStamp = nowISO();
    const preparedDecisionBlocks = normalized.type === "record"
      ? prepareDecisionBlockContentForSave(
          existingBlock?.type === "record" ? existingBlock.contentHtml : "",
          normalized.contentHtml,
          decisionBlockStamp,
          options.decisionBlockRemovals,
          undefined,
          new Map((options.restoredDecisionBlocks ?? []).map((block) => [block.decisionBlockId, block.contentHtml])),
        )
      : undefined;
    if (normalized.type === "record" && preparedDecisionBlocks) {
      normalized = syncRecordRefsFromContent({
        ...normalized,
        contentHtml: preparedDecisionBlocks.contentHtml,
        mistakeRefs: [],
      });
    }
    const isUnchangedBlock = existingBlock
      && existingBlock.type === normalized.type
      && deepEqualIgnoring(existingBlock, normalized, ["updatedAt"]);
    const saved = isUnchangedBlock ? existingBlock : touch(normalized);
    const hasDecisionBlockWork = Boolean(
      saved.type === "record" && preparedDecisionBlocks && (
        preparedDecisionBlocks.blocks.length > 0 ||
        preparedDecisionBlocks.removals.length > 0 ||
        (existingBlock?.type === "record" && extractDecisionBlocks(existingBlock.contentHtml).length > 0)
      ),
    );
    if (hasDecisionBlockWork && saved.type === "record" && preparedDecisionBlocks && db.decisionBlocks) {
      await new DexieReviewCoachRepository(db).saveRecordWithDecisionBlocks(saved, preparedDecisionBlocks, !isUnchangedBlock, options.expectedRecord);
    } else {
      await db.transaction("rw", [db.blocks, db.recordDrafts, db.cloudSyncMutation], async () => {
        const current = options.expectedRecord ? await db.blocks.get(saved.id) : undefined;
        if (options.expectedRecord && (!current || !deepEqualIgnoring(current, options.expectedRecord, []))) {
          throw new StaleRecordError();
        }
        if (!isUnchangedBlock || saved.type === "studySession") await bumpCloudSyncMutationInTransaction();
        await db.blocks.put(saved);
        if (saved.type === "record") {
          await db.recordDrafts.delete(saved.id);
        }
      });
    }

    if (saved.type === "studySession") {
      const existing = await db.studySessions.where("blockId").equals(saved.id).first();
      const nextSession: StudySession = {
        ...(existing ?? createBaseEntity()),
        date: saved.date,
        subject: saved.subject,
        minutes: saved.minutes,
        note: saved.note,
        blockId: saved.id,
      };
      const isUnchangedSession = existing
        && existing.date === nextSession.date
        && existing.subject === nextSession.subject
        && existing.minutes === nextSession.minutes
        && existing.note === nextSession.note;
      await db.studySessions.put(isUnchangedSession ? existing : touch(nextSession));
    }

    return saved;
  }

  async listTemplates(): Promise<ContentTemplate[]> {
    return db.templates.orderBy("updatedAt").reverse().toArray();
  }

  async saveTemplate(template: ContentTemplate): Promise<ContentTemplate> {
    const normalized = {
      ...template,
      title: template.title.trim() || "未命名模板",
      contentHtml: template.contentHtml.trim() || "<p></p>",
    };
    const existing = await db.templates.get(normalized.id);
    if (existing && shallowEqual({ title: existing.title, contentHtml: existing.contentHtml }, { title: normalized.title, contentHtml: normalized.contentHtml })) {
      return existing;
    }
    const saved = touch(normalized);
    await markCloudSyncMutation();
    await db.templates.put(saved);
    return saved;
  }

  async deleteTemplate(templateId: string): Promise<void> {
    await markCloudSyncMutation();
    await db.templates.delete(templateId);
  }

  async getRecordDraft(recordId: string): Promise<RecordDraft | undefined> {
    return db.recordDrafts.get(recordId);
  }

  async listRecordDrafts(): Promise<RecordDraft[]> {
    return db.recordDrafts.orderBy("updatedAt").reverse().toArray();
  }

  async saveRecordDraft(draft: RecordDraft): Promise<RecordDraft> {
    const saved: RecordDraft = {
      ...draft,
      id: draft.recordId,
      draft: syncRecordRefsFromContent({ ...draft.draft, mistakeRefs: [] }),
      updatedAt: nowISO(),
    };
    await markCloudSyncMutation();
    await db.recordDrafts.put(saved);
    return saved;
  }

  async deleteRecordDraft(recordId: string): Promise<void> {
    await markCloudSyncMutation();
    await db.recordDrafts.delete(recordId);
  }

  async listRecordReviews(): Promise<RecordReviewState[]> {
    return db.recordReviews.toArray();
  }

  async getRecordReview(recordId: string): Promise<RecordReviewState | undefined> {
    return db.recordReviews.get(recordId);
  }

  async listDueRecordReviews(date: string): Promise<RecordReviewState[]> {
    const candidates = await db.recordReviews
      .where("[status+nextReviewDate]")
      .between(["active", Dexie.minKey], ["active", date], true, true)
      .toArray();
    const activeBlocks = new Map((await this.recordBlocks()).filter((record) => !record.deletedAt).map((record) => [record.id, record]));
    return candidates
      .filter((review) => isReviewDueOn(review, date) && activeBlocks.has(review.recordId))
      .sort((a, b) => {
        const byDue = (a.nextReviewDate ?? "").localeCompare(b.nextReviewDate ?? "");
        if (byDue !== 0) {
          return byDue;
        }
        const byKind = (a.reviewKind === "memory" ? 0 : 1) - (b.reviewKind === "memory" ? 0 : 1);
        if (byKind !== 0) {
          return byKind;
        }
        const aRecord = activeBlocks.get(a.recordId);
        const bRecord = activeBlocks.get(b.recordId);
        return (bRecord?.date ?? "").localeCompare(aRecord?.date ?? "") || (aRecord?.order ?? 0) - (bRecord?.order ?? 0);
      });
  }

  async addRecordToReview(recordId: string, kind: RecordReviewKind = DEFAULT_REVIEW_KIND): Promise<RecordReviewState | undefined> {
    const record = await this.activeRecord(recordId);
    if (!record) {
      return undefined;
    }
    const existing = await db.recordReviews.get(recordId);
    if (existing?.status === "active") {
      return existing;
    }
    const saved = this.reviewStateForNewCycle(recordId, existing, kind);
    await this.saveRecordReviewAction(existing ? "reset" : "added", existing, saved);
    return saved;
  }

  async addRecordsToReview(recordIds: string[], kind: RecordReviewKind = DEFAULT_REVIEW_KIND): Promise<RecordReviewBulkResult> {
    const uniqueIds = Array.from(new Set(recordIds));
    const result: RecordReviewBulkResult = { added: 0, reset: 0, skippedActive: 0 };
    for (const recordId of uniqueIds) {
      const record = await this.activeRecord(recordId);
      if (!record) {
        continue;
      }
      const existing = await db.recordReviews.get(recordId);
      if (existing?.status === "active") {
        result.skippedActive += 1;
        continue;
      }
      const saved = this.reviewStateForNewCycle(recordId, existing, kind);
      await this.saveRecordReviewAction(existing ? "reset" : "added", existing, saved);
      if (existing) {
        result.reset += 1;
      } else {
        result.added += 1;
      }
    }
    return result;
  }

  async setRecordReviewKind(recordId: string, kind: RecordReviewKind): Promise<RecordReviewState | undefined> {
    const record = await this.activeRecord(recordId);
    if (!record) {
      return undefined;
    }
    const existing = await db.recordReviews.get(recordId);
    const saved = this.reviewStateForNewCycle(recordId, existing, kind);
    await this.saveRecordReviewAction(existing ? "kind-changed" : "added", existing, saved);
    return saved;
  }

  async resetRecordReview(recordId: string): Promise<RecordReviewState | undefined> {
    const record = await this.activeRecord(recordId);
    if (!record) {
      return undefined;
    }
    const existing = await db.recordReviews.get(recordId);
    const saved = this.reviewStateForNewCycle(recordId, existing, existing?.reviewKind ?? DEFAULT_REVIEW_KIND);
    await this.saveRecordReviewAction("reset", existing, saved);
    return saved;
  }

  async removeRecordFromReview(recordId: string): Promise<RecordReviewState | undefined> {
    const existing = await db.recordReviews.get(recordId);
    if (!existing) {
      return undefined;
    }
    const saved: RecordReviewState = {
      ...existing,
      status: "removed",
      nextReviewDate: undefined,
      updatedAt: nowISO(),
    };
    await this.saveRecordReviewAction("removed", existing, saved);
    return saved;
  }

  async ensureRecordReviewDay(date: string, dueCountAtFirstOpen: number): Promise<RecordReviewDayStat> {
    const existing = await db.recordReviewDayStats.get(date);
    if (existing) {
      return existing;
    }
    const stat: RecordReviewDayStat = {
      ...createBaseEntity(),
      id: date,
      date,
      dueCountAtFirstOpen,
      reviewedCount: 0,
      rememberedCount: 0,
      fuzzyCount: 0,
      forgotCount: 0,
      goodCount: 0,
      easyCount: 0,
    };
    await markCloudSyncMutation();
    await db.recordReviewDayStats.put(stat);
    return stat;
  }

  async rateRecordReview(
    recordId: string,
    rating: RecordReviewRating,
    reviewedAt = nowISO(),
    evaluationText?: string,
    decisionBlockFeedback: readonly RecordReviewDecisionBlockFeedbackInput[] = [],
  ): Promise<RecordReviewRateResult | undefined> {
    const record = await this.activeRecord(recordId);
    const review = await db.recordReviews.get(recordId);
    if (!review || !record || review.status !== "active") {
      if (review) {
        await this.removeRecordFromReview(recordId);
      }
      return undefined;
    }
    const reviewedDate = isoDateTimeToLocalDate(reviewedAt);
    const hasEvaluationTextArgument = arguments.length >= 4;
    const normalizedEvaluationText = normalizeReviewEvaluationText(evaluationText);

    await markCloudSyncMutation();
    const result = await db.transaction(
      "rw",
      [db.blocks, db.recordReviews, db.recordReviewLogs, db.recordReviewDayStats, db.cloudSyncMutation, ...reviewCoachFormalTables(db)],
      async () => {
      const current = await db.recordReviews.get(recordId);
      if (!current || current.status !== "active") {
        return undefined;
      }
      const recordLogs = await db.recordReviewLogs.where("recordId").equals(recordId).toArray();
      const correctionLog = current.lastReviewDate === reviewedDate
        ? activeRatingReviewLogs(recordLogs)
          .filter((log) => isoDateTimeToLocalDate(log.reviewedAt) === reviewedDate)
          .sort((a, b) => b.reviewedAt.localeCompare(a.reviewedAt) || b.updatedAt.localeCompare(a.updatedAt))[0]
        : undefined;
      const baseState = correctionLog
        ? reviewStateBeforeLog(current, correctionLog)
        : current.lastReviewDate === reviewedDate
          ? { ...current, totalReviews: Math.max(0, current.totalReviews - 1) }
          : current;
      const scheduled = applyRecordReview(baseState, rating, reviewedDate, reviewedAt);
      const nextState = { ...scheduled.state, updatedAt: nowISO() };
      const normalizedRating = normalizeLegacyRating(rating);
      const log: RecordReviewLog = {
        ...createBaseEntity(),
        recordId,
        rating,
        eventType: "rating",
        normalizedRating,
        reviewKind: nextState.reviewKind ?? DEFAULT_REVIEW_KIND,
        scheduler: nextState.scheduler ?? schedulerForKind(nextState.reviewKind ?? DEFAULT_REVIEW_KIND),
        evaluationText: hasEvaluationTextArgument ? normalizedEvaluationText : correctionLog?.evaluationText,
        reviewedAt,
        previousEaseFactor: baseState.easeFactor,
        nextEaseFactor: nextState.easeFactor,
        previousRepetition: baseState.repetition,
        nextRepetition: nextState.repetition,
        previousIntervalDays: baseState.intervalDays,
        nextIntervalDays: nextState.intervalDays,
        previousNextReviewDate: baseState.nextReviewDate,
        nextReviewDate: nextState.nextReviewDate,
        previousLastReviewDate: baseState.lastReviewDate,
        previousLastReviewedAt: baseState.lastReviewedAt,
        previousConsecutiveRemembered: baseState.consecutiveRemembered,
        previousTotalReviews: baseState.totalReviews,
        previousFsrsCard: baseState.fsrsCard,
        nextFsrsCard: nextState.fsrsCard,
        stateAfter: nextState,
        updatedAt: nowISO(),
      };
      if (!log.evaluationText) {
        delete log.evaluationText;
      }
      await db.recordReviews.put(nextState);
      await db.recordReviewLogs.put(log);
      const feedbackIds: string[] = [];
      let createdFeedback = false;
      for (const input of decisionBlockFeedback) {
        const comment = input.comment.trim();
        if (!comment) continue;
        const feedback: DecisionBlockFeedback = {
          id: newId(),
          createdAt: reviewedAt,
          updatedAt: reviewedAt,
          decisionBlockId: input.decisionBlockId,
          recordId,
          contentVersion: input.contentVersion,
          reviewLogId: log.id,
          comment,
          includeInAnalysis: input.includeInAnalysis,
          source: "review",
          occurredAt: reviewedAt,
          idempotencyKey: `feedback:${input.operationId}`,
        };
        const queueItem: AnalysisQueueItem | undefined = input.includeInAnalysis ? {
          id: newId(),
          createdAt: reviewedAt,
          updatedAt: reviewedAt,
          decisionBlockId: input.decisionBlockId,
          recordId,
          contentVersion: input.contentVersion,
          feedbackId: feedback.id,
          status: "eligible",
          eligibilityReason: "user-feedback",
        } : undefined;
        const persisted = await persistDecisionBlockFeedbackInTransaction(db, feedback, queueItem);
        feedbackIds.push(persisted.feedback.id);
        createdFeedback ||= persisted.created;
      }
      const existingStat = await db.recordReviewDayStats.get(reviewedDate);
      const stat = existingStat ?? {
        ...createBaseEntity(),
        id: reviewedDate,
        date: reviewedDate,
        dueCountAtFirstOpen: 0,
        reviewedCount: 0,
        rememberedCount: 0,
        fuzzyCount: 0,
        forgotCount: 0,
        goodCount: 0,
        easyCount: 0,
      };
      const nextStat: RecordReviewDayStat = correctionLog && existingStat
        ? updateDayStatForRatingCorrection(stat, correctionLog.normalizedRating ?? correctionLog.rating, normalizedRating)
        : {
          ...stat,
          reviewedCount: stat.reviewedCount + 1,
          rememberedCount: stat.rememberedCount + (normalizedRating === "good" || normalizedRating === "easy" ? 1 : 0),
          fuzzyCount: stat.fuzzyCount + (normalizedRating === "fuzzy" ? 1 : 0),
          forgotCount: stat.forgotCount + (normalizedRating === "forgot" ? 1 : 0),
          goodCount: (stat.goodCount ?? 0) + (normalizedRating === "good" ? 1 : 0),
          easyCount: (stat.easyCount ?? 0) + (normalizedRating === "easy" ? 1 : 0),
          updatedAt: nowISO(),
      };
      await db.recordReviewDayStats.put(nextStat);
      if (createdFeedback) await rebuildReviewCoachProjectionsInTransaction(db);
      return {
        review: nextState,
        undoToken: {
          recordId,
          reviewedAt,
          reviewLogId: log.id,
          previousReview: current,
          previousLog: correctionLog,
          previousDayStat: existingStat,
          decisionBlockFeedbackIds: feedbackIds,
        },
      };
      },
    );

    if (!result) {
      return undefined;
    }
    const remainingDue = await this.listDueRecordReviews(reviewedDate);
    if (remainingDue.length === 0) {
      const stat = await db.recordReviewDayStats.get(reviewedDate);
      if (stat && !stat.completedAt) {
        await db.recordReviewDayStats.put({ ...stat, completedAt: nowISO(), updatedAt: nowISO() });
      }
    }
    return result;
  }

  private async migrateRecordTags(): Promise<void> {
    const [blocks, drafts] = await Promise.all([db.blocks.toArray(), db.recordDrafts.toArray()]);
    const migratedBlocks = blocks.map((block) => {
      if (block.type !== "record") {
        return block;
      }
      const tags = normalizeRecordTags(block.tags);
      return sameRecordTags(block.tags, tags) ? block : { ...block, tags };
    });
    const migratedDrafts = drafts.map((draft) => {
      const tags = normalizeRecordTags(draft.draft.tags);
      return sameRecordTags(draft.draft.tags, tags) ? draft : { ...draft, draft: { ...draft.draft, tags } };
    });
    const blocksChanged = migratedBlocks.some((block, index) => block !== blocks[index]);
    const draftsChanged = migratedDrafts.some((draft, index) => draft !== drafts[index]);
    if (!blocksChanged && !draftsChanged) {
      return;
    }
    await db.transaction("rw", db.blocks, db.recordDrafts, async () => {
      if (blocksChanged) {
        await db.blocks.bulkPut(migratedBlocks);
      }
      if (draftsChanged) {
        await db.recordDrafts.bulkPut(migratedDrafts);
      }
    });
  }

  async undoRecordReview(token: RecordReviewUndoToken): Promise<RecordReviewState | undefined> {
    if (token.recordId !== token.previousReview.recordId) {
      return undefined;
    }

    await markCloudSyncMutation();
    const result = await db.transaction(
      "rw",
      [db.blocks, db.recordReviews, db.recordReviewLogs, db.recordReviewDayStats, db.cloudSyncMutation, ...reviewCoachFormalTables(db)],
      async () => {
      const [current, currentLog, recordLogs] = await Promise.all([
        db.recordReviews.get(token.recordId),
        db.recordReviewLogs.get(token.reviewLogId),
        db.recordReviewLogs.where("recordId").equals(token.recordId).toArray(),
      ]);
      const latestLog = activeRatingReviewLogs(recordLogs)
        .sort((a, b) => b.reviewedAt.localeCompare(a.reviewedAt) || b.updatedAt.localeCompare(a.updatedAt))[0];
      if (
        !current ||
        !currentLog ||
        currentLog.recordId !== token.recordId ||
        currentLog.reviewedAt !== token.reviewedAt ||
        latestLog?.id !== currentLog.id ||
        current.lastReviewedAt !== token.reviewedAt
      ) {
        return undefined;
      }

      await db.recordReviews.put(token.previousReview);
      await db.recordReviewLogs.put({
        ...reviewActionLog("rating-undone", current, token.previousReview),
        revertedEventId: currentLog.id,
      });
      const deletedFeedback = await tombstoneDecisionBlockFeedbackInTransaction(
        db,
        token.decisionBlockFeedbackIds ?? [],
        currentLog.id,
        nowISO(),
      );

      const reviewedDate = isoDateTimeToLocalDate(token.reviewedAt);
      if (token.previousDayStat) {
        await db.recordReviewDayStats.put(token.previousDayStat);
      } else {
        await db.recordReviewDayStats.delete(reviewedDate);
      }
      if (deletedFeedback.length > 0) await rebuildReviewCoachProjectionsInTransaction(db);
      return token.previousReview;
      },
    );
    return result;
  }

  async listRecordReviewLogs(recordId?: string): Promise<RecordReviewLog[]> {
    const logs = recordId
      ? await db.recordReviewLogs.where("recordId").equals(recordId).toArray()
      : await db.recordReviewLogs.toArray();
    return activeRatingReviewLogs(logs).sort((a, b) => b.reviewedAt.localeCompare(a.reviewedAt));
  }

  async getRecordReviewStats(date = todayISO()): Promise<RecordReviewStats> {
    const [reviews, dayStats, logs, dueReviews] = await Promise.all([
      db.recordReviews.toArray(),
      db.recordReviewDayStats.toArray(),
      db.recordReviewLogs.toArray(),
      this.listDueRecordReviews(date),
    ]);
    const ratingLogs = activeRatingReviewLogs(logs);
    const active = reviews.filter((review) => review.status === "active");
    const mastered = reviews.filter((review) => review.status === "mastered");
    const overdueCount = dueReviews.filter((review) => review.nextReviewDate && review.nextReviewDate < date).length;
    const sortedStats = dayStats.sort((a, b) => b.date.localeCompare(a.date));
    const todayReviewed = dayStats.find((stat) => stat.date === date && stat.reviewedCount > 0);
    let streakCursor = todayReviewed ? date : addDaysISO(date, -1);
    let streakDays = 0;
    while (streakCursor) {
      const stat = dayStats.find((item) => item.date === streakCursor);
      if (!stat || stat.reviewedCount <= 0) {
        break;
      }
      streakDays += 1;
      streakCursor = addDaysISO(streakCursor, -1);
    }
    const byDate = new Map<string, { remembered: number; reviewed: number }>();
    for (const log of ratingLogs) {
      const key = isoDateTimeToLocalDate(log.reviewedAt);
      const current = byDate.get(key) ?? { remembered: 0, reviewed: 0 };
      current.reviewed += 1;
      const normalizedRating = log.normalizedRating ?? normalizeLegacyRating(log.rating);
      if (normalizedRating === "good" || normalizedRating === "easy") {
        current.remembered += 1;
      }
      byDate.set(key, current);
    }
    const masteryTrend = Array.from(byDate, ([trendDate, value]) => ({
      date: trendDate,
      rememberedRate: value.reviewed > 0 ? value.remembered / value.reviewed : 0,
      reviewedCount: value.reviewed,
    })).sort((a, b) => a.date.localeCompare(b.date)).slice(-30);

    return {
      activeCount: active.length,
      masteredCount: mastered.length,
      dueCount: dueReviews.length,
      overdueCount,
      totalReviews: dayStats.reduce((sum, s) => sum + s.reviewedCount, 0),
      streakDays,
      todayStat: dayStats.find((stat) => stat.date === date),
      dayStats: sortedStats,
      masteryTrend,
    };
  }

  async deleteBlock(blockId: string): Promise<void> {
    const expectedBlock = await db.blocks.get(blockId);
    if (!expectedBlock) {
      return;
    }
    await db.transaction("rw", [db.blocks, db.recordDrafts, db.recordReviews, db.cloudSyncMutation], async () => {
      const block = await db.blocks.get(blockId);
      if (!block || !deepEqualIgnoring(block, expectedBlock, [])) {
        throw new StaleRecordError();
      }
      if (block.deletedAt !== undefined) return;
      const stamp = nowISO();
      await db.blocks.put({ ...block, deletedAt: stamp, updatedAt: stamp });
      await db.recordDrafts.delete(blockId);
      const review = await db.recordReviews.get(blockId);
      if (review) {
        await db.recordReviews.put({ ...review, status: "removed", nextReviewDate: undefined, updatedAt: stamp });
      }
      await bumpCloudSyncMutationInTransaction();
    });
  }

  async listDeletedBlocks(): Promise<RecordBlock[]> {
    const blocks = (await db.blocks.toArray()).filter(
      (block): block is RecordBlock => block.type === "record" && Boolean(block.deletedAt),
    );
    return blocks.sort((a, b) => (b.deletedAt ?? "").localeCompare(a.deletedAt ?? ""));
  }

  async restoreBlock(blockId: string): Promise<RecordBlock | undefined> {
    const expectedBlock = await db.blocks.get(blockId);
    if (!expectedBlock || expectedBlock.type !== "record") {
      return undefined;
    }
    return db.transaction("rw", [db.blocks, db.cloudSyncMutation], async () => {
      const block = await db.blocks.get(blockId);
      if (!block || block.type !== "record" || !deepEqualIgnoring(block, expectedBlock, [])) {
        throw new StaleRecordError();
      }
      if (block.deletedAt === undefined) return block;
      const { deletedAt: _deletedAt, ...restored } = block;
      const saved = { ...restored, updatedAt: nowISO() };
      await db.blocks.put(saved);
      await bumpCloudSyncMutationInTransaction();
      return saved;
    });
  }

  /**
   * Store scope for physically purging blocks.
   *
   * `templates` and `knowledgePodcasts` are in scope because orphan cleanup has
   * to check every store that can reference an asset before it deletes one.
   */
  private blockPurgeStores() {
    return [
      db.blocks,
      db.recordDrafts,
      db.assets,
      db.templates,
      db.knowledgePodcasts,
      db.studySessions,
      db.recordReviews,
      db.recordReviewLogs,
      db.reviewAnnotationDrafts,
      ...reviewCoachFormalTables(db),
    ];
  }

  /**
   * The actual purge. Must be called from inside a transaction covering
   * `blockPurgeStores()` - Dexie rejects touching a table that is outside the
   * enclosing transaction's scope, so this is deliberately a body, not a method
   * that opens its own transaction. That also lets `reclaimEmptyPlanRecords`
   * widen the scope once instead of nesting transactions.
   */
  private async purgeBlockRows(blocks: Block[]): Promise<void> {
    for (const block of blocks) {
      const draft = await db.recordDrafts.get(block.id);
      await db.blocks.delete(block.id);
      await db.recordDrafts.delete(block.id);
      await db.studySessions.where("blockId").equals(block.id).delete();
      await db.recordReviews.delete(block.id);
      await db.recordReviewLogs.where("recordId").equals(block.id).delete();
      await db.reviewAnnotationDrafts.where("recordId").equals(block.id).delete();
      if (block.type === "record") {
        await purgeReviewCoachFactsForRecord(db, block.id);
        await this.cleanupOrphanAssetsForRecord(block, draft);
      }
    }
  }

  /**
   * Physically delete several blocks in one transaction.
   *
   * Behaviour is item-for-item identical to calling `permanentlyDeleteBlock`
   * once per id, except for two batch properties that matter when the daily-plan
   * reclaim job runs: the cross-store transaction is entered once, and
   * `rebuildProjections()` (which replays every decision block) is invoked once
   * for the whole batch. Reclaiming five empty records used to mean five full
   * decision-block replays.
   */
  async permanentlyDeleteBlocks(blockIds: string[]): Promise<void> {
    if (blockIds.length === 0) {
      return;
    }
    const blocks = (await db.blocks.bulkGet(blockIds)).filter((block): block is Block => Boolean(block));
    if (blocks.length === 0) {
      return;
    }

    await markCloudSyncMutation();
    await db.transaction("rw", this.blockPurgeStores(), async () => {
      await this.purgeBlockRows(blocks);
    });
    if (blocks.some((block) => block.type === "record")) {
      await new DexieReviewCoachRepository(db).rebuildProjections();
    }
  }

  async permanentlyDeleteBlock(blockId: string): Promise<void> {
    await this.permanentlyDeleteBlocks([blockId]);
  }

  async purgeExpiredDeletedBlocks(retentionDays: number): Promise<number> {
    const cutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
    const expired = await db.blocks
      .filter(
        (block): block is RecordBlock =>
          block.type === "record" &&
          Boolean(block.deletedAt) &&
          new Date(block.deletedAt ?? 0).getTime() <= cutoff,
      )
      .toArray();

    if (expired.length > 0) {
      await this.permanentlyDeleteBlocks(expired.map((block) => block.id));
    }
    return expired.length;
  }

  async toggleRecordFavorite(blockId: string, favorite: boolean): Promise<RecordBlock | undefined> {
    return db.transaction("rw", [db.blocks, db.cloudSyncMutation], async () => {
      const block = await db.blocks.get(blockId);
      if (!block || block.type !== "record") {
        return undefined;
      }
      if (block.favorite === favorite) {
        return block;
      }
      const saved = { ...block, favorite, updatedAt: nowISO() };
      await db.blocks.put(saved);
      await bumpCloudSyncMutationInTransaction();
      return saved;
    });
  }

  async reorderBlocks(date: string, blockIds: string[]): Promise<void> {
    await markCloudSyncMutation();
    await db.transaction("rw", db.blocks, async () => {
      for (const [order, blockId] of blockIds.entries()) {
        const block = await db.blocks.get(blockId);
        if (block && block.date === date && block.order !== order) {
          await db.blocks.put({ ...block, order, updatedAt: nowISO() });
        }
      }
    });
  }

  // ---------------------------------------------------------------------------
  // Daily plans
  //
  // Layering discipline (docs/daily-plan-final-plan-2026-09-16.md section 7.4):
  // UI and the reclaim job read the filtered views below; snapshots, cloud sync
  // and backups must read `db.dailyPlans.toArray()` raw, soft-deleted rows
  // included, or deletions stop propagating.
  // ---------------------------------------------------------------------------

  async listDailyPlans(date?: string): Promise<DailyPlan[]> {
    const plans = (await db.dailyPlans.toArray()).filter((plan) => !plan.deletedAt);
    const scoped = date ? plans.filter((plan) => plan.date === date) : plans;
    return scoped.sort((a, b) => a.date.localeCompare(b.date) || a.order - b.order);
  }

  /**
   * Soft-deleted plans only, most recently deleted first.
   *
   * Mirrors `listDeletedBlocks` deliberately, including the shape of the filter.
   * The only legitimate consumer is `buildPlanIndex`, so a log whose plan row was
   * deleted can still render its full "from plan" attribution. It must never feed
   * a list, a statistic or a denominator.
   */
  async listDeletedDailyPlans(): Promise<DailyPlan[]> {
    const plans = (await db.dailyPlans.toArray()).filter((plan) => Boolean(plan.deletedAt));
    return plans.sort((a, b) => (b.deletedAt ?? "").localeCompare(a.deletedAt ?? ""));
  }

  /**
   * Raw row lookup by id, soft-deleted rows included.
   *
   * Callers that need "live plans only" must use `listDailyPlans` - this one
   * deliberately does not hide deleted rows, because attribution and repair both
   * need to see them.
   */
  async getDailyPlan(id: string): Promise<DailyPlan | undefined> {
    return db.dailyPlans.get(id);
  }

  async saveDailyPlan(plan: DailyPlan): Promise<DailyPlan> {
    return db.transaction("rw", db.dailyPlans, db.cloudSyncMutation, async () => {
      const current = await db.dailyPlans.get(plan.id);
      if (current?.deletedAt) throw new Error("计划已删除，不能通过保存恢复。");
      if (current && deepEqualIgnoring(current, plan, ["updatedAt"])) return current;
      const saved = touch(plan);
      await bumpCloudSyncMutationInTransaction();
      await db.dailyPlans.put(saved);
      return saved;
    });
  }

  /**
   * Soft-delete a plan row.
   *
   * Intentionally does nothing else. Logs keep their `planId`, so their
   * attribution label survives, and `DailyPlan.linkedRecordId` is untouched, so
   * restoring the log later still reads as fulfilment. Deleting never cascades.
   */
  async deleteDailyPlan(id: string): Promise<void> {
    await db.transaction("rw", db.dailyPlans, db.cloudSyncMutation, async () => {
      const plan = await db.dailyPlans.get(id);
      if (!plan || plan.deletedAt) return;
      const now = nowISO();
      await bumpCloudSyncMutationInTransaction();
      await db.dailyPlans.put({ ...plan, deletedAt: now, updatedAt: now });
    });
  }

  /**
   * Atomically set (or clear) the plan's link to its log record.
   *
   * On purpose this is not wrapped in a cross-store transaction with the record
   * write: the caller saves the record first and links second, so a failure in
   * between leaves "record exists but unlinked" - which is just an ordinary log,
   * never lost content.
   */
  async linkPlanRecord(planId: string, recordId?: string): Promise<void> {
    await db.transaction("rw", db.dailyPlans, db.cloudSyncMutation, async () => {
      const plan = await db.dailyPlans.get(planId);
      if (!plan || plan.deletedAt || plan.linkedRecordId === recordId) return;
      await bumpCloudSyncMutationInTransaction();
      await db.dailyPlans.put({ ...plan, linkedRecordId: recordId, updatedAt: nowISO() });
    });
  }

  /**
   * Physically reclaim plan-linked records that were never actually written to.
   *
   * "Never written to" means: no readable content, no local draft, and not in the
   * review queue. Any record with a draft flush still in flight must be listed in
   * `skipRecordIds` - the editor commits navigation synchronously and persists
   * the draft asynchronously, so "no draft yet" is timing, not evidence.
   *
   * The read-decide-delete sequence runs inside a single read-write transaction.
   * Dexie serialises transactions over overlapping stores, so a `flushDraft`
   * write cannot land between reading `recordDrafts` and deleting the record -
   * that interleaving is exactly the bug this closes.
   *
   * Soft-deleted plans participate too: a plan that was deleted before its record
   * was ever written leaves an empty shell that would otherwise linger in
   * "recent logs" forever. Their rows are simply not written back.
   *
   * Returns the reclaimed record ids (logged by the caller for diagnosis).
   */
  async reclaimEmptyPlanRecords(options: { planIds?: string[]; skipRecordIds?: string[] } = {}): Promise<string[]> {
    const { planIds, skipRecordIds = [] } = options;
    const skip = new Set(skipRecordIds);

    const reclaimed: string[] = [];
    // One transaction covering the delete scope plus `dailyPlans`. Dexie
    // serialises overlapping read-write transactions, so a `flushDraft` write
    // cannot land between reading `recordDrafts` and deleting the record - that
    // interleaving is exactly the bug this closes. Widening the scope here is
    // what lets the purge body be reused instead of nested.
    await db.transaction("rw", [...this.blockPurgeStores(), db.dailyPlans, db.cloudSyncMutation], async () => {
      const plans = (await db.dailyPlans.toArray())
        .filter((plan) => plan.linkedRecordId && (planIds ? planIds.includes(plan.id) : true));
      const candidates = [...new Set(plans.map((plan) => plan.linkedRecordId!))]
        .filter((recordId) => !skip.has(recordId));
      if (candidates.length === 0) return;
      const assets = await db.assets.toArray();
      const doomed: Block[] = [];
      for (const recordId of candidates) {
        const record = await db.blocks.get(recordId);
        // Missing, not a record, or already soft-deleted: nothing to reclaim here.
        if (!record || record.type !== "record" || record.deletedAt) {
          continue;
        }
        // Re-read inside the transaction so the emptiness verdict cannot be stale.
        const draft = await db.recordDrafts.get(recordId);
        const review = await db.recordReviews.get(recordId);
        const reclaimable = !hasPlanRecordContent(record, { assets })
          && !draft
          && review?.status !== "active";
        if (reclaimable) {
          reclaimed.push(recordId);
          doomed.push(record);
        }
      }
      if (doomed.length === 0) {
        return;
      }
      await bumpCloudSyncMutationInTransaction();
      await this.purgeBlockRows(doomed);
      // Only live plans get written back; writing to a soft-deleted row would
      // produce a pointless mutation and a pointless cloud-sync delta.
      for (const plan of plans) {
        if (plan.deletedAt || !plan.linkedRecordId || !reclaimed.includes(plan.linkedRecordId)) {
          continue;
        }
        await db.dailyPlans.put({ ...plan, linkedRecordId: undefined, updatedAt: nowISO() });
      }
    });
    // Every candidate is a live record, so the projection rebuild is always needed.
    if (reclaimed.length > 0) {
      await new DexieReviewCoachRepository(db).rebuildProjections();
    }
    return reclaimed;
  }

  async listMistakes(): Promise<MistakeCard[]> {
    return [];
  }

  async saveMistake(mistake: MistakeCard): Promise<MistakeCard> {
    return touch(mistake);
  }

  async listDueMistakes(date: string): Promise<MistakeCard[]> {
    void date;
    return [];
  }

  async listReviews(mistakeId?: string): Promise<ReviewSchedule[]> {
    void mistakeId;
    return [];
  }

  async saveReview(review: ReviewSchedule): Promise<ReviewSchedule> {
    return touch(review);
  }

  async listTags(): Promise<Tag[]> {
    return db.tags.orderBy("name").filter((tag) => !tag.deletedAt).toArray();
  }

  async upsertTag(name: string): Promise<Tag> {
    const normalized = name.trim().replace(/^#/, "");
    const existing = await db.tags.where("name").equals(normalized).first();
    if (existing) {
      return existing;
    }
    const tag: Tag = {
      ...createBaseEntity(),
      name: normalized,
    };
    await markCloudSyncMutation();
    await db.tags.put(tag);
    return tag;
  }

  async listStudySessions(): Promise<StudySession[]> {
    return db.studySessions.orderBy("date").reverse().filter((session) => !session.deletedAt).toArray();
  }

  async saveStudySession(session: StudySession): Promise<StudySession> {
    const existing = await db.studySessions.get(session.id);
    if (
      existing &&
      shallowEqual(
        { date: existing.date, subject: existing.subject, minutes: existing.minutes, note: existing.note, blockId: existing.blockId },
        { date: session.date, subject: session.subject, minutes: session.minutes, note: session.note, blockId: session.blockId },
      )
    ) {
      return existing;
    }
    const saved = touch(session);
    await markCloudSyncMutation();
    await db.studySessions.put(saved);
    return saved;
  }

  async saveAsset(file: File, kind: Asset["kind"], title?: string, source?: { generatedBy: "knowledge-podcast"; generatedForPodcastId: string; generatedForAudioUnitId: string }): Promise<Asset> {
    const asset: Asset = {
      ...createBaseEntity(),
      fileName: file.name,
      title: title ?? file.name,
      mimeType: file.type || "application/octet-stream",
      size: file.size,
      kind,
      data: file,
      ...source,
    };
    await db.transaction("rw", db.assets, db.cloudSyncMutation, async () => {
      if (!source) await markCloudSyncMutation();
      await db.assets.put(asset);
    });
    return asset;
  }

  async listKnowledgePodcasts(): Promise<KnowledgePodcast[]> {
    return db.knowledgePodcasts.orderBy("updatedAt").reverse().toArray();
  }

  async getKnowledgePodcast(id: string): Promise<KnowledgePodcast | undefined> {
    return db.knowledgePodcasts.get(id);
  }

  async saveKnowledgePodcast(podcast: KnowledgePodcast): Promise<KnowledgePodcast> {
    const saved = touch(podcast);
    await db.knowledgePodcasts.put(saved);
    return saved;
  }

  async deleteKnowledgePodcast(id: string): Promise<void> {
    const podcast = await db.knowledgePodcasts.get(id);
    const assetIds = Array.from(new Set([
      ...(podcast?.segments.flatMap((segment) => segment.audioAssetId ? [segment.audioAssetId] : []) ?? []),
      ...(podcast?.audioUnits?.flatMap((unit) => unit.audioAssetId ? [unit.audioAssetId] : []) ?? []),
      ...(podcast?.pendingAudioCleanupAssetIds ?? []),
    ]));
    await db.transaction("rw", db.knowledgePodcasts, db.assets, async () => {
      await db.knowledgePodcasts.delete(id);
      for (const assetId of assetIds) {
        const asset = await db.assets.get(assetId);
        if (asset?.generatedBy === "knowledge-podcast") await db.assets.delete(assetId);
      }
    });
  }

  async patchAsset(
    id: string,
    patch: Partial<Omit<Asset, "id" | "data">>,
    options: { mutation?: "content" | "operational" } = {},
  ): Promise<Asset | undefined> {
    const { data: _ignoredData, id: _ignoredId, ...safePatch } = patch as Partial<Asset>;
    const tables = options.mutation === "operational" ? [db.assets] : [db.assets, db.cloudSyncMutation];
    return db.transaction("rw", tables, async () => {
      const existing = await db.assets.get(id);
      if (!existing) {
        return undefined;
      }
      const next = { ...existing, ...safePatch, data: existing.data };
      // Blob fields can't round-trip through JSON, so compare everything except updatedAt/data.
      if (deepEqualIgnoring(existing, next, ["updatedAt", "data"])) {
        return existing;
      }
      const saved = touch(next);
      await db.assets.put(saved);
      if (options.mutation !== "operational") {
        await bumpCloudSyncMutationInTransaction();
      }
      return saved;
    });
  }

  async renameAssetTitle(assetId: string, title: string): Promise<void> {
    const nextTitle = title.trim();
    if (!nextTitle) {
      return;
    }

    await db.transaction("rw", [db.assets, db.blocks, db.recordDrafts, db.templates, db.cloudSyncMutation], async () => {
      const existing = await db.assets.get(assetId);
      if (!existing) {
        return;
      }

      const [blocks, drafts, templates] = await Promise.all([db.blocks.toArray(), db.recordDrafts.toArray(), db.templates.toArray()]);
      const renamedBlocks: Block[] = [];
      const renamedDrafts: RecordDraft[] = [];
      const renamedTemplates: ContentTemplate[] = [];

      for (const block of blocks) {
        if (block.type !== "record") {
          continue;
        }
        const result = renameRecordAssetTitle(block, assetId, nextTitle);
        if (result.changed) {
          renamedBlocks.push(touch(result.record));
        }
      }

      for (const draft of drafts) {
        const result = renameRecordAssetTitle(draft.draft, assetId, nextTitle);
        if (result.changed) {
          renamedDrafts.push({
            ...draft,
            draft: result.record,
            updatedAt: nowISO(),
          });
        }
      }

      for (const template of templates) {
        const result = renameAssetTitleInContent(template.contentHtml, assetId, nextTitle);
        if (result.changed) {
          renamedTemplates.push(touch({ ...template, contentHtml: result.contentHtml }));
        }
      }

      const assetChanged = existing.title !== nextTitle;
      if (!assetChanged && renamedBlocks.length === 0 && renamedDrafts.length === 0 && renamedTemplates.length === 0) {
        return;
      }
      if (assetChanged) {
        await db.assets.put(touch({ ...existing, title: nextTitle, data: existing.data }));
      }
      if (renamedBlocks.length > 0) {
        await db.blocks.bulkPut(renamedBlocks);
      }
      if (renamedDrafts.length > 0) {
        await db.recordDrafts.bulkPut(renamedDrafts);
      }
      if (renamedTemplates.length > 0) {
        await db.templates.bulkPut(renamedTemplates);
      }
      await bumpCloudSyncMutationInTransaction();
    });
  }

  async resetStaleOcrJobs(maxAgeMs: number): Promise<void> {
    const now = Date.now();
    const assets = await db.assets
      .filter((asset) =>
        asset.kind === "image" &&
        (asset.ocrStatus === "queued" || asset.ocrStatus === "running") &&
        Boolean(asset.ocrUpdatedAt) &&
        now - new Date(asset.ocrUpdatedAt ?? 0).getTime() > maxAgeMs,
      )
      .toArray();

    if (assets.length === 0) {
      return;
    }

    await db.assets.bulkPut(
      assets.map((asset) =>
        touch({
          ...asset,
          ocrStatus: "failed",
          ocrError: "上次 OCR 识别中断，可重新识别。",
          ocrUpdatedAt: nowISO(),
        }),
      ),
    );
  }

  async getAsset(id: string): Promise<Asset | undefined> {
    return db.assets.get(id);
  }

  async deleteAsset(id: string): Promise<void> {
    await markCloudSyncMutation();
    await db.assets.delete(id);
  }

  async listAssets(): Promise<Asset[]> {
    return db.assets.toArray();
  }

  async stageRecordTransferAsset(sessionId: string, asset: Asset): Promise<void> {
    await db.restoreStagingAssets.put({
      stagingId: `${sessionId}:${asset.id}`,
      sessionId,
      asset,
    });
  }

  async discardRecordTransfer(sessionId: string): Promise<void> {
    await db.restoreStagingAssets.where("sessionId").equals(sessionId).delete();
  }

  async commitRecordTransfer(sessionId: string, records: RecordBlock[]): Promise<RecordTransferSummary> {
    try {
      await markCloudSyncMutation();
      let importedDecisionBlocks = 0;
      const result = await db.transaction("rw", [db.entries, db.blocks, db.assets, db.settings, db.restoreStagingAssets, db.decisionBlocks], async () => {
        const staged = await db.restoreStagingAssets.where("sessionId").equals(sessionId).toArray();
        const stagedAssets = staged.map((entry) => entry.asset);
        const stagedAssetIds = new Set(stagedAssets.map((asset) => asset.id));
        if (stagedAssetIds.size !== stagedAssets.length) {
          throw new Error("导入资源暂存不完整，已取消导入。");
        }

        const [existingBlocks, existingAssets, settings, existingEntries] = await Promise.all([
          db.blocks.toArray(),
          db.assets.toArray(),
          db.settings.get("settings"),
          db.entries.toArray(),
        ]);
        const existingRecordIds = new Set(existingBlocks.map((block) => block.id));
        const existingAssetIds = new Set(existingAssets.map((asset) => asset.id));
        const importedRecordIds = new Set<string>();
        for (const record of records) {
          if (existingRecordIds.has(record.id) || importedRecordIds.has(record.id)) {
            throw new Error(`导入记录 ID 冲突：${record.title}。`);
          }
          importedRecordIds.add(record.id);
          const synced = syncRecordRefsFromContent({ ...record, mistakeRefs: [] });
          for (const ref of synced.assets) {
            if (!stagedAssetIds.has(ref.id) && !existingAssetIds.has(ref.id)) {
              throw new Error(`导入记录“${record.title}”缺少资源 ${ref.id}。`);
            }
          }
        }
        for (const asset of stagedAssets) {
          if (existingAssetIds.has(asset.id)) {
            throw new Error(`导入资源 ID 冲突：${asset.fileName}。`);
          }
        }

        const activeRecords = existingBlocks.filter((block): block is RecordBlock => block.type === "record" && !block.deletedAt);
        const titleKeys = new Set(activeRecords.map((record) => `${normalizeSubjectName(record.subject)}\u0000${record.title.trim()}`));
        const nextOrderByDate = new Map<string, number>();
        for (const record of activeRecords) {
          nextOrderByDate.set(record.date, Math.max(nextOrderByDate.get(record.date) ?? -1, record.order));
        }
        const imported = [...records]
          .sort((left, right) => left.date.localeCompare(right.date) || left.order - right.order)
          .map((record) => {
            const subject = normalizeSubjectName(record.subject);
            const originalTitle = record.title.trim() || "未命名日志";
            let title = originalTitle;
            let suffix = 1;
            while (titleKeys.has(`${subject}\u0000${title}`)) {
              title = suffix === 1 ? `${originalTitle}（导入副本）` : `${originalTitle}（导入副本 ${suffix}）`;
              suffix += 1;
            }
            titleKeys.add(`${subject}\u0000${title}`);
            const order = (nextOrderByDate.get(record.date) ?? -1) + 1;
            nextOrderByDate.set(record.date, order);
            return syncRecordRefsFromContent({
              ...record,
              subject,
              title,
              order,
              deletedAt: undefined,
              mistakeRefs: [],
              updatedAt: title === record.title ? record.updatedAt : nowISO(),
            });
          })
          .map((record) => {
            const prepared = prepareDecisionBlockContentForSave("", record.contentHtml, nowISO());
            return {
              record: syncRecordRefsFromContent({ ...record, contentHtml: prepared.contentHtml, mistakeRefs: [] }),
              decisionBlocks: prepared.blocks.map((block) => ({
                id: block.decisionBlockId,
                recordId: record.id,
                contentVersion: block.contentVersion,
                position: block.position,
                contentUpdatedAt: block.updatedAt,
                createdAt: block.createdAt,
                updatedAt: block.updatedAt,
              })),
            };
          });
        const importedRecords = imported.map((item) => item.record);
        const decisionBlocks = imported.flatMap((item) => item.decisionBlocks);
        const existingDecisionBlockIds = decisionBlocks.length > 0
          ? new Set((await db.decisionBlocks.toArray()).map((block) => block.id))
          : new Set<string>();
        if (decisionBlocks.some((block) => existingDecisionBlockIds.has(block.id))) {
          throw new Error("导入复习重点 ID 冲突，已取消导入。");
        }
        importedDecisionBlocks = decisionBlocks.length;

        const existingDates = new Set(existingEntries.map((entry) => entry.date));
        const newEntries = Array.from(new Set(importedRecords.map((record) => record.date)))
          .filter((date) => !existingDates.has(date))
          .map((date) => createDayEntry(date));
        const ensuredSettings = ensureSettingsSubjects(
          { ...(settings ?? DEFAULT_SETTINGS), schemaVersion: 4 },
          [...activeRecords, ...importedRecords],
        );
        // Subject normalization must not roll a current database schema back.
        const nextSettings = {
          ...ensuredSettings,
          schemaVersion: settings?.schemaVersion ?? 4,
        };

        const writes: Promise<unknown>[] = [
          db.entries.bulkPut(newEntries),
          db.blocks.bulkPut(importedRecords),
          db.assets.bulkPut(stagedAssets),
          db.settings.put(nextSettings),
          db.restoreStagingAssets.where("sessionId").equals(sessionId).delete(),
        ];
        if (decisionBlocks.length > 0) writes.push(db.decisionBlocks.bulkPut(decisionBlocks));
        await Promise.all(writes);

        return {
          records: importedRecords.length,
          assets: stagedAssets.length,
          images: stagedAssets.filter((asset) => asset.kind === "image").length,
          audio: stagedAssets.filter((asset) => asset.kind === "audio").length,
          attachments: stagedAssets.filter((asset) => asset.kind === "attachment").length,
          subjects: new Set(importedRecords.map((record) => record.subject)).size,
        };
      });
      if (importedDecisionBlocks > 0) {
        await new DexieReviewCoachRepository(db).rebuildProjections();
      }
      return result;
    } catch (error) {
      await this.discardRecordTransfer(sessionId);
      throw error;
    }
  }

  async createSnapshot(includeKnowledge = true): Promise<StorageSnapshot> {
    const owner = currentKnowledgeOwner();
    const ownerGeneration = knowledgeContextGeneration();
    const snapshot = await db.transaction(
      "r",
      [db.entries, db.blocks, db.templates, db.tags, db.studySessions, db.settings, db.assets, db.recordDrafts, db.recordReviews, db.recordReviewLogs, db.recordReviewDayStats, db.knowledgePodcasts, db.dailyPlans, ...reviewCoachFormalTables(db), ...(includeKnowledge ? knowledgeTables(db) : [])],
      async () => {
        const [entries, blocks, templates, tags, studySessions, settings, assets, recordDrafts, recordReviews, recordReviewLogs, recordReviewDayStats, podcasts, reviewCoach, dailyPlans] = await Promise.all([
          db.entries.toArray(),
          db.blocks.toArray(),
          db.templates.toArray(),
          db.tags.toArray(),
          db.studySessions.toArray(),
          db.settings.get("settings"),
          db.assets.toArray(),
          db.recordDrafts.toArray(),
          db.recordReviews.toArray(),
          db.recordReviewLogs.toArray(),
          db.recordReviewDayStats.toArray(),
          db.knowledgePodcasts.toArray(),
          getReviewCoachFormalSnapshot(db),
          // Raw table, soft-deleted rows included: tombstones have to travel or
          // deletions stop propagating to other devices.
          db.dailyPlans.toArray(),
        ]);
        const knowledge = includeKnowledge ? await capturePortableKnowledge(db, owner) : undefined;
        assertKnowledgeOwner(owner, ownerGeneration);
        return { entries, blocks, templates, tags, studySessions, settings: settings ?? DEFAULT_SETTINGS, assets, recordDrafts, recordReviews, recordReviewLogs, recordReviewDayStats, podcasts, reviewCoach, dailyPlans, knowledge };
      },
    );
    const { blocks: cleanedBlocks, templates: cleanedTemplates, drafts: cleanedDrafts, backupAssets } =
      prepareExportContent(snapshot.blocks, snapshot.templates, snapshot.recordDrafts, snapshot.assets);
    assertSnapshotIntegrity(cleanedBlocks, cleanedTemplates, backupAssets);

    return {
      payload: {
        manifest: {
          format: "study-journal",
          version: includeKnowledge ? 7 : 6,
          exportedAt: nowISO(),
          appVersion: "0.1.0",
          counts: {
            entries: snapshot.entries.length,
            blocks: cleanedBlocks.length,
            mistakes: 0,
            assets: backupAssets.length,
            tags: snapshot.tags.length,
            reviews: 0,
            studySessions: snapshot.studySessions.length,
            recordReviews: snapshot.recordReviews.length,
            recordReviewLogs: snapshot.recordReviewLogs.length,
            recordReviewDayStats: snapshot.recordReviewDayStats.length,
            templates: cleanedTemplates.length,
            dailyPlans: snapshot.dailyPlans.length,
            reviewCoach: reviewCoachCounts(snapshot.reviewCoach),
          },
        },
        ...(snapshot.knowledge ? { knowledge: snapshot.knowledge } : {}),
        entries: snapshot.entries,
        blocks: cleanedBlocks,
        templates: cleanedTemplates,
        recordDrafts: cleanedDrafts,
        mistakes: [],
        tags: snapshot.tags,
        reviews: [],
        recordReviews: snapshot.recordReviews,
        recordReviewLogs: snapshot.recordReviewLogs,
        recordReviewDayStats: snapshot.recordReviewDayStats,
        studySessions: snapshot.studySessions,
        settings: sanitizeSettingsForExport(ensureSettingsSubjects({ ...snapshot.settings, schemaVersion: 4 }, cleanedBlocks.filter((block): block is RecordBlock => block.type === "record"))),
        podcasts: normalizeSnapshotPodcasts(snapshot.podcasts),
        // Always written, even as an empty array, so every new snapshot carries
        // the field and restore can tell "old snapshot" from "plans cleared".
        dailyPlans: snapshot.dailyPlans,
        reviewCoach: stripPrivateExportFields(snapshot.reviewCoach),
      },
      assets: backupAssets,
      recordDrafts: cleanedDrafts,
    };
  }

  async createCloudSyncSnapshot(): Promise<StorageSnapshot> {
    return this.createSnapshot(false);
  }

  async createStreamableSnapshot(): Promise<StreamableBackupSnapshot> {
    const owner = currentKnowledgeOwner();
    const ownerGeneration = knowledgeContextGeneration();
    const includeKnowledge = true;
    const snapshot = await db.transaction(
      "r",
      [db.entries, db.blocks, db.templates, db.tags, db.studySessions, db.settings, db.assets, db.recordDrafts, db.recordReviews, db.recordReviewLogs, db.recordReviewDayStats, db.knowledgePodcasts, db.dailyPlans, ...reviewCoachFormalTables(db), ...(includeKnowledge ? knowledgeTables(db) : [])],
      async () => {
        const [entries, blocks, templates, tags, studySessions, settings, assets, recordDrafts, recordReviews, recordReviewLogs, recordReviewDayStats, podcasts, reviewCoach, dailyPlans] = await Promise.all([
          db.entries.toArray(),
          db.blocks.toArray(),
          db.templates.toArray(),
          db.tags.toArray(),
          db.studySessions.toArray(),
          db.settings.get("settings"),
          db.assets.toArray(),
          db.recordDrafts.toArray(),
          db.recordReviews.toArray(),
          db.recordReviewLogs.toArray(),
          db.recordReviewDayStats.toArray(),
          db.knowledgePodcasts.toArray(),
          getReviewCoachFormalSnapshot(db),
          db.dailyPlans.toArray(),
        ]);
        const knowledge = includeKnowledge ? await capturePortableKnowledge(db, owner) : undefined;
        assertKnowledgeOwner(owner, ownerGeneration);
        return { entries, blocks, templates, tags, studySessions, settings: settings ?? DEFAULT_SETTINGS, assets, recordDrafts, recordReviews, recordReviewLogs, recordReviewDayStats, podcasts, reviewCoach, dailyPlans, knowledge };
      },
    );
    const { blocks: cleanedBlocks, templates: cleanedTemplates, drafts: cleanedDrafts, backupAssets } =
      prepareExportContent(snapshot.blocks, snapshot.templates, snapshot.recordDrafts, snapshot.assets);
    const assets = backupAssets.map(assetToMeta);
    assertSnapshotIntegrity(cleanedBlocks, cleanedTemplates, assets);

    return {
      payload: {
        manifest: {
          format: "study-journal",
          version: includeKnowledge ? 7 : 6,
          exportedAt: nowISO(),
          appVersion: "0.1.0",
          counts: {
            entries: snapshot.entries.length,
            blocks: cleanedBlocks.length,
            mistakes: 0,
            assets: assets.length,
            tags: snapshot.tags.length,
            reviews: 0,
            studySessions: snapshot.studySessions.length,
            recordReviews: snapshot.recordReviews.length,
            recordReviewLogs: snapshot.recordReviewLogs.length,
            recordReviewDayStats: snapshot.recordReviewDayStats.length,
            templates: cleanedTemplates.length,
            dailyPlans: snapshot.dailyPlans.length,
            reviewCoach: reviewCoachCounts(snapshot.reviewCoach),
          },
        },
        ...(snapshot.knowledge ? { knowledge: snapshot.knowledge } : {}),
        entries: snapshot.entries,
        blocks: cleanedBlocks,
        templates: cleanedTemplates,
        recordDrafts: cleanedDrafts,
        mistakes: [],
        tags: snapshot.tags,
        reviews: [],
        recordReviews: snapshot.recordReviews,
        recordReviewLogs: snapshot.recordReviewLogs,
        recordReviewDayStats: snapshot.recordReviewDayStats,
        studySessions: snapshot.studySessions,
        settings: sanitizeSettingsForExport(ensureSettingsSubjects({ ...snapshot.settings, schemaVersion: 4 }, cleanedBlocks.filter((block): block is RecordBlock => block.type === "record"))),
        podcasts: normalizeSnapshotPodcasts(snapshot.podcasts),
        dailyPlans: snapshot.dailyPlans,
        reviewCoach: stripPrivateExportFields(snapshot.reviewCoach),
      },
      assets,
      recordDrafts: cleanedDrafts,
    };
  }

  private async restoreSnapshotData(
    snapshot: StorageSnapshot,
    expectedEpoch?: number,
    options: {
      preservePodcasts?: boolean;
      preserveLocalSettings?: boolean;
      clearLocalAnnotationDrafts?: boolean;
      clearLocalVoiceRecallTransient?: boolean;
      restoreSessionId?: string;
      /**
       * Runs inside the same transaction that replaces the local data, after the data writes.
       *
       * Cloud recovery keeps two pieces of bookkeeping — the sync ledger and the pull cursor — that
       * describe exactly the dataset being written here. Committing them in a separate transaction
       * leaves a window where the device holds the restored data but still advertises the old
       * cursor, which makes the next sync re-publish or re-download the whole dataset. A callback
       * (rather than a separate table write by the caller) keeps both halves in one Dexie
       * transaction, so a failure in either rolls back both.
       */
      commitCloudState?: () => Promise<void>;
    } = {},
  ): Promise<void> {
    validateBackupPayloadVersion(snapshot.payload);
    const knowledge = Object.hasOwn(snapshot.payload, "knowledge") ? validateKnowledgeEnvelope(snapshot.payload.knowledge) : undefined;
    const owner = currentKnowledgeOwner();
    const ownerGeneration = knowledgeContextGeneration();
    const restoreSessionId = options.restoreSessionId ?? newId();
    const restoredBlocks = normalizeSnapshotRecords(migrateBlocksToRecords(snapshot.payload.blocks));
    const restoredDrafts = normalizeSnapshotRecordDrafts(snapshot.payload.recordDrafts ?? snapshot.recordDrafts ?? []);
    const restoredTemplates = normalizeSnapshotTemplates(snapshot.payload.templates);
    const restoredPodcasts = normalizeSnapshotPodcasts(snapshot.payload.podcasts);
    const restoredReviewCoach = snapshot.payload.reviewCoach ?? structuredClone(EMPTY_REVIEW_COACH_FORMAL_SNAPSHOT);
    /**
     * "Field absent" and "empty array" mean different things here, and getting
     * it wrong destroys data: a snapshot taken before daily plans existed has no
     * `dailyPlans` key at all, so an unconditional clear-then-write would wipe
     * every plan on this device as a side effect of restoring an old backup.
     * Absent therefore means "leave what is here alone".
     */
    const hasDailyPlansField = Array.isArray(snapshot.payload.dailyPlans);
    assertSnapshotIntegrity(restoredBlocks, restoredTemplates, snapshot.assets, restoredDrafts);
    const restoredRecords = restoredBlocks.filter((block): block is RecordBlock => block.type === "record");
    validateReviewCoachFormalSnapshot(restoredReviewCoach, new Set(restoredRecords.map((record) => record.id)));
    await db.transaction(
      "rw",
      [
        db.entries,
        db.blocks,
        db.templates,
        db.recordDrafts,
        db.recordReviews,
        db.recordReviewLogs,
        db.recordReviewDayStats,
        db.mistakes,
        db.tags,
        db.reviews,
        db.studySessions,
        db.settings,
        db.assets,
        db.knowledgePodcasts,
        db.cloudSyncMutation,
        db.cloudSyncState,
        db.cloudSyncLedger,
        db.reviewAnnotationDrafts,
        db.voiceRecallSessions,
        db.voiceRecallTurns,
        db.dailyPlans,
        ...reviewCoachRestoreTables(db),
        ...(knowledge ? knowledgeTables(db) : []),
      ],
      async () => {
        assertKnowledgeOwner(owner, ownerGeneration);
        if (knowledge) await restorePortableKnowledge(db, knowledge, owner, restoreSessionId);
        const [currentEpoch, currentPodcasts, currentPodcastAssets, currentSettings, currentAssets] = await Promise.all([
          db.cloudSyncMutation.get("local"),
          options.preservePodcasts ? db.knowledgePodcasts.toArray() : Promise.resolve([]),
          options.preservePodcasts ? db.assets.filter((asset) => asset.generatedBy === "knowledge-podcast").toArray() : Promise.resolve([]),
          db.settings.get("settings"),
          options.preserveLocalSettings ? db.assets.toArray() : Promise.resolve([]),
        ]);
        if (expectedEpoch !== undefined && (currentEpoch?.epoch ?? 0) !== expectedEpoch) {
          throw new CloudSyncLocalMutationError();
        }
        const settingsToRestore = ensureSettingsSubjects(
          {
            ...(options.preserveLocalSettings
              ? preserveLocalSettings(snapshot.payload.settings, currentSettings ?? DEFAULT_SETTINGS)
              : snapshot.payload.settings),
            editorFontScale: currentSettings?.editorFontScale ?? 1,
            schemaVersion: 4,
          },
          restoredRecords,
        );
        const currentAssetsById = new Map(currentAssets.map((asset) => [asset.id, asset]));
        const assetsToRestore = options.preservePodcasts
          ? [...snapshot.assets.filter((asset) => asset.generatedBy !== "knowledge-podcast")
            .map((asset) => restoreAssetOcrState(asset, currentAssetsById.get(asset.id))), ...currentPodcastAssets]
          : snapshot.assets;
        const podcastsToRestore = options.preservePodcasts ? currentPodcasts : restoredPodcasts;
        await Promise.all([
          db.entries.clear(),
          db.blocks.clear(),
          db.templates.clear(),
          db.recordDrafts.clear(),
          db.recordReviews.clear(),
          db.recordReviewLogs.clear(),
          db.recordReviewDayStats.clear(),
          db.mistakes.clear(),
          db.tags.clear(),
          db.reviews.clear(),
          db.studySessions.clear(),
          db.settings.clear(),
          db.assets.clear(),
          db.knowledgePodcasts.clear(),
          ...(hasDailyPlansField ? [db.dailyPlans.clear()] : []),
          ...(options.clearLocalAnnotationDrafts ? [db.reviewAnnotationDrafts.clear()] : []),
          ...(options.clearLocalVoiceRecallTransient ? [db.voiceRecallSessions.clear(), db.voiceRecallTurns.clear()] : []),
        ]);
        await restoreReviewCoachFormalSnapshot(db, restoredReviewCoach);
        await Promise.all([
          db.entries.bulkPut(snapshot.payload.entries),
          db.blocks.bulkPut(restoredBlocks),
          db.templates.bulkPut(restoredTemplates),
          db.recordDrafts.bulkPut(restoredDrafts),
          db.recordReviews.bulkPut(snapshot.payload.recordReviews ?? []),
          db.recordReviewLogs.bulkPut(snapshot.payload.recordReviewLogs ?? []),
          db.recordReviewDayStats.bulkPut(snapshot.payload.recordReviewDayStats ?? []),
          db.tags.bulkPut(dedupeSnapshotTags(snapshot.payload.tags)),
          db.studySessions.bulkPut(snapshot.payload.studySessions),
          db.settings.put(settingsToRestore),
          db.assets.bulkPut(assetsToRestore),
          db.knowledgePodcasts.bulkPut(podcastsToRestore),
          db.cloudSyncMutation.put({ id: "local", epoch: (currentEpoch?.epoch ?? 0) + 1 }),
          ...(hasDailyPlansField ? [db.dailyPlans.bulkPut(snapshot.payload.dailyPlans!)] : []),
        ]);
        // Last, so any failure here rolls the data replacement back as well.
        if (options.commitCloudState) await options.commitCloudState();
      },
    );
    await this.migrateRecordReviewsToMixedSystem();
    await this.rebuildReviewProjectionFromEvents();
    await new DexieReviewCoachRepository(db).rebuildProjections();
  }

  async restoreSnapshot(snapshot: StorageSnapshot): Promise<void> {
    await this.restoreSnapshotData(snapshot, undefined, { clearLocalAnnotationDrafts: true, clearLocalVoiceRecallTransient: true });
  }

  async restoreCloudSyncSnapshot(snapshot: StorageSnapshot, commitCloudState?: () => Promise<void>): Promise<void> {
    await this.restoreSnapshotData(snapshot, undefined, { preservePodcasts: true, preserveLocalSettings: true, ...(commitCloudState ? { commitCloudState } : {}) });
  }

  async restoreCloudSyncSnapshotIfUnchanged(snapshot: StorageSnapshot, expectedEpoch: number, commitCloudState?: () => Promise<void>): Promise<void> {
    await this.restoreSnapshotData(snapshot, expectedEpoch, { preservePodcasts: true, preserveLocalSettings: true, ...(commitCloudState ? { commitCloudState } : {}) });
  }

  async restoreStreamableSnapshot(
    snapshot: StreamableBackupSnapshot,
    readAsset: StreamedAssetReader,
    options: StreamingImportOptions = {},
  ): Promise<void> {
    validateBackupPayloadVersion(snapshot.payload);
    const knowledge = Object.hasOwn(snapshot.payload, "knowledge") ? validateKnowledgeEnvelope(snapshot.payload.knowledge) : undefined;
    const owner = currentKnowledgeOwner();
    const ownerGeneration = knowledgeContextGeneration();
    const restoreSessionId = options.restoreSessionId ?? newId();
    const restoredBlocks = normalizeSnapshotRecords(migrateBlocksToRecords(snapshot.payload.blocks));
    const restoredDrafts = normalizeSnapshotRecordDrafts(snapshot.payload.recordDrafts ?? snapshot.recordDrafts ?? []);
    const restoredTemplates = normalizeSnapshotTemplates(snapshot.payload.templates);
    assertSnapshotIntegrity(restoredBlocks, restoredTemplates, snapshot.assets, restoredDrafts);
    const restoredRecords = restoredBlocks.filter((block): block is RecordBlock => block.type === "record");
    const restoredReviewCoach = snapshot.payload.reviewCoach ?? structuredClone(EMPTY_REVIEW_COACH_FORMAL_SNAPSHOT);
    validateReviewCoachFormalSnapshot(restoredReviewCoach, new Set(restoredRecords.map((record) => record.id)));
    // Same absent-vs-empty rule as `restoreSnapshotData`: an old stream has no
    // `dailyPlans` key, and clearing on that basis would delete local plans.
    const hasDailyPlansField = Array.isArray(snapshot.payload.dailyPlans);
    const sessionId = newId();
    const total = snapshot.assets.length;
    try {
      for (const [index, meta] of snapshot.assets.entries()) {
        options.onProgress?.({
          stage: "assets",
          message: `正在校验资源 ${index + 1}/${total}。`,
          current: index + 1,
          total,
        });
        const asset = await readAsset(meta, index, total);
        if (!asset) {
          throw new Error(`备份数据不完整：无法读取资源 ${meta.fileName}。`);
        }
        await db.restoreStagingAssets.put({ stagingId: `${sessionId}:${meta.id}`, sessionId, asset });
      }

      const staged = await db.restoreStagingAssets.where("sessionId").equals(sessionId).toArray();
      if (staged.length !== snapshot.assets.length) {
        throw new Error("备份资源暂存不完整，已取消恢复。");
      }

      options.onProgress?.({ stage: "restoring", message: "资源校验完成，正在一次性恢复数据。" });
      await markCloudSyncMutation();
      await db.transaction(
        "rw",
        [db.entries, db.blocks, db.templates, db.recordDrafts, db.recordReviews, db.recordReviewLogs, db.recordReviewDayStats, db.mistakes, db.tags, db.reviews, db.studySessions, db.settings, db.assets, db.knowledgePodcasts, db.restoreStagingAssets, db.reviewAnnotationDrafts, db.voiceRecallSessions, db.voiceRecallTurns, db.dailyPlans, ...reviewCoachRestoreTables(db), ...(knowledge ? knowledgeTables(db) : [])],
        async () => {
          assertKnowledgeOwner(owner, ownerGeneration);
          if (knowledge) await restorePortableKnowledge(db, knowledge, owner, restoreSessionId);
          const currentSettings = await db.settings.get("settings");
          await Promise.all([
            db.entries.clear(), db.blocks.clear(), db.templates.clear(), db.recordDrafts.clear(), db.recordReviews.clear(), db.recordReviewLogs.clear(),
            db.recordReviewDayStats.clear(), db.mistakes.clear(), db.tags.clear(), db.reviews.clear(), db.studySessions.clear(),
            db.settings.clear(), db.assets.clear(), db.knowledgePodcasts.clear(), db.reviewAnnotationDrafts.clear(), db.voiceRecallSessions.clear(), db.voiceRecallTurns.clear(),
          ]);
          if (hasDailyPlansField) {
            // Kept off the list above: this one is conditional, and mixing it in
            // would make the "old stream" case invisible at a glance.
            await db.dailyPlans.clear();
          }
          await restoreReviewCoachFormalSnapshot(db, restoredReviewCoach);
          await Promise.all([
            db.entries.bulkPut(snapshot.payload.entries),
            db.blocks.bulkPut(restoredBlocks),
            db.templates.bulkPut(restoredTemplates),
            db.recordDrafts.bulkPut(restoredDrafts),
            db.recordReviews.bulkPut(snapshot.payload.recordReviews ?? []),
            db.recordReviewLogs.bulkPut(snapshot.payload.recordReviewLogs ?? []),
            db.recordReviewDayStats.bulkPut(snapshot.payload.recordReviewDayStats ?? []),
            db.tags.bulkPut(dedupeSnapshotTags(snapshot.payload.tags)),
            db.studySessions.bulkPut(snapshot.payload.studySessions),
            db.settings.put(ensureSettingsSubjects({ ...snapshot.payload.settings, editorFontScale: currentSettings?.editorFontScale ?? 1, schemaVersion: 4 }, restoredRecords)),
            db.assets.bulkPut(staged.map((entry) => entry.asset)),
            db.knowledgePodcasts.bulkPut(normalizeSnapshotPodcasts(snapshot.payload.podcasts)),
            db.restoreStagingAssets.where("sessionId").equals(sessionId).delete(),
          ]);
          if (hasDailyPlansField) {
            await db.dailyPlans.bulkPut(snapshot.payload.dailyPlans!);
          }
        },
      );
      await this.migrateRecordReviewsToMixedSystem();
      await new DexieReviewCoachRepository(db).rebuildProjections();
    } catch (error) {
      await db.restoreStagingAssets.where("sessionId").equals(sessionId).delete();
      throw error;
    }
  }

  async clearAll(): Promise<void> {
    await db.delete();
    await this.initialize();
    // `db.delete()` removes the mutation table itself, so bump the epoch only
    // after the fresh database has been initialized. This keeps a clear-all
    // operation visible to an in-flight cloud restore instead of resetting the
    // epoch back to zero and accidentally allowing the restore to proceed.
    await markCloudSyncMutation();
  }

  async listAiSessions(): Promise<AiChatSession[]> {
    return db.aiSessions.orderBy("updatedAt").reverse().toArray();
  }

  async getAiSession(id: string): Promise<AiChatSession | undefined> {
    return db.aiSessions.get(id);
  }

  async saveAiSession(session: AiChatSession): Promise<AiChatSession> {
    const saved = touch(session);
    await db.aiSessions.put(saved);
    return saved;
  }

  async deleteAiSession(id: string): Promise<void> {
    await db.transaction("rw", db.aiSessions, db.aiMessages, db.aiAttachments, async () => {
      await db.aiAttachments.where("sessionId").equals(id).delete();
      await db.aiMessages.where("sessionId").equals(id).delete();
      await db.aiSessions.delete(id);
    });
  }

  async listAiMessages(sessionId: string): Promise<AiChatMessage[]> {
    return db.aiMessages.where("sessionId").equals(sessionId).sortBy("createdAt");
  }

  async saveAiMessage(message: AiChatMessage): Promise<AiChatMessage> {
    const saved = touch(message);
    await db.transaction("rw", db.aiMessages, db.aiSessions, async () => {
      await db.aiMessages.put(saved);
      const session = await db.aiSessions.get(saved.sessionId);
      if (session) {
        await db.aiSessions.put({ ...session, updatedAt: nowISO() });
      }
    });
    return saved;
  }

  async saveAiAttachment(attachment: AiChatAttachment): Promise<AiChatAttachment> {
    const saved = touch(attachment);
    await db.aiAttachments.put(saved);
    return saved;
  }

  async listAiAttachments(sessionId: string): Promise<AiChatAttachment[]> {
    return db.aiAttachments.where("sessionId").equals(sessionId).sortBy("createdAt");
  }

  async getAiAttachment(id: string): Promise<AiChatAttachment | undefined> {
    return db.aiAttachments.get(id);
  }

  async deleteAiAttachment(id: string): Promise<void> {
    await db.aiAttachments.delete(id);
  }

  async deleteAiAttachmentsForSession(sessionId: string): Promise<void> {
    await db.aiAttachments.where("sessionId").equals(sessionId).delete();
  }

  async getAiSecret(providerId = "default"): Promise<AiSecret | undefined> {
    return db.aiSecrets.get(providerId);
  }

  async saveAiSecret(apiKey: string, providerId = "default", apiKeySecondary?: string): Promise<AiSecret> {
    const secret: AiSecret = {
      id: providerId,
      apiKey,
      ...(apiKeySecondary ? { apiKeySecondary } : {}),
      updatedAt: nowISO(),
    };
    await db.aiSecrets.put(secret);
    return secret;
  }

  async clearAiSecret(providerId = "default"): Promise<void> {
    await db.aiSecrets.delete(providerId);
  }
}

export const storage = new DexieStorageAdapter();

export const observeEntries = () => liveQuery(() => storage.listEntries());
export const observeMistakes = () => liveQuery(() => storage.listMistakes());
