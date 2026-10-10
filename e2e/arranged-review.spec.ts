import { expect, test, type Page } from "@playwright/test";
test.setTimeout(90_000);
const output = "output/review-workspace-2026-10-07/arranged-review";
const screenshot = async (page: Page, path: string) => { await expect(page.locator(".page-transition-layer-entering, .page-transition-layer-exiting")).toHaveCount(0); await page.screenshot({ path: test.info().outputPath(path.split("/").at(-1)!), animations: "disabled" }); };
const active = (page: Page) => page.locator('.page-transition-layer:not([aria-hidden="true"])').last();
const seed = async (page: Page) => {
  await page.goto("/"); await expect(page.getByRole("heading", { name: "今天", exact: true })).toBeVisible();
  await page.evaluate(async () => {
    const { db } = await import("/src/db/database.ts");
    const { knowledgeRepository: repository } = await import("/src/features/knowledgeLibrary/runtime.ts");
    const { createKnowledgeEntity } = await import("/src/features/knowledgeLibrary/commands.ts");
    const { storage } = await import("/src/services/storageAdapter.ts");
    const { todayISO } = await import("/src/lib/date.ts");
    const stamp = new Date().toISOString();
    const titles = ["冒泡排序流程理解", "冒泡排序高频题", "快速排序理解", "快速排序踩坑点"];
    for (const [index, title] of titles.entries()) await storage.saveBlock({ id: "arranged-record-" + index, type: "record", date: todayISO(), subject: "计算机", title, contentHtml: "<p>" + title + "：分析比较、交换与分区过程。</p>" + (index === 3 ? '<record-decision-block data-decision-block-id="arranged-decision" data-content-version="1"><p>分区指针与循环不变量</p></record-decision-block>' : ""), order: index, createdAt: stamp, updatedAt: stamp, assets: [], formulas: [], mistakeRefs: [], tags: [] });
    await repository.createLibrary("安排复习验收", "arranged-library");
    const opened = await repository.open("arranged-library");
    const workspace = createKnowledgeEntity("arranged-library", "workspace", "排序算法"); await repository.execute(opened.context, workspace);
    for (const [index, title] of ["冒泡排序", "快速排序"].entries()) {
      const node = createKnowledgeEntity("arranged-library", "node", title, workspace.entity.id); await repository.execute(opened.context, node);
      for (const recordIndex of [index * 2, index * 2 + 1]) { const reference = createKnowledgeEntity("arranged-library", "reference", "", workspace.entity.id, undefined, "arranged-record-" + recordIndex, node.entity.id); await repository.execute(opened.context, reference); }
    }
    localStorage.setItem("study-journal-arranged-navigation", JSON.stringify({ mode: "ordinary" }));
    return db.blocks.count();
  });
  await page.reload(); await page.getByRole("button", { name: "更多", exact: true }).last().click(); await active(page).getByRole("button", { name: "知识库", exact: true }).click(); await active(page).getByRole("button", { name: /排序算法/ }).click();
};
for (const view of ["大纲", "导图"]) test(view + " creates a round and click-score-check board survives restart", async ({ page }, info) => {
  await seed(page); await active(page).getByRole("button", { name: view, exact: true }).click();
  await active(page).getByRole("button", { name: "安排复习", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "安排复习", exact: true });
  await dialog.getByRole("checkbox", { name: /冒泡排序\s*2/, exact: false }).check();
  await dialog.getByRole("checkbox", { name: /快速排序\s*2/, exact: false }).check();
  await expect(dialog.getByText("已选 4 条").first()).toBeVisible();
  await screenshot(page, output + "/" + info.project.name + "-" + view + "-selection.png");
  await dialog.getByRole("button", { name: "创建复习", exact: true }).click();
  await expect(active(page).getByText("0/4 已完成", { exact: true })).toBeVisible();
  await active(page).getByRole("button", { name: /快速排序踩坑点.*未完成/ }).click();
  await expect(active(page).getByRole("heading", { name: "快速排序踩坑点", exact: true })).toBeVisible();
  await screenshot(page, output + "/" + info.project.name + "-card.png");
  const theme = await page.evaluate(() => { const previous = { ...document.documentElement.dataset }; document.documentElement.dataset.theme = "dark"; document.documentElement.dataset.visualTheme = "modern"; return previous; });
  await screenshot(page, output + "/" + info.project.name + "-card-dark.png");
  await page.evaluate(previous => { for (const key of ["theme", "visualTheme"]) { if (previous[key] === undefined) delete document.documentElement.dataset[key]; else document.documentElement.dataset[key] = previous[key]; } }, theme);
  const menuBox = await active(page).getByRole("button", { name: "打开复习更多菜单", exact: true }).boundingBox();
  const annotationBox = await page.getByRole("button", { name: "打开批注工具", exact: true }).boundingBox();
  expect(menuBox && annotationBox && (menuBox.x + menuBox.width <= annotationBox.x || annotationBox.x + annotationBox.width <= menuBox.x || menuBox.y + menuBox.height <= annotationBox.y || annotationBox.y + annotationBox.height <= menuBox.y)).toBe(true);
  await page.getByRole("button", { name: "模糊", exact: true }).click();
  await expect(active(page).getByText("1/4 已完成", { exact: true })).toBeVisible();
  await expect(active(page).getByRole("button", { name: /快速排序踩坑点.*模糊/ }).locator(".arranged-check.complete")).toBeVisible();
  await screenshot(page, output + "/" + info.project.name + "-board-light.png");
  await page.evaluate(() => { document.documentElement.dataset.theme = "dark"; document.documentElement.dataset.visualTheme = "modern"; });
  await screenshot(page, output + "/" + info.project.name + "-board-dark.png");
  expect(await active(page).locator(".arranged-workspace").evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
  const facts = await page.evaluate(async () => { const { db } = await import("/src/db/database.ts"); return { scores: await db.arrangedReviewEvents.count(), reviews: await db.recordReviews.count(), logs: await db.recordReviewLogs.count() }; });
  expect(facts).toEqual({ scores: 1, reviews: 0, logs: 0 });
  await page.reload(); await page.getByRole("button", { name: "复习", exact: true }).last().click();
  await expect(active(page).getByText("1/4 已完成", { exact: true })).toBeVisible();
  await active(page).getByRole("button", { name: "待复习", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "复习看板", exact: true }).getByRole("textbox", { name: "搜索待复习日志" })).toBeVisible();
  await active(page).getByRole("button", { name: "已安排", exact: true }).click();
  await expect(active(page).getByText("1/4 已完成", { exact: true })).toBeVisible();
});

test("ordinary board selects a subset without consuming the other due cards", async ({ page }, info) => {
  await seed(page);
  await page.evaluate(async () => { const { storage } = await import("/src/services/storageAdapter.ts"); await storage.addRecordToReview("arranged-record-0"); await storage.addRecordToReview("arranged-record-1"); const { db } = await import("/src/db/database.ts"); const { todayISO } = await import("/src/lib/date.ts"); for (const log of await db.recordReviewLogs.toArray()) if (log.stateAfter) await db.recordReviewLogs.update(log.id, { nextReviewDate: todayISO(), stateAfter: { ...log.stateAfter, nextReviewDate: todayISO(), lastReviewDate: undefined } }); for (const review of await db.recordReviews.toArray()) await db.recordReviews.update(review.id, { nextReviewDate: todayISO(), lastReviewDate: undefined }); });
  await page.reload(); await page.getByRole("button", { name: /^复习/ }).last().click();
  await active(page).getByRole("button", { name: "复习看板", exact: true }).click();
  await expect(active(page).getByRole("checkbox", { name: "选择 冒泡排序流程理解", exact: true })).toBeVisible();
  await screenshot(page, output + "/" + info.project.name + "-ordinary-board.png");
  await active(page).getByRole("checkbox", { name: "选择 冒泡排序流程理解", exact: true }).check();
  await active(page).getByRole("button", { name: "开始所选复习", exact: true }).click();
  await expect(active(page).getByRole("heading", { name: "冒泡排序流程理解", exact: true })).toBeVisible();
  await screenshot(page, output + "/" + info.project.name + "-ordinary-session.png");
  await page.getByRole("button", { name: /^良好/ }).click();
  await expect(active(page).getByRole("heading", { name: "本轮复习已完成", exact: true })).toBeVisible();
  const dueIds = await page.evaluate(async () => { const { storage } = await import("/src/services/storageAdapter.ts"); const { todayISO } = await import("/src/lib/date.ts"); return (await storage.listDueRecordReviews(todayISO())).map(item => item.recordId); });
  expect(dueIds).toEqual(["arranged-record-1"]);
  await active(page).getByRole("button", { name: "继续处理剩余", exact: true }).click();
  await expect(active(page).getByRole("heading", { name: "冒泡排序高频题", exact: true })).toBeVisible();
});

test("320px large-font selection and board remain within the viewport", async ({ page }, info) => {
  await page.setViewportSize({ width: 320, height: 640 }); await seed(page);
  await page.evaluate(() => { document.documentElement.dataset.theme = "dark"; document.documentElement.dataset.visualTheme = "modern"; document.documentElement.style.setProperty("--font-scale", "1.5"); });
  await active(page).getByRole("button", { name: "安排复习", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "安排复习", exact: true });
  await dialog.getByRole("checkbox", { name: "冒泡排序流程理解", exact: true }).check();
  await dialog.getByRole("button", { name: "创建复习", exact: true }).scrollIntoViewIfNeeded();
  await screenshot(page, output + "/" + info.project.name + "-320-selection.png");
  expect(await dialog.evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
  await dialog.getByRole("button", { name: "创建复习", exact: true }).click();
  await expect(active(page).getByText("0/1 已完成", { exact: true })).toBeVisible();
  expect(await active(page).locator(".arranged-workspace").evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
  await screenshot(page, output + "/" + info.project.name + "-320-board.png");
});

test("card feedback persists, explicit analysis fails visibly without credentials, score does not duplicate it", async ({ page }, info) => {
  await seed(page); await active(page).getByRole("button", { name: "安排复习", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "安排复习", exact: true });
  await dialog.getByRole("checkbox", { name: "快速排序踩坑点", exact: true }).check();
  await dialog.getByRole("button", { name: "创建复习", exact: true }).click();
  await active(page).getByRole("button", { name: /快速排序踩坑点.*未完成/ }).click();
  const comment = active(page).getByRole("textbox", { name: "复习重点 1 本次评论" });
  await comment.fill("左右指针相遇时的边界仍然混淆");
  await expect.poll(() => page.evaluate(async () => { const { db } = await import("/src/db/database.ts"); return (await db.arrangedReviewDrafts.toArray()).some(item => Object.values(item.comments).some(value => value.comment.includes("左右指针"))); })).toBe(true);
  await active(page).getByRole("button", { name: /学习助教 ·/ }).click();
  await expect(active(page).getByRole("alert")).toContainText("API Key");
  await screenshot(page, output + "/" + info.project.name + "-coach.png");
  await active(page).getByRole("button", { name: "返回卡片", exact: true }).click();
  await expect(comment).toHaveValue("左右指针相遇时的边界仍然混淆");
  await page.getByRole("button", { name: "良好", exact: true }).click();
  await expect(active(page).getByText("1/1 已完成", { exact: true })).toBeVisible();
  expect(await page.evaluate(async () => { const { db } = await import("/src/db/database.ts"); return [await db.decisionBlockFeedback.count(), await db.analysisQueueItems.count(), await db.recordReviewLogs.count()]; })).toEqual([1, 1, 0]);
  await active(page).getByRole("button", { name: /快速排序踩坑点.*良好/ }).click();
  await expect(active(page).getByText("本轮评价：良好")).toBeVisible();
  page.once("dialog", dialog => dialog.accept());
  await active(page).getByRole("button", { name: "撤销本次评分", exact: true }).click();
  await expect(active(page).getByText("0/1 已完成", { exact: true })).toBeVisible();
  page.once("dialog", dialog => dialog.accept());
  await active(page).locator('summary[aria-label="更多本轮操作"]').click();
  await active(page).getByRole("button", { name: "删除本轮", exact: true }).click();
  expect(await page.evaluate(async () => { const { db } = await import("/src/db/database.ts"); return db.decisionBlockFeedback.count(); })).toBe(1);
});

test("failed persistence never checks an item and editor returns to the original round", async ({ page }) => {
  await seed(page); await active(page).getByRole("button", { name: "安排复习", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "安排复习", exact: true });
  await dialog.getByRole("checkbox", { name: "冒泡排序流程理解", exact: true }).check();
  await dialog.getByRole("button", { name: "创建复习", exact: true }).click();
  await active(page).getByRole("button", { name: /冒泡排序流程理解.*未完成/ }).click();
  await page.evaluate(async () => { const { arrangedReviewRepository } = await import("/src/features/arrangedReview/repository.ts"); const original = arrangedReviewRepository.rate.bind(arrangedReviewRepository); arrangedReviewRepository.rate = async (...args) => { arrangedReviewRepository.rate = original; throw new Error("injected write failure"); }; });
  await page.getByRole("button", { name: "忘记了", exact: true }).click();
  await expect(active(page).getByText(/复习评分失败/)).toBeVisible();
  expect(await page.evaluate(async () => { const { db } = await import("/src/db/database.ts"); return db.arrangedReviewEvents.count(); })).toBe(0);
  await active(page).getByRole("button", { name: "打开复习更多菜单", exact: true }).click();
  await active(page).getByRole("menuitem", { name: /编辑原日志/ }).click();
  await expect(active(page).locator(".record-editor-page")).toBeVisible();
  await active(page).getByRole("button", { name: "返回", exact: true }).click();
  await expect(active(page).getByRole("heading", { name: "冒泡排序流程理解", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "忘记了", exact: true }).click();
  await expect(active(page).getByText("1/1 已完成", { exact: true })).toBeVisible();
});
test("single-card coach plans one task and returns from training without changing the ordinary schedule", async ({ page }, info) => {
  const prompts: string[] = [];
  await page.route("https://**/*", async route => {
    if (!route.request().url().startsWith("https://api.deepseek.com/")) return route.abort();
    const payload = route.request().postDataJSON();
    const prompt = payload.messages.map((item: { content: string }) => item.content).join("\n"); prompts.push(prompt);
    const input = JSON.parse(prompt.slice(prompt.lastIndexOf("\n{") + 1));
    let result: unknown;
    if (Array.isArray(input.blocks)) result = { status: "ok", summary: "本卡分析完成", blueprints: input.blocks.map((block: { decisionBlockId: string; recordId: string; contentVersion: number; excerptHash: string; feedback: { id: string; interpretation?: { id: string } }[] }) => ({
      mainDecisionBlockId: block.decisionBlockId, contentVersion: block.contentVersion, supportingDecisionBlockIds: [], feedbackIds: block.feedback.map(item => item.id), interpretationIds: block.feedback.flatMap(item => item.interpretation ? [item.interpretation.id] : []),
      problemHypothesis: "分区边界条件尚未稳定", hypothesisConfidence: 0.8, objective: "辨析分区指针相遇时的边界", completionCriteria: ["正确说明分区边界"], initialPracticeType: "variation", initialDifficulty: 2, expectedKeyPoints: ["循环不变量"],
      branches: [{ when: "correct", nextStrategy: "finish" }, { when: "partial", nextStrategy: "hint" }, { when: "incorrect", nextStrategy: "explain" }, { when: "skipped", nextStrategy: "prerequisite-check" }], allowedStrategies: ["finish", "hint", "explain", "prerequisite-check"], forbiddenScope: ["其他日志"], evidence: [{ decisionBlockId: block.decisionBlockId, recordId: block.recordId, contentVersion: block.contentVersion, excerptHash: block.excerptHash, purpose: "source" }], maxTurns: 4, maxRetriesPerTurn: 1, maxEstimatedTokens: 4000,
    })) };
    else result = { status: "ok", actionability: "needs_training", difficultyType: "procedure", stuckAt: "分区指针相遇的边界", userHypothesis: "循环不变量尚未稳定", preferredPractice: "variation", missingInformation: [], confidence: 0.84 };
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ choices: [{ finish_reason: "stop", message: { content: JSON.stringify(result) } }], usage: { total_tokens: 100 } }) });
  });
  await seed(page);
  await page.evaluate(async () => { const { storage } = await import("/src/services/storageAdapter.ts"); const settings = await storage.getSettings(); await storage.saveSettings({ ...settings, ai: { ...settings.ai, currentProviderId: "arranged-test", providers: [{ id: "arranged-test", providerName: "DeepSeek", baseUrl: "https://api.deepseek.com", model: "deepseek-chat", temperature: 0, maxTokens: 8000 }] } }); await storage.saveAiSecret("isolated-e2e-not-a-real-key", "arranged-test"); });
  await active(page).getByRole("button", { name: "安排复习", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "安排复习", exact: true }); await dialog.getByRole("checkbox", { name: "快速排序踩坑点", exact: true }).check(); await dialog.getByRole("button", { name: "创建复习", exact: true }).click();
  await active(page).getByRole("button", { name: /快速排序踩坑点.*未完成/ }).click();
  await active(page).getByRole("textbox", { name: "复习重点 1 本次评论" }).fill("分区指针相遇时应该如何判断？");
  await active(page).getByRole("button", { name: /学习助教 ·/ }).click();
  await expect(active(page).getByText("辨析分区指针相遇时的边界", { exact: true })).toBeVisible();
  await screenshot(page, output + "/" + info.project.name + "-coach-success.png");
  expect(prompts).toHaveLength(2); expect(prompts[1]).not.toContain("冒泡排序流程理解");
  await active(page).getByRole("button", { name: "进入训练", exact: true }).click();
  await expect(active(page).getByRole("button", { name: "开始训练", exact: true })).toBeVisible();
  await active(page).getByRole("button", { name: /返回/, exact: false }).first().click();
  await expect(active(page).getByRole("heading", { name: "快速排序踩坑点", exact: true })).toBeVisible();
  await active(page).getByRole("button", { name: /学习助教 ·/ }).click();
  await expect(active(page).getByRole("button", { name: "进入训练", exact: true })).toBeVisible();
  await active(page).getByRole("button", { name: "分析本卡", exact: true }).click();
  await expect(active(page).getByRole("button", { name: "分析本卡", exact: true })).toBeEnabled();
  expect(prompts).toHaveLength(2);
  expect(await page.evaluate(async () => { const { db } = await import("/src/db/database.ts"); return [await db.adaptiveReviewTasks.count(), await db.decisionBlockFeedback.count(), await db.recordReviews.count(), await db.recordReviewLogs.count()]; })).toEqual([1, 1, 0, 0]);
});
test("mode switching waits for the registered review draft guard", async ({ page }) => {
  await seed(page); await active(page).getByRole("button", { name: "安排复习", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "安排复习", exact: true }); await dialog.getByRole("checkbox", { name: "冒泡排序流程理解", exact: true }).check(); await dialog.getByRole("button", { name: "创建复习", exact: true }).click();
  await active(page).getByRole("button", { name: /冒泡排序流程理解.*未完成/ }).click();
  await page.evaluate(async () => { const { registerReviewNavigationCheck } = await import("/src/features/reviewSession/navigationGuard.ts"); let release!: () => void; const pending = new Promise<void>(resolve => { release = resolve; }); const unregister = registerReviewNavigationCheck(() => pending); (window as unknown as { releaseReviewDraft: () => void }).releaseReviewDraft = () => { unregister(); release(); }; });
  await active(page).getByRole("button", { name: "返回看板", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "复习看板" })).not.toBeVisible();
  await expect(active(page).getByRole("heading", { name: "冒泡排序流程理解", exact: true })).toBeVisible();
  await page.evaluate(() => (window as unknown as { releaseReviewDraft: () => void }).releaseReviewDraft());
  await expect(page.getByRole("dialog", { name: "复习看板" })).toBeVisible();
  await active(page).getByRole("button", { name: /冒泡排序流程理解.*未完成/ }).click();
  await expect(active(page).getByRole("heading", { name: "冒泡排序流程理解", exact: true })).toBeVisible();
});
