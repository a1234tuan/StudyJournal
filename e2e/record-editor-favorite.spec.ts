import { expect, test, type Page } from "@playwright/test";

test.setTimeout(90_000);

const live = (page: Page) => page.locator('.page-transition-layer:not([aria-hidden="true"])').last();

const openNewRecord = async (page: Page) => {
  await page.goto("/");
  await page.getByRole("button", { name: "打开今日计划" }).click();
  await page.getByLabel("计划标题").fill("收藏保存回归");
  await page.getByRole("button", { name: /添加计划/ }).click();
  await live(page).locator(".daily-plan-row-main").filter({ hasText: "收藏保存回归" }).click();
  await expect(live(page).locator(".rich-editor[contenteditable='true']")).toBeVisible();
};

const toggleFavorite = async (page: Page, favorite: boolean) => {
  const action = live(page).getByRole("button", { name: favorite ? "收藏记录" : "取消收藏", exact: true });
  if (!await action.isVisible()) {
    await live(page).getByRole("button", { name: "更多操作", exact: true }).click();
  }
  await action.click();
};

const readRecords = async (page: Page) => page.evaluate(async () => {
  const modulePath = "/src/db/database.ts";
  const { db } = await import(modulePath);
  return { records: await db.blocks.toArray(), drafts: await db.recordDrafts.toArray() };
});

test("dirty editor saves after favorite and unfavorite without losing either change", async ({ page }) => {
  await openNewRecord(page);
  await live(page).getByRole("textbox", { name: "记录标题" }).fill("收藏保存测试日志");
  await live(page).locator(".rich-editor[contenteditable='true']").fill("收藏前输入的正文");
  await toggleFavorite(page, true);
  await page.getByRole("button", { name: "保存", exact: true }).click();
  await expect(live(page).getByText("正式内容已保存", { exact: true })).toBeVisible();
  await expect.poll(async () => {
    const data = await readRecords(page);
    return data.records.find((record: { title: string }) => record.title === "收藏保存测试日志");
  }).toMatchObject({ favorite: true, contentHtml: expect.stringContaining("收藏前输入的正文") });

  await live(page).getByRole("button", { name: "编辑", exact: true }).click();
  await live(page).locator(".rich-editor[contenteditable='true']").fill("取消收藏前新增的正文");
  await toggleFavorite(page, false);
  await page.getByRole("button", { name: "保存", exact: true }).click();
  await expect(live(page).getByText("正式内容已保存", { exact: true })).toBeVisible();
  const data = await readRecords(page);
  expect(data.records.find((record: { title: string }) => record.title === "收藏保存测试日志"))
    .toMatchObject({ favorite: false, contentHtml: expect.stringContaining("取消收藏前新增的正文") });
  expect(data.drafts).toHaveLength(0);
});

test("favoriting a dirty editor preserves a savable draft across leaving and reopening", async ({ page }) => {
  await openNewRecord(page);
  await live(page).getByRole("textbox", { name: "记录标题" }).fill("重开收藏草稿");
  await live(page).locator(".rich-editor[contenteditable='true']").fill("尚未正式保存的正文");
  await toggleFavorite(page, true);
  await page.getByRole("button", { name: "返回", exact: true }).click();
  await expect(page.getByRole("heading", { name: "今日计划", exact: true })).toBeVisible();
  await expect.poll(async () => {
    const data = await readRecords(page);
    return data.drafts[0]?.baseUpdatedAt === data.records[0]?.updatedAt && data.drafts[0]?.draft.favorite;
  }).toBe(true);
  await live(page).locator(".daily-plan-row-main").filter({ hasText: "收藏保存回归" }).click();
  await expect(live(page).getByRole("textbox", { name: "记录标题" })).toHaveValue("重开收藏草稿");
  await page.getByRole("button", { name: "保存", exact: true }).click();
  await expect(live(page).getByText("正式内容已保存", { exact: true })).toBeVisible();
  const data = await readRecords(page);
  expect(data.records[0]).toMatchObject({ title: "重开收藏草稿", favorite: true, contentHtml: expect.stringContaining("尚未正式保存的正文") });
  expect(data.drafts).toHaveLength(0);
});
