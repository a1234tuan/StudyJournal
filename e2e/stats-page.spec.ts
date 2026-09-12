import { expect, test } from "@playwright/test";

test("stats page prioritizes action and keeps the home status lightweight", async ({ page }) => {
  await page.goto("/?preview=stage3");
  await page.getByRole("button", { name: "更多", exact: true }).last().click();
  await expect(page.getByRole("heading", { name: "更多" })).toBeVisible();
  await page.getByRole("button", { name: "统计", exact: true }).click();

  await expect(page.getByRole("heading", { name: "学习状态" }).first()).toBeVisible();
  await expect(page.getByRole("heading", { name: "需要行动" })).toBeVisible();
  await expect(page.getByText("今日待复习", { exact: true })).toBeVisible();
  await expect(page.getByText("近 7 天回忆成功率", { exact: true })).toBeVisible();
  await expect(page.getByText("资源文件", { exact: true })).toHaveCount(0);
  await expect(page.getByText("近 14 天记录趋势", { exact: true })).toHaveCount(0);

  await page.getByRole("button", { name: "今天", exact: true }).last().click();
  await expect(page.getByRole("heading", { name: "今天想记下什么？" })).toBeVisible();
  await expect(page.getByRole("region", { name: "今日状态" })).toBeVisible();
  await expect(page.locator(".today-status-line")).toHaveCSS("display", "flex");
});
