import { expect, test } from "@playwright/test";

test.setTimeout(60_000);

const assertNoHorizontalOverflow = async (page: import("@playwright/test").Page) => {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(1);
};

for (const theme of ["reading", "modern"] as const) {
  test(`stage 3 formal editor preserves draft, source navigation and layout in ${theme}`, async ({ page }, testInfo) => {
    const errors: string[] = [];
    page.on("console", (message) => {
      const text = message.text();
      const knownTiptapDevWarning = text.startsWith("Warning: flushSync was called from inside a lifecycle method.");
      if (message.type() === "error" && !knownTiptapDevWarning) errors.push(text);
    });
    page.on("pageerror", (error) => errors.push(error.message));
    await page.addInitScript(([key, value]) => localStorage.setItem(key, value), ["study-journal-visual-theme-v1", theme]);

    await page.goto("/?preview=stage3");
    await page.getByRole("button", { name: /BFS Stage3 Preview/ }).first().click();
    await expect(page.getByRole("heading", { name: "BFS Stage3 Preview" })).toBeVisible();
    await expect(page.getByRole("button", { name: "编辑", exact: true })).toBeVisible();
    await page.waitForTimeout(300);
    await assertNoHorizontalOverflow(page);
    await page.screenshot({ path: testInfo.outputPath(`stage3-reading-${theme}.png`), fullPage: true });

    await page.getByRole("button", { name: "编辑", exact: true }).click();
    const title = page.getByRole("textbox", { name: "记录标题" });
    await title.fill("BFS 中 visited 标记时机、重复入队与 predecessor 稳定性的完整推导");
    const editor = page.locator(".rich-editor[contenteditable='true']");
    await expect(editor).toBeVisible();
    await expect(page.getByLabel("选择学科")).toHaveCount(0);
    await page.getByRole("button", { name: "更多操作" }).click();
    await page.getByRole("combobox", { name: "日志学科" }).selectOption({ label: "数学" });
    await page.getByRole("button", { name: "收起更多操作" }).click();
    const mobileMoreTools = page.getByRole("button", { name: "展开更多编辑工具" });
    const codeLanguage = page.getByRole("combobox", { name: "代码块语言" });
    if (testInfo.project.name === "android-narrow") {
      await expect(mobileMoreTools).toBeVisible();
      await expect(codeLanguage).toBeHidden();
      await mobileMoreTools.click();
      await expect(codeLanguage).toBeVisible();
      await expect(page.getByTitle("图片")).toBeVisible();
    } else {
      await expect(mobileMoreTools).toBeHidden();
      await expect(codeLanguage).toBeVisible();
    }
    const toolbarAlignment = await page.locator(".editor-toolbar").evaluate((toolbar) => {
      const controls = Array.from(toolbar.querySelectorAll<HTMLElement>("button, label.editor-file-button, select"))
        .filter((control) => {
          const style = window.getComputedStyle(control);
          return style.display !== "none" && style.visibility !== "hidden" && control.getBoundingClientRect().height > 0;
        });
      const iconOffsets = controls.flatMap((control) => {
        const icon = control.querySelector("svg");
        if (!icon) return [];
        const controlRect = control.getBoundingClientRect();
        const iconRect = icon.getBoundingClientRect();
        return [Math.abs((controlRect.top + controlRect.bottom - iconRect.top - iconRect.bottom) / 2)];
      });
      return {
        heights: controls.map((control) => control.getBoundingClientRect().height),
        maximumIconOffset: Math.max(0, ...iconOffsets),
      };
    });
    expect(toolbarAlignment.heights.every((height) => height >= 35.5 && height <= 40.5)).toBe(true);
    expect(toolbarAlignment.maximumIconOffset).toBeLessThanOrEqual(1.5);
    await assertNoHorizontalOverflow(page);
    await editor.fill("在 BFS 中，一个节点可能同时与多个已经访问到的父节点相邻。\n\n首次发现时必须先标记 visited，再加入队列，并同时记录 predecessor。\n\n这条不变量保证每个节点最多入队一次，也保证首次发现路径不会被后续父节点覆盖。");
    await expect(page.getByRole("status")).toContainText(/正在保存本机草稿|草稿已存于本机/, { timeout: 10_000 });
    await page.locator("html").evaluate((element) => element.style.setProperty("--font-scale", "1.25"));
    await assertNoHorizontalOverflow(page);
    await page.screenshot({ path: testInfo.outputPath(`stage3-editor-${theme}.png`), fullPage: true });

    await page.getByRole("button", { name: "保存", exact: true }).click();
    await expect(page.getByRole("heading", { name: /BFS 中 visited/ })).toBeVisible();
    await expect(page.getByText("正式内容已保存", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "返回", exact: true }).click();
    await expect(page.getByRole("heading", { name: "今天想记下什么？" })).toBeVisible();
    await assertNoHorizontalOverflow(page);
    expect(errors).toEqual([]);
  });
}
