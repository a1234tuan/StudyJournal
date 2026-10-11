import { afterEach, describe, expect, it, vi } from "vitest";
import { anchorForText, captureMarkSelection, rectanglesForMark, resolveMarkAnchor } from "./anchors";
import { anchorForObject, readStructuredBlock, resolveStructuredAnchor } from "./structuredAnchors";
import { validStructuredAnchor } from "./structuredModel";
import { validateReviewMarkEvents } from "./domain";
import { markTestEvent, markTestValue } from "./fixtures";

const inline = '<span class="node-recordInlineMath" contenteditable="false"><span class="record-inline-math" contenteditable="false" data-latex="x^2"><span class="katex"><span>渲染符号</span><math><mtext>重复符号</mtext></math></span></span></span>';
const setup = (html: string) => { const root = document.createElement("div"); root.innerHTML = '<div class="ProseMirror">' + html + '</div>'; document.body.append(root); return root; };
const capture = (root: HTMLElement, from: Node, start: number, to: Node, end: number) => {
  const range = document.createRange(); range.setStart(from, start); range.setEnd(to, end);
  const selection = window.getSelection()!; selection.removeAllRanges(); selection.addRange(range);
  return captureMarkSelection(root, selection);
};
afterEach(() => { document.body.innerHTML = ""; window.getSelection()?.removeAllRanges(); vi.restoreAllMocks(); });

describe("source-based formula and code anchors", () => {
  it("captures text and a terminal formula despite the editor separator image", () => {
    const root = setup('<p>求下列极限：' + inline + '<img class="ProseMirror-separator" alt=""><br class="ProseMirror-trailingBreak"></p>');
    const paragraph = root.querySelector("p")!;
    const glyph = root.querySelector(".katex > span")!.firstChild!;
    const anchor = capture(root, paragraph.firstChild!, 1, glyph, 2)!;
    expect(anchor.quote).toBe("下列极限：$x^2$");
    expect(anchor.structured?.target).toBe("range");
    expect(() => validateReviewMarkEvents([markTestEvent("terminal-mixed", [], { ...markTestValue, anchor })])).not.toThrow();
    expect(anchorForObject(root, root.querySelector<HTMLElement>(".record-inline-math")!)?.quote).toBe("$x^2$");
    paragraph.querySelector(".ProseMirror-separator")!.remove();
    expect(resolveMarkAnchor(root, anchor)?.block).toBe(paragraph);
  });
  it("keeps existing trailing-break anchors and rejects actual images", () => {
    const root = setup('<p>求极限：' + inline + '<br class="ProseMirror-trailingBreak"></p>');
    const formula = root.querySelector<HTMLElement>(".record-inline-math")!;
    const anchor = anchorForObject(root, formula)!;
    const paragraph = root.querySelector("p")!;
    paragraph.insertAdjacentHTML("beforeend", '<img class="ProseMirror-separator" alt="">');
    expect(resolveMarkAnchor(root, anchor)?.block).toBe(paragraph);
    paragraph.insertAdjacentHTML("beforeend", '<img src="real.png" alt="题图">');
    expect(readStructuredBlock(paragraph)).toBeNull();
    expect(resolveMarkAnchor(root, anchor)).toBeNull();
  });
  it("selects an entire inline formula using LaTeX, not KaTeX text", () => {
    const root = setup('<p>公式' + inline + '结论</p>'); const formula = root.querySelector<HTMLElement>(".record-inline-math")!;
    const anchor = anchorForObject(root, formula)!;
    expect(anchor.quote).toBe("$x^2$"); expect(anchor.structured).toMatchObject({ target: "formula", start: 2, end: 3 });
    expect(anchor.blockText).not.toContain("渲染符号"); expect(validStructuredAnchor(anchor)).toBe(true);
    formula.innerHTML = '<span>尚未排版</span>';
    expect(resolveMarkAnchor(root, anchor)).not.toBeNull();
  });
  it("expands a selection inside generated formula descendants to the complete formula", () => {
    const root = setup('<p>前文' + inline + '后文</p>'); const glyph = root.querySelector(".katex > span")!.firstChild!;
    const anchor = capture(root, glyph, 1, glyph, 2)!;
    expect(anchor.quote).toBe("$x^2$"); expect(anchor.structured?.target).toBe("formula");
  });
  it("captures text plus inline formulas as one semantic range", () => {
    const root = setup('<p>前文' + inline + '后文</p>'); const paragraph = root.querySelector("p")!;
    const anchor = capture(root, paragraph.firstChild!, 1, paragraph.lastChild!, 1)!;
    expect(anchor.quote).toBe("文$x^2$后"); expect(anchor.structured?.target).toBe("range");
    expect(() => validateReviewMarkEvents([markTestEvent("mixed", [], { ...markTestValue, anchor })])).not.toThrow();
  });
  it("accepts native whole-block selections with endpoints outside the atom", () => {
    const root = setup('<div class="node-recordFormula" contenteditable="false"><div class="formula-editor-card" contenteditable="false" data-latex="a+b"><strong>标题</strong><span>渲染内容</span></div></div>');
    const editor = root.querySelector(".ProseMirror")!;
    expect(capture(root, editor, 0, editor, 1)?.quote).toBe("$a+b$");
  });
  it("relocates unchanged formula blocks after insertion and refuses changed source", () => {
    const root = setup('<div class="formula-editor-card" data-latex="a+b">ab</div>'); const formula = root.querySelector<HTMLElement>(".formula-editor-card")!;
    const anchor = anchorForObject(root, formula)!; root.querySelector(".ProseMirror")!.prepend(document.createElement("p"));
    expect(resolveMarkAnchor(root, anchor)?.block).toBe(formula);
    formula.dataset.latex = "a-b"; expect(resolveMarkAnchor(root, anchor)).toBeNull();
  });
  it("uses context for repeated blocks but refuses indistinguishable locations", () => {
    const formula = '<div class="formula-editor-card" data-latex="a">a</div>';
    const root = setup('<p>第一组</p>' + formula + '<p>第二组</p>' + formula + '<p>结束</p>');
    const second = root.querySelectorAll<HTMLElement>(".formula-editor-card")[1];
    expect(resolveMarkAnchor(root, anchorForObject(root, second)!)?.block).toBe(second);
    root.querySelector(".ProseMirror")!.innerHTML = formula.repeat(4);
    expect(() => anchorForObject(root, root.querySelectorAll<HTMLElement>(".formula-editor-card")[1])).toThrow("重复");
  });
  it("anchors multi-line code through changing syntax-highlight spans", () => {
    const root = setup('<pre><code><span>const</span> value = 1;\n  return value;</code></pre>'); const code = root.querySelector("code")!;
    const anchor = capture(root, code.firstChild!.firstChild!, 0, code.lastChild!, code.lastChild!.textContent!.length)!;
    expect(anchor.quote).toContain("\n  return"); expect(anchor.structured?.target).toBe("range");
    const text = code.textContent!; code.innerHTML = ""; code.textContent = text;
    expect(resolveMarkAnchor(root, anchor)).not.toBeNull();
  });
  it("marks whole code independently of HTML syntax styling", () => {
    const root = setup('<pre><code>if (value) {\n  return 1;\n}</code></pre>'); const code = root.querySelector<HTMLElement>("pre")!;
    const anchor = anchorForObject(root, code)!;
    expect(anchor.structured?.target).toBe("code"); expect(anchor.quote).toBe(code.textContent);
    const source = readStructuredBlock(code)!; expect(source.source.kind).toBe("code");
    code.querySelector("code")!.textContent += " changed"; expect(resolveMarkAnchor(root, anchor)).toBeNull();
  });
  it("does not confuse formula LaTeX with literal code or text", () => {
    const root = setup('<p>' + inline + '</p><pre><code>$x^2$</code></pre>');
    const formula = root.querySelector<HTMLElement>(".record-inline-math")!; const anchor = anchorForObject(root, formula)!;
    formula.closest("p")!.remove(); expect(resolveMarkAnchor(root, anchor)).toBeNull();
  });
  it("keeps legacy text marks readable without upgrading their payload", () => {
    const root = setup('<p>这里需要巩固的内容</p>'); const anchor = anchorForText("这里需要巩固的内容", 2, 6);
    expect(anchor.structured).toBeUndefined(); expect(resolveMarkAnchor(root, anchor)?.start).toBe(2);
  });
  it("does not capture mixed unsupported images or cross-block content", () => {
    const root = setup('<p>前文' + inline + '<img src="x"/>后文</p><p>下一段</p>'); const paragraph = root.querySelector("p")!;
    expect(() => capture(root, paragraph.firstChild!, 0, paragraph.lastChild!, 2)).toThrow("暂不支持");
    expect(capture(root, paragraph.firstChild!, 0, root.querySelectorAll("p")[1].firstChild!, 1)).toBeNull();
  });
  it.each(["version", "offset", "source", "quote", "target"])("rejects malformed structured %s", key => {
    const root = setup('<pre><code>code</code></pre>'); const anchor = anchorForObject(root, root.querySelector("pre")!)!;
    if (key === "version") anchor.structured!.version = 2 as 1;
    if (key === "offset") anchor.structured!.end = 999;
    if (key === "source") anchor.blockText = "not-json";
    if (key === "quote") anchor.quote = "different";
    if (key === "target") anchor.structured!.target = "formula";
    expect(validStructuredAnchor(anchor)).toBe(false);
    expect(() => validateReviewMarkEvents([markTestEvent("bad", [], { ...markTestValue, anchor })])).toThrow("印记");
  });
  it("clips code range paint to its horizontal scrolling viewport", () => {
    const root = setup('<pre style="overflow-x:auto"><code>const example = longCode;</code></pre>'); const code = root.querySelector<HTMLElement>("pre")!;
    const text = code.querySelector("code")!.firstChild!; const anchor = capture(root, text, 0, text, 10)!;
    Object.defineProperty(code, "clientWidth", { configurable: true, value: 100 });
    vi.spyOn(code, "getBoundingClientRect").mockReturnValue(new DOMRect(20, 10, 100, 40));
    Object.defineProperty(Range.prototype, "getClientRects", { configurable: true, value: () => [new DOMRect(-20, 15, 180, 20)] });
    const rects = rectanglesForMark(root, resolveMarkAnchor(root, anchor)!, false);
    expect(rects).toHaveLength(1); expect(rects[0].left).toBe(20); expect(rects[0].right).toBe(120);
  });
});
