import { sha256 } from "@noble/hashes/sha256";
import { bytesToHex } from "@noble/hashes/utils";
import { KnowledgeError } from "./domain";

export const canonicalKnowledge = (value: unknown): string => {
  if (value === null || typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number" && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return "[" + value.map(canonicalKnowledge).join(",") + "]";
  if (typeof value === "object" && value && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)) {
    return "{" + Object.keys(value).sort().map(key => JSON.stringify(key) + ":" + canonicalKnowledge((value as Record<string, unknown>)[key])).join(",") + "}";
  }
  throw new KnowledgeError("invalid", "知识内容包含不支持的值");
};
export const knowledgeHash = (value: unknown): string => bytesToHex(sha256(new TextEncoder().encode(canonicalKnowledge(value))));
export const knowledgeBytes = (value: unknown): number => new TextEncoder().encode(canonicalKnowledge(value)).byteLength;
export const referenceIdentity = (nodeId: string, recordId: string): string => "ref-v1-" + knowledgeHash({ nodeId, recordId });
export const groupIdentity = (entityId: string, unit: string): string => "group-" + knowledgeHash({ entityId, unit });
export const revisionIdentity = (commandId: string, unit: string): string => commandId + ":" + unit;
