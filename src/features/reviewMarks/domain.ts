import { validStructuredAnchor, type StructuredMarkTarget } from "./structuredModel";
import type { BaseEntity } from "../../types";

export const markColors = ["amber", "green", "blue", "rose"] as const;
export const markKinds = ["highlight", "underline", "outline", "paragraph"] as const;
export type MarkColor = typeof markColors[number];
export type MarkKind = typeof markKinds[number];
export interface ReviewMarkAnchor { quote: string; prefix: string; suffix: string; blockText: string; structured?: StructuredMarkTarget }
export interface ReviewMarkValue { anchor: ReviewMarkAnchor; kind: MarkKind; color: MarkColor; label: string }
export interface ReviewMarkEvent extends BaseEntity { recordId: string; markId: string; parents: string[]; value: ReviewMarkValue | null }
export interface ReviewMarkProjection { markId: string; heads: ReviewMarkEvent[]; value: ReviewMarkValue | null; conflict: boolean }

export const projectReviewMarks = (events: readonly ReviewMarkEvent[]): ReviewMarkProjection[] => {
  const parents = new Set(events.flatMap(event => event.parents));
  const groups = new Map<string, ReviewMarkEvent[]>();
  for (const event of events) {
    if (parents.has(event.id)) continue;
    const heads = groups.get(event.markId) ?? [];
    heads.push(event); groups.set(event.markId, heads);
  }
  return [...groups].map(([markId, heads]) => {
    heads.sort((left, right) => left.id.localeCompare(right.id));
    const conflict = heads.length > 1;
    return { markId, heads, conflict, value: heads.some(head => head.value === null) ? null : heads[0].value };
  }).sort((left, right) => left.heads[0].createdAt.localeCompare(right.heads[0].createdAt) || left.markId.localeCompare(right.markId));
};

export const validateReviewMarkEvents = (events: unknown): void => {
  const invalid = (): never => { throw new Error("复习印记数据不完整或无效，未执行写入。"); };
  const idValid = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= 200;
  const timeValid = (value: unknown) => typeof value === "string" && Number.isFinite(Date.parse(value));
  if (!Array.isArray(events)) return invalid();
  const rows = new Map<string, ReviewMarkEvent>();
  const owners = new Map<string, string>();
  for (const event of events as ReviewMarkEvent[]) {
    if (!event || !idValid(event.id) || !idValid(event.recordId) || !idValid(event.markId) || rows.has(event.id) || !timeValid(event.createdAt) || event.updatedAt !== event.createdAt || event.deletedAt !== undefined || !Array.isArray(event.parents) || event.parents.length > 1000 || !event.parents.every(idValid) || new Set(event.parents).size !== event.parents.length) return invalid();
    if (event.value !== null) {
      const value = event.value;
      if (!value || !markColors.includes(value.color) || !markKinds.includes(value.kind) || typeof value.label !== "string" || value.label.length > 160) return invalid();
      const anchor = value.anchor;
      if (!anchor || typeof anchor.quote !== "string" || !anchor.quote.trim() || anchor.quote.length > 16000 || typeof anchor.blockText !== "string" || anchor.blockText.length > 100000 || typeof anchor.prefix !== "string" || anchor.prefix.length > 64 || typeof anchor.suffix !== "string" || anchor.suffix.length > 64) return invalid();
      if (anchor.structured !== undefined ? !validStructuredAnchor(anchor) : !anchor.blockText.includes(anchor.quote)) return invalid();
    }
    if (owners.has(event.markId) && owners.get(event.markId) !== event.recordId) return invalid();
    owners.set(event.markId, event.recordId);
    rows.set(event.id, event);
  }
  const children = new Map<string, string[]>();
  const remaining = new Map<string, number>();
  const ready: string[] = [];
  for (const event of rows.values()) {
    remaining.set(event.id, event.parents.length);
    if (!event.parents.length) ready.push(event.id);
    for (const parentId of event.parents) {
      const parent = rows.get(parentId);
      if (!parent || parent.recordId !== event.recordId || parent.markId !== event.markId) return invalid();
      const descendants = children.get(parentId) ?? [];
      descendants.push(event.id); children.set(parentId, descendants);
    }
  }
  for (let index = 0; index < ready.length; index += 1) {
    for (const child of children.get(ready[index]) ?? []) {
      const count = remaining.get(child)! - 1; remaining.set(child, count);
      if (!count) ready.push(child);
    }
  }
  if (ready.length !== rows.size) return invalid();
};

export const reviewMarksBackupVersion = (events: readonly ReviewMarkEvent[]): 7 | 8 | 9 => events.some(event => event.value?.anchor.structured) ? 9 : events.length ? 8 : 7;
