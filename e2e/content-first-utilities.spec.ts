import { expect, test, type Page } from "@playwright/test";

const checkHeader = async (page: Page, selector: string) => {
  const root = page.locator(selector);
  await expect(root).toBeVisible();
  await expect(page.locator(".page-transition-layer-exiting")).toHaveCount(0);
  const header = root.locator(":scope > .page-header-workspace");
  await expect(header).toBeVisible();
  const metrics = await header.evaluate(element => {
    const box = element.getBoundingClientRect();
    const title = element.querySelector("h1")!;
    const controls = [...element.querySelectorAll("button")].filter(button => button.getBoundingClientRect().width > 0);
    return { fontSize: parseFloat(getComputedStyle(title).fontSize), left: box.left, right: box.right,
      controls: controls.map(button => { const rect = button.getBoundingClientRect(); return { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom }; }) };
  });
  expect(metrics.fontSize).toBeLessThanOrEqual(await page.locator("html").getAttribute("data-mobile-ui") === "true" ? 22 : 18);
  expect(metrics.left).toBeGreaterThanOrEqual(0);
  expect(metrics.right).toBeLessThanOrEqual(page.viewportSize()!.width + 1);
  for (const [index, control] of metrics.controls.entries()) {
    expect(control.left).toBeGreaterThanOrEqual(metrics.left - 1);
    expect(control.right).toBeLessThanOrEqual(metrics.right + 1);
    for (const other of metrics.controls.slice(index + 1)) {
      expect(control.right <= other.left + 1 || other.right <= control.left + 1 || control.bottom <= other.top + 1 || other.bottom <= control.top + 1).toBe(true);
    }
  }
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
};

test("compact utility headers preserve navigation and actions", async ({ page }, info) => {
  test.setTimeout(90000);
  await page.route("**/*", route => new URL(route.request().url()).hostname === "127.0.0.1" ? route.continue() : route.abort());
  await page.goto("/?preview=journal-performance");
  await expect(page.locator(".today-study-aside")).toBeVisible();
  if (info.project.name === "android-narrow") {
    await page.setViewportSize({ width: 320, height: 844 });
    await page.evaluate(() => document.documentElement.style.setProperty("--font-scale", "1.25"));
  }
  const nav = () => page.locator(info.project.name === "desktop" ? ".sidebar nav" : ".bottom-nav");
  await nav().getByRole("button", { name: "更多", exact: true }).click();
  await expect(page.locator(".today-page")).toHaveCount(0);
  await checkHeader(page, ".more-page");
  for (const [name, selector] of [["设置", ".settings-page"], ["统计", ".stats-page"], ["备份与恢复", ".backup-page"]]) {
    await page.locator(".more-page").getByRole("button", { name: new RegExp("^" + name) }).click();
    await expect(page.locator(".more-page")).toHaveCount(0);
    await checkHeader(page, selector);
    await page.screenshot({ path: info.outputPath(selector.slice(1) + ".png"), animations: "disabled" });
    await page.getByRole("button", { name: "返回", exact: true }).click();
    await expect(page.locator(selector)).toHaveCount(0);
    await expect(page.locator(".more-page")).toBeVisible();
  }
  await page.locator(".more-page").getByRole("button", { name: "今日计划", exact: true }).click();
  await expect(page.locator(".more-page")).toHaveCount(0);
  await checkHeader(page, ".daily-plan-page");
  await page.getByRole("button", { name: "返回今天", exact: true }).click();
  await expect(page.locator(".daily-plan-page")).toHaveCount(0);
  await page.getByRole("button", { name: "打开收藏夹", exact: true }).click();
  await expect(page.locator(".today-page")).toHaveCount(0);
  await checkHeader(page, ".favorites-page");
  await page.getByRole("button", { name: "返回", exact: true }).click();
  await expect(page.locator(".favorites-page")).toHaveCount(0);
  await expect(page.locator(".more-page")).toBeVisible();
  await nav().getByRole("button", { name: "今天", exact: true }).click();
  await expect(page.locator(".more-page")).toHaveCount(0);
  await page.getByRole("button", { name: "全局搜索", exact: true }).click();
  await checkHeader(page, ".search-page");
  await page.locator(".search-page input").fill("BFS");
  await expect(page.locator(".search-page").getByText("BFS Stage3 Preview", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "返回", exact: true }).click();
  await expect(page.locator(".search-page")).toHaveCount(0);
  await expect(page.locator(".journal-page")).toBeVisible();
  await nav().getByRole("button", { name: /^复习(?:\s+\d+)?$/ }).click();
  await expect(page.locator(".journal-page")).toHaveCount(0);
  await page.getByRole("button", { name: "返回卡片库", exact: true }).click();
  await checkHeader(page, ".review-page");
  const tabs = page.locator(".review-mode-tabs button");
  for (const tab of await tabs.all()) {
    expect(await tab.evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
  }
  await page.screenshot({ path: info.outputPath("review-library.png"), animations: "disabled" });
});
