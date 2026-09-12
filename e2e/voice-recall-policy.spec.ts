import { expect, test, type Page } from "@playwright/test";

const submitKeyboardAnswer = async (page: Page, answer: string) => {
  await page.getByRole("button", { name: "字幕与键盘输入" }).click();
  await page.getByLabel("本轮转写校对").fill(answer);
  await page.getByRole("button", { name: "确认并发送" }).click();
};

test("voice recall follows one-question boundaries and explicit user controls", async ({ page }) => {
  await page.goto("/?preview=voice-recall-policy");
  await page.getByRole("tab", { name: "自由主题" }).click();
  await page.getByRole("button", { name: /点击录音/ }).click();
  await page.getByPlaceholder("例如：解释事件循环").fill("核心概念");
  await page.getByRole("button", { name: "开始语音复述" }).click();
  await page.getByRole("checkbox", { name: /我了解本次发送范围/ }).check();
  await page.getByRole("button", { name: "确认并连接" }).click();

  await expect(page.getByRole("heading", { name: "先说说你对“核心概念”的整体理解。" })).toBeVisible();
  await submitKeyboardAnswer(page, "我只说了一部分");
  await expect(page.getByText("还缺一个关键联系。“核心概念”为什么会产生这个结果？", { exact: true })).toBeVisible();

  await submitKeyboardAnswer(page, "我还是只说了一部分");
  await expect(page.getByText("这部分已经覆盖。接着说说“运行机制”。", { exact: true })).toBeVisible();

  await submitKeyboardAnswer(page, "换到实际应用");
  await expect(page.getByText(/换到“实际应用”/, { exact: false })).toBeVisible();

  await submitKeyboardAnswer(page, "跳过这个问题");
  await expect(page.getByText(/换到“运行机制”/, { exact: false })).toBeVisible();
  await submitKeyboardAnswer(page, "运行机制的整体过程已经说明完整");
  await expect(page.getByRole("heading", { name: "要继续补充，还是查看总结？" })).toBeVisible();
  await expect(page.getByRole("button", { name: "准备自动听说" })).toHaveCount(0);

  await page.getByRole("button", { name: "继续补充" }).click();
  await submitKeyboardAnswer(page, "结束");
  await expect(page.getByRole("heading", { name: "要继续补充，还是查看总结？" })).toBeVisible();
  await expect(page.getByRole("button", { name: "查看总结" })).toBeVisible();
  await expect(page.getByRole("button", { name: "结束会话" })).toBeVisible();
});
