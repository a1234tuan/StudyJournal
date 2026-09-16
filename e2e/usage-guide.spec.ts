import { readdirSync } from "node:fs";
import { join } from "node:path";

import { expect, test } from "@playwright/test";

// Every chapter illustration is a multi-megabyte PNG that this spec scrolls
// into view and waits to decode, so it needs more than the default budget:
// six figures put it around 34s, and the sixth is what pushed it over 30s.
test.setTimeout(90_000);

/**
 * `public/guide` holds exactly the illustration set the usage guide publishes,
 * one per illustrated chapter. Deriving the expected count from those assets
 * keeps this spec honest when a chapter gains an illustration, instead of
 * rotting the way it did when it still expected five while the guide already
 * shipped six (the daily-plan figure landed without updating this number).
 */
const publishedGuideAssets = readdirSync(join(process.cwd(), "public", "guide"))
  .filter((name) => name.endsWith(".png"));

test("usage guide loads its visual guide and remains readable", async ({ page }) => {
  await page.goto("/?preview=stage3");

  await page.getByRole("button", { name: "更多", exact: true }).first().click();
  await expect(page.getByRole("heading", { name: "更多" })).toBeVisible();
  await page.locator(".more-page").getByRole("button", { name: /使用教程/ }).click();
  await expect(page.getByRole("heading", { name: "使用教程" })).toBeVisible();

  const images = page.locator(".guide-figure img");
  await expect(images).toHaveCount(publishedGuideAssets.length);
  for (let index = 0; index < await images.count(); index += 1) {
    await images.nth(index).scrollIntoViewIfNeeded();
    await expect.poll(() => images.nth(index).evaluate((image) => (image as HTMLImageElement).naturalWidth > 0)).toBe(true);
  }
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);

  const collapsedDetails = page.locator(".guide-details").filter({ hasText: "模板、批量操作与回收站" });
  await expect(collapsedDetails).not.toHaveAttribute("open", "");
  await collapsedDetails.locator("summary").click();
  await expect(collapsedDetails).toHaveAttribute("open", "");

  await page.getByRole("button", { name: "返回", exact: true }).click();
  await expect(page.getByRole("heading", { name: "更多" })).toBeVisible();
});
