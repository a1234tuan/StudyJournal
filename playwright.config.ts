import { defineConfig, devices } from "@playwright/test";

const chromePath = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";

const localNow = new Date();
const reminderDate = [localNow.getFullYear(), String(localNow.getMonth() + 1).padStart(2, "0"), String(localNow.getDate()).padStart(2, "0")].join("-");

// The closed-loop suite must run with the explicit Review Coach v2 mode.
export default defineConfig({
  testDir: "./e2e",
  outputDir: "test-results/playwright",
  fullyParallel: false,
  forbidOnly: true,
  retries: 0,
  reporter: "list",
  use: {
    baseURL: "http://127.0.0.1:4190",
    browserName: "chromium",
    launchOptions: { executablePath: chromePath },
    trace: "retain-on-failure",
    storageState: { cookies: [], origins: [{ origin: "http://127.0.0.1:4190", localStorage: [{ name: "study-journal-daily-plan-reminder-date", value: reminderDate }] }] },
  },
  projects: [
    { name: "desktop", use: { viewport: { width: 1440, height: 1000 } } },
    { name: "android-narrow", use: { ...devices["Pixel 7"], viewport: { width: 390, height: 844 } } },
  ],
  webServer: {
    command: "npm run dev:review-coach-v2 -- --port 4190 --strictPort",
    url: "http://127.0.0.1:4190",
    reuseExistingServer: false,
    timeout: 120_000,
  },
});
