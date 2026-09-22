import { expect, test } from "@playwright/test";

test.setTimeout(90000);
const active = (page: import("@playwright/test").Page) => page.locator('.page-transition-layer:not([aria-hidden="true"])').last();

test("creates a topic, keeps browsing read-only, edits notes and switches to map", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "今天想记下什么？" })).toBeVisible();
  await page.getByRole("button", { name: "更多", exact: true }).last().click();
  await page.getByRole("button", { name: /知识库/ }).click();
  await expect(page.getByRole("heading", { name: "知识库", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "新建本机库", exact: true }).click();
  await page.getByRole("button", { name: "新建专题", exact: true }).click();
  await page.getByRole("dialog").getByLabel("新建专题", { exact: true }).fill("数据结构");
  await page.getByRole("dialog").getByRole("button", { name: "保存", exact: true }).click();
  await expect(active(page).getByRole("heading", { name: "数据结构", exact: true })).toBeVisible();
  await expect(active(page).getByRole("button", { name: "添加分支", exact: true })).toHaveCount(0);
  await active(page).getByRole("button", { name: "整理", exact: true }).click();
  await active(page).getByRole("button", { name: "添加分支", exact: true }).click();
  await page.getByRole("dialog").getByLabel("新建节点", { exact: true }).fill("图的遍历");
  await page.getByRole("dialog").getByRole("button", { name: "保存", exact: true }).click();
  await expect(active(page).getByRole("heading", { name: "图的遍历", exact: true })).toBeVisible();
  await active(page).getByRole("button", { name: "编辑说明", exact: true }).last().click();
  await page.getByRole("dialog").getByLabel("编辑节点说明", { exact: true }).fill("BFS 使用队列；DFS 使用栈。");
  await page.getByRole("dialog").getByRole("button", { name: "保存", exact: true }).click();
  await expect(active(page).getByText("BFS 使用队列；DFS 使用栈。", { exact: true })).toBeVisible();
  await active(page).getByRole("button", { name: "关闭节点详情", exact: true }).click();
  await active(page).getByRole("button", { name: "完成整理", exact: true }).click();
  await active(page).getByRole("button", { name: "导图", exact: true }).click();
  await expect(active(page).getByRole("region", { name: "专题导图" })).toBeVisible();
  await active(page).getByRole("button", { name: "缩小导图", exact: true }).click();
  await expect(active(page).locator(".knowledge-map-section output")).toHaveText("83%");
  await page.keyboard.press("Control+f");
  await expect(active(page).getByLabel("检索知识库", { exact: true })).toBeFocused();
  await active(page).getByLabel("检索知识库", { exact: true }).fill("队列");
  await expect(active(page).locator(".knowledge-results").getByRole("button")).toHaveCount(1);
});
