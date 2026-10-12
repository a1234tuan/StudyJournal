import type { RecordBlock } from "../types";
import { normalizeRecordTags, recordTagKey } from "./recordTags";
import type { KnowledgeOwner } from "../features/knowledgeLibrary/domain";

export type JournalScope = { kind: "all" } | { kind: "tag"; tag: string } | { kind: "topic"; owner: KnowledgeOwner; libraryId: string; workspaceId: string };
export interface JournalTopic {
  owner: KnowledgeOwner;
  libraryId: string;
  workspaceId: string;
  title: string;
  libraryTitle: string;
  recordIds: ReadonlySet<string>;
}

const collator = new Intl.Collator("zh-CN-u-co-pinyin", { numeric: true, sensitivity: "base" });
export const compareJournalLabels = (left: string, right: string): number => collator.compare(left, right) || left.localeCompare(right);

export const restoreJournalScope = (value: unknown): JournalScope => {
  if (!value || typeof value !== "object") return { kind: "all" };
  const scope = value as Record<string, unknown>;
  if (scope.kind === "tag" && typeof scope.tag === "string" && scope.tag.trim()) return { kind: "tag", tag: recordTagKey(scope.tag) };
  if (scope.kind === "topic" && typeof scope.owner === "string" && (scope.owner === "deviceGuest" || /^account:.+/.test(scope.owner)) && typeof scope.libraryId === "string" && scope.libraryId && typeof scope.workspaceId === "string" && scope.workspaceId) {
    return { kind: "topic", owner: scope.owner as KnowledgeOwner, libraryId: scope.libraryId, workspaceId: scope.workspaceId };
  }
  return { kind: "all" };
};

export const journalTags = (records: readonly RecordBlock[]): Array<{ key: string; label: string }> => {
  const tags = new Map<string, string>();
  for (const record of records) {
    if (record.deletedAt) continue;
    for (const tag of normalizeRecordTags(record.tags)) if (!tags.has(recordTagKey(tag))) tags.set(recordTagKey(tag), tag);
  }
  return Array.from(tags, ([key, label]) => ({ key, label })).sort((left, right) => compareJournalLabels(left.label, right.label));
};

export const selectedJournalTopic = (topics: readonly JournalTopic[], scope: JournalScope): JournalTopic | undefined => scope.kind === "topic"
  ? topics.find(topic => topic.owner === scope.owner && topic.libraryId === scope.libraryId && topic.workspaceId === scope.workspaceId)
  : undefined;

export const filterJournalRecords = (records: readonly RecordBlock[], subject: string, scope: JournalScope, topics: readonly JournalTopic[]): RecordBlock[] => {
  const topic = selectedJournalTopic(topics, scope);
  return records.filter(record => !record.deletedAt && (subject === "全部" || record.subject === subject)
    && (scope.kind === "all" || (scope.kind === "tag" ? normalizeRecordTags(record.tags).some(tag => recordTagKey(tag) === recordTagKey(scope.tag)) : !!topic?.recordIds.has(record.id))))
    .sort((left, right) => right.date.localeCompare(left.date) || right.updatedAt.localeCompare(left.updatedAt));
};
