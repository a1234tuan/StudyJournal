import { expect, test } from "@playwright/test";

test.describe("voice recall production workspace migration", () => {
  test("keeps the record scope list scrollable while actions remain visible", async ({ page }) => {
    await page.goto("/?preview=voice-recall-production");

    await page.getByRole("button", { name: "调整范围" }).click();
    await page.getByRole("tab", { name: "选择日志" }).click();

    const content = page.locator(".ai-scope-page-content");
    const actions = page.locator(".ai-scope-page-actions");
    await expect(content).toBeVisible();
    await expect(actions).toBeVisible();
    await expect(page.getByRole("button", { name: "取消本次选择" })).toBeVisible();
    await expect(page.getByRole("button", { name: "使用这些资料" })).toBeVisible();

    const layout = await page.locator(".ai-scope-page-shell").evaluate((shell) => {
      const contentElement = shell.querySelector<HTMLElement>(".ai-scope-page-content")!;
      const actionsElement = shell.querySelector<HTMLElement>(".ai-scope-page-actions")!;
      return {
        shellBottom: shell.getBoundingClientRect().bottom,
        actionsBottom: actionsElement.getBoundingClientRect().bottom,
        contentOverflowY: getComputedStyle(contentElement).overflowY,
        actionsPosition: getComputedStyle(actionsElement).position,
      };
    });
    expect(layout.contentOverflowY).toBe("auto");
    expect(layout.actionsBottom).toBeLessThanOrEqual(layout.shellBottom + 1);
    expect(layout.actionsPosition).not.toBe("absolute");
  });

  test("shows device-local provider templates and the redesigned local history", async ({ page }) => {
    await page.goto("/?preview=voice-recall-production");

    const providerDetails = page.locator(".vr-provider-details");
    await providerDetails.locator("summary").click();
    await expect(providerDetails.getByLabel("预置链路")).toHaveValue("voice-default-cn");
    await providerDetails.getByLabel("预置链路").selectOption("voice-default-cn");
    await expect(providerDetails.getByText("豆包流式 ASR")).toBeVisible();
    await expect(providerDetails.getByText("deepseek-v4-flash")).toBeVisible();
    await expect(providerDetails.getByText(/Fish Audio/)).toBeVisible();
    await page.reload();
    await page.locator(".vr-provider-details summary").click();
    await expect(page.getByLabel("预置链路")).toHaveValue("voice-default-cn");

    await page.getByRole("button", { name: "本机历史" }).click();
    await expect(page.locator(".vr-history")).toBeVisible();
    await expect(page.getByRole("heading", { name: "本机通话历史" })).toBeVisible();
    await expect(page.getByText("你的复述轨迹")).toBeVisible();
    await expect(page.locator(".sidebar")).toBeHidden();
    await expect(page.locator(".bottom-nav")).toBeHidden();
  });

  test("uses the prototype visual hierarchy with the production route and runtime", async ({ page }) => {
    await page.goto("/?preview=voice-recall-production");
    await page.evaluate(() => localStorage.clear());
    await page.reload();

    await expect(page.getByRole("heading", { name: "把刚学过的内容讲出来" })).toBeVisible();
    await expect(page.locator(".vr-start")).toBeVisible();
    await expect(page.locator(".sidebar")).toBeHidden();
    await expect(page.locator(".bottom-nav")).toBeHidden();

    await page.getByRole("tab", { name: "自由主题" }).click();
    await page.getByPlaceholder("例如：解释事件循环").fill("间隔复习为什么有效");
    await page.locator(".vr-advanced-details summary").click();
    await page.getByRole("button", { name: "点击录音" }).click();
    await page.getByRole("button", { name: "开始语音复述" }).click();
    await expect(page.getByRole("heading", { name: "本次会使用哪些服务？" })).toBeVisible();
    await expect(page.getByRole("button", { name: "确认并连接" })).toBeDisabled();
    await page.getByRole("checkbox", { name: "我了解本次发送范围，并记住这个选择" }).check();
    await page.getByRole("button", { name: "确认并连接" }).click();

    await expect(page.locator(".vr-call")).toBeVisible();
    await expect(page.getByText("正在听", { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "开始说话" })).toBeVisible();
    await page.getByRole("button", { name: "更多通话选项" }).click();
    await expect(page.getByRole("complementary", { name: "通话详情" })).toBeVisible();
    await page.getByRole("button", { name: "关闭详情" }).click();

    await page.getByRole("button", { name: "结束并查看摘要" }).click();
    await expect(page.getByRole("dialog", { name: "要暂停还是结束本次通话？" })).toBeVisible();
    await page.getByRole("button", { name: /继续通话/ }).click();
    await expect(page.getByRole("dialog", { name: "要暂停还是结束本次通话？" })).toBeHidden();
    expect(await page.locator("body").evaluate((node) => node.scrollWidth <= window.innerWidth)).toBe(true);
  });
});
