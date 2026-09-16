/**
 * Ref-counted registry of "this record has a draft flush in flight".
 *
 * Why this exists at all: the record editor persists drafts on detached paths -
 * an autosave debounce, tab hide, unmount, and the back handler, because
 * returning must never wait on storage. That is the right call for the editor,
 * but it creates a window where "there is no draft row on disk" does not mean
 * "the user wrote nothing" - it means "the write has not landed yet". Anything
 * that deletes empty records has to be able to see that window and wait it out.
 *
 * Why a count rather than a boolean: flushes for one record can overlap (the
 * back handler's flush and the unmount cleanup's flush, for example). A plain
 * flag would be cleared by whichever one settled first, reopening the window
 * while the second was still writing. Acquire/release pairs survive any
 * interleaving, and the record is only reported as settled once the count
 * returns to zero.
 *
 * Treat it as acquire/release, never as set/clear: an unmatched release is
 * ignored rather than pushing the count negative, so a double release cannot
 * resurrect a pending state.
 */
export interface DraftFlushTracker {
  /** A flush has started for this record. */
  acquire(recordId: string): void;
  /** A flush has settled for this record. Returns true when none remain. */
  release(recordId: string): boolean;
  /** Every record with at least one flush still in flight, in first-acquire order. */
  pendingRecordIds(): string[];
  isPending(recordId: string): boolean;
}

export const createDraftFlushTracker = (): DraftFlushTracker => {
  const counts = new Map<string, number>();
  return {
    acquire(recordId) {
      counts.set(recordId, (counts.get(recordId) ?? 0) + 1);
    },
    release(recordId) {
      const next = (counts.get(recordId) ?? 0) - 1;
      if (next > 0) {
        counts.set(recordId, next);
        return false;
      }
      counts.delete(recordId);
      return true;
    },
    pendingRecordIds() {
      return [...counts.keys()];
    },
    isPending(recordId) {
      return counts.has(recordId);
    },
  };
};
