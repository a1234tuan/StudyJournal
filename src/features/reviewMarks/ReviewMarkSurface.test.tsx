import "fake-indexeddb/auto";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "../../db/database";
import type { RecordBlock } from "../../types";
import { ReviewMarkSurface } from "./ReviewMarkSurface";
import { projectReviewMarks } from "./domain";
import { markTestEvent, markTestStamp, markTestValue } from "./fixtures";
import { reviewMarkRepository } from "./repository";
import { pendingReviewNavigation } from "../reviewSession/navigationGuard";
vi.mock("../../services/autoBackupService", () => ({ markAutoBackupDirty: vi.fn() }));
const record: RecordBlock = { id: "mark-record", type: "record", date: "2026-10-11", title: "印记", subject: "数学", contentHtml: "<p>这里需要巩固的内容</p>", assets: [], tags: [], mistakeRefs: [], formulas: [], order: 0, createdAt: markTestStamp, updatedAt: markTestStamp };
const body = <div className="ProseMirror"><p>这里需要巩固的内容</p><p>已经学会的背景知识</p></div>;
const mount = (enabled = true, open = true) => render(<ReviewMarkSurface recordId={record.id} contentRevision={markTestStamp} enabled={enabled} open={open} onOpenChange={() => undefined}>{body}</ReviewMarkSurface>);
const selectText = () => {
  const paragraph = document.querySelector(".ProseMirror p")!;
  const range = document.createRange(); range.setStart(paragraph.firstChild!, 2); range.setEnd(paragraph.firstChild!, 6);
  const selection = window.getSelection()!; selection.removeAllRanges(); selection.addRange(range); fireEvent(document, new Event("selectionchange"));
};
const count = async (expected: number) => waitFor(async () => expect(await db.reviewMarkEvents.count()).toBe(expected));
beforeEach(async () => {
  await db.open(); await db.blocks.put(record);
  Object.defineProperty(Range.prototype, "getClientRects", { configurable: true, value: () => [new DOMRect(10, 20, 100, 24)] });
  Object.defineProperty(HTMLElement.prototype, "scrollIntoView", { configurable: true, value: vi.fn() });
});
afterEach(async () => { cleanup(); vi.restoreAllMocks(); await db.delete(); });

describe("permanent review-only surface", () => {
  it("does not add tools or marks outside ordinary review", async () => {
    await db.reviewMarkEvents.put(markTestEvent()); const view = mount(false);
    expect(screen.queryByRole("button", { name: "永久复习印记" })).not.toBeInTheDocument();
    expect(view.container.querySelector(".review-mark-paint")).toBeNull();
    expect(view.container.querySelector(".ProseMirror")?.textContent).toContain("需要巩固");
  });
  it("renders stored marks while closed and leaves original content intact", async () => {
    await db.reviewMarkEvents.put(markTestEvent()); const view = mount(true, false);
    await waitFor(() => expect(view.container.querySelectorAll("[data-mark-id]")).toHaveLength(1));
    expect(screen.queryByRole("region", { name: "印记工具" })).not.toBeInTheDocument();
    expect(view.container.querySelector(".ProseMirror")?.innerHTML).toBe("<p>这里需要巩固的内容</p><p>已经学会的背景知识</p>");
  });
  it("adds, restyles, erases and repeatedly undoes without changing the source", async () => {
    mount(); selectText();
    await waitFor(() => expect(screen.getByRole("button", { name: "标记选中文字" })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: "标记选中文字" })); await count(1);
    fireEvent.click(screen.getByRole("button", { name: "重点列表" }));
    fireEvent.click(screen.getByRole("button", { name: "蓝色印记" }));
    fireEvent.click(screen.getByRole("button", { name: "更新印记样式" })); await count(2);
    expect(projectReviewMarks(await db.reviewMarkEvents.toArray())[0].value?.color).toBe("blue");
    fireEvent.click(screen.getByRole("button", { name: "擦除印记" })); await count(3);
    expect(projectReviewMarks(await db.reviewMarkEvents.toArray())[0].value).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "撤销印记" })); await count(4);
    fireEvent.keyDown(window, { key: "z", ctrlKey: true }); await count(5);
    expect(projectReviewMarks(await db.reviewMarkEvents.toArray())[0].value?.color).toBe("amber");
    fireEvent.click(screen.getByRole("button", { name: "撤销印记" })); await count(6);
    expect(projectReviewMarks(await db.reviewMarkEvents.toArray())[0].value).toBeNull();
    expect(await db.blocks.get(record.id)).toEqual(record);
  });
  it("keeps unresolved marks discoverable rather than drawing on another paragraph", async () => {
    await db.reviewMarkEvents.put(markTestEvent("missing", [], { ...markTestValue, anchor: { quote: "原来的内容", blockText: "原来的内容", prefix: "", suffix: "" } }));
    const view = mount(); fireEvent.click(screen.getByRole("button", { name: "重点列表" }));
    await screen.findByText(/原文变化或重复/);
    expect(view.container.querySelectorAll("[data-mark-id]")).toHaveLength(0);
    fireEvent.click(screen.getByRole("button", { name: /待重新定位/ })); selectText();
    fireEvent.click(screen.getByRole("button", { name: "移到所选文字" })); await count(2);
    await waitFor(() => expect(view.container.querySelectorAll("[data-mark-id]")).toHaveLength(1));
  });
  it("exposes erase/edit conflicts for explicit confirmation", async () => {
    await db.reviewMarkEvents.bulkPut([markTestEvent(), markTestEvent("erase", ["mark-event"], null), markTestEvent("edit", ["mark-event"], { ...markTestValue, color: "blue" })]);
    const view = mount(); fireEvent.click(screen.getByRole("button", { name: "重点列表" }));
    fireEvent.click(await screen.findByRole("button", { name: /存在并发修改/ }));
    expect(view.container.querySelectorAll("[data-mark-id]")).toHaveLength(0);
    fireEvent.click(screen.getByRole("button", { name: /保留版本 1/ })); await count(4);
    expect(projectReviewMarks(await db.reviewMarkEvents.toArray())[0]).toMatchObject({ conflict: false, value: { color: "blue" } });
  });
  it("navigates in document order rather than mark creation order", async () => {
    const first = markTestEvent("first", [], { ...markTestValue, anchor: { quote: "背景知识", blockText: "已经学会的背景知识", prefix: "已经学会的", suffix: "" } });
    const second = { ...markTestEvent("second"), markId: "second-mark" };
    await db.reviewMarkEvents.bulkPut([first, second]); mount();
    const next = screen.getByRole("button", { name: "下一处印记" });
    await waitFor(() => expect(next).toBeEnabled()); fireEvent.click(next);
    await waitFor(() => expect(document.querySelector('[data-mark-id="second-mark"]')).toHaveAttribute("data-active", "true"));
    fireEvent.click(next);
    await waitFor(() => expect(document.querySelector('[data-mark-id="mark"]')).toHaveAttribute("data-active", "true"));
  });
  it("reports write failures without fake highlights and supports retry", async () => {
    vi.spyOn(reviewMarkRepository, "write").mockRejectedValueOnce(new Error("storage unavailable"));
    const view = mount(); selectText(); const save = screen.getByRole("button", { name: "标记选中文字" });
    await waitFor(() => expect(save).toBeEnabled()); fireEvent.click(save);
    await screen.findByRole("alert");
    expect(await db.reviewMarkEvents.count()).toBe(0); expect(view.container.querySelectorAll("[data-mark-id]")).toHaveLength(0);
    await waitFor(() => expect(save).toBeEnabled()); fireEvent.click(save); await count(1);
  });
  it("waits for in-flight persistence at the review navigation guard", async () => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const original = reviewMarkRepository.write.bind(reviewMarkRepository);
    vi.spyOn(reviewMarkRepository, "write").mockImplementation(async (...args) => { await gate; return original(...args); });
    mount(); selectText(); await waitFor(() => expect(screen.getByRole("button", { name: "标记选中文字" })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: "标记选中文字" }));
    const navigation = pendingReviewNavigation(); expect(navigation).toBeInstanceOf(Promise);
    expect(await db.reviewMarkEvents.count()).toBe(0);
    await act(async () => { release(); await navigation; }); await count(1);
  });
});
