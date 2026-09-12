import { expect, test } from "@playwright/test";

test.setTimeout(60_000);

const assertNoHorizontalOverflow = async (page: import("@playwright/test").Page) => {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(1);
};

test("stage 2 formal app keeps both visual themes usable across today and library", async ({ page }, testInfo) => {
  const errors: string[] = [];
  page.on("console", (message) => {
    const text = message.text();
    const knownTiptapDevWarning = text.startsWith("Warning: flushSync was called from inside a lifecycle method.");
    if (message.type() === "error" && !knownTiptapDevWarning) errors.push(text);
  });
  page.on("pageerror", (error) => errors.push(error.message));

  await page.goto("/?preview=stage3");
  if (testInfo.project.name === "android-narrow") {
    const navCentering = await page.locator(".bottom-nav").evaluate((nav) => {
      const create = nav.querySelector<HTMLElement>(".bottom-nav-create");
      if (!create) return Number.POSITIVE_INFINITY;
      const navRect = nav.getBoundingClientRect();
      const createRect = create.getBoundingClientRect();
      return Math.abs((navRect.top + navRect.bottom - createRect.top - createRect.bottom) / 2);
    });
    expect(navCentering).toBeLessThanOrEqual(1.5);
  }
  await expect(page.locator("html")).toHaveAttribute("data-visual-theme", "reading");
  await expect(page.getByRole("heading", { name: "今天想记下什么？" })).toBeVisible();
  await expect(page.getByRole("button", { name: /新建 .* 记录/ })).toBeVisible();
  await expect(page.locator(".today-page").getByText("BFS Stage3 Preview", { exact: true }).first()).toBeVisible();
  if (testInfo.project.name === "desktop") {
    await page.getByRole("button", { name: "打开置顶日志 BFS Stage3 Preview" }).click();
    await expect(page.getByRole("heading", { name: "BFS Stage3 Preview" })).toBeVisible();
    await page.getByRole("button", { name: "返回", exact: true }).click();
    await expect(page.getByRole("heading", { name: "今天想记下什么？" })).toBeVisible();
  }
  await page.waitForTimeout(4_500);
  await assertNoHorizontalOverflow(page);
  await page.screenshot({ path: testInfo.outputPath("stage2-today-reading.png"), fullPage: true });

  await page.getByRole("button", { name: "日志", exact: true }).first().click();
  await expect(page.getByRole("heading", { name: "日志资料库" })).toBeVisible();
  await expect(page.getByRole("tab", { name: "全部日志" })).toHaveAttribute("aria-selected", "true");
  await expect(page.locator(".journal-page").getByText("BFS Stage3 Preview", { exact: true }).first()).toBeVisible();
  await page.waitForTimeout(350);
  await assertNoHorizontalOverflow(page);
  await page.screenshot({ path: testInfo.outputPath("stage2-library-reading.png"), fullPage: true });

  if (testInfo.project.name === "android-narrow") {
    await page.getByRole("button", { name: "更多", exact: true }).last().click();
    await page.getByRole("button", { name: /设置/ }).last().click();
  } else {
    await page.getByRole("button", { name: "设置", exact: true }).click();
  }
  await expect(page.getByRole("heading", { name: "设置" })).toBeVisible();
  await expect(page.locator("label").filter({ hasText: "界面字号" })).toHaveCount(1);
  await expect(page.locator("label").filter({ hasText: "正文字号" })).toHaveCount(1);
  const typographySliders = page.getByRole("slider");
  await expect(typographySliders).toHaveCount(3);
  await typographySliders.nth(1).focus();
  await page.keyboard.press("ArrowRight");
  await expect.poll(() => page.locator("html").evaluate((element) => element.style.getPropertyValue("--editor-font-scale"))).toBe("1.05");
  await page.getByRole("button", { name: /清爽现代/ }).click();
  await expect(page.locator("html")).toHaveAttribute("data-visual-theme", "modern");
  await page.getByRole("button", { name: "日志", exact: true }).first().click();
  await expect(page.getByRole("heading", { name: "日志资料库" })).toBeVisible();
  await page.waitForTimeout(350);
  await assertNoHorizontalOverflow(page);
  await page.screenshot({ path: testInfo.outputPath("stage2-library-modern.png"), fullPage: true });

  await page.locator("html").evaluate((element) => element.style.setProperty("--font-scale", "1.25"));
  await assertNoHorizontalOverflow(page);
  await expect(page.getByRole("heading", { name: "日志资料库" })).toBeVisible();

  expect(errors).toEqual([]);
});
