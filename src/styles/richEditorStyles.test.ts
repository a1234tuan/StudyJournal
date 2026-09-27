import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const stylesCss = readFileSync(join(process.cwd(), "src", "styles.css"), "utf8").replace(/\r\n/g, "\n");

describe("rich editor styles", () => {
  it("keeps inline and block formula backgrounds transparent", () => {
    const inlineMathRule = /\.rich-editor \[data-node-view-wrapper\]\.record-inline-math \{([\s\S]*?)\n\}/.exec(stylesCss)?.[1] ?? "";
    const formulaPreviewRule = /\.formula-preview \{([\s\S]*?)\n\}/.exec(stylesCss)?.[1] ?? "";

    expect(inlineMathRule).toContain("background: transparent;");
    expect(formulaPreviewRule).toContain("background: transparent;");
  });

  it("keeps inline math node views inline despite the shared node-view layout rule", () => {
    expect(stylesCss).toContain(".rich-editor [data-node-view-wrapper],\n.rich-editor [data-node-view-content]");

    const inlineMathRule = /\.rich-editor \[data-node-view-wrapper\]\.record-inline-math \{([\s\S]*?)\n\}/.exec(stylesCss)?.[1] ?? "";
    expect(inlineMathRule).toContain("display: inline-flex;");
    expect(inlineMathRule).toContain("inline-size: auto;");
    expect(inlineMathRule).toContain("vertical-align: baseline;");
  });
});
