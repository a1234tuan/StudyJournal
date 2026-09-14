import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * F-03 guard.
 *
 * The behavioural coverage lives in `AiKnowledgeScopePicker.test.tsx` (local-day
 * default under a UTC+8 clock). This file is the site-level guard: the defect was
 * six scattered call sites, so a per-site assertion is the only thing that stops
 * the UTC slice from being reintroduced in five places while the sixth stays fixed.
 */

const SRC_ROOT = join(process.cwd(), "src");

const sourceFiles = (dir: string): string[] =>
  readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      return sourceFiles(full);
    }
    return /\.tsx?$/.test(entry) ? [full] : [];
  });

const read = (relativePath: string) => readFileSync(join(SRC_ROOT, relativePath), "utf8");

/**
 * Tencent Cloud signature dates are defined in UTC ("Date" in the v3 signing
 * algorithm), so this helper is the one place the UTC slice is correct.
 * `src/lib/date.ts` intentionally contains the literal only inside this list's
 * counterpart, `todayISO`, which formats with the local calendar.
 */
const UTC_SLICE_ALLOWED = [join("lib", "tencentSigning.ts")];

const UTC_DATE_SLICE = /toISOString\(\)\s*\.\s*slice\(0,\s*10\)/;

/** The three files that resolve an AI knowledge scope against "today". */
const SCOPE_SITES = [
  join("components", "AiKnowledgeScopePicker.tsx"),
  join("pages", "KnowledgePodcastPage.tsx"),
  join("features", "voiceRecall", "VoiceRecallWorkspace.tsx"),
];

describe("local-date contract", () => {
  it("keeps the raw UTC date slice out of every module except the Tencent signature helper", () => {
    const offenders = sourceFiles(SRC_ROOT)
      .filter((file) => !file.endsWith(".test.ts") && !file.endsWith(".test.tsx"))
      .filter((file) => UTC_DATE_SLICE.test(readFileSync(file, "utf8")))
      .map((file) => relative(SRC_ROOT, file));

    expect(offenders).toEqual(UTC_SLICE_ALLOWED);
  });

  it("still uses the UTC slice where the signing contract requires it", () => {
    const signing = read(join("lib", "tencentSigning.ts"));
    expect(signing).toMatch(UTC_DATE_SLICE);
  });

  it("resolves every AI knowledge scope date from the local day helper", () => {
    for (const site of SCOPE_SITES) {
      const source = read(site);
      expect(source, `${site} should call todayISO()`).toContain("todayISO(");
      // `new Date().toISOString()` for `updatedAt` stamps is fine; deriving a
      // calendar day from it is not.
      expect(source, `${site} must not derive a day from a UTC timestamp`).not.toMatch(UTC_DATE_SLICE);
    }
  });

  it("keeps todayISO on the local calendar day", () => {
    const dateLib = read(join("lib", "date.ts"));
    expect(dateLib).toMatch(/export const todayISO[\s\S]{0,120}format\(new Date\(\), "yyyy-MM-dd"\)/);
    expect(dateLib.split("export const todayISO")[1]?.split("export const")[0]).not.toMatch(/toISOString/);
  });
});
