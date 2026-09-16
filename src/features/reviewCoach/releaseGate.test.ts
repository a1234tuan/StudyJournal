import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  PRODUCTION_V2_ENABLED,
  REVIEW_COACH_V2_INTERNAL_MODE,
  assertReviewCoachV2Enabled,
  isReviewCoachV2Enabled,
  resolveReviewCoachV2,
  v2EnabledModes,
} from "./releaseGate";

const read = (relativePath: string) => readFileSync(join(process.cwd(), relativePath), "utf8");

describe("releaseGate", () => {
  it("opens only for the internal review-coach-v2 mode", () => {
    expect(resolveReviewCoachV2({ mode: REVIEW_COACH_V2_INTERNAL_MODE })).toBe(true);
    expect(resolveReviewCoachV2({ mode: "development" })).toBe(false);
    expect(resolveReviewCoachV2({ mode: "test" })).toBe(false);
    expect(resolveReviewCoachV2({ mode: "production" })).toBe(false);
    expect(resolveReviewCoachV2({ mode: "" })).toBe(false);
  });

  it("cannot be opened in production until the versioned source constant flips", () => {
    expect(PRODUCTION_V2_ENABLED).toBe(false);
    expect(resolveReviewCoachV2({ mode: "production", productionV2Enabled: true })).toBe(true);
    expect(v2EnabledModes()).toEqual([REVIEW_COACH_V2_INTERNAL_MODE]);
  });

  it("imports nothing, so it cannot leak into portable state", () => {
    const source = read("src/features/reviewCoach/releaseGate.ts");
    expect(source).not.toMatch(/^\s*import\s/m);
  });

  it("asserts before v2 write paths and names the operation", () => {
    // The Vitest run is pinned to mode=test, so the gate is closed here.
    expect(isReviewCoachV2Enabled()).toBe(false);
    expect(() => assertReviewCoachV2Enabled("completeLearningLoop")).toThrow(/completeLearningLoop/);
  });
});
