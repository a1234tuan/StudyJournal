import { expect, test } from "@playwright/test";

const entries = [
  ["AI 问答", ".ai-chat-page"],
  ["知识播客", ".knowledge-podcast-page"],
  ["OCR 设置", ".ocr-settings-page"],
  ["知识库", "main.knowledge-library"],
  ["今日计划", ".daily-plan-page"],
  ["分类管理", ".categories-page"],
  ["录音库", ".recordings-page"],
  ["模板", ".template-library-page"],
  ["统计", ".stats-page"],
  ["使用教程", ".usage-guide-page"],
  ["备份与恢复", ".backup-page"],
  ["回收站", ".trash-page"],
  ["设置", ".settings-page"],
] as const;

test("every More entry renders once and browser back-forward preserves its destination", async ({ page }, info) => {
  test.setTimeout(120000);
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.route("https://**/*", route => route.abort());
  await page.goto("/?preview=journal-performance");
  await expect(page.locator(".today-page")).toBeVisible();
  const navigation = page.locator(info.project.name === "desktop" ? ".sidebar nav" : ".bottom-nav");
  await navigation.getByRole("button", { name: "更多", exact: true }).click();
  await expect(page.locator(".today-page")).toHaveCount(0);
  for (const [label, selector] of entries) {
    await test.step(label, async () => {
      const entry = page.locator(".more-page").getByRole("button", { name: new RegExp("^" + label) });
      await expect(entry).toHaveCount(1);
      await entry.click();
      await expect(page.locator(".page-transition-layer-entering, .page-transition-layer-exiting")).toHaveCount(0);
      await expect(page.locator(selector)).toHaveCount(1);
      await expect(page.locator(selector)).toBeVisible();
      await expect(page.locator(".more-page")).toHaveCount(0);
      await page.goBack();
      await expect(page.locator(selector)).toHaveCount(0);
      await expect(page.locator(".more-page")).toBeVisible();
      await page.goForward();
      await expect(page.locator(selector)).toBeVisible();
      await expect(page.locator(".more-page")).toHaveCount(0);
      await page.goBack();
      await expect(page.locator(selector)).toHaveCount(0);
      await expect(page.locator(".more-page")).toBeVisible();
    });
  }
  expect(errors).toEqual([]);
});
