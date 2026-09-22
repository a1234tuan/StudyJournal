import type { BackupPayload } from "../../types";
import { knowledgeHash } from "./canonical";
import { KnowledgeError } from "./domain";
import { validateKnowledgeEnvelope } from "./backup";

export const KNOWLEDGE_PAYLOAD_ENTRY = "snapshot-v7.json";
export interface KnowledgeContainer { format: "study-journal-container"; version: 7; payloadEntry: "snapshot-v7.json"; checksum: string; knowledgeScope: "current-identity-local-libraries" | "selected-libraries"; journalScope: "device-local" }
export const containerForPayload = (payload: BackupPayload & { assets?: unknown[] }): KnowledgeContainer => {
  const knowledge = validateKnowledgeEnvelope(payload.knowledge);
  return { format: "study-journal-container", version: 7, payloadEntry: KNOWLEDGE_PAYLOAD_ENTRY, checksum: knowledgeHash(JSON.parse(JSON.stringify(payload))), knowledgeScope: knowledge.scope, journalScope: "device-local" };
};
export const validateBackupPayloadVersion = (payload: BackupPayload): void => {
  if (!payload?.manifest || !["study-journal", "408-study-journal"].includes(payload.manifest.format) || ![1, 2, 3, 4, 5, 6, 7].includes(payload.manifest.version)) throw new KnowledgeError("invalid", "备份格式或版本不兼容");
  if (payload.manifest.version === 7) validateKnowledgeEnvelope(payload.knowledge);
  else if (Object.hasOwn(payload, "knowledge")) throw new KnowledgeError("invalid", "旧格式不能携带未经校验的知识内容");
};
export const validateBackupContainer = (container: unknown, payload: BackupPayload): void => {
  validateBackupPayloadVersion(payload);
  if (payload.manifest.version !== 7) throw new KnowledgeError("invalid", "新版容器载荷版本不一致");
  if (knowledgeHash(container) !== knowledgeHash(containerForPayload(payload))) throw new KnowledgeError("invalid", "备份外层范围或校验和不一致");
};
