import { expect, test, type Page } from "@playwright/test";

test.setTimeout(90_000);
const output = "output/ui-ux-polish-2026-10-03/knowledge-and-reminder";
const active = (page: Page) => page.locator('.page-transition-layer:not([aria-hidden="true"])').last();
const prepareKnowledge = async (page: Page) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "今天想记下什么？" })).toBeVisible();
  await page.evaluate(async () => {
    const { knowledgeRepository: repository } = await import("/src/features/knowledgeLibrary/runtime.ts");
    const { createKnowledgeEntity } = await import("/src/features/knowledgeLibrary/commands.ts");
    await repository.createLibrary("新建日志验收", "new-log-library");
    const opened = await repository.open("new-log-library");
    const workspace = createKnowledgeEntity("new-log-library", "workspace", "算法与数据结构");
    await repository.execute(opened.context, workspace);
    const node = createKnowledgeEntity("new-log-library", "node", "图的遍历", workspace.entity.id);
    await repository.execute(opened.context, node);
  });
  await page.reload();
  await page.getByRole("button", { name: "更多", exact: true }).last().click();
  await active(page).getByRole("button", { name: "知识库", exact: true }).click();
  await active(page).getByRole("button", { name: /算法与数据结构/ }).click();
};

for (const view of ["大纲", "导图"]) {
  test(view + " creates a linked blank journal and returns to the same node", async ({ page }, info) => {
    await prepareKnowledge(page);
    await active(page).getByRole("button", { name: view, exact: true }).click();
    await active(page).getByRole("button", { name: /图的遍历/ }).first().click();
    await active(page).getByRole("button", { name: "添加日志", exact: true }).click();
    const picker = page.getByRole("dialog", { name: "添加日志", exact: true });
    await expect(picker.getByText("或选择已有日志")).toBeVisible();
    await page.screenshot({ path: output + "/" + info.project.name + "-" + view + "-add-log.png" });
    await picker.getByRole("button", { name: /新建空白日志/ }).click();
    await expect(page.getByRole("button", { name: /^创建.+日志$/ }).first()).toBeVisible();
    await page.screenshot({ path: output + "/" + info.project.name + "-" + view + "-subject-picker.png" });
    await page.getByRole("button", { name: /^创建.+日志$/ }).first().click();
    await expect(active(page).locator('.record-editor-page .tiptap[contenteditable="true"]').first()).toBeVisible();
    const saved = await page.evaluate(async () => {
      const { db } = await import("/src/db/database.ts");
      return { records: await db.blocks.toArray(), references: await db.knowledgeReferences.toArray(), nodes: await db.knowledgeNodes.toArray() };
    });
    expect(saved.records).toHaveLength(1);
    expect(saved.references).toHaveLength(1);
    expect(saved.references[0].recordId).toBe(saved.records[0].id);
    expect(saved.references[0].nodeId).toBe(saved.nodes[0].id);
    expect(saved.records[0].contentHtml).toBe("<p></p>");
    expect(saved.records[0].planId).toBeUndefined();
    await page.screenshot({ path: output + "/" + info.project.name + "-" + view + "-new-editor.png" });
    await active(page).getByRole("button", { name: "返回", exact: true }).click();
    await expect(active(page).locator("main.knowledge-library")).toBeVisible();
    await expect(active(page).getByRole("heading", { name: "图的遍历", exact: true })).toBeVisible();
    await expect(active(page).getByRole("button", { name: view, exact: true })).toHaveAttribute("aria-pressed", "true");
    await expect(active(page).getByText("关联日志 · 1")).toBeVisible();
  });
}

test("canceling creates nothing and linking retries reuse the journal", async ({ page }, info) => {
  await prepareKnowledge(page);
  await active(page).getByRole("button", { name: /图的遍历/ }).first().click();
  await active(page).getByRole("button", { name: "添加日志", exact: true }).click();
  await page.getByRole("button", { name: /新建空白日志/ }).click();
  await page.keyboard.press("Escape");
  expect(await page.evaluate(async () => { const { db } = await import("/src/db/database.ts"); return db.blocks.count(); })).toBe(0);
  await active(page).getByRole("button", { name: "添加日志", exact: true }).click();
  await page.getByRole("button", { name: /新建空白日志/ }).click();
  await page.evaluate(async () => {
    const { knowledgeRepository: repository } = await import("/src/features/knowledgeLibrary/runtime.ts");
    const original = repository.execute.bind(repository);
    repository.execute = async (...args) => { repository.execute = original; throw new Error("injected reference write failure"); };
  });
  await page.getByRole("button", { name: /^创建.+日志$/ }).first().click();
  await expect(page.getByRole("alert")).toContainText("日志已创建，但尚未关联");
  await page.screenshot({ path: output + "/" + info.project.name + "-link-retry.png" });
  await page.getByRole("button", { name: /^创建.+日志$/ }).first().click();
  await expect(active(page).locator(".record-editor-page")).toBeVisible();
  expect(await page.evaluate(async () => { const { db } = await import("/src/db/database.ts"); return [await db.blocks.count(), await db.knowledgeReferences.count()]; })).toEqual([1, 1]);
});

test.describe("daily plan welcome", () => {
  test.use({ storageState: { cookies: [], origins: [] } });
  test("a second window cannot repeat the same day's reminder", async ({ page, context }) => {
    await page.goto("/");
    await expect(page.getByRole("dialog", { name: "为今天定个小目标" })).toBeVisible();
    const second = await context.newPage();
    await second.goto("/");
    await expect(second.getByRole("heading", { name: "今天想记下什么？" })).toBeVisible();
    await second.waitForTimeout(1100);
    await expect(second.locator(".daily-plan-reminder")).not.toBeVisible();
    await second.close();
  });

  test("remains usable on small screens with large fonts and modern themes", async ({ page }, info) => {
    await page.setViewportSize({ width: 320, height: 640 });
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.goto("/");
    const dialog = page.getByRole("dialog", { name: "为今天定个小目标" });
    await expect(dialog).toBeVisible();
    await page.evaluate(() => { document.documentElement.style.setProperty("--font-scale", "1.5"); document.documentElement.dataset.visualTheme = "modern"; });
    for (const theme of ["light", "dark"]) {
      await page.evaluate(value => { document.documentElement.dataset.theme = value; }, theme);
      await dialog.getByRole("button", { name: "去制定计划" }).scrollIntoViewIfNeeded();
      await page.screenshot({ path: output + "/" + info.project.name + "-320-large-modern-" + theme + ".png" });
      expect(await dialog.evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
      await expect(dialog.getByRole("button", { name: "去制定计划" })).toBeInViewport();
    }
    await dialog.getByRole("button", { name: "暂不制定" }).click();
    await expect(dialog).not.toBeVisible();
  });
  test("shows once with responsive light/dark styling and opens today's planner", async ({ page }, info) => {
    await page.goto("/");
    const dialog = page.getByRole("dialog", { name: "为今天定个小目标" });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole("button", { name: "去制定计划" })).toBeFocused();
    await dialog.evaluate(async element => { await Promise.all(element.getAnimations().map(animation => animation.finished)); });
    for (const theme of ["light", "dark"]) {
      await page.evaluate(value => { document.documentElement.dataset.theme = value; }, theme);
      await dialog.evaluate(async element => { await Promise.all(element.getAnimations({ subtree: true }).map(animation => animation.finished)); });
      await page.screenshot({ path: output + "/" + info.project.name + "-reminder-" + theme + ".png" });
      const bounds = await dialog.boundingBox();
      expect(bounds!.x).toBeGreaterThanOrEqual(0);
      expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(page.viewportSize()!.width);
      expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(page.viewportSize()!.height);
    }
    await dialog.getByRole("button", { name: "去制定计划" }).click();
    await expect(active(page).getByRole("heading", { name: "今日计划" })).toBeVisible();
    await page.reload();
    await expect(page.getByRole("heading", { name: "今天想记下什么？" })).toBeVisible();
    await page.waitForTimeout(1100);
    await expect(dialog).not.toBeVisible();
  });
  test("Escape consumes the day and existing plans use accurate copy", async ({ page }, info) => {
    await page.goto("/");
    await expect(page.getByRole("dialog", { name: "为今天定个小目标" })).toBeVisible();
    await page.keyboard.press("Escape");
    await page.reload();
    await page.waitForTimeout(1100);
    await expect(page.locator(".daily-plan-reminder")).not.toBeVisible();
    await page.evaluate(async () => {
      const { db } = await import("/src/db/database.ts");
      const { todayISO } = await import("/src/lib/date.ts");
      await db.dailyPlans.put({ id: "today-plan", title: "复习图的遍历", subject: "读书笔记", date: todayISO(), order: 0, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
      localStorage.removeItem("study-journal-daily-plan-reminder-date");
    });
    await page.reload();
    const dialog = page.getByRole("dialog", { name: "今天的计划，已经就绪" });
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText("今天已安排 1 项计划");
    await page.screenshot({ path: output + "/" + info.project.name + "-reminder-planned.png" });
    await dialog.getByRole("button", { name: "直接开始" }).click();
    await page.reload();
    await page.waitForTimeout(1100);
    await expect(dialog).not.toBeVisible();
  });
});
