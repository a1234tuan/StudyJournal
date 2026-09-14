import { expect, test, type Page } from "@playwright/test";

const submitKeyboardAnswer = async (page: Page, answer: string) => {
  await page.getByRole("button", { name: "字幕与键盘输入" }).click();
  await page.getByLabel("本轮转写校对").fill(answer);
  await page.getByRole("button", { name: "确认并发送" }).click();
};

test("voice recall starts with the user and keeps natural conversation controls", async ({ page }) => {
  await page.goto("/?preview=voice-recall-policy");
  await page.getByRole("tab", { name: "自由主题" }).click();
  await page.getByRole("button", { name: /点击录音/ }).click();
  await page.getByPlaceholder("例如：解释事件循环").fill("核心概念");
  await page.getByRole("button", { name: "开始语音复述" }).click();
  await page.getByRole("checkbox", { name: /我了解本次发送范围/ }).check();
  await page.getByRole("button", { name: "确认并连接" }).click();

  await expect(page.getByRole("heading", { name: "已接通，你可以直接说。" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "先说说你对“核心概念”的整体理解。" })).toHaveCount(0);

  await submitKeyboardAnswer(page, "我只说了一部分");
  await expect(page.getByText(/我理解你刚才的重点是“我只说了一部分”/, { exact: false })).toBeVisible();
  await expect(page.getByText(/还缺一个关键联系|换到“运行机制”|再举一个/, { exact: false })).toHaveCount(0);

  await page.getByRole("button", { name: "结束并查看摘要" }).click();
  await expect(page.getByRole("heading", { name: "本次复述摘要" })).toBeVisible();
  await expect(page.getByRole("button", { name: "保留为本机历史" })).toBeVisible();
});
