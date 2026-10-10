import { expect, test, type Page } from "@playwright/test";

const key = "study-journal-sidebar-layout-v1";
const current = (page: Page) => page.locator('.page-transition-layer:not([aria-hidden="true"])').last();
const settle = (page: Page) => expect(page.locator(".page-transition-layer-entering, .page-transition-layer-exiting")).toHaveCount(0);
const start = async (page: Page) => {
  await page.goto("/?preview=stage3");
  await expect(page.locator(".today-page")).toBeVisible();
  await settle(page);
};
const width = (page: Page) => page.locator(".sidebar").evaluate(element => element.getBoundingClientRect().width);
const pref = (page: Page) => page.evaluate(key => JSON.parse(localStorage.getItem(key)!), key);
const dragWidth = async (page: Page, delta: number, cancel = false) => {
  const bounds = await page.getByRole("separator", { name: "调整导航栏宽度" }).boundingBox();
  await page.mouse.move(bounds!.x + bounds!.width / 2, bounds!.y + 80);
  await page.mouse.down();
  await page.mouse.move(bounds!.x + bounds!.width / 2 + delta, bounds!.y + 80, { steps: 8 });
  if (cancel) await page.keyboard.press("Escape");
  await page.mouse.up();
};
const noOverflow = async (page: Page) => expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);

test("rail preserves global destinations, focus labels, pins and saved width", async ({ page }, info) => {
  test.skip(info.project.name !== "desktop", "Desktop sidebar");
  await start(page);
  await page.getByRole("separator", { name: "调整导航栏宽度" }).press("End");
  await page.getByRole("button", { name: "收起左侧导航" }).click();
  expect(await width(page)).toBe(64);
  const sidebar = page.locator(".sidebar");
  await expect(sidebar.getByRole("button", { name: "云同步" })).toBeVisible();
  for (const [label, selector] of [["日志", ".journal-page"], ["复习", ".review-page"], ["知识库", "main.knowledge-library"], ["更多", ".more-page"], ["分类管理", ".categories-page"], ["设置", ".settings-page"], ["今天", ".today-page"]]) {
    await sidebar.getByRole("button", { name: label, exact: true }).click();
    await expect(current(page).locator(selector)).toBeVisible();
    await settle(page);
    expect(await width(page)).toBe(64);
    await expect(sidebar.getByRole("button", { name: label, exact: true })).toHaveAttribute("aria-current", "page");
  }
  await sidebar.getByRole("button", { name: "日志", exact: true }).focus();
  expect(await sidebar.getByRole("button", { name: "日志", exact: true }).locator("span").evaluate(element => getComputedStyle(element).clipPath)).toBe("none");
  const pins = sidebar.getByRole("button", { name: "置顶日志", exact: true });
  await pins.click();
  const list = sidebar.getByRole("region", { name: "置顶日志列表" });
  await expect(list).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(pins).toBeFocused();
  await expect(list).toHaveCount(0);
  await pins.click();
  await list.getByRole("button", { name: /打开置顶日志/ }).first().click();
  await expect(current(page).getByRole("heading", { name: "BFS Stage3 Preview" })).toBeVisible();
  await current(page).getByRole("button", { name: "返回", exact: true }).first().click();
  await page.getByRole("button", { name: "展开左侧导航" }).click();
  expect(await width(page)).toBe(320);
  await page.reload();
  await expect(page.locator(".sidebar")).toBeVisible();
  expect(await width(page)).toBe(320);
  await noOverflow(page);
});

test("drag bounds, cancellation, reset and window clamps preserve the preference", async ({ page }, info) => {
  test.skip(info.project.name !== "desktop", "Desktop sidebar");
  await start(page);
  await dragWidth(page, 72);
  expect(await width(page)).toBe(280);
  expect((await pref(page)).width).toBe(280);
  await dragWidth(page, -60, true);
  expect(await width(page)).toBe(280);
  expect((await pref(page)).width).toBe(280);
  await dragWidth(page, 400);
  expect(await width(page)).toBe(320);
  await page.setViewportSize({ width: 960, height: 800 });
  await expect.poll(() => width(page)).toBeLessThanOrEqual(240);
  expect((await pref(page)).width).toBe(320);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await expect.poll(() => width(page)).toBe(320);
  await dragWidth(page, -500);
  expect(await width(page)).toBe(192);
  await page.getByRole("separator", { name: "调整导航栏宽度" }).dblclick({ position: { x: 4, y: 80 } });
  expect(await width(page)).toBe(208);
  const separator = page.getByRole("separator", { name: "调整导航栏宽度" });
  const bounds = await separator.boundingBox();
  await page.mouse.move(bounds!.x + 4, bounds!.y + 80);
  await page.mouse.down();
  await page.mouse.move(bounds!.x + 90, bounds!.y + 80);
  await separator.dispatchEvent("pointercancel");
  await page.mouse.up();
  await expect(page.locator(".app-shell")).not.toHaveClass(/sidebar-resizing/);
  expect(await width(page)).toBe(208);
  expect((await pref(page)).width).toBe(208);
  await noOverflow(page);
});

test("review docks follow rail and drag while feedback and progress stay intact", async ({ page }, info) => {
  test.skip(info.project.name !== "desktop", "Desktop sidebar");
  await start(page);
  await page.locator(".sidebar nav").getByRole("button", { name: "复习", exact: true }).click();
  await expect(page.locator(".review-session")).toBeVisible();
  await settle(page);
  const feedback = page.getByRole("textbox", { name: "复习重点 1 本次评论" });
  await feedback.fill("侧栏调整不能丢失这段未提交评论");
  const progress = await page.getByRole("progressbar").getAttribute("aria-valuenow");
  for (const action of ["widen", "collapse", "expand"]) {
    if (action === "widen") await dragWidth(page, 112);
    else await page.getByRole("button", { name: action === "collapse" ? "收起左侧导航" : "展开左侧导航" }).click();
    await expect(feedback).toHaveValue("侧栏调整不能丢失这段未提交评论");
    await expect(page.getByRole("progressbar")).toHaveAttribute("aria-valuenow", progress!);
    const card = await page.locator(".review-record-card").boundingBox();
    const dock = await page.locator(".review-bottom-controls").boundingBox();
    expect(Math.abs(card!.x - dock!.x)).toBeLessThanOrEqual(1);
    expect(Math.abs(card!.width - dock!.width)).toBeLessThanOrEqual(1);
  }
  await page.getByRole("button", { name: "打开批注工具" }).click();
  await page.getByRole("button", { name: "收起左侧导航" }).click();
  const annotation = await page.getByRole("toolbar", { name: "批注工具栏" }).boundingBox();
  const card = await page.locator(".review-record-card").boundingBox();
  expect(Math.abs(annotation!.x - card!.x)).toBeLessThanOrEqual(1);
  await page.getByRole("button", { name: "关闭批注工具" }).click();
  await page.screenshot({ path: info.outputPath("review-rail.png"), animations: "disabled" });
});

test("journal preview keeps its selection and content through sidebar resizing", async ({ page }, info) => {
  test.skip(info.project.name !== "desktop", "Desktop sidebar");
  await start(page);
  await page.locator(".sidebar nav").getByRole("button", { name: "日志", exact: true }).click();
  await page.locator(".journal-library-records .record-card-main").first().click();
  const preview = page.getByRole("region", { name: "日志预览" });
  await expect(preview).toBeVisible();
  const title = await preview.locator("h2").first().innerText();
  for (const viewport of [1440, 1024, 960, 921]) {
    await page.setViewportSize({ width: viewport, height: 1000 });
    await page.getByRole("separator", { name: "调整导航栏宽度" }).press("End");
    await expect(page.locator(".journal-library-scroll")).toBeVisible();
    await expect(preview.locator("h2").first()).toHaveText(title);
    expect((await preview.boundingBox())!.width).toBeGreaterThanOrEqual(400);
    await noOverflow(page);
  }
  await page.getByRole("button", { name: "收起左侧导航" }).click();
  await expect(preview.locator("h2").first()).toHaveText(title);
  await page.screenshot({ path: info.outputPath("journal-rail.png"), animations: "disabled" });
});

test("rail geometry supports both themes, dark mode, large text and a desktop titlebar", async ({ page }, info) => {
  test.skip(info.project.name !== "desktop", "Desktop sidebar");
  await start(page);
  await page.getByRole("button", { name: "收起左侧导航" }).click();
  for (const visualTheme of ["reading", "modern"]) {
    for (const theme of ["light", "dark"]) {
      await page.evaluate(({ visualTheme, theme }) => {
        document.documentElement.dataset.visualTheme = visualTheme;
        document.documentElement.dataset.theme = theme;
        document.documentElement.dataset.desktopChrome = "true";
        document.documentElement.style.setProperty("--font-scale", "1.25");
      }, { visualTheme, theme });
      await page.setViewportSize({ width: 1024, height: 650 });
      const buttons = await page.locator(".sidebar button:visible").evaluateAll(elements => elements.map(element => element.getBoundingClientRect().toJSON()));
      for (const [index, button] of buttons.entries()) {
        expect(button.width).toBeGreaterThanOrEqual(44);
        expect(button.height).toBeGreaterThanOrEqual(44);
        expect(button.bottom).toBeLessThanOrEqual(650);
        for (const other of buttons.slice(index + 1)) expect(button.right <= other.left + 1 || other.right <= button.left + 1 || button.bottom <= other.top + 1 || other.bottom <= button.top + 1).toBe(true);
      }
      const edge = await page.locator(".sidebar-edge").boundingBox();
      expect(Math.abs(edge!.y + edge!.height / 2 - (650 + 36) / 2)).toBeLessThanOrEqual(1);
      await noOverflow(page);
      await page.screenshot({ path: info.outputPath(visualTheme + "-" + theme + ".png"), animations: "disabled" });
    }
  }
});

test("narrow layouts do not expose desktop resize tools or lose desktop preference", async ({ page }, info) => {
  test.skip(info.project.name !== "android-narrow", "Narrow sidebar boundary");
  await page.addInitScript(key => localStorage.setItem(key, JSON.stringify({ collapsed: true, width: 288 })), key);
  await start(page);
  for (const viewport of [920, 390, 320]) {
    await page.setViewportSize({ width: viewport, height: 844 });
    await expect(page.locator(".sidebar")).toBeHidden();
    await expect(page.locator(".sidebar-edge")).toBeHidden();
    await expect(page.getByRole("separator", { name: "调整导航栏宽度" })).toHaveCount(0);
    await expect(page.locator(".bottom-nav")).toBeVisible();
    await noOverflow(page);
  }
  expect(await pref(page)).toEqual({ collapsed: true, width: 288 });
});
