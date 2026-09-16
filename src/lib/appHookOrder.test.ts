import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * `App.tsx` renders a loading screen and returns early until the local database
 * has initialized. React therefore sees two different hook sequences - the
 * loading one, and the real one - unless every hook stays above that guard.
 *
 * Getting this wrong does not fail type-checking, and no unit test mounts the
 * whole App, so the only visible symptom is a blank window with a
 * "change in the order of Hooks" error in the console. That is exactly what
 * happened when a `useMemo` was added next to the render helpers further down
 * the file, which is why this guard exists.
 *
 * The check is textual on purpose: installing a lint stack for one rule is not
 * worth it, and a false negative here is loud (the app does not render) while a
 * false positive is cheap to fix by moving a hook up.
 */

const APP_SOURCE = resolve(__dirname, "..", "App.tsx");

/** React's own hooks plus this codebase's custom hooks, e.g. `useKeyboardVisible`. */
const HOOK_CALL = /\buse[A-Z][A-Za-z0-9]*\s*\(/;

/** The initialization guard: everything after it is conditional. */
const GUARD = "if (!app.initialized || !app.settings)";

describe("App hook order", () => {
  it("keeps every hook call above the initialization guard", () => {
    const lines = readFileSync(APP_SOURCE, "utf8").split(/\r?\n/);
    const guardIndex = lines.findIndex((line) => line.includes(GUARD));

    expect(guardIndex, `${GUARD} not found in App.tsx`).toBeGreaterThan(-1);

    const offenders = lines
      .map((line, index) => ({ line: index + 1, text: line.replace(/\/\/.*$/, "").trim() }))
      .filter((entry) => entry.line > guardIndex + 1 && HOOK_CALL.test(entry.text));

    expect(offenders).toEqual([]);
  });
});
