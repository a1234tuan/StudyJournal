import { expect, test } from "@playwright/test";

test.setTimeout(60000);

test("V2 visual contract preserves palette, hierarchy and reachable actions", async ({ page }, info) => {
  await page.goto("/?preview=journal-performance");
  await expect(page.locator(".today-study-aside")).toBeVisible();
  await page.evaluate(() => { document.documentElement.dataset.theme = "light"; document.documentElement.dataset.visualTheme = "reading"; });
  const palette = await page.evaluate(() => {
    const root = getComputedStyle(document.documentElement);
    return ["--color-bg", "--color-surface", "--color-primary", "--color-sidebar"].map(name => root.getPropertyValue(name).trim());
  });
  expect(palette).toEqual(["#f4f1ea", "#fffdf8", "#356047", "#eeece3"]);
  if (info.project.name === "desktop") {
    const sidebar = (await page.locator(".app-shell > .sidebar").boundingBox())!;
    expect(sidebar.width).toBe(208);
    const compose = (await page.locator(".today-compose-band").boundingBox())!;
    const links = (await page.locator(".today-home-links").boundingBox())!;
    const content = (await page.locator(".today-journal-column").boundingBox())!;
    const aside = (await page.locator(".today-study-aside").boundingBox())!;
    expect(Math.abs(compose.y - links.y)).toBeLessThan(2);
    expect(links.x).toBeGreaterThan(compose.x + compose.width);
    expect(aside.x).toBeGreaterThanOrEqual(content.x + content.width);
  }
  await page.locator(".today-create-options summary").click();
  const menu = (await page.locator(".today-create-options > div").boundingBox())!;
  expect(menu.x).toBeGreaterThanOrEqual(0);
  expect(menu.x + menu.width).toBeLessThanOrEqual(page.viewportSize()!.width);
  await expect(page.getByRole("combobox", { name: "新记录模板" })).toBeVisible();
  await page.locator(".today-create-options summary").click();
  const card = page.locator(".today-recent-records .record-card").first();
  await card.locator("summary").click();
  await expect(card.getByRole("status", { name: /待复习/ })).toBeVisible();
  await expect(card.getByRole("button", { name: /待复习/ })).toHaveCount(0);
  await expect(card.getByRole("button", { name: "取消收藏" })).toBeVisible();
  await card.getByRole("button", { name: "取消收藏" }).click();
  await expect(card.getByRole("button", { name: "收藏记录" })).toBeVisible();
  await card.locator("summary").click();
  await page.screenshot({ path: info.outputPath("today-v2.png"), animations: "disabled" });
  await page.getByRole("button", { name: "日志资料库", exact: true }).click();
  const filterToggle = page.getByRole("button", { name: "筛选日志", exact: true });
  if (await filterToggle.isVisible()) await filterToggle.click();
  await expect(page.getByRole("combobox", { name: "按学科筛选" })).toBeVisible();
  if (await filterToggle.isVisible()) await page.keyboard.press("Escape");
  const libraryCard = page.locator(".journal-library-records .record-card").first();
  await expect(libraryCard.locator(".record-card-actions > summary")).toBeVisible();
  await expect(libraryCard.locator(".record-action-items")).toBeHidden();
  await libraryCard.locator(".record-card-actions > summary").click();
  await expect(libraryCard.getByRole("button", { name: /^AI问答 / })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(libraryCard.locator(".record-action-items")).toBeHidden();
  await expect(libraryCard.locator("summary")).toBeFocused();
  await libraryCard.locator("summary").click();
  const secondCard = page.locator(".journal-library-records .record-card").nth(1);
  await secondCard.locator("summary").click();
  await expect(libraryCard.locator(".record-action-items")).toBeHidden();
  await expect(secondCard.locator(".record-action-items")).toBeVisible();
  await page.locator(".journal-page h1").click();
  await expect(secondCard.locator(".record-action-items")).toBeHidden();
  await libraryCard.locator(".record-card-main").click();
  await page.screenshot({ path: info.outputPath("journal-v2.png"), animations: "disabled" });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
});

test("workspace themes and enlarged type keep tools inside the viewport", async ({ page }, info) => {
  test.skip(info.project.name !== "desktop", "Shared resize matrix");
  await page.goto("/?preview=journal-performance");
  await expect(page.locator(".today-study-aside")).toBeVisible();
  for (const width of [1920, 1440, 1024, 390, 320]) {
    await page.setViewportSize({ width, height: 980 });
    for (const theme of ["light", "dark"]) {
      await page.evaluate(theme => { document.documentElement.dataset.theme = theme; document.documentElement.style.setProperty("--font-scale", "1.25"); }, theme);
      await page.locator(".today-create-options summary").click();
      const menu = (await page.locator(".today-create-options > div").boundingBox())!;
      expect(menu.x).toBeGreaterThanOrEqual(0);
      expect(menu.x + menu.width).toBeLessThanOrEqual(width + 1);
      await page.locator(".today-create-options summary").click();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
      await page.screenshot({ path: info.outputPath("today-" + width + "-" + theme + ".png"), animations: "disabled" });
    }
  }
  await page.setViewportSize({ width: 1440, height: 980 });
  await page.emulateMedia({ colorScheme: "dark" });
  await page.evaluate(() => { document.documentElement.dataset.theme = "system"; });
  for (const visualTheme of ["reading", "modern"]) {
    await page.evaluate(visualTheme => { document.documentElement.dataset.visualTheme = visualTheme; }, visualTheme);
    const colors = await page.locator(".today-compose-main").evaluate(button => ({ foreground: getComputedStyle(button).color, background: getComputedStyle(button).backgroundColor }));
    expect(colors.foreground).not.toBe(colors.background);
    await page.screenshot({ path: info.outputPath("today-system-dark-" + visualTheme + ".png"), animations: "disabled" });
  }
});
