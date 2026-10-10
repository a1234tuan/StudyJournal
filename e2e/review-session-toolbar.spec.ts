import { expect, test } from "@playwright/test";

test("compact review tools stay usable across widths, themes and workspace switches", async ({ page }, info) => {
  await page.goto("/?preview=stage3");
  await page.getByRole("button", { name: /^复习/ }).first().click();
  await expect(page.locator(".review-record-card h1")).toHaveText("BFS Stage3 Preview");
  await expect(page.getByRole("button", { name: "打开批注工具" })).toBeEnabled();
  const widths = info.project.name === "desktop" ? [1440, 1024, 921] : [600, 390, 320];
  for (const width of widths) {
    await page.setViewportSize({ width, height: 1000 });
    await page.evaluate(width => {
      document.documentElement.dataset.theme = width <= 390 ? "dark" : "light";
      document.documentElement.dataset.visualTheme = width === 1024 || width === 390 ? "modern" : "reading";
      document.documentElement.style.setProperty("--font-scale", width === 320 ? "1.25" : "1");
    }, width);
    const header = page.locator(".review-page-header");
    await expect(header.getByRole("button", { name: /编辑|更多|看板|返回/ })).toHaveCount(0);
    await expect(header.getByRole("tablist", { name: "复习视图" })).toBeVisible();
    const chrome = page.getByRole("region", { name: "复习进度" });
    await expect(chrome.getByRole("button", { name: "复习看板" })).toBeVisible();
    const bounds = await chrome.boundingBox();
    const controls = await chrome.locator("button:visible").evaluateAll(elements => elements.map(element => element.getBoundingClientRect().toJSON()));
    for (const [index, control] of controls.entries()) {
      expect(control.height).toBeGreaterThanOrEqual(44);
      expect(control.left).toBeGreaterThanOrEqual(bounds!.x - 1);
      expect(control.right).toBeLessThanOrEqual(bounds!.x + bounds!.width + 1);
      for (const other of controls.slice(index + 1)) {
        expect(control.right <= other.left + 1 || other.right <= control.left + 1 || control.bottom <= other.top + 1 || other.bottom <= control.top + 1).toBe(true);
      }
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
    const card = await page.locator(".review-record-card").boundingBox();
    expect(card!.y).toBeLessThan(width > 600 ? 170 : 220);
    await page.screenshot({ path: info.outputPath("toolbar-" + width + ".png"), animations: "disabled" });
  }
  const tabs = await page.locator(".review-mode-tabs").boundingBox();
  for (const label of ["卡片库", "学习助教", "日志复习"]) {
    await page.getByRole("button", { name: label, exact: true }).click();
    const after = await page.locator(".review-mode-tabs").boundingBox();
    expect(after).toEqual(tabs);
    await expect(page.getByRole("button", { name: "复习看板" })).toHaveCount(label === "日志复习" ? 1 : 0);
  }
  await page.getByRole("button", { name: "打开批注工具" }).click();
  await expect(page.getByRole("toolbar", { name: "批注工具栏" })).toBeVisible();
  await page.getByRole("button", { name: "关闭批注工具" }).click();
  await page.getByRole("button", { name: "打开复习更多菜单" }).click();
  await expect(page.getByRole("menuitem", { name: /编辑/ })).toHaveCount(1);
  const menu = await page.getByRole("menu", { name: "复习操作" }).boundingBox();
  expect(menu!.x).toBeGreaterThanOrEqual(0);
  expect(menu!.x + menu!.width).toBeLessThanOrEqual(widths.at(-1)!);
  await page.getByRole("menuitem", { name: /编辑原日志/ }).click();
  await expect(page.getByRole("textbox", { name: "记录标题" })).toBeVisible();
  await page.getByRole("textbox", { name: "记录标题" }).fill("BFS Stage3 Preview 已编辑");
  await page.getByRole("button", { name: "保存", exact: true }).click();
  await expect.poll(() => page.evaluate(async () => {
    const { db } = await import("/src/db/database.ts");
    return (await db.blocks.get("stage3-preview-record"))?.title;
  })).toBe("BFS Stage3 Preview 已编辑");
  await page.getByRole("button", { name: "返回", exact: true }).first().click();
  await expect(page.locator(".review-record-card h1")).toHaveText("BFS Stage3 Preview 已编辑");
  await expect(page.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "0");
});
