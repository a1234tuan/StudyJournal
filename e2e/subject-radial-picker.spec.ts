import { expect, test } from "@playwright/test";

test.setTimeout(60_000);

test("bottom plus opens subject orbit without creating a record", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "android-narrow", "The subject orbit belongs to the narrow-screen bottom navigation.");
  await page.goto("/?preview=stage3");
  const plus = page.getByRole("button", { name: "打开新建日志菜单" });
  await expect(plus).toBeVisible();

  const before = await page.locator(".today-page .record-card").count();
  await plus.click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  const focusedSubject = (await dialog.locator(".subject-orbit-heading h2").textContent())?.trim();
  expect(focusedSubject).toBeTruthy();
  await expect(dialog.getByRole("button", { name: `创建${focusedSubject}日志` })).toBeVisible();
  expect(await page.locator(".today-page .record-card").count()).toBe(before);
  await dialog.getByRole("button", { name: "关闭新建菜单" }).click();
  await expect(page.getByRole("dialog")).toBeHidden();
  expect(await page.locator(".today-page .record-card").count()).toBe(before);
});
