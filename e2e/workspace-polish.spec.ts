import { expect, test, type Page } from "@playwright/test";

test.setTimeout(90_000);
const active = (page: Page) => page.locator('.page-transition-layer:not([aria-hidden="true"])').last();
const capture = async (page: Page, name: string) => {
  await expect(page.locator(".page-transition-layer-entering, .page-transition-layer-exiting")).toHaveCount(0);
  await page.screenshot({ path: "output/workspace-polish-2026-10-05/" + name + ".png", animations: "disabled" });
};
const start = async (page: Page) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "今天想记下什么？" })).toBeVisible();
};

test("all 25 due cards keep their progress across reload and undo", async ({ page }, info) => {
  await start(page);
  await page.evaluate(async () => {
    const { storage } = await import("/src/services/storageAdapter.ts");
    const { db } = await import("/src/db/database.ts");
    const { todayISO } = await import("/src/lib/date.ts");
    const stamp = new Date().toISOString();
    for (let index = 0; index < 25; index += 1) {
      const id = "progress-" + String(index).padStart(2, "0");
      await storage.saveBlock({ id, type: "record", date: todayISO(), title: "断点复习 " + (index + 1), subject: "计算机", order: index, createdAt: stamp, updatedAt: stamp, contentHtml: "<p>检查已提交评分与本轮进度。</p>", assets: [], tags: [], formulas: [], mistakeRefs: [] });
      await storage.addRecordToReview(id);
      await db.recordReviews.update(id, { nextReviewDate: todayISO() });
    }
    for (const log of await db.recordReviewLogs.toArray()) {
      if (log.stateAfter) await db.recordReviewLogs.update(log.id, { nextReviewDate: todayISO(), stateAfter: { ...log.stateAfter, nextReviewDate: todayISO() } });
    }
  });
  await page.reload();
  await page.getByRole("button", { name: /^复习(?:\s+\d+)?$/ }).last().click();
  await expect(active(page).getByRole("progressbar")).toHaveAttribute("aria-valuemax", "25");
  await expect(active(page).getByRole("progressbar")).toHaveAttribute("aria-valuenow", "0");
  await page.getByRole("button", { name: /^良好/ }).click();
  await expect(active(page).getByRole("progressbar")).toHaveAttribute("aria-valuenow", "1");
  await expect.poll(() => page.evaluate(async () => (await (await import("/src/db/database.ts")).db.recordReviews.toArray()).filter(review => review.lastReviewDate).length)).toBe(1);
  await active(page).getByRole("button", { name: "打开复习更多菜单" }).click();
  await active(page).getByRole("menuitem", { name: /撤回上次评分/ }).click();
  await expect(active(page).getByRole("progressbar")).toHaveAttribute("aria-valuenow", "0");
  await page.getByRole("button", { name: /^良好/ }).click();
  await expect.poll(() => page.evaluate(async () => (await (await import("/src/db/database.ts")).db.recordReviews.toArray()).filter(review => review.lastReviewDate).length)).toBe(1);
  const nextTitle = await active(page).locator(".review-session h1").first().textContent();
  await page.reload();
  await page.getByRole("button", { name: /^复习(?:\s+\d+)?$/ }).last().click();
  await expect(active(page).getByRole("progressbar")).toHaveAttribute("aria-valuemax", "25");
  await expect(active(page).getByRole("progressbar")).toHaveAttribute("aria-valuenow", "1");
  await expect(active(page).locator(".review-session h1").first()).toHaveText(nextTitle!);
  await capture(page, info.project.name + "-review-resumed");
  const local = await page.evaluate(() => JSON.parse(localStorage.getItem("studyjournal-ordinary-review-checkpoint-v1")!));
  expect(local.recordIds).toHaveLength(25);
  expect(local.undoHistory).toBeUndefined();
  await active(page).getByRole("button", { name: "返回复习", exact: true }).click();
  await page.evaluate(async () => { const { withRestoreLock } = await import("/src/services/restoreLockService.ts"); await withRestoreLock(() => new Promise(resolve => setTimeout(resolve, 100))); });
  expect(await page.evaluate(() => localStorage.getItem("studyjournal-ordinary-review-checkpoint-v1"))).toBeNull();
});

test("chat uses readable user text, open answers, and navigable history", async ({ page, isMobile }, info) => {
  await start(page);
  await page.evaluate(async () => {
    const { db } = await import("/src/db/database.ts");
    const stamp = new Date().toISOString();
    await db.aiSessions.bulkPut([
      { id: "chat-polish", title: "复习规划问答", createdAt: stamp, updatedAt: stamp },
      { id: "chat-previous", title: "上一轮学习问答", createdAt: stamp, updatedAt: stamp },
    ]);
    await db.aiMessages.bulkPut([
      { id: "chat-user", sessionId: "chat-polish", role: "user", content: "请解释为什么复习需要间隔。\n我想理解，而不只是记住结论。", createdAt: stamp, updatedAt: stamp },
      { id: "chat-answer", sessionId: "chat-polish", role: "assistant", content: "## 从回忆开始，而不是重复阅读\n\n间隔复习把学习安排在不同时间。重点不是增加阅读次数，而是在遗忘之前尝试主动提取。\n\n### 一个简单的例子\n\n1. 合上材料，用自己的话解释。\n2. 对照原文，定位遗漏和错误。\n3. 根据真实回忆情况评分。\n\n```typescript\nconst completed = reviewedCards.length;\nconst progress = completed / totalCards;\n```\n\n进度应使用已完成数量，例如 $2/25$，而不是当前卡片序号。", createdAt: stamp + "1", updatedAt: stamp },
      { id: "chat-previous-answer", sessionId: "chat-previous", role: "assistant", content: "上一轮的回答仍然保留。", createdAt: stamp, updatedAt: stamp },
    ]);
  });
  await page.reload();
  await page.getByRole("button", { name: "更多", exact: true }).last().click();
  await active(page).getByRole("button", { name: /AI 问答/ }).click();
  const openHistory = async () => { if (isMobile) await active(page).getByRole("button", { name: "打开历史聊天" }).click(); };
  const history = () => isMobile ? page.locator(".ai-history-drawer") : active(page).getByRole("complementary", { name: "聊天历史" });
  await openHistory();
  await history().getByRole("button", { name: /^复习规划问答/ }).click();
  const user = active(page).getByRole("article", { name: "用户消息" });
  await expect(user).toContainText("请解释为什么复习需要间隔。");
  expect(await user.innerText()).not.toMatch(/你|复制/);
  await expect(active(page).locator(".ai-bubble-row.assistant .ai-bubble")).toHaveCount(0);
  await expect(page.locator(".app-shell > .sidebar")).toBeHidden();
  const copy = user.getByRole("button", { name: "复制用户消息" });
  if (!isMobile) {
    await page.mouse.move(0, 0);
    await expect(copy).toHaveCSS("opacity", "0");
    await user.locator(".ai-bubble").hover();
    await expect(copy).toHaveCSS("opacity", "1");
    await page.mouse.move(0, 0);
    await copy.focus();
    await expect(copy).toHaveCSS("opacity", "1");
  } else {
    await expect(copy).toHaveCSS("opacity", "1");
  }
  for (const visual of ["warm", "modern"]) for (const theme of ["light", "dark"]) {
    await page.evaluate(({ visual, theme }) => { document.documentElement.dataset.visualTheme = visual; document.documentElement.dataset.theme = theme; }, { visual, theme });
    const contrast = await user.locator(".ai-bubble").evaluate(element => {
      const style = getComputedStyle(element);
      const luminance = (color: string) => color.match(/[\d.]+/g)!.slice(0, 3).map(value => Number(value) / 255).map(value => value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4).reduce((sum, value, index) => sum + value * [.2126, .7152, .0722][index], 0);
      const foreground = luminance(style.color); const background = luminance(style.backgroundColor);
      return (Math.max(foreground, background) + .05) / (Math.min(foreground, background) + .05);
    });
    expect(contrast).toBeGreaterThanOrEqual(4.5);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
    const input = await active(page).getByPlaceholder("问问 AI...").boundingBox();
    expect(input!.y + input!.height).toBeLessThanOrEqual(await page.evaluate(() => innerHeight));
    await capture(page, info.project.name + "-chat-" + visual + "-" + theme);
  }
  await openHistory();
  await history().getByRole("button", { name: /^上一轮学习问答/ }).click();
  await expect(active(page).getByRole("log")).toContainText("上一轮的回答仍然保留。");
  await expect(active(page).getByRole("log")).not.toContainText("请解释为什么复习需要间隔。");
  if (isMobile) {
    await page.setViewportSize({ width: 320, height: 844 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
    await capture(page, info.project.name + "-chat-320");
  }
  await page.locator(".ai-workspace-back:visible, .ai-history-return:visible").click();
  await expect(active(page).getByRole("heading", { name: "更多", exact: true })).toBeVisible();
});
