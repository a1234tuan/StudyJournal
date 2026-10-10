import { expect, test } from "@playwright/test";

test("compact page tools preserve actions and avoid horizontal overflow", async ({ page }) => {
  await page.goto("/?preview=journal-performance");
  await expect(page.getByRole("button", { name: "打开今日计划" })).toBeVisible();
  await expect(page.getByRole("button", { name: "打开收藏夹" })).toBeVisible();
  await expect(page.locator(".today-page h1")).toHaveText("今天");
  await page.getByRole("button", { name: "日志", exact: true }).first().click();
  await expect(page.locator(".journal-toolbar")).toBeVisible();
  await expect(page.locator(".page-transition-layer-entering, .page-transition-layer-exiting")).toHaveCount(0);
  if (await page.getByRole("button", { name: "筛选日志", exact: true }).isVisible()) await page.getByRole("button", { name: "筛选日志", exact: true }).click();
  await expect(page.getByRole("combobox", { name: "按学科筛选" })).toBeVisible();
  await expect(page.getByRole("button", { name: "全局搜索" })).toBeVisible();
  await expect(page.getByRole("tab", { name: "按日期", exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  const header = await page.locator(".journal-page .page-header").boundingBox();
  expect(header!.height).toBeLessThan(145);
});


test("journal preview keeps browser history, reading position and business facts", async ({ page }) => {
  await page.goto("/?preview=journal-performance");
  await page.getByRole("button", { name: "日志", exact: true }).first().click();
  const facts = () => page.evaluate(async () => {
    const { db } = await import("/src/db/database.ts");
    return JSON.stringify(await Promise.all([db.blocks.toArray(), db.recordReviews.toArray(), db.recordReviewLogs.toArray(), db.recordReviewDayStats.toArray()]));
  });
  const before = await facts();
  const card = page.locator(".journal-library-records .record-card-main").nth(1);
  const title = await card.getAttribute("title");
  await card.click();
  const preview = page.getByRole("region", { name: "日志预览" });
  await expect(preview.getByRole("heading", { name: title!, exact: true })).toBeVisible();
  const filter = page.getByRole("button", { name: "筛选日志", exact: true });
  if (await filter.isVisible()) {
    await filter.click();
    await expect(page.getByRole("combobox", { name: "按学科筛选" })).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(filter).toBeFocused();
    await expect(preview).toBeVisible();
  }
  const body = preview.locator(".journal-preview-body");
  await body.evaluate(element => { element.scrollTop = 150; element.dispatchEvent(new Event("scroll", { bubbles: true })); });
  const scroll = await body.evaluate(element => element.scrollTop);
  expect(scroll).toBeGreaterThan(0);
  await preview.getByRole("button", { name: "打开完整日志" }).click();
  await expect(page.locator(".page-transition-layer:not([aria-hidden]) .record-editor-page")).toBeVisible();
  await page.goBack();
  await expect(preview).toBeVisible();
  await expect.poll(() => body.evaluate(element => element.scrollTop)).toBe(scroll);
  await page.goBack();
  await expect(preview).toHaveCount(0);
  await page.goForward();
  await expect(preview).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(preview).toHaveCount(0);
  expect(await facts()).toBe(before);
});

test("journal reading space adapts to width and large text without clipping tools", async ({ page }, info) => {
  test.skip(info.project.name !== "desktop", "Width matrix uses desktop resizing; mobile flow has dedicated coverage");
  await page.goto("/?preview=journal-performance");
  await page.getByRole("button", { name: "日志", exact: true }).first().click();
  await page.locator(".journal-library-records .record-card-main").first().click();
  const readings = [];
  for (const width of [1920, 1440, 1280, 1160, 1159, 1024, 921, 920, 768, 390, 320]) {
    await page.setViewportSize({ width, height: 900 });
    await expect(page.getByRole("button", { name: "返回列表" })).toBeVisible();
    await expect(page.getByRole("button", { name: "打开完整日志" })).toBeVisible();
    const geometry = await page.evaluate(() => {
      const panel = document.querySelector(".journal-record-preview")!.getBoundingClientRect();
      const toolbar = document.querySelector(".journal-preview-toolbar")!.getBoundingClientRect();
      const title = document.querySelector(".journal-preview-heading")!.getBoundingClientRect();
      return { viewport: innerWidth, pane: panel.width, paneRight: panel.right, toolbarBottom: toolbar.bottom, titleTop: title.top, overflow: document.documentElement.scrollWidth > innerWidth + 1 };
    });
    expect(geometry.overflow).toBe(false);
    expect(geometry.paneRight).toBeLessThanOrEqual(width + 1);
    expect(geometry.titleTop).toBeGreaterThanOrEqual(geometry.toolbarBottom);
    const controls = await page.locator(".journal-preview-toolbar button").evaluateAll(buttons => buttons.map(button => { const rect = button.getBoundingClientRect(); return { x: rect.x, right: rect.right, y: rect.y, bottom: rect.bottom }; }));
    expect(controls[0].right <= controls[1].x || controls[1].right <= controls[0].x || controls[0].bottom <= controls[1].y || controls[1].bottom <= controls[0].y).toBe(true);
    if (width >= 1280) expect(geometry.pane).toBeGreaterThanOrEqual(600);
    readings.push(geometry);
  }
  await info.attach("reading-space.json", { body: JSON.stringify(readings, null, 2), contentType: "application/json" });
  await page.setViewportSize({ width: 1440, height: 900 });
  for (const theme of ["light", "dark"]) {
    await page.evaluate(theme => { document.documentElement.dataset.theme = theme; document.documentElement.style.fontSize = "20px"; }, theme);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
    await page.screenshot({ path: info.outputPath("journal-" + theme + "-large.png"), animations: "disabled" });
  }
});


test("preview changes records, retains filtering and reports a deleted source", async ({ page }, info) => {
  await page.goto("/?preview=journal-performance");
  await page.getByRole("button", { name: "日志", exact: true }).first().click();
  await expect(page.locator(".journal-toolbar")).toBeVisible();
  await expect(page.locator(".page-transition-layer-entering, .page-transition-layer-exiting")).toHaveCount(0);
  if (await page.getByRole("button", { name: "筛选日志", exact: true }).isVisible()) await page.getByRole("button", { name: "筛选日志", exact: true }).click();
  await page.getByRole("combobox", { name: "按学科筛选" }).selectOption("数据结构");
  await page.keyboard.press("Escape");
  const records = page.locator(".journal-library-records .record-card");
  await records.nth(0).locator(".record-card-main").click();
  if (info.project.name === "desktop") {
    await records.nth(1).locator(".record-card-main").click();
    await expect(records.nth(1).locator(".record-card-main")).toHaveAttribute("aria-current", "true");
    await page.getByRole("region", { name: "日志预览" }).getByRole("button", { name: "打开完整日志" }).click();
    await page.getByRole("button", { name: "返回", exact: true }).click();
  }
  await expect(page.getByLabel("按学科筛选", { exact: true })).toHaveValue("数据结构");
  await page.getByRole("region", { name: "日志预览" }).getByRole("button", { name: "打开完整日志" }).click();
  await page.getByRole("button", { name: "编辑", exact: true }).click();
  await page.getByRole("button", { name: "更多操作", exact: true }).click();
  page.once("dialog", dialog => dialog.accept());
  await page.locator(".record-more-menu").getByRole("button", { name: "删除记录", exact: true }).click();
  await expect(page.getByRole("status").filter({ hasText: "原日志暂不可用" })).toBeVisible();
  await expect(page.getByRole("button", { name: "打开完整日志" })).toBeDisabled();
  await page.getByRole("button", { name: "返回列表" }).click();
  await expect(page.getByLabel("按学科筛选", { exact: true })).toHaveValue("数据结构");
  await page.getByRole("tab", { name: "按日期", exact: true }).click();
  await expect(page.getByRole("heading", { name: "本月有记录日期" })).toBeVisible();
  await page.getByRole("button", { name: "全局搜索" }).click();
  await expect(page.locator(".search-page")).toBeVisible();
});

test("long titles and rich content stay readable at narrow and wide sizes", async ({ page }, info) => {
  await page.goto("/?preview=journal-performance");
  await page.getByRole("button", { name: "日志", exact: true }).first().click();
  const card = page.locator(".journal-library-records .record-card").first();
  const recordId = await card.getAttribute("data-record-id");
  await page.evaluate(async recordId => {
    const { db } = await import("/src/db/database.ts");
    await db.blocks.update(recordId!, { title: "窗口边界与循环不变量：".repeat(10), contentHtml: "<h2>正文结构</h2><p>" + "边界条件需要逐项核对。".repeat(90) + "</p><pre><code>" + "long_unbroken_identifier_".repeat(30) + "</code></pre><p>文末定位</p>" });
  }, recordId);
  await page.goto("/");
  await page.getByRole("button", { name: "日志", exact: true }).first().click();
  await expect(card.locator("strong")).toHaveText("窗口边界与循环不变量：".repeat(10));
  await card.locator(".record-card-main").click();
  await expect(page.getByRole("region", { name: "日志预览" }).getByRole("heading", { name: "正文结构" })).toBeVisible();
  await page.evaluate(() => { document.documentElement.style.setProperty("--font-scale", "1.25"); document.documentElement.style.setProperty("--editor-font-scale", "1.2"); });
  const preview = page.getByRole("region", { name: "日志预览" });
  await expect(preview.getByRole("button", { name: "打开完整日志" })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  await page.screenshot({ path: info.outputPath("long-title-reading.png"), animations: "disabled" });
});
