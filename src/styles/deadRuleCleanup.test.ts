import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * F-21 guard.
 *
 * Two full `.review-evaluation-*` rule blocks were dead (the audit reported only the
 * first one at `:458`; a later override block at `:3683` was also unreferenced). The
 * `legacy-`-prefixed and `record-`/`inline-indicator` variants are still rendered by
 * `ReviewPage` and `RecordEditorPage`, so a blind "delete every review-evaluation
 * rule" cleanup would break them.
 */

const css = readFileSync(join(process.cwd(), "src", "styles", "pages.css"), "utf8");

/** Selectors with no remaining TSX/TS consumer. */
const REMOVED_SELECTORS = [
  ".review-evaluation-panel",
  ".review-evaluation-toggle",
  ".review-evaluation-body",
  ".review-evaluation-state",
  ".review-evaluation-history",
];

/** Selectors that are still rendered and must survive the cleanup. */
const RETAINED_SELECTORS = [
  ".record-review-evaluation",
  ".review-evaluation-inline-indicator",
  ".legacy-review-evaluation-history",
];

describe("review-evaluation stylesheet cleanup", () => {
  it("does not resurrect the removed rule blocks", () => {
    for (const selector of REMOVED_SELECTORS) {
      expect(css, `${selector} has no consumer and should stay deleted`).not.toContain(selector);
    }
  });

  it("keeps the selectors that are still rendered", () => {
    for (const selector of RETAINED_SELECTORS) {
      expect(css, `${selector} is still used and must stay defined`).toContain(selector);
    }
  });

  it("keeps the stylesheet balanced after the line-range deletion", () => {
    const open = (css.match(/\{/g) ?? []).length;
    const close = (css.match(/\}/g) ?? []).length;
    expect(open).toBeGreaterThan(0);
    expect(open).toBe(close);
  });

  it("keeps the shared rule that pairs a dead selector with a live one", () => {
    // `.review-evaluation-history p` was deleted but `.record-review-evaluation` in
    // the same selector list is live, so the declaration block itself must remain.
    const shared = /\.record-review-evaluation\s*\{[\s\S]{0,200}?white-space:\s*pre-wrap/;
    expect(css).toMatch(shared);
  });
});
