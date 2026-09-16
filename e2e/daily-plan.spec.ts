import { expect, test, type Page } from "@playwright/test";

/**
 * End-to-end coverage for the daily plan workspace.
 *
 * These cases run against a real browser and a real IndexedDB, with no seeded
 * preview data, because the behaviour under test *is* the write path: creating a
 * plan, opening the log it stands for, and letting the reclaim job clean up an
 * attempt that never happened. A seeded fixture would bypass exactly the code
 * these tests exist to protect.
 *
 * Navigation cross-fades: `PageTransition` keeps the outgoing page mounted for
 * one 200ms frame next to the incoming one. Role and label queries already skip
 * it, because the exiting layer is `aria-hidden`, but CSS and text locators do
 * not - a bare `.daily-plan-row` can match the same row twice mid-transition and
 * trip strict mode. So every CSS/text query below is scoped to the live layer.
 */

test.setTimeout(90_000);

const PLAN_TITLE = "力学 10 题";

/** The page the user is actually on, not the one fading out. */
const live = (page: Page) =>
  page.locator('.page-transition-layer:not([aria-hidden="true"])').last();

const openDashboard = async (page: Page) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "今天想记下什么？" })).toBeVisible();
};

const openDailyPlan = async (page: Page) => {
  await page.getByRole("button", { name: "打开今日计划" }).click();
  await expect(page.getByRole("heading", { name: "今日计划" })).toBeVisible();
};

const addPlan = async (page: Page, title = PLAN_TITLE) => {
  await page.getByLabel("计划标题").fill(title);
  await page.getByRole("button", { name: /添加计划/ }).click();
  await expect(planRow(page, title)).toBeVisible();
};

const planRow = (page: Page, title = PLAN_TITLE) =>
  live(page).locator(".daily-plan-row-main").filter({ hasText: title });

const planStatus = (page: Page, title = PLAN_TITLE) =>
  live(page).locator(".daily-plan-row").filter({ hasText: title }).locator(".daily-plan-status");

/**
 * Open a plan's log from the plan page.
 *
 * The landing mode differs by design: a plan with nothing written yet opens
 * directly into editing, while a log that already has saved content opens in
 * browse mode (the user taps 编辑 to change it). So this waits for the record
 * page itself, and the cases that type assert the editable body explicitly.
 */
const openPlanLog = async (page: Page, title = PLAN_TITLE) => {
  await planRow(page, title).click();
  await expect(live(page).locator(".record-editor-page")).toBeVisible();
};

const editable = (page: Page) => live(page).locator(".rich-editor[contenteditable='true']");

/** Type into a plan's log, which requires the editor to be in writing mode. */
const writeInto = async (page: Page, text: string) => {
  await expect(editable(page)).toBeVisible();
  await editable(page).fill(text);
};

const saveRecord = async (page: Page) => {
  await page.getByRole("button", { name: "保存", exact: true }).click();
  await expect(live(page).getByText("正式内容已保存", { exact: true })).toBeVisible();
};

test("case 1: opens the daily plan from the home header and returns to the dashboard", async ({ page }) => {
  await openDashboard(page);
  await openDailyPlan(page);

  await expect(live(page).getByText("今天还没有计划。列一条，做完就能顺手记下来。")).toBeVisible();
  await expect(page.getByRole("button", { name: /添加计划/ })).toBeDisabled();

  await page.getByRole("button", { name: "返回今天" }).click();
  await expect(page.getByRole("heading", { name: "今天想记下什么？" })).toBeVisible();
});

test("case 2: writing the log fulfils the plan and shows a done row", async ({ page }) => {
  await openDashboard(page);
  await openDailyPlan(page);
  await addPlan(page);

  await expect(planStatus(page)).toHaveText("未完成");

  await openPlanLog(page);
  await writeInto(page, "做完 660 题第 50 到 60 题，错 2 题。");
  await saveRecord(page);

  await page.getByRole("button", { name: "返回" }).first().click();

  await expect(page.getByRole("heading", { name: "今日计划" })).toBeVisible();
  await expect(planStatus(page)).toHaveText("已完成");
  await expect(live(page).getByText("1 / 1 完成")).toBeVisible();
  await expect(live(page).getByText("今天已经兑现 1 条计划。")).toBeVisible();

  // Fulfilling through the plan page still produces an ordinary log that
  // declares where it came from: `linkPlanRecord` writes both pointers.
  await openPlanLog(page);
  await expect(live(page).locator(".record-plan-origin")).toContainText("[来自计划]");
  await expect(live(page).locator(".record-plan-origin")).toContainText(`读书笔记 · ${PLAN_TITLE}`);
});

test("case 3: opening a plan and leaving without typing reclaims the empty log", async ({ page }) => {
  await openDashboard(page);
  await openDailyPlan(page);
  await addPlan(page);

  await openPlanLog(page);
  await page.getByRole("button", { name: "返回" }).first().click();

  await expect(page.getByRole("heading", { name: "今日计划" })).toBeVisible();
  await expect(planStatus(page)).toHaveText("未完成");

  // The empty record is reclaimed, so it never appears as a real log. The plan
  // row keeps its link, which is why the hint must not claim the log was deleted.
  await page.getByRole("button", { name: "返回今天" }).click();
  await expect(page.getByRole("heading", { name: "今天想记下什么？" })).toBeVisible();
  await expect(live(page).locator(".record-card")).toHaveCount(0);
});

test("case 4: typing then leaving immediately keeps the draft instead of losing it", async ({ page }) => {
  await openDashboard(page);
  await openDailyPlan(page);
  await addPlan(page);

  await openPlanLog(page);
  const typing = "刚刚打进去还没保存的内容";
  await writeInto(page, typing);
  // Deliberately no waiting and no save: this is the race the flush tracker and
  // the reclaim job's skip set exist to survive.
  await page.getByRole("button", { name: "返回" }).first().click();

  await expect(page.getByRole("heading", { name: "今日计划" })).toBeVisible();
  await expect(planStatus(page)).toHaveText("未保存（上次输入已保留）");

  // Re-entering must show what was typed, not an empty record.
  await openPlanLog(page);
  await expect(editable(page)).toContainText(typing);
});

test("case 5: the history view shows the day's group and its completion tally", async ({ page }) => {
  await openDashboard(page);
  await openDailyPlan(page);
  await addPlan(page);
  await addPlan(page, "错题复盘 5 条");

  await openPlanLog(page, PLAN_TITLE);
  await writeInto(page, "完成了。");
  await saveRecord(page);
  await page.getByRole("button", { name: "返回" }).first().click();

  await page.getByRole("tab", { name: "历史" }).click();
  await expect(page.getByRole("heading", { name: "计划历史" })).toBeVisible();

  const group = live(page).locator(".daily-plan-history-group").first();
  await expect(group.locator(".daily-plan-history-heading small")).toHaveText("1/2");
  await expect(group).toContainText(PLAN_TITLE);
  await expect(group).toContainText("错题复盘 5 条");

  const summary = page.getByRole("region", { name: "计划汇总" });
  await expect(summary).toContainText("近 7 天已兑现");
  await expect(summary).toContainText("1 / 2");
  // No percentage anywhere: "1 of 2" is a count, and dressing it as a rate would
  // claim more than the data supports.
  await expect(summary).not.toContainText("%");
});

test("case 6: D8 - trashing the log unfulfills the plan, restoring it fulfils it again", async ({ page }, testInfo) => {
  await openDashboard(page);
  await openDailyPlan(page);
  await addPlan(page);

  await openPlanLog(page);
  await writeInto(page, "写完就删，验证派生关系。");
  await saveRecord(page);

  // Move the log to the trash from the editor itself. Below 920px the record
  // toolbar collapses and the delete action moves behind 更多操作, so reach it
  // the way a narrow-screen user would.
  page.on("dialog", (dialog) => void dialog.accept());
  await page.getByRole("button", { name: "编辑", exact: true }).click();
  if (testInfo.project.name === "android-narrow") {
    await page.getByRole("button", { name: "更多操作" }).click();
    await live(page).locator(".record-more-menu").getByRole("button", { name: "删除记录" }).click();
  } else {
    await page.getByLabel("删除记录").click();
  }

  await expect(page.getByRole("heading", { name: "今日计划" })).toBeVisible();
  await expect(planStatus(page)).toHaveText("未完成");
  await expect(live(page).getByText("日志已删除")).toBeVisible();

  // Restore it from the trash; the plan must flip back with no plan write at all.
  await page.getByRole("button", { name: "返回今天" }).click();
  await page.getByRole("button", { name: "更多", exact: true }).last().click();
  await live(page).locator(".more-page").getByRole("button", { name: "回收站", exact: true }).click();
  await expect(live(page).locator(".trash-card").first()).toBeVisible();
  await live(page).locator(".trash-card").first().getByRole("button", { name: "恢复", exact: true }).click();

  await page.getByRole("button", { name: "今天", exact: true }).last().click();
  await page.getByRole("button", { name: "打开今日计划" }).click();
  await expect(planStatus(page)).toHaveText("已完成");
  await expect(live(page).getByText("日志已删除")).toHaveCount(0);
});

test("case 7: D9 - deleting the plan keeps the log and its attribution", async ({ page }) => {
  await openDashboard(page);
  await openDailyPlan(page);
  await addPlan(page);

  await openPlanLog(page);
  await writeInto(page, "计划会被删掉，但这篇日志要留着。");
  await saveRecord(page);
  await page.getByRole("button", { name: "返回" }).first().click();

  page.on("dialog", (dialog) => void dialog.accept());
  await page.getByRole("button", { name: `删除计划 ${PLAN_TITLE}` }).click();

  await expect(planRow(page, PLAN_TITLE)).toHaveCount(0);
  await expect(live(page).getByText("今天还没有计划。列一条，做完就能顺手记下来。")).toBeVisible();

  // The log survives and still names the plan it came from, subject and title
  // included - that is the whole reason soft-deleted plans stay readable.
  await page.getByRole("button", { name: "返回今天" }).click();
  const logCard = live(page).locator(".record-card").filter({ hasText: "计划会被删掉" });
  await expect(logCard).toBeVisible();
  await logCard.click();
  await expect(live(page).locator(".record-plan-origin")).toContainText("[来自计划·已删除]");
  await expect(live(page).locator(".record-plan-origin")).toContainText(`读书笔记 · ${PLAN_TITLE}`);
});

test("case 8: the narrow layout stacks the form and the back chain unwinds layer by layer", async ({ page }, testInfo) => {
  await openDashboard(page);
  await openDailyPlan(page);

  // The pair that actually restacks: the title field keeps its full 40-char
  // width on narrow screens by pushing the submit button onto its own line.
  const field = live(page).locator(".daily-plan-compose-row input");
  const submit = live(page).locator(".daily-plan-compose-row .primary-button");
  const fieldBox = await field.boundingBox();
  const submitBox = await submit.boundingBox();
  expect(fieldBox).not.toBeNull();
  expect(submitBox).not.toBeNull();

  if (testInfo.project.name === "android-narrow") {
    // Stacked: the button starts below the field.
    expect(submitBox!.y).toBeGreaterThanOrEqual(fieldBox!.y + fieldBox!.height - 1);
  } else {
    // Side by side: same line, and the button sits to the right of the field.
    expect(submitBox!.y).toBeLessThan(fieldBox!.y + fieldBox!.height);
    expect(submitBox!.x).toBeGreaterThanOrEqual(fieldBox!.x + fieldBox!.width - 1);
  }
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(1);

  await addPlan(page);
  await openPlanLog(page);

  // Browser back is the web equivalent of the Android back gesture here, and it
  // must unwind record -> plan -> dashboard rather than jumping straight home.
  await page.goBack();
  await expect(page.getByRole("heading", { name: "今日计划" })).toBeVisible();
  await page.goBack();
  await expect(page.getByRole("heading", { name: "今天想记下什么？" })).toBeVisible();
});
