import type { ReviewMarkAnchor } from "./domain";

export type MarkSourcePart = ["text" | "inline-formula" | "block-formula" | "break", string];
export interface MarkSource { kind: "content" | "code"; parts: MarkSourcePart[] }
export interface StructuredMarkTarget { version: 1; target: "range" | "formula" | "code"; start: number; end: number; before: string; after: string }
export const sourcePartLength = (part: MarkSourcePart) => part[0] === "text" ? part[1].length : 1;
export const sourceLength = (source: MarkSource) => source.parts.reduce((total, part) => total + sourcePartLength(part), 0);
export const sourcePreview = (source: MarkSource, start: number, end: number): string => {
  let position = 0;
  return source.parts.map(part => {
    const from = Math.max(0, start - position); const to = Math.min(sourcePartLength(part), end - position);
    position += sourcePartLength(part);
    if (from >= to) return "";
    return part[0] === "text" ? part[1].slice(from, to) : part[0] === "break" ? "\n" : "$" + part[1] + "$";
  }).join("");
};
export const validStructuredAnchor = (anchor: ReviewMarkAnchor): boolean => {
  const target = anchor.structured;
  if (!target || target.version !== 1 || !["range", "formula", "code"].includes(target.target) || !Number.isInteger(target.start) || !Number.isInteger(target.end) || target.start < 0 || target.start >= target.end || typeof target.before !== "string" || target.before.length > 512 || typeof target.after !== "string" || target.after.length > 512 || anchor.prefix !== "" || anchor.suffix !== "") return false;
  try {
    const source = JSON.parse(anchor.blockText) as MarkSource;
    if (!source || !["content", "code"].includes(source.kind) || !Array.isArray(source.parts) || !source.parts.length || source.parts.length > 16000) return false;
    for (const part of source.parts) {
      if (!Array.isArray(part) || part.length !== 2 || !["text", "inline-formula", "block-formula", "break"].includes(part[0]) || typeof part[1] !== "string") return false;
      if (part[0] === "break" ? part[1] !== "" : !part[1].length) return false;
      if (source.kind === "code" && part[0] !== "text" && part[0] !== "break") return false;
    }
    const length = sourceLength(source);
    if (target.end > length || sourcePreview(source, target.start, target.end) !== anchor.quote) return false;
    if (target.target === "code" && (source.kind !== "code" || target.start !== 0 || target.end !== length)) return false;
    if (target.target === "formula") {
      let position = 0;
      const matched = source.parts.some(part => {
        const start = position; position += sourcePartLength(part);
        return part[0].endsWith("formula") && start === target.start && position === target.end;
      });
      if (!matched) return false;
    }
    return true;
  } catch { return false; }
};
