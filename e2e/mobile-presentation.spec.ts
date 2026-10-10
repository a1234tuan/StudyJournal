import { expect, test } from "@playwright/test";

test("mobile today prioritizes tasks and has a compact header", async ({ page }, info) => {
  test.skip(info.project.name !== "android-narrow", "Mobile presentation gate");
  await page.goto("/?preview=stage3");
  await expect(page.locator("html")).toHaveAttribute("data-mobile-ui", "true");
  await expect(page.locator(".today-page")).toBeVisible();
  await expect(page.locator(".today-compose-main")).toHaveText("新建记录");
  for (const width of [390, 320, 412]) {
    await page.setViewportSize({ width, height: 844 });
    const header = await page.locator(".today-page .page-header").boundingBox();
    expect(header!.height).toBeLessThanOrEqual(72);
    const study = await page.locator(".today-study-aside").boundingBox();
    const journal = await page.locator(".today-journal-column").boundingBox();
    expect(study!.y + study!.height).toBeLessThanOrEqual(journal!.y);
    expect(study!.width).toBeGreaterThan(width * .8);
    const goal = await page.locator(".today-goal-summary").boundingBox();
    expect(goal!.height).toBeLessThan(80);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
    await expect(page.getByRole("button", { name: "打开今日计划" })).toBeVisible();
    await expect(page.getByRole("button", { name: "打开收藏夹" })).toBeVisible();
    await page.screenshot({ path: info.outputPath("today-" + width + ".png"), animations: "disabled" });
  }
});

test("mobile reading removes duplicate workspace chrome and returns to the same list", async ({ page }, info) => {
  test.skip(info.project.name !== "android-narrow", "Mobile reading gate");
  await page.goto("/?preview=journal-performance");
  await page.getByRole("button", { name: "日志资料库", exact: true }).click();
  const list = page.locator(".journal-library-scroll");
  await list.evaluate(element => { element.scrollTop = 120; element.dispatchEvent(new Event("scroll", { bubbles: true })); });
  const position = await list.evaluate(element => element.scrollTop);
  await page.locator(".journal-library-records .record-card-main").nth(2).click();
  const preview = page.getByRole("region", { name: "日志预览" });
  await expect(preview).toBeVisible();
  await expect(page.locator(".journal-page > .page-header")).toBeHidden();
  await expect(page.locator(".journal-toolbar")).toBeHidden();
  expect((await preview.boundingBox())!.y).toBeLessThan(10);
  await page.screenshot({ path: info.outputPath("mobile-reading.png"), animations: "disabled", scale: "css" });
  await page.getByRole("button", { name: "返回列表" }).click();
  await expect(preview).toHaveCount(0);
  await expect.poll(() => list.evaluate(element => element.scrollTop)).toBe(position);
});

test("mobile enlarged type preserves utilities, theme controls and return", async ({ page }, info) => {
  test.skip(info.project.name !== "android-narrow", "Large type gate");
  await page.setViewportSize({ width: 320, height: 844 });
  await page.goto("/?preview=stage3");
  await page.locator(".bottom-nav").getByRole("button", { name: "更多", exact: true }).click();
  await page.locator(".more-page").getByRole("button", { name: /^设置/ }).click();
  await page.getByRole("slider", { name: "界面字号", exact: true }).fill("1.25");
  for (const theme of ["温润阅读", "清爽现代"]) {
    await page.getByRole("button", { name: new RegExp(theme) }).click();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
    await expect(page.getByRole("button", { name: "返回", exact: true })).toBeVisible();
  }
  await page.screenshot({ path: info.outputPath("settings-large.png"), animations: "disabled", scale: "css" });
  await page.getByRole("button", { name: "返回", exact: true }).click();
  await expect(page.locator(".more-page")).toBeVisible();
});

test("desktop has no mobile stylesheet leakage", async ({ page }, info) => {
  test.skip(info.project.name !== "desktop", "Desktop isolation gate");
  await page.goto("/?preview=stage3");
  await expect(page.locator("html")).toHaveAttribute("data-mobile-ui", "false");
  await page.getByRole("button", { name: "开始复习", exact: true }).click();
  await expect(page.locator(".review-mode-tabs")).toBeVisible();
  await expect(page.getByRole("button", { name: "复习看板", exact: true })).toBeVisible();
  await expect(page.locator(".page-transition-layer-exiting, .page-transition-layer-entering")).toHaveCount(0);
  const before = await page.screenshot({ animations: "disabled" });
  await page.evaluate(() => {
    document.querySelectorAll('style[data-vite-dev-id$="/styles/mobile.css"]').forEach(element => element.remove());
  });
  expect(await page.screenshot({ animations: "disabled" })).toEqual(before);
  await page.screenshot({ path: info.outputPath("desktop-review.png"), animations: "disabled", scale: "css" });
});

test("mobile mode menu waits for pending review writes", async ({ page }, info) => {
  test.skip(info.project.name !== "android-narrow", "Mobile navigation guard");
  await page.goto("/?preview=stage3");
  await page.getByRole("button", { name: "开始复习", exact: true }).click();
  await expect(page.locator(".review-record-card")).toBeVisible();
  await page.evaluate(async () => {
    const { registerReviewNavigationCheck } = await import("/src/features/reviewSession/navigationGuard.ts");
    const scope = window as unknown as { releaseMobileGuard: () => void; mobileGuardCalls: number };
    scope.mobileGuardCalls = 0;
    const pending = new Promise<void>(resolve => { scope.releaseMobileGuard = resolve; });
    const unregister = registerReviewNavigationCheck(() => { scope.mobileGuardCalls += 1; return pending.then(unregister); });
  });
  await page.getByRole("button", { name: "打开复习更多菜单" }).click();
  await page.getByRole("menuitem", { name: "学习助教", exact: true }).click();
  await expect.poll(() => page.evaluate(() => (window as unknown as { mobileGuardCalls: number }).mobileGuardCalls)).toBeGreaterThan(0);
  await expect(page.locator(".review-record-card")).toBeVisible();
  await page.evaluate(() => (window as unknown as { releaseMobileGuard: () => void }).releaseMobileGuard());
  await expect(page.locator(".review-record-card")).toHaveCount(0);
  await expect(page.locator(".review-mode-tabs")).toBeVisible();
  await expect(page.locator(".bottom-nav")).toBeVisible();
});

test("mobile review keeps one task dock and working menu exits", async ({ page }, info) => {
  test.skip(info.project.name !== "android-narrow", "Mobile presentation gate");
  await page.goto("/?preview=stage3");
  await page.getByRole("button", { name: "开始复习", exact: true }).click();
  await expect(page.locator(".review-record-card")).toBeVisible();
  await expect(page.locator(".bottom-nav")).toBeHidden();
  await expect(page.locator(".review-mode-tabs")).toHaveCount(0);
  for (const width of [390, 320]) {
    await page.setViewportSize({ width, height: 844 });
    const card = await page.locator(".review-record-card").boundingBox();
    expect(card!.y).toBeLessThan(150);
    const toolbar = await page.locator(".review-session-chrome").boundingBox();
    for (const control of await page.locator(".review-session-chrome button:visible").evaluateAll(elements => elements.map(element => element.getBoundingClientRect().toJSON()))) {
      expect(control.height).toBeGreaterThanOrEqual(48);
      expect(control.right).toBeLessThanOrEqual(toolbar!.x + toolbar!.width + 1);
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
    await page.screenshot({ path: info.outputPath("review-" + width + ".png"), animations: "disabled" });
  }
  await page.getByRole("button", { name: "打开复习更多菜单" }).click();
  await page.getByRole("menuitem", { name: "复习看板", exact: true }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await page.getByRole("button", { name: "打开复习更多菜单" }).click();
  await page.getByRole("menuitem", { name: "卡片库", exact: true }).click();
  await expect(page.locator(".review-mode-tabs")).toBeVisible();
  await expect(page.locator(".bottom-nav")).toBeVisible();
  await page.getByRole("button", { name: "日志复习", exact: true }).click();
  await expect(page.locator(".review-record-card")).toBeVisible();
  await page.getByRole("button", { name: "打开批注工具" }).click();
  await expect(page.getByRole("toolbar", { name: "批注工具栏" })).toBeVisible();
  await page.getByRole("button", { name: "关闭批注工具" }).click();
  await page.getByRole("button", { name: "打开复习更多菜单" }).click();
  await page.getByRole("menuitem", { name: "编辑原日志", exact: true }).click();
  await page.getByRole("textbox", { name: "记录标题", exact: true }).fill("移动端编辑返回验收");
  await page.getByRole("button", { name: "保存", exact: true }).click();
  await expect.poll(() => page.evaluate(async () => {
    const { db } = await import("/src/db/database.ts");
    return (await db.blocks.get("stage3-preview-record"))?.title;
  })).toBe("移动端编辑返回验收");
  await page.getByRole("button", { name: "返回", exact: true }).first().click();
  await expect(page.locator(".review-record-card h1")).toHaveText("移动端编辑返回验收");
  await expect(page.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "0");
});
