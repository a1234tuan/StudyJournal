import { expect, test } from "@playwright/test";

for (const scenario of [
  { width: 320, fontScale: 1.25, theme: "light", visualTheme: "warm" },
  { width: 390, fontScale: 1, theme: "dark", visualTheme: "modern" },
  { width: 412, fontScale: 1, theme: "light", visualTheme: "warm" },
]) {
  test(`mobile today empty, picker and saved record fit at ${scenario.width}px`, async ({ page }, info) => {
    test.skip(info.project.name !== "android-narrow", "Mobile layout regression");
    await page.setViewportSize({ width: scenario.width, height: 844 });
    await page.goto("/?preview=stage3");
    await expect(page.locator(".today-page")).toBeVisible();
    await page.evaluate(async (settings) => {
      const { db } = await import("/src/db/database.ts");
      const stamp = new Date().toISOString();
      await db.blocks.clear();
      await db.settings.update("settings", {
        fontScale: settings.fontScale, theme: settings.theme, visualTheme: settings.visualTheme,
        subjects: Array.from({ length: 12 }, (_, index) => ({
          id: `mobile-subject-${index}`, name: index === 11 ? "移动端超长学科名称与布局回归验证" : `学科${index + 1}`,
          order: index, createdAt: stamp, updatedAt: stamp,
        })),
      });
      await db.templates.put({ id: "mobile-layout-template", title: "布局验证模板", contentHtml: "<p>模板正文验证</p>", createdAt: stamp, updatedAt: stamp });
    }, scenario);
    await page.goto("/");
    await expect(page.locator(".today-page .empty-state")).toBeVisible();

    const assertColumnWidth = async (selector: string) => {
      const grid = (await page.locator(".today-content-grid").boundingBox())!;
      const content = (await page.locator(selector).boundingBox())!;
      expect(Math.abs(content.x - grid.x)).toBeLessThanOrEqual(1);
      expect(Math.abs(content.width - grid.width)).toBeLessThanOrEqual(1);
    };
    await assertColumnWidth(".today-journal-column");
    await assertColumnWidth(".today-page .empty-state");
    await page.screenshot({ path: info.outputPath("empty.png"), animations: "disabled" });
    await page.locator(".today-create-options summary").click();
    const panel = page.locator(".today-create-options > div");
    const bounds = (await panel.boundingBox())!;
    expect(bounds.x).toBeGreaterThanOrEqual(16);
    expect(bounds.x + bounds.width).toBeLessThanOrEqual(scenario.width - 16 + 1);
    const main = (await page.locator(".today-compose-main").boundingBox())!;
    const toggle = (await page.locator(".today-create-options summary").boundingBox())!;
    expect(Math.abs(main.y - toggle.y)).toBeLessThanOrEqual(1);
    expect(Math.abs(main.height - toggle.height)).toBeLessThanOrEqual(1);
    expect(main.height).toBeGreaterThanOrEqual(48);
    expect(Math.abs(main.x + main.width - toggle.x)).toBeLessThanOrEqual(1);
    for (const button of await panel.locator(".subject-picker button").all()) {
      await button.scrollIntoViewIfNeeded();
      const box = (await button.boundingBox())!;
      expect(box.x).toBeGreaterThanOrEqual(bounds.x);
      expect(box.x + box.width).toBeLessThanOrEqual(bounds.x + bounds.width);
      expect(box.height).toBeGreaterThanOrEqual(44);
    }
    const subject = "移动端超长学科名称与布局回归验证";
    await panel.getByRole("button", { name: subject, exact: true }).click();
    await expect(page.locator(".today-compose-main")).toHaveAttribute("aria-label", `新建 ${subject} 记录`);
    await panel.getByRole("combobox", { name: "新记录模板" }).selectOption("mobile-layout-template");
    expect(await panel.evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
    await page.screenshot({ path: info.outputPath("picker.png"), animations: "disabled" });
    await page.locator(".today-create-options summary").click();
    await expect(panel).toBeHidden();
    await page.locator(".today-compose-main").click();
    await expect(page.locator(".record-editor-page")).toContainText("模板正文验证");
    await page.getByRole("button", { name: "编辑", exact: true }).click();
    await page.getByRole("textbox", { name: "记录标题", exact: true }).fill("移动首页布局回归记录");
    await page.getByRole("button", { name: "保存", exact: true }).click();
    await expect.poll(() => page.evaluate(async () => {
      const { db } = await import("/src/db/database.ts");
      return (await db.blocks.toArray()).some(block => block.type === "record" && block.title === "移动首页布局回归记录");
    })).toBe(true);
    await page.getByRole("button", { name: "返回", exact: true }).first().click();
    await expect(page.locator(".today-page .record-card")).toContainText("移动首页布局回归记录");
    await assertColumnWidth(".today-journal-column");
    await assertColumnWidth(".today-page .record-card");
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
    await page.screenshot({ path: info.outputPath("saved-record.png"), animations: "disabled" });
  });
}

test("desktop today keeps its layout with mobile rules loaded", async ({ page }, info) => {
  test.skip(info.project.name !== "desktop", "Desktop isolation regression");
  await page.goto("/?preview=stage3");
  await expect(page.locator("html")).toHaveAttribute("data-mobile-ui", "false");
  await page.locator(".today-create-options summary").click();
  await expect(page.locator(".today-create-options > div")).toBeVisible();
  await expect(page.locator(".page-transition-layer-exiting, .page-transition-layer-entering")).toHaveCount(0);
  await page.evaluate(() => document.fonts.ready);
  const before = await page.screenshot({ animations: "disabled" });
  await page.evaluate(() => {
    document.querySelectorAll('style[data-vite-dev-id$="/styles/mobile.css"]').forEach(element => element.remove());
  });
  expect(await page.screenshot({ animations: "disabled" })).toEqual(before);
});
