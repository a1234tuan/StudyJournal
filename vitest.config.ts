import { defineConfig } from "vitest/config";

// The Review Coach release gate (src/features/reviewCoach/releaseGate.ts) resolves
// from the Vite mode. The unit suite pins `test` explicitly instead of trusting
// the ambient environment; `test` is never a v2-enabled mode. The gate itself is
// covered by the pure resolver tests in releaseGate.test.ts.
export default defineConfig({
  mode: "test",
  test: {
    globals: true,
    environment: "jsdom",
    setupFiles: "./src/test/setup.ts",
    // The root suite is browser-side; Cloud Functions use Node's built-in runner from functions/.
    include: ["src/**/*.{test,spec}.{js,ts,jsx,tsx}"],
  },
});
