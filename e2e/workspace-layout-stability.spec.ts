import { expect, test, type Page } from "@playwright/test";

const settled = async (page: Page) => {
  await expect(page.locator(".page-transition-layer-entering, .page-transition-layer-exiting")).toHaveCount(0);
};
const box = async (page: Page, selector: string) => {
  await settled(page);
  return page.locator(selector).boundingBox().then(value => { expect(value).not.toBeNull(); return value!; });
};

test("journal tabs keep their header and toolbar anchors", async ({ page }, info) => {
  await page.goto("/?preview=stage3");
  const nav = page.locator(info.project.name === "desktop" ? ".sidebar nav" : ".bottom-nav");
  await nav.getByRole("button", { name: "日志", exact: true }).click();
  await expect(page.locator(".journal-page")).toBeVisible();
  const header = await box(page, ".journal-page .page-header");
  const toolbar = await box(page, ".journal-toolbar");
  const tabs = await box(page, ".journal-view-tabs");
  if (await page.getByRole("button", { name: "筛选日志", exact: true }).isVisible()) {
    await page.getByRole("button", { name: "筛选日志", exact: true }).click();
  }
  await page.getByRole("combobox", { name: "按学科筛选" }).selectOption("数学");
  await page.keyboard.press("Escape");
  await page.getByRole("tab", { name: "按日期", exact: true }).click();
  for (const [selector, before] of [[".journal-page .page-header", header], [".journal-toolbar", toolbar], [".journal-view-tabs", tabs]] as const) {
    const after = await box(page, selector);
    for (const coordinate of ["x", "y", "width", "height"] as const) expect(Math.abs(after[coordinate] - before[coordinate])).toBeLessThanOrEqual(1);
  }
  await page.getByRole("tab", { name: "全部日志", exact: true }).click();
  if (await page.getByRole("button", { name: "筛选日志", exact: true }).isVisible()) await page.getByRole("button", { name: "筛选日志", exact: true }).click();
  await expect(page.getByRole("combobox", { name: "按学科筛选" })).toHaveValue("数学");
  await page.keyboard.press("Escape");
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
});

test("knowledge handle stays centered with a slim visible grip", async ({ page }, info) => {
  test.skip(info.project.name !== "desktop", "Desktop sidebar only");
  await page.goto("/?preview=stage3");
  await page.locator(".sidebar nav").getByRole("button", { name: "知识库", exact: true }).click();
  const handle = page.locator(".knowledge-sidebar-edge");
  for (const height of [1000, 720]) {
    await page.setViewportSize({ width: 1440, height });
    for (const collapsed of [false, true]) {
      await expect(handle).toHaveAttribute("aria-expanded", String(!collapsed));
      const rect = await box(page, ".knowledge-sidebar-edge");
      expect(Math.abs(rect.y + rect.height / 2 - height / 2)).toBeLessThanOrEqual(1);
      const sidebarWidth = await page.evaluate(() => parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--sidebar-width")));
      expect(rect.x).toBe(collapsed ? 0 : sidebarWidth - rect.width / 2);
      expect(await handle.locator("svg").count()).toBe(0);
      expect(await handle.evaluate(element => ({ width: getComputedStyle(element, "::before").width, height: getComputedStyle(element, "::before").height }))).toEqual({ width: "4px", height: "28px" });
      await handle.click();
    }
  }
});

test("workspace headers share geometry and keep a single in-header return", async ({ page }, info) => {
  await page.goto("/?preview=stage3");
  await expect(page.locator(".today-page")).toBeVisible();
  await expect(page.locator("html")).toHaveCSS("scrollbar-gutter", "stable");
  const baseline = await box(page, ".today-page > .page-header");
  const nav = page.locator(info.project.name === "desktop" ? ".sidebar nav" : ".bottom-nav");
  await nav.getByRole("button", { name: "更多", exact: true }).click();
  const more = await box(page, ".more-page > .page-header");
  expect(more).toEqual(baseline);
  for (const [name, selector] of [["设置", ".settings-page"], ["分类管理", ".categories-page"], ["统计", ".stats-page"]]) {
    await page.locator(".more-page").getByRole("button", { name: new RegExp("^" + name) }).click();
    await expect(page.locator(selector)).toBeVisible();
    await page.evaluate(() => window.scrollTo(0, 0));
    const header = await box(page, selector + " > .page-header");
    for (const coordinate of ["x", "y", "width", "height"] as const) expect(Math.abs(header[coordinate] - baseline[coordinate])).toBeLessThanOrEqual(1);
    await expect(page.locator(".web-navigation-back-row")).toHaveCount(0);
    if (name !== "分类管理") {
      await expect(page.locator(selector + " > .page-header .workspace-back")).toHaveCount(1);
      await page.locator(selector + " > .page-header .workspace-back").click();
    } else {
      await page.goBack();
    }
    await expect(page.locator(".more-page")).toBeVisible();
  }
});


test("review views preserve the workspace shell and card progress", async ({ page }, info) => {
  await page.goto("/?preview=stage3");
  const nav = page.locator(info.project.name === "desktop" ? ".sidebar nav" : ".bottom-nav");
  await nav.getByRole("button", { name: /^复习/ }).click();
  await expect(page.locator(".review-session")).toBeVisible();
  const header = await box(page, ".review-page > .page-header");
  const tabs = await box(page, ".review-mode-tabs");
  const content = await box(page, ".review-workspace-content");
  const annotation = await box(page, ".review-annotation-entry");
  expect(annotation.y).toBeGreaterThanOrEqual(tabs.y + tabs.height);
  if (info.project.name !== "desktop") {
    const rating = await box(page, ".review-bottom-controls");
    const bottomNav = await box(page, ".bottom-nav");
    expect(rating.y + rating.height).toBeLessThanOrEqual(bottomNav.y + 1);
  }
  const title = await page.locator(".review-session h1").textContent();
  const progress = await page.getByRole("progressbar").getAttribute("aria-valuenow");
  await expect(nav).toBeVisible();
  await expect(page.getByRole("button", { name: "打开复习更多菜单", exact: true })).toHaveCount(1);
  await page.getByRole("button", { name: "卡片库", exact: true }).click();
  await expect(page.locator(".review-library")).toBeVisible();
  for (const [selector, before] of [[".review-page > .page-header", header], [".review-mode-tabs", tabs], [".review-workspace-content", content]] as const) {
    const after = await box(page, selector);
    for (const coordinate of ["x", "y", "width"] as const) expect(Math.abs(after[coordinate] - before[coordinate])).toBeLessThanOrEqual(1);
  }
  await page.getByRole("button", { name: "日志复习", exact: true }).click();
  await expect(page.locator(".review-session h1")).toHaveText(title!);
  await expect(page.getByRole("progressbar")).toHaveAttribute("aria-valuenow", progress!);
  await expect(nav).toBeVisible();
});

test("new tools start at the top and in-app return restores More scroll", async ({ page }, info) => {
  await page.goto("/?preview=stage3");
  if (info.project.name === "desktop") await page.setViewportSize({ width: 1024, height: 600 });
  const nav = page.locator(info.project.name === "desktop" ? ".sidebar nav" : ".bottom-nav");
  await nav.getByRole("button", { name: "更多", exact: true }).click();
  await expect(page.locator(".more-page")).toBeVisible();
  await settled(page);
  const settings = page.locator(".more-page").getByRole("button", { name: /^设置/ });
  await settings.scrollIntoViewIfNeeded();
  const before = await page.evaluate(() => window.scrollY);
  expect(before).toBeGreaterThan(0);
  await settings.click();
  await expect(page.locator(".settings-page")).toBeVisible();
  await settled(page);
  expect(await page.evaluate(() => window.scrollY)).toBe(0);
  expect((await box(page, ".settings-page h1")).y).toBeGreaterThanOrEqual(0);
  await page.locator(".settings-page .workspace-back").click();
  await expect(page.locator(".more-page")).toBeVisible();
  await settled(page);
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(before);
});

test("workspace geometry remains stable across breakpoints, dark mode and larger text", async ({ page }, info) => {
  test.skip(info.project.name !== "desktop", "One bounded resize matrix");
  test.setTimeout(120000);
  await page.goto("/?preview=stage3");
  const nav = () => page.locator(".sidebar nav:visible, .bottom-nav:visible");
  for (const width of [1440, 1024, 921, 920, 390, 320]) {
    await page.setViewportSize({ width, height: 900 });
    await page.evaluate(width => {
      document.documentElement.dataset.theme = width <= 390 ? "dark" : "light";
      document.documentElement.style.setProperty("--font-scale", width === 320 ? "1.25" : "1");
    }, width);
    await nav().getByRole("button", { name: "日志", exact: true }).click();
    await expect(page.locator(".journal-page")).toBeVisible();
    await page.evaluate(() => scrollTo(0, 0));
    const journalHeader = await box(page, ".journal-page > .page-header");
    const journalTools = await box(page, ".journal-toolbar");
    await page.getByRole("tab", { name: "按日期", exact: true }).click();
    expect(await box(page, ".journal-page > .page-header")).toEqual(journalHeader);
    expect(await box(page, ".journal-toolbar")).toEqual(journalTools);
    await page.getByRole("tab", { name: "全部日志", exact: true }).click();
    await nav().getByRole("button", { name: /^复习/ }).click();
    await expect(page.locator(".review-session")).toBeVisible();
    await page.evaluate(() => scrollTo(0, 0));
    await settled(page);
    const header = page.locator(".review-page > .page-header");
    const bounds = await header.boundingBox();
    const buttons = await header.locator("button:visible").evaluateAll(elements => elements.map(element => element.getBoundingClientRect().toJSON()));
    for (const [index, button] of buttons.entries()) {
      expect(button.left).toBeGreaterThanOrEqual(bounds!.x);
      expect(button.right).toBeLessThanOrEqual(bounds!.x + bounds!.width + 1);
      for (const other of buttons.slice(index + 1)) expect(button.right <= other.left + 1 || other.right <= button.left + 1 || button.bottom <= other.top + 1 || other.bottom <= button.top + 1).toBe(true);
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
    const tabs = await box(page, ".review-mode-tabs");
    const entry = await box(page, ".review-annotation-entry");
    expect(entry.y).toBeGreaterThanOrEqual(tabs.y + tabs.height);
    await page.screenshot({ path: info.outputPath("review-" + width + ".png"), animations: "disabled" });
  }
});
