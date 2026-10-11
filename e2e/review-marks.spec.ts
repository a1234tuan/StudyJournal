import { expect, test, type Page } from "@playwright/test";

const recordId = "stage3-preview-record";
const text = "这里需要巩固的内容，包含容易混淆的边界条件。";
const open = async (page: Page) => {
  await page.goto("/?preview=stage3");
  await expect(page.locator(".today-page")).toBeVisible();
  await page.evaluate(async ({ recordId, text }) => {
    const { db } = await import("/src/db/database.ts");
    const { storage } = await import("/src/services/storageAdapter.ts");
    const record = await db.blocks.get(recordId);
    if (record?.type !== "record") throw new Error("Missing preview record");
    await storage.saveBlock({ ...record, contentHtml: "<p>" + text + "</p><p>已经掌握的背景知识仍然保留。阅读提示不会改变评分或调度。</p>" });
  }, { recordId, text });
  await page.getByRole("button", { name: /^复习/ }).first().click();
  await expect(page.locator(".review-record-card h1")).toHaveText("BFS Stage3 Preview");
};
const select = async (page: Page, index = 0) => {
  await page.locator(".review-mark-content .ProseMirror > p").nth(index).evaluate(element => {
    const range = document.createRange(); range.setStart(element.firstChild!, 2); range.setEnd(element.firstChild!, 6);
    const selection = window.getSelection()!; selection.removeAllRanges(); selection.addRange(range);
    document.dispatchEvent(new Event("selectionchange"));
  });
};
const markCount = (page: Page) => page.evaluate(async recordId => {
  const { db } = await import("/src/db/database.ts"); return db.reviewMarkEvents.where("recordId").equals(recordId).count();
}, recordId);
const addMark = async (page: Page) => {
  await page.getByRole("button", { name: "永久复习印记", exact: true }).click();
  await select(page);
  await page.getByRole("button", { name: "标记选中文字" }).click();
  await expect.poll(() => markCount(page)).toBe(1);
  await expect(page.locator(".review-mark-paint [data-mark-id]")).toHaveCount(1);
};

test("marks survive reload and ratings but never appear in the source editor", async ({ page }) => {
  await open(page); await addMark(page);
  await page.getByRole("button", { name: "关闭印记工具" }).click();
  const stored = await page.evaluate(async recordId => { const { db } = await import("/src/db/database.ts"); return db.blocks.get(recordId); }, recordId);
  expect(stored?.contentHtml).not.toContain("review-mark");
  await page.reload();
  await page.getByRole("button", { name: /^复习/ }).first().click();
  await expect(page.locator(".review-mark-paint [data-mark-id]")).toHaveCount(1);
  await page.getByRole("button", { name: "打开复习更多菜单" }).click();
  await page.getByRole("menuitem", { name: /编辑原日志/ }).click();
  await expect(page.getByRole("textbox", { name: "记录标题" })).toBeVisible();
  await expect(page.locator(".page-transition-layer:not([aria-hidden=true]) .review-mark-paint")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "永久复习印记", exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "返回", exact: true }).first().click();
  await expect(page.locator(".review-mark-paint [data-mark-id]")).toHaveCount(1);
  const logs = await page.evaluate(async recordId => { const { db } = await import("/src/db/database.ts"); return db.recordReviewLogs.where("recordId").equals(recordId).count(); }, recordId);
  await page.getByRole("button", { name: /^良好/ }).click();
  await expect.poll(() => page.evaluate(async recordId => { const { db } = await import("/src/db/database.ts"); return db.recordReviewLogs.where("recordId").equals(recordId).count(); }, recordId)).toBeGreaterThan(logs);
  expect(await markCount(page)).toBe(1);
});

test("real selection tools preserve geometry across widths, themes and enlarged text", async ({ page }, info) => {
  await open(page); await addMark(page);
  const widths = info.project.name === "desktop" ? [1440, 1024, 921] : [390, 320, 412];
  for (const width of widths) {
    await page.setViewportSize({ width, height: 1000 });
    await page.evaluate(width => { document.documentElement.dataset.theme = width === 320 || width === 1024 ? "dark" : "light"; document.documentElement.dataset.visualTheme = width === 412 || width === 1024 ? "modern" : "reading"; document.documentElement.style.setProperty("--font-scale", width === 320 ? "1.25" : "1"); }, width);
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
    const chrome = page.getByRole("region", { name: "复习进度" });
    const chromeBounds = await chrome.boundingBox();
    const bounds = await chrome.locator("button:visible").evaluateAll(elements => elements.map(element => element.getBoundingClientRect().toJSON()));
    for (const [index, button] of bounds.entries()) {
      expect(button.height).toBeGreaterThanOrEqual(44); expect(button.left).toBeGreaterThanOrEqual(chromeBounds!.x - 1); expect(button.right).toBeLessThanOrEqual(chromeBounds!.x + chromeBounds!.width + 1);
      for (const other of bounds.slice(index + 1)) expect(button.right <= other.left + 1 || other.right <= button.left + 1 || button.bottom <= other.top + 1 || other.bottom <= button.top + 1).toBe(true);
    }
    await expect.poll(() => page.evaluate(() => {
      const paragraph = document.querySelector(".review-mark-content .ProseMirror > p")!;
      const range = document.createRange(); range.setStart(paragraph.firstChild!, 2); range.setEnd(paragraph.firstChild!, 6);
      const target = range.getBoundingClientRect(); const paint = document.querySelector(".review-mark-paint [data-mark-id]")!.getBoundingClientRect();
      return Math.abs(target.x - paint.x) < 2 && Math.abs(target.y - paint.y) < 2;
    })).toBe(true);
    await page.screenshot({ path: info.outputPath("marks-" + width + ".png"), animations: "disabled" });
  }
  await page.getByRole("button", { name: "重点列表" }).click();
  await page.getByLabel("印记样式", { exact: true }).selectOption("outline");
  await page.getByRole("button", { name: "蓝色印记" }).click();
  await page.getByRole("button", { name: "更新印记样式" }).click();
  await expect.poll(() => markCount(page)).toBe(2);
  await expect(page.locator('.review-mark-paint [data-kind="outline"][data-color="blue"]')).toHaveCount(1);
  await page.getByRole("button", { name: "擦除印记" }).click(); await expect.poll(() => markCount(page)).toBe(3);
  await expect(page.locator(".review-mark-paint [data-mark-id]")).toHaveCount(0);
  await page.getByRole("button", { name: "撤销印记" }).click(); await expect.poll(() => markCount(page)).toBe(4);
  await page.keyboard.press("Control+z"); await expect.poll(() => markCount(page)).toBe(5);
  await expect(page.locator('.review-mark-paint [data-color="amber"]')).toHaveCount(1);
  await page.getByRole("button", { name: "打开批注工具" }).click();
  await expect(page.getByRole("region", { name: "印记工具" })).toHaveCount(0);
  await expect(page.getByRole("toolbar", { name: "批注工具栏" })).toBeVisible();
});

test("changed source yields an unresolved mark and supports explicit relocation", async ({ page }) => {
  await open(page); await addMark(page);
  await page.evaluate(async recordId => {
    const { db } = await import("/src/db/database.ts"); const { storage } = await import("/src/services/storageAdapter.ts"); const record = await db.blocks.get(recordId);
    if (record?.type !== "record") throw new Error("Missing record");
    await storage.saveBlock({ ...record, contentHtml: "<p>这里改成全新内容，原来的印记不应随意定位。</p><p>别的段落不应误高亮。</p>" });
  }, recordId);
  await page.reload(); await page.getByRole("button", { name: /^复习/ }).first().click();
  await expect(page.locator(".review-mark-paint [data-mark-id]")).toHaveCount(0);
  await page.getByRole("button", { name: /部分印记需要确认/ }).click();
  await page.getByRole("button", { name: /待重新定位/ }).click();
  await select(page);
  await page.getByRole("button", { name: "移到所选文字" }).click(); await expect.poll(() => markCount(page)).toBe(2);
  await expect(page.locator(".review-mark-paint [data-mark-id]")).toHaveCount(1);
});
