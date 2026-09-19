import { expect, test } from "@playwright/test";

test.use({ permissions: ["clipboard-read", "clipboard-write"] });
test.setTimeout(60_000);

test("read-only review copy keeps a block formula when Chromium targets body", async ({ page }) => {
  await page.goto("/?preview=stage3");
  await page.getByRole("button", { name: /BFS Stage3 Preview/ }).first().click();
  await page.getByRole("button", { name: "编辑", exact: true }).click();

  const editor = page.locator(".rich-editor[contenteditable='true']");
  await editor.click();
  await page.keyboard.press("Control+A");
  await page.evaluate(() => navigator.clipboard.writeText([
    "关于例 14.7 的通关练习题，做对这个意味着通关",
    "",
    "$$",
    "I=\\int_0^1 x\\arcsin\\sqrt{4x-4x^2}dx",
    "$$",
  ].join("\n")));
  await page.keyboard.press("Control+V");
  await expect(editor.locator(".formula-editor-card")).toHaveCount(1);

  await page.getByRole("button", { name: "保存", exact: true }).click();
  await page.getByRole("button", { name: "返回", exact: true }).click();
  await page.getByRole("button", { name: /^复习/ }).first().click();
  await expect(page.getByRole("heading", { name: "BFS Stage3 Preview" })).toBeVisible();
  const readOnlyEditor = page.locator(".rich-editor[contenteditable='false']");
  await expect(readOnlyEditor).toBeVisible();

  const firstParagraph = readOnlyEditor.locator(":scope > p").first();
  const trailingParagraph = readOnlyEditor.locator(":scope > p").last();
  const start = await firstParagraph.boundingBox();
  const end = await trailingParagraph.boundingBox();
  if (!start || !end) throw new Error("Review selection endpoints are not visible");
  await page.mouse.move(start.x + 2, start.y + start.height / 2);
  await page.mouse.down();
  await page.mouse.move(end.x + 8, end.y + Math.max(2, end.height / 2), { steps: 12 });
  await page.mouse.up();
  expect(await page.evaluate(() => window.getSelection()?.isCollapsed)).toBe(false);
  await page.evaluate(() => navigator.clipboard.writeText("SENTINEL-BEFORE-COPY"));
  await page.keyboard.press("Control+C");

  const copied = await page.evaluate(() => navigator.clipboard.readText());
  expect(copied).toContain("关于例 14.7 的通关练习题，做对这个意味着通关");
  expect(copied).toContain("$$\nI=\\int_0^1 x\\arcsin\\sqrt{4x-4x^2}dx\n$$");
  expect(copied).not.toBe("SENTINEL-BEFORE-COPY");

  const externalInput = await page.evaluate(() => {
    const input = document.createElement("input");
    input.type = "text";
    input.setAttribute("data-testid", "external-input");
    document.body.appendChild(input);
    input.focus();
    return input;
  });
  void externalInput;
  await page.keyboard.press("Control+V");
  const pastedIntoInput = await page.locator("[data-testid=external-input]").inputValue();
  expect(pastedIntoInput).toContain("I=\\int_0^1 x\\arcsin\\sqrt{4x-4x^2}dx");
});

test("editable editor copy pastes block formula into an external input", async ({ page }) => {
  await page.goto("/?preview=stage3");
  await page.getByRole("button", { name: /BFS Stage3 Preview/ }).first().click();
  await page.getByRole("button", { name: "编辑", exact: true }).click();
  const editor = page.locator(".rich-editor[contenteditable='true']");
  await editor.click();
  await page.keyboard.press("Control+A");
  await page.evaluate(() => navigator.clipboard.writeText(["正文", "", "$$", "E=mc^2", "$$"].join("\n")));
  await page.keyboard.press("Control+V");
  await expect(editor.locator(".formula-editor-card")).toHaveCount(1);
  await editor.click();
  await page.keyboard.press("Control+A");
  await page.keyboard.press("Control+C");
  const copied = await page.evaluate(() => navigator.clipboard.readText());
  expect(copied).toContain("E=mc^2");
  await page.evaluate(() => {
    const element = document.createElement("input");
    element.type = "text";
    element.setAttribute("data-testid", "editable-external-input");
    document.body.appendChild(element);
    element.focus();
  });
  await page.keyboard.press("Control+V");
  await expect(page.locator("[data-testid=editable-external-input]")).toHaveValue(/E=mc\^2/);
});

test("editable mouse selection crossing a formula keeps its LaTeX in external input", async ({ page }) => {
  await page.goto("/?preview=stage3");
  await page.getByRole("button", { name: /BFS Stage3 Preview/ }).first().click();
  await page.getByRole("button", { name: "编辑", exact: true }).click();
  const editor = page.locator(".rich-editor[contenteditable='true']");
  await editor.click();
  await page.keyboard.press("Control+A");
  await page.evaluate(() => navigator.clipboard.writeText(["前文", "", "$$", "E=mc^2", "$$", "", "后文"].join("\n")));
  await page.keyboard.press("Control+V");
  await expect(editor.locator(".formula-editor-card")).toHaveCount(1);
  const first = editor.locator(":scope > p").first();
  const last = editor.locator(":scope > p").last();
  const a = await first.boundingBox();
  const b = await last.boundingBox();
  if (!a || !b) throw new Error("editor paragraphs are not visible");
  await page.mouse.move(a.x + 2, a.y + a.height / 2);
  await page.mouse.down();
  await page.mouse.move(b.x + Math.max(4, b.width - 2), b.y + b.height / 2, { steps: 12 });
  await page.mouse.up();
  await page.evaluate(() => navigator.clipboard.writeText("SENTINEL"));
  await page.keyboard.press("Control+C");
  const copied = await page.evaluate(() => navigator.clipboard.readText());
  expect(copied).toContain("E=mc^2");
  await page.evaluate(() => {
    const input = document.createElement("input");
    input.type = "text";
    input.setAttribute("data-testid", "drag-external-input");
    document.body.appendChild(input);
    input.focus();
  });
  await page.keyboard.press("Control+V");
  await expect(page.locator("[data-testid=drag-external-input]")).toHaveValue(/E=mc\^2/);
});

test("editable mouse selection keeps multiple inline formulas in external input", async ({ page }) => {
  await page.goto("/?preview=stage3");
  await page.getByRole("button", { name: /BFS Stage3 Preview/ }).first().click();
  await page.getByRole("button", { name: "编辑", exact: true }).click();
  const editor = page.locator(".rich-editor[contenteditable='true']");
  await editor.click();
  await page.keyboard.press("Control+A");
  await page.evaluate(() => navigator.clipboard.writeText("设函数 $f(x)$ 在 $x=0$ 处存在二阶导数，且已知：$f(0)=0,\ f'(0)=2,\ f''(0)=4$ 求极限：$\lim_{x\to0} \frac{1}{x}(\frac{2}{f(x)}-\frac{1}{x})$"));
  await page.keyboard.press("Control+V");
  await expect(editor.locator(".record-inline-math")).toHaveCount(4);
  const paragraph = editor.locator(":scope > p").first();
  await paragraph.evaluate((element) => {
    const range = document.createRange();
    range.selectNodeContents(element);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
  });
  await page.evaluate(() => navigator.clipboard.writeText("SENTINEL"));
  await page.keyboard.press("Control+C");
  const copied = await page.evaluate(() => navigator.clipboard.readText());
  expect(copied).toContain("$f(x)$");
  expect(copied).toContain("$x=0$");
  expect(copied).toContain("$f(0)=0");
  await page.evaluate(() => {
    const input = document.createElement("input");
    input.type = "text";
    input.setAttribute("data-testid", "inline-external-input");
    document.body.appendChild(input);
    input.focus();
  });
  await page.keyboard.press("Control+V");
  await expect(page.locator("[data-testid=inline-external-input]")).toHaveValue(/\$f\(x\)\$/);
});

test("real mouse drag across wrapped inline formulas keeps the complete selection", async ({ page }) => {
  await page.goto("/?preview=stage3");
  await page.getByRole("button", { name: /BFS Stage3 Preview/ }).first().click();
  await page.getByRole("button", { name: "编辑", exact: true }).click();
  const editor = page.locator(".rich-editor[contenteditable='true']");
  await editor.click();
  await page.keyboard.press("Control+A");
  await page.evaluate(() => navigator.clipboard.writeText("设函数 $f(x)$ 在 $x=0$ 处存在二阶导数，且已知：$f(0)=0,\ f'(0)=2,\ f''(0)=4$ 求极限：$\lim_{x\to0} \frac{1}{x}(\frac{2}{f(x)}-\frac{1}{x})$"));
  await page.keyboard.press("Control+V");
  await expect(editor.locator(".record-inline-math")).toHaveCount(4);
  const paragraph = editor.locator(":scope > p").first();
  const rects = await paragraph.evaluate((element) => {
    const range = document.createRange();
    range.selectNodeContents(element);
    return Array.from(range.getClientRects()).map((rect) => ({ x: rect.x, y: rect.y, width: rect.width, height: rect.height }));
  });
  if (rects.length === 0) throw new Error("paragraph has no client rects");
  const first = rects[0];
  const last = rects[rects.length - 1];
  await page.mouse.move(first.x + 1, first.y + first.height / 2);
  await page.mouse.down();
  await page.mouse.move(last.x + last.width - 1, last.y + last.height / 2, { steps: 20 });
  await page.mouse.up();
  await page.evaluate(() => navigator.clipboard.writeText("SENTINEL"));
  await page.keyboard.press("Control+C");
  const copied = await page.evaluate(() => navigator.clipboard.readText());
  expect(copied).toContain("$f(x)$");
  expect(copied).toContain("$x=0$");
  expect(copied).toContain("$f(0)=0");
});

test("read-only wrapped inline formulas copied from body keep LaTeX", async ({ page }) => {
  await page.goto("/?preview=stage3");
  await page.getByRole("button", { name: /BFS Stage3 Preview/ }).first().click();
  await page.getByRole("button", { name: "编辑", exact: true }).click();
  const editor = page.locator(".rich-editor[contenteditable='true']");
  await editor.click();
  await page.keyboard.press("Control+A");
  await page.evaluate(() => navigator.clipboard.writeText("设函数 $f(x)$ 在 $x=0$ 处存在二阶导数，且已知：$f(0)=0,\ f'(0)=2,\ f''(0)=4$ 求极限：$\lim_{x\to0} \frac{1}{x}(\frac{2}{f(x)}-\frac{1}{x})$"));
  await page.keyboard.press("Control+V");
  await page.getByRole("button", { name: "保存", exact: true }).click();
  await page.getByRole("button", { name: "返回", exact: true }).click();
  await page.getByRole("button", { name: /^复习/ }).first().click();
  const readOnly = page.locator(".rich-editor[contenteditable='false']");
  await expect(readOnly.locator(".record-inline-math")).toHaveCount(4);
  const paragraph = readOnly.locator(":scope > p").first();
  await paragraph.evaluate((element) => {
    const range = document.createRange();
    range.selectNodeContents(element);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
  });
  await page.evaluate(() => navigator.clipboard.writeText("SENTINEL"));
  await page.keyboard.press("Control+C");
  const copied = await page.evaluate(() => navigator.clipboard.readText());
  expect(copied).toContain("$f(x)$");
  expect(copied).toContain("$x=0$");
  expect(copied).toContain("$f(0)=0");
});

test("selection endpoint inside rendered inline formula keeps its LaTeX", async ({ page }) => {
  await page.goto("/?preview=stage3");
  await page.getByRole("button", { name: /BFS Stage3 Preview/ }).first().click();
  await page.getByRole("button", { name: "编辑", exact: true }).click();
  const editor = page.locator(".rich-editor[contenteditable='true']");
  await editor.click();
  await page.keyboard.press("Control+A");
  await page.evaluate(() => navigator.clipboard.writeText("设函数 $f(x)$ 在 $x=0$ 处存在二阶导数，且已知：$f(0)=0,\ f'(0)=2,\ f''(0)=4$ 求极限：$\lim_{x\to0} \frac{1}{x}(\frac{2}{f(x)}-\frac{1}{x})$"));
  await page.keyboard.press("Control+V");
  await expect(editor.locator(".record-inline-math")).toHaveCount(4);
  await page.evaluate(() => {
    const formula = document.querySelector(".rich-editor .record-inline-math");
    const paragraph = document.querySelector(".rich-editor > p");
    const endpoint = formula?.firstChild;
    if (!formula || !paragraph || !endpoint) throw new Error("formula DOM endpoint not found");
    const range = document.createRange();
    range.setStart(endpoint, 0);
    range.setEnd(paragraph, paragraph.childNodes.length);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
  });
  await page.evaluate(() => navigator.clipboard.writeText("SENTINEL"));
  await page.keyboard.press("Control+C");
  const copied = await page.evaluate(() => navigator.clipboard.readText());
  expect(copied).toContain("$f(x)$");
});
