import { describe, expect, it } from "vitest";

import {
  assertDownloadedAssetVerified,
  assertStrictCloudSnapshot,
  assertStrictRemoteDataset,
  classifyCloudRecoverySnapshot,
  CLOUD_SNAPSHOT_ENTITY_TYPES,
  describeCloudRecoverySnapshotStatus,
  isCloudRecoverySnapshotRestorable,
} from "./cloudSnapshotIntegrity";
import { hashBlob } from "./cloudSyncModel";

const parent = (value: Record<string, unknown> = {}) => ({ entityCount: 1, revision: 4, complete: true, ...value });

const entityDoc = (documentId: string, value: Record<string, unknown> = {}) => ({
  id: documentId,
  data: () => ({
    entityType: documentId.split(":")[0],
    entityId: documentId.split(":").slice(1).join(":"),
    contentHash: "hash-1",
    revision: 4,
    payload: { id: documentId.split(":").slice(1).join(":"), title: "t" },
    deleted: false,
    ...value,
  }),
});

const expectRejected = (fn: () => unknown, pattern: RegExp) => {
  expect(fn).toThrow(pattern);
};

describe("cloud snapshot status classification", () => {
  it("distinguishes complete, writing, legacy and unprovable recovery points", () => {
    expect(classifyCloudRecoverySnapshot(parent())).toBe("complete");
    expect(classifyCloudRecoverySnapshot(parent({ complete: false }))).toBe("writing");
    expect(classifyCloudRecoverySnapshot(parent({ status: "writing", complete: undefined }))).toBe("writing");
    expect(classifyCloudRecoverySnapshot({ entityCount: 3, revision: 4 })).toBe("legacy-unverified");
    expect(classifyCloudRecoverySnapshot({ entityCount: 0, revision: 4 })).toBe("unverifiable");
    expect(classifyCloudRecoverySnapshot({ revision: 4 })).toBe("unverifiable");
    expect(classifyCloudRecoverySnapshot({ entityCount: 1.5, revision: 4 })).toBe("unverifiable");
    expect(classifyCloudRecoverySnapshot({ entityCount: -1, revision: 4 })).toBe("unverifiable");

    expect(isCloudRecoverySnapshotRestorable("complete")).toBe(true);
    expect(isCloudRecoverySnapshotRestorable("legacy-unverified")).toBe(true);
    expect(isCloudRecoverySnapshotRestorable("writing")).toBe(false);
    expect(isCloudRecoverySnapshotRestorable("unverifiable")).toBe(false);
    for (const status of ["complete", "writing", "legacy-unverified", "unverifiable"] as const) {
      expect(describeCloudRecoverySnapshotStatus(status).length).toBeGreaterThan(0);
    }
  });

  it("keeps the runtime entity-type list aligned with the protocol union", () => {
    expect(CLOUD_SNAPSHOT_ENTITY_TYPES.has("block")).toBe(true);
    expect(CLOUD_SNAPSHOT_ENTITY_TYPES.has("knowledge-library")).toBe(false);
    expect(CLOUD_SNAPSHOT_ENTITY_TYPES.size).toBeGreaterThan(20);
  });
});

describe("strict snapshot validation", () => {
  it("accepts a complete snapshot whose count matches", () => {
    const result = assertStrictCloudSnapshot({
      snapshotId: "s1",
      parent: parent({ entityCount: 2 }),
      documents: [
        entityDoc("block:one"),
        entityDoc("review-event:log-1", {
          entityType: undefined, entityId: undefined, deleted: undefined,
          payload: { id: "log-1" }, revision: 3,
        }),
      ],
    });
    expect(result).toMatchObject({ status: "complete", expectedCount: 2, revision: 4 });
    expect(result.entities.map((item) => item.key)).toEqual(["block:one"]);
    expect(result.reviewEvents.map((item) => item.id)).toEqual(["log-1"]);
  });

  it("rejects a count mismatch, a duplicate document and an unrecognised entity type", () => {
    expectRejected(
      () => assertStrictCloudSnapshot({ snapshotId: "s", parent: parent({ entityCount: 3 }), documents: [entityDoc("block:one")] }),
      /记录应有 3 项，实际读取到 1 项/,
    );
    expectRejected(
      () => assertStrictCloudSnapshot({ snapshotId: "s", parent: parent({ entityCount: 2 }), documents: [entityDoc("block:one"), entityDoc("block:one")] }),
      /重复/,
    );
    expectRejected(
      () => assertStrictCloudSnapshot({
        snapshotId: "s",
        parent: parent(),
        documents: [{ id: "knowledge-library:k1", data: () => ({ entityType: "knowledge-library", entityId: "k1", contentHash: "h", revision: 1, payload: { id: "k1" } }) }],
      }),
      /类型无法识别/,
    );
  });

  it("rejects a mismatched identity, a bad revision and contradictory payloads", () => {
    expectRejected(
      () => assertStrictCloudSnapshot({ snapshotId: "s", parent: parent(), documents: [entityDoc("block:one", { entityId: "two" })] }),
      /身份标识与类型不一致/,
    );
    expectRejected(
      () => assertStrictCloudSnapshot({ snapshotId: "s", parent: parent(), documents: [entityDoc("block:one", { revision: 1.5 })] }),
      /修订号非法/,
    );
    expectRejected(
      () => assertStrictCloudSnapshot({ snapshotId: "s", parent: parent(), documents: [entityDoc("block:one", { contentHash: "  " })] }),
      /缺少内容哈希/,
    );
    expectRejected(
      () => assertStrictCloudSnapshot({ snapshotId: "s", parent: parent(), documents: [entityDoc("block:one", { payload: {} })] }),
      /载荷为空/,
    );
    expectRejected(
      () => assertStrictCloudSnapshot({ snapshotId: "s", parent: parent(), documents: [entityDoc("block:one", { payload: { id: "other" } })] }),
      /载荷身份不一致/,
    );
    expectRejected(
      () => assertStrictCloudSnapshot({
        snapshotId: "s",
        parent: parent(),
        documents: [entityDoc("block:one", { deleted: true, payload: { id: "other" } })],
      }),
      /删除标记 .* 与载荷身份不一致/,
    );
  });

  it("allows a tombstone with an empty payload and a large-payload placeholder", () => {
    const result = assertStrictCloudSnapshot({
      snapshotId: "s",
      parent: parent({ entityCount: 2 }),
      documents: [
        { id: "block:gone", data: () => ({ entityType: "block", entityId: "gone", contentHash: "h", revision: 2, payload: {}, deleted: true }) },
        { id: "block:huge", data: () => ({ entityType: "block", entityId: "huge", contentHash: "h2", revision: 2, payload: {}, payloadDocumentHash: "doc-1", payloadByteSize: 1024 }) },
      ],
    });
    expect(result.entities.map((item) => item.key).sort()).toEqual(["block:gone", "block:huge"]);
  });

  it("rejects review events with a missing payload or revision", () => {
    expectRejected(
      () => assertStrictCloudSnapshot({
        snapshotId: "s",
        parent: parent(),
        documents: [{ id: "review-event:log-1", data: () => ({ contentHash: "h", revision: 1, payload: {} }) }],
      }),
      /复习事件 .* 缺少有效载荷/,
    );
    expectRejected(
      () => assertStrictCloudSnapshot({
        snapshotId: "s",
        parent: parent(),
        documents: [{ id: "review-event:log-1", data: () => ({ contentHash: "h", payload: { id: "log-1" } }) }],
      }),
      /复习事件 .* 的修订号非法/,
    );
  });

  it("refuses writing and unprovable snapshots before looking at any document", () => {
    expectRejected(
      () => assertStrictCloudSnapshot({ snapshotId: "s", parent: parent({ complete: false }), documents: [] }),
      /尚未完成写入/,
    );
    expectRejected(
      () => assertStrictCloudSnapshot({ snapshotId: "s", parent: { revision: 1 }, documents: [] }),
      /缺少可靠的完整性记录/,
    );
  });
});

describe("downloaded asset byte verification", () => {
  const bytes = (content: string, type = "image/png") => new Blob([content], { type });

  it("accepts a byte-identical object when the declared size and type agree", async () => {
    const blob = bytes("hello");
    await expect(assertDownloadedAssetVerified({
      hash: await hashBlob(blob),
      blob,
      label: "a.png",
      declaredSize: blob.size,
      declaredMimeType: "image/png",
    })).resolves.toBeUndefined();
  });

  it("rejects different bytes served from the correct address", async () => {
    const declared = bytes("hello");
    await expect(assertDownloadedAssetVerified({ hash: await hashBlob(declared), blob: bytes("hello!"), label: "a.png" }))
      .rejects.toThrow(/字节内容与声明不一致/);
  });

  it("rejects a truncated object even though the address exists", async () => {
    const declared = bytes("hello world");
    const truncated = new Blob(["hello"], { type: "image/png" });
    await expect(assertDownloadedAssetVerified({ hash: await hashBlob(declared), blob: truncated, label: "a.png" }))
      .rejects.toThrow(/字节内容与声明不一致/);
  });

  it("rejects a byte-identical object whose declared size or type contradicts it", async () => {
    const blob = bytes("hello");
    const hash = await hashBlob(blob);
    await expect(assertDownloadedAssetVerified({ hash, blob, label: "a.png", declaredSize: 4 }))
      .rejects.toThrow(/实际大小 5 字节与声明的 4 字节不一致/);
    await expect(assertDownloadedAssetVerified({ hash, blob: bytes("hello", "audio/mpeg"), label: "a.png", declaredMimeType: "image/png" }))
      .rejects.toThrow(/实际类型 audio\/mpeg 与声明的 image\/png 不一致/);
  });

  it("treats equivalent MIME spellings and the generic upload fallback as agreement", async () => {
    const jpg = bytes("hello", "image/jpeg");
    await expect(assertDownloadedAssetVerified({ hash: await hashBlob(jpg), blob: jpg, declaredMimeType: "image/jpg" }))
      .resolves.toBeUndefined();
    // A blob that had no type is uploaded as `application/octet-stream`; a transport that then
    // reports the concrete type is not a contradiction about the bytes, which already matched.
    const untyped = bytes("hello", "");
    await expect(assertDownloadedAssetVerified({
      hash: await hashBlob(untyped),
      blob: bytes("hello", "application/octet-stream"),
      declaredMimeType: "application/octet-stream",
    })).resolves.toBeUndefined();
    const unknown = bytes("hello", "audio/mpeg");
    await expect(assertDownloadedAssetVerified({ hash: await hashBlob(unknown), blob: unknown, declaredMimeType: "" }))
      .resolves.toBeUndefined();
  });

  it("MIME-A: a concrete declaration is not contradicted by a generic-fallback blob type", async () => {
    // The bytes already matched the hash. A transport that reports the generic upload fallback
    // carries no type information, so it cannot contradict a concrete declaration. The exemption
    // must be symmetric: it used to fire only when the *declared* side was the fallback, so a
    // byte-identical object whose blob type is `application/octet-stream` was wrongly rejected.
    const png = bytes("hello", "image/png");
    await expect(assertDownloadedAssetVerified({
      hash: await hashBlob(png),
      blob: bytes("hello", "application/octet-stream"),
      label: "a.png",
      declaredMimeType: "image/png",
    })).resolves.toBeUndefined();
  });

  it("rejects a hash declaration this client cannot reproduce instead of treating it as verified", async () => {
    const blob = bytes("hello");
    await expect(assertDownloadedAssetVerified({ hash: "legacy-fnv1a-hash", blob }))
      .rejects.toThrow(/不是本客户端可校验的格式/);
    await expect(assertDownloadedAssetVerified({ hash: "c092df87ad240efa9f032f792b57f5d3812a833b47de33172f59cf70ee2f01c4ff", blob }))
      .rejects.toThrow(/不是本客户端可校验的格式/);
    await expect(assertDownloadedAssetVerified({ hash: "", blob }))
      .rejects.toThrow(/不是本客户端可校验的格式/);
  });

  it("verifies a legacy asset document whose entity hash uses the old algorithm", async () => {
    // The blob address never changed: an old document's `contentHashAlgorithm: "fnv1a"` describes
    // how its entity payload was hashed, so it must not make a valid blob unverifiable.
    const blob = bytes("legacy-bytes", "image/png");
    await expect(assertDownloadedAssetVerified({
      hash: await hashBlob(blob),
      blob,
      label: "old.png",
      declaredSize: blob.size,
      declaredMimeType: "image/png",
    })).resolves.toBeUndefined();
  });
});

describe("strict active-dataset validation", () => {
  const datasetEntity = (key: string, overrides: Record<string, unknown> = {}) => ({
    key,
    entityType: key.split(":")[0],
    entityId: key.split(":").slice(1).join(":"),
    contentHash: "h",
    revision: 2,
    payload: { id: key.split(":").slice(1).join(":") },
    deleted: false,
    ...overrides,
  }) as never;

  it("accepts a well-formed dataset", () => {
    expect(() => assertStrictRemoteDataset({
      entities: [datasetEntity("block:one"), datasetEntity("block:two", { deleted: true, payload: {} })],
      reviewEvents: [{ id: "log-1", contentHash: "h", payload: { id: "log-1" }, revision: 2 }],
    })).not.toThrow();
  });

  it("rejects duplicates and identity contradictions", () => {
    expect(() => assertStrictRemoteDataset({ entities: [datasetEntity("block:one"), datasetEntity("block:one")], reviewEvents: [] }))
      .toThrow(/重复/);
    expect(() => assertStrictRemoteDataset({ entities: [datasetEntity("block:one", { payload: { id: "other" } })], reviewEvents: [] }))
      .toThrow(/载荷身份不一致/);
    expect(() => assertStrictRemoteDataset({
      entities: [],
      reviewEvents: [{ id: "log-1", contentHash: "h", payload: { id: "log-1" }, revision: 2 }, { id: "log-1", contentHash: "h", payload: { id: "log-1" }, revision: 2 }],
    })).toThrow(/重复/);
  });
});
