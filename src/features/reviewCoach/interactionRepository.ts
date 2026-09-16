import type { StudyJournalDatabase } from "../../db/database";
import { db } from "../../db/database";
import {
  REVIEW_COACH_INTERACTION_RETENTION_DAYS,
  expiredInteractionSegmentIds,
  rollupInteractionSegments,
  type InteractionRollup,
  type ReviewCoachInteractionSegmentLocal,
} from "./interactionTrace";

/**
 * Device-local persistence for interaction segments.
 *
 * This repository deliberately only touches `reviewCoachInteractionSegments`.
 * It is NOT registered in `reviewCoachFormalTables`, so nothing written here can
 * reach the portable backup, record transfer, cloud sync or knowledge export.
 */
export class ReviewCoachInteractionRepository {
  constructor(private readonly database: StudyJournalDatabase = db) {}

  async append(segments: readonly ReviewCoachInteractionSegmentLocal[]): Promise<void> {
    if (segments.length === 0) return;
    await this.database.reviewCoachInteractionSegments.bulkPut(segments.map((segment) => structuredClone(segment)));
  }

  async listForTask(taskId: string): Promise<ReviewCoachInteractionSegmentLocal[]> {
    return this.database.reviewCoachInteractionSegments.where("taskId").equals(taskId).sortBy("endedAt");
  }

  async listSince(isoFrom: string): Promise<ReviewCoachInteractionSegmentLocal[]> {
    return this.database.reviewCoachInteractionSegments
      .filter((segment) => segment.endedAt >= isoFrom)
      .toArray();
  }

  async rollup(since: string): Promise<InteractionRollup> {
    return rollupInteractionSegments(await this.listSince(since));
  }

  /** Deletes segments past the retention window. Returns the deleted ids. */
  async pruneExpired(now = Date.now()): Promise<string[]> {
    const all = await this.database.reviewCoachInteractionSegments.toArray();
    const expired = expiredInteractionSegmentIds(all, now);
    if (expired.length > 0) {
      await this.database.reviewCoachInteractionSegments.bulkDelete(expired);
    }
    return expired;
  }

  /** Local-only escape hatch used by development reports and tests. */
  async clearAll(): Promise<void> {
    await this.database.reviewCoachInteractionSegments.clear();
  }
}

export const reviewCoachInteractionRetentionDays = REVIEW_COACH_INTERACTION_RETENTION_DAYS;
export const reviewCoachInteractionRepository = new ReviewCoachInteractionRepository();
