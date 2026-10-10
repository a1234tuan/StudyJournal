import { expect, test, type Page } from "@playwright/test";

test("scrollbars remain discoverable without shifting journal tabs", async ({ page }, info) => {
  await page.goto("/?preview=journal-performance");
  await expect(page.locator(".today-page")).toBeVisible();
  await page.getByRole("button", { name: "日志资料库", exact: true }).click();
  await expect(page.locator(".page-transition-layer-entering, .page-transition-layer-exiting")).toHaveCount(0);
  const root = page.locator("html");
  const list = page.locator(".journal-library-scroll");
  await expect(root).toHaveCSS("scrollbar-gutter", "stable");
  await expect(root).toHaveCSS("scrollbar-width", "thin");
  await expect(list).toHaveCSS("scrollbar-width", "thin");
  const header = await page.locator(".journal-page > .page-header").boundingBox();
  const before = await list.boundingBox();
  await list.hover();
  expect(await list.boundingBox()).toEqual(before);
  const available = await list.evaluate(element => element.scrollHeight - element.clientHeight);
  expect(available).toBeGreaterThan(0);
  await list.evaluate(element => { element.scrollTop = 180; });
  await expect.poll(() => list.evaluate(element => element.scrollTop)).toBeGreaterThan(100);
  if (info.project.name === "desktop") {
    const position = await list.evaluate(element => element.scrollTop);
    await page.mouse.wheel(0, 200);
    await expect.poll(() => list.evaluate(element => element.scrollTop)).toBeGreaterThan(position);
    await list.locator(".record-card-main").first().focus();
    await page.keyboard.press("PageDown");
    await expect.poll(() => list.evaluate(element => element.scrollTop)).toBeGreaterThan(0);
  }
  await page.getByRole("tab", { name: "按日期", exact: true }).click();
  expect(await page.locator(".journal-page > .page-header").boundingBox()).toEqual(header);
  await page.getByRole("tab", { name: "全部日志", exact: true }).click();
  expect(await page.locator(".journal-page > .page-header").boundingBox()).toEqual(header);
  await page.screenshot({ path: info.outputPath("journal-scrollbars.png"), animations: "disabled" });
  await page.emulateMedia({ forcedColors: "active" });
  await expect(root).toHaveCSS("scrollbar-color", "auto");
  await expect(list).toHaveCSS("scrollbar-width", "auto");
});

const palette = (page: Page) => page.evaluate(() => {
  const style = getComputedStyle(document.documentElement);
  return Object.fromEntries(["bg", "surface", "sidebar", "nav-active", "text", "muted", "primary", "primary-strong", "primary-soft", "on-primary", "accent", "accent-strong", "accent-soft"].map(name => [name, style.getPropertyValue("--color-" + name).trim()]));
});

const contrast = (foreground: string, background: string) => {
  const luminance = (hex: string) => {
    const channels = hex.slice(1).match(/../g)!.map(channel => {
      const value = parseInt(channel, 16) / 255;
      return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
    });
    return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722;
  };
  const values = [luminance(foreground), luminance(background)].sort((left, right) => right - left);
  return (values[0] + 0.05) / (values[1] + 0.05);
};

test("theme palettes stay distinct, accessible and consistent with system mode", async ({ page }, info) => {
  await page.goto("/?preview=stage3");
  await expect(page.locator(".today-page")).toBeVisible();
  const nav = page.locator(info.project.name === "desktop" ? ".sidebar nav" : ".bottom-nav");
  await nav.getByRole("button", { name: "更多", exact: true }).click();
  await page.locator(".more-page").getByRole("button", { name: /^设置/ }).click();
  await expect(page.locator(".settings-page")).toBeVisible();
  await expect(page.locator(".page-transition-layer-entering, .page-transition-layer-exiting")).toHaveCount(0);
  const header = await page.locator(".settings-page > .page-header").boundingBox();
  const mode = page.getByRole("combobox", { name: "明暗模式", exact: true });
  const themes: Record<string, Record<string, string>> = {};
  for (const [visualTheme, label] of [["reading", "温润阅读"], ["modern", "清爽现代"]]) {
    await page.getByRole("button", { name: new RegExp(label) }).click();
    await expect(page.locator("html")).toHaveAttribute("data-visual-theme", visualTheme);
    for (const colorMode of ["light", "dark"] as const) {
      await mode.selectOption(colorMode);
      await expect(page.locator("html")).toHaveAttribute("data-theme", colorMode);
      const colors = await palette(page);
      for (const surface of ["bg", "surface", "sidebar"]) {
        expect(contrast(colors.text, colors[surface])).toBeGreaterThanOrEqual(4.5);
        expect(contrast(colors.muted, colors[surface])).toBeGreaterThanOrEqual(4.5);
      }
      expect(contrast(colors["on-primary"], colors.primary)).toBeGreaterThanOrEqual(4.5);
      expect(contrast(colors["primary-strong"], colors["nav-active"])).toBeGreaterThanOrEqual(4.5);
      themes[visualTheme + colorMode] = colors;
      expect(await page.locator(".settings-page > .page-header").boundingBox()).toEqual(header);
      await page.emulateMedia({ colorScheme: colorMode });
      await mode.selectOption("system");
      await expect(page.locator("html")).toHaveAttribute("data-theme", "system");
      expect(await palette(page)).toEqual(colors);
      await page.screenshot({ path: info.outputPath(visualTheme + "-" + colorMode + ".png"), animations: "disabled" });
    }
  }
  for (const colorMode of ["light", "dark"]) {
    for (const role of ["bg", "surface", "sidebar", "nav-active", "text", "primary"]) {
      expect(themes["reading" + colorMode][role]).not.toBe(themes["modern" + colorMode][role]);
    }
  }
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("data-visual-theme", "modern");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "system");
  expect(await palette(page)).toEqual(themes.moderndark);
});
