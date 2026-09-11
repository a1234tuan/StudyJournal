import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ReviewAnnotationDraft, ReviewAnnotationTool } from "./domain";

const drafts = new Map<string, ReviewAnnotationDraft>();

vi.mock("./repository", () => ({
  reviewAnnotationRepository: {
    openDraft: vi.fn(async (draft: ReviewAnnotationDraft) => drafts.get(draft.id) ?? draft),
    getDraft: vi.fn(async (recordId: string, occurrenceKey: string) => drafts.get(`${recordId}:${occurrenceKey}`)),
    upsertDraft: vi.fn(async (draft: ReviewAnnotationDraft) => {
      drafts.set(`${draft.recordId}:${draft.reviewOccurrenceKey}`, draft);
    }),
    deleteDraft: vi.fn(async () => undefined),
    clearAfterRating: vi.fn(async () => undefined),
  },
}));

import { ReviewAnnotationSurface } from "./ReviewAnnotationSurface";

const draftFor = (recordId: string, occurrenceKey: string, kind: ReviewAnnotationTool = "pen"): ReviewAnnotationDraft => {
  const element = {
    id: "element-1",
    kind,
    points: [{ x: 0.1, y: 0.1 }, { x: 0.6, y: 0.6 }],
    anchorIndex: 0,
    anchorFingerprint: "P:hello",
    color: "#111827",
    width: 3,
    opacity: 1,
    value: kind === "select" ? "选项 1" : "批注内容",
    options: kind === "select" ? ["选项 1", "选项 2"] : undefined,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
  return {
    id: `${recordId}:${occurrenceKey}`,
    recordId,
    reviewOccurrenceKey: occurrenceKey,
    contentRevision: "rev-1",
    schemaVersion: 1,
    elements: [element],
    history: [[], [element]],
    historyCursor: 1,
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
};

const body = () => (
  <div className="ProseMirror">
    <p>hello</p>
  </div>
);

const rect = (left: number, top: number, width: number, height: number): DOMRect => ({
  x: left,
  y: top,
  left,
  top,
  width,
  height,
  right: left + width,
  bottom: top + height,
  toJSON: () => ({}),
});

const prepareGeometry = (container: HTMLElement) => {
  const root = container.querySelector<HTMLElement>(".review-annotation-root")!;
  const svg = container.querySelector<SVGSVGElement>(".review-annotation-svg")!;
  Object.defineProperty(svg, "setPointerCapture", { configurable: true, value: vi.fn() });
  return { root, svg };
};

describe("ReviewAnnotationSurface", () => {
  beforeEach(() => {
    drafts.clear();
    vi.clearAllMocks();
    Object.defineProperty(window, "PointerEvent", { configurable: true, value: MouseEvent });
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      if (this.classList.contains("review-annotation-root")) return rect(0, 0, 400, 300);
      if (this.tagName === "P") return rect(0, 0, 400, 200);
      return rect(0, 0, 0, 0);
    });
  });

  afterEach(() => vi.restoreAllMocks());

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

  it("selects, moves and resizes an existing graphic, then persists one state per gesture", async () => {
    drafts.set("record-a:key-a", draftFor("record-a", "key-a"));
    const { container } = render(
      <ReviewAnnotationSurface recordId="record-a" occurrenceKey="key-a" contentRevision="rev-1" open>{body()}</ReviewAnnotationSurface>,
    );
    await waitFor(() => expect(container.querySelector("polyline")).not.toBeNull());
    const { svg } = prepareGeometry(container);

    fireEvent.click(screen.getByRole("button", { name: "选择" }));
    fireEvent.pointerDown(svg, { clientX: 80, clientY: 50, pointerId: 1 });
    fireEvent.pointerMove(svg, { clientX: 120, clientY: 70, pointerId: 1 });
    fireEvent.pointerUp(svg, { pointerId: 1 });

    await waitFor(() => expect(drafts.get("record-a:key-a")?.elements[0].points[0].x).toBeCloseTo(0.2), { timeout: 750 });
    const moved = drafts.get("record-a:key-a")!;
    expect(moved.history).toHaveLength(3);

    const southeast = container.querySelector<SVGCircleElement>('[data-selection-handle="se"]')!;
    const startX = Number(southeast.getAttribute("cx"));
    const startY = Number(southeast.getAttribute("cy"));
    fireEvent.pointerDown(southeast, { clientX: startX, clientY: startY, pointerId: 2 });
    fireEvent.pointerMove(svg, { clientX: startX + 40, clientY: startY + 30, pointerId: 2 });
    fireEvent.pointerUp(svg, { pointerId: 2 });

    await waitFor(() => expect(drafts.get("record-a:key-a")?.history).toHaveLength(4), { timeout: 750 });
    const resized = drafts.get("record-a:key-a")!;
    expect(resized.elements[0].points[1].x - resized.elements[0].points[0].x).toBeGreaterThan(
      moved.elements[0].points[1].x - moved.elements[0].points[0].x,
    );
  });

  it.each(["text", "input", "select"] as const)("moves and resizes %s controls through the shared selection layer", async (kind) => {
    drafts.set("record-a:key-a", draftFor("record-a", "key-a", kind));
    const { container } = render(
      <ReviewAnnotationSurface recordId="record-a" occurrenceKey="key-a" contentRevision="rev-1" open>{body()}</ReviewAnnotationSurface>,
    );
    await waitFor(() => expect(container.querySelector(".review-annotation-control")).not.toBeNull());
    const { svg } = prepareGeometry(container);

    fireEvent.click(screen.getByRole("button", { name: "选择" }));
    expect(container.querySelector(".review-annotation-root")).toHaveClass("selecting");
    fireEvent.pointerDown(svg, { clientX: 80, clientY: 50, pointerId: 3 });
    fireEvent.pointerMove(svg, { clientX: 120, clientY: 70, pointerId: 3 });
    fireEvent.pointerUp(svg, { pointerId: 3 });

    await waitFor(() => expect(drafts.get("record-a:key-a")?.elements[0].points[0].x).toBeCloseTo(0.2), { timeout: 750 });
    const moved = drafts.get("record-a:key-a")!;
    const movedWidth = moved.elements[0].points[1].x - moved.elements[0].points[0].x;
    const movedHeight = moved.elements[0].points[1].y - moved.elements[0].points[0].y;

    const southeast = container.querySelector<SVGCircleElement>('[data-selection-handle="se"]')!;
    const startX = Number(southeast.getAttribute("cx"));
    const startY = Number(southeast.getAttribute("cy"));
    fireEvent.pointerDown(southeast, { clientX: startX, clientY: startY, pointerId: 4 });
    fireEvent.pointerMove(svg, { clientX: startX + 40, clientY: startY + 30, pointerId: 4 });
    fireEvent.pointerUp(svg, { pointerId: 4 });

    await waitFor(() => expect(drafts.get("record-a:key-a")?.history).toHaveLength(4), { timeout: 750 });
    const resized = drafts.get("record-a:key-a")!;
    expect(resized.elements[0].points[1].x - resized.elements[0].points[0].x).toBeGreaterThan(movedWidth);
    expect(resized.elements[0].points[1].y - resized.elements[0].points[0].y).toBeGreaterThan(movedHeight);
  });

  it("rolls an interrupted move back without persisting it", async () => {
    drafts.set("record-a:key-a", draftFor("record-a", "key-a"));
    const { container } = render(
      <ReviewAnnotationSurface recordId="record-a" occurrenceKey="key-a" contentRevision="rev-1" open>{body()}</ReviewAnnotationSurface>,
    );
    await waitFor(() => expect(container.querySelector("polyline")).not.toBeNull());
    const { svg } = prepareGeometry(container);
    const originalPoints = container.querySelector("polyline")!.getAttribute("points");

    fireEvent.click(screen.getByRole("button", { name: "选择" }));
    fireEvent.pointerDown(svg, { clientX: 80, clientY: 50, pointerId: 5 });
    fireEvent.pointerMove(svg, { clientX: 150, clientY: 90, pointerId: 5 });
    fireEvent.pointerCancel(svg, { pointerId: 5 });

    await waitFor(() => expect(container.querySelector("polyline")!.getAttribute("points")).toBe(originalPoints));
    expect(drafts.get("record-a:key-a")?.history).toHaveLength(2);
  });

  it("keeps form controls editable in browse mode", async () => {
    drafts.set("record-a:key-a", draftFor("record-a", "key-a", "input"));
    const { container } = render(
      <ReviewAnnotationSurface recordId="record-a" occurrenceKey="key-a" contentRevision="rev-1" open>{body()}</ReviewAnnotationSurface>,
    );
    await waitFor(() => expect(container.querySelector("textarea.review-annotation-control")).not.toBeNull());
    const control = container.querySelector<HTMLTextAreaElement>("textarea.review-annotation-control")!;
    fireEvent.change(control, { target: { value: "新的批注" } });
    await waitFor(() => expect(drafts.get("record-a:key-a")?.elements[0].value).toBe("新的批注"), { timeout: 750 });
  });
});
