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

test("switches, renames and deletes legacy libraries without offering new independent libraries", async ({ page }) => {
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
    const row = page.getByRole("dialog").locator(".knowledge-library-list button").nth(["one", "three", "two"].indexOf(id));
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
  await expect(page.getByRole("button", { name: "新建独立知识库", exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "关闭操作窗口", exact: true }).click();
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

test("keeps recovery copies with unresolved blocked commands undeletable", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "今天想记下什么？" })).toBeVisible();
  await page.evaluate(async () => {
    const { knowledgeRepository: repository } = await import("/src/features/knowledgeLibrary/runtime.ts");
    const { db } = await import("/src/db/database.ts");
    await repository.createLibrary("依赖来源库", "blocked-source");
    await repository.createLibrary("待确认恢复副本", "blocked-recovery", true);
    await db.knowledgeCommands.put({
      libraryId: "blocked-source",
      id: "blocked-command",
      command: { protocolVersion: 1, id: "blocked-command", libraryId: "blocked-source", operation: "create", entity: { id: "topic", kind: "workspace", workspaceId: "topic", nodeId: "", recordId: "" }, expected: { title: null, note: null, archived: null, deleted: null }, changes: { title: "待确认", note: "", archived: false, deleted: false } },
      hash: "a".repeat(64), status: "blocked", blockedReason: "stale", recoveryLibraryId: "blocked-recovery", localSequence: 1,
    });
  });
  await home(page);
  await manage(page);
  await page.getByText(/恢复管理 ·/).click();
  await pointerClick(page, page.getByRole("button", { name: "查看保留内容：待确认恢复副本", exact: true }));
  if (await page.getByRole("dialog").count()) await page.getByRole("dialog").getByRole("button", { name: "关闭操作窗口" }).click();
  await manage(page);
  const deleteButton = page.getByRole("button", { name: "删除本机库", exact: true });
  await expect(deleteButton).toBeDisabled();
  await expect(page.getByText("保留内容不会自动删除。", { exact: true })).toBeVisible();
  await capture(page, "protected-recovery-library.png");
});

test("can leave an inline editor after draft persistence fails without overwriting the old draft", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "今天想记下什么？" })).toBeVisible();
  await page.evaluate(async () => {
    const { knowledgeRepository: repository } = await import("/src/features/knowledgeLibrary/runtime.ts");
    const { createKnowledgeEntity } = await import("/src/features/knowledgeLibrary/commands.ts");
    await repository.createLibrary("草稿验证", "draft-recheck");
    const opened = await repository.open("draft-recheck");
    const topic = createKnowledgeEntity("draft-recheck", "workspace", "草稿专题");
    topic.entity.id = topic.entity.workspaceId = "draft-topic";
    await repository.execute(opened.context, topic);
    const node = createKnowledgeEntity("draft-recheck", "node", "原节点标题", topic.entity.id);
    node.entity.id = "draft-node";
    await repository.execute(opened.context, node);
  });
  await home(page);
  await active(page).getByRole("button", { name: "草稿专题", exact: true }).click();
  await active(page).getByRole("button", { name: "原节点标题", exact: true }).dblclick();
  const input = active(page).getByRole("textbox", { name: "节点标题", exact: true });
  await expect(input).toBeVisible();
  await page.evaluate(async () => {
    const { db } = await import("/src/db/database.ts");
    await db.knowledgeDrafts.put({ libraryId: "draft-recheck", id: "draft-node:title", entityId: "draft-node", unit: "title", text: "必须保留的旧稿", expectedRevision: null, dataGeneration: 0 });
  });
  await input.fill("本次未保存输入");
  await expect(active(page).getByRole("button", { name: "放弃本次输入并退出", exact: true })).toBeVisible();
  await capture(page, "inline-draft-failure-exit.png");
  page.once("dialog", dialog => dialog.accept());
  await active(page).getByRole("button", { name: "放弃本次输入并退出", exact: true }).click();
  await expect(input).toHaveCount(0);
  expect(await page.evaluate(async () => (await (await import("/src/db/database.ts")).db.knowledgeDrafts.get(["draft-recheck", "draft-node:title"]))?.text)).toBe("必须保留的旧稿");
  await expect(active(page).getByRole("button", { name: "原节点标题", exact: true })).toBeVisible();
});

test("resets outline position when changing topics and does not reuse a stale record origin", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "今天想记下什么？" })).toBeVisible();
  await page.evaluate(async () => {
    const { knowledgeRepository: repository } = await import("/src/features/knowledgeLibrary/runtime.ts");
    const { createKnowledgeEntity } = await import("/src/features/knowledgeLibrary/commands.ts");
    const { db } = await import("/src/db/database.ts");
    await repository.createLibrary("导航测试", "navigation-test");
    const opened = await repository.open("navigation-test");
    for (const [id, count] of [["长专题", 25], ["短专题", 1]] as const) {
      const topic = createKnowledgeEntity("navigation-test", "workspace", id);
      await repository.execute(opened.context, topic);
      for (let index = 0; index < count; index += 1) {
        const node = createKnowledgeEntity("navigation-test", "node", id + index, topic.entity.id);
        await repository.execute(opened.context, node);
        if (count === 1) await repository.execute(opened.context, createKnowledgeEntity("navigation-test", "reference", "", topic.entity.id, "@root", "origin-record", node.entity.id));
      }
    }
    await db.blocks.put({ id: "origin-record", type: "record", title: "来源日志", subject: "算法", date: "2026-09-23", createdAt: "2026-09-23T00:00:00.000Z", updatedAt: "2026-09-23T00:00:00.000Z", order: 0, contentHtml: "<p>导航回归</p>", tags: [], assets: [], formulas: [], mistakeRefs: [] });
  });
  await page.reload();
  await expect(page.getByRole("heading", { name: "今天想记下什么？" })).toBeVisible();
  await home(page);
  await active(page).getByRole("button", { name: "长专题", exact: true }).click();
  await active(page).locator(".knowledge-outline").evaluate(element => { element.scrollTop = 900; element.dispatchEvent(new Event("scroll", { bubbles: true })); });
  await expect.poll(() => active(page).locator(".knowledge-outline").evaluate(element => element.scrollTop)).toBeGreaterThan(0);
  await active(page).getByRole("button", { name: "返回", exact: true }).click();
  await active(page).getByRole("button", { name: "短专题", exact: true }).click();
  await expect.poll(() => active(page).locator(".knowledge-outline").evaluate(element => element.scrollTop)).toBe(0);
  await capture(page, "topic-scroll-reset.png");
  await active(page).getByRole("button", { name: "来源日志", exact: true }).click();
  await expect(active(page).locator(".record-editor-page")).toBeVisible();
  await active(page).getByRole("button", { name: "更多操作", exact: true }).click();
  await active(page).getByRole("button", { name: "加入专题", exact: true }).click();
  await expect(active(page).getByRole("heading", { name: "知识库", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "今天", exact: true }).last().click();
  await home(page);
  await active(page).getByRole("button", { name: "返回", exact: true }).click();
  await expect(active(page).locator(".record-editor-page")).toHaveCount(0);
  await expect(active(page).getByRole("button", { name: "知识库", exact: true })).toBeVisible();
});

test("shows safe cloud-history recovery without skipping damaged commits", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "今天想记下什么？" })).toBeVisible();
  await page.evaluate(async () => {
    const { knowledgeRepository: repository } = await import("/src/features/knowledgeLibrary/runtime.ts");
    await repository.createLibrary("云历史异常", "broken-library");
    await repository.recordSyncFailure((await repository.open("broken-library")).context, "invalid", { cursor: 0, sequence: 1, fingerprint: "f".repeat(64) });
  });
  await home(page);
  await expect(active(page).getByText("云提交校验失败，知识库同步已停止。本机内容和待同步操作仍保留。", { exact: true })).toBeVisible();
  await capture(page, "cloud-history-recovery.png");
  await active(page).getByRole("button", { name: "保全并打开本机副本", exact: true }).click();
  await expect(active(page).getByText("此恢复副本正在保全待确认内容，只能查看。", { exact: true })).toBeVisible();
  await expect(active(page).getByRole("button", { name: "创建第一个专题", exact: true })).toBeDisabled();
  await capture(page, "cloud-history-preserved-copy.png");
});
test("keeps preserved source drafts accessible without the old sync selection UI", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "今天想记下什么？" })).toBeVisible();
  await page.evaluate(async () => {
    const { knowledgeRepository: repository } = await import("/src/features/knowledgeLibrary/runtime.ts");
    const { db } = await import("/src/db/database.ts");
    await repository.createLibrary("默认知识库", "current");
    await repository.createLibrary("旧本机内容", "preserved");
    await db.knowledgeLibraryMigrations.put({ ownerScope: "deviceGuest", sourceLibraryId: "preserved", targetLibraryId: "current", cloudLibraryId: "cloud", sourceHash: "preview", sourceEpoch: 0, sourceGeneration: 0, sessionId: "saved", phase: "confirmed" });
    await db.knowledgeDrafts.put({ libraryId: "preserved", id: "draft", entityId: "node", unit: "note", text: "旧输入仍在这里", expectedRevision: null, dataGeneration: 0 });
  });
  await home(page); await manage(page);
  await page.getByText(/恢复管理 ·/).click();
  await page.getByText("未提交草稿", { exact: true }).click();
  await expect(page.getByRole("textbox", { name: "保留的草稿" })).toHaveValue("旧输入仍在这里");
  await expect(page.getByLabel("复制来源知识库")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "新建独立知识库", exact: true })).toHaveCount(0);
  await capture(page, "preserved-draft-recovery.png");
});
