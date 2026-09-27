import { expect, test, type Locator, type Page } from "@playwright/test";

test.use({ permissions: ["clipboard-read", "clipboard-write"] });
test.setTimeout(60_000);

const expectTransparentFormulas = async (page: Page, editor: Locator) => {
  for (const theme of ["light", "dark"]) {
    await page.evaluate((value) => document.documentElement.setAttribute("data-theme", value), theme);
    const formulas = editor.locator(".record-inline-math, .formula-editor-card, .formula-preview");
    await expect(formulas).toHaveCount(5);
    for (const formula of await formulas.all()) {
      await expect(formula).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
      await expect(formula).toHaveCSS("background-image", "none");
    }
  }
};

test("inline, pasted block and inserted formulas share the text background in edit and read-only views", async ({ page }) => {
  await page.goto("/?preview=stage3");
  await page.getByRole("button", { name: /BFS Stage3 Preview/ }).first().click();
  await page.getByRole("button", { name: "编辑", exact: true }).click();
  const editor = page.locator(".rich-editor[contenteditable='true']");
  await editor.click();
  await page.keyboard.press("Control+A");
  await page.evaluate(() => navigator.clipboard.writeText("正文 $x^2$ 正文\n\n$$\nE=mc^2\n$$\n\n结尾正文"));
  await page.keyboard.press("Control+V");
  await expect(editor.locator(".record-inline-math")).toHaveCount(1);
  await expect(editor.locator(".formula-editor-card")).toHaveCount(1);
  await editor.locator(":scope > p").last().click();
  const expandTools = page.getByRole("button", { name: "展开更多编辑工具", exact: true });
  if (await expandTools.isVisible()) {
    await expandTools.click();
  }
  await page.getByRole("button", { name: "公式", exact: true }).click();
  await expect(editor.locator(".formula-editor-card")).toHaveCount(2);
  await expect(editor.locator(".katex")).toHaveCount(3);
  await expectTransparentFormulas(page, editor);

  await page.getByRole("button", { name: "保存", exact: true }).click();
  await page.getByRole("button", { name: "返回", exact: true }).click();
  await page.getByRole("button", { name: /^复习/ }).first().click();
  const readOnlyEditor = page.locator(".rich-editor[contenteditable='false']");
  await expect(readOnlyEditor).toBeVisible();
  await expect(readOnlyEditor.locator(".katex")).toHaveCount(3);
  await expectTransparentFormulas(page, readOnlyEditor);
});
