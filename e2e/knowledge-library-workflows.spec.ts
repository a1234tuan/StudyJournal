import { expect, test, type Page } from "@playwright/test";

test.setTimeout(90000);
const active = (page: Page) => page.locator('.page-transition-layer:not([aria-hidden="true"])').last();
const prepare = async (page: Page) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "今天想记下什么？" })).toBeVisible();
  const ids = await page.evaluate(async () => {
    const { knowledgeRepository: repository } = await import("/src/features/knowledgeLibrary/runtime.ts");
    const { createKnowledgeEntity } = await import("/src/features/knowledgeLibrary/commands.ts");
    const { storage } = await import("/src/services/storageAdapter.ts");
    await repository.createLibrary("验收本机库", "acceptance");
    const opened = await repository.open("acceptance");
    const topic = createKnowledgeEntity("acceptance", "workspace", "算法专题");
    await repository.execute(opened.context, topic);
    const node = createKnowledgeEntity("acceptance", "node", "遍历方法", topic.entity.id);
    await repository.execute(opened.context, node);
    const other = createKnowledgeEntity("acceptance", "node", "练习", topic.entity.id);
    await repository.execute(opened.context, other);
    await storage.saveBlock({ id: "bfs-log", type: "record", title: "BFS 复习", subject: "读书笔记", date: "2026-09-22", createdAt: "2026-09-22T00:00:00.000Z", updatedAt: "2026-09-22T00:00:00.000Z", order: 0, contentHtml: "<p>队列保存待访问节点</p>", tags: [], assets: [], formulas: [], mistakeRefs: [] });
    return { topic: topic.entity.id, node: node.entity.id, other: other.entity.id };
  });
  await page.reload();
  await page.getByRole("button", { name: "更多", exact: true }).last().click();
  await page.getByRole("button", { name: /知识库/ }).click();
  await active(page).getByRole("button", { name: /算法专题/ }).click();
  return ids;
};

test("adds a log once, preserves remarks through remove and restore, and returns from the log reader", async ({ page }) => {
  await prepare(page);
  await active(page).getByRole("button", { name: /遍历方法/ }).click();
  await active(page).getByRole("button", { name: "添加日志", exact: true }).click();
  await page.getByRole("dialog").getByRole("checkbox").check();
  await page.getByRole("dialog").getByRole("button", { name: "添加所选 1 条日志" }).click();
  await expect(active(page).getByRole("button", { name: "BFS 复习", exact: true })).toBeVisible();
  await active(page).getByLabel("引用操作：BFS 复习").click();
  await active(page).getByRole("button", { name: "编辑备注" }).click();
  await page.getByRole("dialog").getByLabel("编辑引用备注", { exact: true }).fill("先看队列");
  await page.getByRole("dialog").getByRole("button", { name: "保存", exact: true }).click();
  await active(page).getByRole("button", { name: "BFS 复习", exact: true }).click();
  await expect(active(page).locator(".record-editor-page")).toBeVisible();
  await expect(active(page).locator(".rich-editor")).toContainText("队列保存待访问节点");
  await expect(active(page).getByRole("button", { name: "加入专题", exact: true })).toHaveCount(0);
  await expect(active(page).locator(".record-editor-page > .record-knowledge-links")).toHaveCount(0);
  await active(page).getByRole("button", { name: "更多操作", exact: true }).click();
  await expect(active(page).locator(".record-more-menu").getByRole("button", { name: "加入专题", exact: true })).toBeVisible();
  await expect(page.locator(".page-transition-layer-exiting, .page-transition-layer-entering")).toHaveCount(0);
  await page.screenshot({ path: test.info().outputPath("record-more.png"), animations: "disabled", scale: "css" });
  await active(page).getByRole("button", { name: "收起更多操作", exact: true }).click();
  await active(page).getByRole("button", { name: "返回", exact: true }).first().click();
  await expect(active(page).getByRole("heading", { name: "遍历方法", exact: true })).toBeVisible();
  await active(page).getByLabel("引用操作：BFS 复习").click();
  page.once("dialog", dialog => dialog.accept());
  await active(page).getByRole("button", { name: "移除引用" }).click();
  await active(page).getByRole("button", { name: /遍历方法/ }).click();
  await active(page).getByRole("button", { name: "添加日志", exact: true }).click();
  await page.getByRole("dialog").getByRole("checkbox").check();
  page.once("dialog", dialog => dialog.accept());
  await page.getByRole("dialog").getByRole("button", { name: "添加所选 1 条日志" }).click();
  await expect(active(page).getByText("先看队列", { exact: true })).toBeVisible();
  const persisted = await page.evaluate(async () => { const { db } = await import("/src/db/database.ts"); return { refs: await db.knowledgeReferences.count(), log: await db.blocks.get("bfs-log") }; });
  expect(persisted.refs).toBe(1);
  expect(persisted.log.contentHtml).toBe("<p>队列保存待访问节点</p>");
});

test("retains input when another writer updates the note and never silently approves new candidates", async ({ page }) => {
  const ids = await prepare(page);
  await active(page).getByRole("button", { name: /遍历方法/ }).click();
  await active(page).getByRole("button", { name: "更多节点操作" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "编辑说明", exact: true }).click();
  await page.getByRole("dialog").getByLabel("编辑节点说明", { exact: true }).fill("我的未保存说明");
  await page.evaluate(async id => { const { knowledgeRepository: repository } = await import("/src/features/knowledgeLibrary/runtime.ts"); const { editKnowledgeEntity } = await import("/src/features/knowledgeLibrary/commands.ts"); const opened = await repository.open("acceptance"); await repository.execute(opened.context, editKnowledgeEntity("acceptance", opened.state, opened.state.entities[id], "note", "另一窗口较新正文")); }, ids.node);
  await page.getByRole("dialog").getByRole("button", { name: "保存", exact: true }).click();
  await expect(page.getByRole("dialog").getByRole("textbox", { name: "编辑节点说明", exact: true })).toHaveValue("我的未保存说明");
  await expect(page.getByRole("dialog").getByRole("alert")).toContainText("内容已在其他位置更新");
  const saved = await page.evaluate(async id => { const { knowledgeRepository: repository } = await import("/src/features/knowledgeLibrary/runtime.ts"); const { valueOf } = await import("/src/features/knowledgeLibrary/protocol.ts"); const opened = await repository.open("acceptance"); return valueOf(opened.state, opened.state.entities[id], "note"); }, ids.node);
  expect(saved).toBe("另一窗口较新正文");
});

test("pans and drags only from handles; browse gestures never create writes", async ({ page }) => {
  const ids = await prepare(page);
  await active(page).getByRole("button", { name: "导图", exact: true }).click();
  const count = await page.evaluate(async () => { const { db } = await import("/src/db/database.ts"); return db.knowledgeCommands.count(); });
  const viewport = active(page).locator(".knowledge-map-viewport");
  const rect = (await viewport.boundingBox())!;
  await page.mouse.move(rect.x + 30, rect.y + 280); await page.mouse.down(); await page.mouse.move(rect.x + 100, rect.y + 300, { steps: 10 }); await page.mouse.up();
  await active(page).getByRole("button", { name: "查看全貌" }).click();
  expect(await page.evaluate(async () => { const { db } = await import("/src/db/database.ts"); return db.knowledgeCommands.count(); })).toBe(count);
  const handle = active(page).getByRole("button", { name: "拖动分支：遍历方法" });
  const target = active(page).locator('[data-node-id="' + ids.other + '"]');
  const sourceBox = (await handle.boundingBox())!; const targetBox = (await target.boundingBox())!;
  await page.mouse.move(sourceBox.x + 15, sourceBox.y + 20); await page.mouse.down(); await page.mouse.move(targetBox.x + 75, targetBox.y + 25, { steps: 12 }); await page.mouse.up();
  await expect.poll(async () => page.evaluate(async id => { const { knowledgeRepository: repository } = await import("/src/features/knowledgeLibrary/runtime.ts"); const { valueOf } = await import("/src/features/knowledgeLibrary/protocol.ts"); const opened = await repository.open("acceptance"); return valueOf(opened.state, opened.state.entities[id], "position"); }, ids.node)).toMatchObject({ parentNodeId: ids.other });
  await expect(page.getByRole("dialog")).not.toBeVisible();
});
