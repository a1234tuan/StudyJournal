import { render, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ReviewAnnotationDraft } from "./domain";

const drafts = new Map<string, ReviewAnnotationDraft>();

vi.mock("./repository", () => ({
  reviewAnnotationRepository: {
    getDraft: vi.fn(async (recordId: string, occurrenceKey: string) => drafts.get(`${recordId}:${occurrenceKey}`)),
    upsertDraft: vi.fn(async (draft: ReviewAnnotationDraft) => {
      drafts.set(`${draft.recordId}:${draft.reviewOccurrenceKey}`, draft);
    }),
    deleteDraft: vi.fn(async () => undefined),
    clearAfterRating: vi.fn(async () => undefined),
  },
}));

import { ReviewAnnotationSurface } from "./ReviewAnnotationSurface";

const draftFor = (recordId: string, occurrenceKey: string): ReviewAnnotationDraft => ({
  id: `${recordId}:${occurrenceKey}`,
  recordId,
  reviewOccurrenceKey: occurrenceKey,
  contentRevision: "rev-1",
  schemaVersion: 1,
  elements: [{
    id: "element-1",
    kind: "pen",
    points: [{ x: 0.1, y: 0.1 }, { x: 0.6, y: 0.6 }],
    anchorIndex: 0,
    anchorFingerprint: "P:hello",
    color: "#111827",
    width: 3,
    opacity: 1,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  }],
  history: [[]],
  historyCursor: 0,
  updatedAt: "2026-01-01T00:00:00.000Z",
});

const body = () => (
  <div className="ProseMirror">
    <p>hello</p>
  </div>
);

describe("ReviewAnnotationSurface", () => {
  beforeEach(() => {
    drafts.clear();
  });

  it("re-seats the draft when the reviewed card changes instead of leaking the previous card's strokes", async () => {
    drafts.set("record-a:key-a", draftFor("record-a", "key-a"));
    const { container, rerender } = render(
      <ReviewAnnotationSurface recordId="record-a" occurrenceKey="key-a" contentRevision="rev-1">{body()}</ReviewAnnotationSurface>,
    );
    await waitFor(() => expect(container.querySelector("polyline")).not.toBeNull());

    rerender(
      <ReviewAnnotationSurface recordId="record-b" occurrenceKey="key-b" contentRevision="rev-1">{body()}</ReviewAnnotationSurface>,
    );

    await waitFor(() => expect(container.querySelector("polyline")).toBeNull());
    expect(container.querySelector("polyline")).toBeNull();
  });

  it("loads the saved draft when returning to a card that has one", async () => {
    drafts.set("record-a:key-a", draftFor("record-a", "key-a"));
    const { container, rerender } = render(
      <ReviewAnnotationSurface recordId="record-b" occurrenceKey="key-b" contentRevision="rev-1">{body()}</ReviewAnnotationSurface>,
    );
    await waitFor(() => expect(container.querySelector("polyline")).toBeNull());

    rerender(
      <ReviewAnnotationSurface recordId="record-a" occurrenceKey="key-a" contentRevision="rev-1">{body()}</ReviewAnnotationSurface>,
    );
    await waitFor(() => expect(container.querySelector("polyline")).not.toBeNull());
  });
});
