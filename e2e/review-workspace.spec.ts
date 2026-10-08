import { expect, test, type Page } from "@playwright/test";

test.setTimeout(90_000);
const active = (page: Page) => page.locator('.page-transition-layer:not([aria-hidden="true"])').last();
const seedReview = async (page: Page) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "今天想记下什么？" })).toBeVisible();
  await page.evaluate(async () => {
    const { storage } = await import("/src/services/storageAdapter.ts");
    const { db } = await import("/src/db/database.ts");
    const { todayISO } = await import("/src/lib/date.ts");
    const stamp = new Date().toISOString();
    for (let index = 0; index < 32; index++) {
      const id = "board-" + String(index).padStart(2, "0");
      await storage.saveBlock({ id, type: "record", date: todayISO(), subject: index % 2 ? "数学" : "计算机", title: "复习日志 " + id, contentHtml: "<p>复习浮窗测试内容</p>", assets: [], formulas: [], mistakeRefs: [], tags: [], order: index, createdAt: stamp, updatedAt: stamp });
      await storage.addRecordToReview(id);
      await db.recordReviews.update(id, { nextReviewDate: todayISO() });
    }
    for (const log of await db.recordReviewLogs.toArray()) {
      if (log.stateAfter) await db.recordReviewLogs.update(log.id, { nextReviewDate: todayISO(), stateAfter: { ...log.stateAfter, nextReviewDate: todayISO() } });
    }
    localStorage.setItem("studyjournal-review-edit-shortcut", "off");
  });
  await page.reload();
  await page.getByRole("button", { name: /^复习(?:\s+\d+)?$/ }).last().click();
  await expect(active(page).locator(".review-session")).toBeVisible();
};

test("review board is a centered list dialog preserving queue, focus, and selected scope", async ({ page }, info) => {
  await seedReview(page);
  const title = await active(page).locator(".review-session h1").first().textContent();
  await expect(active(page).getByRole("navigation", { name: "复习模式" })).toHaveCount(0);
  const entry = active(page).getByRole("button", { name: "复习看板", exact: true });
  await entry.click();
  const dialog = page.getByRole("dialog", { name: "复习看板", exact: true });
  await expect(dialog).toBeVisible();
  await expect(active(page).locator(".review-session")).toBeVisible();
  const box = await dialog.boundingBox();
  const viewport = page.viewportSize()!;
  expect(box!.x).toBeGreaterThan(4);
  expect(box!.y).toBeGreaterThan(4);
  expect(Math.abs(box!.x + box!.width / 2 - viewport.width / 2)).toBeLessThan(3);
  const list = dialog.getByLabel("待复习日志列表", { exact: true });
  expect(await list.evaluate(element => element.scrollHeight > element.clientHeight)).toBe(true);
  expect((await list.boundingBox())!.height / box!.height).toBeGreaterThan(.55);
  await dialog.getByRole("checkbox", { name: "选择 复习日志 board-00", exact: true }).check();
  await dialog.getByRole("textbox", { name: "搜索待复习日志" }).fill("board-01");
  await expect(dialog.getByText("含筛选外 1 条")).toBeVisible();
  await dialog.getByRole("button", { name: "已安排", exact: true }).click();
  await dialog.getByRole("button", { name: "待复习", exact: true }).click();
  await expect(dialog.getByRole("textbox", { name: "搜索待复习日志" })).toHaveValue("board-01");
  await dialog.getByRole("heading", { name: "复习看板" }).click();
  await page.keyboard.press("e");
  await expect(dialog).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(dialog).not.toBeVisible();
  await expect(entry).toBeFocused();
  expect(await active(page).locator(".review-session h1").first().textContent()).toBe(title);
  await entry.click();
  await expect(dialog.getByRole("textbox", { name: "搜索待复习日志" })).toHaveValue("board-01");
  await dialog.getByRole("button", { name: "开始所选复习" }).click();
  await expect(dialog).not.toBeVisible();
  await expect(active(page).getByRole("heading", { name: "复习日志 board-00", exact: true })).toBeVisible();
  await active(page).getByRole("button", { name: "返回看板", exact: true }).click();
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("textbox", { name: "搜索待复习日志" })).toHaveValue("board-01");
  await dialog.getByRole("textbox", { name: "搜索待复习日志" }).fill("");
  await page.evaluate(() => { document.documentElement.dataset.theme = "dark"; });
  await page.screenshot({ path: "output/review-workspace-2026-10-07/" + info.project.name + "-board.png" });
  await page.mouse.click(2, 2);
  await expect(dialog).not.toBeVisible();
  await active(page).getByRole("button", { name: "打开复习更多菜单" }).click();
  await expect(page.getByText(/快捷编辑：/)).toHaveCount(0);
});

test("voice entry from an active review keeps navigation and returns to the same queue", async ({ page }, info) => {
  await seedReview(page);
  const title = await active(page).locator(".review-session h1").first().textContent();
  await active(page).getByRole("button", { name: "打开复习更多菜单" }).click();
  await page.getByRole("menuitem", { name: "语音复述当前卡片" }).click();
  await expect(page.locator(".vr-start")).toBeVisible();
  await expect(page.locator(".app-shell")).not.toHaveClass(/immersive-task-active/);
  if (info.project.name === "desktop") await expect(page.locator(".sidebar")).toBeVisible();
  else await expect(page.locator(".bottom-nav")).toBeVisible();
  await page.getByRole("button", { name: "返回复习", exact: true }).click();
  await expect(active(page).locator(".review-session h1").first()).toHaveText(title!);
  await expect(active(page).getByRole("progressbar")).toHaveAttribute("aria-valuemax", "32");
  await expect(active(page).getByRole("progressbar")).toHaveAttribute("aria-valuenow", "0");
});
