import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const pagesCss = readFileSync(join(process.cwd(), "src", "styles", "pages.css"), "utf8").replace(/\r\n/g, "\n");
const visualV2Css = readFileSync(join(process.cwd(), "src", "styles", "visual-v2.css"), "utf8").replace(/\r\n/g, "\n");
const baseCss = readFileSync(join(process.cwd(), "src", "styles.css"), "utf8").replace(/\r\n/g, "\n");

describe("font scale styles", () => {
  it("keeps the interface scale at the root and the body scale scoped to record content", () => {
    expect(baseCss).toContain("font-size: calc(16px * var(--font-scale, 1));");
    expect(baseCss).toContain("--editor-font-scale: 1;");
    expect(visualV2Css).toContain(".record-editor-page .rich-editor,\n.record-view-page .rich-editor {");
    expect(visualV2Css).toContain("font-size: calc(16px * var(--editor-font-scale, 1));");
    expect(pagesCss).toContain(".review-record-card .rich-editor {");
    expect(pagesCss).toContain("font-size: calc(clamp(16px, 1.3vw, 17.92px) * var(--editor-font-scale, 1));");
  });

  it("scales record code blocks with the body instead of the global root only", () => {
    expect(visualV2Css).toContain(".record-editor-page .rich-editor pre { max-width: 100%; overflow-x: auto; font-size: calc(12.8px * var(--editor-font-scale, 1)); }");
    expect(pagesCss).toContain(".review-record-card .rich-editor pre {");
    expect(pagesCss).toContain("font-size: calc(12.8px * var(--editor-font-scale, 1));");
  });
});
