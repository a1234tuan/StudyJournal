import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const themeCss = readFileSync(join(process.cwd(), "src", "styles", "theme.css"), "utf8");
const componentsCss = readFileSync(join(process.cwd(), "src", "styles", "components.css"), "utf8");

const cssBlockFor = (css: string, selector: string): string => {
  const escapedSelector = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = new RegExp(`${escapedSelector}\\s*\\{([\\s\\S]*?)\\}`).exec(css);
  if (!match) {
    throw new Error(`Missing CSS selector: ${selector}`);
  }
  return match[1];
};

describe("interaction feedback styles", () => {
  it("defines warm interaction and focus tokens for light and dark themes", () => {
    const requiredTokens = [
      "--color-interaction-hover:",
      "--color-interaction-pressed:",
      "--color-focus-ring:",
    ];

    for (const token of requiredTokens) {
      expect(cssBlockFor(themeCss, ":root")).toContain(token);
      expect(cssBlockFor(themeCss, ':root[data-theme="dark"]')).toContain(token);
    }
    expect(cssBlockFor(themeCss, ":root")).toContain("--focus-ring: var(--color-focus-ring)");
  });

  it("normalizes tap highlights and separates pointer focus from keyboard focus", () => {
    const tapHighlight = cssBlockFor(componentsCss, ':is(button, [role="button"], a, summary, label[for])');
    const pointerFocus = cssBlockFor(componentsCss, ':is(button, [role="button"], a, summary):focus:not(:focus-visible)');
    const keyboardFocus = cssBlockFor(componentsCss, ':is(button, [role="button"], a, summary):focus-visible');

    expect(tapHighlight).toContain("-webkit-tap-highlight-color: transparent");
    expect(pointerFocus).toContain("outline: none");
    expect(keyboardFocus).toContain("outline: 2px solid var(--color-focus-ring)");
  });

  it("uses a warm pressed state and avoids hardcoded blue in shared controls", () => {
    expect(componentsCss).toContain("--press-y: 1px;");
    expect(componentsCss).toContain("--press-scale: 0.985;");
    expect(componentsCss).toContain("background: var(--color-interaction-pressed);");
    expect(componentsCss).not.toContain("#2563eb");
    expect(componentsCss).not.toContain("#3b82f6");
  });
});
