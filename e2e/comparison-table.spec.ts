import { expect, test, type Locator, type Page } from "@playwright/test";

type TableData = {
  title: string;
  columns: Array<{ id: string; label: string }>;
  rows: Array<{ id: string; cells: Record<string, string> }>;
};

test.setTimeout(90_000);

const live = (page: Page) => page.locator('.page-transition-layer:not([aria-hidden="true"])').last();
const table = (page: Page) => live(page).locator("table.comparison-table-view");
const block = (page: Page) => live(page).locator(".comparison-block");
const recordTitle = "对照表布局验收";
const longText = "队列按先进先出的顺序扩展相邻节点，并记录已经访问的状态，避免重复遍历。";

const fixture = (): TableData => ({
  title: "图遍历对照表",
  columns: [
    { id: "concept", label: "算法" },
    { id: "order", label: "访问方式" },
    { id: "detail", label: "实现与边界" },
    { id: "cost", label: "复杂度" },
  ],
  rows: [
    { id: "bfs", cells: { concept: "BFS", order: "逐层扩展", detail: longText.repeat(5), cost: "$O(V+E)$" } },
    { id: "dfs", cells: { concept: "DFS", order: "沿路径深入", detail: "使用栈或递归。", cost: "$O(V+E)$" } },
    { id: "empty", cells: { concept: "待补充", order: "", detail: "", cost: "" } },
  ],
});

const openTable = async (page: Page, data: TableData, options: { collapse?: boolean; markdown?: boolean } = {}) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "今天", exact: true })).toBeVisible();
  await page.evaluate(async ({ data, recordTitle, options }) => {
    const modulePath = "/src/db/database.ts";
    const { db } = await import(modulePath);
    const node = document.createElement("record-comparison-table");
    node.setAttribute("data-json", JSON.stringify(data));
    if (options.markdown !== false) node.setAttribute("data-format", "markdown");
    const content = options.collapse
      ? `<record-collapse data-title="折叠中的对照表" data-default-open="true">${node.outerHTML}<p></p></record-collapse>`
      : `${node.outerHTML}<p></p>`;
    await db.blocks.put({
      id: "comparison-test", type: "record", title: recordTitle, subject: "读书笔记", date: "2026-09-28",
      createdAt: "2026-09-28T00:00:00.000Z", updatedAt: "2026-09-28T00:00:00.000Z", order: 0,
      contentHtml: content, tags: [], assets: [], formulas: [], mistakeRefs: [],
    });
  }, { data, recordTitle, options });
  await page.reload();
  await expect(page.getByRole("heading", { name: "今天", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "日志", exact: true }).first().click();
  await live(page).locator(".record-card-main").filter({ hasText: recordTitle }).click();
  await live(page).getByRole("button", { name: "打开完整日志", exact: true }).click();
  await expect(table(page)).toBeVisible();
  await expect(live(page)).toHaveClass(/page-transition-layer-entered/);
};

const startEditing = async (page: Page) => {
  await live(page).getByRole("button", { name: "编辑", exact: true }).click();
  await expect(block(page).getByRole("button", { name: "加行", exact: true })).toBeVisible();
  await expect(live(page)).toHaveClass(/page-transition-layer-entered/);
};

const geometry = (target: Locator) => target.evaluate((element) => {
  const scroller = element.closest(".comparison-table-scroll")!;
  return {
    containerWidth: scroller.clientWidth,
    scrollWidth: scroller.scrollWidth,
    scrollLeft: scroller.scrollLeft,
    rows: [...element.querySelectorAll("tr")].map((row) => [...row.children].map((cell) => {
      const rect = cell.getBoundingClientRect();
      return { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom, width: rect.width, height: rect.height, border: getComputedStyle(cell).borderBottomWidth };
    })),
  };
});

const assertAligned = async (page: Page) => {
  await expect.poll(async () => {
    const measured = await geometry(table(page));
    const errors: string[] = [];
    measured.rows.forEach((row, rowIndex) => {
      row.forEach((cell, columnIndex) => {
        if (Math.abs(cell.top - row[0].top) > 1 || Math.abs(cell.bottom - row[0].bottom) > 1) errors.push(`row-${rowIndex}-${columnIndex}`);
        const header = measured.rows[0][columnIndex];
        if (Math.abs(cell.left - header.left) > 1 || Math.abs(cell.width - header.width) > 1) errors.push(`column-${rowIndex}-${columnIndex}`);
        if (rowIndex < measured.rows.length - 1 && cell.border !== "1px") errors.push(`border-${rowIndex}-${columnIndex}`);
      });
      if (rowIndex > 0 && Math.abs(row[0].top - measured.rows[rowIndex - 1][0].bottom) > 1) errors.push(`gap-${rowIndex}`);
    });
    return errors;
  }).toEqual([]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(1);
};

const saveRecord = async (page: Page) => {
  await live(page).getByRole("button", { name: "保存", exact: true }).click();
  await expect(live(page).getByText("正式内容已保存", { exact: true })).toBeVisible();
};

const readStoredTable = (page: Page) => page.evaluate(async () => {
  const modulePath = "/src/db/database.ts";
  const { db } = await import(modulePath);
  const record = await db.blocks.get("comparison-test");
  const document = new DOMParser().parseFromString(record.contentHtml, "text/html");
  return JSON.parse(document.querySelector("record-comparison-table")!.getAttribute("data-json")!);
});

test("cell clicks do not select the whole table node", async ({ page }) => {
  await openTable(page, fixture());
  await table(page).locator("tbody td").first().click();
  await expect(live(page).locator(".node-recordComparisonTable.ProseMirror-selectednode")).toHaveCount(0);
  await startEditing(page);
  await table(page).locator("tbody td").first().click();
  await expect(live(page).locator(".node-recordComparisonTable.ProseMirror-selectednode")).toHaveCount(0);
  const input = table(page).locator("textarea");
  expect(await input.evaluate(element => element.selectionStart === element.selectionEnd)).toBe(true);
  await input.fill("最后一次输入");
  await saveRecord(page);
  expect((await readStoredTable(page)).rows[0].cells.concept).toBe("最后一次输入");
});

test("uneven rows share borders and intrinsic column widths, with one sticky-first-column scroller", async ({ page }, testInfo) => {
  await openTable(page, fixture());
  await assertAligned(page);
  const before = await geometry(table(page));
  expect(before.rows[1][0].height).toBeGreaterThan(before.rows[2][0].height + 20);
  expect(before.rows[0][2].width).toBeGreaterThan(before.rows[0][0].width * 1.4);
  expect(before.rows[0][0].width).toBeLessThan(before.containerWidth * 0.55);
  await expect(live(page).locator(".comparison-fixed-panel, .comparison-table-right-scroll")).toHaveCount(0);
  await expect(live(page).locator(".comparison-table-scroll")).toHaveCount(1);
  await testInfo.attach("table-geometry", { body: JSON.stringify(before, null, 2), contentType: "application/json" });
  await page.screenshot({ path: testInfo.outputPath("comparison-light.png"), fullPage: true, animations: "disabled" });
  await page.locator("html").evaluate((element) => element.setAttribute("data-theme", "dark"));
  await assertAligned(page);
  await page.screenshot({ path: testInfo.outputPath("comparison-dark.png"), fullPage: true, animations: "disabled" });
  await page.locator("html").evaluate((element) => element.setAttribute("data-theme", "light"));

  const scroller = live(page).locator(".comparison-table-scroll");
  if (before.scrollWidth > before.containerWidth + 1) {
    await scroller.evaluate((element) => { element.scrollLeft = element.scrollWidth; });
    await expect(table(page).locator(".katex").first()).toBeVisible();
    const after = await geometry(table(page));
    expect(after.scrollLeft).toBeGreaterThan(0);
    expect(Math.abs(after.rows[1][0].left - before.rows[1][0].left)).toBeLessThanOrEqual(1);
    expect(after.rows[1][2].left).toBeLessThan(before.rows[1][2].left);
    await assertAligned(page);
    await page.screenshot({ path: testInfo.outputPath("comparison-scrolled.png"), fullPage: true, animations: "disabled" });
  }
  expect(await readStoredTable(page)).toEqual(fixture());
});

test("editing grows and shrinks the entire row without changing column widths, then survives saving", async ({ page }, testInfo) => {
  const data = fixture();
  data.rows = [data.rows[1]];
  await openTable(page, data);
  await startEditing(page);
  const cell = table(page).getByRole("cell", { name: "第 1 行实现与边界列，点击编辑", exact: true });
  const beforeEditing = await geometry(table(page));
  await cell.click();
  const input = table(page).getByRole("textbox", { name: "第 1 行实现与边界列", exact: true });
  const initial = await geometry(table(page));
  initial.rows[0].forEach((header, index) => expect(Math.abs(header.width - beforeEditing.rows[0][index].width)).toBeLessThanOrEqual(1));
  await input.fill(Array.from({ length: 12 }, (_, index) => `第 ${index + 1} 行：${longText}`).join("\n"));
  await assertAligned(page);
  const expanded = await geometry(table(page));
  expect(expanded.rows[1][0].height).toBeGreaterThan(initial.rows[1][0].height + 100);
  expect(Math.abs(expanded.rows[0][2].width - initial.rows[0][2].width)).toBeLessThanOrEqual(1);
  expect(await input.evaluate((element: HTMLTextAreaElement) => element.scrollHeight - element.clientHeight)).toBeLessThanOrEqual(1);
  await input.fill("短句");
  await assertAligned(page);
  const shortened = await geometry(table(page));
  expect(shortened.rows[1][0].height).toBeLessThan(expanded.rows[1][0].height - 100);
  await input.press("Control+Enter");
  await expect(cell).toHaveText("短句");
  await assertAligned(page);

  await table(page).getByRole("cell", { name: "第 1 行首列，点击编辑", exact: true }).press("Enter");
  const firstInput = table(page).getByRole("textbox", { name: "第 1 行首列", exact: true });
  await firstInput.fill("第一列也可以是多行内容\n".repeat(5));
  await assertAligned(page);
  await page.screenshot({ path: testInfo.outputPath("comparison-editing.png"), fullPage: true, animations: "disabled" });
  await firstInput.press("Escape");
  await assertAligned(page);
  await saveRecord(page);
  const stored = await readStoredTable(page);
  expect(stored.rows[0].cells.detail).toBe("短句");
  expect(stored.rows[0].cells.concept).toBe("DFS");
  expect(stored.columns).toEqual(data.columns);
});

test("long first-column text, unbroken strings, delayed math and scaling stay within the page", async ({ page }, testInfo) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const data = fixture();
  data.columns[0].label = "这是一个很长的首列表头，用于检查窄屏固定列";
  data.rows[0].cells.concept = "很长的第一列也必须参与整行高度计算。".repeat(9);
  data.rows[0].cells.detail = "https://example.invalid/" + "unbrokentoken".repeat(50);
  data.rows[1].cells.detail = "$$\n\\underbrace{x+x+\\cdots+x}_{n\\text{ terms}}=\\sum_{i=1}^{100} x_i+\\int_0^1 \\frac{t^2+1}{t+2}\\,dt\n$$";
  await openTable(page, data);
  await table(page).locator("tbody tr").nth(1).scrollIntoViewIfNeeded();
  await expect(table(page).locator(".katex-display")).toBeVisible();
  await assertAligned(page);
  for (const width of [320, 768, 1440]) {
    await page.setViewportSize({ width, height: 1000 });
    await assertAligned(page);
    const measured = await geometry(table(page));
    expect(measured.rows[0][0].width).toBeLessThan(measured.containerWidth * 0.6);
  }
  await page.setViewportSize(testInfo.project.name === "desktop" ? { width: 1440, height: 1000 } : { width: 390, height: 844 });
  await page.locator("html").evaluate((element) => {
    element.setAttribute("data-theme", "dark");
    element.style.setProperty("--editor-font-scale", "1.5");
  });
  await assertAligned(page);
  await block(page).scrollIntoViewIfNeeded();
  await page.screenshot({ path: testInfo.outputPath("comparison-dark-scaled.png"), fullPage: true, animations: "disabled" });
  expect(errors).toEqual([]);
});

test("single-column empty cells, added and removed rows and columns retain the final cell", async ({ page }) => {
  const data: TableData = { title: "单列边界", columns: [{ id: "only", label: "唯一列" }], rows: [{ id: "only-row", cells: { only: "" } }] };
  await openTable(page, data, { markdown: false });
  await assertAligned(page);
  await expect(table(page).locator("tbody td")).toHaveText("—");
  await startEditing(page);
  await expect(block(page).getByRole("button", { name: "删除唯一列" })).toHaveCount(0);
  await block(page).getByRole("button", { name: "删除第 1 行", exact: true }).click();
  await expect(table(page).locator("tbody tr")).toHaveCount(1);
  await block(page).getByRole("button", { name: "加列", exact: true }).click();
  await block(page).getByRole("button", { name: "加行", exact: true }).click();
  await expect(table(page).locator("tbody tr")).toHaveCount(2);
  await expect(table(page).locator("thead th")).toHaveCount(2);
  await table(page).getByRole("cell", { name: "第 2 行首列，点击编辑", exact: true }).click();
  await table(page).getByRole("textbox", { name: "第 2 行首列", exact: true }).fill("移到第一行");
  await table(page).getByRole("textbox", { name: "第 2 行首列", exact: true }).press("Control+Enter");
  await block(page).getByRole("button", { name: "上移第 2 行", exact: true }).click();
  await expect(table(page).locator("tbody tr").first().locator("td").first()).toHaveText("移到第一行");
  await block(page).getByRole("button", { name: "删除新列列", exact: true }).click();
  await block(page).getByRole("button", { name: "删除第 2 行", exact: true }).click();
  await assertAligned(page);
  await saveRecord(page);
  const stored = await readStoredTable(page);
  expect(stored.columns).toEqual(data.columns);
  expect(stored.rows).toHaveLength(1);
  expect(stored.rows[0].cells).toEqual({ only: "移到第一行" });
});

test("many columns in a nested table use local scrolling and keep row geometry after resize", async ({ page }, testInfo) => {
  const data: TableData = {
    title: "多列对照",
    columns: Array.from({ length: 12 }, (_, index) => ({ id: `column-${index}`, label: `第 ${index + 1} 列` })),
    rows: Array.from({ length: 8 }, (_, rowIndex) => ({
      id: `row-${rowIndex}`,
      cells: Object.fromEntries(Array.from({ length: 12 }, (_, columnIndex) => [`column-${columnIndex}`, columnIndex === rowIndex ? longText.repeat(2) : `${rowIndex + 1}-${columnIndex + 1}`])),
    })),
  };
  await openTable(page, data, { collapse: true });
  await expect(table(page).locator("thead th")).toHaveCount(12);
  await expect(table(page).locator("tbody tr")).toHaveCount(8);
  await assertAligned(page);
  const before = await geometry(table(page));
  expect(before.scrollWidth).toBeGreaterThan(before.containerWidth);
  await live(page).locator(".comparison-table-scroll").evaluate((element) => { element.scrollLeft = element.scrollWidth; });
  await expect(table(page).locator("thead th").last().locator(".formula-render-pending")).toHaveCount(0);
  await expect.poll(async () => {
    await live(page).locator(".comparison-table-scroll").evaluate((element) => { element.scrollLeft = element.scrollWidth; });
    const measured = await geometry(table(page));
    return Math.abs(measured.scrollWidth - measured.containerWidth - measured.scrollLeft);
  }).toBeLessThanOrEqual(1);
  const after = await geometry(table(page));
  expect(Math.abs(after.rows[1][0].left - before.rows[1][0].left)).toBeLessThanOrEqual(1);
  await assertAligned(page);
  const lastColumnRight = after.rows[0].at(-1)!.right;
  const scrollerRight = await live(page).locator(".comparison-table-scroll").evaluate((element) => element.getBoundingClientRect().right);
  expect(lastColumnRight).toBeLessThanOrEqual(scrollerRight + 1);
  await page.screenshot({ path: testInfo.outputPath("comparison-many-columns.png"), animations: "disabled" });
  expect(Math.abs((await geometry(table(page))).scrollLeft - after.scrollLeft)).toBeLessThanOrEqual(1);
});

test("long header editing reflows on viewport resize and commits on blur", async ({ page }) => {
  const data = fixture();
  await openTable(page, data);
  await startEditing(page);
  await table(page).getByRole("columnheader", { name: "表格首列表头，点击编辑", exact: true }).click();
  const input = table(page).getByRole("textbox", { name: "表格首列表头", exact: true });
  const header = "长表头也需要随列宽变化自动换行".repeat(6);
  await input.fill(header);
  for (const width of [1440, 320, 768]) {
    await page.setViewportSize({ width, height: 1000 });
    await expect.poll(() => input.evaluate((element: HTMLTextAreaElement) => element.scrollHeight - element.clientHeight)).toBeLessThanOrEqual(1);
    await assertAligned(page);
  }
  await block(page).locator(".structure-block-head input").click();
  await expect(table(page).locator("thead th").first()).toHaveText(header);
  await saveRecord(page);
  expect((await readStoredTable(page)).columns[0].label).toBe(header);
});

test("header-only tables recover through add-row and preserve markdown image policy", async ({ page }) => {
  const data: TableData = { title: "空表边界", columns: [{ id: "only", label: "唯一列" }], rows: [] };
  await openTable(page, data);
  await expect(table(page).locator("tbody tr")).toHaveCount(0);
  await startEditing(page);
  await block(page).getByRole("button", { name: "加行", exact: true }).click();
  await expect(table(page).locator("tbody tr")).toHaveCount(1);
  await table(page).getByRole("cell", { name: "第 1 行首列，点击编辑", exact: true }).click();
  const input = table(page).getByRole("textbox", { name: "第 1 行首列", exact: true });
  const content = "![图片不自动加载](https://example.invalid/image.png)";
  await input.fill(content);
  await input.press("Control+Enter");
  await expect(table(page).locator("img")).toHaveCount(0);
  await expect(table(page).getByRole("link", { name: "图片不自动加载" })).toBeVisible();
  await assertAligned(page);
  await saveRecord(page);
  expect((await readStoredTable(page)).rows[0].cells.only).toBe(content);
});
