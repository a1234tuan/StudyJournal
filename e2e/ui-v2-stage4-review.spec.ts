import { expect, test } from "@playwright/test";

test.setTimeout(60_000);

const assertNoHorizontalOverflow = async (page: import("@playwright/test").Page) => {
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(1);
};

for (const theme of ["reading", "modern"] as const) {
  test(`stage 4 exposes review coach and returns adaptive tasks to it in ${theme}`, async ({ page }, testInfo) => {
    const errors: string[] = [];
    page.on("console", (message) => {
      const text = message.text();
      if (message.type() === "error" && !text.startsWith("Warning: flushSync was called from inside a lifecycle method.")) errors.push(text);
    });
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("response", (response) => {
      if (response.status() === 401) errors.push(`HTTP 401 ${response.url()}`);
    });
    await page.route("https://api.deepseek.com/**", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          id: "stage4-ui-mock",
          choices: [{ finish_reason: "stop", message: { content: JSON.stringify({
            status: "ok",
            actionability: "needs_training",
            difficultyType: "procedure",
            stuckAt: "关键步骤的执行顺序",
            userHypothesis: "边界条件尚未稳定",
            preferredPractice: "variation",
            missingInformation: [],
            confidence: 0.84,
          }) } }],
          usage: { prompt_tokens: 120, completion_tokens: 40, total_tokens: 160 },
        }),
      });
    });
    await page.addInitScript(([key, value]) => localStorage.setItem(key, value), ["study-journal-visual-theme-v1", theme]);

    await page.goto("/?preview=stage6");
    await page.getByRole("button", { name: /^复习/ }).first().click();
    await expect(page.getByRole("button", { name: "返回复习", exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "日志复习", exact: true })).toHaveCount(0);
    await page.getByRole("button", { name: "返回复习", exact: true }).click();
    await expect(page.getByRole("button", { name: "日志复习", exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "卡片库", exact: true })).toHaveClass(/active/);
    await page.getByRole("button", { name: "日志复习", exact: true }).click();
    await expect(page.getByRole("button", { name: "返回复习", exact: true })).toBeVisible();
    await page.getByRole("button", { name: "返回复习", exact: true }).click();
    await page.getByRole("button", { name: "学习助教", exact: true }).click();
    await expect(page.getByRole("heading", { name: "学习助教" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "复习助教" })).toBeVisible();
    await expect(page.getByText("进行中", { exact: true })).toBeVisible();
    await assertNoHorizontalOverflow(page);
    await page.screenshot({ path: testInfo.outputPath(`stage4-coach-${theme}.png`), fullPage: true });

    await page.getByRole("button", { name: "继续训练" }).click();
    await expect(page.getByRole("heading", { name: /BFS 中首次发现/ })).toBeVisible();
    await expect(page.getByRole("textbox", { name: "你的回答" })).toBeVisible();
    await expect(page.locator(".bottom-nav")).toBeHidden();
    await page.locator("html").evaluate((element) => element.style.setProperty("--font-scale", "1.25"));
    await assertNoHorizontalOverflow(page);
    await page.screenshot({ path: testInfo.outputPath(`stage4-adaptive-${theme}.png`), fullPage: true });

    await page.getByRole("button", { name: "返回", exact: true }).click();
    await expect(page.getByRole("heading", { name: "学习助教" })).toBeVisible();
    await expect(page.getByRole("button", { name: "学习助教", exact: true })).toHaveClass(/active/);
    await assertNoHorizontalOverflow(page);
    expect(errors).toEqual([]);
  });
}

test("keeps rating undo across tabs and exposes annotation tools", async ({ page }) => {
  await page.goto("/?preview=stage3");
  await page.getByRole("button", { name: /^复习/ }).first().click();

  const annotationEntry = page.getByRole("button", { name: "打开批注工具" });
  await annotationEntry.click();
  await expect(page.getByRole("button", { name: "关闭批注工具" })).toHaveAttribute("aria-pressed", "true");
  const toolbar = page.getByRole("toolbar", { name: "批注工具栏" });
  await expect(toolbar).toBeVisible();
  await expect(page.getByRole("button", { name: "浏览", exact: true })).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByTitle("画笔")).toBeVisible();
  await page.getByRole("button", { name: "矩形", exact: true }).click();
  await expect(page.getByRole("button", { name: "矩形", exact: true })).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByRole("button", { name: "浏览", exact: true })).toHaveAttribute("aria-pressed", "false");
  await expect(page.getByText("当前：矩形", { exact: true })).toBeVisible();
  await expect(page.getByTitle("输入框")).toBeVisible();
  await expect(page.getByTitle("下拉选择")).toBeVisible();
  const toolbarBox = await toolbar.boundingBox();
  const viewport = page.viewportSize();
  expect(toolbarBox).not.toBeNull();
  expect(viewport).not.toBeNull();
  expect(toolbarBox!.y).toBeGreaterThanOrEqual(0);
  expect(toolbarBox!.y + toolbarBox!.height).toBeLessThanOrEqual(viewport!.height);
  // The rating controls stay available while annotating; the toolbar docks above
  // them instead of hiding or covering them.
  const ratingBar = page.locator(".review-bottom-controls");
  await expect(ratingBar).toBeVisible();
  const ratingBox = await ratingBar.boundingBox();
  expect(ratingBox).not.toBeNull();
  expect(toolbarBox!.y + toolbarBox!.height).toBeLessThanOrEqual(ratingBox!.y + 1);

  await page.getByRole("button", { name: "浏览", exact: true }).click();
  await page.getByRole("button", { name: "关闭批注工具" }).click();
  await expect(page.locator(".review-bottom-controls")).toBeVisible();
  await page.getByRole("button", { name: "打开复习更多菜单" }).click();
  await page.getByRole("menuitem", { name: "语音复述当前卡片" }).click();
  await expect(page.getByRole("heading", { name: "把刚学过的内容讲出来" })).toBeVisible();
  await expect(page.locator(".vr-setup-copy h2")).toHaveText("BFS Stage3 Preview");
  await expect(page.getByRole("button", { name: "开始语音复述" })).toBeVisible();
  await page.getByRole("button", { name: "返回复习" }).click();
  await expect(page.getByRole("heading", { name: "BFS Stage3 Preview" })).toBeVisible();

  await page.getByRole("button", { name: /良好/ }).click();
  await page.getByRole("button", { name: "今天", exact: true }).click();
  await page.getByRole("button", { name: /^复习/ }).first().click();
  await page.getByRole("button", { name: "打开复习更多菜单" }).click();
  const undo = page.getByRole("menuitem", { name: /撤回上次评分/ });
  await expect(undo).toBeEnabled();
  await undo.click();
  await expect(page.getByRole("heading", { name: "BFS Stage3 Preview" })).toBeVisible();
});
