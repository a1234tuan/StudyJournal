import { expect, test, type Page } from "@playwright/test";

const enter = async (page: Page) => {
  await page.getByRole("button", { name: "日志", exact: true }).first().click();
  await expect(page.locator(".journal-toolbar")).toBeVisible();
  await expect(page.locator(".page-transition-layer-entering, .page-transition-layer-exiting")).toHaveCount(0);
};
const seed = async (page: Page) => {
  await page.goto("/?preview=journal-performance");
  await expect(page.getByRole("heading", { name: "今天", exact: true })).toBeVisible();
  const topicId = await page.evaluate(async () => {
    const { db } = await import("/src/db/database.ts");
    const { knowledgeRepository: repository } = await import("/src/features/knowledgeLibrary/runtime.ts");
    const { createKnowledgeEntity } = await import("/src/features/knowledgeLibrary/commands.ts");
    const records = (await db.blocks.toArray()).filter(record => record.type === "record").slice(0, 4);
    const names = ["数学重点", "数据结构重点", "数学公式", "无标签日志"];
    await db.blocks.clear();
    await db.blocks.bulkPut(records.map((record, index) => ({ ...record, title: names[index], subject: index === 1 ? "数据结构" : "数学", date: "2026-10-" + String(12 - index).padStart(2, "0"), tags: index < 2 ? ["重点"] : index === 2 ? ["公式"] : [] })));
    await repository.createLibrary("筛选测试库", "filter-library");
    const { context } = await repository.open("filter-library");
    const topic = createKnowledgeEntity("filter-library", "workspace", "交叉学科专题");
    await repository.execute(context, topic);
    for (const ordinal of [0, 1]) {
      const node = createKnowledgeEntity("filter-library", "node", "节点" + ordinal, topic.entity.id);
      await repository.execute(context, node);
      for (const record of records.slice(0, 3)) await repository.execute(context, createKnowledgeEntity("filter-library", "reference", "", topic.entity.id, "@root", record.id, node.entity.id));
    }
    await repository.createLibrary("不应出现的恢复副本", "filter-copy", true);
    const copy = await repository.open("filter-copy");
    await repository.execute(copy.context, createKnowledgeEntity("filter-copy", "workspace", "恢复副本专题"));
    return topic.entity.id;
  });
  await page.goto("/");
  await enter(page);
  return topicId;
};
const pickTag = async (page: Page, name: string) => {
  await page.getByRole("button", { name: /^(按标签|标签：)/ }).click();
  await page.getByRole("dialog", { name: "选择标签" }).getByRole("button", { name, exact: true }).click();
};
const pickTopic = async (page: Page) => {
  await page.getByRole("button", { name: /^(按专题|专题：)/ }).click();
  const dialog = page.getByRole("dialog", { name: "选择专题" });
  await expect(dialog.getByText("恢复副本专题")).toHaveCount(0);
  await dialog.getByRole("button", { name: "交叉学科专题 筛选测试库" }).click();
};
const expectCount = async (page: Page, count: number) => {
  await expect(page.locator(".journal-result-meta")).toContainText(count + " 条日志");
  await expect(page.locator(".journal-library-records .record-card")).toHaveCount(count);
};

test("all, tags and topics intersect with subject without changing business facts", async ({ page }, info) => {
  await seed(page);
  const facts = () => page.evaluate(async () => { const { db } = await import("/src/db/database.ts"); return JSON.stringify(await Promise.all([db.blocks.toArray(), db.recordReviews.toArray(), db.recordReviewLogs.toArray(), db.recordReviewDayStats.toArray(), db.knowledgeReferences.toArray(), db.knowledgeCommands.toArray()])); });
  const before = await facts();
  await expectCount(page, 4);
  if (info.project.name === "desktop") {
    await expect(page.locator(".journal-preview-heading h2")).toHaveText("数学重点");
    await expect(page.getByRole("tab", { name: "按日期" })).toHaveCount(0);
  } else await expect(page.locator(".journal-record-preview")).toHaveCount(0);
  const subject = page.getByLabel("按学科筛选", { exact: true });
  await subject.selectOption("数学");
  await expectCount(page, 3);
  await pickTag(page, "重点");
  await expectCount(page, 1);
  await subject.selectOption("全部");
  await expectCount(page, 2);
  await pickTopic(page);
  await expectCount(page, 3);
  await subject.selectOption("数据结构");
  await expectCount(page, 1);
  if (info.project.name === "desktop") await expect(page.locator(".journal-preview-heading h2")).toHaveText("数据结构重点");
  await page.getByRole("tab", { name: "全部日志", exact: true }).click();
  await expect(subject).toHaveValue("数据结构");
  await expectCount(page, 1);
  await pickTag(page, "公式");
  await expectCount(page, 0);
  if (info.project.name === "desktop") {
    await expect(page.locator(".journal-record-preview")).toBeVisible();
    const list = await page.locator(".journal-library-scroll").boundingBox();
    const preview = await page.locator(".journal-record-preview").boundingBox();
    expect(preview!.x).toBeGreaterThan(list!.x + list!.width - 1);
  }
  expect(await facts()).toBe(before);
});

test("topic updates are live, deduplicated and owner-safe", async ({ page }) => {
  const topicId = await seed(page);
  await pickTopic(page);
  await expectCount(page, 3);
  await page.evaluate(async topicId => {
    const { knowledgeRepository: repository } = await import("/src/features/knowledgeLibrary/runtime.ts");
    const { editKnowledgeEntity } = await import("/src/features/knowledgeLibrary/commands.ts");
    const { state, context } = await repository.open("filter-library");
    await repository.execute(context, editKnowledgeEntity("filter-library", state, state.entities[topicId], "title", "改名后的专题"));
  }, topicId);
  await expect(page.getByRole("button", { name: "专题：改名后的专题" })).toBeVisible();
  await expectCount(page, 3);
  await page.evaluate(async topicId => {
    const { knowledgeRepository: repository } = await import("/src/features/knowledgeLibrary/runtime.ts");
    const { editKnowledgeEntity } = await import("/src/features/knowledgeLibrary/commands.ts");
    const { state, context } = await repository.open("filter-library");
    await repository.execute(context, editKnowledgeEntity("filter-library", state, state.entities[topicId], "archived", true));
  }, topicId);
  await expect(page.locator(".journal-result-meta")).toContainText("专题已归档");
  await expect(page.locator(".journal-library-records .record-card")).toHaveCount(0);
  await page.evaluate(async () => { const { changeKnowledgeOwner } = await import("/src/features/knowledgeLibrary/context.ts"); changeKnowledgeOwner("account:isolated-test"); window.dispatchEvent(new Event("knowledge-owner-changed")); });
  await expect(page.locator(".journal-result-meta")).toContainText("账号已变化");
  await page.getByRole("button", { name: /专题：/ }).click();
  await expect(page.getByRole("dialog")).toContainText("当前身份还没有可用专题");
});

test("selected scope survives full record return, search return and explicit preview close", async ({ page }, info) => {
  await seed(page);
  await pickTag(page, "重点");
  await page.getByLabel("按学科筛选", { exact: true }).selectOption("数据结构");
  await page.locator(".journal-library-records .record-card-main").first().click();
  await page.getByRole("button", { name: "打开完整日志" }).click();
  await page.getByRole("button", { name: "返回", exact: true }).click();
  await expect(page.locator(".journal-preview-heading h2")).toHaveText("数据结构重点");
  await page.getByRole("button", { name: "返回列表" }).click();
  if (info.project.name === "desktop") await expect(page.locator(".journal-record-preview")).toContainText("选择左侧日志以预览");
  else await expect(page.locator(".journal-record-preview")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "标签：重点", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "全局搜索", exact: true }).click();
  await page.getByRole("button", { name: "返回", exact: true }).click();
  await expect(page.getByLabel("按学科筛选", { exact: true })).toHaveValue("数据结构");
  await expectCount(page, 1);
  if (info.project.name === "desktop") await expect(page.locator(".journal-record-preview")).toContainText("选择左侧日志以预览");
});

test("filter popovers do not push reading panes and remain usable with long names", async ({ page }, info) => {
  const topicId = await seed(page);
  const workspace = await page.locator(".journal-reading-workspace").boundingBox();
  const trigger = page.getByRole("button", { name: "按标签", exact: true });
  await trigger.click();
  await expect(page.getByLabel("搜索标签")).toBeFocused();
  const opened = await page.locator(".journal-reading-workspace").boundingBox();
  expect(opened!.y).toBe(workspace!.y);
  expect(opened!.height).toBe(workspace!.height);
  await page.keyboard.press("Escape");
  await expect(trigger).toBeFocused();
  if (info.project.name === "desktop") await expect(page.locator(".journal-preview-heading h2")).toBeVisible();
  await page.evaluate(async topicId => {
    const { db } = await import("/src/db/database.ts");
    const records = (await db.blocks.toArray()).filter(record => record.type === "record");
    await db.blocks.update(records[0].id, { tags: ["重点", "跨学科综合知识梳理与长标签边界验证".repeat(3), ...Array.from({ length: 60 }, (_, index) => "排序标签" + index)] });
    const { knowledgeRepository: repository } = await import("/src/features/knowledgeLibrary/runtime.ts");
    const { editKnowledgeEntity } = await import("/src/features/knowledgeLibrary/commands.ts");
    const { state, context } = await repository.open("filter-library");
    await repository.execute(context, editKnowledgeEntity("filter-library", state, state.entities[topicId], "title", "跨学科专题名称与超长标题边界验证".repeat(5)));
  }, topicId);
  await page.goto("/");
  await enter(page);
  for (const width of info.project.name === "desktop" ? [1440, 1024] : [390, 320]) {
    await page.setViewportSize({ width, height: 900 });
    await trigger.click();
    await expect(page.getByRole("dialog")).toBeVisible();
    const dialog = await page.getByRole("dialog").boundingBox();
    expect(dialog!.x).toBeGreaterThanOrEqual(0);
    expect(dialog!.x + dialog!.width).toBeLessThanOrEqual(width + 1);
    expect(await page.locator(".journal-filter-options").evaluate(element => element.scrollHeight > element.clientHeight)).toBe(true);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
    await page.screenshot({ path: info.outputPath("filters-" + width + ".png"), animations: "disabled" });
    await page.keyboard.press("Escape");
  }
  await page.evaluate(() => { document.documentElement.dataset.theme = "dark"; document.documentElement.style.fontSize = "20px"; });
  await page.getByRole("button", { name: "按专题", exact: true }).click();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  await page.screenshot({ path: info.outputPath("filters-dark-large.png"), animations: "disabled" });
  await page.getByRole("dialog").getByRole("button", { name: /跨学科专题名称/ }).click();
  await expectCount(page, 3);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  if (info.project.name !== "desktop") {
    const labels = await page.locator(".journal-scope-button > span").evaluateAll(elements => elements.map(element => ({ text: element.textContent, fits: element.scrollWidth <= element.clientWidth })));
    expect(labels).toEqual([{ text: "标签", fits: true }, { text: "专题", fits: true }]);
    await expect(page.locator(".journal-result-scope")).toContainText("跨学科专题名称");
  }
  await page.screenshot({ path: info.outputPath("selected-topic-dark-large.png"), animations: "disabled" });
});

test("calendar stays mobile-only and widening safely restores the desktop library", async ({ page }, info) => {
  test.skip(info.project.name !== "desktop", "This case transitions between web viewport modes");
  await seed(page);
  await page.getByRole("button", { name: "返回列表" }).click();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole("tab", { name: "按日期", exact: true }).click();
  await expect(page.getByText("本月有记录日期")).toBeVisible();
  await page.setViewportSize({ width: 1440, height: 1000 });
  await expect(page.locator(".journal-fixed-reading")).toBeVisible();
  await expect(page.getByRole("tab", { name: "按日期", exact: true })).toHaveCount(0);
  await expectCount(page, 4);
});
