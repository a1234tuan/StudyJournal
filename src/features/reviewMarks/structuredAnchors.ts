import { ActionableError } from "../../lib/uiError";
import type { ReviewMarkAnchor } from "./domain";
import { sourceLength, sourcePreview, validStructuredAnchor, type MarkSource, type MarkSourcePart, type StructuredMarkTarget } from "./structuredModel";

export const formulaSelector = ".record-inline-math[data-latex], .formula-editor-card[data-latex]";
export const markObjectSelector = formulaSelector + ", pre";
export interface SourceUnit { node: Node; start: number; end: number; atomic: boolean }
export interface StructuredBlock { block: HTMLElement; source: MarkSource; serialized: string; units: SourceUnit[] }
export interface StructuredResolution { block: HTMLElement; start: number; end: number; units: SourceUnit[]; target: StructuredMarkTarget["target"] }
export const sourceBlocks = (root: HTMLElement) => Array.from(root.querySelectorAll<HTMLElement>(".ProseMirror > *"));

export const readStructuredBlock = (block: HTMLElement): StructuredBlock | null => {
  const source: MarkSource = { kind: block.matches("pre") ? "code" : "content", parts: [] };
  const units: SourceUnit[] = [];
  let position = 0; let unsupported = false;
  const append = (part: MarkSourcePart, node: Node, atomic: boolean) => {
    if (part[0] === "text" && !part[1]) return;
    const length = part[0] === "text" ? part[1].length : 1;
    const last = source.parts.at(-1);
    if (part[0] === "text" && last?.[0] === "text") last[1] += part[1];
    else source.parts.push(part);
    units.push({ node, start: position, end: position + length, atomic }); position += length;
  };
  const visit = (node: Node) => {
    if (node.nodeType === Node.TEXT_NODE) { append(["text", node.textContent ?? ""], node, false); return; }
    if (!(node instanceof HTMLElement)) { if (node instanceof Element) unsupported = true; return; }
    if (node.matches("img.ProseMirror-separator")) return;
    if (node.matches(formulaSelector)) {
      const latex = node.getAttribute("data-latex") ?? "";
      if (!latex.trim()) { unsupported = true; return; }
      append([node.matches(".record-inline-math") ? "inline-formula" : "block-formula", latex], node, true); return;
    }
    if (node.matches("br")) { append(["break", ""], node, true); return; }
    if (node.matches(".node-recordInlineMath, .node-recordFormula")) { node.childNodes.forEach(visit); return; }
    if (node.matches("img, video, audio, table, button, input, textarea, select, [contenteditable=false]")) { unsupported = true; return; }
    node.childNodes.forEach(visit);
  };
  visit(block);
  const serialized = JSON.stringify(source);
  return unsupported || !units.length || serialized.length > 100000 ? null : { block, source, serialized, units };
};
const context = (block: HTMLElement | undefined) => {
  if (!block) return "";
  const text = readStructuredBlock(block)?.serialized ?? (block.textContent ?? "");
  return text.length > 256 ? text.slice(0, 128) + text.slice(-128) : text;
};
export const makeStructuredAnchor = (root: HTMLElement, source: StructuredBlock, start: number, end: number, target: StructuredMarkTarget["target"]): ReviewMarkAnchor => {
  const blocks = sourceBlocks(root); const index = blocks.indexOf(source.block);
  const anchor: ReviewMarkAnchor = { quote: sourcePreview(source.source, start, end), blockText: source.serialized, prefix: "", suffix: "", structured: { version: 1, target, start, end, before: context(blocks[index - 1]), after: context(blocks[index + 1]) } };
  if (!anchor.quote.trim() || anchor.quote.length > 16000 || !validStructuredAnchor(anchor)) throw new ActionableError("所选内容过长或暂不支持，请缩小选区。");
  if (!resolveStructuredAnchor(root, anchor)) throw new ActionableError("此内容与其他位置重复，无法可靠定位；请连同前后文字选择。");
  return anchor;
};
export const resolveStructuredAnchor = (root: HTMLElement, anchor: ReviewMarkAnchor): StructuredResolution | null => {
  if (!validStructuredAnchor(anchor)) return null;
  const target = anchor.structured!; const blocks = sourceBlocks(root);
  let candidates = blocks.map((block, index) => ({ source: readStructuredBlock(block), index })).filter(item => item.source?.serialized === anchor.blockText);
  if (candidates.length > 1) candidates = candidates.filter(item => context(blocks[item.index - 1]) === target.before && context(blocks[item.index + 1]) === target.after);
  if (candidates.length !== 1) return null;
  const source = candidates[0].source!;
  return { block: source.block, start: target.start, end: target.end, units: source.units, target: target.target };
};
export const anchorForObject = (root: HTMLElement, element: HTMLElement): ReviewMarkAnchor | null => {
  const block = sourceBlocks(root).find(node => node === element || node.contains(element));
  const source = block && readStructuredBlock(block);
  if (!source) return null;
  if (element.matches("pre") && block === element) return makeStructuredAnchor(root, source, 0, sourceLength(source.source), "code");
  const unit = source.units.find(item => item.node === element && item.atomic);
  return unit ? makeStructuredAnchor(root, source, unit.start, unit.end, "formula") : null;
};
export const captureStructuredRange = (root: HTMLElement, block: HTMLElement, range: Range): ReviewMarkAnchor | null => {
  const source = readStructuredBlock(block);
  if (!source) throw new ActionableError("这个选区含暂不支持的内容。可先单独选择公式、代码或文字。");
  const selected: { start: number; end: number }[] = [];
  for (const unit of source.units) {
    if (!range.intersectsNode(unit.node)) continue;
    if (unit.atomic) { selected.push({ start: unit.start, end: unit.end }); continue; }
    const length = unit.end - unit.start;
    if (range.comparePoint(unit.node, 0) === 1 || range.comparePoint(unit.node, length) === -1) continue;
    const start = range.startContainer === unit.node ? range.startOffset : 0;
    const end = range.endContainer === unit.node ? range.endOffset : length;
    if (start < end) selected.push({ start: unit.start + start, end: unit.start + end });
  }
  if (!selected.length) return null;
  const start = selected[0].start; const end = selected.at(-1)!.end;
  const unit = source.units.find(item => item.start === start && item.end === end && item.atomic && item.node instanceof HTMLElement && item.node.matches(formulaSelector));
  return makeStructuredAnchor(root, source, start, end, unit ? "formula" : "range");
};

export const clipMarkRect = (rect: DOMRect, element: HTMLElement, root: HTMLElement): DOMRect | null => {
  let left = rect.left; let right = rect.right; let top = rect.top; let bottom = rect.bottom;
  for (let parent: HTMLElement | null = element; parent && parent !== root; parent = parent.parentElement) {
    const style = getComputedStyle(parent); const bounds = parent.getBoundingClientRect();
    if (/(auto|scroll|hidden|clip)/.test(style.overflowX)) { left = Math.max(left, bounds.left + parent.clientLeft); right = Math.min(right, bounds.left + parent.clientLeft + parent.clientWidth); }
    if (/(auto|scroll|hidden|clip)/.test(style.overflowY)) { top = Math.max(top, bounds.top + parent.clientTop); bottom = Math.min(bottom, bounds.top + parent.clientTop + parent.clientHeight); }
  }
  return right > left && bottom > top ? new DOMRect(left, top, right - left, bottom - top) : null;
};
export const structuredRects = (root: HTMLElement, anchor: StructuredResolution, paragraph: boolean): DOMRect[] => {
  if (anchor.target === "code" || (paragraph && anchor.target !== "formula")) {
    const clipped = clipMarkRect(anchor.block.getBoundingClientRect(), anchor.block.parentElement ?? anchor.block, root);
    return clipped ? [clipped] : [];
  }
  const result: DOMRect[] = [];
  for (const unit of anchor.units) {
    const start = Math.max(unit.start, anchor.start); const end = Math.min(unit.end, anchor.end);
    if (start >= end) continue;
    const parent = unit.node instanceof HTMLElement ? unit.node : unit.node.parentElement!;
    let rects: DOMRect[];
    if (unit.atomic) rects = Array.from((unit.node as HTMLElement).getClientRects());
    else {
      const range = document.createRange(); range.setStart(unit.node, start - unit.start); range.setEnd(unit.node, end - unit.start);
      rects = Array.from(range.getClientRects());
    }
    for (const rect of rects) { const clipped = clipMarkRect(rect, unit.atomic ? parent.parentElement ?? parent : parent, root); if (clipped) result.push(clipped); }
  }
  const merged: DOMRect[] = [];
  for (const rect of result) {
    const previous = merged.at(-1);
    if (previous && Math.abs(previous.top - rect.top) < .5 && Math.abs(previous.height - rect.height) < .5 && rect.left >= previous.left && rect.left <= previous.right + 1) merged[merged.length - 1] = new DOMRect(previous.left, previous.top, Math.max(previous.right, rect.right) - previous.left, previous.height);
    else merged.push(rect);
  }
  return merged;
};
