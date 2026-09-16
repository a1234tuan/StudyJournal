import { expect, test, type Page } from "@playwright/test";

import { stubDeepSeekProvider } from "./helpers/providerStub";

const installDiagnostics = (page: Page) => {
  const errors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error"
      && !message.text().startsWith("Failed to load resource:")
      && !message.text().startsWith("Warning: flushSync was called")) {
      errors.push(message.text());
    }
  });
  page.on("response", (response) => {
    if (response.status() >= 400 && !response.url().startsWith("https://fonts.")) {
      errors.push(`${response.status()} ${response.url()}`);
    }
  });
  page.on("pageerror", (error) => errors.push(error.message));
  return errors;
};

const expectNoHorizontalOverflow = async (page: Page) => {
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
};

/** Kept as a thin alias so existing call sites keep reading well. */
const mockDeepSeek = (page: Page) => stubDeepSeekProvider(page);

test.describe("Stage 9 Review Coach release path", () => {
  test("queues decision-block review feedback atomically", async ({ page }) => {
    const errors = installDiagnostics(page);
    await mockDeepSeek(page);
    await page.goto("/?preview=stage3");

    await page.getByRole("button", { name: "开始复习" }).click();
    await expect(page.getByRole("heading", { name: "BFS Stage3 Preview" })).toBeVisible();
    await page.getByRole("textbox", { name: "复习重点 1 本次评论" }).fill("阶段 9：首次发现时应立即标记，避免重复入队。");
    await page.getByRole("button", { name: /忘记了/ }).click();
    await page.getByRole("button", { name: /^复习/ }).first().click();
    await page.getByRole("button", { name: "学习助教", exact: true }).click();
    // M5 removed the per-block analysis checkboxes: the workbench now shows the
    // queued feedback as a read-only item and analyses it in one action.
    await expect(page.getByText(/阶段 9：首次发现时应立即标记/)).toBeVisible();
    await expect(page.getByRole("button", { name: /开始分析并出题/ })).toBeVisible();
    await expect(page.getByRole("checkbox", { name: /阶段 9/ })).toHaveCount(0);
    await expectNoHorizontalOverflow(page);
    expect(errors).toEqual([]);
  });

  test("restores the analysis and scheduling checkpoints", async ({ page }) => {
    const errors = installDiagnostics(page);
    await page.goto("/?preview=stage5");
    await page.getByRole("button", { name: /^复习/ }).first().click();
    await page.getByRole("button", { name: "返回复习", exact: true }).click();
    await page.getByRole("button", { name: "学习助教", exact: true }).click();

    await expect(page.getByRole("heading", { name: "复习助教" })).toBeVisible();
    await expect(page.getByText("最近分析：部分完成")).toBeVisible();
    // M5: the screen shows the one task to do, with a reason, and reports the
    // rest as a count. The previous assertions here looked for the per-row
    // status labels ("等待中" / "已延期") that the retired multi-task list
    // rendered - that list is exactly what the plan says must not compete with
    // the current action on the same screen.
    await expect(page.locator(".review-coach-current-task")).toHaveCount(1);
    await expect(page.locator(".review-coach-current-task .primary-button")).toHaveCount(1);
    await expect(page.locator(".review-coach-current-task").getByText("当前任务", { exact: true })).toBeVisible();
    await expect(page.locator(".review-coach-task-remaining")).toHaveCount(1);
    await expectNoHorizontalOverflow(page);
    expect(errors).toEqual([]);
  });

  test("commits an immediate answer and mastered outcome with deterministic AI", async ({ page }) => {
    const errors = installDiagnostics(page);
    await mockDeepSeek(page);
    await page.goto("/?preview=stage6");
    await page.getByRole("button", { name: /^复习/ }).first().click();
    await page.getByRole("button", { name: "返回复习", exact: true }).click();
    await page.getByRole("button", { name: "学习助教", exact: true }).click();

    await page.getByRole("button", { name: "继续训练" }).click();
    await expect(page.getByRole("heading", { name: /BFS 中首次发现/ })).toBeVisible();
    await page.getByRole("textbox", { name: "你的回答" }).fill("先标记 visited 再入队，避免节点重复入队。");
    await page.getByRole("button", { name: "提交回答" }).click();
    await expect(page.getByText("回答正确", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "结束本次训练" }).click();
    await page.getByRole("button", { name: "已掌握" }).click();
    await expect(page.getByRole("heading", { name: "复习助教" })).toBeVisible();
    await expectNoHorizontalOverflow(page);
    expect(errors).toEqual([]);
  });

  test("commits delayed verification independently from record FSRS", async ({ page }) => {
    const errors = installDiagnostics(page);
    await mockDeepSeek(page);
    await page.goto("/?preview=stage7");
    await page.getByRole("button", { name: /^复习/ }).first().click();
    await page.getByRole("button", { name: "返回复习", exact: true }).click();
    await page.getByRole("button", { name: "学习助教", exact: true }).click();

    await page.getByRole("button", { name: "继续训练" }).click();
    await expect(page.getByText(/结果不会改写整条日志的 FSRS 日期/)).toBeVisible();
    await page.getByRole("button", { name: "结束本次训练" }).click();
    await page.getByRole("button", { name: "仍然掌握" }).click();
    await expect(page.getByRole("heading", { name: "复习助教" })).toBeVisible();
    await expect(page.getByText(/次样本/)).toHaveCount(0);
    await expectNoHorizontalOverflow(page);
    expect(errors).toEqual([]);
  });
});
