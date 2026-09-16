import { expect, test, type Page } from "@playwright/test";

import { stubDeepSeekProvider } from "./helpers/providerStub";

/**
 * Closed-loop v2 end-to-end.
 *
 * The unit suites prove each rule in isolation. This proves they compose: a real
 * browser, the real `AdaptiveReviewPage`, the real orchestrator, the real
 * repository and the real Dexie writes, with only the provider stubbed at the
 * HTTP layer. The gap it closes is the one the audit named - every v2 unit test
 * passed while the runtime chain was never actually connected.
 *
 * What it must show, in order:
 *   1. generation produces an `initial` retrieval;
 *   2. answering writes *provisional* evidence and no durable conclusion - an
 *      AI-graded answer may not become an irreversible "retained" fact;
 *   3. the loop does not close on one retrieval;
 *   4. choosing a next action steers the next question (the M3 driver);
 *   5. the second retrieval is `post-judgment`, closes the loop, and still
 *      leaves no `retained` conclusion, because nothing here is objective.
 */

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

/** Reads the v2 task's own rows straight out of Dexie, not out of the UI. */
const readFormalState = (page: Page, taskId: string) => page.evaluate(async (id: string) => {
  const opened = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open("study-journal-408");
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  const readAll = <T>(store: string): Promise<T[]> => new Promise((resolve, reject) => {
    const request = opened.transaction(store, "readonly").objectStore(store).getAll();
    request.onsuccess = () => resolve(request.result as T[]);
    request.onerror = () => reject(request.error);
  });
  const [turns, events, verifications, tasks] = await Promise.all([
    readAll<{ id: string; taskId: string; phase?: string; status: string; assessment?: string; sequence: number }>("adaptiveQuizTurns"),
    readAll<{ id: string; taskId: string; kind: string; evidenceStatus?: string; verificationOutcome?: string }>("taskOutcomeEvents"),
    readAll<{ id: string; taskId?: string; evidenceStatus?: string; verificationOutcome?: string }>("delayedVerifications"),
    readAll<{ id: string; status: string }>("adaptiveReviewTasks"),
  ]);
  opened.close();
  return {
    turns: turns.filter((turn) => turn.taskId === id).sort((left, right) => left.sequence - right.sequence),
    events: events.filter((event) => event.taskId === id),
    verifications: verifications.filter((verification) => verification.taskId === id),
    task: tasks.find((item) => item.id === id),
  };
}, taskId);

/** Navigates from the seeded app into the v2 task's training screen. */
const openV2Task = async (page: Page) => {
  await page.getByRole("button", { name: /^复习/ }).first().click();
  await page.getByRole("button", { name: "返回复习", exact: true }).click();
  await page.getByRole("button", { name: "学习助教", exact: true }).click();
  await page.getByRole("button", { name: /开始训练|继续训练/ }).first().click();
};

test.describe("closed-loop v2 end to end", () => {
  test("closes the loop only after a second retrieval, and never writes retained from AI grading", async ({ page }) => {
    const errors = installDiagnostics(page);
    // The answer is graded "correct" by the model. That is the whole point: a
    // correct AI evaluation is still not objective evidence.
    await stubDeepSeekProvider(page, { evaluation: { assessment: "correct", rationale: "覆盖判据。" } });
    await page.goto("/?preview=loop-v2");

    await openV2Task(page);

    // The v2 counter is what proves this is the v2 task and not a v1 fallback.
    await expect(page.getByText("提取 0/2")).toBeVisible();
    expect((await readFormalState(page, "loop-v2-preview-task")).turns).toHaveLength(0);

    // 1. Generation produces the first retrieval, phase `initial`.
    await page.getByRole("button", { name: "开始训练" }).click();
    await expect(page.getByRole("button", { name: "提交回答" })).toBeVisible();

    let state = await readFormalState(page, "loop-v2-preview-task");
    expect(state.turns).toHaveLength(1);
    expect(state.turns[0].phase).toBe("initial");
    expect(state.turns[0].status).toBe("displayed");

    // 2. Answer it. The judgment is AI-produced, so the evidence is provisional.
    await page.getByRole("textbox").first().fill("首次发现时先标记 visited，再加入队列，这样同一节点不会被重复入队。");
    await page.getByRole("button", { name: "提交回答" }).click();
    await expect(page.getByText("答案依据")).toBeVisible();

    state = await readFormalState(page, "loop-v2-preview-task");
    const answered = state.turns.find((turn) => turn.status === "answered");
    expect(answered).toBeDefined();
    expect(answered!.assessment).toBe("correct");
    // A model-graded answer is provisional evidence, and provisional authority
    // may never be written as a durable conclusion. This is the P0 rule, and it
    // is asserted here on rows that were written by the real app rather than by
    // a mocked repository.
    expect(JSON.stringify(state.events)).not.toContain('"retained"');
    expect(JSON.stringify(state.verifications)).not.toContain('"retained"');

    // 3 & 4. One retrieval is not a closed loop, so the way forward is to
    // retrieve again. A *correct* attempt is not a shortfall, so it must not be
    // gated behind a fabricated self-report - the learner can continue directly.
    const next = page.getByRole("button", { name: "按这个方式再提取一次" });
    await expect(page.getByRole("button", { name: "我没有想出来" })).toHaveCount(0);
    await expect(next).toBeEnabled();
    await next.click();

    // The second retrieval is the post-judgment one, not another initial.
    await expect.poll(async () => (await readFormalState(page, "loop-v2-preview-task")).turns.length).toBe(2);
    state = await readFormalState(page, "loop-v2-preview-task");
    expect(state.turns[1].phase).toBe("post-judgment");
    expect(state.turns[1].status).toBe("displayed");

    await page.getByRole("textbox").first().fill("标记必须发生在入队之前，否则同一层两个父节点会把它重复入队。");
    await page.getByRole("button", { name: "提交回答" }).click();

    // Two qualifying retrievals now exist, so the loop can be closed.
    const closeLoop = page.getByRole("button", { name: /闭环|再提取一次|结束本次训练/ }).first();
    await expect(closeLoop).toBeVisible();
    await closeLoop.click();

    await expect(page.getByRole("heading", { name: "复习助教" })).toBeVisible();

    state = await readFormalState(page, "loop-v2-preview-task");
    // The loop closed, and it closed on provisional evidence only. Nothing in
    // this run was objectively checked, so no `retained` fact may exist.
    expect(JSON.stringify(state.events)).not.toContain('"retained"');
    expect(JSON.stringify(state.verifications)).not.toContain('"retained"');
    await expectNoHorizontalOverflow(page);
    expect(errors).toEqual([]);
  });

  test("requires an action before continuing when the retrieval fell short", async ({ page }) => {
    const errors = installDiagnostics(page);
    // The model grades this one wrong, so the learner must say what to do next.
    await stubDeepSeekProvider(page, {
      evaluation: { assessment: "incorrect", matchedCriteria: [], missingCriteria: ["能准确说明来源中的关键规则"], rationale: "没有说明来源中的关键规则。" },
    });
    await page.goto("/?preview=loop-v2");
    await openV2Task(page);

    await page.getByRole("button", { name: "开始训练" }).click();
    await expect(page.getByRole("button", { name: "提交回答" })).toBeVisible();
    await page.getByRole("textbox").first().fill("我先入队，之后再标记。");
    await page.getByRole("button", { name: "提交回答" }).click();
    await expect(page.getByText("答案依据")).toBeVisible();

    // The action is required *and* it is an action, never a diagnosis.
    const next = page.getByRole("button", { name: "按这个方式再提取一次" });
    await expect(next).toBeDisabled();
    await page.getByRole("button", { name: "我记混了" }).click();
    await expect(next).toBeEnabled();
    await next.click();

    // The choice is recorded as an event whose only content is the action.
    await expect.poll(async () => (await readFormalState(page, "loop-v2-preview-task")).turns.length).toBe(2);
    const state = await readFormalState(page, "loop-v2-preview-task");
    expect(state.events.some((event) => event.kind === "intervention-selected")).toBe(true);
    expect(state.turns[1].phase).toBe("post-judgment");
    await expectNoHorizontalOverflow(page);
    expect(errors).toEqual([]);
  });

  /**
   * The P0 rule, exercised through the real verification write path.
   *
   * `completeV2Verification` derives the conclusion from the *authority* of the
   * locked attempt. Here the attempt is graded `correct` by the model against
   * model-authored criteria, which is provisional authority - so the write must
   * record `provisional-pass` and leave the block without a durable `retained`
   * conclusion. The old code mapped "passed" straight to `retained`, which made
   * an AI opinion an irreversible fact.
   */
  test("a correct AI verification records provisional evidence and never a retained fact", async ({ page }) => {
    const errors = installDiagnostics(page);
    await stubDeepSeekProvider(page, {
      // No criteria override: the stub's evaluation echoes the criteria the
      // question actually carries, and the product rejects any judgment that
      // cites a criterion the turn never declared.
      evaluation: { assessment: "correct", rationale: "覆盖判据。" },
      quality: { verdict: "pass" },
    });
    await page.goto("/?preview=loop-v2-verify");

    await page.getByRole("button", { name: /^复习/ }).first().click();
    await page.getByRole("button", { name: "返回复习", exact: true }).click();
    await page.getByRole("button", { name: "学习助教", exact: true }).click();
    await page.getByRole("button", { name: /继续训练|开始训练/ }).first().click();

    // The verification asks for a fresh retrieval, not the historical question.
    await expect(page.getByText(/不会改写整条日志的 FSRS 日期/)).toBeVisible();
    await page.getByRole("button", { name: "开始训练" }).click();
    await expect(page.getByRole("button", { name: "提交回答" })).toBeVisible();
    await page.getByRole("textbox").first().fill("必须先标记 visited，再加入队列。");
    await page.getByRole("button", { name: "提交回答" }).click();

    // v2 settles from the evidence, so the learner is not asked for a verdict -
    // the only forward action is to submit the attempt for derivation. The
    // verdict buttons that v1 shows must be absent, and the submit action must
    // appear exactly once (it used to render in two places at the same time).
    const settle = page.getByRole("button", { name: "提交验证结果", exact: true });
    await expect(settle).toHaveCount(1);
    await expect(settle).toBeVisible();
    await expect(page.getByRole("button", { name: /仍然掌握|已经衰退/ })).toHaveCount(0);
    await settle.click();
    await expect(page.getByRole("heading", { name: "复习助教" })).toBeVisible();

    const verification = await page.evaluate(async () => {
      const opened = await new Promise<IDBDatabase>((resolve, reject) => {
        const request = indexedDB.open("study-journal-408");
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      const rows = await new Promise<Array<Record<string, unknown>>>((resolve, reject) => {
        const request = opened.transaction("delayedVerifications", "readonly").objectStore("delayedVerifications").getAll();
        request.onsuccess = () => resolve(request.result as Array<Record<string, unknown>>);
        request.onerror = () => reject(request.error);
      });
      opened.close();
      return rows.find((row) => row.id === "loop-v2-verification") ?? null;
    });

    expect(verification).not.toBeNull();
    // Provisional, not objective: the judge was the model.
    expect(verification!.evidenceStatus).toBe("provisional-pass");
    expect(verification!.verificationOutcome).not.toBe("retained");
    // The verification *action* completed, but the *conclusion* did not, so the
    // chain must stay open: no `concludedAt`, and a successor window in the
    // future. Asserting only "not retained" let the chain silently end.
    expect(verification!.status).toBe("completed");
    expect(verification!.concludedAt).toBeUndefined();
    expect(typeof verification!.nextVerificationDueAt).toBe("string");
    expect(Date.parse(String(verification!.nextVerificationDueAt))).toBeGreaterThan(Date.now());
    await expectNoHorizontalOverflow(page);
    expect(errors).toEqual([]);
  });
});
