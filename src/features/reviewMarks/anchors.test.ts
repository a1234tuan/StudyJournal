import { describe, it, expect } from "vitest";
import { anchorForText, captureMarkSelection, rangeForMark, resolveMarkAnchor, resolveTextAnchor } from "./anchors";

describe("semantic review anchors", () => {
  const text = "先理解概念，再掌握边界，最后做题。";
  const anchor = anchorForText(text, 6, 11);
  it("survives paragraph insertion and movement", () => {
    expect(resolveTextAnchor(["新插入的一段", text], anchor)).toEqual({ index: 1, start: 6, end: 11 });
  });
  it("never falls back to an old index on changed or removed text", () => {
    expect(resolveTextAnchor(["完全不同的段落"], anchor)).toBeNull();
    expect(resolveTextAnchor([text.replace(anchor.quote, "更改内容")], anchor)).toBeNull();
  });
  it("refuses duplicate paragraphs and repeated indistinguishable text", () => {
    expect(resolveTextAnchor([text, text], anchor)).toBeNull();
    const repeated = "啊".repeat(200);
    expect(resolveTextAnchor([repeated], anchorForText(repeated, 90, 92))).toBeNull();
  });
  it("relocates through distant edits but requires matching immediate context", () => {
    const long = "甲".repeat(90) + "唯一重点" + "乙".repeat(90);
    const mark = anchorForText(long, 90, 94);
    expect(resolveTextAnchor(["新开头" + long.slice(3)], mark)).not.toBeNull();
    expect(resolveTextAnchor([long.replace("唯一重点", "唯一要点")], mark)).toBeNull();
  });
  it("rejects empty and oversized selections", () => {
    expect(() => anchorForText("   ", 0, 2)).toThrow();
    expect(() => anchorForText("字".repeat(16001), 0, 16001)).toThrow();
  });
  it("anchors text across inline markup and reconstructs a DOM range", () => {
    const root = document.createElement("div"); root.innerHTML = '<div class="ProseMirror"><p>先理解<strong>概念</strong>再练习</p></div>';
    document.body.append(root);
    const range = document.createRange(); range.setStart(root.querySelector("p")!.firstChild!, 1); range.setEnd(root.querySelector("strong")!.firstChild!, 2);
    const selection = window.getSelection()!; selection.removeAllRanges(); selection.addRange(range);
    const captured = captureMarkSelection(root, selection)!;
    expect(captured.quote).toBe("理解概念");
    expect(rangeForMark(resolveMarkAnchor(root, captured)!)?.toString()).toBe("理解概念");
    root.remove(); selection.removeAllRanges();
  });
  it("rejects cross-paragraph selection instead of inventing coordinates", () => {
    const root = document.createElement("div"); root.innerHTML = '<div class="ProseMirror"><p>第一段</p><p>第二段</p></div>'; document.body.append(root);
    const range = document.createRange(); range.setStart(root.querySelectorAll("p")[0].firstChild!, 0); range.setEnd(root.querySelectorAll("p")[1].firstChild!, 2);
    const selection = window.getSelection()!; selection.removeAllRanges(); selection.addRange(range);
    expect(captureMarkSelection(root, selection)).toBeNull(); root.remove(); selection.removeAllRanges();
  });
});
