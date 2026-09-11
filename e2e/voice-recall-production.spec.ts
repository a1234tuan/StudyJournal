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

    const providerDetails = page.getByRole("region", { name: "本机语音服务配置" });
    await expect(providerDetails.locator("summary")).toHaveCount(3);
    await expect(providerDetails.locator("summary").filter({ hasText: "ASR：" })).toContainText("阿里云");
    await expect(providerDetails.locator("summary").filter({ hasText: "TTS：" })).toContainText("Fish Audio");
    const llm = providerDetails.locator("details").filter({ has: page.locator("summary").filter({ hasText: "LLM：" }) });
    await llm.locator("summary").click();
    await expect(llm.getByLabel("大语言模型服务")).toBeVisible();
    await expect(llm.getByLabel("模型", { exact: true })).toHaveValue("deepseek-v4-pro");
    const asr = providerDetails.locator("details").filter({ has: page.locator("summary").filter({ hasText: "ASR：" }) });
    await asr.locator("summary").click();
    await expect(asr.getByLabel("语音识别服务")).toBeVisible();
    await asr.getByLabel("语音识别服务").selectOption("voice-asr-doubao-seed-streaming");
    await expect(asr.getByLabel("Resource ID")).toHaveValue("volc.seedasr.sauc.duration");
    await asr.getByLabel("语音识别服务").selectOption("voice-asr-aliyun-paraformer");
    await asr.getByLabel("热词列表 ID").fill("test-local-vocabulary");
    await expect(llm.getByLabel("模型", { exact: true })).toBeVisible();
    const tts = providerDetails.locator("details").filter({ has: page.locator("summary").filter({ hasText: "TTS：" }) });
    await tts.locator("summary").click();
    await expect(tts.getByLabel("语音合成服务")).toBeVisible();
    await tts.getByLabel("语音合成服务").selectOption("voice-tts-doubao-small");
    await expect(tts.getByLabel("模型", { exact: true })).toHaveValue("volcano_tts");
    await expect(tts.getByLabel("旧版控制台 App ID")).toBeVisible();

    await page.getByRole("button", { name: "本机历史" }).click();
    await expect(page.locator(".vr-history")).toBeVisible();
    await expect(page.getByRole("heading", { name: "本机通话历史" })).toBeVisible();
    await expect(page.getByText("你的复述轨迹")).toBeVisible();
    await expect(page.locator(".sidebar")).toBeHidden();
    await expect(page.locator(".bottom-nav")).toBeHidden();
  });

  test("refuses to start instead of showing a simulated call when the chain is unconfigured", async ({ page }) => {
    await page.goto("/?preview=voice-recall-production");
    await page.evaluate(() => localStorage.clear());
    await page.reload();

    await expect(page.getByRole("heading", { name: "把刚学过的内容讲出来" })).toBeVisible();
    await expect(page.locator(".vr-start")).toBeVisible();
    await expect(page.locator(".sidebar")).toBeHidden();
    await expect(page.locator(".bottom-nav")).toBeHidden();

    await page.getByRole("tab", { name: "自由主题" }).click();
    await page.getByPlaceholder("例如：解释事件循环").fill("间隔复习为什么有效");
    await page.getByRole("button", { name: "开始语音复述" }).click();
    await expect(page.getByRole("heading", { name: "本次会使用哪些服务？" })).toBeVisible();
    await expect(page.getByRole("button", { name: "确认并连接" })).toBeDisabled();
    await page.getByRole("checkbox", { name: "我了解本次发送范围，并记住这个选择" }).check();
    await page.getByRole("button", { name: "确认并连接" }).click();

    // No provider credentials exist in CI, so the workspace must refuse rather than
    // fabricate a call. The call screen now requires a real ASR/LLM/TTS chain
    // (desktop or Android), so its visuals are covered by desktop acceptance.
    await expect(page.locator(".status-message")).toContainText(/密钥|API Key/);
    await expect(page.locator(".vr-call")).toHaveCount(0);
    expect(await page.locator("body").evaluate((node) => node.scrollWidth <= window.innerWidth)).toBe(true);
  });
});
