import { expect, test, type Locator, type Page } from "@playwright/test";

test.setTimeout(45000);
const active = (page: Page) => page.locator('.page-transition-layer:not([aria-hidden="true"])').last();
const capture = async (page: Page, filename: string) => {
  await expect(page.locator(".page-transition-layer-exiting, .page-transition-layer-entering")).toHaveCount(0);
  await page.screenshot({ path: test.info().outputPath(filename), animations: "disabled", scale: "css" });
};
const pointerClick = async (page: Page, locator: Locator) => {
  await locator.scrollIntoViewIfNeeded();
  const bounds = (await locator.boundingBox())!;
  await page.mouse.click(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
};
const home = async (page: Page) => {
  await page.getByRole("button", { name: "更多", exact: true }).last().click();
  await active(page).getByRole("button", { name: "知识库", exact: true }).click();
  await expect(active(page).getByRole("heading", { name: "知识库", exact: true })).toBeVisible();
};
const manage = async (page: Page) => {
  await active(page).getByRole("button", { name: /当前库：/ }).click();
  await expect(page.getByRole("dialog").getByRole("heading", { name: "知识库管理", exact: true })).toHaveCount(1);
};

test("switches, renames, creates and deletes libraries by pointer without losing logs", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "今天想记下什么？" })).toBeVisible();
  await page.evaluate(async () => {
    const { knowledgeRepository: repository } = await import("/src/features/knowledgeLibrary/runtime.ts");
    const { createKnowledgeEntity } = await import("/src/features/knowledgeLibrary/commands.ts");
    const { db } = await import("/src/db/database.ts");
    for (const id of ["one", "two", "three"]) {
      await repository.createLibrary("本机知识库", id);
      const opened = await repository.open(id);
      await repository.execute(opened.context, createKnowledgeEntity(id, "workspace", "专题 " + id));
    }
    await db.blocks.put({ id: "keep-log", type: "record", title: "原日志保留", subject: "算法", date: "2026-09-23", createdAt: "2026-09-23T00:00:00.000Z", updatedAt: "2026-09-23T00:00:00.000Z", order: 0, contentHtml: "<p>原文</p>", tags: [], assets: [], formulas: [], mistakeRefs: [] });
  });
  await home(page);
  for (const id of ["two", "three", "one", "two"]) {
    await manage(page);
    await expect(page.locator("dialog[open]")).toHaveCount(1);
    const row = page.getByRole("dialog").locator(".knowledge-library-list button").filter({ hasText: "ID " + id });
    await pointerClick(page, row);
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(active(page).getByRole("button", { name: "专题 " + id, exact: true })).toBeVisible();
  }
  await manage(page);
  const name = page.getByLabel("知识库名称", { exact: true });
  await pointerClick(page, name);
  await expect(name).toBeFocused();
  await name.fill("考试复习");
  await name.press("Home"); await page.keyboard.type("A");
  await expect(name).toHaveValue("A考试复习");
  await page.getByRole("button", { name: "保存名称", exact: true }).click();
  await expect(page.getByRole("dialog").locator(".knowledge-library-list")).toContainText("A考试复习");
  await capture(page, "management.png");
  const geometry = await page.getByRole("dialog").evaluate(element => ({ width: element.scrollWidth, client: element.clientWidth, visible: Array.from(element.querySelectorAll("button")).filter(button => button.getBoundingClientRect().height > 0).length }));
  expect(geometry.width).toBeLessThanOrEqual(geometry.client);
  expect(geometry.visible).toBeLessThanOrEqual(8);
  const originalViewport = page.viewportSize()!;
  await page.setViewportSize(originalViewport.width > 920 ? { width: 1280, height: 800 } : { width: 360, height: 800 });
  await capture(page, "management-small.png");
  const overflow = await page.getByRole("dialog").evaluate(element => element.scrollWidth > element.clientWidth);
  expect(overflow).toBe(false);
  await page.setViewportSize(originalViewport);
  page.once("dialog", dialog => dialog.dismiss());
  await page.getByRole("button", { name: "删除本机库", exact: true }).click();
  await expect(name).toHaveValue("A考试复习");
  page.once("dialog", dialog => dialog.accept());
  await page.getByRole("button", { name: "删除本机库", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  expect(await page.evaluate(async () => (await import("/src/db/database.ts")).db.knowledgeLibraries.count())).toBe(2);
  expect(await page.evaluate(async () => (await import("/src/db/database.ts")).db.blocks.get("keep-log"))).toMatchObject({ contentHtml: "<p>原文</p>" });
  await manage(page);
  await page.getByRole("button", { name: "新建独立知识库", exact: true }).click();
  await pointerClick(page, name); await name.fill("项目资料");
  await page.getByRole("button", { name: "创建独立库", exact: true }).dblclick();
  await expect(active(page).getByRole("button", { name: "当前库：项目资料" })).toBeVisible();
  expect(await page.evaluate(async () => (await import("/src/db/database.ts")).db.knowledgeLibraries.count())).toBe(3);
  await active(page).getByRole("button", { name: "更多知识库操作" }).click();
  await expect(page.getByRole("button", { name: "未加入专题的日志", exact: true })).toHaveCount(1);
  await expect(page.getByRole("button", { name: "知识库与同步", exact: true })).toHaveCount(0);
});

test("topic inputs keep the caret, target selectors receive pointer focus, and dialog reopening stays interactive", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "今天想记下什么？" })).toBeVisible();
  await home(page);
  for (let iteration = 0; iteration < 3; iteration += 1) {
    await active(page).getByRole("button", { name: "创建第一个专题" }).click();
    await expect(page.locator("dialog[open]")).toHaveCount(1);
    const input = page.getByRole("textbox", { name: "新建专题", exact: true });
    await pointerClick(page, input); await input.fill("abc"); await input.press("Home");
    await page.keyboard.type("12", { delay: 80 });
    await expect(input).toHaveValue("12abc");
    await input.fill(""); await page.getByRole("button", { name: "取消", exact: true }).click();
  }
  await active(page).getByRole("button", { name: "创建第一个专题" }).click();
  await page.getByRole("textbox", { name: "新建专题", exact: true }).fill("交互专题");
  await page.getByRole("button", { name: "创建专题", exact: true }).click();
  await expect(active(page).getByRole("heading", { name: "交互专题", exact: true })).toBeVisible();
  for (const title of ["重点知识", "例题整理", "复习清单"]) {
    await active(page).getByRole("button", { name: "添加节点", exact: true }).first().click();
    await active(page).getByRole("textbox", { name: "新建节点", exact: true }).fill(title);
    await active(page).getByRole("button", { name: "保存节点", exact: true }).click();
    await active(page).getByRole("button", { name: "返回", exact: true }).click();
    await expect(active(page).getByRole("heading", { name: "知识库", exact: true })).toBeVisible();
    await active(page).getByRole("button", { name: "交互专题", exact: true }).click();
  }
  await capture(page, "outline.png");
  await active(page).getByRole("button", { name: "导图", exact: true }).click();
  await capture(page, "map.png");
  await active(page).getByRole("button", { name: "更多知识库操作" }).click();
  await page.getByRole("button", { name: "未加入专题的日志", exact: true }).click();
  for (const label of ["目标专题", "目标节点"]) {
    const select = page.getByLabel(label, { exact: true });
    await pointerClick(page, select); await page.keyboard.press("Escape"); await expect(select).toBeFocused();
    await select.press("End"); await select.press("Enter");
    await expect(select).not.toHaveValue("");
    await select.press("Escape");
  }
  await expect(page.getByRole("button", { name: "选择日志后添加", exact: true })).toBeDisabled();
  await capture(page, "collection.png");
});

test("clears deleted branches but preserves archives and blocks cloud-library purge", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "今天想记下什么？" })).toBeVisible();
  await page.evaluate(async () => {
    const { knowledgeRepository: repository } = await import("/src/features/knowledgeLibrary/runtime.ts");
    const { createKnowledgeEntity, editKnowledgeEntity } = await import("/src/features/knowledgeLibrary/commands.ts");
    await repository.createLibrary("清理测试", "trash-ui");
    const opened = await repository.open("trash-ui");
    for (const unit of ["deleted", "archived"] as const) {
      const topic = createKnowledgeEntity("trash-ui", "workspace", unit === "deleted" ? "已删除专题" : "归档专题");
      await repository.execute(opened.context, topic);
      await repository.execute(opened.context, createKnowledgeEntity("trash-ui", "node", "子节点", topic.entity.id));
      const current = await repository.open("trash-ui");
      await repository.execute(current.context, editKnowledgeEntity("trash-ui", current.state, current.state.entities[topic.entity.id], unit, true));
    }
  });
  await home(page);
  await active(page).getByRole("button", { name: "更多知识库操作" }).click();
  await page.getByRole("button", { name: "回收站与归档", exact: true }).click();
  await capture(page, "trash.png");
  page.once("dialog", dialog => dialog.accept());
  await page.getByRole("button", { name: "清空本机回收站", exact: true }).click();
  await expect(page.getByText("回收站为空。", { exact: true })).toBeVisible();
  await expect(page.getByText("归档专题", { exact: true })).toBeVisible();
  expect(await page.evaluate(async () => (await import("/src/db/database.ts")).db.knowledgeNodes.count())).toBe(1);
  await page.getByRole("button", { name: "取消归档", exact: true }).click();
  await expect(page.getByRole("button", { name: "取消归档", exact: true })).toHaveCount(0);
  await page.evaluate(async () => { const { db } = await import("/src/db/database.ts"); await db.knowledgeLibraries.update("trash-ui", { cloudLibraryId: "cloud-test" }); });
  await expect(page.getByText(/账号同步库不支持单方面永久清空/)).toBeVisible();
  await page.getByRole("button", { name: "关闭操作窗口" }).click(); await manage(page);
  await expect(page.getByRole("button", { name: "删除本机库", exact: true })).toBeDisabled();
});
