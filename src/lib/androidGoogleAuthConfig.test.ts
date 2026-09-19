import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

describe("Android native Google authentication config", () => {
  it("ships a real Web OAuth client id instead of the plugin placeholder", () => {
    const strings = readFileSync("android/app/src/main/res/values/strings.xml", "utf8");
    const clientId = strings.match(/<string name="default_web_client_id">([^<]+)<\/string>/)?.[1];

    expect(clientId).toMatch(/^\d+-[a-z0-9]+\.apps\.googleusercontent\.com$/);
    expect(clientId).not.toBe("WILL_BE_OVERRIDDEN");
    expect(strings).toContain('<string name="google_app_id">1:545473367044:android:');
    expect(strings).toContain('<string name="project_id">study-journal-408-9f31</string>');
  });
});
