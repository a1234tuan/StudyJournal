import { expect, test } from "@playwright/test";

test.setTimeout(60_000);

test("bottom plus opens compact subjects and larger subject orbit without creating a record", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "android-narrow", "The subject orbit belongs to the narrow-screen bottom navigation.");
  await page.goto("/?preview=stage3");
  const plus = page.getByRole("button", { name: "打开新建日志菜单" });
  await expect(plus).toBeVisible();

  const before = await page.locator(".today-page .record-card").count();
  await plus.click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  await expect(page.locator(".app-toast")).toBeHidden();
  await expect(dialog.getByRole("heading", { name: "选择后创建日志" })).toBeVisible();
  await expect(dialog.locator(".subject-orbit-all-list button")).toHaveCount(5);
  expect(await page.locator(".today-page .record-card").count()).toBe(before);
  await dialog.getByRole("button", { name: "关闭学科选择", exact: true }).click();
  await expect(dialog).toBeHidden();
  expect(await page.locator(".today-page .record-card").count()).toBe(before);
  await page.evaluate(async () => {
    const { storage } = await import("/src/services/storageAdapter.ts");
    const settings = await storage.getSettings();
    await storage.saveSubjects([...settings.subjects, { id: "orbit-sixth-subject", name: "第六学科", order: 5 }]);
  });
  await page.reload();
  await plus.click();
  await expect(dialog).toBeVisible();
  const focusedSubject = (await dialog.locator(".subject-orbit-heading h2").textContent())?.trim();
  expect(focusedSubject).toBeTruthy();
  await expect(dialog.getByRole("button", { name: `创建${focusedSubject}日志` })).toBeVisible();
  expect(await page.locator(".today-page .record-card").count()).toBe(before);
  const layout = await page.evaluate(() => {
    const box = (selector: string) => {
      const rect = document.querySelector<HTMLElement>(selector)!.getBoundingClientRect();
      return { top: rect.top, right: rect.right, bottom: rect.bottom, left: rect.left };
    };
    return {
      heading: box(".subject-orbit-heading"),
      controls: box(".subject-orbit-controls"),
      allSubjects: box(".subject-orbit-all-button"),
      close: box(".bottom-nav-create"),
      navigation: box(".bottom-nav"),
    };
  });
  expect(layout.heading.bottom).toBeLessThan(layout.controls.top);
  expect(layout.allSubjects.bottom).toBeLessThan(layout.close.top);
  expect(layout.close.top).toBeGreaterThanOrEqual(layout.navigation.top);
  await page.getByRole("button", { name: "关闭新建菜单" }).click();
  await expect(page.getByRole("dialog")).toBeHidden();
  expect(await page.locator(".today-page .record-card").count()).toBe(before);
});
