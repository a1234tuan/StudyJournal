import { expect, test } from "@playwright/test";

test("usage guide loads its visual guide and remains readable", async ({ page }) => {
  await page.goto("/?preview=stage3");

  await page.getByRole("button", { name: "更多", exact: true }).first().click();
  await expect(page.getByRole("heading", { name: "更多" })).toBeVisible();
  await page.locator(".more-page").getByRole("button", { name: /使用教程/ }).click();
  await expect(page.getByRole("heading", { name: "使用教程" })).toBeVisible();

  const images = page.locator(".guide-figure img");
  await expect(images).toHaveCount(5);
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
