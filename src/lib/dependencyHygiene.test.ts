import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * F-22 guard.
 *
 * `recharts` and `idb-keyval` were declared but never imported. Removing a
 * dependency touches three places that must stay consistent:
 *
 *   1. `package.json` (the declaration)
 *   2. `package-lock.json` (the resolved tree)
 *   3. `vite.config.ts` -> `build.rollupOptions.output.manualChunks` (the bundle split)
 *
 * Dropping only (1) makes Rollup resolve a chunk entry that no longer exists, and
 * leaving it in (2) makes `npm ci` disagree with `package.json`. These assertions
 * fail loudly on any of those half-applied states.
 */

const ROOT = process.cwd();
const read = (name: string) => readFileSync(join(ROOT, name), "utf8");
const readJson = (name: string) => JSON.parse(read(name)) as Record<string, unknown>;

const pkg = readJson("package.json") as {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
};
const lock = readJson("package-lock.json") as { packages?: Record<string, unknown> };
const viteConfig = read("vite.config.ts");

const declaredDependencies = new Set([
  ...Object.keys(pkg.dependencies ?? {}),
  ...Object.keys(pkg.devDependencies ?? {}),
]);

/** module specifiers listed inside the `manualChunks` object literal */
const manualChunkModules = (): string[] => {
  const start = viteConfig.indexOf("manualChunks:");
  if (start === -1) {
    return [];
  }
  const open = viteConfig.indexOf("{", start);
  let depth = 0;
  let end = open;
  for (let index = open; index < viteConfig.length; index += 1) {
    if (viteConfig[index] === "{") {
      depth += 1;
    } else if (viteConfig[index] === "}") {
      depth -= 1;
      if (depth === 0) {
        end = index;
        break;
      }
    }
  }
  return [...viteConfig.slice(open, end + 1).matchAll(/"([^"]+)"/g)].map((match) => match[1]);
};

describe("dependency hygiene", () => {
  it("does not declare the dependencies that were removed as dead code", () => {
    expect(declaredDependencies.has("recharts")).toBe(false);
    expect(declaredDependencies.has("idb-keyval")).toBe(false);
  });

  it("does not keep the removed packages in the lockfile either", () => {
    expect(lock.packages?.["node_modules/recharts"]).toBeUndefined();
    expect(lock.packages?.["node_modules/idb-keyval"]).toBeUndefined();
  });

  it("keeps prosemirror-history, which is a real transitive dependency", () => {
    // Removing it would change how npm resolves prosemirror-menu's dependency.
    expect(declaredDependencies.has("prosemirror-history")).toBe(true);
    expect(lock.packages?.["node_modules/prosemirror-history"]).toBeDefined();
  });

  it("only splits chunks for modules that are both declared and installed", () => {
    const modules = manualChunkModules();
    expect(modules.length).toBeGreaterThan(0);

    for (const moduleName of modules) {
      expect(declaredDependencies.has(moduleName), `${moduleName} is not declared in package.json`).toBe(true);
      expect(
        existsSync(join(ROOT, "node_modules", moduleName, "package.json")),
        `${moduleName} is not installed, so Rollup cannot resolve the manual chunk`,
      ).toBe(true);
    }
  });
});
