import type {
  AppSettings,
  Asset,
  BackupManifest,
  Block,
  CloudSyncEntityType,
  ContentTemplate,
  DayEntry,
  RecordDraft,
  RecordBlock,
  RecordReviewDayStat,
  RecordReviewLog,
  RecordReviewState,
  StorageSnapshot,
  StudySession,
  Tag,
} from "../types";
import {
  EMPTY_REVIEW_COACH_FORMAL_SNAPSHOT,
  type AdaptiveQuizTurn,
  type AdaptiveReviewTask,
  type AiRoleConfig,
  type AnalysisBatch,
  type AnalysisQueueItem,
  type DecisionBlock,
  type DecisionBlockArchive,
  type DecisionBlockFeedback,
  type DelayedVerification,
  type FeedbackInterpretation,
  type LegacyKnowledgePoint,
  type LegacyKnowledgeRelation,
  type LegacyLearningEvidence,
  type LegacyRecordKnowledgePointLink,
  type ReviewCoachFormalSnapshot,
  type SessionBlueprint,
  type TaskOutcomeEvent,
} from "../features/reviewCoach/domain";
import { DEFAULT_SETTINGS, DEFAULT_TAGS } from "../db/defaults";
import { nowISO } from "../lib/date";
import { sha256 as javascriptSha256 } from "@noble/hashes/sha256";
import { extractDecisionBlocks } from "../features/reviewCoach/decisionBlockContent";
import { sanitizeSettingsForExport, stripPrivateExportFields } from "./exportPrivacy";

export type CloudHashAlgorithm = "sha256" | "fnv1a";

export interface CloudSyncEntity {
  key: string;
  entityType: CloudSyncEntityType;
  entityId: string;
  contentHash: string;
  /** Hash format used for this entity. Older Firestore documents omit this field. */
  contentHashVersion?: number;
  /** Algorithm used for contentHash. Older documents infer this from the hash prefix. */
  contentHashAlgorithm?: CloudHashAlgorithm;
  payload: Record<string, unknown>;
  deleted?: boolean;
  /** Content-addressed Storage object for payloads too large for Firestore. */
  payloadDocumentHash?: string;
  payloadByteSize?: number;
}

export interface CloudReviewEvent {
  id: string;
  contentHash: string;
  payload: Record<string, unknown>;
}

export interface CloudSyncExport {
  entities: CloudSyncEntity[];
  reviewEvents: CloudReviewEvent[];
  assetBlobs: Map<string, Blob>;
}

/**
 * A fresh device contains only settings and the built-in tag guide. Those
 * values are not user-authored data and must not compete with an existing
 * cloud snapshot during the first pull.
 */
export const isBootstrapOnlyCloudData = (exported: CloudSyncExport): boolean => {
  if (exported.reviewEvents.length > 0) return false;
  const settings = exported.entities.filter((entity) => entity.entityType === "settings" && !entity.deleted);
  if (settings.length !== 1) return false;
  const tags = exported.entities.filter((entity) => entity.entityType === "tag");
  if (tags.some((entity) => entity.deleted)) return false;
  const names = tags
    .map((entity) => typeof entity.payload.name === "string" ? entity.payload.name.trim() : "")
    .filter(Boolean)
    .sort();
  const defaultNames = [...DEFAULT_TAGS].sort();
  if (names.length !== defaultNames.length || names.some((name, index) => name !== defaultNames[index])) return false;
  if (exported.entities.some((entity) => !["settings", "tag"].includes(entity.entityType))) return false;

  const normalizeSettings = (payload: Record<string, unknown>) => {
    const sanitized = sanitizeSettingsForExport(payload as unknown as AppSettings) as unknown as Record<string, unknown>;
    const { schemaVersion: _schemaVersion, lastBackupAt: _lastBackupAt, syncFolderName: _syncFolderName, ...rest } = sanitized;
    return rest;
  };
  return stableJson(normalizeSettings(settings[0].payload)) === stableJson(normalizeSettings(DEFAULT_SETTINGS as unknown as Record<string, unknown>));
};

/**
 * Entity types excluded from the coarse entity-level conflict check. Review
 * projections are mergeable by event/state semantics, while settings/templates
 * are checked separately by `mergeCloudSyncSmallEntity` at field granularity.
 */
export const NON_CONFLICTING_ENTITY_TYPES = new Set<CloudSyncEntityType>(["review-state", "review-day-stat", "settings", "template"]);

type JsonRecord = Record<string, unknown>;

export const CLOUD_DOCUMENT_THRESHOLD_BYTES = 750 * 1024;
export const ASSET_CONTENT_HASH_VERSION = 2;
export const BLOCK_CONTENT_HASH_VERSION = 2;
export const ASSET_OPERATIONAL_FIELDS = ["ocrStatus", "ocrError", "ocrJobId", "ocrUpdatedAt", "ocrResultSummary"] as const;

export interface CloudPayloadDocument {
  hash: string;
  byteSize: number;
  blob: Blob;
}

const sortValue = (value: unknown): unknown => {
  if (Array.isArray(value)) {
    return value.map(sortValue);
  }
  if (value && typeof value === "object") {
    return Object.keys(value as JsonRecord)
      .sort()
      .reduce<JsonRecord>((result, key) => {
        const next = (value as JsonRecord)[key];
        if (next !== undefined) {
          result[key] = sortValue(next);
        }
        return result;
      }, {});
  }
  return value;
};

const fallbackHash = (value: string) => {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return `fnv-${(hash >>> 0).toString(16)}`;
};

/** Legacy-only compatibility path. New content must never use this 32-bit hash. */
export const legacyFnvHashValue = (value: unknown) => fallbackHash(stableJson(value));

const hex = (bytes: ArrayBuffer | Uint8Array) => Array.from(
  bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes),
  (value) => value.toString(16).padStart(2, "0"),
).join("");

const digest = async (bytes: ArrayBuffer, fallbackSource: string) => {
  if (globalThis.crypto?.subtle) {
    return hex(await globalThis.crypto.subtle.digest("SHA-256", bytes));
  }
  void fallbackSource;
  return hex(javascriptSha256(new Uint8Array(bytes)));
};

export const stableJson = (value: unknown) => JSON.stringify(sortValue(value));

export const hashValue = async (value: unknown) => {
  const source = stableJson(value);
  return digest(new TextEncoder().encode(source).buffer as ArrayBuffer, source);
};

/**
 * `updatedAt` is bookkeeping, not content — storageAdapter.ts's save paths already skip bumping it
 * when nothing else changed, but every entity hashed here still carries whatever `updatedAt` value
 * it happens to have. Stripping it before hashing means the entity's contentHash reflects only its
 * actual content, so re-saving with a genuinely unchanged payload can never look like a real edit
 * to the sync layer even in paths that don't (or can't) guard the timestamp itself.
 *
 * Only used at the two call sites that compute an entity's `contentHash` (`entity()` and
 * `createCloudPayloadDocument()`) — NOT inside the shared `hashValue`/`stableJson` used elsewhere
 * (e.g. review-event log hashing), whose `updatedAt` semantics are unrelated to this concern.
 */
export const stripUpdatedAt = (value: unknown): unknown => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const { updatedAt: _updatedAt, ...rest } = value as JsonRecord;
  return rest;
};

/**
 * OCR queue state and derived result summaries are device-local bookkeeping.
 * The OCR text itself remains synchronized as user-visible content.
 */
export const stripAssetOperationalFields = (value: unknown): unknown => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const {
    ocrStatus: _ocrStatus,
    ocrError: _ocrError,
    ocrJobId: _ocrJobId,
    ocrUpdatedAt: _ocrUpdatedAt,
    ocrResultSummary: _ocrResultSummary,
    ...rest
  } = value as JsonRecord;
  return rest;
};

/** Keep OCR queue state local when a remote asset result is applied. */
export const preserveAssetOperationalFields = (
  current: CloudSyncEntity | undefined,
  incoming: CloudSyncEntity,
): CloudSyncEntity => {
  if (
    incoming.entityType !== "asset" || incoming.deleted ||
    !current || current.entityType !== "asset" || current.deleted
  ) return incoming;
  const localOperational = ASSET_OPERATIONAL_FIELDS.reduce<JsonRecord>((result, key) => {
    if (Object.prototype.hasOwnProperty.call(current.payload, key)) result[key] = current.payload[key];
    return result;
  }, {});
  if (Object.keys(localOperational).length === 0) return incoming;
  return { ...incoming, payload: { ...incoming.payload, ...localOperational } };
};

export const normalizeBlockHashPayload = (payload: unknown): unknown => {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return payload;
  const record = payload as JsonRecord;
  if (record.type !== "record" || Object.prototype.hasOwnProperty.call(record, "favorite")) return payload;
  return { ...record, favorite: false };
};

/** Hash shape used by pre-v2 block ledgers that omitted the record favorite field. */
export const legacyBlockHashPayload = (payload: unknown): unknown => {
  const normalized = stripUpdatedAt(payload);
  if (!normalized || typeof normalized !== "object" || Array.isArray(normalized)) return normalized;
  const record = normalized as JsonRecord;
  if (record.type !== "record") return normalized;
  const { favorite: _favorite, ...withoutFavorite } = record;
  return withoutFavorite;
};

export const syncHashPayload = (entityType: CloudSyncEntityType, payload: unknown): unknown => {
  const withoutOperational = entityType === "asset" ? stripAssetOperationalFields(payload) : payload;
  return stripUpdatedAt(entityType === "block" ? normalizeBlockHashPayload(withoutOperational) : withoutOperational);
};

export const legacyEntityHashPayload = (payload: unknown): unknown => stripUpdatedAt(payload);

/**
 * Firestore documents have a 1 MiB ceiling. Keep a margin and store large
 * structured payloads in Storage, addressed by the same hash as the entity.
 */
export const createCloudPayloadDocument = async (entity: CloudSyncEntity): Promise<CloudPayloadDocument | undefined> => {
  if (entity.deleted || entity.payloadDocumentHash) return undefined;
  const source = stableJson(entity.payload);
  const bytes = new TextEncoder().encode(source);
  if (bytes.byteLength <= CLOUD_DOCUMENT_THRESHOLD_BYTES) return undefined;
  const hash = await hashValue(syncHashPayload(entity.entityType, entity.payload));
  const legacyHash = entity.entityType === "block"
    ? await hashValue(legacyBlockHashPayload(entity.payload))
    : undefined;
  const legacyAlgorithmHash = legacyFnvHashValue(syncHashPayload(entity.entityType, entity.payload));
  const legacyEntityAlgorithmHash = entity.entityType === "asset"
    ? legacyFnvHashValue(legacyEntityHashPayload(entity.payload))
    : undefined;
  const legacyBlockAlgorithmHash = entity.entityType === "block"
    ? legacyFnvHashValue(legacyBlockHashPayload(entity.payload))
    : undefined;
  if (hash !== entity.contentHash && legacyHash !== entity.contentHash && legacyAlgorithmHash !== entity.contentHash && legacyEntityAlgorithmHash !== entity.contentHash && legacyBlockAlgorithmHash !== entity.contentHash) {
    throw new Error(`同步实体 ${entity.key} 的内容哈希不一致。`);
  }
  return {
    hash: entity.contentHash,
    byteSize: bytes.byteLength,
    blob: new Blob([bytes], { type: "application/json" }),
  };
};

export const withCloudPayloadDocument = (entity: CloudSyncEntity, document: CloudPayloadDocument): CloudSyncEntity => ({
  ...entity,
  payload: {},
  payloadDocumentHash: document.hash,
  payloadByteSize: document.byteSize,
});

const blobArrayBuffer = async (blob: Blob): Promise<ArrayBuffer> => {
  const direct = (blob as Blob & { arrayBuffer?: () => Promise<ArrayBuffer> }).arrayBuffer;
  if (direct) return direct.call(blob);
  return new Promise<ArrayBuffer>((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error("无法读取同步资源。"));
    reader.onload = () => resolve(reader.result as ArrayBuffer);
    reader.readAsArrayBuffer(blob);
  });
};

export const hashBlob = async (blob: Blob) => {
  const bytes = await blobArrayBuffer(blob);
  return digest(bytes, `${blob.type}:${blob.size}`);
};

const entity = async (
  entityType: CloudSyncEntityType,
  value: { id: string; deletedAt?: string },
): Promise<CloudSyncEntity> => {
  const payload = sortValue(value) as JsonRecord;
  return {
    key: `${entityType}:${value.id}`,
    entityType,
    entityId: value.id,
    contentHash: await hashValue(syncHashPayload(entityType, payload)),
    contentHashAlgorithm: "sha256",
    ...(entityType === "asset" ? { contentHashVersion: ASSET_CONTENT_HASH_VERSION } : {}),
    ...(entityType === "block" ? { contentHashVersion: BLOCK_CONTENT_HASH_VERSION } : {}),
    payload,
    deleted: Boolean(value.deletedAt),
  };
};

const mapEntities = async <T extends { id: string; deletedAt?: string }>(
  entityType: CloudSyncEntityType,
  values: T[],
): Promise<CloudSyncEntity[]> => Promise.all(values.map((value) => entity(entityType, value)));

export const exportCloudSync = async (snapshot: StorageSnapshot): Promise<CloudSyncExport> => {
  const coach = stripPrivateExportFields(snapshot.payload.reviewCoach ?? EMPTY_REVIEW_COACH_FORMAL_SNAPSHOT);
  const ordinary = await Promise.all([
    mapEntities("entry", snapshot.payload.entries),
    mapEntities("block", snapshot.payload.blocks),
    mapEntities("template", snapshot.payload.templates ?? []),
    mapEntities("draft", snapshot.payload.recordDrafts ?? snapshot.recordDrafts ?? []),
    mapEntities("tag", snapshot.payload.tags),
    mapEntities("study-session", snapshot.payload.studySessions),
    mapEntities("review-state", snapshot.payload.recordReviews ?? []),
    mapEntities("review-day-stat", snapshot.payload.recordReviewDayStats ?? []),
    mapEntities("decision-block", coach.decisionBlocks),
    mapEntities("decision-block-archive", coach.decisionBlockArchives),
    mapEntities("decision-block-feedback", coach.decisionBlockFeedback),
    mapEntities("feedback-interpretation", coach.feedbackInterpretations),
    mapEntities("analysis-queue-item", coach.analysisQueueItems),
    mapEntities("analysis-batch", coach.analysisBatches),
    mapEntities("session-blueprint", coach.sessionBlueprints),
    mapEntities("adaptive-review-task", coach.adaptiveReviewTasks),
    mapEntities("adaptive-quiz-turn", coach.adaptiveQuizTurns),
    mapEntities("task-outcome-event", coach.taskOutcomeEvents),
    mapEntities("delayed-verification", coach.delayedVerifications),
    mapEntities("ai-role-config", coach.aiRoleConfigs),
    mapEntities("legacy-learning-evidence", coach.legacyLearningEvidence),
    mapEntities("legacy-knowledge-point", coach.legacyKnowledgePoints),
    mapEntities("legacy-record-kp-link", coach.legacyRecordKnowledgePointLinks),
    mapEntities("legacy-knowledge-relation", coach.legacyKnowledgeRelations),
  ]);
  const settings = await entity("settings", sanitizeSettingsForExport(snapshot.payload.settings));
  const assetBlobs = new Map<string, Blob>();
  const assets = await Promise.all(
    snapshot.assets.filter((asset) => asset.generatedBy !== "knowledge-podcast").map(async (asset) => {
      const { data, ...meta } = asset;
      const assetHash = await hashBlob(data);
      assetBlobs.set(assetHash, data);
      return entity("asset", { ...meta, id: asset.id, contentHash: assetHash } as Asset & { contentHash: string });
    }),
  );
  const reviewEvents = await Promise.all(
    (snapshot.payload.recordReviewLogs ?? []).map(async (log) => ({
      id: log.id,
      contentHash: await hashValue(log),
      payload: sortValue(log) as JsonRecord,
    })),
  );
  return { entities: [...ordinary.flat(), settings, ...assets], reviewEvents, assetBlobs };
};

const values = <T>(entities: CloudSyncEntity[], type: CloudSyncEntityType) =>
  entities.filter((entity) => entity.entityType === type && !entity.deleted).map((entity) => entity.payload as unknown as T);

const coachValues = <T extends { id: string }>(entities: CloudSyncEntity[], type: CloudSyncEntityType) =>
  entities
    .filter((entity) => entity.entityType === type && (!entity.deleted || typeof entity.payload.id === "string"))
    .map((entity) => entity.payload as unknown as T);

const manifestFor = (entities: CloudSyncEntity[], reviewEvents: CloudReviewEvent[]): BackupManifest => {
  const count = (type: CloudSyncEntityType) => entities.filter((entity) => entity.entityType === type && !entity.deleted).length;
  return {
    format: "study-journal",
    version: 6,
    exportedAt: nowISO(),
    appVersion: "0.1.0",
    counts: {
      entries: count("entry"),
      blocks: count("block"),
      mistakes: 0,
      assets: count("asset"),
      tags: count("tag"),
      reviews: 0,
      studySessions: count("study-session"),
      templates: count("template"),
      recordReviews: count("review-state"),
      recordReviewLogs: reviewEvents.length,
      recordReviewDayStats: count("review-day-stat"),
      reviewCoach: {
        decisionBlocks: count("decision-block"),
        decisionBlockArchives: count("decision-block-archive"),
        decisionBlockFeedback: count("decision-block-feedback"),
        feedbackInterpretations: count("feedback-interpretation"),
        analysisQueueItems: count("analysis-queue-item"),
        analysisBatches: count("analysis-batch"),
        sessionBlueprints: count("session-blueprint"),
        adaptiveReviewTasks: count("adaptive-review-task"),
        adaptiveQuizTurns: count("adaptive-quiz-turn"),
        taskOutcomeEvents: count("task-outcome-event"),
        delayedVerifications: count("delayed-verification"),
        aiRoleConfigs: count("ai-role-config"),
        legacyLearningEvidence: count("legacy-learning-evidence"),
        legacyKnowledgePoints: count("legacy-knowledge-point"),
        legacyRecordKnowledgePointLinks: count("legacy-record-kp-link"),
        legacyKnowledgeRelations: count("legacy-knowledge-relation"),
      },
    },
  };
};

export const materializeCloudSyncSnapshot = (
  entities: CloudSyncEntity[],
  reviewEvents: CloudReviewEvent[],
  assetBlobs: Map<string, Blob>,
): StorageSnapshot => {
  const assetValues = values<Omit<Asset, "data"> & { contentHash?: string }>(entities, "asset").map((asset) => {
    const { contentHash, ...meta } = asset;
    const data = contentHash ? assetBlobs.get(contentHash) : undefined;
    if (!data) {
      throw new Error(`云端资源不完整：${asset.fileName}。`);
    }
    return { ...meta, data } as Asset;
  });
  const settings = values<AppSettings>(entities, "settings")[0] ?? DEFAULT_SETTINGS;
  const recordDrafts = values<RecordDraft>(entities, "draft");
  const reviewCoach: ReviewCoachFormalSnapshot = {
    decisionBlocks: coachValues<DecisionBlock>(entities, "decision-block"),
    decisionBlockArchives: coachValues<DecisionBlockArchive>(entities, "decision-block-archive"),
    decisionBlockFeedback: coachValues<DecisionBlockFeedback>(entities, "decision-block-feedback"),
    feedbackInterpretations: coachValues<FeedbackInterpretation>(entities, "feedback-interpretation"),
    analysisQueueItems: coachValues<AnalysisQueueItem>(entities, "analysis-queue-item"),
    analysisBatches: coachValues<AnalysisBatch>(entities, "analysis-batch"),
    sessionBlueprints: coachValues<SessionBlueprint>(entities, "session-blueprint"),
    adaptiveReviewTasks: coachValues<AdaptiveReviewTask>(entities, "adaptive-review-task"),
    adaptiveQuizTurns: coachValues<AdaptiveQuizTurn>(entities, "adaptive-quiz-turn"),
    taskOutcomeEvents: coachValues<TaskOutcomeEvent>(entities, "task-outcome-event"),
    delayedVerifications: coachValues<DelayedVerification>(entities, "delayed-verification"),
    aiRoleConfigs: coachValues<AiRoleConfig>(entities, "ai-role-config"),
    legacyLearningEvidence: coachValues<LegacyLearningEvidence>(entities, "legacy-learning-evidence"),
    legacyKnowledgePoints: coachValues<LegacyKnowledgePoint>(entities, "legacy-knowledge-point"),
    legacyRecordKnowledgePointLinks: coachValues<LegacyRecordKnowledgePointLink>(entities, "legacy-record-kp-link"),
    legacyKnowledgeRelations: coachValues<LegacyKnowledgeRelation>(entities, "legacy-knowledge-relation"),
  };
  return {
    payload: {
      manifest: manifestFor(entities, reviewEvents),
      entries: values<DayEntry>(entities, "entry"),
      blocks: values<Block>(entities, "block"),
      templates: values<ContentTemplate>(entities, "template"),
      recordDrafts,
      mistakes: [],
      tags: values<Tag>(entities, "tag"),
      reviews: [],
      recordReviews: values<RecordReviewState>(entities, "review-state"),
      recordReviewLogs: reviewEvents.map((event) => event.payload as unknown as RecordReviewLog),
      recordReviewDayStats: values<RecordReviewDayStat>(entities, "review-day-stat"),
      studySessions: values<StudySession>(entities, "study-session"),
      settings,
      reviewCoach,
    },
    assets: assetValues,
    recordDrafts,
  };
};

export const withDecisionBlockConflictCopies = (
  snapshot: StorageSnapshot,
  localEntities: CloudSyncEntity[],
  conflictingKeys: ReadonlySet<string>,
  archivedAt: string,
): StorageSnapshot => {
  const reviewCoach = snapshot.payload.reviewCoach;
  if (!reviewCoach) return snapshot;
  const activeById = new Map(reviewCoach.decisionBlocks.map((item) => [item.id, item]));
  const knownKeys = new Set(reviewCoach.decisionBlockArchives.map((item) => item.idempotencyKey));
  const archives = [...reviewCoach.decisionBlockArchives];

  for (const entity of localEntities) {
    if (entity.entityType !== "block" || entity.deleted || !conflictingKeys.has(entity.key)) continue;
    const record = entity.payload as unknown as Partial<RecordBlock>;
    if (record.type !== "record" || typeof record.id !== "string" || typeof record.contentHtml !== "string") continue;
    for (const node of extractDecisionBlocks(record.contentHtml, archivedAt)) {
      const active = activeById.get(node.decisionBlockId);
      if (!active || active.recordId !== record.id || node.contentVersion > active.contentVersion) continue;
      const idempotencyKey = `content-conflict:${entity.contentHash}:${node.decisionBlockId}:${node.contentVersion}`;
      if (knownKeys.has(idempotencyKey)) continue;
      knownKeys.add(idempotencyKey);
      archives.push({
        id: idempotencyKey,
        decisionBlockId: node.decisionBlockId,
        recordId: record.id,
        contentVersion: node.contentVersion,
        contentHtml: node.contentHtml,
        archivedAt,
        reason: "content-conflict",
        idempotencyKey,
        createdAt: archivedAt,
        updatedAt: archivedAt,
      });
    }
  }
  if (archives.length === reviewCoach.decisionBlockArchives.length) return snapshot;
  return {
    ...snapshot,
    payload: { ...snapshot.payload, reviewCoach: { ...reviewCoach, decisionBlockArchives: archives } },
  };
};

export const mergeCloudSyncEntities = (
  current: CloudSyncEntity[],
  updates: CloudSyncEntity[],
) => {
  const byKey = new Map(current.map((entity) => [entity.key, entity]));
  updates.forEach((entity) => byKey.set(entity.key, preserveAssetOperationalFields(byKey.get(entity.key), entity)));
  return [...byKey.values()];
};

/**
 * Select local changes that remain eligible after the user chooses "cloud
 * wins". A local tombstone is ignored when the cloud still has the entity and
 * did not change it; otherwise it would turn a cloud snapshot restore into an
 * accidental delete. Local additions and edits on keys untouched by the cloud
 * are retained for the follow-up upload.
 */
export const preserveLocalChangesForCloudWins = (
  localChanges: CloudSyncEntity[],
  remoteEntities: CloudSyncEntity[],
  remoteChangedKeys: Set<string>,
) => {
  const remoteByKey = new Map(remoteEntities.map((entity) => [entity.key, entity]));
  return localChanges.filter((entity) => {
    if (remoteChangedKeys.has(entity.key)) return false;
    const remoteEntity = remoteByKey.get(entity.key);
    if (entity.deleted && remoteEntity && !remoteEntity.deleted) return false;
    return true;
  });
};

export interface CloudSyncSmallEntityMerge {
  payload: Record<string, unknown>;
  deleted: boolean;
  conflicts: string[];
}

/**
 * Three-way merge for the two small entities whose fields are independently editable.
 * A missing base is deliberately conservative: old ledgers have no common ancestor and
 * therefore still use entity-level conflict handling.
 */
export const mergeCloudSyncSmallEntity = (
  local: Pick<CloudSyncEntity, "entityType" | "payload" | "deleted">,
  remote: Pick<CloudSyncEntity, "entityType" | "payload" | "deleted">,
  basePayload: Record<string, unknown> | undefined,
): CloudSyncSmallEntityMerge => {
  if (local.entityType !== remote.entityType || (local.entityType !== "settings" && local.entityType !== "template")) {
    return { payload: remote.payload, deleted: Boolean(remote.deleted), conflicts: ["entity"] };
  }

  const normalizePayload = (payload: Record<string, unknown>) => local.entityType === "settings"
    ? sanitizeSettingsForExport(payload as unknown as AppSettings) as unknown as Record<string, unknown>
    : payload;
  const localPayload = normalizePayload(local.payload);
  const remotePayload = normalizePayload(remote.payload);
  if (!basePayload) {
    return !local.deleted && !remote.deleted && stableJson(localPayload) === stableJson(remotePayload)
      ? { payload: remotePayload, deleted: false, conflicts: [] }
      : { payload: remotePayload, deleted: Boolean(remote.deleted), conflicts: ["entity"] };
  }
  const normalizedBasePayload = normalizePayload(basePayload);

  const localDeleted = Boolean(local.deleted);
  const remoteDeleted = Boolean(remote.deleted);
  const ignored = new Set(local.entityType === "settings" ? ["updatedAt", "lastBackupAt", "syncFolderName"] : ["updatedAt"]);
  const allowed = local.entityType === "template" ? new Set(["title", "contentHtml"]) : undefined;
  const keys = new Set([
    ...Object.keys(normalizedBasePayload),
    ...(localDeleted ? [] : Object.keys(localPayload)),
    ...(remoteDeleted ? [] : Object.keys(remotePayload)),
  ].filter((key) => !ignored.has(key)));
  const conflicts: string[] = [];
  const merged: Record<string, unknown> = { ...(remoteDeleted ? {} : remotePayload) };
  const localChangedKeys = new Set<string>();
  const remoteChangedKeys = new Set<string>();
  let localContentChanged = false;
  let remoteContentChanged = false;
  for (const key of keys) {
    const baseValue = normalizedBasePayload[key];
    // A tombstone has no payload; compare it to the common base as unchanged
    // content and handle the deletion separately below.
    const localValue = localDeleted ? baseValue : localPayload[key];
    const remoteValue = remoteDeleted ? baseValue : remotePayload[key];
    const localChanged = stableJson(localValue) !== stableJson(baseValue);
    const remoteChanged = stableJson(remoteValue) !== stableJson(baseValue);
    if (localChanged) localContentChanged = true;
    if (remoteChanged) remoteContentChanged = true;
    if (localChanged) localChangedKeys.add(key);
    if (remoteChanged) remoteChangedKeys.add(key);
    if (allowed && !allowed.has(key)) {
      if (localChanged || remoteChanged) conflicts.push(key);
      continue;
    }
    if (localChanged && remoteChanged && stableJson(localValue) !== stableJson(remoteValue)) {
      conflicts.push(key);
      continue;
    }
    if (localChanged && !remoteChanged) merged[key] = localValue;
  }

  // A deletion and a content edit are a conflict. Deleting an unchanged entity is safe and
  // follows the side that actually performed the deletion. Treat a tombstone's empty payload
  // as unchanged content so a remote-only delete cannot become an empty live entity.
  if (localDeleted !== remoteDeleted) {
    if (localDeleted && remoteContentChanged) conflicts.push(...remoteChangedKeys, "deletedAt");
    if (remoteDeleted && localContentChanged) conflicts.push(...localChangedKeys, "deletedAt");
    if (conflicts.length === 0) return { payload: {}, deleted: true, conflicts: [] };
  }
  return { payload: merged, deleted: remoteDeleted, conflicts: [...new Set(conflicts)] };
};

/**
 * True only when a locally-changed entity and a remotely-changed entity share a key AND their
 * content actually differs. Sharing a key with matching hashes means the two sides already agree —
 * most commonly this device's own prior publish coming back to it after `headRevision` advanced but
 * this device's local ledger write for that same publish was interrupted (e.g. app killed between
 * the two). That case must resolve as "no conflict" and fall through to the normal merge/download
 * path, which re-derives the ledger row from the (identical) remote copy instead of raising a manual
 * "keep local or cloud" prompt for something neither side actually disagrees about.
 */
export const hasConflictingChanges = (
  normalLocal: Pick<CloudSyncEntity, "key" | "entityType" | "contentHash">[],
  normalRemote: Pick<CloudSyncEntity, "key" | "entityType" | "contentHash">[],
): boolean => {
  return findConflictingChanges(normalLocal, normalRemote).length > 0;
};

export const findConflictingChanges = (
  normalLocal: Pick<CloudSyncEntity, "key" | "entityType" | "contentHash">[],
  normalRemote: Pick<CloudSyncEntity, "key" | "entityType" | "contentHash">[],
) => {
  if (normalLocal.length === 0) return [] as Array<{ key: string; entityType: CloudSyncEntityType }>;
  const localByKey = new Map(normalLocal.map((entity) => [entity.key, entity]));
  return normalRemote
    .filter((entity) => {
      const local = localByKey.get(entity.key);
      return Boolean(local && local.contentHash !== entity.contentHash);
    })
    .map((entity) => ({ key: entity.key, entityType: entity.entityType }));
};
