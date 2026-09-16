/**
 * Review Coach closed-loop v2 release gate.
 *
 * This module is the single authority for "may this build write v2 learning
 * facts?". It deliberately does NOT read the application settings, Dexie,
 * Firebase, ZIP backups, record transfer or knowledge export, so the gate can
 * never leak into portable state (dev plan section 1.8 / 2.2 item 12).
 *
 * Two independent switches must both be open:
 *
 *   1. the build mode must be the internal `review-coach-v2` mode;
 *   2. the source constant `PRODUCTION_V2_ENABLED` must be true.
 *
 * The second switch is a versioned source change, not configuration. That means
 * no environment variable, no `.env` file and no runtime setting can open v2 in
 * a production build. `npm run build`, `desktop:dev` and `desktop:build` all
 * stay on production mode during M0-M5 and therefore stay closed.
 */

export const REVIEW_COACH_V2_INTERNAL_MODE = "review-coach-v2";

/**
 * Versioned production switch.
 *
 * Stays `false` until M0-M5 all pass their Go conditions and a dedicated
 * release change flips it. Do not wire this to an environment variable.
 */
export const PRODUCTION_V2_ENABLED = false;

/** Modes in which v2 may ever be written. Only the internal mode for now. */
export const v2EnabledModes = (): readonly string[] => (
  PRODUCTION_V2_ENABLED ? [REVIEW_COACH_V2_INTERNAL_MODE, "production"] : [REVIEW_COACH_V2_INTERNAL_MODE]
);

export interface ReviewCoachGateInput {
  mode?: string;
  productionV2Enabled?: boolean;
}

/**
 * Pure resolver. Exported separately from the ambient environment read so tests
 * can cover internal / development / test / production without depending on the
 * test runner's implicit `import.meta.env`.
 */
export const resolveReviewCoachV2 = (input: ReviewCoachGateInput): boolean => {
  const mode = input.mode ?? "";
  const productionEnabled = input.productionV2Enabled ?? PRODUCTION_V2_ENABLED;
  if (mode === REVIEW_COACH_V2_INTERNAL_MODE) return true;
  if (mode === "production") return productionEnabled;
  return false;
};

/** Ambient read. Every runtime call site should go through this. */
export const isReviewCoachV2Enabled = (): boolean => resolveReviewCoachV2({
  mode: import.meta.env.MODE,
  productionV2Enabled: PRODUCTION_V2_ENABLED,
});

/**
 * Guard for v2-only write paths. Throws instead of silently degrading, so a
 * mis-built bundle fails loudly in tests rather than writing half-truths.
 */
export const assertReviewCoachV2Enabled = (operation: string): void => {
  if (!isReviewCoachV2Enabled()) {
    throw new Error(`review-coach-v2 未启用，拒绝执行 ${operation}。当前 mode 为 ${import.meta.env.MODE}。`);
  }
};
