import { expect, test, type Page } from "@playwright/test";

test.setTimeout(60_000);

const openReview = async (page: Page) => {
  await page.goto("/?preview=stage3");
  await page.getByRole("button", { name: /^复习/ }).first().click();
  await expect(page.getByRole("heading", { name: "BFS Stage3 Preview" })).toBeVisible();
  await expect(page.getByRole("button", { name: "打开批注工具" })).toBeEnabled();
};

const drawRectangle = async (page: Page, offset = 0) => {
  const opener = page.getByRole("button", { name: "打开批注工具" });
  if (await opener.isVisible()) await opener.click();
  await page.getByRole("button", { name: "矩形", exact: true }).click();
  const bounds = await page.locator(".review-annotation-root").boundingBox();
  if (!bounds) throw new Error("Annotation surface is missing");
  await page.mouse.move(bounds.x + 30 + offset, bounds.y + 30);
  await page.mouse.down();
  await page.mouse.move(bounds.x + 110 + offset, bounds.y + 70, { steps: 4 });
  await page.mouse.up();
};

const nav = (page: Page, name: string | RegExp) => page.locator(".sidebar").getByRole("button", { name, exact: typeof name === "string" });

test("keeps unsubmitted feedback and its analysis choice across sidebar navigation", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "Desktop sidebar");
  await openReview(page);
  const feedback = page.getByRole("textbox", { name: "复习重点 1 本次评论" });
  await feedback.fill("未评分的评论不能因为切换导航丢失");
  const analysisChoice = page.getByRole("checkbox", { name: "加入待分析", exact: true });
  await expect(analysisChoice).toBeChecked();
  await analysisChoice.click();
  await expect(analysisChoice).not.toBeChecked();
  const progress = await page.locator(".review-progress-meta").innerText();
  await nav(page, "日志").click();
  await expect(page.locator(".review-record-card")).toHaveCount(0);
  await nav(page, /^复习/).click();
  await expect(feedback).toHaveValue("未评分的评论不能因为切换导航丢失");
  await expect(page.getByRole("checkbox", { name: "加入待分析", exact: true })).not.toBeChecked();
  await expect(page.locator(".review-progress-meta")).toHaveText(progress, { useInnerText: true });
});

test("waits for annotation saves before leaving and reloads the complete draft", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "Desktop sidebar");
  await openReview(page);
  await page.evaluate(async () => {
    const { reviewAnnotationRepository: repository } = await import("/src/features/reviewAnnotations/repository.ts");
    const original = repository.upsertDraft.bind(repository);
    const gate = new Promise<void>((resolve) => { (window as any).releaseAnnotationSave = resolve; });
    repository.upsertDraft = async (draft) => { await gate; return original(draft); };
  });
  await drawRectangle(page);
  await nav(page, "日志").click();
  await expect(page.getByRole("status").filter({ hasText: "正在保存批注" })).toBeVisible();
  await expect(page.locator(".review-record-card")).toBeVisible();
  await page.evaluate(() => (window as any).releaseAnnotationSave());
  await expect(page.locator(".review-record-card")).toHaveCount(0);
  await nav(page, /^复习/).click();
  await expect(page.locator("rect[data-annotation-element]")).toHaveCount(1);
  await drawRectangle(page, 160);
  await nav(page, "日志").click();
  await expect(page.locator(".review-record-card")).toHaveCount(0);
  await nav(page, /^复习/).click();
  await expect(page.locator("rect[data-annotation-element]")).toHaveCount(2);
});

test("failed annotation writes block leaving and can be retried without losing strokes", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "Desktop sidebar");
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await openReview(page);
  await page.evaluate(async () => {
    const { reviewAnnotationRepository: repository } = await import("/src/features/reviewAnnotations/repository.ts");
    const original = repository.upsertDraft.bind(repository);
    (window as any).restoreAnnotationSave = () => { repository.upsertDraft = original; };
    repository.upsertDraft = async () => { throw new DOMException("Simulated quota", "QuotaExceededError"); };
  });
  await drawRectangle(page);
  await page.getByRole("button", { name: "收起左侧导航" }).click();
  expect((await page.locator(".sidebar").boundingBox())!.width).toBe(64);
  await nav(page, "日志").click();
  await expect(page.getByRole("alert")).toContainText("未保存批注仍保留");
  await expect(page.locator(".review-record-card")).toBeVisible();
  await expect(page.locator("rect[data-annotation-element]")).toHaveCount(1);
  await page.evaluate(() => (window as any).restoreAnnotationSave());
  await page.getByRole("button", { name: "重试保存批注" }).click();
  await expect(page.getByRole("alert")).toHaveCount(0);
  await nav(page, "日志").click();
  await expect(page.locator(".review-record-card")).toHaveCount(0);
  await nav(page, /^复习/).click();
  await expect(page.locator("rect[data-annotation-element]")).toHaveCount(1);
  expect(errors).toEqual([]);
});

test("unfinished annotation options require save or cancel before navigation", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "Desktop sidebar");
  await openReview(page);
  await page.getByRole("button", { name: "打开批注工具" }).click();
  await page.getByTitle("下拉选择", { exact: true }).click();
  const bounds = await page.locator(".review-annotation-root").boundingBox();
  if (!bounds) throw new Error("Annotation surface is missing");
  await page.mouse.click(bounds.x + 50, bounds.y + 25);
  const dialog = page.getByRole("dialog", { name: "编辑下拉选项" });
  await dialog.getByRole("textbox").first().fill("未确认的批注选项");
  await nav(page, "日志").click();
  await expect(page.getByRole("alert")).toContainText("请先完成当前批注操作");
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "保存", exact: true }).click();
  await nav(page, "日志").click();
  await expect(page.locator(".review-record-card")).toHaveCount(0);
  await nav(page, /^复习/).click();
  await expect(page.locator(".review-annotation-control option").filter({ hasText: "未确认的批注选项" })).toHaveCount(1);
});

test("annotation input stays disabled until the saved draft finishes loading", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "Desktop sidebar");
  await openReview(page);
  await drawRectangle(page);
  await nav(page, "日志").click();
  await expect(page.locator(".review-record-card")).toHaveCount(0);
  await page.evaluate(async () => {
    const { reviewAnnotationRepository: repository } = await import("/src/features/reviewAnnotations/repository.ts");
    const original = repository.openDraft.bind(repository);
    const gate = new Promise<void>((resolve) => { (window as any).releaseAnnotationRead = resolve; });
    repository.openDraft = async (draft) => { await gate; return original(draft); };
  });
  await nav(page, /^复习/).click();
  await expect(page.getByRole("button", { name: "打开批注工具" })).toBeDisabled();
  await page.evaluate(() => (window as any).releaseAnnotationRead());
  await expect(page.getByRole("button", { name: "打开批注工具" })).toBeEnabled();
  await expect(page.locator("rect[data-annotation-element]")).toHaveCount(1);
});
