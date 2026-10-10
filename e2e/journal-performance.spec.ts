import { expect, test } from "@playwright/test";

test.setTimeout(60_000);

test("bounds a 92-record journal and restores the list after preview", async ({ page }) => {
  const errors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  page.on("pageerror", (error) => errors.push(error.message));

  await page.goto("/?preview=journal-performance");
  await page.getByRole("button", { name: "日志", exact: true }).first().click();
  await expect(page.getByText("92 条日志", { exact: true })).toBeVisible();
  await expect(page.locator(".journal-library-records .record-card")).toHaveCount(20);
  await expect(page.getByText("已显示 20 / 92", { exact: true })).toBeVisible();

  await page.getByRole("button", { name: "再显示 20 条" }).click();
  await expect(page.locator(".journal-library-records .record-card")).toHaveCount(40);
  const source = page.locator(".journal-library-records .record-card").nth(30);
  await source.scrollIntoViewIfNeeded();
  const list = page.locator(".journal-library-scroll");
  const sourceScrollY = await list.evaluate(element => element.scrollTop);
  expect(sourceScrollY).toBeGreaterThan(0);
  await source.locator(".record-card-main").click();
  await expect(page.getByRole("region", { name: "日志预览" })).toBeVisible();
  await expect(page.locator(".journal-preview-body .tiptap")).toHaveAttribute("contenteditable", "false");
  await page.getByRole("button", { name: "打开完整日志" }).click();

  await expect(page.getByRole("button", { name: "返回", exact: true })).toBeVisible();
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBeLessThanOrEqual(1);
  await page.getByRole("button", { name: "返回", exact: true }).click();
  await expect(page.getByRole("region", { name: "日志预览" })).toBeVisible();
  await page.getByRole("button", { name: "返回列表" }).click();
  await expect(page.locator(".journal-library-records .record-card")).toHaveCount(40);
  await expect(page.getByText("已显示 40 / 92", { exact: true })).toBeVisible();
  await expect.poll(() => list.evaluate(element => element.scrollTop)).toBeGreaterThan(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
  expect(errors).toEqual([]);
});
