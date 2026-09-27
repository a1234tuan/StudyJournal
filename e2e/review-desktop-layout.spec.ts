import { expect, test, type Page } from "@playwright/test";

test.setTimeout(60_000);

const geometry = (page: Page) => page.evaluate(() => {
  const rect = (selector: string) => {
    const bounds = document.querySelector(selector)!.getBoundingClientRect();
    return { left: bounds.left, width: bounds.width, right: bounds.right, bottom: bounds.bottom };
  };
  return {
    content: rect(".content-area"),
    chrome: rect(".review-session-chrome"),
    card: rect(".review-record-card"),
    body: rect(".review-record-card .editor-shell.read-only"),
    dock: rect(".review-viewport-dock"),
    overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    viewportHeight: window.innerHeight,
  };
});

const expectAlignedDesktop = async (page: Page) => {
  await expect(page.locator(".sidebar")).toBeVisible();
  await expect.poll(async () => {
    const bounds = await geometry(page);
    return Math.max(...[bounds.chrome, bounds.body, bounds.dock].flatMap((item) => [
      Math.abs(item.left - bounds.card.left),
      Math.abs(item.width - bounds.card.width),
    ]));
  }).toBeLessThanOrEqual(1);
  const bounds = await geometry(page);
  expect(bounds.card.width).toBeLessThanOrEqual(960.5);
  expect(Math.abs(bounds.card.left + bounds.card.width / 2 - bounds.content.left - bounds.content.width / 2)).toBeLessThanOrEqual(1);
  await expect.poll(async () => {
    const settled = await geometry(page);
    return Math.abs(settled.dock.bottom - settled.viewportHeight);
  }).toBeLessThanOrEqual(0.5);
  expect(bounds.overflow).toBeLessThanOrEqual(1);
};

for (const plainContent of [false, true]) {
  test("desktop review aligns navigation, content and controls with plainContent=" + plainContent, async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== "desktop", "Desktop responsive layout acceptance");
    await page.goto("/?preview=stage3");
    await expect(page.getByRole("button", { name: /BFS Stage3 Preview/ }).first()).toBeVisible();
    if (plainContent) {
      await page.evaluate(async () => {
        const { db } = await import("/src/db/database.ts");
        await db.blocks.update("stage3-preview-record", {
          contentHtml: Array.from({ length: 24 }, () => "<p>这是用于验证阅读宽度的日志正文，保留导航后也应能舒适阅读，顶部操作与底部评分应始终对齐。</p>").join(""),
        });
      });
      await page.reload();
    }
    await page.getByRole("button", { name: /^复习/ }).first().click();
    await expect(page.getByRole("heading", { name: "BFS Stage3 Preview" })).toBeVisible();
    await expect(page.locator(".decision-block-reflection-list")).toHaveCount(plainContent ? 0 : 1);
    for (const width of [1440, 1920, 1024, 921]) {
      await page.setViewportSize({ width, height: 1000 });
      await expectAlignedDesktop(page);
      if (width >= 1440) expect((await geometry(page)).body.width).toBeCloseTo(960, 0);
    }
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.screenshot({ path: testInfo.outputPath("desktop-review.png") });
    await page.getByRole("button", { name: "打开批注工具" }).click();
    await expect(page.getByRole("toolbar", { name: "批注工具栏" })).toBeVisible();
    await expectAlignedDesktop(page);
    await page.getByRole("button", { name: "关闭批注工具" }).click();
    await page.evaluate(() => window.scrollTo(0, 500));
    await expectAlignedDesktop(page);
    expect(await page.locator(".sidebar").evaluate((element) => element.getBoundingClientRect().top)).toBeCloseTo(0, 0);
    await page.locator(".sidebar").getByRole("button", { name: "日志", exact: true }).click();
    await expect(page.locator(".review-record-card")).toHaveCount(0);
    await page.locator(".sidebar").getByRole("button", { name: /^复习/ }).click();
    await expect(page.getByRole("heading", { name: "BFS Stage3 Preview" })).toBeVisible();
    await expectAlignedDesktop(page);
  });
}

test("narrow review keeps its immersive layout and existing widths", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "android-narrow", "Narrow layout acceptance");
  await page.goto("/?preview=stage3");
  await page.getByRole("button", { name: /^复习/ }).first().click();
  await expect(page.getByRole("heading", { name: "BFS Stage3 Preview" })).toBeVisible();
  for (const width of [390, 920]) {
    await page.setViewportSize({ width, height: 844 });
    await expect(page.locator(".sidebar")).toBeHidden();
    await expect(page.locator(".bottom-nav")).toBeHidden();
    const bounds = await geometry(page);
    expect(bounds.card.width).toBeCloseTo(Math.min(760, width - 32), 0);
    expect(bounds.dock.width).toBeCloseTo(Math.min(760, width - 32), 0);
    expect(bounds.overflow).toBeLessThanOrEqual(1);
  }
});
