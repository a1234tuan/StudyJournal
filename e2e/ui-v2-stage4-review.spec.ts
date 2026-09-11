import { expect, test } from "@playwright/test";

test.setTimeout(60_000);

const assertNoHorizontalOverflow = async (page: import("@playwright/test").Page) => {
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(1);
};

test("desktop review layout, brand and click feedback use the new visual hierarchy", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "Desktop layout acceptance");
  await page.goto("/?preview=stage3");

  const brand = page.locator(".brand");
  await expect(brand).toContainText("学习日志");
  await expect(brand).not.toContainText("离线优先");
  await expect(brand.locator(".brand-mark svg")).toBeVisible();

  const todayButton = page.locator(".sidebar nav button").first();
  const tapHighlight = await todayButton.evaluate((element) => getComputedStyle(element).webkitTapHighlightColor);
  expect(tapHighlight).toBe("rgba(0, 0, 0, 0)");
  await todayButton.click();
  expect(await todayButton.evaluate((element) => getComputedStyle(element).outlineStyle)).toBe("none");
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.keyboard.press("Tab");
  const keyboardOutline = await page.locator(":focus").evaluate((element) => {
    const style = getComputedStyle(element);
    return { style: style.outlineStyle, width: style.outlineWidth };
  });
  expect(keyboardOutline.style).toBe("solid");
  expect(Number.parseFloat(keyboardOutline.width)).toBeGreaterThan(0);

  await page.getByRole("button", { name: "日志", exact: true }).click();
  const journalCard = page.locator(".record-card").first();
  await expect(journalCard).toBeVisible();
  const cardHierarchy = await journalCard.evaluate((card) => {
    const title = card.querySelector(".record-card-copy > strong")!;
    const excerpt = card.querySelector(".record-card-excerpt")!;
    const meta = card.querySelector(".record-card-meta")!;
    const titleStyle = getComputedStyle(title);
    const excerptStyle = getComputedStyle(excerpt);
    const metaStyle = getComputedStyle(meta);
    return {
      ordered: title.compareDocumentPosition(excerpt) === Node.DOCUMENT_POSITION_FOLLOWING
        && excerpt.compareDocumentPosition(meta) === Node.DOCUMENT_POSITION_FOLLOWING,
      titleSize: Number.parseFloat(titleStyle.fontSize),
      excerptSize: Number.parseFloat(excerptStyle.fontSize),
      titleWeight: Number.parseFloat(titleStyle.fontWeight),
      excerptWeight: Number.parseFloat(excerptStyle.fontWeight),
      titleColor: titleStyle.color,
      excerptColor: excerptStyle.color,
      metaColor: metaStyle.color,
    };
  });
  expect(cardHierarchy.ordered).toBe(true);
  expect(cardHierarchy.titleSize).toBeGreaterThan(cardHierarchy.excerptSize);
  expect(cardHierarchy.titleWeight).toBeGreaterThan(cardHierarchy.excerptWeight);
  expect(cardHierarchy.titleColor).not.toBe(cardHierarchy.excerptColor);
  expect(cardHierarchy.titleColor).not.toBe(cardHierarchy.metaColor);

  await page.getByRole("button", { name: /^复习/ }).first().click();
  await expect(page.getByRole("heading", { name: "BFS Stage3 Preview" })).toBeVisible();
  const sessionGeometry = await page.evaluate(() => {
    const content = document.querySelector(".content-area")!.getBoundingClientRect();
    const card = document.querySelector(".review-record-card")!.getBoundingClientRect();
    const body = document.querySelector(".review-annotation-root")!.getBoundingClientRect();
    const focus = document.querySelector(".decision-block-reflection-list")!.getBoundingClientRect();
    return {
      centerDelta: Math.abs((content.left + content.width / 2) - (card.left + card.width / 2)),
      cardWidth: card.width,
      focusAfterBody: focus.top >= body.bottom - 1,
    };
  });
  expect(sessionGeometry.centerDelta).toBeLessThanOrEqual(1);
  expect(sessionGeometry.cardWidth).toBeLessThanOrEqual(760.5);
  expect(sessionGeometry.focusAfterBody).toBe(true);
  await page.screenshot({ path: testInfo.outputPath("desktop-review-centered.png"), fullPage: false });

  await page.getByRole("button", { name: "返回复习", exact: true }).click();
  await expect(page.getByRole("button", { name: "卡片库", exact: true })).toHaveClass(/active/);
  const libraryGeometry = await page.evaluate(() => {
    const library = document.querySelector(".review-library")!.getBoundingClientRect();
    const scope = document.querySelector(".review-deck-sidebar")!.getBoundingClientRect();
    const content = document.querySelector(".review-library-content")!.getBoundingClientRect();
    return {
      widthDelta: Math.abs(library.width - content.width),
      centerDelta: Math.abs((library.left + library.width / 2) - (content.left + content.width / 2)),
      scopeWidthDelta: Math.abs(library.width - scope.width),
    };
  });
  expect(libraryGeometry.widthDelta).toBeLessThanOrEqual(1);
  expect(libraryGeometry.centerDelta).toBeLessThanOrEqual(1);
  expect(libraryGeometry.scopeWidthDelta).toBeLessThanOrEqual(1);
  const scopePanel = page.locator(".review-deck-panel");
  await expect(scopePanel).not.toHaveAttribute("open");
  await scopePanel.locator("summary").click();
  await expect(scopePanel).toHaveAttribute("open", "");
  await assertNoHorizontalOverflow(page);
  await page.screenshot({ path: testInfo.outputPath("desktop-review-library.png"), fullPage: false });
});

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

test("keeps rating undo across tabs and exposes annotation tools", async ({ page }, testInfo) => {
  await page.goto("/?preview=stage3");
  await page.getByRole("button", { name: /^复习/ }).first().click();

  const viewport = page.viewportSize();
  expect(viewport).not.toBeNull();
  const ratingBar = page.locator(".review-bottom-controls");
  await expect(ratingBar).toBeVisible();
  await page.waitForTimeout(180);
  const ratingAtTop = await ratingBar.boundingBox();
  expect(ratingAtTop).not.toBeNull();
  expect(viewport!.height - ratingAtTop!.y - ratingAtTop!.height).toBeGreaterThanOrEqual(8);
  expect(viewport!.height - ratingAtTop!.y - ratingAtTop!.height).toBeLessThanOrEqual(32);

  const annotationEntry = page.getByRole("button", { name: "打开批注工具" });
  const entryAtTop = await annotationEntry.boundingBox();
  expect(entryAtTop).not.toBeNull();
  await page.locator(".review-annotation-root").evaluate((element) => { (element as HTMLElement).style.minHeight = "1400px"; });
  await page.evaluate(() => window.scrollTo(0, 480));
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(0);
  const entryAfterScroll = await annotationEntry.boundingBox();
  const ratingAfterScroll = await ratingBar.boundingBox();
  expect(Math.abs(entryAfterScroll!.y - entryAtTop!.y)).toBeLessThanOrEqual(1);
  expect(Math.abs(ratingAfterScroll!.y - ratingAtTop!.y)).toBeLessThanOrEqual(1);
  await page.evaluate(() => window.scrollTo(0, 0));

  await annotationEntry.click();
  await expect(page.getByRole("button", { name: "关闭批注工具" })).toHaveAttribute("aria-pressed", "true");
  const toolbar = page.getByRole("toolbar", { name: "批注工具栏" });
  await expect(toolbar).toBeVisible();
  await expect(ratingBar).toHaveCount(0);
  await expect(page.getByRole("button", { name: "浏览", exact: true })).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByTitle("画笔")).toBeVisible();
  await page.getByRole("button", { name: "矩形", exact: true }).click();
  await expect(page.getByRole("button", { name: "矩形", exact: true })).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByRole("button", { name: "浏览", exact: true })).toHaveAttribute("aria-pressed", "false");
  await expect(page.getByText("当前：矩形", { exact: true })).toBeVisible();
  await expect(page.getByTitle("输入框")).toBeVisible();
  await expect(page.getByTitle("下拉选择")).toBeVisible();
  const toolbarBox = await toolbar.boundingBox();
  expect(toolbarBox).not.toBeNull();
  expect(toolbarBox!.y).toBeGreaterThanOrEqual(0);
  expect(viewport!.height - toolbarBox!.y - toolbarBox!.height).toBeGreaterThanOrEqual(8);
  expect(viewport!.height - toolbarBox!.y - toolbarBox!.height).toBeLessThanOrEqual(32);
  await page.screenshot({ path: testInfo.outputPath(`review-annotation-${testInfo.project.name}.png`), fullPage: false });

  const surface = page.locator(".review-annotation-root");
  const surfaceBox = await surface.boundingBox();
  expect(surfaceBox).not.toBeNull();
  const drawStart = { x: surfaceBox!.x + 90, y: Math.max(110, surfaceBox!.y + 50) };
  const drawEnd = { x: drawStart.x + 110, y: drawStart.y + 70 };
  await page.mouse.move(drawStart.x, drawStart.y);
  await page.mouse.down();
  await page.mouse.move(drawEnd.x, drawEnd.y, { steps: 4 });
  await page.mouse.up();
  const shape = page.locator('.review-annotation-svg > rect[data-annotation-element]').first();
  await expect(shape).toBeVisible();
  const drawnBox = await shape.boundingBox();
  expect(drawnBox).not.toBeNull();

  await page.getByRole("button", { name: "选择", exact: true }).click();
  await page.mouse.move(drawnBox!.x + drawnBox!.width / 2, drawnBox!.y + drawnBox!.height / 2);
  await page.mouse.down();
  await page.mouse.move(drawnBox!.x + drawnBox!.width / 2 + 36, drawnBox!.y + drawnBox!.height / 2 + 24, { steps: 4 });
  await page.mouse.up();
  const movedBox = await shape.boundingBox();
  expect(movedBox!.x).toBeGreaterThan(drawnBox!.x + 20);
  expect(movedBox!.y).toBeGreaterThan(drawnBox!.y + 10);

  const southeastHandle = page.locator('[data-selection-handle="se"]');
  const handleBox = await southeastHandle.boundingBox();
  expect(handleBox).not.toBeNull();
  await page.mouse.move(handleBox!.x + handleBox!.width / 2, handleBox!.y + handleBox!.height / 2);
  await page.mouse.down();
  await page.mouse.move(handleBox!.x + handleBox!.width / 2 + 40, handleBox!.y + handleBox!.height / 2 + 30, { steps: 4 });
  await page.mouse.up();
  const resizedBox = await shape.boundingBox();
  expect(resizedBox!.width).toBeGreaterThan(movedBox!.width + 20);
  expect(resizedBox!.height).toBeGreaterThan(movedBox!.height + 10);

  await page.getByRole("button", { name: "关闭批注工具" }).click();
  await expect(page.locator(".review-bottom-controls")).toBeVisible();
  await expect(toolbar).toHaveCount(0);
  await annotationEntry.click();
  await expect(toolbar).toBeVisible();
  const reopenedBox = await shape.boundingBox();
  expect(Math.abs(reopenedBox!.x - resizedBox!.x)).toBeLessThanOrEqual(2);
  expect(Math.abs(reopenedBox!.y - resizedBox!.y)).toBeLessThanOrEqual(2);
  expect(Math.abs(reopenedBox!.width - resizedBox!.width)).toBeLessThanOrEqual(2);
  expect(Math.abs(reopenedBox!.height - resizedBox!.height)).toBeLessThanOrEqual(2);
  await page.waitForTimeout(350);
  await page.getByRole("button", { name: "关闭批注工具" }).click();

  await page.reload();
  await page.getByRole("button", { name: /^复习/ }).first().click();
  await expect(page.locator(".review-annotation-root")).toBeVisible();
  await page.getByRole("button", { name: "打开批注工具" }).click();
  const reloadedShape = page.locator('.review-annotation-svg > rect[data-annotation-element]').first();
  await expect(reloadedShape).toBeVisible();
  const reloadedBox = await reloadedShape.boundingBox();
  expect(Math.abs(reloadedBox!.x - resizedBox!.x)).toBeLessThanOrEqual(2);
  expect(Math.abs(reloadedBox!.y - resizedBox!.y)).toBeLessThanOrEqual(2);
  expect(Math.abs(reloadedBox!.width - resizedBox!.width)).toBeLessThanOrEqual(2);
  expect(Math.abs(reloadedBox!.height - resizedBox!.height)).toBeLessThanOrEqual(2);
  await page.getByRole("button", { name: "关闭批注工具" }).click();

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
