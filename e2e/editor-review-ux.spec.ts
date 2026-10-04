import { expect, test, type Page } from "@playwright/test";

const active = (page: Page) => page.locator('.page-transition-layer:not([aria-hidden="true"])').last();
const seedDraft = async (page: Page, changed: boolean) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "今天想记下什么？" })).toBeVisible();
  await page.evaluate(async different => {
    const { db } = await import("/src/db/database.ts");
    const record = { id: "draft-ux", type: "record", title: "版本核对验收", subject: "读书笔记", date: "2026-10-04", createdAt: "2026-10-01T00:00:00.000Z", updatedAt: "2026-10-03T00:00:00.000Z", order: 0, contentHtml: "<p>正式正文</p><p></p>", tags: [], assets: [], formulas: [], mistakeRefs: [] };
    await db.blocks.put(record);
    await db.recordDrafts.put({ id: record.id, recordId: record.id, baseUpdatedAt: "2026-10-02T00:00:00.000Z", draft: { ...record, contentHtml: different ? "<p>本机修改</p><p></p>" : record.contentHtml }, updatedAt: "2026-10-04T00:00:00.000Z" });
  }, changed);
  await page.reload();
  await page.getByRole("button", { name: "日志", exact: true }).first().click();
  await active(page).locator(".record-card-main").filter({ hasText: "版本核对验收" }).click();
  await expect(active(page).getByText("已恢复未保存草稿，点击保存后才会写入正式记录。")).toBeVisible();
};

test("redundant recovered drafts converge without false storage errors or formal writes", async ({ page }) => {
  await seedDraft(page, false);
  const before = await page.evaluate(async () => (await import("/src/db/database.ts")).db.blocks.get("draft-ux"));
  await active(page).getByRole("button", { name: "保存", exact: true }).click();
  await expect(active(page).getByRole("region", { name: "核对记录版本" })).toBeVisible();
  await expect(active(page).getByText(/本机草稿保存失败/)).toHaveCount(0);
  await active(page).getByRole("button", { name: "采用最新正式内容" }).click();
  await expect(active(page).getByText("正式内容已保存", { exact: true })).toBeVisible();
  const after = await page.evaluate(async () => { const { db } = await import("/src/db/database.ts"); return { record: await db.blocks.get("draft-ux"), draft: await db.recordDrafts.get("draft-ux") }; });
  expect(after.record).toEqual(before);
  expect(after.draft).toBeUndefined();
});

test("changed recovered drafts require confirmation and preserve the edited content", async ({ page }) => {
  await seedDraft(page, true);
  await active(page).getByRole("button", { name: "保存", exact: true }).click();
  const confirm = active(page).getByRole("button", { name: "确认保存当前编辑内容" });
  await expect(confirm).toBeDisabled();
  await active(page).getByRole("checkbox", { name: /已核对两份内容/ }).check();
  await confirm.click();
  await expect(active(page).getByText("正式内容已保存", { exact: true })).toBeVisible();
  expect(await page.evaluate(async () => (await (await import("/src/db/database.ts")).db.blocks.get("draft-ux"))?.contentHtml)).toContain("本机修改");
});

test("E opens the current review editor and returns to the same ungraded card", async ({ page }) => {
  await page.goto("/?preview=stage3");
  await page.getByRole("button", { name: /^复习/ }).first().click();
  await expect(active(page).getByRole("heading", { name: "BFS Stage3 Preview" })).toBeVisible();
  await expect(active(page)).toHaveClass(/page-transition-layer-entered/);
  const progress = await active(page).locator(".review-progress-meta").innerText();
  const feedback = active(page).getByRole("textbox", { name: "复习重点 1 本次评论" });
  await feedback.fill("e 不能触发编辑");
  await feedback.press("e");
  await expect(active(page).locator(".record-editor-page")).toHaveCount(0);
  await feedback.blur();
  await page.keyboard.press("E");
  await expect(active(page).getByRole("textbox", { name: "记录标题" })).toBeVisible();
  await active(page).getByRole("button", { name: "返回", exact: true }).first().click();
  await expect(active(page).locator(".review-progress-meta")).toHaveText(progress, { useInnerText: true });
  await expect(active(page).getByRole("heading", { name: "BFS Stage3 Preview" })).toBeVisible();
});
