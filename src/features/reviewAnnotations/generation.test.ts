import "fake-indexeddb/auto";
import { afterEach, expect, it } from "vitest";
import { db } from "../../db/database";
import type { ReviewAnnotationDraft } from "./domain";
import { reviewAnnotationRepository as repository } from "./repository";

const recordId = "annotation-generation-test";
const empty = (): ReviewAnnotationDraft => ({ id: recordId + ":occurrence", recordId, reviewOccurrenceKey: "occurrence", contentRevision: "revision", schemaVersion: 1, elements: [], history: [[]], historyCursor: 0, updatedAt: "2026-09-09T00:00:00.000Z" });
afterEach(async () => { await db.reviewAnnotationDrafts.delete(empty().id); });

it("rejects both tabs' old saves after rating and permits a fresh empty draft after undo", async () => {
  const tabOne = await repository.openDraft(empty());
  const tabTwo = await repository.openDraft(empty());
  await repository.clearAfterRating(recordId, "occurrence");
  expect(await repository.upsertDraft(tabOne)).toBe(false);
  expect(await repository.upsertDraft(tabTwo)).toBe(false);
  const reopened = await repository.openDraft(empty());
  expect(reopened.elements).toEqual([]);
  expect(reopened.writeGeneration).toBe(1);
  expect(await repository.upsertDraft({ ...reopened, historyCursor: 0 })).toBe(true);
  expect(await repository.upsertDraft(tabOne)).toBe(false);
  expect((await repository.getDraft(recordId, "occurrence"))?.writeGeneration).toBe(1);
});
it("retains the rating barrier across database reopen", async () => {
  const stale = await repository.openDraft(empty());
  await repository.clearAfterRating(recordId, "occurrence");
  db.close();
  await db.open();
  expect(await repository.upsertDraft(stale)).toBe(false);
  const marker = await repository.getDraft(recordId, "occurrence");
  expect(marker?.pendingClear).toBe(true);
  expect(marker?.elements).toEqual([]);
});

it("rejects an old content revision after opening the new revision", async () => {
  const old = await repository.openDraft(empty());
  const current = await repository.openDraft({ ...empty(), contentRevision: "new" });
  expect(current.writeGeneration).toBe(1);
  expect(await repository.upsertDraft(old)).toBe(false);
});
