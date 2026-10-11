import { expect, test, type Page } from "@playwright/test";

const recordId = "stage3-preview-record";
const html = '<p>能量关系 <record-inline-math data-latex="E=mc^2"></record-inline-math> 需要结合条件理解。</p>'
  + '<record-formula data-formula-id="mark-formula" data-title="求和公式" data-latex="\\sum_{k=1}^{n} k=\\frac{n(n+1)}{2}"></record-formula>'
  + '<pre><code class="language-typescript">const example = "' + 'long_segment_'.repeat(18) + '";\nfunction solve(value: number) {\n  return value + 1;\n}</code></pre>'
  + '<p>这段背景知识不应被误标。</p>';

const open = async (page: Page, contentHtml = html) => {
  await page.goto("/?preview=stage3"); await expect(page.locator(".today-page")).toBeVisible();
  await page.evaluate(async ({ recordId, html }) => {
    const { db } = await import("/src/db/database.ts"); const { storage } = await import("/src/services/storageAdapter.ts");
    const record = await db.blocks.get(recordId); if (record?.type !== "record") throw new Error("Missing fixture");
    await storage.saveBlock({ ...record, contentHtml: html });
  }, { recordId, html: contentHtml });
  await page.getByRole("button", { name: /^复习/ }).first().click();
  await expect(page.locator(".review-mark-content .formula-editor-card")).toBeVisible();
  await page.getByRole("button", { name: "永久复习印记", exact: true }).click();
};
const events = (page: Page) => page.evaluate(async recordId => {
  const { db } = await import("/src/db/database.ts"); return db.reviewMarkEvents.where("recordId").equals(recordId).toArray();
}, recordId);
const save = async (page: Page, count: number) => {
  await page.getByRole("button", { name: "标记选中内容", exact: true }).click();
  await expect.poll(async () => (await events(page)).length).toBe(count);
};
const source = (page: Page) => page.evaluate(async recordId => { const { db } = await import("/src/db/database.ts"); return (await db.blocks.get(recordId))?.contentHtml; }, recordId);
const closeTools = (page: Page) => page.getByRole("button", { name: "关闭印记工具" }).click();

test("formula taps, whole code selection, persistence, undo and unchanged source", async ({ page }, info) => {
  await open(page); const original = await source(page);
  await page.locator(".review-mark-content .record-inline-math").click();
  await expect(page.locator(".review-mark-selection")).toContainText("$E=mc^2$"); await save(page, 1);
  await page.locator(".review-mark-content .formula-editor-card").click(); await save(page, 2);
  await page.getByLabel("选择公式或代码块", { exact: true }).selectOption("2");
  await expect(page.locator(".review-mark-selection")).toContainText("const example"); await save(page, 3);
  const saved = await events(page);
  expect(saved.map(event => event.value?.anchor.structured?.target).sort()).toEqual(["code", "formula", "formula"]);
  expect(await source(page)).toBe(original);
  await page.getByRole("button", { name: "撤销印记", exact: true }).click();
  await expect.poll(async () => (await events(page)).length).toBe(4);
  await closeTools(page);
  await page.reload(); await page.getByRole("button", { name: /^复习/ }).first().click();
  await expect.poll(() => page.locator(".review-mark-paint [data-mark-id]").count()).toBe(2);
  for (const width of info.project.name === "desktop" ? [1440, 1024] : [390, 320]) {
    await page.setViewportSize({ width, height: 844 });
    await page.evaluate(width => { document.documentElement.dataset.theme = width === 320 || width === 1024 ? "dark" : "light"; document.documentElement.style.setProperty("--font-scale", width === 320 ? "1.25" : "1"); }, width);
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
    await expect.poll(() => page.evaluate(() => {
      const formula = document.querySelector(".review-mark-content .record-inline-math")!.getBoundingClientRect();
      return Array.from(document.querySelectorAll(".review-mark-paint [data-mark-id]")).some(node => { const bounds = node.getBoundingClientRect(); return Math.abs(bounds.left - formula.left) < 2 && Math.abs(bounds.top - formula.top) < 2; });
    })).toBe(true);
    await page.screenshot({ path: info.outputPath("formula-marks-" + width + ".png"), animations: "disabled" });
  }
});

test("mixed formula selection and multi-line code paint follow horizontal scrolling", async ({ page }, info) => {
  await open(page);
  await page.locator(".review-mark-content .ProseMirror > p").first().evaluate(paragraph => {
    const range = document.createRange(); range.setStart(paragraph.firstChild!, 1); range.setEnd(paragraph.lastChild!, 5);
    const selection = window.getSelection()!; selection.removeAllRanges(); selection.addRange(range); document.dispatchEvent(new Event("selectionchange"));
  });
  await save(page, 1);
  expect((await events(page))[0].value?.anchor.quote).toContain("$E=mc^2$");
  await page.locator(".review-mark-content pre code").evaluate(code => {
    const range = document.createRange(); range.selectNodeContents(code);
    const selection = window.getSelection()!; selection.removeAllRanges(); selection.addRange(range); document.dispatchEvent(new Event("selectionchange"));
  });
  await save(page, 2);
  const codeMark = (await events(page)).find(event => event.value?.anchor.structured?.target === "range" && event.value.anchor.blockText.includes('"kind":"code"'))!;
  expect(codeMark.value!.anchor.quote).toContain("\n  return");
  await closeTools(page);
  const code = page.locator(".review-mark-content pre"); await code.scrollIntoViewIfNeeded();
  for (const offset of [0, 250, 650]) {
    await code.evaluate((element, offset) => { element.scrollLeft = offset; element.dispatchEvent(new Event("scroll")); }, offset);
    await expect.poll(() => page.evaluate(markId => {
      const code = document.querySelector<HTMLElement>(".review-mark-content pre")!; const bounds = code.getBoundingClientRect();
      const marks = Array.from(document.querySelectorAll<HTMLElement>('.review-mark-paint [data-mark-id="' + markId + '"]'));
      return marks.length > 0 && marks.every(mark => { const rect = mark.getBoundingClientRect(); return rect.left >= bounds.left - 1 && rect.right <= bounds.left + code.clientLeft + code.clientWidth + 1; });
    }, codeMark.markId)).toBe(true);
  }
  await page.screenshot({ path: info.outputPath("code-scrolled.png"), animations: "disabled" });
  await page.reload(); await page.getByRole("button", { name: /^复习/ }).first().click();
  await expect(page.getByRole("button", { name: /部分印记需要确认/ })).toHaveCount(0);
  expect((await events(page)).length).toBe(2);
});

test("formula source changes require relocation and never mark literal LaTeX instead", async ({ page }) => {
  await open(page);
  await page.locator(".review-mark-content .record-inline-math").click(); await save(page, 1);
  await page.evaluate(async recordId => {
    const { db } = await import("/src/db/database.ts"); const { storage } = await import("/src/services/storageAdapter.ts");
    const record = await db.blocks.get(recordId); if (record?.type !== "record") throw new Error("Missing fixture");
    await storage.saveBlock({ ...record, contentHtml: record.contentHtml.replace('data-latex="E=mc^2"', 'data-latex="E=mc^3"') + '<p>$E=mc^2$</p>' });
  }, recordId);
  await page.reload(); await page.getByRole("button", { name: /^复习/ }).first().click();
  await expect(page.locator(".review-mark-paint [data-mark-id]")).toHaveCount(0);
  await page.getByRole("button", { name: /部分印记需要确认/ }).click();
  await page.getByRole("button", { name: /待重新定位/ }).click();
  await page.getByLabel("选择公式或代码块", { exact: true }).selectOption("0");
  await page.getByRole("button", { name: "移到所选文字" }).click();
  await expect.poll(async () => (await events(page)).length).toBe(2);
  await expect(page.locator(".review-mark-paint [data-mark-id]")).toHaveCount(1);
});


test("terminal inline formula mixed selection ignores actual editor separator and survives reload", async ({ page }, info) => {
  const latex = "\\lim_{x\\to+\\infty}(x^3\\ln\\frac{x+2}{x-2}-4x^2)=\\underline{\\quad}";
  await open(page, html + '<p>求下列极限：<record-inline-math data-latex="' + latex + '"></record-inline-math></p><p>注意展开时的系数变化。</p>');
  const original = await source(page);
  const paragraph = page.locator(".review-mark-content .ProseMirror > p").filter({ hasText: "求下列极限：" });
  await expect(paragraph.locator("img.ProseMirror-separator")).toHaveCount(1);
  await expect(paragraph.locator(".katex-html")).toBeVisible();
  await paragraph.scrollIntoViewIfNeeded();
  for (const backwards of [false, true]) {
    await page.evaluate(() => window.getSelection()?.removeAllRanges());
    await paragraph.evaluate(element => element.scrollIntoView({ block: "center", behavior: "instant" }));
    if (info.project.name === "desktop") {
      const points = await paragraph.evaluate(element => {
        const start = document.createRange(); start.setStart(element.firstChild!, 1); start.setEnd(element.firstChild!, 2);
        const text = start.getBoundingClientRect(); const formula = element.querySelector(".record-inline-math")!.getBoundingClientRect();
        return [{ x: text.left + 1, y: text.top + text.height / 2 }, { x: formula.right - 4, y: formula.top + formula.height / 2 }];
      });
      const [start, end] = backwards ? points.reverse() : points;
      await page.mouse.move(start.x, start.y); await page.mouse.down();
      await page.mouse.move(end.x, end.y, { steps: 16 }); await page.mouse.up();
    } else {
      await paragraph.evaluate((element, backwards) => {
        const glyph = element.querySelector(".katex-html .mord.mathnormal")!.firstChild!;
        const selection = window.getSelection()!;
        if (backwards) selection.setBaseAndExtent(glyph, 1, element.firstChild!, 1);
        else selection.setBaseAndExtent(element.firstChild!, 1, glyph, 1);
        document.dispatchEvent(new Event("selectionchange"));
      }, backwards);
    }
    await expect(page.locator(".review-mark-selection")).toContainText("极限：$");
    await expect(page.locator(".review-mark-selection")).toContainText(latex);
    await expect(page.getByRole("button", { name: "标记选中内容", exact: true })).toBeEnabled();
    await expect(page.locator(".review-mark-error")).toHaveCount(0);
  }
  await save(page, 1);
  expect((await events(page))[0].value?.anchor.structured?.target).toBe("range");
  await page.getByLabel("选择公式或代码块", { exact: true }).selectOption("3"); await save(page, 2);
  expect(await source(page)).toBe(original);
  await closeTools(page); await page.reload();
  await page.getByRole("button", { name: /^复习/ }).first().click();
  await expect.poll(() => page.locator(".review-mark-paint [data-mark-id]").evaluateAll(nodes => new Set(nodes.map(node => node.getAttribute("data-mark-id"))).size)).toBe(2);
  await expect(page.getByRole("button", { name: /部分印记需要确认/ })).toHaveCount(0);
  await paragraph.scrollIntoViewIfNeeded();
  await page.screenshot({ path: info.outputPath("terminal-formula.png"), animations: "disabled" });
});
