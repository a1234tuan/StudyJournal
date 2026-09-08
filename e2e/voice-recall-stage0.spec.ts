import { expect, test } from "@playwright/test";

test.describe("voice recall isolated prototype", () => {
  test("shows explicit input selection and disclosure before connecting", async ({ page }) => {
    await page.goto("/?preview=voice-recall");
    const title = page.getByRole("heading", { name: "把刚学过的内容讲出来" });
    await expect(title).toBeVisible();
    expect((await title.boundingBox())!.height).toBeLessThanOrEqual(70);
    expect(await page.locator("body").evaluate((node) => node.scrollWidth <= window.innerWidth)).toBe(true);

    const pushToTalk = page.getByRole("button", { name: /长按说话/ });
    await pushToTalk.click();
    await expect(pushToTalk).toHaveAttribute("aria-pressed", "true");

    await page.getByRole("button", { name: "开始语音复述" }).click();
    await expect(page.getByRole("heading", { name: "开始前确认数据去向" })).toBeVisible();
    await expect(page.getByRole("button", { name: "确认并连接" })).toBeDisabled();
    await page.getByRole("checkbox", { name: "我已了解本次发送范围" }).check();
    await page.getByRole("button", { name: "确认并连接" }).click();
    await expect(page.getByText("正在听", { exact: true })).toBeVisible();
    await expect(page.locator(".vr-call")).toHaveAttribute("data-call-palette", "bright");
    await page.getByRole("button", { name: "通话设置" }).click();
    await expect(page.getByText("Provider 配置", { exact: true })).toBeVisible();
    await expect(page.locator("select")).toHaveCount(4);
    await expect(page.locator("select").nth(0)).toContainText("voice-mock-cn");
    await expect(page.locator("select").nth(1)).toContainText("豆包流式 ASR");
    await expect(page.locator("select").nth(3)).toContainText("Fish Audio");
    await page.locator("select").nth(3).selectOption("voice-tts-doubao-seed-20");
    await expect(page.locator("select").nth(3)).toHaveValue("voice-tts-doubao-seed-20");
    await page.getByRole("button", { name: "深色声场" }).click();
    await expect(page.locator(".vr-call")).toHaveAttribute("data-call-palette", "dark");
    await page.getByRole("button", { name: "明亮声场" }).click();
    await page.getByRole("button", { name: "关闭详情" }).click();
    await expect(page.locator(".vr-voice-field")).toBeVisible();
    await expect(page.getByRole("button", { name: /按住说话/ })).toBeVisible();
    const captions = page.getByRole("button", { name: "字幕开" });
    await expect(captions).toHaveAttribute("aria-pressed", "true");
    await captions.click();
    await expect(page.getByRole("button", { name: "字幕关" })).toHaveAttribute("aria-pressed", "false");
  });

  test("keeps mute explicit and supports interruption and return choices", async ({ page }) => {
    await page.goto("/?preview=voice-recall");
    await page.getByRole("button", { name: "开始语音复述" }).click();
    await page.getByRole("checkbox", { name: "我已了解本次发送范围" }).check();
    await page.getByRole("button", { name: "确认并连接" }).click();
    await expect(page.getByText("正在听", { exact: true })).toBeVisible();

    await page.getByRole("button", { name: "静音", exact: true }).click();
    await expect(page.getByText("你已静音，系统不会自动解除")).toBeVisible();
    await page.getByRole("button", { name: "已静音", exact: true }).click();
    await page.getByRole("button", { name: "立即发送" }).click();
    await expect(page.getByText("正在回答", { exact: true })).toBeVisible({ timeout: 4000 });
    await expect(page.getByText("教师播放中，麦克风暂时关闭")).toBeVisible();
    await page.getByRole("button", { name: "打断并说话" }).click();
    await expect(page.getByText("正在听", { exact: true })).toBeVisible();

    await page.getByRole("button", { name: "返回", exact: true }).click();
    await expect(page.getByRole("heading", { name: "要暂停还是结束本次通话？" })).toBeVisible();
    await page.getByRole("button", { name: /暂停并离开/ }).click();
    await expect(page.getByText("已暂停", { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "继续通话" })).toBeVisible();
  });

  test("fits the Android narrow viewport with fixed controls", async ({ page }) => {
    await page.setViewportSize({ width: 360, height: 760 });
    await page.goto("/?preview=voice-recall");
    await page.getByRole("button", { name: "开始语音复述" }).click();
    await page.getByRole("checkbox", { name: "我已了解本次发送范围" }).check();
    await page.getByRole("button", { name: "确认并连接" }).click();
    const controls = page.locator(".vr-controls");
    await expect(controls).toBeVisible();
    const mainControl = page.getByRole("button", { name: "立即发送" });
    const mainControlBox = await mainControl.boundingBox();
    expect(mainControlBox?.width).toBe(mainControlBox?.height);
    expect(await mainControl.evaluate((node) => getComputedStyle(node).borderRadius)).toBe("50%");
    const box = await controls.boundingBox();
    expect(box).not.toBeNull();
    expect(box!.y + box!.height).toBeLessThanOrEqual(761);
    expect(await page.locator("body").evaluate((node) => node.scrollWidth <= window.innerWidth)).toBe(true);
  });
});
