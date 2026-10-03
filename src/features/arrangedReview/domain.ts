import type { BaseEntity, RecordReviewRating } from "../../types";

export interface ArrangedReviewItem { recordId: string; title: string; source: string; contentRevision: string }
export interface ArrangedReview extends BaseEntity { title: string; items: ArrangedReviewItem[]; endedAt?: string }
export interface ArrangedReviewEvent extends BaseEntity { roundId: string; recordId: string; parents: string[]; rating: RecordReviewRating | null; contentRevision: string }
export interface ArrangedReviewDraft { id: string; contentRevision: string; comments: Record<string, { comment: string; includeInAnalysis: boolean }>; updatedAt: string }
export const arrangedRatings = [{ value: "forgot", label: "忘记了" }, { value: "fuzzy", label: "模糊" }, { value: "good", label: "良好" }, { value: "easy", label: "轻松" }] as const;
export const reviewEventHeads = (events: readonly ArrangedReviewEvent[], roundId: string, recordId: string) => {
  const relevant = events.filter(event => event.roundId === roundId && event.recordId === recordId && !event.deletedAt);
  const parents = new Set(relevant.flatMap(event => event.parents));
  return relevant.filter(event => !parents.has(event.id)).sort((left, right) => left.id.localeCompare(right.id));
};
export const arrangedItemStatus = (events: readonly ArrangedReviewEvent[], roundId: string, recordId: string) => {
  const heads = reviewEventHeads(events, roundId, recordId);
  return { heads, conflict: heads.length > 1, rating: heads.length === 1 ? heads[0].rating : null };
};
export const validateArrangedReviews = (rounds: readonly ArrangedReview[], events: readonly ArrangedReviewEvent[]) => {
  const invalid = () => { throw new Error("复习数据无效，未执行恢复。"); };
  const validId = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0;
  const validTime = (value: unknown) => typeof value === "string" && Number.isFinite(Date.parse(value));
  const validBase = (value: BaseEntity) => value && validId(value.id) && validTime(value.createdAt) && validTime(value.updatedAt) && (value.deletedAt === undefined || validTime(value.deletedAt));
  if (!Array.isArray(rounds) || !Array.isArray(events)) return invalid();
  const memberships = new Map<string, Set<string>>();
  for (const round of rounds) {
    if (!validBase(round) || memberships.has(round.id) || typeof round.title !== "string" || (round.endedAt !== undefined && !validTime(round.endedAt)) || !Array.isArray(round.items) || !round.items.length) return invalid();
    const members = new Set<string>();
    for (const item of round.items) {
      if (!item || !validId(item.recordId) || members.has(item.recordId) || typeof item.title !== "string" || typeof item.source !== "string" || typeof item.contentRevision !== "string") return invalid();
      members.add(item.recordId);
    }
    memberships.set(round.id, members);
  }
  const eventMap = new Map<string, ArrangedReviewEvent>();
  for (const event of events) {
    if (!validBase(event) || eventMap.has(event.id) || !memberships.get(event.roundId)?.has(event.recordId) || !Array.isArray(event.parents) || new Set(event.parents).size !== event.parents.length || !event.parents.every(validId) || typeof event.contentRevision !== "string" || (event.rating !== null && !arrangedRatings.some(rating => rating.value === event.rating))) return invalid();
    eventMap.set(event.id, event);
  }
  const children = new Map<string, string[]>();
  const remaining = new Map<string, number>();
  const ready: string[] = [];
  for (const event of events) {
    remaining.set(event.id, event.parents.length);
    if (!event.parents.length) ready.push(event.id);
    for (const parent of event.parents) {
      const target = eventMap.get(parent);
      if (!target || target.roundId !== event.roundId || target.recordId !== event.recordId) return invalid();
      const descendants = children.get(parent) ?? [];
      descendants.push(event.id); children.set(parent, descendants);
    }
  }
  for (let index = 0; index < ready.length; index += 1) {
    for (const child of children.get(ready[index]) ?? []) {
      const count = remaining.get(child)! - 1; remaining.set(child, count);
      if (!count) ready.push(child);
    }
  }
  if (ready.length !== events.length) return invalid();
};
