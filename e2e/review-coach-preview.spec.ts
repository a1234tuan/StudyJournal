import { expect, test } from "@playwright/test";

test("shows and exercises the isolated AI coach preview", async ({ page }, testInfo) => {
  const errors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  page.on("pageerror", (error) => errors.push(error.message));

  await page.goto("/?preview=coach");
  await expect(page.getByRole("heading", { name: "AI 驾驶舱" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "复习助教" })).toBeVisible();
  await expect(page.getByText("训练效果", { exact: true })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("coach-dashboard.png"), fullPage: true });

  await page.getByRole("button", { name: "自适应训练" }).click();
  await expect(page.getByText("在 BFS 中首次发现一个尚未访问的相邻节点时")).toBeVisible();
  await page.getByRole("button", { name: "提示 1" }).click();
  await expect(page.getByText("考虑两个父节点同时发现同一个相邻节点。")).toBeVisible();
  await page.getByRole("button", { name: "语音输入" }).click();
  await page.getByRole("textbox", { name: "语音回答转写" }).fill("先标记 visited，再入队，避免重复入队。");
  await expect(page.getByRole("button", { name: "提交回答" })).toBeDisabled();
  await page.getByRole("button", { name: "确认转写" }).click();
  await expect(page.getByRole("button", { name: "提交回答" })).toBeEnabled();
  await page.getByRole("button", { name: "提交回答" }).click();
  await expect(page.getByText("回答正确", { exact: true })).toBeVisible();

  await page.getByRole("button", { name: "延迟验证" }).click();
  await expect(page.getByText("Delayed Verification", { exact: true })).toBeVisible();
  await expect(page.getByText("结果不会改写整条日志的 FSRS 日期。", { exact: false })).toBeVisible();

  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(1);
  expect(errors).toEqual([]);

  await page.screenshot({ path: testInfo.outputPath("coach-preview.png"), fullPage: true });
});
