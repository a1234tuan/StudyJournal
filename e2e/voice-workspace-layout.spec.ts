import { expect, test } from "@playwright/test";

test("voice preparation and pending practice stay inside the normal workspace", async ({ page }, info) => {
  await page.goto("/?preview=voice-recall-production");
  await expect(page.locator(".vr-start")).toBeVisible();
  await page.evaluate(async () => {
    const { db } = await import("/src/db/database.ts");
    const stamp = new Date().toISOString();
    for (const [id, topic, status, offset] of [["old", "旧的练习", "paused", -2000], ["recent", "事件循环复述", "paused", -1000], ["failed", "未开始的连接", "failed", 0]] as const) await db.voiceRecallSessions.put({ id, mode: "free-topic", sourceKind: "free-topic", source: { kind: "free-topic", topic }, sourceRecordIds: [], status, provider: {}, memory: { learningGoal: topic, coveredPoints: [], misconceptions: [], pendingTopics: [] }, checkpoint: { nextSequence: 0, elapsedMs: 0, inputMode: "tap-to-record", userMuted: false }, createdAt: stamp, updatedAt: new Date(Date.now() + offset).toISOString() });
  });
  await page.reload();
  await expect(page.getByRole("region", { name: "上次练习提醒" })).toBeVisible();
  await expect(page.getByText("事件循环复述", { exact: true })).toBeVisible();
  await expect(page.getByText("旧的练习", { exact: true })).toHaveCount(0);
  await expect(page.getByText("未开始的连接", { exact: true })).toHaveCount(0);
  await expect(page.locator(".app-shell")).not.toHaveClass(/immersive-task-active/);
  if (info.project.name === "desktop") await expect(page.locator(".sidebar")).toBeVisible();
  else await expect(page.locator(".bottom-nav")).toBeVisible();
  await expect(page.locator(".vr-service-settings")).not.toHaveAttribute("open");
  await expect(page.getByRole("button", { name: /点击录音/ })).not.toBeVisible();
  await page.getByRole("tab", { name: "自由主题" }).click();
  await page.getByPlaceholder("例如：解释事件循环").fill("微积分基本定理");
  const bounds = await page.locator(".vr-start-content").boundingBox();
  for (const selector of [".vr-topic-editor", ".vr-resumable", ".vr-start-footer"]) {
    const box = await page.locator(selector).boundingBox();
    expect(box!.x).toBeGreaterThanOrEqual(bounds!.x - 1);
    expect(box!.x + box!.width).toBeLessThanOrEqual(bounds!.x + bounds!.width + 1);
  }
  const footer = page.locator(".vr-start-footer");
  await footer.scrollIntoViewIfNeeded();
  if (info.project.name !== "desktop") expect((await footer.boundingBox())!.y + (await footer.boundingBox())!.height).toBeLessThanOrEqual((await page.locator(".bottom-nav").boundingBox())!.y + 1);
  expect(await page.locator(".vr-start-footer .vr-primary").evaluate(node => getComputedStyle(node).color)).toBe("rgb(255, 255, 255)");
  await page.screenshot({ path: "output/review-workspace-2026-10-07/" + info.project.name + "-voice-start.png" });
  await page.getByRole("button", { name: "本机记录", exact: true }).click();
  await expect(page.getByRole("region", { name: "未结束的本机练习" }).getByRole("button", { name: "查看并继续" })).toHaveCount(3);
  page.once("dialog", dialog => dialog.dismiss());
  await page.getByRole("button", { name: "结束此练习" }).first().click();
  await expect(page.getByRole("button", { name: "结束此练习" })).toHaveCount(3);
  await page.getByRole("button", { name: "返回语音复述" }).click();
  await page.setViewportSize({ width: 320, height: 720 });
  await page.evaluate(() => { document.documentElement.dataset.theme = "dark"; });
  await expect(page.locator(".vr-start")).toBeVisible();
  expect(await page.locator("body").evaluate(node => node.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: "output/review-workspace-2026-10-07/" + info.project.name + "-voice-320-dark.png" });
});
