import { expect, test, type Page } from "@playwright/test";

test.setTimeout(90000);
const active = (page: Page) => page.locator('.page-transition-layer:not([aria-hidden="true"])').last();
const openKnowledge = async (page: Page) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "今天想记下什么？" })).toBeVisible();
  await page.getByRole("button", { name: "更多", exact: true }).last().click();
  await expect(active(page).locator(".more-list").getByRole("button", { name: "知识库", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "知识库", exact: true }).click();
};

test("first use creates one library, edits inline, keeps browsing read-only and searches notes", async ({ page }) => {
  await openKnowledge(page);
  await page.getByRole("button", { name: "创建第一个专题" }).click();
  expect(await page.evaluate(async () => (await import("/src/db/database.ts")).db.knowledgeLibraries.count())).toBe(0);
  await page.getByRole("dialog").getByRole("textbox", { name: "新建专题", exact: true }).fill("数据结构");
  await page.getByRole("dialog").getByRole("button", { name: "创建专题", exact: true }).click();
  await expect(active(page).getByRole("heading", { name: "数据结构", exact: true })).toBeVisible();
  await expect(active(page).getByRole("button", { name: "返回", exact: true })).toHaveCount(1);
  await expect(active(page).getByRole("button", { name: "整理", exact: true })).toHaveCount(0);
  await active(page).getByRole("button", { name: "添加节点", exact: true }).first().click();
  await active(page).getByRole("textbox", { name: "新建节点", exact: true }).fill("图的遍历");
  await active(page).getByRole("button", { name: "保存节点" }).click();
  await expect(active(page).locator(".knowledge-row-title")).toHaveText("图的遍历");
  await active(page).locator(".knowledge-row-title").dblclick();
  await active(page).getByRole("textbox", { name: "节点标题" }).fill("广度优先遍历");
  await active(page).getByRole("textbox", { name: "节点标题" }).press("Enter");
  await expect(active(page).locator(".knowledge-row-title")).toHaveText("广度优先遍历");
  await active(page).getByRole("button", { name: "更多节点操作" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "编辑说明", exact: true }).click();
  await page.getByRole("dialog").getByRole("textbox", { name: "编辑节点说明", exact: true }).fill("BFS 使用队列；DFS 使用栈。");
  await page.getByRole("dialog").getByRole("button", { name: "保存", exact: true }).click();
  const count = await page.evaluate(async () => (await import("/src/db/database.ts")).db.knowledgeCommands.count());
  await active(page).getByRole("button", { name: "导图", exact: true }).click();
  await expect(active(page).locator("[data-map-root]")).toBeVisible();
  const initialZoom = parseInt(await active(page).locator(".knowledge-map-controls output").innerText(), 10);
  await active(page).getByRole("button", { name: "缩小导图", exact: true }).click();
  await expect.poll(async () => parseInt(await active(page).locator(".knowledge-map-controls output").innerText(), 10)).toBeLessThan(initialZoom);
  await page.keyboard.press("Control+f");
  await expect(page.getByRole("dialog").getByRole("textbox", { name: "检索知识库", exact: true })).toBeFocused();
  await page.getByRole("dialog").getByRole("textbox", { name: "检索知识库", exact: true }).fill("队列");
  await expect(page.getByRole("dialog").locator(".knowledge-results").getByRole("button")).toHaveCount(1);
  expect(await page.evaluate(async () => (await import("/src/db/database.ts")).db.knowledgeCommands.count())).toBe(count);
  expect(await page.evaluate(async () => (await import("/src/db/database.ts")).db.knowledgeLibraries.count())).toBe(1);
});

test("selected details cannot intercept filters, large results stay virtual and selected logs are organized", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "今天想记下什么？" })).toBeVisible();
  await page.evaluate(async () => {
    const { knowledgeRepository: repository } = await import("/src/features/knowledgeLibrary/runtime.ts");
    const { createKnowledgeEntity } = await import("/src/features/knowledgeLibrary/commands.ts");
    const { db } = await import("/src/db/database.ts");
    const library = await repository.createLibrary("过滤测试", "filters");
    const opened = await repository.open(library.id);
    const topic = createKnowledgeEntity(library.id, "workspace", "筛选专题");
    await repository.execute(opened.context, topic);
    await repository.execute(opened.context, createKnowledgeEntity(library.id, "node", "目标节点", topic.entity.id));
    await db.blocks.bulkPut(Array.from({ length: 1000 }, (_, index) => ({ id: "filter-" + index, type: "record", title: "验收日志 " + index, subject: index % 2 ? "数学" : "算法", date: index % 2 ? "2025-05-12" : "2026-09-22", createdAt: "2026-09-22T00:00:00.000Z", updatedAt: "2026-09-22T00:00:00.000Z", order: index, contentHtml: "<p>测试</p>", tags: index % 2 ? ["基础"] : ["图论"], assets: [], formulas: [], mistakeRefs: [] })));
  });
  await openKnowledge(page);
  await active(page).getByRole("button", { name: "筛选专题", exact: true }).click();
  await active(page).locator(".knowledge-row-title").click();
  await expect(active(page).getByRole("complementary", { name: "节点详情" })).toBeVisible();
  await active(page).getByRole("button", { name: "更多知识库操作" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "未加入专题的日志", exact: true }).click();
  await expect(active(page).locator(".knowledge-detail")).toHaveCount(0);
  await page.getByRole("dialog").getByRole("button", { name: "筛选", exact: true }).click();
  const label = page.getByRole("dialog").getByLabel("按标签筛选", { exact: true });
  const box = (await label.boundingBox())!;
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  await expect(label).toBeFocused();
  await label.fill("基础");
  await page.getByRole("dialog").getByLabel("按学科筛选", { exact: true }).selectOption("数学");
  await page.getByRole("dialog").getByLabel("按年份筛选", { exact: true }).selectOption("2025");
  await expect(page.getByRole("dialog").locator(".knowledge-result-count")).toContainText("500 项");
  expect(await page.getByRole("dialog").locator(".knowledge-result-row").count()).toBeLessThan(30);
  await page.getByRole("dialog").getByRole("checkbox", { name: "验收日志 1", exact: true }).check();
  await page.screenshot({ path: test.info().outputPath("filtered-logs.png"), animations: "disabled", scale: "css" });
  await page.getByRole("dialog").getByRole("button", { name: "添加所选 1 条日志", exact: true }).click();
  await expect(page.getByRole("dialog")).not.toBeVisible();
  await expect(active(page).getByRole("complementary", { name: "节点详情" }).getByRole("button", { name: "验收日志 1", exact: true })).toBeVisible();
});

test("keeps same-name libraries distinct and centralizes sync", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "今天想记下什么？" })).toBeVisible();
  await page.evaluate(async () => {
    const { knowledgeRepository: repository } = await import("/src/features/knowledgeLibrary/runtime.ts");
    for (const id of ["one", "two", "three"]) await repository.createLibrary("本机知识库", id);
  });
  await openKnowledge(page);
  await expect(active(page).getByRole("button", { name: /当前库：/ })).toBeVisible();
  await active(page).getByRole("button", { name: /当前库：/ }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.locator(".knowledge-library-list").getByRole("button")).toHaveCount(3);
  await dialog.getByLabel("知识库名称", { exact: true }).fill("考试复习");
  await dialog.getByRole("button", { name: "保存名称" }).click();
  await expect(dialog.locator(".knowledge-library-list")).toContainText("考试复习");
  await expect(dialog.getByRole("button", { name: "开启知识库同步", exact: true })).toHaveCount(0);
  await expect(dialog.getByText(/日常内容会随云同步一起保存/)).toBeVisible();
  expect(await page.evaluate(async () => (await import("/src/db/database.ts")).db.knowledgeLibraries.count())).toBe(3);
});


test("touch editing, IME confirmation, sibling creation and map editing keep intent explicit", async ({ page }) => {
  await openKnowledge(page);
  await active(page).getByRole("button", { name: "创建第一个专题" }).click();
  await page.getByRole("dialog").getByRole("textbox", { name: "新建专题" }).fill("交互专题");
  await page.getByRole("dialog").getByRole("button", { name: "创建专题", exact: true }).click();
  await active(page).getByRole("button", { name: "添加节点", exact: true }).first().click();
  const input = active(page).getByRole("textbox", { name: "新建节点", exact: true });
  await input.fill("中文节点");
  const prevented = await input.evaluate(element => !element.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", code: "Enter", isComposing: true, bubbles: true, cancelable: true })));
  expect(prevented).toBe(true);
  expect(await page.evaluate(async () => (await import("/src/db/database.ts")).db.knowledgeNodes.count())).toBe(0);
  await active(page).getByRole("button", { name: "保存节点" }).click();
  await active(page).getByRole("button", { name: "更多节点操作" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "添加同级节点", exact: true }).click();
  await active(page).getByRole("textbox", { name: "新建节点", exact: true }).fill("同级节点");
  await active(page).getByRole("button", { name: "保存节点" }).click();
  await active(page).getByRole("button", { name: "导图", exact: true }).click();
  await active(page).locator(".knowledge-map-label").filter({ hasText: "同级节点" }).dblclick();
  await active(page).getByRole("textbox", { name: "节点标题", exact: true }).fill("导图内编辑");
  await active(page).getByRole("button", { name: "保存节点" }).click();
  await expect(active(page).locator(".knowledge-map-label").filter({ hasText: "导图内编辑" })).toBeVisible();
  await active(page).getByRole("button", { name: "大纲", exact: true }).click();
  await expect(active(page).locator(".knowledge-row-title").filter({ hasText: "导图内编辑" })).toBeVisible();
});

test("new topic from an unorganized selection preserves the selection through first-library creation", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "今天想记下什么？" })).toBeVisible();
  await page.evaluate(async () => {
    const { db } = await import("/src/db/database.ts");
    await db.blocks.put({ id: "collect-first", type: "record", title: "第一次整理", subject: "读书笔记", date: "2026-09-22", createdAt: "2026-09-22T00:00:00.000Z", updatedAt: "2026-09-22T00:00:00.000Z", order: 0, contentHtml: "<p>保留正文</p>", tags: [], assets: [], formulas: [], mistakeRefs: [] });
  });
  await openKnowledge(page);
  await active(page).getByRole("button", { name: "更多知识库操作" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "未加入专题的日志", exact: true }).click();
  await page.getByRole("dialog").getByRole("checkbox", { name: "第一次整理" }).check();
  await page.getByRole("dialog").getByRole("button", { name: "新建专题", exact: true }).click();
  await page.getByRole("dialog").getByRole("textbox", { name: "新建专题", exact: true }).fill("就地创建");
  await page.getByRole("dialog").getByRole("button", { name: "创建专题", exact: true }).click();
  await expect(page.getByRole("dialog").getByRole("checkbox", { name: "第一次整理" })).toBeChecked();
  await page.getByRole("dialog").getByRole("button", { name: "添加所选 1 条日志", exact: true }).click();
  await expect(active(page).getByRole("heading", { name: "就地创建", exact: true })).toBeVisible();
  await expect(active(page).getByRole("complementary", { name: "节点详情" }).getByRole("button", { name: "第一次整理", exact: true })).toBeVisible();
  expect(await page.evaluate(async () => (await import("/src/db/database.ts")).db.knowledgeLibraries.count())).toBe(1);
});

for (const visual of ["reading", "modern"]) for (const theme of ["light", "dark"]) {
  test("canvas geometry and button density: " + visual + "/" + theme, async ({ page }) => {
    await openKnowledge(page);
    await page.evaluate(({ visual, theme }) => { document.documentElement.dataset.visualTheme = visual; document.documentElement.dataset.theme = theme; }, { visual, theme });
    await active(page).getByRole("button", { name: "创建第一个专题" }).click();
    await page.getByRole("dialog").getByRole("textbox", { name: "新建专题", exact: true }).fill("信息密度检查");
    await page.getByRole("dialog").getByRole("button", { name: "创建专题", exact: true }).click();
    await expect(active(page).locator(".knowledge-workspace")).toBeVisible();
    const geometry = await active(page).locator("main.knowledge-shell").evaluate(element => {
      const bounds = element.getBoundingClientRect();
      const workspace = element.querySelector(".knowledge-workspace")!.getBoundingClientRect();
      return { ratio: workspace.height / bounds.height, top: workspace.top, width: document.documentElement.scrollWidth, viewport: window.innerWidth, headerButtons: element.querySelectorAll(".knowledge-header button").length };
    });
    expect(geometry.ratio).toBeGreaterThan(page.viewportSize()!.width > 920 ? 0.8 : 0.7);
    expect(geometry.top).toBeLessThan(120);
    expect(geometry.width).toBeLessThanOrEqual(geometry.viewport);
    expect(geometry.headerButtons).toBeLessThanOrEqual(5);
    await expect(active(page).getByText("先浏览，再整理", { exact: false })).toHaveCount(0);
    await expect(active(page).getByRole("button", { name: "启用并发现账号知识库" })).toHaveCount(0);
  });
}
