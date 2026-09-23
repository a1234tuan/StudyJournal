import { hashBlob } from "./cloudSyncModel";

/**
 * The single definition of "these bytes are the object the declaration promised".
 *
 * Cloud downloads, zip archives and folder repositories all have to answer the same question, and
 * they must answer it identically — a check that is subtly stricter or looser in one path is worse
 * than no check, because it makes the other paths' guarantees unstatable. Each caller keeps its own
 * wording and error type; only the comparison lives here.
 *
 * The address is the only declaration of the hash format: `hashBlob` is SHA-256 over the bytes and
 * always produces lowercase hex, so a declared value in any other shape is a format this client
 * cannot reproduce and is a hard failure rather than a "cannot check, allow". Entity-level fields
 * such as `contentHashAlgorithm` describe the entity payload, not the blob, and are deliberately
 * not consulted here.
 */

/** `hashBlob` always emits lowercase SHA-256 hex; anything else is an unsupported declaration. */
export const SHA256_HEX_PATTERN = /^[0-9a-f]{64}$/;

/**
 * MIME types that mean the same thing in practice. Anything outside this table must match exactly;
 * an unrecognised declaration is never treated as "close enough".
 */
const MIME_ALIASES: Record<string, string> = {
  "image/jpg": "image/jpeg",
  "image/pjpeg": "image/jpeg",
  "application/x-zip-compressed": "application/zip",
  "application/zip-compressed": "application/zip",
};

/**
 * The type an upload gets when the source blob had none (`blob.type || "application/octet-stream"`).
 * It carries no information about the real content, so a declaration that says exactly this cannot
 * be contradicted by a transport that reports a concrete type.
 */
export const UNKNOWN_MIME_TYPE = "application/octet-stream";

export const normalizeMimeType = (value: unknown): string | undefined => {
  if (typeof value !== "string") return undefined;
  const essence = value.split(";")[0]?.trim().toLowerCase();
  if (!essence) return undefined;
  return MIME_ALIASES[essence] ?? essence;
};

const isByteCount = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

export type AssetByteFailure =
  /** The declared address is not a hash format this client can reproduce. */
  | { reason: "unsupported-hash"; declaredHash: string }
  /** The bytes hash to something else: wrong object, truncated object, or a broken writer. */
  | { reason: "hash"; declaredHash: string; actualHash: string }
  /** Byte-identical content whose separately declared size contradicts the bytes. */
  | { reason: "size"; declaredSize: number; actualSize: number }
  /** Byte-identical content whose separately declared type contradicts the bytes. */
  | { reason: "mime"; declaredMimeType: string; actualMimeType: string };

/**
 * Re-hash a blob and compare it with the declaration that pointed at it.
 *
 * Returns `undefined` when every declared fact agrees with the bytes. Size and MIME are checked as
 * separately declared facts: a hash-matching object whose declaration contradicts it is still a
 * metadata contract violation. The one deliberate exception is a byte-identical object where either
 * side's MIME is the generic upload fallback — that value means "no type known", so it cannot
 * contradict a concrete type on the other side. Only two concrete, differing types are a violation.
 */
export const assetByteFailure = async (params: {
  hash: string;
  blob: Blob;
  declaredSize?: unknown;
  declaredMimeType?: unknown;
}): Promise<AssetByteFailure | undefined> => {
  if (!SHA256_HEX_PATTERN.test(params.hash)) {
    return { reason: "unsupported-hash", declaredHash: params.hash };
  }
  const actualHash = await hashBlob(params.blob);
  if (actualHash !== params.hash) {
    return { reason: "hash", declaredHash: params.hash, actualHash };
  }
  if (isByteCount(params.declaredSize) && params.declaredSize !== params.blob.size) {
    return { reason: "size", declaredSize: params.declaredSize, actualSize: params.blob.size };
  }
  const declaredMimeType = normalizeMimeType(params.declaredMimeType);
  const actualMimeType = normalizeMimeType(params.blob.type);
  if (declaredMimeType && actualMimeType
    && declaredMimeType !== UNKNOWN_MIME_TYPE && actualMimeType !== UNKNOWN_MIME_TYPE
    && declaredMimeType !== actualMimeType) {
    return { reason: "mime", declaredMimeType, actualMimeType };
  }
  return undefined;
};

/**
 * The identity an integrity failure must carry, so the user is told *which* resource is broken
 * instead of a class-level message.
 */
export const describeAssetByteFailure = (
  name: string,
  failure: AssetByteFailure,
): string => {
  switch (failure.reason) {
    case "unsupported-hash":
      return `资源“${name}”的内容哈希 ${failure.declaredHash.slice(0, 16)}… 不是本客户端可校验的格式，无法验证其内容。`;
    case "hash":
      return `资源“${name}”的字节内容与声明不一致（声明 ${failure.declaredHash.slice(0, 12)}…，实际 ${failure.actualHash.slice(0, 12)}…）。`;
    case "size":
      return `资源“${name}”的实际大小 ${failure.actualSize} 字节与声明的 ${failure.declaredSize} 字节不一致。`;
    case "mime":
      return `资源“${name}”的实际类型 ${failure.actualMimeType} 与声明的 ${failure.declaredMimeType} 不一致。`;
  }
};
