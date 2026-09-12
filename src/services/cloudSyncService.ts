import { FirebaseAuthentication } from "@capacitor-firebase/authentication";
import type { User } from "firebase/auth";
import { getRedirectResult, GoogleAuthProvider, onAuthStateChanged, signInWithCredential, signInWithPopup, signOut } from "firebase/auth";
import {
  collection,
  doc,
  documentId,
  getCountFromServer,
  getDoc,
  getDocs,
  limit,
  orderBy,
  query,
  runTransaction,
  setDoc,
  where,
  writeBatch,
} from "firebase/firestore";
import type { Query, Transaction, WriteBatch } from "firebase/firestore";
import { deleteObject, getBlob, getMetadata, list, ref, uploadBytesResumable } from "firebase/storage";
import type { StorageReference } from "firebase/storage";

import type {
  AppSettings,
  CloudSyncEntityType,
  CloudSyncExpectedValue,
  CloudSyncLedgerRecord,
  CloudSyncOperationPhase,
  CloudSyncOperationRecord,
  CloudSyncStateRecord,
  ImportOptions,
} from "../types";
import { db } from "../db/database";
import { newId } from "../lib/entity";
import { isAndroidPlatform, isDesktopPlatform, isNativePlatform } from "../lib/platform";
import { firebaseAuth, firebaseStorage, firestore, googleAuthProvider } from "./firebase";
import {
  exportCloudSync,
  ASSET_CONTENT_HASH_VERSION,
  BLOCK_CONTENT_HASH_VERSION,
  createCloudPayloadDocument,
  legacyBlockHashPayload,
  legacyEntityHashPayload,
  legacyFnvHashValue,
  hashValue,
  findConflictingChanges,
  materializeCloudSyncSnapshot,
  withDecisionBlockConflictCopies,
  mergeCloudSyncSmallEntity,
  mergeCloudSyncEntities,
  NON_CONFLICTING_ENTITY_TYPES,
  preserveAssetOperationalFields,
  preserveLocalChangesForCloudWins,
  syncHashPayload,
  isBootstrapOnlyCloudData,
  withCloudPayloadDocument,
  type CloudReviewEvent,
  type CloudHashAlgorithm,
  type CloudSyncEntity,
  type CloudSyncExport,
} from "./cloudSyncModel";
import { CloudSyncLocalMutationError, storage } from "./storageAdapter";
import { snapshotToZip, summarizeSnapshot, zipToSnapshot } from "./backup";
import { sanitizeSettingsForExport } from "./exportPrivacy";
import {
  downloadNativeFirebaseStorageBlob,
  listNativeFirebaseStoragePaths,
  nativeFirebaseStorageObjectExists,
  uploadNativeFirebaseStorageBlob,
} from "./nativeFirebaseStorage";

const PROTOCOL_VERSION = 2;
const MAX_BATCH_WRITES = 400;
const LOCK_DURATION_MS = 30 * 60 * 1000;
const LOCK_RENEW_INTERVAL_MS = 5 * 60 * 1000;
const LOCK_STALE_AFTER_MS = LOCK_RENEW_INTERVAL_MS * 2;
const SNAPSHOT_LIMIT = 3;
const EXPENSIVE_WRITE_THRESHOLD = 5_000;
const EXPENSIVE_WRITE_STORAGE_OBJECTS = 500;
const EXPENSIVE_WRITE_STORAGE_BYTES = 100 * 1024 * 1024;
const DESKTOP_AUTH_TIMEOUT_MS = 90_000;
const LEGACY_SNAPSHOT_FILE = "snapshots/current.zip";
const LEGACY_METADATA_DOCUMENT = "current";

export type RemoteSyncLock = {
  deviceId: string;
  operationId?: string;
  revision?: number;
  expiresAt: number;
  acquiredAt?: number;
  lastRenewedAt?: number;
  fencingRevision?: number;
};

type RemoteSyncState = {
  protocolVersion: number;
  headRevision: number;
  nextRevision: number;
  lock?: RemoteSyncLock | null;
  storageSummary?: RemoteStorageSummary | null;
  lastLockRecovery?: {
    operationId?: string;
    revision?: number;
    byDeviceId: string;
    recoveredAt: number;
    reason: string;
  };
};

/** Deduplicated active Firebase Storage footprint for the visible cloud revision. */
export type RemoteStorageSummary = {
  revision: number;
  assetObjectCount: number;
  assetBytes: number;
  payloadObjectCount: number;
  payloadBytes: number;
};

type RemoteEntity = CloudSyncEntity & { revision: number };
type RemoteReviewEvent = CloudReviewEvent & { revision: number };

export interface CloudSnapshotInfo {
  updatedAt: string;
  byteSize: number;
  version: number;
}

export interface CloudSyncStatus {
  protocolVersion: number;
  cloudRevision: number;
  localPending: number;
  remotePending: number;
  snapshotCount: number;
  legacySnapshotAvailable: boolean;
  lastSyncedAt?: string;
  lastSnapshotMaintenanceError?: string;
  lastSnapshotMaintenanceFailedAt?: string;
  lastSnapshotMaintenanceStatus?: "completed" | "deferred-cost" | "failed";
  lastSnapshotMaintenanceDeferredAt?: string;
  /** Deduplicated Firebase Storage bytes/objects for the currently visible revision. */
  storageBytes: number;
  storageObjectCount: number;
  /** False when the active revision predates storage-summary tracking (older sync history). */
  storageKnown: boolean;
}

export interface CloudRecoverySnapshot {
  id: string;
  createdAt: string;
  label: string;
  entityCount: number;
  revision: number;
}

export interface CloudSyncProgress {
  stage: "checking" | "downloading" | "uploading" | "applying" | "snapshot" | "done";
  message: string;
  current?: number;
  total?: number;
}

export type CloudSyncConflictChoice = "local" | "cloud";

export interface CloudSyncConflict {
  reason: "concurrent-changes" | "legacy-snapshot" | "local-changed-during-sync";
  localChanges: number;
  remoteChanges: number;
  cloudRevision: number;
  conflicts?: Array<{
    key: string;
    entityType?: CloudSyncEntityType;
    fields?: string[];
    reason?: "content" | "field";
  }>;
}

export interface CloudSyncReadEstimate {
  mode: "incremental" | "full";
  estimatedReads: number;
  entityReads: number;
  reviewEventReads: number;
  targetedReads: number;
  overheadReads: number;
  /** Deduplicated Storage objects this restore is expected to download. */
  storageObjectCount: number;
  /** Total bytes for those Storage objects. */
  storageBytes: number;
  /** False means old/incomplete metadata prevents a reliable Storage estimate. */
  storageKnown: boolean;
}

export interface CloudSyncWriteEstimate {
  estimatedWrites: number;
  entityWrites: number;
  reviewEventWrites: number;
  overheadWrites: number;
  /** Upper bound before content-addressed Storage existence checks. */
  storageObjectCount: number;
  storageBytes: number;
}

export type CloudSyncBudgetChoice = CloudSyncConflictChoice | "sync";

export type CloudSyncResult =
  | { kind: "synced"; uploaded: number; downloaded: number; revision: number; pending: number; restored?: boolean }
  | { kind: "conflict"; conflict: CloudSyncConflict }
  | { kind: "read-budget"; estimate: CloudSyncReadEstimate; message: string; choice: CloudSyncConflictChoice }
  | { kind: "write-budget"; estimate: CloudSyncWriteEstimate; message: string; choice: CloudSyncBudgetChoice }
  | { kind: "uncertain"; operationId: string; revision: number; message: string };

export interface CloudSyncOptions {
  onProgress?: (progress: CloudSyncProgress) => void;
  signal?: AbortSignal;
  /** Allows a user-confirmed recovery that may read a large portion of Firestore. */
  allowExpensiveRead?: boolean;
  /** Allows a user-confirmed publish that may consume a large portion of the daily write quota. */
  allowExpensiveWrite?: boolean;
}

export interface CloudDownloadOptions {
  onImportProgress?: ImportOptions["onProgress"];
}

const stateRef = (uid: string) => doc(firestore, "users", uid, "syncState", "current");
const entitiesRef = (uid: string) => collection(firestore, "users", uid, "syncEntities");
const entityRef = (uid: string, key: string) => doc(firestore, "users", uid, "syncEntities", key);
const reviewEventsRef = (uid: string) => collection(firestore, "users", uid, "syncReviewEvents");
const reviewEventRef = (uid: string, id: string) => doc(firestore, "users", uid, "syncReviewEvents", id);
const snapshotsRef = (uid: string) => collection(firestore, "users", uid, "syncSnapshots");
const snapshotRef = (uid: string, id: string) => doc(firestore, "users", uid, "syncSnapshots", id);
const snapshotEntitiesRef = (uid: string, id: string) => collection(firestore, "users", uid, "syncSnapshots", id, "entities");
const assetRef = (uid: string, hash: string) => ref(firebaseStorage, `users/${uid}/assets/${hash}`);
const assetsRootRef = (uid: string) => ref(firebaseStorage, `users/${uid}/assets`);
const documentRef = (uid: string, hash: string) => ref(firebaseStorage, `users/${uid}/documents/${hash}`);
const documentsRootRef = (uid: string) => ref(firebaseStorage, `users/${uid}/documents`);
const legacyMetadataRef = (uid: string) => doc(firestore, "users", uid, "cloudSync", LEGACY_METADATA_DOCUMENT);
const legacySnapshotRef = (uid: string) => ref(firebaseStorage, `users/${uid}/${LEGACY_SNAPSHOT_FILE}`);

const getCloudStorageBlob = async (uid: string, storageRef: StorageReference): Promise<Blob> => {
  const desktopStorage = isDesktopPlatform() ? window.studyJournalDesktop?.firebaseStorage : undefined;
  const user = firebaseAuth.currentUser;
  if (isAndroidPlatform() && user?.uid === uid) {
    return downloadNativeFirebaseStorageBlob(storageRef.fullPath, await getIdTokenFor(user));
  }
  if (!desktopStorage || !user || user.uid !== uid) {
    return getBlob(storageRef);
  }
  const { data, contentType } = await desktopStorage.download(uid, storageRef.fullPath, await getIdTokenFor(user));
  return new Blob([data], { type: contentType });
};

const uploadCloudStorageBlob = async (
  uid: string,
  storageRef: StorageReference,
  blob: Blob,
  onProgress?: (bytesTransferred: number, totalBytes: number) => void,
) => {
  const desktopStorage = isDesktopPlatform() ? window.studyJournalDesktop?.firebaseStorage : undefined;
  const user = firebaseAuth.currentUser;
  if (isAndroidPlatform() && user?.uid === uid) {
    await uploadNativeFirebaseStorageBlob(storageRef.fullPath, blob, await getIdTokenFor(user), onProgress);
    return;
  }
  if (desktopStorage && user?.uid === uid) {
    await desktopStorage.upload(
      uid,
      storageRef.fullPath,
      await getIdTokenFor(user),
      await blob.arrayBuffer(),
      blob.type || "application/octet-stream",
    );
    onProgress?.(blob.size, blob.size);
    return;
  }
  const task = uploadBytesResumable(storageRef, blob, { contentType: blob.type || "application/octet-stream" });
  await new Promise<void>((resolve, reject) => task.on("state_changed", (snapshot) => {
    onProgress?.(snapshot.bytesTransferred, snapshot.totalBytes);
  }, reject, resolve));
};

const cloudStorageObjectExists = async (uid: string, storageRef: StorageReference): Promise<boolean> => {
  const desktopStorage = isDesktopPlatform() ? window.studyJournalDesktop?.firebaseStorage : undefined;
  const user = firebaseAuth.currentUser;
  if (isAndroidPlatform() && user?.uid === uid) {
    return nativeFirebaseStorageObjectExists(storageRef.fullPath, await getIdTokenFor(user));
  }
  if (desktopStorage && user?.uid === uid) {
    return desktopStorage.exists(uid, storageRef.fullPath, await getIdTokenFor(user));
  }
  try {
    await getMetadata(storageRef);
    return true;
  } catch (error) {
    if ((error as { code?: string }).code === "storage/object-not-found") return false;
    throw error;
  }
};

const progress = (options: CloudSyncOptions, stage: CloudSyncProgress["stage"], message: string, current?: number, total?: number) =>
  options.onProgress?.({ stage, message, current, total });

/**
 * Firebase's web SDK can leave a request pending indefinitely after a proxy/network change in
 * Android WebView. Surface a useful error instead of relying on the UI watchdog to guess why the
 * operation stopped. This does not cancel the underlying SDK request, so callers must still avoid
 * mutating local state until the raced promise has resolved.
 */
export const withTimeout = <T>(promise: PromiseLike<T>, ms: number, message: string): Promise<T> => {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => reject(new Error(message)), ms);
  });
  return Promise.race([Promise.resolve(promise), timeout]).finally(() => {
    if (timeoutId) clearTimeout(timeoutId);
  });
};

const AUTH_TOKEN_TIMEOUT_MS = 20_000;
const getIdTokenFor = (user: User) => withTimeout(
  user.getIdToken(),
  AUTH_TOKEN_TIMEOUT_MS,
  "刷新 Firebase 登录令牌超时，请重新登录后重试。",
);

/** Run network work with a small fixed number of concurrent requests. */
export const mapWithConcurrency = async <T, R>(
  items: T[],
  concurrency: number,
  mapper: (item: T, index: number) => Promise<R>,
): Promise<R[]> => {
  if (items.length === 0) return [];
  const results = new Array<R>(items.length);
  let nextIndex = 0;
  const workerCount = Math.min(items.length, Math.max(1, Math.floor(concurrency)));
  const worker = async () => {
    while (true) {
      const index = nextIndex++;
      if (index >= items.length) return;
      results[index] = await mapper(items[index], index);
    }
  };
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return results;
};

/**
 * Firestore's long-lived connection can wedge after a network/proxy change (the same Android
 * WebView class of issue the Storage calls below already guard against) — a read or transaction
 * then neither resolves nor rejects, so the UI watchdog is the only thing that ever notices,
 * minutes later. These give the same "explicit error over silent hang" treatment to every
 * Firestore call in this file. Document reads/writes have no legitimate reason to take long, so
 * the window is much shorter than the Storage timeouts (which must tolerate large file transfers).
 */
const FIRESTORE_READ_TIMEOUT_MS = 20_000;
const FIRESTORE_LOCK_TIMEOUT_MS = 20_000;
const FIRESTORE_BATCH_TIMEOUT_MS = 30_000;
const EXPENSIVE_READ_THRESHOLD = 40_000;
const READ_RISK_THRESHOLD = 50_000;
const EXPENSIVE_STORAGE_BYTES = 100 * 1024 * 1024;
const EXPENSIVE_STORAGE_OBJECTS = 500;
const TARGETED_READ_BATCH_SIZE = 30;
const AUTO_MAINTENANCE_MAX_REFERENCED_DOCS = 5_000;
const AUTO_MAINTENANCE_MAX_STORAGE_ITEMS_PER_ROOT = 250;
const AUTO_MAINTENANCE_MAX_DELETES = 500;
const AUTO_MAINTENANCE_MAX_DURATION_MS = 60_000;

const parseLegacySnapshotInfo = (value: unknown): CloudSnapshotInfo | undefined => {
  if (!value || typeof value !== "object") return undefined;
  const data = value as Record<string, unknown>;
  if (typeof data.updatedAt !== "string" || typeof data.byteSize !== "number" || typeof data.version !== "number") return undefined;
  return { updatedAt: data.updatedAt, byteSize: data.byteSize, version: data.version };
};

const emptyRemoteState = (): RemoteSyncState => ({ protocolVersion: PROTOCOL_VERSION, headRevision: 0, nextRevision: 0, lock: null, storageSummary: null });

const parseStorageSummary = (value: unknown): RemoteStorageSummary | null => {
  if (!value || typeof value !== "object") return null;
  const summary = value as Record<string, unknown>;
  const fields = ["revision", "assetObjectCount", "assetBytes", "payloadObjectCount", "payloadBytes"] as const;
  if (fields.some((field) => typeof summary[field] !== "number" || !Number.isFinite(summary[field]) || summary[field] < 0)) return null;
  return {
    revision: summary.revision as number,
    assetObjectCount: summary.assetObjectCount as number,
    assetBytes: summary.assetBytes as number,
    payloadObjectCount: summary.payloadObjectCount as number,
    payloadBytes: summary.payloadBytes as number,
  };
};

const parseRemoteState = (value: unknown): RemoteSyncState => {
  if (!value || typeof value !== "object") return emptyRemoteState();
  const data = value as Record<string, unknown>;
  const lastLockRecovery = data.lastLockRecovery && typeof data.lastLockRecovery === "object" ? (() => {
    const recovery = data.lastLockRecovery as Record<string, unknown>;
    return typeof recovery.byDeviceId === "string" && typeof recovery.recoveredAt === "number" && typeof recovery.reason === "string"
      ? {
        byDeviceId: recovery.byDeviceId,
        recoveredAt: recovery.recoveredAt,
        reason: recovery.reason,
        ...(typeof recovery.operationId === "string" ? { operationId: recovery.operationId } : {}),
        ...(typeof recovery.revision === "number" ? { revision: recovery.revision } : {}),
      }
      : undefined;
  })() : undefined;
  return {
    protocolVersion: typeof data.protocolVersion === "number" ? data.protocolVersion : PROTOCOL_VERSION,
    headRevision: typeof data.headRevision === "number" ? data.headRevision : 0,
    nextRevision: typeof data.nextRevision === "number" ? data.nextRevision : 0,
    storageSummary: parseStorageSummary(data.storageSummary),
    ...(lastLockRecovery ? { lastLockRecovery } : {}),
    lock: data.lock && typeof data.lock === "object" ? (() => {
      const lock = data.lock as Record<string, unknown>;
      return typeof lock.deviceId === "string" && typeof lock.expiresAt === "number"
        ? {
          deviceId: lock.deviceId,
          expiresAt: lock.expiresAt,
          ...(typeof lock.operationId === "string" ? { operationId: lock.operationId } : {}),
          ...(typeof lock.revision === "number" ? { revision: lock.revision } : {}),
          ...(typeof lock.acquiredAt === "number" ? { acquiredAt: lock.acquiredAt } : {}),
          ...(typeof lock.lastRenewedAt === "number" ? { lastRenewedAt: lock.lastRenewedAt } : {}),
          ...(typeof lock.fencingRevision === "number" ? { fencingRevision: lock.fencingRevision } : {}),
        }
        : null;
    })() : null,
  };
};

/** Convert sync metadata to a Firestore-safe document without undefined optional fields. */
export const remoteSyncStateDocument = (state: RemoteSyncState) => ({
  protocolVersion: state.protocolVersion,
  headRevision: state.headRevision,
  nextRevision: state.nextRevision,
  lock: state.lock ?? null,
  storageSummary: state.storageSummary ?? null,
  ...(state.lastLockRecovery ? {
    lastLockRecovery: {
      byDeviceId: state.lastLockRecovery.byDeviceId,
      recoveredAt: state.lastLockRecovery.recoveredAt,
      reason: state.lastLockRecovery.reason,
      ...(typeof state.lastLockRecovery.operationId === "string" ? { operationId: state.lastLockRecovery.operationId } : {}),
      ...(typeof state.lastLockRecovery.revision === "number" ? { revision: state.lastLockRecovery.revision } : {}),
    },
  } : {}),
});

const parseRemoteEntity = (id: string, value: unknown): RemoteEntity | undefined => {
  if (!value || typeof value !== "object") return undefined;
  const data = value as Record<string, unknown>;
  if (
    typeof data.entityType !== "string" ||
    typeof data.entityId !== "string" ||
    typeof data.contentHash !== "string" ||
    typeof data.revision !== "number" ||
    !data.payload || typeof data.payload !== "object"
  ) return undefined;
  return {
    key: id,
    entityType: data.entityType as CloudSyncEntityType,
    entityId: data.entityId,
    contentHash: data.contentHash,
    contentHashVersion: typeof data.contentHashVersion === "number" ? data.contentHashVersion : undefined,
    contentHashAlgorithm: data.contentHashAlgorithm === "sha256" || data.contentHashAlgorithm === "fnv1a"
      ? data.contentHashAlgorithm as CloudHashAlgorithm
      : data.contentHash.startsWith("fnv-") ? "fnv1a" : "sha256",
    payload: data.payload as Record<string, unknown>,
    deleted: Boolean(data.deleted),
    payloadDocumentHash: typeof data.payloadDocumentHash === "string" ? data.payloadDocumentHash : undefined,
    payloadByteSize: typeof data.payloadByteSize === "number" ? data.payloadByteSize : undefined,
    revision: data.revision,
  };
};

export const normalizeRemoteEntity = async (entity: RemoteEntity): Promise<RemoteEntity> => {
  if (entity.deleted || Object.keys(entity.payload).length === 0) return entity;
  if (entity.entityType === "settings") {
    const payload = sanitizeSettingsForExport(entity.payload as unknown as AppSettings) as unknown as Record<string, unknown>;
    return {
      ...entity,
      payload,
      contentHash: await hashValue(syncHashPayload(entity.entityType, payload)),
      contentHashAlgorithm: "sha256",
    };
  }
  const currentVersion = entity.entityType === "asset"
    ? ASSET_CONTENT_HASH_VERSION
    : entity.entityType === "block" ? BLOCK_CONTENT_HASH_VERSION : undefined;
  const versionCurrent = currentVersion === undefined || entity.contentHashVersion === currentVersion;
  if (versionCurrent && entity.contentHashAlgorithm === "sha256") return entity;
  return {
    ...entity,
    contentHash: await hashValue(syncHashPayload(entity.entityType, entity.payload)),
    contentHashAlgorithm: "sha256",
    ...(currentVersion !== undefined ? { contentHashVersion: currentVersion } : {}),
  };
};

const parseAndNormalizeRemoteEntities = async (docs: Array<{ id: string; data: () => unknown }>) => {
  const parsed = docs
    .map((item) => parseRemoteEntity(item.id, item.data()))
    .filter((item): item is RemoteEntity => Boolean(item));
  return Promise.all(parsed.map(normalizeRemoteEntity));
};

const parseRemoteReviewEvent = (id: string, value: unknown): RemoteReviewEvent | undefined => {
  if (!value || typeof value !== "object") return undefined;
  const data = value as Record<string, unknown>;
  if (typeof data.contentHash !== "string" || typeof data.revision !== "number" || !data.payload || typeof data.payload !== "object") return undefined;
  return { id, contentHash: data.contentHash, payload: data.payload as Record<string, unknown>, revision: data.revision };
};

const ledgerId = (type: CloudSyncEntityType | "review-event", id: string) => `${type}:${id}`;

const newDeviceId = () => globalThis.crypto?.randomUUID?.() ?? newId();

class CloudSyncLockLostError extends Error {
  constructor() {
    super("同步锁已失效，未发布的数据将留待核对后重试。");
    this.name = "CloudSyncLockLostError";
  }
}

class CloudSyncResultUnknownError extends Error {
  readonly operationId: string;
  readonly revision: number;

  constructor(operationId: string, revision: number, message: string) {
    super(message);
    this.name = "CloudSyncResultUnknownError";
    this.operationId = operationId;
    this.revision = revision;
  }
}

const isTimeoutError = (error: unknown) => error instanceof Error && /超时|timeout/i.test(error.message);

const operationFor = async (operationId: string) => db.cloudSyncOperations.get(operationId);

const pendingOperationsFor = async (uid: string) => db.cloudSyncOperations
  .where("userId")
  .equals(uid)
  .filter((operation) => operation.status === "pending" || operation.status === "unknown" || Boolean(operation.lockReleaseError))
  .toArray();

const saveOperation = async (operation: CloudSyncOperationRecord) => {
  await db.cloudSyncOperations.put({ ...operation, updatedAt: new Date().toISOString() });
};

const updateOperation = async (operationId: string, patch: Partial<CloudSyncOperationRecord>) => {
  const current = await operationFor(operationId);
  if (!current) return undefined;
  const terminalRecovery = patch.status === "succeeded" || patch.status === "superseded";
  const next = {
    ...current,
    ...patch,
    ...(terminalRecovery ? { lockReleaseError: undefined, lockReleaseErrorAt: undefined, lockReleaseAttempts: undefined } : {}),
    updatedAt: new Date().toISOString(),
  };
  await db.cloudSyncOperations.put(next);
  return next;
};

const expectedValues = (entities: CloudSyncEntity[], events: CloudReviewEvent[]): { expectedEntities: CloudSyncExpectedValue[]; expectedEvents: CloudSyncExpectedValue[] } => ({
  expectedEntities: entities.map((entity) => ({ key: entity.key, contentHash: entity.contentHash })),
  expectedEvents: events.map((event) => ({ key: event.id, contentHash: event.contentHash })),
});

/** A pure, bounded proof that every key from an unknown operation is now behind a visible newer revision. */
export const isCloudSyncOperationSuperseded = (
  operation: Pick<CloudSyncOperationRecord, "revision" | "expectedEntities" | "expectedEvents">,
  observed: { entities: Array<{ key: string; revision: number }>; events: Array<{ key: string; revision: number }> },
  headRevision: number,
) => {
  const revisions = [
    ...operation.expectedEntities.map((expected) => observed.entities.find((item) => item.key === expected.key)?.revision ?? -1),
    ...operation.expectedEvents.map((expected) => observed.events.find((item) => item.key === expected.key)?.revision ?? -1),
  ];
  return revisions.length > 0 && revisions.every((revision) => revision > operation.revision) && headRevision >= Math.max(...revisions);
};

const localState = async (uid: string): Promise<CloudSyncStateRecord> => {
  const existing = await db.cloudSyncState.get("state");
  if (existing?.userId === uid) return existing;
  const next: CloudSyncStateRecord = {
    id: "state",
    deviceId: existing?.deviceId ?? newDeviceId(),
    userId: uid,
    lastPulledRevision: 0,
    lastReviewEventRevision: 0,
  };
  await db.transaction("rw", db.cloudSyncState, db.cloudSyncLedger, async () => {
    await db.cloudSyncLedger.clear();
    await db.cloudSyncState.put(next);
  });
  return next;
};

const ledgerFor = async () => db.cloudSyncLedger.toArray();

const tombstoneFor = (ledger: CloudSyncLedgerRecord): CloudSyncEntity => ({
  key: ledger.id,
  entityType: ledger.entityType as CloudSyncEntityType,
  entityId: ledger.entityId,
  contentHash: `deleted:${ledger.contentHash}`,
  contentHashVersion: ledger.contentHashVersion,
  contentHashAlgorithm: ledger.contentHashAlgorithm,
  payload: {},
  deleted: true,
});

const matchesLedger = async (entity: CloudSyncEntity, ledger: CloudSyncLedgerRecord | undefined) => {
  if (!ledger) return false;
  if (ledger.contentHash === entity.contentHash) return true;
  if (ledger.contentHashAlgorithm === "fnv1a" || ledger.contentHash.startsWith("fnv-")) {
    const canonicalLegacy = legacyFnvHashValue(syncHashPayload(entity.entityType, entity.payload));
    if (ledger.contentHash === canonicalLegacy) return true;
    if (entity.entityType === "asset" && ledger.contentHash === legacyFnvHashValue(legacyEntityHashPayload(entity.payload))) return true;
    if (entity.entityType === "block" && ledger.contentHash === legacyFnvHashValue(legacyBlockHashPayload(entity.payload))) return true;
  }
  if (entity.entityType === "asset" && ledger.contentHashVersion !== ASSET_CONTENT_HASH_VERSION) {
    // Existing ledgers used the old asset hash that included OCR queue metadata.
    return ledger.contentHash === await hashValue(legacyEntityHashPayload(entity.payload));
  }
  if (entity.entityType === "block" && ledger.contentHashVersion !== BLOCK_CONTENT_HASH_VERSION) {
    return ledger.contentHash === await hashValue(legacyBlockHashPayload(entity.payload));
  }
  return false;
};

export const deriveLocalCloudChanges = async (exported: CloudSyncExport, ledger: CloudSyncLedgerRecord[]) => {
  const byKey = new Map(ledger.map((item) => [item.id, item]));
  const entities = (await Promise.all(exported.entities.map(async (item) => (
    await matchesLedger(item, byKey.get(item.key)) ? undefined : item
  )))).filter((item): item is CloudSyncEntity => Boolean(item));
  const present = new Set(exported.entities.map((item) => item.key));
  const removed = await Promise.all(
    ledger
      .filter((item) => item.entityType !== "review-event" && !present.has(item.id) && !item.contentHash.startsWith("deleted:"))
      .map(tombstoneFor),
  );
  const events = exported.reviewEvents.filter((item) => byKey.get(ledgerId("review-event", item.id))?.contentHash !== item.contentHash);
  return { entities: [...entities, ...removed], events };
};

const migrateLegacyLedgers = async (exported: CloudSyncExport, ledger: CloudSyncLedgerRecord[]) => {
  const byKey = new Map(ledger.map((item) => [item.id, item]));
  const updates: CloudSyncLedgerRecord[] = (await Promise.all(exported.entities
    .filter((entity) =>
      (entity.entityType === "asset" && entity.contentHashVersion === ASSET_CONTENT_HASH_VERSION) ||
      (entity.entityType === "block" && entity.contentHashVersion === BLOCK_CONTENT_HASH_VERSION),
    )
    .map(async (entity): Promise<CloudSyncLedgerRecord | undefined> => {
      const current = byKey.get(entity.key);
      const currentVersion = entity.entityType === "asset" ? ASSET_CONTENT_HASH_VERSION : BLOCK_CONTENT_HASH_VERSION;
      if (!current) return undefined;
      const legacyHash = entity.entityType === "asset"
        ? await hashValue(legacyEntityHashPayload(entity.payload))
        : await hashValue(legacyBlockHashPayload(entity.payload));
      const legacyFnvHash = entity.entityType === "asset"
        ? legacyFnvHashValue(legacyEntityHashPayload(entity.payload))
        : legacyFnvHashValue(legacyBlockHashPayload(entity.payload));
      const canonicalHash = await hashValue(syncHashPayload(entity.entityType, entity.payload));
      const matchesLegacy = current.contentHash === legacyHash || current.contentHash === legacyFnvHash || current.contentHash === legacyFnvHashValue(syncHashPayload(entity.entityType, entity.payload));
      const needsMigration = current.contentHashAlgorithm !== "sha256" || current.contentHashVersion !== currentVersion;
      return needsMigration && matchesLegacy && canonicalHash === entity.contentHash
        ? { ...current, contentHash: entity.contentHash, contentHashVersion: currentVersion, contentHashAlgorithm: "sha256" }
        : undefined;
    }))).filter((item): item is CloudSyncLedgerRecord => Boolean(item));
  if (updates.length > 0) {
    await db.transaction("rw", db.cloudSyncLedger, async () => {
      await db.cloudSyncLedger.bulkPut(updates);
    });
    const updatedByKey = new Map(updates.map((item) => [item.id, item]));
    return ledger.map((item) => updatedByKey.get(item.id) ?? item);
  }
  return ledger;
};

const getRemoteState = async (uid: string) => {
  const snapshot = await withTimeout(getDoc(stateRef(uid)), FIRESTORE_READ_TIMEOUT_MS, "检查云端同步状态超时，请确认网络可连接后重试。");
  return { exists: snapshot.exists(), state: parseRemoteState(snapshot.data()) };
};

const getRemoteChanges = async (uid: string, afterRevision: number, state: RemoteSyncState) => {
  if (state.headRevision <= afterRevision) return { entities: [] as RemoteEntity[], reviewEvents: [] as RemoteReviewEvent[] };
  const [entities, reviewEvents] = await withTimeout(
    Promise.all([
      getDocs(query(entitiesRef(uid), where("revision", ">", afterRevision), where("revision", "<=", state.headRevision), orderBy("revision"))),
      getDocs(query(reviewEventsRef(uid), where("revision", ">", afterRevision), where("revision", "<=", state.headRevision), orderBy("revision"))),
    ]),
    FIRESTORE_READ_TIMEOUT_MS,
    "拉取云端更改超时，请确认网络可连接后重试。",
  );
  return {
    entities: await parseAndNormalizeRemoteEntities(entities.docs),
    reviewEvents: reviewEvents.docs.map((item) => parseRemoteReviewEvent(item.id, item.data())).filter((item): item is RemoteReviewEvent => Boolean(item)),
  };
};

type RemoteDataset = {
  entities: RemoteEntity[];
  reviewEvents: RemoteReviewEvent[];
  changed: { entities: RemoteEntity[]; reviewEvents: RemoteReviewEvent[] };
  completeThroughRevision: number;
  mode: "incremental" | "full";
};

export const splitCloudSyncReadKeys = <T>(items: T[], size = TARGETED_READ_BATCH_SIZE) => {
  const result: T[][] = [];
  for (let index = 0; index < items.length; index += size) result.push(items.slice(index, index + size));
  return result;
};

const getTargetedRemoteDocuments = async (uid: string, entityKeys: string[], eventIds: string[]) => {
  const entityChunks = splitCloudSyncReadKeys([...new Set(entityKeys)]);
  const eventChunks = splitCloudSyncReadKeys([...new Set(eventIds)]);
  const [entityDocs, eventDocs] = await Promise.all([
    Promise.all(entityChunks.map((keys) => withTimeout(
      getDocs(query(entitiesRef(uid), where(documentId(), "in", keys))),
      FIRESTORE_READ_TIMEOUT_MS,
      "定点读取云端实体超时，请确认网络可连接后重试。",
    ))),
    Promise.all(eventChunks.map((ids) => withTimeout(
      getDocs(query(reviewEventsRef(uid), where(documentId(), "in", ids))),
      FIRESTORE_READ_TIMEOUT_MS,
      "定点读取云端复习事件超时，请确认网络可连接后重试。",
    ))),
  ]);
  return {
    entities: await parseAndNormalizeRemoteEntities(entityDocs.flatMap((snapshot) => snapshot.docs)),
    reviewEvents: eventDocs.flatMap((snapshot) => snapshot.docs)
      .map((item) => parseRemoteReviewEvent(item.id, item.data()))
      .filter((item): item is RemoteReviewEvent => Boolean(item)),
  };
};

const estimateCount = async (target: Query, afterRevision?: number, headRevision?: number) => {
  const base = afterRevision === undefined || headRevision === undefined
    ? query(target)
    : query(target, where("revision", ">", afterRevision), where("revision", "<=", headRevision));
  const result = await withTimeout(getCountFromServer(base), FIRESTORE_READ_TIMEOUT_MS, "估算云端读取量超时，请确认网络可连接后重试。 ");
  return result.data().count;
};

const remoteStorageEstimate = (remote: RemoteSyncState) => {
  const summary = remote.storageSummary;
  if (!summary || summary.revision !== remote.headRevision) {
    return { storageObjectCount: 0, storageBytes: 0, storageKnown: false };
  }
  return {
    storageObjectCount: summary.assetObjectCount + summary.payloadObjectCount,
    storageBytes: summary.assetBytes + summary.payloadBytes,
    storageKnown: true,
  };
};

const readEstimateFor = async (
  uid: string,
  remote: RemoteSyncState,
  local: CloudSyncStateRecord,
  ledger: CloudSyncLedgerRecord[],
  localExport: CloudSyncExport,
): Promise<CloudSyncReadEstimate> => {
  const complete = local.remoteDatasetCompleteThroughRevision !== undefined
    && local.remoteDatasetCompleteThroughRevision === local.lastPulledRevision
    && remote.headRevision >= local.lastPulledRevision;
  const overheadReads = 8;
  if (!complete) {
    try {
      const [entityReads, reviewEventReads] = await Promise.all([
        estimateCount(entitiesRef(uid)),
        estimateCount(reviewEventsRef(uid)),
      ]);
      return {
        mode: "full",
        entityReads,
        reviewEventReads,
        targetedReads: 0,
        overheadReads,
        estimatedReads: entityReads + reviewEventReads + overheadReads,
        ...remoteStorageEstimate(remote),
      };
    } catch {
      return {
        mode: "full",
        entityReads: 0,
        reviewEventReads: 0,
        targetedReads: 0,
        overheadReads,
        estimatedReads: Number.POSITIVE_INFINITY,
        ...remoteStorageEstimate(remote),
      };
    }
  }
  const localKeys = new Map(localExport.entities.map((entity) => [entity.key, entity]));
  const localEventIds = new Set(localExport.reviewEvents.map((event) => event.id));
  const targetedEntityKeys = ledger
    .filter((entry) => entry.entityType !== "review-event")
    .filter((entry) => !localKeys.has(entry.id) || localKeys.get(entry.id)?.deleted)
    .map((entry) => entry.id);
  const targetedEventIds = ledger
    .filter((entry) => entry.entityType === "review-event" && !localEventIds.has(entry.entityId))
    .map((entry) => entry.entityId);
  try {
    const [entityReads, reviewEventReads] = await Promise.all([
      estimateCount(entitiesRef(uid), local.lastPulledRevision, remote.headRevision),
      estimateCount(reviewEventsRef(uid), local.lastPulledRevision, remote.headRevision),
    ]);
    const targetedReads = targetedEntityKeys.length + targetedEventIds.length;
    return {
      mode: "incremental",
      entityReads,
      reviewEventReads,
      targetedReads,
      overheadReads,
      estimatedReads: entityReads + reviewEventReads + targetedReads + overheadReads,
      // Incremental recovery reads the changed documents first, then derives an exact plan from
      // the actual missing objects before it creates a recovery point or starts downloading.
      storageObjectCount: 0,
      storageBytes: 0,
      storageKnown: true,
    };
  } catch {
    return {
      mode: "incremental",
      entityReads: 0,
      reviewEventReads: 0,
      targetedReads: targetedEntityKeys.length + targetedEventIds.length,
      overheadReads,
      estimatedReads: Number.POSITIVE_INFINITY,
      storageObjectCount: 0,
      storageBytes: 0,
      storageKnown: true,
    };
  }
};

export const cloudSyncReadRequiresConfirmation = (estimate: CloudSyncReadEstimate, allowExpensiveRead = false) =>
  !allowExpensiveRead && (
    !Number.isFinite(estimate.estimatedReads)
    || estimate.estimatedReads >= EXPENSIVE_READ_THRESHOLD
    || !estimate.storageKnown
    || estimate.storageObjectCount >= EXPENSIVE_STORAGE_OBJECTS
    || estimate.storageBytes >= EXPENSIVE_STORAGE_BYTES
  );

const requiresReadConfirmation = (estimate: CloudSyncReadEstimate, options: CloudSyncOptions) =>
  cloudSyncReadRequiresConfirmation(estimate, options.allowExpensiveRead);

const readBudgetMessage = (estimate: CloudSyncReadEstimate) => {
  const firestore = Number.isFinite(estimate.estimatedReads)
    ? `Firestore 约 ${estimate.estimatedReads.toLocaleString()} 次（实体 ${estimate.entityReads.toLocaleString()}、复习事件 ${estimate.reviewEventReads.toLocaleString()}、定点 ${estimate.targetedReads.toLocaleString()}、固定开销 ${estimate.overheadReads}）`
    : "Firestore 读取量无法可靠估算";
  const storage = estimate.storageKnown
    ? `Storage ${estimate.storageObjectCount.toLocaleString()} 个对象 / ${(estimate.storageBytes / (1024 * 1024)).toFixed(1)} MiB`
    : "Storage 下载规模无法可靠估算";
  const risk = !Number.isFinite(estimate.estimatedReads)
    || estimate.estimatedReads >= READ_RISK_THRESHOLD
    || !estimate.storageKnown
    || estimate.storageObjectCount >= EXPENSIVE_STORAGE_OBJECTS
    || estimate.storageBytes >= EXPENSIVE_STORAGE_BYTES
    ? "，可能超过免费额度或产生额外费用"
    : "";
  return `本次${estimate.mode === "full" ? "全量" : "增量"}恢复预计 ${firestore}；${storage}${risk}。`;
};

export const canSkipCloudSyncLock = (
  legacySnapshotAvailable: boolean,
  remoteExists: boolean,
  remoteHeadRevision: number,
  lastPulledRevision: number,
  changed: { entities: unknown[]; events: unknown[] },
) => !legacySnapshotAvailable
  && (!remoteExists || remoteHeadRevision <= lastPulledRevision)
  && changed.entities.length === 0
  && changed.events.length === 0;

export const cloudSyncWriteEstimateFor = async (
  exported: CloudSyncExport,
  changed: { entities: CloudSyncEntity[]; events: CloudReviewEvent[] },
): Promise<CloudSyncWriteEstimate> => {
  const storageObjects = new Map<string, number>();
  for (const entity of changed.entities) {
    if (entity.deleted) continue;
    if (entity.entityType === "asset" && typeof entity.payload.contentHash === "string") {
      const blob = exported.assetBlobs.get(entity.payload.contentHash);
      if (blob) storageObjects.set(`asset:${entity.payload.contentHash}`, blob.size);
    }
    const document = await createCloudPayloadDocument(entity);
    if (document) storageObjects.set(`document:${document.hash}`, document.byteSize);
  }
  const entityWrites = changed.entities.length;
  const reviewEventWrites = changed.events.length;
  const overheadWrites = 8;
  return {
    estimatedWrites: entityWrites + reviewEventWrites + overheadWrites,
    entityWrites,
    reviewEventWrites,
    overheadWrites,
    storageObjectCount: storageObjects.size,
    storageBytes: [...storageObjects.values()].reduce((total, bytes) => total + bytes, 0),
  };
};

export const cloudSyncWriteRequiresConfirmation = (estimate: CloudSyncWriteEstimate, allowExpensiveWrite = false) =>
  !allowExpensiveWrite && (
    estimate.estimatedWrites >= EXPENSIVE_WRITE_THRESHOLD
    || estimate.storageObjectCount >= EXPENSIVE_WRITE_STORAGE_OBJECTS
    || estimate.storageBytes >= EXPENSIVE_WRITE_STORAGE_BYTES
  );

const writeBudgetMessage = (estimate: CloudSyncWriteEstimate) =>
  `预计写入 Firestore ${estimate.estimatedWrites.toLocaleString()} 次（实体 ${estimate.entityWrites.toLocaleString()}、复习事件 ${estimate.reviewEventWrites.toLocaleString()}、协议开销约 ${estimate.overheadWrites}），并可能上传 Storage ${estimate.storageObjectCount.toLocaleString()} 个对象 / ${(estimate.storageBytes / (1024 * 1024)).toFixed(1)} MiB。为避免意外消耗免费额度，已暂停同步。`;

const writeBudgetResultFor = async (
  exported: CloudSyncExport,
  changed: { entities: CloudSyncEntity[]; events: CloudReviewEvent[] },
  options: CloudSyncOptions,
  choice: CloudSyncBudgetChoice,
) => {
  const estimate = await cloudSyncWriteEstimateFor(exported, changed);
  return cloudSyncWriteRequiresConfirmation(estimate, options.allowExpensiveWrite)
    ? { kind: "write-budget" as const, estimate, message: writeBudgetMessage(estimate), choice }
    : undefined;
};

const buildIncrementalRemoteDataset = async (
  uid: string,
  local: CloudSyncStateRecord,
  remote: RemoteSyncState,
  localExport: CloudSyncExport,
  ledger: CloudSyncLedgerRecord[],
): Promise<RemoteDataset> => {
  const changes = await getRemoteChanges(uid, local.lastPulledRevision, remote);
  const localEntities = new Map(localExport.entities.map((entity) => [entity.key, entity]));
  const localEvents = new Map(localExport.reviewEvents.map((event) => [event.id, event]));
  const ledgerByKey = new Map(ledger.map((entry) => [entry.id, entry]));
  const targetEntityKeys = ledger
    .filter((entry) => entry.entityType !== "review-event")
    .filter((entry) => !localEntities.has(entry.id) || localEntities.get(entry.id)?.deleted)
    .map((entry) => entry.id);
  const targetEventIds = ledger
    .filter((entry) => entry.entityType === "review-event" && !localEvents.has(entry.entityId))
    .map((entry) => entry.entityId);
  const targeted = await getTargetedRemoteDocuments(uid, targetEntityKeys, targetEventIds);
  const observedRevisions = [
    ...changes.entities.map((entity) => entity.revision),
    ...changes.reviewEvents.map((event) => event.revision),
    ...targeted.entities.map((entity) => entity.revision),
    ...targeted.reviewEvents.map((event) => event.revision),
  ];
  if (observedRevisions.some((revision) => revision > remote.headRevision)) {
    await getRemoteState(uid);
    throw new Error("云端状态在恢复期间发生变化，请重新检查后重试。");
  }
  const entities = new Map<string, RemoteEntity>();
  ledger
    .filter((entry) => entry.entityType !== "review-event")
    .forEach((entry) => {
      const localEntity = localEntities.get(entry.id);
      if (localEntity && !localEntity.deleted) entities.set(entry.id, { ...localEntity, revision: entry.cloudRevision });
    });
  targeted.entities.forEach((entity) => entities.set(entity.key, entity));
  targetEntityKeys
    .filter((key) => !entities.has(key) && !targeted.entities.some((entity) => entity.key === key))
    .forEach((key) => {
      const entry = ledgerByKey.get(key);
      if (entry) entities.set(key, { ...tombstoneFor(entry), revision: entry.cloudRevision });
    });
  changes.entities.forEach((entity) => entities.set(entity.key, entity));

  const events = new Map<string, RemoteReviewEvent>();
  ledger
    .filter((entry) => entry.entityType === "review-event")
    .forEach((entry) => {
      const localEvent = localEvents.get(entry.entityId);
      if (localEvent) events.set(entry.entityId, { ...localEvent, revision: entry.cloudRevision });
    });
  targeted.reviewEvents.forEach((event) => events.set(event.id, event));
  changes.reviewEvents.forEach((event) => events.set(event.id, event));
  return {
    entities: [...entities.values()],
    reviewEvents: [...events.values()],
    changed: changes,
    completeThroughRevision: remote.headRevision,
    mode: "incremental",
  };
};

const buildFullRemoteDataset = async (uid: string, local: CloudSyncStateRecord, remote: RemoteSyncState): Promise<RemoteDataset> => {
  const all = await getAllRemote(uid, remote);
  return {
    ...all,
    changed: {
      entities: all.entities.filter((entity) => entity.revision > local.lastPulledRevision),
      reviewEvents: all.reviewEvents.filter((event) => event.revision > local.lastReviewEventRevision),
    },
    completeThroughRevision: remote.headRevision,
    mode: "full",
  };
};

const getAllRemoteDocuments = async (uid: string) => {
  const [entities, reviewEvents] = await withTimeout(
    Promise.all([getDocs(entitiesRef(uid)), getDocs(reviewEventsRef(uid))]),
    FIRESTORE_READ_TIMEOUT_MS,
    "读取云端全部数据超时，请确认网络可连接后重试。",
  );
  return {
    entities: await parseAndNormalizeRemoteEntities(entities.docs),
    reviewEvents: reviewEvents.docs
      .map((item) => parseRemoteReviewEvent(item.id, item.data()))
      .filter((item): item is RemoteReviewEvent => Boolean(item)),
  };
};

const getAllRemote = async (uid: string, state: RemoteSyncState) => {
  const all = await getAllRemoteDocuments(uid);
  return {
    entities: all.entities.filter((entity) => entity.revision <= state.headRevision),
    reviewEvents: all.reviewEvents.filter((event) => event.revision <= state.headRevision),
  };
};

const assetStorageInfo = (entity: CloudSyncEntity, assetBlobs?: Map<string, Blob>) => {
  if (entity.entityType !== "asset" || entity.deleted) return undefined;
  const hash = typeof entity.payload.contentHash === "string" ? entity.payload.contentHash : undefined;
  if (!hash) return null;
  const declaredSize = typeof entity.payload.size === "number" && Number.isFinite(entity.payload.size) && entity.payload.size >= 0
    ? entity.payload.size
    : undefined;
  const size = declaredSize ?? assetBlobs?.get(hash)?.size;
  return size === undefined ? null : { hash, size };
};

const payloadDocumentInfo = async (entity: CloudSyncEntity) => {
  if (entity.deleted) return undefined;
  if (entity.payloadDocumentHash) {
    return typeof entity.payloadByteSize === "number" && Number.isFinite(entity.payloadByteSize) && entity.payloadByteSize >= 0
      ? { hash: entity.payloadDocumentHash, size: entity.payloadByteSize }
      : null;
  }
  const document = await createCloudPayloadDocument(entity);
  return document ? { hash: document.hash, size: document.byteSize } : undefined;
};

/** Compute a revision-scoped, content-addressed view of the active Storage footprint. */
export const cloudStorageSummaryFor = async (
  entities: CloudSyncEntity[],
  revision: number,
  assetBlobs?: Map<string, Blob>,
): Promise<RemoteStorageSummary | undefined> => {
  const assets = new Map<string, number>();
  const documents = new Map<string, number>();
  for (const entity of entities) {
    const asset = assetStorageInfo(entity, assetBlobs);
    if (asset === null) return undefined;
    if (asset) assets.set(asset.hash, asset.size);
    const document = await payloadDocumentInfo(entity);
    if (document === null) return undefined;
    if (document) documents.set(document.hash, document.size);
  }
  return {
    revision,
    assetObjectCount: assets.size,
    assetBytes: [...assets.values()].reduce((total, size) => total + size, 0),
    payloadObjectCount: documents.size,
    payloadBytes: [...documents.values()].reduce((total, size) => total + size, 0),
  };
};

export interface CloudSyncStoragePlan {
  storageObjectCount: number;
  storageBytes: number;
  storageKnown: boolean;
}

/** Exact download plan once the changed remote entities are known, before any Storage request. */
export const cloudStorageDownloadPlanFor = async (
  entities: CloudSyncEntity[],
  local: CloudSyncExport,
): Promise<CloudSyncStoragePlan> => {
  const localByKey = new Map(local.entities.map((entity) => [entity.key, entity]));
  const assetHashes = new Map<string, number>();
  const documentHashes = new Map<string, number>();
  for (const entity of entities) {
    const asset = assetStorageInfo(entity, local.assetBlobs);
    if (asset === null) return { storageObjectCount: 0, storageBytes: 0, storageKnown: false };
    if (asset && !local.assetBlobs.has(asset.hash)) assetHashes.set(asset.hash, asset.size);
    const localEntity = localByKey.get(entity.key);
    // A local entity with the same content hash already contains the full payload, even when the
    // remote representation stores that payload in Storage. Reusing it avoids a duplicate fetch.
    if (localEntity && localEntity.contentHash === entity.contentHash && !localEntity.deleted && Object.keys(localEntity.payload).length > 0) continue;
    const document = await payloadDocumentInfo(entity);
    if (document === null) return { storageObjectCount: 0, storageBytes: 0, storageKnown: false };
    if (document) documentHashes.set(document.hash, document.size);
  }
  return {
    storageObjectCount: assetHashes.size + documentHashes.size,
    storageBytes: [...assetHashes.values(), ...documentHashes.values()].reduce((total, size) => total + size, 0),
    storageKnown: true,
  };
};

const withStoragePlan = (estimate: CloudSyncReadEstimate, plan: CloudSyncStoragePlan): CloudSyncReadEstimate => ({
  ...estimate,
  ...plan,
});

const hydratePayloadDocuments = async <T extends CloudSyncEntity>(
  uid: string,
  entities: T[],
  options: CloudSyncOptions,
  localEntities?: Map<string, CloudSyncEntity>,
): Promise<T[]> => {
  const documents = entities.filter((entity) => !entity.deleted && entity.payloadDocumentHash);
  if (documents.length === 0) return entities;
  return Promise.all(entities.map(async (entity) => {
    const documentHash = entity.payloadDocumentHash;
    if (entity.deleted || !documentHash) return entity;
    const local = localEntities?.get(entity.key);
    if (local && !local.deleted && local.contentHash === entity.contentHash && Object.keys(local.payload).length > 0) {
      return { ...entity, payload: local.payload, payloadDocumentHash: undefined, payloadByteSize: undefined };
    }
    const index = documents.findIndex((item) => item.key === entity.key) + 1;
    progress(options, "downloading", `正在下载大文本 ${index}/${documents.length}。`, index, documents.length);
    const blob = await withTimeout(
      getCloudStorageBlob(uid, documentRef(uid, documentHash)),
      ASSET_DOWNLOAD_TIMEOUT_MS,
      `下载云端大文本超时（${index}/${documents.length}），请确认网络可连接 Firebase Storage 后重试。`,
    );
    const content = await blob.text();
    let payload: unknown;
    try {
      payload = JSON.parse(content);
    } catch {
      throw new Error(`云端大文本 ${entity.key} 无法解析。`);
    }
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
      throw new Error(`云端大文本 ${entity.key} 的格式无效。`);
    }
    // Large payload documents use the same entity-specific canonicalization as
    // ordinary entities: bookkeeping fields are stripped before hashing. Keep
    // upload and download validation symmetric, including for large assets.
    const actualHash = await hashValue(syncHashPayload(entity.entityType, payload));
    const legacyHash = entity.entityType === "block"
      ? await hashValue(legacyBlockHashPayload(payload))
      : entity.entityType === "asset"
        ? await hashValue(legacyEntityHashPayload(payload))
        : undefined;
    const legacyAlgorithmHash = legacyFnvHashValue(syncHashPayload(entity.entityType, payload));
    const legacyEntityAlgorithmHash = entity.entityType === "asset"
      ? legacyFnvHashValue(legacyEntityHashPayload(payload))
      : undefined;
    const legacyBlockAlgorithmHash = entity.entityType === "block"
      ? legacyFnvHashValue(legacyBlockHashPayload(payload))
      : undefined;
    const documentMatches = actualHash === documentHash || legacyHash === documentHash || legacyAlgorithmHash === documentHash || legacyEntityAlgorithmHash === documentHash || legacyBlockAlgorithmHash === documentHash;
    const entityMatches = actualHash === entity.contentHash || legacyHash === entity.contentHash || legacyAlgorithmHash === entity.contentHash || legacyEntityAlgorithmHash === entity.contentHash || legacyBlockAlgorithmHash === entity.contentHash || documentHash === entity.contentHash;
    if (!documentMatches || !entityMatches) {
      throw new Error(`云端大文本 ${entity.key} 的完整性校验失败。`);
    }
    const migrated = entity.contentHash !== actualHash || entity.contentHashAlgorithm !== "sha256" ||
      (entity.entityType === "asset" && entity.contentHashVersion !== ASSET_CONTENT_HASH_VERSION) ||
      (entity.entityType === "block" && entity.contentHashVersion !== BLOCK_CONTENT_HASH_VERSION);
    return {
      ...entity,
      contentHash: actualHash,
      contentHashAlgorithm: "sha256",
      ...(entity.entityType === "asset" ? { contentHashVersion: ASSET_CONTENT_HASH_VERSION } : {}),
      ...(entity.entityType === "block" ? { contentHashVersion: BLOCK_CONTENT_HASH_VERSION } : {}),
      payload: payload as Record<string, unknown>,
      ...(migrated ? { payloadDocumentHash: undefined, payloadByteSize: undefined } : {}),
    };
  }));
};

const ASSET_DOWNLOAD_TIMEOUT_MS = isNativePlatform() ? 300_000 : 120_000;
const ASSET_DOWNLOAD_CONCURRENCY = 5;

const downloadRemoteAssets = async (uid: string, entities: CloudSyncEntity[], existing: Map<string, Blob>, options: CloudSyncOptions) => {
  const pending = [
    ...new Set(
      entities
        .filter((e) => e.entityType === "asset" && !e.deleted)
        .map((e) => e.payload.contentHash)
        .filter((h): h is string => typeof h === "string" && !existing.has(h)),
    ),
  ];
  const total = pending.length;
  let completed = 0;
  for (let i = 0; i < total; i += ASSET_DOWNLOAD_CONCURRENCY) {
    await Promise.all(
      pending.slice(i, i + ASSET_DOWNLOAD_CONCURRENCY).map(async (hash) => {
        if (existing.has(hash)) return;
        try {
          let timeoutId: ReturnType<typeof setTimeout> | undefined;
          const timeout = new Promise<never>((_, reject) => {
            timeoutId = setTimeout(() => reject(new Error("下载超时，请检查网络连接、代理设置后重试。")), ASSET_DOWNLOAD_TIMEOUT_MS);
          });
          try {
            existing.set(hash, await Promise.race([getCloudStorageBlob(uid, assetRef(uid, hash)), timeout]));
          } finally {
            if (timeoutId) clearTimeout(timeoutId);
          }
          completed++;
          progress(options, "downloading", `正在下载资源 ${completed}/${total}。`, completed, total);
        } catch (err) {
          const detail = err instanceof Error ? err.message : String(err);
          throw new Error(`资源下载失败（${completed + 1}/${total}），请确认网络可连接 Firebase Storage 后重试。（${detail}）`);
        }
      }),
    );
  }
};

const mergeReviewEvents = (current: CloudReviewEvent[], updates: CloudReviewEvent[]) => {
  const byId = new Map(current.map((event) => [event.id, event]));
  updates.forEach((event) => byId.set(event.id, event));
  return [...byId.values()];
};

const mergeRemoteFieldChanges = async (
  current: CloudSyncExport,
  localChanged: { entities: CloudSyncEntity[]; events: CloudReviewEvent[] },
  updates: { entities: RemoteEntity[]; reviewEvents: RemoteReviewEvent[] },
  ledger: CloudSyncLedgerRecord[],
) => {
  const localByKey = new Map(current.entities.map((entity) => [entity.key, entity]));
  localChanged.entities.forEach((entity) => localByKey.set(entity.key, entity));
  const ledgerByKey = new Map(ledger.map((entry) => [entry.id, entry]));
  const conflicts: Array<{
    key: string;
    entityType?: CloudSyncEntityType;
    fields?: string[];
    reason?: "content" | "field";
  }> = [];
  const entities: RemoteEntity[] = [];
  for (const remote of updates.entities) {
    const local = localByKey.get(remote.key);
    if (!local || (local.entityType !== "settings" && local.entityType !== "template")) {
      entities.push(remote);
      continue;
    }
    if (local.contentHash === remote.contentHash && Boolean(local.deleted) === Boolean(remote.deleted)) {
      entities.push(remote);
      continue;
    }
    const merged = mergeCloudSyncSmallEntity(local, remote, ledgerByKey.get(remote.key)?.basePayload);
    if (merged.conflicts.length > 0) {
      conflicts.push({ key: remote.key, entityType: remote.entityType, fields: merged.conflicts, reason: "field" });
      entities.push(remote);
      continue;
    }
    entities.push({
      ...remote,
      payload: merged.payload,
      deleted: merged.deleted,
      contentHash: await hashValue(syncHashPayload(remote.entityType, merged.payload)),
    });
  }
  return { entities, reviewEvents: updates.reviewEvents, conflicts };
};

const applyRemote = async (
  uid: string,
  current: CloudSyncExport,
  updates: { entities: RemoteEntity[]; reviewEvents: RemoteReviewEvent[] },
  options: CloudSyncOptions,
  expectedEpoch?: number,
) => {
  const mergedEntities = await hydratePayloadDocuments(
    uid,
    mergeCloudSyncEntities(current.entities, updates.entities),
    options,
    new Map(current.entities.map((entity) => [entity.key, entity])),
  );
  const mergedEvents = mergeReviewEvents(current.reviewEvents, updates.reviewEvents);
  const assetBlobs = new Map(current.assetBlobs);
  await downloadRemoteAssets(uid, mergedEntities, assetBlobs, options);
  progress(options, "applying", "正在一次性应用云端更改。");
  const snapshot = materializeCloudSyncSnapshot(mergedEntities, mergedEvents, assetBlobs);
  if (expectedEpoch === undefined) {
    await storage.restoreCloudSyncSnapshot(snapshot);
  } else {
    await storage.restoreCloudSyncSnapshotIfUnchanged(snapshot, expectedEpoch);
  }
};

export const lockMatches = (lock: RemoteSyncLock | null | undefined, deviceId: string, operationId: string, revision: number) =>
  Boolean(
    lock && lock.deviceId === deviceId && lock.operationId === operationId && lock.revision === revision &&
    (lock.fencingRevision === undefined || lock.fencingRevision === revision),
  );

export const isStaleRemoteLock = (lock: RemoteSyncLock | null | undefined, now = Date.now()) => {
  if (!lock?.operationId || lock.revision === undefined || lock.lastRenewedAt === undefined) return false;
  return lock.expiresAt > now && now - lock.lastRenewedAt >= LOCK_STALE_AFTER_MS;
};

const acquireLock = async (uid: string, deviceId: string, operationId: string) => withTimeout(
  runTransaction(firestore, async (transaction) => {
    const reference = stateRef(uid);
    const current = parseRemoteState((await transaction.get(reference)).data());
    const now = Date.now();
    if (current.protocolVersion !== PROTOCOL_VERSION) {
      throw new Error("云端同步协议版本不兼容，请先使用新版应用完成迁移。");
    }
    const activeLock = current.lock && current.lock.expiresAt > now ? current.lock : undefined;
    if (activeLock && !lockMatches(activeLock, deviceId, operationId, activeLock.revision ?? -1) && !isStaleRemoteLock(activeLock, now)) {
      throw new Error("另一台设备正在同步，请稍后再试。");
    }
    const revision = Math.max(current.nextRevision, current.headRevision) + 1;
    const nextLock: RemoteSyncLock = {
      deviceId,
      operationId,
      revision,
      fencingRevision: revision,
      acquiredAt: now,
      lastRenewedAt: now,
      expiresAt: now + LOCK_DURATION_MS,
    };
    transaction.set(reference, remoteSyncStateDocument({
      ...current,
      protocolVersion: PROTOCOL_VERSION,
      nextRevision: revision,
      lock: nextLock,
      ...(activeLock && isStaleRemoteLock(activeLock, now) ? {
        lastLockRecovery: {
          byDeviceId: deviceId,
          recoveredAt: now,
          reason: "lease-heartbeat-stale",
          ...(typeof activeLock.operationId === "string" ? { operationId: activeLock.operationId } : {}),
          ...(typeof activeLock.revision === "number" ? { revision: activeLock.revision } : {}),
        },
      } : {}),
    }));
    return {
      operationId,
      revision,
      previousHead: current.headRevision,
      deviceId,
      ...(activeLock && isStaleRemoteLock(activeLock, now) ? { recoveredStaleLock: true } : {}),
    };
  }),
  FIRESTORE_LOCK_TIMEOUT_MS,
  "获取云同步锁超时，请确认网络可连接后重试。",
);

const releaseLock = async (
  uid: string,
  deviceId: string,
  operationId: string,
  revision: number,
  publish: boolean,
  storageSummary?: RemoteStorageSummary,
) => withTimeout(
  runTransaction(firestore, async (transaction) => {
    const reference = stateRef(uid);
    const current = parseRemoteState((await transaction.get(reference)).data());
    if (!lockMatches(current.lock, deviceId, operationId, revision)) {
      throw new CloudSyncLockLostError();
    }
    const headRevision = publish ? Math.max(current.headRevision, revision) : current.headRevision;
    transaction.set(reference, remoteSyncStateDocument({
      ...current,
      protocolVersion: PROTOCOL_VERSION,
      headRevision,
      nextRevision: Math.max(current.nextRevision, revision),
      lock: null,
      // A summary is only useful when it describes the revision that remains visible after this
      // transaction. Never let an older operation publish a misleading summary for a newer head.
      ...(storageSummary && storageSummary.revision === headRevision ? { storageSummary } : {}),
    }));
  }),
  FIRESTORE_LOCK_TIMEOUT_MS,
  "释放云同步锁超时，请确认网络可连接后重试。",
);

const releaseLockSafely = async (
  uid: string,
  lock: Pick<AcquiredLock, "deviceId" | "operationId" | "revision">,
  publish: boolean,
  originalError?: unknown,
  storageSummary?: RemoteStorageSummary,
) => {
  try {
    await releaseLock(uid, lock.deviceId, lock.operationId, lock.revision, publish, storageSummary);
    return true;
  } catch (releaseError) {
    const message = releaseError instanceof Error ? releaseError.message : String(releaseError);
    await updateOperation(lock.operationId, {
      lockReleaseError: message,
      lockReleaseErrorAt: new Date().toISOString(),
      lockReleaseAttempts: ((await operationFor(lock.operationId))?.lockReleaseAttempts ?? 0) + 1,
      ...(originalError instanceof Error ? { errorMessage: originalError.message } : {}),
    }).catch((diagnosticError) => {
      console.warn("云同步锁释放失败，且诊断记录写入失败。", { lock, releaseError, diagnosticError });
    });
    console.warn("云同步锁释放失败。", { lock, releaseError, originalError });
    return false;
  }
};

const renewLock = async (uid: string, deviceId: string, operationId: string, revision: number) => withTimeout(
  runTransaction(firestore, async (transaction) => {
    const reference = stateRef(uid);
    const current = parseRemoteState((await transaction.get(reference)).data());
    if (!lockMatches(current.lock, deviceId, operationId, revision) || current.lock!.expiresAt <= Date.now()) {
      throw new CloudSyncLockLostError();
    }
    transaction.set(reference, remoteSyncStateDocument({
      ...current,
      lock: {
        ...current.lock,
        deviceId,
        operationId,
        revision,
        fencingRevision: revision,
        lastRenewedAt: Date.now(),
        expiresAt: Date.now() + LOCK_DURATION_MS,
      },
    }));
  }),
  FIRESTORE_LOCK_TIMEOUT_MS,
  "续租云同步锁超时，请确认网络可连接后重试。",
);

const startLockRenewal = (uid: string, deviceId: string, lock: AcquiredLock) => {
  let leaseError: unknown;
  const timer = setInterval(() => {
    void renewLock(uid, deviceId, lock.operationId, lock.revision).catch((error: unknown) => {
      leaseError ??= error;
    });
  }, LOCK_RENEW_INTERVAL_MS);
  return {
    assert: async () => {
      if (leaseError) throw leaseError;
      await renewLock(uid, deviceId, lock.operationId, lock.revision);
    },
    stop: () => clearInterval(timer),
  };
};

const writeInBatches = async (writes: Array<(batch: WriteBatch) => void>, beforeBatch?: () => Promise<void>) => {
  for (let index = 0; index < writes.length; index += MAX_BATCH_WRITES) {
    await beforeBatch?.();
    const batch = writeBatch(firestore);
    writes.slice(index, index + MAX_BATCH_WRITES).forEach((write) => write(batch));
    await withTimeout(batch.commit(), FIRESTORE_BATCH_TIMEOUT_MS, "提交同步数据超时，请确认网络可连接后重试。");
  }
};

/**
 * Metadata writes are fenced by the current lock in the same Firestore transaction. Updating the
 * sync state during stale-lock takeover conflicts with this transaction, so an old request that
 * arrives after takeover cannot write a newer operation's entity documents.
 */
const writeMetadataInBatchesWithLease = async (
  uid: string,
  lock: AcquiredLock,
  writes: Array<(batch: Transaction) => void>,
  beforeBatch?: () => Promise<void>,
) => {
  for (let index = 0; index < writes.length; index += MAX_BATCH_WRITES) {
    await beforeBatch?.();
    await withTimeout(runTransaction(firestore, async (transaction) => {
      const current = parseRemoteState((await transaction.get(stateRef(uid))).data());
      if (!lockMatches(current.lock, lock.deviceId, lock.operationId, lock.revision)) {
        throw new CloudSyncLockLostError();
      }
      writes.slice(index, index + MAX_BATCH_WRITES).forEach((write) => write(transaction));
    }), FIRESTORE_BATCH_TIMEOUT_MS, "提交同步数据超时，请确认网络可连接后重试。");
  }
};

const ASSET_UPLOAD_CONCURRENCY = 5;
const STORAGE_METADATA_CONCURRENCY = 6;
// Native uploads use Android's network stack and may legitimately take longer than the web SDK
// timeout while the operating system sends a large cached file.
const ASSET_UPLOAD_TIMEOUT_MS = isNativePlatform() ? 300_000 : 120_000;
const METADATA_CHECK_TIMEOUT_MS = 30_000;
const STORAGE_LIST_TIMEOUT_MS = isNativePlatform() ? 5 * 60_000 : METADATA_CHECK_TIMEOUT_MS;

export const isUnsupportedStorageListError = (error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  return /HTTP\s*(403|404|405)|列表.*不支持|list.*(unsupported|not supported)/i.test(message);
};

const listNativeStoragePathsOrFallback = async (prefix: string, token: string, timeoutMessage: string) => {
  try {
    return await withTimeout(listNativeFirebaseStoragePaths(prefix, token), STORAGE_LIST_TIMEOUT_MS, timeoutMessage);
  } catch (error) {
    if (isUnsupportedStorageListError(error)) return undefined;
    throw error;
  }
};

const uploadAssets = async (
  uid: string,
  entities: CloudSyncEntity[],
  assetBlobs: Map<string, Blob>,
  options: CloudSyncOptions,
) => {
  const hashes = [...new Set(entities
    .filter((entity) => entity.entityType === "asset" && !entity.deleted)
    .map((entity) => entity.payload.contentHash)
    .filter((hash): hash is string => typeof hash === "string"))];
  const user = firebaseAuth.currentUser;
  const nativeAssetPaths = hashes.length > 0 && isAndroidPlatform() && user?.uid === uid
    ? await listNativeStoragePathsOrFallback(
      `users/${uid}/assets/`,
      await getIdTokenFor(user),
      "检查云端资源超时，请检查网络连接后重试。",
    )
    : undefined;
  const missing = nativeAssetPaths
    ? hashes.filter((hash) => !nativeAssetPaths.has(`users/${uid}/assets/${hash}`))
    : (
      await mapWithConcurrency(hashes, STORAGE_METADATA_CONCURRENCY, async (hash) => {
        const exists = await withTimeout(
          cloudStorageObjectExists(uid, assetRef(uid, hash)),
          METADATA_CHECK_TIMEOUT_MS,
          "检查云端资源超时，请检查网络连接后重试。",
        );
        return exists ? null : hash;
      })
    ).filter((h): h is string => h !== null);
  let transferred = 0;
  const total = missing.length;
  let completed = 0;
  for (let i = 0; i < total; i += ASSET_UPLOAD_CONCURRENCY) {
    await Promise.all(
      missing.slice(i, i + ASSET_UPLOAD_CONCURRENCY).map(async (hash) => {
        const blob = assetBlobs.get(hash);
        if (!blob) throw new Error("本地资源缓存不完整，无法同步。");
        let taskTransferred = 0;
        const uploadPromise = uploadCloudStorageBlob(uid, assetRef(uid, hash), blob, (bytesTransferred) => {
          // Both native and web upload implementations report a cumulative value. Add only the
          // delta; otherwise a 90 MB upload would look like hundreds of megabytes in the UI.
          const delta = Math.max(0, bytesTransferred - taskTransferred);
          taskTransferred = Math.max(taskTransferred, bytesTransferred);
          transferred += delta;
          progress(options, "uploading", `正在上传资源 ${completed + 1}/${total}（${(transferred / (1024 * 1024)).toFixed(1)} MB）。`);
        });
        await withTimeout(uploadPromise, ASSET_UPLOAD_TIMEOUT_MS, `资源上传超时（${completed + 1}/${total}），请确认网络可连接 Firebase Storage 后重试。`);
        completed++;
        progress(options, "uploading", `正在上传资源 ${completed}/${total}（${(transferred / (1024 * 1024)).toFixed(1)} MB）。`);
      }),
    );
  }
};

const uploadLargePayloadDocuments = async <T extends CloudSyncEntity>(
  uid: string,
  entities: T[],
  options: CloudSyncOptions,
): Promise<T[]> => {
  const prepared = await Promise.all(entities.map(async (entity) => {
    const document = await createCloudPayloadDocument(entity);
    return document ? { entity: { ...entity, ...withCloudPayloadDocument(entity, document) } as T, document } : { entity };
  }));
  const documents = prepared.filter((item): item is { entity: T; document: NonNullable<Awaited<ReturnType<typeof createCloudPayloadDocument>>> } => Boolean(item.document));
  const user = firebaseAuth.currentUser;
  const nativeDocumentPaths = documents.length > 0 && isAndroidPlatform() && user?.uid === uid
    ? await listNativeStoragePathsOrFallback(
      `users/${uid}/documents/`,
      await getIdTokenFor(user),
      "检查云端大文本超时，请确认网络可连接后重试。",
    )
    : undefined;
  const missingDocs = nativeDocumentPaths
    ? documents.filter((item) => !nativeDocumentPaths.has(`users/${uid}/documents/${item.document.hash}`))
    : (
      await mapWithConcurrency(documents, STORAGE_METADATA_CONCURRENCY, async (item) => {
        const exists = await withTimeout(
          cloudStorageObjectExists(uid, documentRef(uid, item.document.hash)),
          METADATA_CHECK_TIMEOUT_MS,
          "检查云端大文本超时，请确认网络可连接后重试。",
        );
        return exists ? null : item;
      })
    ).filter((item): item is (typeof documents)[number] => item !== null);
  await mapWithConcurrency(missingDocs, ASSET_UPLOAD_CONCURRENCY, (item, index) => {
    progress(options, "uploading", `正在上传大文本 ${index + 1}/${missingDocs.length}。`, index + 1, missingDocs.length);
    return withTimeout(
      uploadCloudStorageBlob(uid, documentRef(uid, item.document.hash), item.document.blob),
      ASSET_UPLOAD_TIMEOUT_MS,
      `上传云端大文本超时（${index + 1}/${missingDocs.length}），请确认网络可连接 Firebase Storage 后重试。`,
    );
  });
  return prepared.map((item) => item.entity);
};

const persistLedgers = async (
  state: CloudSyncStateRecord,
  entities: RemoteEntity[],
  events: RemoteReviewEvent[],
  revision: number,
  completeThroughRevision?: number,
) => {
  const rows: CloudSyncLedgerRecord[] = [
    ...entities.map((entity) => ({
      id: entity.key,
      entityType: entity.entityType,
      entityId: entity.entityId,
      contentHash: entity.contentHash,
      contentHashVersion: entity.contentHashVersion,
      contentHashAlgorithm: entity.contentHashAlgorithm,
      cloudRevision: entity.revision,
      assetHash: entity.entityType === "asset" && typeof entity.payload.contentHash === "string" ? entity.payload.contentHash : undefined,
      basePayload: entity.entityType === "settings" || entity.entityType === "template"
        ? entity.deleted ? undefined : entity.payload
        : undefined,
    })),
    ...events.map((event) => ({
      id: ledgerId("review-event", event.id),
      entityType: "review-event" as const,
      entityId: event.id,
      contentHash: event.contentHash,
      cloudRevision: event.revision,
    })),
  ];
  await db.transaction("rw", db.cloudSyncState, db.cloudSyncLedger, async () => {
    if (rows.length) await db.cloudSyncLedger.bulkPut(rows);
    await db.cloudSyncState.put({
      ...state,
      lastPulledRevision: Math.max(state.lastPulledRevision, revision),
      lastReviewEventRevision: Math.max(state.lastReviewEventRevision, revision),
      remoteDatasetCompleteThroughRevision: completeThroughRevision ?? state.remoteDatasetCompleteThroughRevision,
      lastSyncedAt: new Date().toISOString(),
    });
  });
};

const resetLedgers = async (state: CloudSyncStateRecord) => {
  await db.transaction("rw", db.cloudSyncState, db.cloudSyncLedger, async () => {
    await db.cloudSyncLedger.clear();
    await db.cloudSyncState.put({
      ...state,
      lastPulledRevision: 0,
      lastReviewEventRevision: 0,
      remoteDatasetCompleteThroughRevision: undefined,
      lastSyncedAt: undefined,
    });
  });
};

const resetAndPersistLedgers = async (state: CloudSyncStateRecord, entities: RemoteEntity[], events: RemoteReviewEvent[], revision: number) => {
  const rows: CloudSyncLedgerRecord[] = [
    ...entities.map((entity) => ({
      id: entity.key,
      entityType: entity.entityType,
      entityId: entity.entityId,
      contentHash: entity.contentHash,
      contentHashVersion: entity.contentHashVersion,
      cloudRevision: entity.revision,
      assetHash: entity.entityType === "asset" && typeof entity.payload.contentHash === "string" ? entity.payload.contentHash : undefined,
      basePayload: entity.entityType === "settings" || entity.entityType === "template"
        ? entity.deleted ? undefined : entity.payload
        : undefined,
    })),
    ...events.map((event) => ({
      id: ledgerId("review-event", event.id),
      entityType: "review-event" as const,
      entityId: event.id,
      contentHash: event.contentHash,
      cloudRevision: event.revision,
    })),
  ];
  await db.transaction("rw", db.cloudSyncState, db.cloudSyncLedger, async () => {
    await db.cloudSyncLedger.clear();
    if (rows.length) await db.cloudSyncLedger.bulkPut(rows);
    await db.cloudSyncState.put({
      ...state,
      lastPulledRevision: revision,
      lastReviewEventRevision: revision,
      remoteDatasetCompleteThroughRevision: revision,
      lastSyncedAt: new Date().toISOString(),
    });
  });
};

const toRemoteEntity = (entity: CloudSyncEntity, revision: number): RemoteEntity => ({ ...entity, revision });
const toRemoteReviewEvent = (event: CloudReviewEvent, revision: number): RemoteReviewEvent => ({ ...event, revision });
type AcquiredLock = { operationId: string; revision: number; previousHead: number; deviceId: string; recoveredStaleLock?: boolean };

const activeEntityDocument = (entity: RemoteEntity) => ({
  entityType: entity.entityType,
  entityId: entity.entityId,
  contentHash: entity.contentHash,
  ...(entity.contentHashVersion !== undefined ? { contentHashVersion: entity.contentHashVersion } : {}),
  ...(entity.contentHashAlgorithm !== undefined ? { contentHashAlgorithm: entity.contentHashAlgorithm } : {}),
  payload: entity.payload,
  ...(entity.payloadDocumentHash ? {
    payloadDocumentHash: entity.payloadDocumentHash,
    payloadByteSize: entity.payloadByteSize,
  } : {}),
  deleted: Boolean(entity.deleted),
  revision: entity.revision,
  updatedAt: new Date().toISOString(),
});

const snapshotEntityDocument = (entity: RemoteEntity) => ({
  key: entity.key,
  ...activeEntityDocument(entity),
  kind: "entity",
});

const publish = async (
  user: User,
  state: CloudSyncStateRecord,
  exported: CloudSyncExport,
  changed: { entities: CloudSyncEntity[]; events: CloudReviewEvent[] },
  options: CloudSyncOptions,
  heldLock?: AcquiredLock,
) => {
  if (changed.entities.length === 0 && changed.events.length === 0) {
    if (heldLock) {
      await releaseLock(user.uid, state.deviceId, heldLock.operationId, heldLock.revision, false);
      await updateOperation(heldLock.operationId, { status: "succeeded", phase: "releasing" });
    }
    return { revision: heldLock?.previousHead ?? state.lastPulledRevision, uploaded: 0 };
  }
  const lock = heldLock ?? await acquireLock(user.uid, state.deviceId, newId());
  const lease = startLockRenewal(user.uid, state.deviceId, lock);
  const assertLease = lease.assert;
  try {
    const expected = expectedValues(changed.entities, changed.events);
    await updateOperation(lock.operationId, {
      expectedEntities: expected.expectedEntities,
      expectedEvents: expected.expectedEvents,
    });
    await updateOperation(lock.operationId, { phase: "uploading", status: "pending" });
    await uploadAssets(user.uid, changed.entities, exported.assetBlobs, options);
    await assertLease();
    progress(options, "uploading", "正在提交同步元数据。", 0, changed.entities.length + changed.events.length);
    const storedEntities = await uploadLargePayloadDocuments(user.uid, changed.entities, options);
    const remoteEntities = storedEntities.map((entity) => toRemoteEntity(entity, lock.revision));
    const remoteEvents = changed.events.map((event) => toRemoteReviewEvent(event, lock.revision));
    await updateOperation(lock.operationId, { phase: "committing" });
    await writeMetadataInBatchesWithLease(user.uid, lock, [
      ...remoteEntities.map((entity) => (batch: Transaction) => batch.set(entityRef(user.uid, entity.key), activeEntityDocument(entity))),
      ...remoteEvents.map((event) => (batch: Transaction) => batch.set(reviewEventRef(user.uid, event.id), {
        contentHash: event.contentHash,
        payload: event.payload,
        revision: event.revision,
        updatedAt: new Date().toISOString(),
      })),
    ], assertLease);
    // Advance headRevision before recording the local ledger, not after. The Firestore batch write
    // above is the true point of no return — once it succeeds, this revision's data is durably
    // stored regardless of what happens next. If the app is killed between these two calls:
    //  - headRevision-first (this order): the server already reflects the new revision, so every
    //    device (including this one) can see it on the very next pull. This device's local ledger
    //    is stale, so its next sync harmlessly re-diffs and re-uploads the same content under a new
    //    revision — wasteful but self-correcting on this device's own next attempt.
    //  - ledger-first (the old order): the local ledger says "already synced," so this device's own
    //    retries find nothing to publish and release the lock without advancing headRevision. The
    //    just-written entities sit above headRevision — invisible to every device, including this
    //    one — until some unrelated future edit anywhere finally pushes headRevision past them.
    await updateOperation(lock.operationId, { phase: "releasing" });
    const storageSummary = await cloudStorageSummaryFor(exported.entities, lock.revision, exported.assetBlobs).catch(() => undefined);
    await releaseLock(user.uid, state.deviceId, lock.operationId, lock.revision, true, storageSummary);
    const completeThroughRevision = state.remoteDatasetCompleteThroughRevision !== undefined
      && state.remoteDatasetCompleteThroughRevision === state.lastPulledRevision
      ? lock.revision
      : undefined;
    await persistLedgers(state, remoteEntities, remoteEvents, lock.revision, completeThroughRevision);
    await updateOperation(lock.operationId, { status: "succeeded", phase: "releasing" });
    return { revision: lock.revision, uploaded: remoteEntities.length + remoteEvents.length };
  } catch (error) {
    const timedOut = error instanceof Error && error.message.includes("超时");
    if (timedOut) {
      await updateOperation(lock.operationId, { status: "unknown", errorMessage: error.message });
      throw new CloudSyncResultUnknownError(lock.operationId, lock.revision, `${error.message} 操作结果未知，正在核对云端状态。`);
    }
    await releaseLockSafely(user.uid, lock, false, error);
    await updateOperation(lock.operationId, { status: "failed", phase: "releasing", errorMessage: error instanceof Error ? error.message : String(error) });
    throw error;
  } finally {
    lease.stop();
  }
};

const makeRemoteSnapshot = async (
  uid: string,
  label: string,
  entities: RemoteEntity[],
  events: RemoteReviewEvent[],
  revision: number,
  options: CloudSyncOptions,
  beforeBatch?: () => Promise<void>,
) => {
  const id = `${Date.now()}-${newId()}`;
  progress(options, "snapshot", "正在创建恢复快照。");
  const snapshotEntities = await uploadLargePayloadDocuments(uid, entities, options);
  await beforeBatch?.();
  await withTimeout(setDoc(snapshotRef(uid, id), {
    createdAt: new Date().toISOString(),
    label,
    entityCount: snapshotEntities.length + events.length,
    revision,
  }), FIRESTORE_BATCH_TIMEOUT_MS, "写入云端恢复快照超时，请确认网络可连接后重试。");
  progress(options, "snapshot", `正在写入快照数据（共 ${snapshotEntities.length + events.length} 项）。`);
  await writeInBatches([
    ...snapshotEntities.map((entity) => (batch: WriteBatch) => batch.set(doc(snapshotEntitiesRef(uid, id), entity.key), snapshotEntityDocument(entity))),
    ...events.map((event) => (batch: WriteBatch) => batch.set(doc(snapshotEntitiesRef(uid, id), `review-event:${event.id}`), { ...event, kind: "review-event" })),
  ], beforeBatch);
  return id;
};

const referencedAssetHash = (entity: CloudSyncEntity) =>
  entity.entityType === "asset" && !entity.deleted && typeof entity.payload.contentHash === "string"
    ? entity.payload.contentHash
    : undefined;

const collectSnapshotEntities = async (uid: string, snapshotIds: string[]) => {
  const children = await withTimeout(
    Promise.all(snapshotIds.map((id) => getDocs(snapshotEntitiesRef(uid, id)))),
    FIRESTORE_READ_TIMEOUT_MS,
    "读取恢复快照内容超时，请确认网络可连接后重试。",
  );
  const parsed = await Promise.all(children.map((items) => parseAndNormalizeRemoteEntities(items.docs)));
  return parsed.flat();
};

type StorageCleanupOptions = { allowExpensive?: boolean; deadline?: number };
type StorageCleanupResult = { kind: "completed" } | { kind: "deferred-cost"; message: string };

const listStorageObjects = async (root: StorageReference, options: StorageCleanupOptions) => {
  const items = [] as Awaited<ReturnType<typeof list>>["items"];
  let pageToken: string | undefined;
  const pageSize = options.allowExpensive ? 1_000 : AUTO_MAINTENANCE_MAX_STORAGE_ITEMS_PER_ROOT + 1;
  do {
    if (options.deadline && Date.now() > options.deadline) return { items, deferred: true };
    const page = await withTimeout(
      list(root, { maxResults: pageSize, ...(pageToken ? { pageToken } : {}) }),
      ASSET_DOWNLOAD_TIMEOUT_MS,
      "列出云端资源超时，请确认网络可连接后重试。",
    );
    items.push(...page.items);
    if (!options.allowExpensive && (items.length > AUTO_MAINTENANCE_MAX_STORAGE_ITEMS_PER_ROOT || page.nextPageToken)) {
      return { items, deferred: true };
    }
    pageToken = page.nextPageToken;
  } while (pageToken);
  return { items, deferred: false };
};

/** Remove blobs that are no longer referenced by the active set or any retained recovery snapshot. */
const cleanUpUnreferencedStorage = async (
  uid: string,
  snapshotIds: string[],
  options: StorageCleanupOptions = {},
): Promise<StorageCleanupResult> => {
  const deadline = options.deadline ?? (options.allowExpensive ? Number.POSITIVE_INFINITY : Date.now() + AUTO_MAINTENANCE_MAX_DURATION_MS);
  const remote = await getRemoteState(uid);
  const activeCount = remote.exists ? (await getCountFromServer(entitiesRef(uid))).data().count : 0;
  const snapshotCounts = await Promise.all(snapshotIds.map((id) => getCountFromServer(snapshotEntitiesRef(uid, id))));
  const referencedDocumentCount = activeCount + snapshotCounts.reduce((sum, count) => sum + count.data().count, 0);
  if (!options.allowExpensive && referencedDocumentCount > AUTO_MAINTENANCE_MAX_REFERENCED_DOCS) {
    return { kind: "deferred-cost", message: `同步实体规模超过 ${AUTO_MAINTENANCE_MAX_REFERENCED_DOCS} 项，已跳过自动资源扫描。` };
  }
  const [assetListing, documentListing] = await Promise.all([
    listStorageObjects(assetsRootRef(uid), { ...options, deadline }),
    listStorageObjects(documentsRootRef(uid), { ...options, deadline }),
  ]);
  if (assetListing.deferred || documentListing.deferred) {
    return { kind: "deferred-cost", message: `云端 Storage 对象超过 ${EXPENSIVE_STORAGE_OBJECTS} 个，已跳过自动孤儿扫描。` };
  }
  let maintenanceLock: AcquiredLock;
  try {
    const state = await localState(uid);
    maintenanceLock = await acquireLock(uid, state.deviceId, `storage-gc:${newId()}`);
  } catch (error) {
    if (error instanceof Error && error.message.includes("另一台设备正在同步")) {
      return { kind: "deferred-cost", message: "检测到同步正在进行，已延期 Storage 清理。" };
    }
    throw error;
  }
  const lease = startLockRenewal(uid, maintenanceLock.deviceId, maintenanceLock);
  try {
    await lease.assert();
    // Re-read references after obtaining the lock. This closes the window where another device
    // uploaded a Storage object and then committed the entity metadata just before maintenance.
    const protectedRemote = await getRemoteState(uid);
    const protectedSnapshots = await withTimeout(
      getDocs(query(snapshotsRef(uid), orderBy("createdAt", "desc"), limit(SNAPSHOT_LIMIT))),
      FIRESTORE_READ_TIMEOUT_MS,
      "读取保留恢复快照超时，请确认网络可连接后重试。",
    );
    const protectedSnapshotIds = protectedSnapshots.docs.map((item) => item.id);
    const protectedActiveCount = protectedRemote.exists ? (await getCountFromServer(entitiesRef(uid))).data().count : 0;
    const protectedSnapshotCounts = await Promise.all(protectedSnapshotIds.map((id) => getCountFromServer(snapshotEntitiesRef(uid, id))));
    const protectedReferenceCount = protectedActiveCount + protectedSnapshotCounts.reduce((sum, count) => sum + count.data().count, 0);
    if (!options.allowExpensive && protectedReferenceCount > AUTO_MAINTENANCE_MAX_REFERENCED_DOCS) {
      return { kind: "deferred-cost", message: `同步实体规模超过 ${AUTO_MAINTENANCE_MAX_REFERENCED_DOCS} 项，已跳过自动资源扫描。` };
    }
    const active = protectedRemote.exists ? (await getAllRemote(uid, protectedRemote.state)).entities : [];
    const snapshots = await collectSnapshotEntities(uid, protectedSnapshotIds);
    const referenced = [...active, ...snapshots];
    const assetHashes = new Set(referenced.map(referencedAssetHash).filter((hash): hash is string => Boolean(hash)));
    const documentHashes = new Set(referenced
      .filter((entity) => !entity.deleted && entity.payloadDocumentHash)
      .map((entity) => entity.payloadDocumentHash as string));
    const stale = [
      ...assetListing.items.filter((item) => !assetHashes.has(item.name)),
      ...documentListing.items.filter((item) => !documentHashes.has(item.name)),
    ];
    if (!options.allowExpensive && stale.length > AUTO_MAINTENANCE_MAX_DELETES) {
      return { kind: "deferred-cost", message: `待清理 Storage 对象超过 ${AUTO_MAINTENANCE_MAX_DELETES} 个，已跳过自动删除。` };
    }
    for (const item of stale) {
      if (Date.now() > deadline) return { kind: "deferred-cost", message: "后台资源清理达到时间上限，已延期。" };
      await lease.assert();
      await withTimeout(deleteObject(item), ASSET_UPLOAD_TIMEOUT_MS, "清理云端资源超时，请确认网络可连接后重试。");
    }
    return { kind: "completed" };
  } finally {
    lease.stop();
    await releaseLock(uid, maintenanceLock.deviceId, maintenanceLock.operationId, maintenanceLock.revision, false);
  }
};

let snapshotMaintenanceRunning = false;

export interface CloudRecoveryMaintenanceOptions {
  /** Bypass automatic size limits after an explicit user confirmation. */
  allowExpensiveStorageGc?: boolean;
  /** Ignore the 24-hour automatic maintenance interval. */
  force?: boolean;
}

/**
 * Best-effort maintenance for recovery snapshots. This is intentionally separate from the sync
 * request so a successful user sync never waits for historical snapshot reads/deletes or Storage
 * garbage collection.
 */
export const cleanupCloudRecoverySnapshotsIfDue = async (
  uid: string,
  options: CloudRecoveryMaintenanceOptions = {},
): Promise<void> => {
  if (snapshotMaintenanceRunning) return;
  const state = await db.cloudSyncState.get("state");
  if (!state || state.userId !== uid) return;
  const last = state.lastSnapshotMaintenanceAt ? Date.parse(state.lastSnapshotMaintenanceAt) : 0;
  if (!options.force && Number.isFinite(last) && Date.now() - last < 24 * 60 * 60 * 1000) return;
  snapshotMaintenanceRunning = true;
  try {
    const snapshotCount = (await getCountFromServer(snapshotsRef(uid))).data().count;
    const snapshots = await withTimeout(
      getDocs(query(
        snapshotsRef(uid),
        orderBy("createdAt", "desc"),
        ...(options.allowExpensiveStorageGc ? [] : [limit(SNAPSHOT_LIMIT + 1)]),
      )),
      FIRESTORE_READ_TIMEOUT_MS,
      "检查云端恢复快照超时，请确认网络可连接后重试。",
    );
    const expired = snapshots.docs.slice(SNAPSHOT_LIMIT);
    for (const item of expired) {
      const children = await withTimeout(
        getDocs(snapshotEntitiesRef(uid, item.id)),
        FIRESTORE_READ_TIMEOUT_MS,
        "读取过期恢复快照超时，请确认网络可连接后重试。",
      );
      await writeInBatches([
        ...children.docs.map((child) => (batch: WriteBatch) => batch.delete(child.ref)),
        (batch: WriteBatch) => batch.delete(item.ref),
      ]);
    }
    // When more than one page of old snapshots remains, automatic GC cannot prove that a
    // Storage object is unreferenced. Delete the clearly expired page, then defer the expensive
    // orphan scan until the user explicitly confirms it.
    if (!options.allowExpensiveStorageGc && snapshotCount > SNAPSHOT_LIMIT + 1) {
      await db.cloudSyncState.update("state", {
        lastSnapshotMaintenanceStatus: "deferred-cost",
        lastSnapshotMaintenanceDeferredAt: new Date().toISOString(),
        lastSnapshotMaintenanceError: `恢复快照超过 ${SNAPSHOT_LIMIT + 1} 份，等待手动维护。`,
      });
      return;
    }
    if (expired.length > 0) {
      const retainedIds = snapshots.docs.slice(0, SNAPSHOT_LIMIT).map((item) => item.id);
      const cleanup = await cleanUpUnreferencedStorage(uid, retainedIds, {
        allowExpensive: options.allowExpensiveStorageGc,
        deadline: options.allowExpensiveStorageGc ? undefined : Date.now() + AUTO_MAINTENANCE_MAX_DURATION_MS,
      });
      if (cleanup.kind === "deferred-cost") {
        await db.cloudSyncState.update("state", {
          lastSnapshotMaintenanceStatus: "deferred-cost",
          lastSnapshotMaintenanceDeferredAt: new Date().toISOString(),
          lastSnapshotMaintenanceError: cleanup.message,
        });
        return;
      }
    }
    await db.cloudSyncState.update("state", {
      lastSnapshotMaintenanceAt: new Date().toISOString(),
      lastSnapshotMaintenanceError: undefined,
      lastSnapshotMaintenanceFailedAt: undefined,
      lastSnapshotMaintenanceStatus: "completed",
      lastSnapshotMaintenanceDeferredAt: undefined,
    }).catch(() => undefined);
  } catch (error) {
    // Maintenance is deliberately non-blocking. Keep a visible diagnostic but leave the success
    // timestamp untouched so the next foreground/idle opportunity can retry it.
    await db.cloudSyncState.update("state", {
      lastSnapshotMaintenanceError: error instanceof Error ? error.message : String(error),
      lastSnapshotMaintenanceFailedAt: new Date().toISOString(),
      lastSnapshotMaintenanceStatus: "failed",
    }).catch(() => undefined);
  } finally {
    snapshotMaintenanceRunning = false;
  }
};

const makeLocalSnapshot = async (
  user: User,
  exported: CloudSyncExport,
  label: string,
  revision: number,
  options: CloudSyncOptions,
  beforeBatch?: () => Promise<void>,
) => {
  const entities = exported.entities.map((entity) => toRemoteEntity(entity, revision));
  const events = exported.reviewEvents.map((event) => toRemoteReviewEvent(event, revision));
  await uploadAssets(user.uid, entities, exported.assetBlobs, options);
  return makeRemoteSnapshot(user.uid, label, entities, events, revision, options, beforeBatch);
};

const replaceCloudWithLocal = async (user: User, state: CloudSyncStateRecord, options: CloudSyncOptions): Promise<
  { revision: number; uploaded: number } | { writeBudget: CloudSyncWriteEstimate }
> => {
  const exported = await exportCloudSync(await storage.createCloudSyncSnapshot());
  const operationId = newId();
  const lock = await acquireLock(user.uid, state.deviceId, operationId);
  if (lock.recoveredStaleLock) progress(options, "checking", "检测到失联同步，已安全接管锁。");
  const lease = startLockRenewal(user.uid, state.deviceId, lock);
  let lockReleased = false;
  try {
    await saveOperation({
      id: operationId,
      operationId,
      userId: user.uid,
      deviceId: state.deviceId,
      revision: lock.revision,
      previousHeadRevision: lock.previousHead,
      expectedEntities: [],
      expectedEvents: [],
      phase: "acquiring",
      status: "pending",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    const remote = await getRemoteState(user.uid);
    const allRemote = await getAllRemote(user.uid, remote.state);
    const localKeys = new Set(exported.entities.map((entity) => entity.key));
    const tombstones = allRemote.entities
      .filter((entity) => !localKeys.has(entity.key) && !entity.deleted && entity.entityType !== "review-state" && entity.entityType !== "review-day-stat")
      .map((entity) => ({ ...entity, contentHash: `deleted:${entity.contentHash}`, payload: {}, deleted: true }));
    const changes = { entities: [...exported.entities, ...tombstones], events: exported.reviewEvents };
    const writeBudget = await writeBudgetResultFor(exported, changes, options, "local");
    const snapshotWrites = allRemote.entities.length + allRemote.reviewEvents.length + 2;
    const totalEstimate = writeBudget?.estimate ?? await cloudSyncWriteEstimateFor(exported, changes);
    const combinedEstimate = {
      ...totalEstimate,
      estimatedWrites: totalEstimate.estimatedWrites + snapshotWrites,
      overheadWrites: totalEstimate.overheadWrites + snapshotWrites,
    };
    if (cloudSyncWriteRequiresConfirmation(combinedEstimate, options.allowExpensiveWrite)) {
      await releaseLockSafely(user.uid, lock, false);
      lockReleased = true;
      await updateOperation(operationId, { status: "failed", phase: "releasing" });
      return { writeBudget: combinedEstimate };
    }
    await makeRemoteSnapshot(user.uid, "冲突前的云端版本", allRemote.entities, allRemote.reviewEvents, remote.state.headRevision, options, lease.assert);
    await lease.assert();
    const result = await publish(user, state, exported, changes, options, lock);
    lockReleased = true;
    await updateOperation(operationId, { status: "succeeded", phase: "releasing" });
    return result;
  } catch (error) {
    if (error instanceof CloudSyncResultUnknownError) throw error;
    if (isTimeoutError(error)) {
      await updateOperation(operationId, { status: "unknown", phase: "reconciling", errorMessage: error instanceof Error ? error.message : String(error) });
      throw new CloudSyncResultUnknownError(operationId, lock.revision, `${error instanceof Error ? error.message : String(error)} 操作结果未知，正在核对云端状态。`);
    }
    if (!lockReleased) {
      await releaseLockSafely(user.uid, lock, false, error);
    }
    await updateOperation(operationId, { status: "failed", phase: "releasing", errorMessage: error instanceof Error ? error.message : String(error) });
    throw error;
  } finally {
    lease.stop();
  }
};

const restoreRemote = async (uid: string, options: CloudSyncOptions, expectedEpoch?: number) => {
  const remote = await getRemoteState(uid);
  if (!remote.exists || remote.state.headRevision === 0) throw new Error("云端没有可恢复的增量同步数据。");
  progress(options, "downloading", "正在从云端读取全量数据。");
  const all = await getAllRemote(uid, remote.state);
  all.entities = await hydratePayloadDocuments(uid, all.entities, options);
  const assetBlobs = new Map<string, Blob>();
  await downloadRemoteAssets(uid, all.entities, assetBlobs, options);
  progress(options, "applying", "正在恢复云端数据。");
  const snapshot = materializeCloudSyncSnapshot(all.entities, all.reviewEvents, assetBlobs);
  if (expectedEpoch === undefined) await storage.restoreCloudSyncSnapshot(snapshot);
  else await storage.restoreCloudSyncSnapshotIfUnchanged(snapshot, expectedEpoch);
  return { state: remote.state, ...all };
};

export const getCurrentCloudUser = (): User | null => firebaseAuth.currentUser;

export const listenToCloudUser = (listener: (user: User | null) => void) => onAuthStateChanged(firebaseAuth, listener);

export const completeGoogleRedirect = async (): Promise<User | null> => {
  if (isNativePlatform()) return null;
  const result = await getRedirectResult(firebaseAuth);
  return result?.user ?? null;
};

const signInWithNativeGoogle = async (): Promise<User> => {
  const result = await FirebaseAuthentication.signInWithGoogle({ skipNativeAuth: true });
  const idToken = result.credential?.idToken;
  if (!idToken) {
    throw new Error("Google 登录未返回身份令牌。请确认 Android 应用的 SHA-1 指纹和 google-services.json 已更新。");
  }
  const credential = GoogleAuthProvider.credential(idToken, result.credential?.accessToken ?? null);
  const userCredential = await signInWithCredential(firebaseAuth, credential);
  return userCredential.user;
};

const signInWithDesktopOAuth = async (): Promise<User> => {
  const result = await window.studyJournalDesktop!.auth.signInWithGoogle();
  const credential = GoogleAuthProvider.credential(result.idToken);
  const userCredential = await signInWithCredential(firebaseAuth, credential);
  return userCredential.user;
};

export const signInToCloudSync = async (): Promise<User> => {
  if (isNativePlatform()) return signInWithNativeGoogle();
  if (isDesktopPlatform()) return signInWithDesktopOAuth();
  const popupPromise = signInWithPopup(firebaseAuth, googleAuthProvider);
  const userCredential = await new Promise<Awaited<typeof popupPromise>>((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error("Google 登录窗口未能打开或在 90 秒内完成。请确认使用最新 Desktop 安装包，并允许访问 study-journal-408-9f31.firebaseapp.com。"));
    }, DESKTOP_AUTH_TIMEOUT_MS);
    popupPromise.then(
      (result) => {
        clearTimeout(timeout);
        resolve(result);
      },
      (error: unknown) => {
        clearTimeout(timeout);
        reject(error);
      },
    );
  });
  return userCredential.user;
};

export const signOutOfCloudSync = async (): Promise<void> => {
  if (isNativePlatform()) {
    try {
      await FirebaseAuthentication.signOut();
    } finally {
      await signOut(firebaseAuth);
    }
    return;
  }
  await signOut(firebaseAuth);
};

export const getCloudSnapshotInfo = async (uid: string): Promise<CloudSnapshotInfo | undefined> => {
  const snapshot = await withTimeout(
    getDoc(legacyMetadataRef(uid)),
    FIRESTORE_READ_TIMEOUT_MS,
    "检查云端旧版备份信息超时，请确认网络可连接后重试。",
  );
  return snapshot.exists() ? parseLegacySnapshotInfo(snapshot.data()) : undefined;
};

export const getCloudSyncStatus = async (user: User): Promise<CloudSyncStatus> => {
  const [local, remote, legacy, exported, ledger, snapshotCount] = await Promise.all([
    localState(user.uid),
    getRemoteState(user.uid),
    getCloudSnapshotInfo(user.uid),
    exportCloudSync(await storage.createCloudSyncSnapshot()),
    ledgerFor(),
    estimateCount(snapshotsRef(user.uid)),
  ]);
  const migratedLedger = await migrateLegacyLedgers(exported, ledger);
  const bootstrapOnly = ledger.length === 0 && isBootstrapOnlyCloudData(exported);
  const changed = remote.exists && remote.state.headRevision > 0 && bootstrapOnly
    ? { entities: [] as CloudSyncEntity[], events: [] as CloudReviewEvent[] }
    : await deriveLocalCloudChanges(exported, migratedLedger);
  const [remoteEntities, remoteEvents] = remote.exists && remote.state.headRevision > local.lastPulledRevision
    ? await Promise.all([
      estimateCount(entitiesRef(user.uid), local.lastPulledRevision, remote.state.headRevision),
      estimateCount(reviewEventsRef(user.uid), local.lastPulledRevision, remote.state.headRevision),
    ])
    : [0, 0];
  const storageEstimate = remote.exists
    ? remoteStorageEstimate(remote.state)
    : { storageObjectCount: 0, storageBytes: 0, storageKnown: false };
  return {
    protocolVersion: remote.state.protocolVersion,
    cloudRevision: remote.state.headRevision,
    localPending: changed.entities.length + changed.events.length,
    remotePending: remoteEntities + remoteEvents,
    snapshotCount,
    legacySnapshotAvailable: Boolean(legacy && !remote.exists),
    lastSyncedAt: local.lastSyncedAt,
    lastSnapshotMaintenanceError: local.lastSnapshotMaintenanceError,
    lastSnapshotMaintenanceFailedAt: local.lastSnapshotMaintenanceFailedAt,
    lastSnapshotMaintenanceStatus: local.lastSnapshotMaintenanceStatus,
    lastSnapshotMaintenanceDeferredAt: local.lastSnapshotMaintenanceDeferredAt,
    storageBytes: storageEstimate.storageBytes,
    storageObjectCount: storageEstimate.storageObjectCount,
    storageKnown: storageEstimate.storageKnown,
  };
};

const reconcileOperation = async (user: User, operation: CloudSyncOperationRecord, options: CloudSyncOptions): Promise<boolean> => {
  await updateOperation(operation.operationId, { phase: "reconciling", status: "unknown" });
  try {
    const remote = await getRemoteState(user.uid);
    const expectedCount = operation.expectedEntities.length + operation.expectedEvents.length;
    // Inspect only the documents this operation intended to write. A timeout must never turn an
    // unknown-operation check into a full dataset read, particularly on a large account.
    const currentDocuments = remote.exists && expectedCount > 0
      ? await getTargetedRemoteDocuments(
        user.uid,
        operation.expectedEntities.map((item) => item.key),
        operation.expectedEvents.map((item) => item.key),
      )
      : { entities: [] as RemoteEntity[], reviewEvents: [] as RemoteReviewEvent[] };
    const latestEntities = new Map<string, RemoteEntity>();
    currentDocuments.entities.forEach((entity) => latestEntities.set(entity.key, entity));
    const latestEvents = new Map<string, RemoteReviewEvent>();
    currentDocuments.reviewEvents.forEach((event) => latestEvents.set(event.id, event));
    const matchedEntities = operation.expectedEntities
      .map((expected) => latestEntities.get(expected.key))
      .filter((entity): entity is RemoteEntity => Boolean(entity && entity.revision >= operation.revision));
    const matchedEvents = operation.expectedEvents
      .map((expected) => latestEvents.get(expected.key))
      .filter((event): event is RemoteReviewEvent => Boolean(event && event.revision >= operation.revision));
    const entitiesComplete = operation.expectedEntities.every((expected) => {
      const entity = latestEntities.get(expected.key);
      return Boolean(entity && entity.revision >= operation.revision && entity.contentHash === expected.contentHash);
    });
    const eventsComplete = operation.expectedEvents.every((expected) => {
      const event = latestEvents.get(expected.key);
      return Boolean(event && event.revision >= operation.revision && event.contentHash === expected.contentHash);
    });
    const lock = remote.state.lock;
    const stillHeld = lockMatches(lock, operation.deviceId, operation.operationId, operation.revision) && lock!.expiresAt > Date.now();

    if (expectedCount > 0 && remote.exists && entitiesComplete && eventsComplete) {
      let visibleRevision = remote.state.headRevision;
      if (remote.state.headRevision < operation.revision && stillHeld) {
        // We still own the original lease, so safely finish the operation that
        // wrote the metadata before the client lost its response.
        await releaseLock(user.uid, operation.deviceId, operation.operationId, operation.revision, true);
        visibleRevision = operation.revision;
      } else if (remote.state.headRevision < operation.revision && (!lock || !stillHeld)) {
        // Metadata exists at the target revision but the head was never
        // advanced. Acquire a short repair lease and publish the highest head
        // so the data cannot remain permanently invisible.
        const repair = await acquireLock(user.uid, operation.deviceId, `${operation.operationId}:repair:${newId()}`);
        await releaseLock(user.uid, operation.deviceId, repair.operationId, repair.revision, true);
        visibleRevision = repair.revision;
      } else if (lockMatches(lock, operation.deviceId, operation.operationId, operation.revision) && stillHeld) {
        // The target is already visible, but the response to the original
        // release was lost. Clear the matching lock while we still own it.
        await releaseLock(user.uid, operation.deviceId, operation.operationId, operation.revision, true);
      } else if (lock && !stillHeld) {
        // The target is already visible, but an expired stale lock remains.
        // Acquiring and releasing a repair lease clears it without lowering
        // the current head.
        const repair = await acquireLock(user.uid, operation.deviceId, `${operation.operationId}:unlock:${newId()}`);
        await releaseLock(user.uid, operation.deviceId, repair.operationId, repair.revision, false);
      } else if (lock && !lockMatches(lock, operation.deviceId, operation.operationId, operation.revision)) {
        // A newer operation owns the lock. It may still be in flight, so do not mark this one as
        // complete until its already-written revision is visible.
        if (remote.state.headRevision < operation.revision) {
          await updateOperation(operation.operationId, { status: "unknown", phase: "reconciling", reconciliationReason: "目标数据已写入，但等待后续操作推进可见修订。" });
          return false;
        }
      }
      const state = await localState(user.uid);
      await persistLedgers(state, matchedEntities, matchedEvents, visibleRevision);
      await updateOperation(operation.operationId, {
        status: "succeeded",
        phase: "reconciling",
        reconciliationReason: "目标实体与事件已完整提交。",
        reconciledAt: new Date().toISOString(),
      });
      return true;
    }

    const expectedDocumentsWereSuperseded = remote.exists && isCloudSyncOperationSuperseded(
      operation,
      { entities: [...latestEntities.values()], events: [...latestEvents.values()].map((event) => ({ key: event.id, revision: event.revision })) },
      remote.state.headRevision,
    );
    if (expectedDocumentsWereSuperseded) {
      // The only writes we can identify are now behind a newer visible revision. Retain the audit
      // record, but let the next sync proceed instead of permanently blocking on an obsolete hash.
      await updateOperation(operation.operationId, {
        status: "superseded",
        phase: "reconciling",
        supersededByRevision: remote.state.headRevision,
        reconciliationReason: "目标实体已被更高修订覆盖。",
        reconciledAt: new Date().toISOString(),
      });
      return true;
    }

    if (expectedCount === 0) {
      // Empty expectations come from a no-change acquire/release path, or from a request that
      // stopped before it had computed what to publish. They are intentionally reconciled only
      // from phase, lock and head revision; scanning the collection cannot prove more safely.
      if (remote.state.headRevision > operation.revision) {
        await updateOperation(operation.operationId, {
          status: "superseded",
          phase: "reconciling",
          supersededByRevision: remote.state.headRevision,
          reconciliationReason: "云端可见修订已越过未记录实体的旧操作。",
          reconciledAt: new Date().toISOString(),
        });
        return true;
      }
      if (operation.phase === "acquiring" || operation.phase === "uploading") {
        if (stillHeld) await releaseLock(user.uid, operation.deviceId, operation.operationId, operation.revision, false);
        if (!stillHeld || !lock || lockMatches(lock, operation.deviceId, operation.operationId, operation.revision)) {
          await updateOperation(operation.operationId, {
            status: "succeeded",
            phase: "reconciling",
            reconciliationReason: "未记录待提交实体，已按无变更操作收敛。",
            reconciledAt: new Date().toISOString(),
          });
          return true;
        }
      }
      if (remote.state.headRevision < operation.revision) {
        if (stillHeld) await releaseLock(user.uid, operation.deviceId, operation.operationId, operation.revision, false);
        await updateOperation(operation.operationId, {
          status: "succeeded",
          phase: "reconciling",
          reconciliationReason: "未记录待提交实体，且目标修订未对云端产生可见变更。",
          reconciledAt: new Date().toISOString(),
        });
        return true;
      }
      await updateOperation(operation.operationId, {
        status: "unknown",
        phase: "reconciling",
        reconciliationReason: "操作未记录待提交实体，当前阶段无法证明是否发生部分提交。",
      });
      return false;
    }

    if (!stillHeld && !lock && (!remote.exists || remote.state.headRevision < operation.revision)) {
      await updateOperation(operation.operationId, {
        status: "failed",
        phase: "reconciling",
        reconciliationReason: "未发现目标修订或仍持有的锁。",
        reconciledAt: new Date().toISOString(),
        lockReleaseError: undefined,
        lockReleaseErrorAt: undefined,
        lockReleaseAttempts: undefined,
      });
      return true;
    }
    if (stillHeld && isStaleRemoteLock(lock)) {
      // The original process is no longer renewing its lease. Take over through a CAS transaction,
      // then release the new fence without advancing head; the next normal sync can safely reuse
      // the account while any old in-flight metadata transaction is fenced out.
      progress(options, "checking", "检测到失联同步，正在安全接管。");
      const currentState = await localState(user.uid);
      const recovery = await acquireLock(user.uid, currentState.deviceId, `${operation.operationId}:takeover:${newId()}`);
      await releaseLock(user.uid, recovery.deviceId, recovery.operationId, recovery.revision, false);
      await updateOperation(operation.operationId, {
        status: "failed",
        phase: "reconciling",
        reconciliationReason: "原同步租约已失联，已通过 CAS 安全接管并解除阻塞。",
        reconciledAt: new Date().toISOString(),
        lockReleaseError: undefined,
        lockReleaseErrorAt: undefined,
        lockReleaseAttempts: undefined,
      });
      progress(options, "checking", "已解除失联同步锁，继续检查本机和云端更改。");
      return true;
    }
    await updateOperation(operation.operationId, { status: "unknown", phase: "reconciling" });
    return false;
  } catch (error) {
    await updateOperation(operation.operationId, {
      status: "unknown",
      phase: "reconciling",
      errorMessage: error instanceof Error ? error.message : String(error),
    });
    progress(options, "checking", "上次同步结果仍无法确认，请确认网络后重试核对。 ");
    return false;
  }
};

const reconcilePendingOperations = async (user: User, options: CloudSyncOptions) => {
  const pending = await pendingOperationsFor(user.uid);
  for (const operation of pending) {
    await reconcileOperation(user, operation, options);
  }
  return pendingOperationsFor(user.uid);
};

export const synchronizeCloudChanges = async (user: User, options: CloudSyncOptions = {}): Promise<CloudSyncResult> => {
  progress(options, "checking", "正在检查本机和云端的更改。");
  const remainingOperations = await reconcilePendingOperations(user, options);
  if (remainingOperations.length > 0) {
    const operation = remainingOperations[0];
    return {
      kind: "uncertain",
      operationId: operation.operationId,
      revision: operation.revision,
      message: "上一次同步结果尚未确认，已暂停新的同步，请保持网络连接后重试核对。",
    };
  }
  const operationId = newId();
  const initialEpoch = await storage.getCloudSyncMutationEpoch();
  const [state, initialRemote, legacy, initialSnapshot, ledger] = await Promise.all([
    localState(user.uid),
    getRemoteState(user.uid),
    getCloudSnapshotInfo(user.uid),
    storage.createCloudSyncSnapshot(),
    ledgerFor(),
  ]);
  const initialExport = await exportCloudSync(initialSnapshot);
  const migratedLedger = await migrateLegacyLedgers(initialExport, ledger);
  const firstEmptyDevice = ledger.length === 0 && isBootstrapOnlyCloudData(initialExport);
  const initialChanges = await deriveLocalCloudChanges(initialExport, migratedLedger);
  const remoteAlreadySeen = !initialRemote.exists || initialRemote.state.headRevision <= state.lastPulledRevision;
  if (canSkipCloudSyncLock(Boolean(legacy), initialRemote.exists, initialRemote.state.headRevision, state.lastPulledRevision, initialChanges)) {
    progress(options, "done", "本机和云端均无新变化。");
    return { kind: "synced", uploaded: 0, downloaded: 0, revision: state.lastPulledRevision, pending: 0 };
  }
  if (remoteAlreadySeen) {
    const writeBudget = await writeBudgetResultFor(initialExport, initialChanges, options, "sync");
    if (writeBudget) return writeBudget;
  }
  let lock: AcquiredLock | undefined;
  let lockReleased = false;
  let restored = false;
  try {
    lock = await acquireLock(user.uid, state.deviceId, operationId);
    if (lock.recoveredStaleLock) progress(options, "checking", "检测到失联同步，已安全接管锁。");
    await saveOperation({
      id: operationId,
      operationId,
      userId: user.uid,
      deviceId: state.deviceId,
      revision: lock.revision,
      previousHeadRevision: lock.previousHead,
      expectedEntities: [],
      expectedEvents: [],
      phase: "acquiring",
      status: "pending",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    if (!initialRemote.exists && legacy && !isBootstrapOnlyCloudData(initialExport)) {
      await releaseLock(user.uid, state.deviceId, lock.operationId, lock.revision, false);
      await updateOperation(operationId, { status: "failed", phase: "releasing" });
      lockReleased = true;
      return { kind: "conflict", conflict: { reason: "legacy-snapshot", localChanges: initialExport.entities.length, remoteChanges: 1, cloudRevision: 0 } };
    }

    if (!initialRemote.exists && legacy && firstEmptyDevice) {
      progress(options, "downloading", "正在迁移旧版云端备份。", 0, 1);
      const archive = await withTimeout(
        getCloudStorageBlob(user.uid, legacySnapshotRef(user.uid)),
        ASSET_DOWNLOAD_TIMEOUT_MS,
        "下载云端旧版备份超时，请确认网络可连接 Firebase Storage 后重试。",
      );
      const snapshot = await zipToSnapshot(new File([archive], "study-journal-cloud-sync.zip", { type: "application/zip" }));
      await storage.restoreCloudSyncSnapshotIfUnchanged(snapshot, initialEpoch);
      restored = true;
    }

    const remote = await getRemoteState(user.uid);
    if (firstEmptyDevice && remote.exists && remote.state.headRevision > 0) {
      const estimate = await readEstimateFor(user.uid, remote.state, state, migratedLedger, initialExport);
      if (requiresReadConfirmation(estimate, options)) {
        await releaseLock(user.uid, state.deviceId, lock.operationId, lock.revision, false);
        await updateOperation(operationId, { status: "failed", phase: "releasing" });
        lockReleased = true;
        return { kind: "read-budget", estimate, message: readBudgetMessage(estimate), choice: "cloud" };
      }
      // A new device's generated settings/tags are bootstrap material, not
      // user edits. Pull the complete cloud snapshot before any diffing so
      // random local IDs can never create a first-sync conflict or upload.
      const allRemote = await getAllRemote(user.uid, remote.state);
      await applyRemote(user.uid, initialExport, allRemote, options, initialEpoch);
      await persistLedgers(state, allRemote.entities, allRemote.reviewEvents, remote.state.headRevision, remote.state.headRevision);
      const storageSummary = await cloudStorageSummaryFor(allRemote.entities, remote.state.headRevision, initialExport.assetBlobs).catch(() => undefined);
      await releaseLock(user.uid, state.deviceId, lock.operationId, lock.revision, false, storageSummary);
      await updateOperation(operationId, { status: "succeeded", phase: "releasing" });
      lockReleased = true;
      const downloaded = allRemote.entities.length + allRemote.reviewEvents.length;
      progress(options, "done", "已从云端恢复现有数据。");
      return { kind: "synced", uploaded: 0, downloaded, revision: remote.state.headRevision, pending: 0, restored: true };
    }
    const remoteChanges = remote.exists ? await getRemoteChanges(user.uid, state.lastPulledRevision, remote.state) : { entities: [], reviewEvents: [] };
    const changed = await deriveLocalCloudChanges(restored ? await exportCloudSync(await storage.createCloudSyncSnapshot()) : initialExport, migratedLedger);
    const mergedRemoteChanges = await mergeRemoteFieldChanges(initialExport, changed, remoteChanges, migratedLedger);
    const normalLocal = (firstEmptyDevice ? [] : changed.entities)
      .filter((entity) => !NON_CONFLICTING_ENTITY_TYPES.has(entity.entityType));
    const normalRemote = remoteChanges.entities.filter((entity) => !NON_CONFLICTING_ENTITY_TYPES.has(entity.entityType));
    const contentConflicts = findConflictingChanges(normalLocal, normalRemote)
      .map((item) => ({ ...item, reason: "content" as const }));
    const conflicts = [...contentConflicts, ...mergedRemoteChanges.conflicts];
    if (conflicts.length > 0) {
      await releaseLock(user.uid, state.deviceId, lock.operationId, lock.revision, false);
      await updateOperation(operationId, { status: "failed", phase: "releasing" });
      lockReleased = true;
      return {
        kind: "conflict",
        conflict: {
          reason: "concurrent-changes",
          localChanges: normalLocal.length + changed.entities.filter((entity) => entity.entityType === "settings" || entity.entityType === "template").length,
          remoteChanges: normalRemote.length + remoteChanges.entities.filter((entity) => entity.entityType === "settings" || entity.entityType === "template").length,
          cloudRevision: remote.state.headRevision,
          conflicts,
        },
      };
    }
    let downloaded = 0;
    if (!restored && (remoteChanges.entities.length || remoteChanges.reviewEvents.length)) {
      await applyRemote(user.uid, initialExport, mergedRemoteChanges, options, initialEpoch);
      const completeThroughRevision = state.remoteDatasetCompleteThroughRevision !== undefined
        && state.remoteDatasetCompleteThroughRevision === state.lastPulledRevision
        ? remote.state.headRevision
        : undefined;
      await persistLedgers(state, remoteChanges.entities, remoteChanges.reviewEvents, remote.state.headRevision, completeThroughRevision);
      downloaded = remoteChanges.entities.length + remoteChanges.reviewEvents.length;
      restored = true;
    }
    const skipReExport = downloaded === 0 && !restored;
    const afterPullState = skipReExport ? state : await localState(user.uid);
    const afterPullExport = skipReExport ? initialExport : await exportCloudSync(await storage.createCloudSyncSnapshot());
    const afterPullChanges = skipReExport ? changed : await deriveLocalCloudChanges(afterPullExport, await ledgerFor());
    const writeBudget = await writeBudgetResultFor(afterPullExport, afterPullChanges, options, "sync");
    if (writeBudget) {
      await releaseLock(user.uid, state.deviceId, lock.operationId, lock.revision, false);
      await updateOperation(operationId, { status: "failed", phase: "releasing" });
      lockReleased = true;
      return writeBudget;
    }
    const expected = expectedValues(afterPullChanges.entities, afterPullChanges.events);
    await updateOperation(operationId, { expectedEntities: expected.expectedEntities, expectedEvents: expected.expectedEvents, phase: "uploading" });
    const published = await publish(user, afterPullState, afterPullExport, afterPullChanges, options, lock);
    lockReleased = true;
    progress(options, "done", "云端同步完成。");
    return { kind: "synced", uploaded: published.uploaded, downloaded, revision: published.revision, pending: 0, restored };
  } catch (error) {
    if (error instanceof CloudSyncResultUnknownError) {
      return { kind: "uncertain", operationId: error.operationId, revision: error.revision, message: error.message };
    }
    if (lock && isTimeoutError(error)) {
      await updateOperation(operationId, { status: "unknown", phase: "reconciling", errorMessage: error instanceof Error ? error.message : String(error) });
      return {
        kind: "uncertain",
        operationId,
        revision: lock.revision,
        message: `${error instanceof Error ? error.message : String(error)} 操作结果未知，正在核对云端状态。`,
      };
    }
    if (error instanceof CloudSyncLocalMutationError) {
      if (lock && !lockReleased) {
        await releaseLockSafely(user.uid, lock, false, error);
        lockReleased = true;
      }
      await updateOperation(operationId, { status: "failed", phase: "releasing", errorMessage: error.message });
      return {
        kind: "conflict",
        conflict: {
          reason: "local-changed-during-sync",
          localChanges: 1,
          remoteChanges: 0,
          cloudRevision: initialRemote.state.headRevision,
        },
      };
    }
    if (lock && !lockReleased) {
      await releaseLockSafely(user.uid, lock, false, error);
      await updateOperation(operationId, { status: "failed", phase: "releasing", errorMessage: error instanceof Error ? error.message : String(error) });
    }
    throw error;
  }
};

export const resolveCloudSyncConflict = async (
  user: User,
  choice: CloudSyncConflictChoice,
  options: CloudSyncOptions = {},
): Promise<CloudSyncResult> => {
  const state = await localState(user.uid);
  if (choice === "local") {
    if (!options.allowExpensiveRead) {
      const localExport = await exportCloudSync(await storage.createCloudSyncSnapshot());
      const remote = await getRemoteState(user.uid);
      if (remote.exists && remote.state.headRevision > 0) {
        const fullReadEstimate = await readEstimateFor(user.uid, remote.state, { ...state, remoteDatasetCompleteThroughRevision: undefined }, await ledgerFor(), localExport);
        // Replacing the cloud creates a Firestore recovery snapshot but never downloads its active
        // Storage objects. Do not ask for a Storage-download confirmation that this branch cannot use.
        const estimate = { ...fullReadEstimate, storageObjectCount: 0, storageBytes: 0, storageKnown: true };
        if (requiresReadConfirmation(estimate, options)) {
          return { kind: "read-budget", estimate, message: readBudgetMessage(estimate), choice };
        }
      }
    }
    let result: { revision: number; uploaded: number } | { writeBudget: CloudSyncWriteEstimate };
    try {
      result = await replaceCloudWithLocal(user, state, options);
    } catch (error) {
      if (error instanceof CloudSyncResultUnknownError) {
        return { kind: "uncertain", operationId: error.operationId, revision: error.revision, message: error.message };
      }
      throw error;
    }
    if ("writeBudget" in result) {
      return { kind: "write-budget", estimate: result.writeBudget, message: writeBudgetMessage(result.writeBudget), choice };
    }
    progress(options, "done", "已以本机数据更新云端。");
    return { kind: "synced", uploaded: result.uploaded, downloaded: 0, revision: result.revision, pending: 0 };
  }
  progress(options, "snapshot", "正在导出本机数据准备恢复点。");
  const initialEpoch = await storage.getCloudSyncMutationEpoch();
  const localExport = await exportCloudSync(await storage.createCloudSyncSnapshot());
  const localRecoveryBudget = await writeBudgetResultFor(localExport, {
    entities: localExport.entities,
    events: localExport.reviewEvents,
  }, options, choice);
  if (localRecoveryBudget) return localRecoveryBudget;
  const ledger = await ledgerFor();
  let remote = await getRemoteState(user.uid);
  if (remote.exists && remote.state.headRevision > 0) {
    const estimate = await readEstimateFor(user.uid, remote.state, state, ledger, localExport);
    if (requiresReadConfirmation(estimate, options)) {
      return { kind: "read-budget", estimate, message: readBudgetMessage(estimate), choice };
    }
  }
  const operationId = newId();
  const lock = await acquireLock(user.uid, state.deviceId, operationId);
  if (lock.recoveredStaleLock) progress(options, "checking", "检测到失联同步，已安全接管锁。");
  const lease = startLockRenewal(user.uid, state.deviceId, lock);
  let lockReleased = false;
  try {
    await saveOperation({
      id: operationId,
      operationId,
      userId: user.uid,
      deviceId: state.deviceId,
      revision: lock.revision,
      previousHeadRevision: lock.previousHead,
      expectedEntities: [],
      expectedEvents: [],
      phase: "acquiring",
      status: "pending",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    // Re-read the state after acquiring the lock. If the dataset completeness proof changed
    // while the confirmation dialog was open, the next branch will conservatively fall back to
    // the full path (or return a fresh read-budget result before any snapshot is created).
    remote = await getRemoteState(user.uid);
    let remoteEstimate: CloudSyncReadEstimate | undefined;
    if (remote.exists && remote.state.headRevision > 0) {
      const currentEstimate = await readEstimateFor(user.uid, remote.state, state, ledger, localExport);
      remoteEstimate = currentEstimate;
      if (requiresReadConfirmation(currentEstimate, options)) {
        await releaseLockSafely(user.uid, lock, false);
        lockReleased = true;
        await updateOperation(operationId, { status: "failed", phase: "releasing" });
        return { kind: "read-budget", estimate: currentEstimate, message: readBudgetMessage(currentEstimate), choice };
      }
    }
    if (remote.exists && remote.state.headRevision > 0) {
      const complete = state.remoteDatasetCompleteThroughRevision !== undefined
        && state.remoteDatasetCompleteThroughRevision === state.lastPulledRevision
        && remote.state.headRevision >= state.lastPulledRevision;
      const dataset = complete
        ? await buildIncrementalRemoteDataset(user.uid, state, remote.state, localExport, ledger)
        : await buildFullRemoteDataset(user.uid, state, remote.state);
      const remoteChanges = dataset.changed;
      const fieldMerged = await mergeRemoteFieldChanges(localExport, await deriveLocalCloudChanges(localExport, ledger), remoteChanges, ledger);
      const remoteChangedKeys = new Set(remoteChanges.entities.map((entity) => entity.key));
      const remoteChangedEvents = new Set(remoteChanges.reviewEvents.map((event) => event.id));
      const fieldMergedByKey = new Map(fieldMerged.entities.map((entity) => [entity.key, entity]));
      const changed = await deriveLocalCloudChanges(localExport, ledger);
      const preservedLocal = preserveLocalChangesForCloudWins(changed.entities, dataset.entities, remoteChangedKeys);
      const cloudEntitiesByKey = new Map<string, CloudSyncEntity>(dataset.entities.map((entity) => [entity.key, entity]));
      fieldMergedByKey.forEach((entity, key) => cloudEntitiesByKey.set(key, entity));
      preservedLocal.forEach((entity) => cloudEntitiesByKey.set(entity.key, entity));
      const localByKey = new Map(localExport.entities.map((entity) => [entity.key, entity]));
      const storagePlan = await cloudStorageDownloadPlanFor([...cloudEntitiesByKey.values()], localExport);
      const exactEstimate = withStoragePlan(remoteEstimate ?? await readEstimateFor(user.uid, remote.state, state, ledger, localExport), storagePlan);
      if (requiresReadConfirmation(exactEstimate, options)) {
        await releaseLockSafely(user.uid, lock, false);
        lockReleased = true;
        await updateOperation(operationId, { status: "failed", phase: "releasing" });
        return { kind: "read-budget", estimate: exactEstimate, message: readBudgetMessage(exactEstimate), choice };
      }
      // The only point where a cloud-wins recovery writes a recovery point. Firestore and Storage
      // estimates are both approved by now, so cancelling the dialog above has no side effects.
      progress(options, "snapshot", `正在上传本机恢复快照（共 ${localExport.assetBlobs.size} 个资源）。`);
      await makeLocalSnapshot(user, localExport, "冲突前的本机版本", remote.state.headRevision, options, lease.assert);
      await lease.assert();
      const hydratedCloudEntities = await hydratePayloadDocuments(user.uid, [...cloudEntitiesByKey.values()], options, localByKey);
      const cloudEntities = hydratedCloudEntities.map((entity) => preserveAssetOperationalFields(localByKey.get(entity.key), entity));
      const cloudEventsById = new Map<string, CloudReviewEvent>(dataset.reviewEvents.map((event) => [event.id, event]));
      changed.events.filter((event) => !remoteChangedEvents.has(event.id) && !cloudEventsById.has(event.id)).forEach((event) => cloudEventsById.set(event.id, event));
      const cloudEvents = [...cloudEventsById.values()];
      const assetBlobs = new Map(localExport.assetBlobs);
      await downloadRemoteAssets(user.uid, cloudEntities, assetBlobs, options);
      await lease.assert();
      progress(options, "applying", "正在恢复云端数据。");
      const conflictKeys = new Set(findConflictingChanges(changed.entities, remoteChanges.entities).map((item) => item.key));
      const cloudSnapshot = withDecisionBlockConflictCopies(
        materializeCloudSyncSnapshot(cloudEntities, cloudEvents, assetBlobs),
        localExport.entities,
        conflictKeys,
        new Date().toISOString(),
      );
      await storage.restoreCloudSyncSnapshotIfUnchanged(cloudSnapshot, initialEpoch);
      await persistLedgers(state, dataset.entities, dataset.reviewEvents, remote.state.headRevision, dataset.completeThroughRevision);
      await lease.assert();
      const storageSummary = await cloudStorageSummaryFor(dataset.entities, remote.state.headRevision, localExport.assetBlobs).catch(() => undefined);
      await releaseLock(user.uid, state.deviceId, lock.operationId, lock.revision, false, storageSummary);
      lockReleased = true;
      await updateOperation(operationId, { status: "succeeded", phase: "releasing" });
      progress(options, "done", "已以云端为准完成同步。");
      return { kind: "synced", uploaded: 0, downloaded: dataset.entities.length + dataset.reviewEvents.length, revision: remote.state.headRevision, pending: preservedLocal.length, restored: true };
    }
    // Legacy zip backups do not carry a trustworthy object/byte manifest. Treat their Storage
    // download as unknown and require the same explicit confirmation before creating a recovery
    // point or fetching the archive.
    const legacyBeforeRestore = await getCloudSnapshotInfo(user.uid);
    if (legacyBeforeRestore && !options.allowExpensiveRead) {
      const estimate: CloudSyncReadEstimate = {
        mode: "full",
        estimatedReads: 8,
        entityReads: 0,
        reviewEventReads: 0,
        targetedReads: 0,
        overheadReads: 8,
        storageObjectCount: 0,
        storageBytes: 0,
        storageKnown: false,
      };
      await releaseLockSafely(user.uid, lock, false);
      lockReleased = true;
      await updateOperation(operationId, { status: "failed", phase: "releasing" });
      return { kind: "read-budget", estimate, message: readBudgetMessage(estimate), choice };
    }
    progress(options, "snapshot", `正在上传本机恢复快照（共 ${localExport.assetBlobs.size} 个资源）。`);
    await makeLocalSnapshot(user, localExport, "冲突前的本机版本", remote.state.headRevision, options, lease.assert);
    await lease.assert();
    const restored = await restoreRemote(user.uid, options, initialEpoch).catch(async (error: unknown) => {
      if (error instanceof CloudSyncLocalMutationError) throw error;
      const legacy = await getCloudSnapshotInfo(user.uid);
      if (!legacy) throw error;
      const archive = await withTimeout(
        getCloudStorageBlob(user.uid, legacySnapshotRef(user.uid)),
        ASSET_DOWNLOAD_TIMEOUT_MS,
        "下载云端旧版备份超时，请确认网络可连接 Firebase Storage 后重试。",
      );
      const snapshot = await zipToSnapshot(new File([archive], "study-journal-cloud-sync.zip", { type: "application/zip" }));
      await storage.restoreCloudSyncSnapshotIfUnchanged(snapshot, initialEpoch);
      return undefined;
    });
    if (restored) {
      await resetAndPersistLedgers(state, restored.entities, restored.reviewEvents, restored.state.headRevision);
      await lease.assert();
      await releaseLock(user.uid, state.deviceId, lock.operationId, lock.revision, false);
      lockReleased = true;
      await updateOperation(operationId, { status: "succeeded", phase: "releasing" });
      progress(options, "done", "已恢复云端数据。");
      return { kind: "synced", uploaded: 0, downloaded: restored.entities.length + restored.reviewEvents.length, revision: restored.state.headRevision, pending: 0, restored: true };
    }
    const imported = await exportCloudSync(await storage.createCloudSyncSnapshot());
    await resetLedgers(state);
    const importedChanges = {
      entities: imported.entities,
      events: imported.reviewEvents,
    };
    const writeBudget = await writeBudgetResultFor(imported, importedChanges, options, choice);
    if (writeBudget) {
      await releaseLockSafely(user.uid, lock, false);
      lockReleased = true;
      await updateOperation(operationId, { status: "failed", phase: "releasing" });
      return writeBudget;
    }
    const published = await publish(user, { ...state, lastPulledRevision: 0, lastReviewEventRevision: 0 }, imported, importedChanges, options, lock);
    lockReleased = true;
    progress(options, "done", "已迁移旧版云端备份到增量同步。");
    return { kind: "synced", uploaded: published.uploaded, downloaded: 1, revision: published.revision, pending: 0, restored: true };
  } catch (error) {
    if (error instanceof CloudSyncResultUnknownError) {
      return { kind: "uncertain", operationId: error.operationId, revision: error.revision, message: error.message };
    }
    if (isTimeoutError(error)) {
      await updateOperation(operationId, { status: "unknown", phase: "reconciling", errorMessage: error instanceof Error ? error.message : String(error) });
      return {
        kind: "uncertain",
        operationId,
        revision: lock.revision,
        message: `${error instanceof Error ? error.message : String(error)} 操作结果未知，正在核对云端状态。`,
      };
    }
    if (error instanceof CloudSyncLocalMutationError) {
      if (!lockReleased) {
        await releaseLockSafely(user.uid, lock, false, error);
        lockReleased = true;
      }
      await updateOperation(operationId, { status: "failed", phase: "releasing", errorMessage: error.message });
      return {
        kind: "conflict",
        conflict: { reason: "local-changed-during-sync", localChanges: 1, remoteChanges: 0, cloudRevision: (await getRemoteState(user.uid)).state.headRevision },
      };
    }
    if (!lockReleased) {
      await releaseLockSafely(user.uid, lock, false, error);
    }
    await updateOperation(operationId, { status: "failed", phase: "releasing", errorMessage: error instanceof Error ? error.message : String(error) });
    throw error;
  } finally {
    lease.stop();
  }
};

export const listCloudRecoverySnapshots = async (uid: string): Promise<CloudRecoverySnapshot[]> => {
  const snapshots = await withTimeout(
    getDocs(query(snapshotsRef(uid), orderBy("createdAt", "desc"))),
    FIRESTORE_READ_TIMEOUT_MS,
    "获取云端恢复快照列表超时，请确认网络可连接后重试。",
  );
  return snapshots.docs.map((item) => {
    const value = item.data() as Record<string, unknown>;
    return {
      id: item.id,
      createdAt: typeof value.createdAt === "string" ? value.createdAt : new Date(0).toISOString(),
      label: typeof value.label === "string" ? value.label : "恢复快照",
      entityCount: typeof value.entityCount === "number" ? value.entityCount : 0,
      revision: typeof value.revision === "number" ? value.revision : 0,
    };
  });
};

export const restoreCloudRecoverySnapshot = async (user: User, id: string, options: CloudSyncOptions = {}) => {
  const initialEpoch = await storage.getCloudSyncMutationEpoch();
  const items = await withTimeout(
    getDocs(snapshotEntitiesRef(user.uid, id)),
    FIRESTORE_READ_TIMEOUT_MS,
    "读取恢复快照超时，请确认网络可连接后重试。",
  );
  if (items.empty) throw new Error("恢复快照不存在或已被清理。");
  let entities = await parseAndNormalizeRemoteEntities(items.docs);
  const reviewEvents = items.docs
    .map((item) => item.id.startsWith("review-event:") ? parseRemoteReviewEvent(item.id.slice("review-event:".length), item.data()) : undefined)
    .filter((item): item is RemoteReviewEvent => Boolean(item));
  entities = await hydratePayloadDocuments(user.uid, entities, options);
  const assetBlobs = new Map<string, Blob>();
  await downloadRemoteAssets(user.uid, entities, assetBlobs, options);
  await storage.restoreCloudSyncSnapshotIfUnchanged(materializeCloudSyncSnapshot(entities, reviewEvents, assetBlobs), initialEpoch);
  const local = await localState(user.uid);
  const revision = Math.max(0, ...entities.map((entity) => entity.revision), ...reviewEvents.map((event) => event.revision));
  await resetAndPersistLedgers(local, entities, reviewEvents, revision);
};
