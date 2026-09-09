import { expect, test } from "@playwright/test";

test.setTimeout(60_000);

const noOverflow = async (page: import("@playwright/test").Page) => {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
};

for (const theme of ["reading", "modern"] as const) {
  test(`stage 5 keeps tools, search, categories and AI input usable in ${theme}`, async ({ page }, testInfo) => {
    const errors: string[] = [];
    page.on("console", (message) => {
      const text = message.text();
      if (message.type() === "error" && !text.startsWith("Warning: flushSync was called")) errors.push(text);
    });
    page.on("pageerror", (error) => errors.push(error.message));
    await page.addInitScript(([key, value]) => localStorage.setItem(key, value), ["study-journal-visual-theme-v1", theme]);
    await page.goto("/?preview=stage5");

    await page.getByRole("button", { name: "更多", exact: true }).first().click();
    await expect(page.getByRole("heading", { name: "更多" })).toBeVisible();
    // More rows no longer carry a description, so "分类管理" is also the sidebar
    // entry's name; scope to the More page to keep the target unambiguous.
    await page.locator(".more-page").getByRole("button", { name: "分类管理", exact: true }).click();
    await expect(page.getByRole("heading", { name: "学科分类" })).toBeVisible();
    await noOverflow(page);

    await page.getByRole("button", { name: "更多", exact: true }).first().click();
    await page.getByRole("button", { name: /AI 问答/ }).click();
    await page.getByRole("button", { name: "新建知识库问答", exact: true }).click();
    await page.getByRole("tab", { name: "近期学习" }).click();
    await page.getByRole("button", { name: "创建问答" }).click();
    const composer = page.getByPlaceholder("问问 AI...");
    await expect(composer).toBeVisible();
    await composer.fill("请结合这些学习记录解释 BFS 中 visited 与 predecessor 的更新顺序，并给出一个反例。");
    await expect(page.locator(".bottom-nav")).toBeHidden();
    const composerBounds = await composer.boundingBox();
    expect(composerBounds).not.toBeNull();
    expect(composerBounds!.y + composerBounds!.height).toBeLessThanOrEqual((await page.evaluate(() => window.innerHeight)) + 1);
    await noOverflow(page);
    await page.screenshot({ path: testInfo.outputPath(`stage5-ai-${theme}.png`), fullPage: true });

    await page.getByRole("button", { name: "返回", exact: true }).click();
    await page.getByRole("button", { name: "日志", exact: true }).first().click();
    await page.getByRole("button", { name: "全局搜索" }).click();
    await page.getByPlaceholder(/搜索中值定理/).fill("BFS");
    await expect(page.locator(".search-result").filter({ hasText: "BFS Stage3 Preview" })).toBeVisible();
    await page.locator("html").evaluate((element) => element.style.setProperty("--font-scale", "1.25"));
    await noOverflow(page);
    await page.screenshot({ path: testInfo.outputPath(`stage5-search-${theme}.png`), fullPage: true });

    expect(errors).toEqual([]);
  });
}
