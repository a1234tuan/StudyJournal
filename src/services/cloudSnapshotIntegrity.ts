import { ActionableError } from "../lib/uiError";
import { assetByteFailure, describeAssetByteFailure } from "./assetIntegrity";
import type { CloudSyncEntityType } from "../types";

/**
 * Strict, fail-closed validation for destructive cloud recovery.
 *
 * Two very different inputs share one parser in `cloudSyncService`:
 *
 * - an incremental pull, where a tolerant merge is correct because damaged documents are skipped
 *   and the ledger/cursor cannot claim more than what actually arrived, and
 * - a destructive full replacement, where a single missing, duplicated or malformed document means
 *   the set is unverifiable and must never reach the local database, the ledger or the cursor.
 *
 * Everything in this module is the second case. It is pure and synchronous so the exact contract
 * can be unit tested without a Firestore emulator, and it is deliberately stricter than
 * `parseRemoteEntity`: a document that the tolerant parser silently drops is a hard error here.
 */

/**
 * Every entity type the incremental cloud protocol may store under `syncEntities`.
 *
 * `CLOUD_SNAPSHOT_ENTITY_TYPES_EXHAUSTIVE` is a compile-time proof that this runtime list covers
 * the whole `CloudSyncEntityType` union; adding a member to the union without adding it here fails
 * the type check instead of silently rejecting real snapshots.
 */
const RUNTIME_ENTITY_TYPES = [
  "entry",
  "block",
  "template",
  "draft",
  "tag",
  "study-session",
  "settings",
  "asset",
  "review-state",
  "review-day-stat",
  "daily-plan",
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
] as const satisfies readonly CloudSyncEntityType[];

type MissingEntityType = Exclude<CloudSyncEntityType, (typeof RUNTIME_ENTITY_TYPES)[number]>;

export const CLOUD_SNAPSHOT_ENTITY_TYPES_EXHAUSTIVE: MissingEntityType extends never ? true : never = true;

export const CLOUD_SNAPSHOT_ENTITY_TYPES: ReadonlySet<string> = new Set<string>(RUNTIME_ENTITY_TYPES);

export const REVIEW_EVENT_DOCUMENT_PREFIX = "review-event:";

/**
 * Whether a recovery snapshot can be advertised as recoverable.
 *
 * - `complete`            — written by a client that commits the parent document last, with a
 *                           verified item count. Safest, and what new snapshots always are.
 * - `writing`             — the writer itself declared the snapshot unfinished.
 * - `legacy-unverified`   — written before completion markers existed. Its historical
 *                           `entityCount` is the only completeness proof available, so it may be
 *                           restored only after the same strict validation passes.
 * - `unverifiable`        — no usable completeness proof (missing/zero count). Never restorable.
 */
export type CloudRecoverySnapshotStatus = "complete" | "writing" | "legacy-unverified" | "unverifiable";

/** Raised for every integrity failure so the UI can show an actionable message verbatim. */
export class CloudSnapshotIntegrityError extends ActionableError {
  constructor(message: string) {
    super(message);
    this.name = "CloudSnapshotIntegrityError";
  }
}

export interface CloudSnapshotDocument {
  id: string;
  data: () => unknown;
}

export interface CloudSnapshotParent {
  entityCount?: unknown;
  revision?: unknown;
  complete?: unknown;
  status?: unknown;
}

export interface StrictParsedEntity {
  key: string;
  entityType: CloudSyncEntityType;
  entityId: string;
  contentHash: string;
  contentHashVersion?: number;
  contentHashAlgorithm?: "sha256" | "fnv1a";
  payload: Record<string, unknown>;
  deleted: boolean;
  payloadDocumentHash?: string;
  payloadByteSize?: number;
  revision: number;
}

export interface StrictParsedReviewEvent {
  id: string;
  contentHash: string;
  payload: Record<string, unknown>;
  revision: number;
}

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

const isCount = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

const isRevision = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

const nonEmptyString = (value: unknown): value is string =>
  typeof value === "string" && value.trim().length > 0;

/** Classify a snapshot parent document without reading any child document. */
export const classifyCloudRecoverySnapshot = (parent: CloudSnapshotParent): CloudRecoverySnapshotStatus => {
  if (parent.complete === true) return "complete";
  if (parent.complete === false || parent.status === "writing") return "writing";
  return isCount(parent.entityCount) && parent.entityCount > 0 ? "legacy-unverified" : "unverifiable";
};

export const describeCloudRecoverySnapshotStatus = (status: CloudRecoverySnapshotStatus): string => {
  switch (status) {
    case "complete":
      return "完整";
    case "writing":
      return "写入未完成";
    case "legacy-unverified":
      return "旧版快照（恢复前会严格校验）";
    case "unverifiable":
      return "无法证明完整，不可恢复";
  }
};

export const isCloudRecoverySnapshotRestorable = (status: CloudRecoverySnapshotStatus): boolean =>
  status === "complete" || status === "legacy-unverified";

const parseStrictEntity = (documentId: string, value: unknown): StrictParsedEntity => {
  if (!isPlainObject(value)) {
    throw new CloudSnapshotIntegrityError(`云端恢复快照损坏：实体文档 ${documentId} 不是有效对象。请选择其他恢复点或改用完整备份恢复。`);
  }
  const entityType = value.entityType;
  if (typeof entityType !== "string" || !CLOUD_SNAPSHOT_ENTITY_TYPES.has(entityType)) {
    throw new CloudSnapshotIntegrityError(`云端恢复快照损坏：实体 ${documentId} 的类型无法识别。请在云端恢复点列表中选择其他恢复点。`);
  }
  if (!nonEmptyString(value.entityId)) {
    throw new CloudSnapshotIntegrityError(`云端恢复快照损坏：实体 ${documentId} 缺少稳定身份。请在云端恢复点列表中选择其他恢复点。`);
  }
  const expectedKey = `${entityType}:${value.entityId}`;
  // The document id is the entity key in every protocol version this client knows. A `key` field
  // that disagrees means two writers disagreed about identity, so the set cannot be trusted.
  if (documentId !== expectedKey) {
    throw new CloudSnapshotIntegrityError(`云端恢复快照损坏：实体 ${documentId} 的身份标识与类型不一致。请在云端恢复点列表中选择其他恢复点。`);
  }
  if (typeof value.key === "string" && value.key !== documentId) {
    throw new CloudSnapshotIntegrityError(`云端恢复快照损坏：实体 ${documentId} 的键与内容不一致。请在云端恢复点列表中选择其他恢复点。`);
  }
  if (!nonEmptyString(value.contentHash)) {
    throw new CloudSnapshotIntegrityError(`云端恢复快照损坏：实体 ${documentId} 缺少内容哈希。请在云端恢复点列表中选择其他恢复点。`);
  }
  if (!isRevision(value.revision)) {
    throw new CloudSnapshotIntegrityError(`云端恢复快照损坏：实体 ${documentId} 的修订号非法。请在云端恢复点列表中选择其他恢复点。`);
  }
  const deleted = value.deleted === true;
  const payloadDocumentHash = nonEmptyString(value.payloadDocumentHash) ? value.payloadDocumentHash : undefined;
  if (value.payloadDocumentHash !== undefined && !payloadDocumentHash) {
    throw new CloudSnapshotIntegrityError(`云端恢复快照损坏：实体 ${documentId} 的大文本引用非法。请在云端恢复点列表中选择其他恢复点。`);
  }
  if (!isPlainObject(value.payload)) {
    throw new CloudSnapshotIntegrityError(`云端恢复快照损坏：实体 ${documentId} 缺少有效载荷。请在云端恢复点列表中选择其他恢复点。`);
  }
  const payload = value.payload;
  if (payloadDocumentHash) {
    // Large payloads live in Storage addressed by `payloadDocumentHash`; the placeholder document
    // is intentionally empty and the real content is hash-verified after download.
  } else if (deleted) {
    // A tombstone may carry an empty payload, but it must not carry a contradictory live one.
    if (nonEmptyString(payload.id) && payload.id !== value.entityId) {
      throw new CloudSnapshotIntegrityError(`云端恢复快照损坏：删除标记 ${documentId} 与载荷身份不一致。请在云端恢复点列表中选择其他恢复点。`);
    }
  } else {
    if (Object.keys(payload).length === 0) {
      throw new CloudSnapshotIntegrityError(`云端恢复快照损坏：实体 ${documentId} 的载荷为空。请在云端恢复点列表中选择其他恢复点。`);
    }
    if (payload.id !== value.entityId) {
      throw new CloudSnapshotIntegrityError(`云端恢复快照损坏：实体 ${documentId} 的载荷身份不一致。请在云端恢复点列表中选择其他恢复点。`);
    }
  }
  if (value.payloadByteSize !== undefined && !isCount(value.payloadByteSize)) {
    throw new CloudSnapshotIntegrityError(`云端恢复快照损坏：实体 ${documentId} 的大文本大小非法。请在云端恢复点列表中选择其他恢复点。`);
  }
  return {
    key: documentId,
    entityType: entityType as CloudSyncEntityType,
    entityId: value.entityId,
    contentHash: value.contentHash,
    contentHashVersion: typeof value.contentHashVersion === "number" ? value.contentHashVersion : undefined,
    contentHashAlgorithm: value.contentHashAlgorithm === "sha256" || value.contentHashAlgorithm === "fnv1a"
      ? value.contentHashAlgorithm
      : undefined,
    payload,
    deleted,
    payloadDocumentHash,
    payloadByteSize: value.payloadByteSize as number | undefined,
    revision: value.revision,
  };
};

const parseStrictReviewEvent = (documentId: string, value: unknown): StrictParsedReviewEvent => {
  if (!isPlainObject(value)) {
    throw new CloudSnapshotIntegrityError(`云端恢复快照损坏：复习事件 ${documentId} 不是有效对象。请在云端恢复点列表中选择其他恢复点。`);
  }
  const id = documentId.slice(REVIEW_EVENT_DOCUMENT_PREFIX.length);
  if (!nonEmptyString(id)) {
    throw new CloudSnapshotIntegrityError(`云端恢复快照损坏：复习事件 ${documentId} 缺少编号。请在云端恢复点列表中选择其他恢复点。`);
  }
  if (!nonEmptyString(value.contentHash)) {
    throw new CloudSnapshotIntegrityError(`云端恢复快照损坏：复习事件 ${documentId} 缺少内容哈希。请在云端恢复点列表中选择其他恢复点。`);
  }
  if (!isRevision(value.revision)) {
    throw new CloudSnapshotIntegrityError(`云端恢复快照损坏：复习事件 ${documentId} 的修订号非法。请在云端恢复点列表中选择其他恢复点。`);
  }
  if (!isPlainObject(value.payload) || Object.keys(value.payload).length === 0) {
    throw new CloudSnapshotIntegrityError(`云端恢复快照损坏：复习事件 ${documentId} 缺少有效载荷。请在云端恢复点列表中选择其他恢复点。`);
  }
  if (value.payload.id !== undefined && value.payload.id !== id) {
    throw new CloudSnapshotIntegrityError(`云端恢复快照损坏：复习事件 ${documentId} 的载荷身份不一致。请在云端恢复点列表中选择其他恢复点。`);
  }
  return { id, contentHash: value.contentHash, payload: value.payload, revision: value.revision };
};

export interface StrictCloudSnapshot {
  status: Exclude<CloudRecoverySnapshotStatus, "unverifiable" | "writing">;
  expectedCount: number;
  revision: number;
  entities: StrictParsedEntity[];
  reviewEvents: StrictParsedReviewEvent[];
}

/**
 * Validate the input of a destructive full replacement that was assembled from the *active* cloud
 * set rather than from one snapshot document collection.
 *
 * The incremental dataset is a merged view, so there is no external cardinality to compare against;
 * what must still hold is that every member is a well-formed, uniquely identified protocol entity.
 * A single contradiction rejects the whole replacement.
 */
export const assertStrictRemoteDataset = (params: {
  entities: Array<Pick<StrictParsedEntity, "key" | "entityType" | "entityId" | "contentHash" | "revision" | "payload" | "payloadDocumentHash" | "payloadByteSize" | "contentHashVersion" | "contentHashAlgorithm"> & { deleted?: boolean }>;
  reviewEvents: Array<Pick<StrictParsedReviewEvent, "id" | "contentHash" | "payload" | "revision">>;
}): void => {
  const seen = new Set<string>();
  for (const entity of params.entities) {
    if (seen.has(entity.key)) {
      throw new CloudSnapshotIntegrityError(`云端数据不一致：实体 ${entity.key} 重复，已拒绝覆盖本机数据。请稍后重试或联系支持清理云端数据。`);
    }
    seen.add(entity.key);
    parseStrictEntity(entity.key, entity);
  }
  const seenEvents = new Set<string>();
  for (const event of params.reviewEvents) {
    if (seenEvents.has(event.id)) {
      throw new CloudSnapshotIntegrityError(`云端数据不一致：复习事件 ${event.id} 重复，已拒绝覆盖本机数据。请稍后重试或联系支持清理云端数据。`);
    }
    seenEvents.add(event.id);
    parseStrictReviewEvent(`${REVIEW_EVENT_DOCUMENT_PREFIX}${event.id}`, event);
  }
};

/**
 * Validate a whole recovery snapshot before anything local is touched.
 *
 * Every failure path throws; there is no "filter and continue" mode here on purpose. Callers must
 * run this before replacing the local database, the ledger or the cursor.
 */
export const assertStrictCloudSnapshot = (params: {
  snapshotId: string;
  parent: CloudSnapshotParent;
  documents: CloudSnapshotDocument[];
}): StrictCloudSnapshot => {
  const { parent, documents } = params;
  const status = classifyCloudRecoverySnapshot(parent);
  if (status === "writing") {
    throw new CloudSnapshotIntegrityError("该云端恢复点尚未完成写入，不能用于恢复。请稍后重试或选择其他恢复点。");
  }
  if (status === "unverifiable") {
    throw new CloudSnapshotIntegrityError("该云端恢复点缺少可靠的完整性记录，无法证明数据完整，已拒绝恢复。请选择其他恢复点，或改用完整备份恢复。");
  }
  if (!isCount(parent.entityCount)) {
    throw new CloudSnapshotIntegrityError("该云端恢复点的条目数量记录非法，已拒绝恢复。请选择其他恢复点。");
  }
  const expectedCount = parent.entityCount;
  const revision = isRevision(parent.revision) ? parent.revision : 0;

  const seen = new Set<string>();
  const entities: StrictParsedEntity[] = [];
  const reviewEvents: StrictParsedReviewEvent[] = [];
  for (const document of documents) {
    if (seen.has(document.id)) {
      throw new CloudSnapshotIntegrityError(`云端恢复快照损坏：条目 ${document.id} 重复。请在云端恢复点列表中选择其他恢复点。`);
    }
    seen.add(document.id);
    const value = document.data();
    if (document.id.startsWith(REVIEW_EVENT_DOCUMENT_PREFIX)) {
      reviewEvents.push(parseStrictReviewEvent(document.id, value));
    } else {
      entities.push(parseStrictEntity(document.id, value));
    }
  }

  const actualCount = entities.length + reviewEvents.length;
  if (actualCount !== expectedCount) {
    throw new CloudSnapshotIntegrityError(
      `云端恢复快照不完整：记录应有 ${expectedCount} 项，实际读取到 ${actualCount} 项（实体 ${entities.length}、复习事件 ${reviewEvents.length}）。`
      + "为避免覆盖本机数据，已拒绝恢复；请选择其他恢复点或改用完整备份恢复。",
    );
  }

  return { status, expectedCount, revision, entities, reviewEvents };
};

/**
 * Verify one downloaded Storage object against the entity that points at it.
 *
 * Content addressing alone is not proof: the path `assets/<hash>` can return a different object,
 * a truncated object, or an object written by an older/broken client. The bytes are therefore
 * re-hashed and compared with the declaration before they may enter a snapshot. The comparison
 * itself lives in `assetIntegrity` so a zip archive or folder repository cannot end up with a
 * subtly different rule than a cloud download.
 *
 * Note the entity's own `contentHashAlgorithm`/`contentHashVersion` are deliberately NOT used here:
 * they describe how the entity *payload* is hashed (`sha256` or the legacy `fnv1a`, version 1 or 2)
 * and say nothing about the blob address. Legacy asset documents legitimately carry `fnv1a` there
 * while `payload.contentHash` is still a `hashBlob` result, so treating that field as the blob hash
 * format would reject valid old data.
 */
export const assertDownloadedAssetVerified = async (params: {
  hash: string;
  blob: Blob;
  label?: string;
  declaredSize?: unknown;
  declaredMimeType?: unknown;
}): Promise<void> => {
  const name = params.label ?? params.hash;
  const failure = await assetByteFailure({
    hash: params.hash,
    blob: params.blob,
    declaredSize: params.declaredSize,
    declaredMimeType: params.declaredMimeType,
  });
  if (!failure) return;
  throw new CloudSnapshotIntegrityError(
    `云端资源校验失败：${describeAssetByteFailure(name, failure)}`
    + "本机数据、同步游标与云同步记录均未改变。请重试；若持续失败，请改用完整备份恢复或联系支持核查云存储对象。",
  );
};
