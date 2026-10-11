import { ActionableError } from "../../lib/uiError";
import type { ReviewMarkAnchor } from "./domain";

export interface ResolvedMarkAnchor { block: HTMLElement; start: number; end: number }
export const reviewTextBlocks = (root: HTMLElement): HTMLElement[] => Array.from(root.querySelectorAll<HTMLElement>(".ProseMirror > *")).filter(block => Boolean(block.textContent?.trim()));

export const anchorForText = (blockText: string, start: number, end: number): ReviewMarkAnchor => {
  const quote = blockText.slice(start, end);
  if (start < 0 || end > blockText.length || start >= end || !quote.trim() || quote.length > 16000 || blockText.length > 100000) throw new ActionableError("请在同一段落内选择适量文字后标记。");
  return { quote, blockText, prefix: blockText.slice(Math.max(0, start - 64), start), suffix: blockText.slice(end, end + 64) };
};

export const resolveTextAnchor = (texts: readonly string[], anchor: ReviewMarkAnchor): { index: number; start: number; end: number } | null => {
  const matches: { index: number; start: number; end: number }[] = [];
  texts.forEach((text, index) => {
    let start = text.indexOf(anchor.quote);
    while (start >= 0) {
      const end = start + anchor.quote.length;
      if (text.slice(Math.max(0, start - anchor.prefix.length), start) === anchor.prefix && text.slice(end, end + anchor.suffix.length) === anchor.suffix && (text === anchor.blockText || anchor.prefix.length + anchor.suffix.length > 0)) matches.push({ index, start, end });
      start = text.indexOf(anchor.quote, start + 1);
    }
  });
  return matches.length === 1 ? matches[0] : null;
};

export const resolveMarkAnchor = (root: HTMLElement, anchor: ReviewMarkAnchor): ResolvedMarkAnchor | null => {
  const blocks = reviewTextBlocks(root);
  const found = resolveTextAnchor(blocks.map(block => block.textContent ?? ""), anchor);
  return found ? { block: blocks[found.index], start: found.start, end: found.end } : null;
};

export const captureMarkSelection = (root: HTMLElement, selection: Selection | null): ReviewMarkAnchor | null => {
  if (!selection?.rangeCount || selection.isCollapsed) return null;
  const range = selection.getRangeAt(0);
  const block = reviewTextBlocks(root).find(node => node.contains(range.startContainer) && node.contains(range.endContainer));
  if (!block) return null;
  if (range.cloneContents().querySelector("img, video, audio, .katex, [contenteditable=false]")) return null;
  const before = document.createRange(); before.selectNodeContents(block); before.setEnd(range.startContainer, range.startOffset);
  const through = document.createRange(); through.selectNodeContents(block); through.setEnd(range.endContainer, range.endOffset);
  return anchorForText(block.textContent ?? "", before.toString().length, through.toString().length);
};

export const rangeForMark = ({ block, start, end }: ResolvedMarkAnchor): Range | null => {
  const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT);
  const range = document.createRange();
  let consumed = 0;
  let started = false;
  let text = walker.nextNode();
  while (text) {
    const length = text.textContent?.length ?? 0;
    if (!started && start < consumed + length) { range.setStart(text, start - consumed); started = true; }
    if (started && end <= consumed + length) { range.setEnd(text, end - consumed); return range; }
    consumed += length; text = walker.nextNode();
  }
  return null;
};
