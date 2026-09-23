import { expect, test, type Page, type Locator } from "@playwright/test";

test.setTimeout(90000);
const active = (page: Page) => page.locator('.page-transition-layer:not([aria-hidden="true"])').last();
const node = (page: Page, id: string) => active(page).locator('[data-node-id="' + id + '"]');
const capture = async (page: Page, filename: string) => {
  await expect(page.locator(".page-transition-layer-exiting, .page-transition-layer-entering")).toHaveCount(0);
  await page.screenshot({ path: test.info().outputPath(filename), animations: "disabled", scale: "css" });
};
const prepare = async (page: Page) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "今天想记下什么？" })).toBeVisible();
  const ids = await page.evaluate(async () => {
    const { knowledgeRepository: repository } = await import("/src/features/knowledgeLibrary/runtime.ts");
    const { createKnowledgeEntity, editKnowledgeEntity } = await import("/src/features/knowledgeLibrary/commands.ts");
    const { orderBetween } = await import("/src/features/knowledgeLibrary/orderKey.ts");
    const { db } = await import("/src/db/database.ts");
    await repository.createLibrary("导图验收", "map-ux");
    const opened = await repository.open("map-ux");
    const topic = createKnowledgeEntity("map-ux", "workspace", "数据结构与算法");
    await repository.execute(opened.context, topic);
    const order = new Map<string, string>();
    const add = async (title: string, parent = "@root") => {
      const command = createKnowledgeEntity("map-ux", "node", title, topic.entity.id, parent);
      const orderKey = orderBetween(order.get(parent) ?? null, null, command.id); order.set(parent, orderKey);
      command.changes.position = { parentNodeId: parent, orderKey };
      await repository.execute(opened.context, command); return command.entity.id;
    };
    const roots = [];
    for (const title of ["线性结构", "树与图", "查找与排序", "解题方法"]) roots.push(await add(title));
    const first = await add("队列与栈", roots[0]);
    const second = await add("链表", roots[0]);
    const deep = await add("单调队列", first);
    await add("树的遍历", roots[1]); await add("最短路径", roots[1]);
    await add("二分查找", roots[2]); await add("归并排序", roots[2]);
    await add("动态规划", roots[3]); await add("贪心策略", roots[3]);
    const labels = ["双端队列的实现与边界", "滑动窗口：从例题理解单调队列", "复杂度分析与复习要点"];
    for (let index = 0; index < labels.length; index += 1) {
      const recordId = "map-log-" + index;
      await db.blocks.put({ id: recordId, type: "record", title: labels[index], subject: "算法", date: "2026-09-23", createdAt: "2026-09-23T00:00:00.000Z", updatedAt: "2026-09-23T00:00:00.000Z", order: index, contentHtml: "<p>保留原日志正文</p>", tags: [], assets: [], formulas: [], mistakeRefs: [] });
      const reference = createKnowledgeEntity("map-ux", "reference", "", topic.entity.id, "@root", recordId, first);
      await repository.execute(opened.context, reference);
      if (index === 0) { const latest = await repository.open("map-ux"); await repository.execute(latest.context, editKnowledgeEntity("map-ux", latest.state, latest.state.entities[reference.entity.id], "remark", "注意队首与队尾的边界条件。")); }
    }
    return { roots, first, second, deep, labels };
  });
  await page.reload();
  await page.getByRole("button", { name: "更多", exact: true }).last().click();
  await active(page).getByRole("button", { name: "知识库", exact: true }).click();
  await active(page).getByRole("button", { name: "数据结构与算法", exact: true }).click();
  return ids;
};
const position = (page: Page, id: string) => page.evaluate(async entityId => {
  const { knowledgeRepository: repository } = await import("/src/features/knowledgeLibrary/runtime.ts");
  const { valueOf } = await import("/src/features/knowledgeLibrary/protocol.ts");
  const opened = await repository.open("map-ux"); return valueOf(opened.state, opened.state.entities[entityId], "position");
}, id);
const dragTo = async (page: Page, source: Locator, target: Locator, fraction = .5) => {
  const sourceBox = (await source.boundingBox())!; const targetBox = (await target.boundingBox())!;
  await page.mouse.move(sourceBox.x + sourceBox.width / 2, sourceBox.y + sourceBox.height / 2); await page.mouse.down();
  await page.mouse.move(targetBox.x + targetBox.width / 2, targetBox.y + targetBox.height * fraction, { steps: 14 });
  await expect(active(page).locator(".knowledge-map-ghost")).toBeVisible();
  await page.mouse.up();
};

test("balanced map, compact circular controls, direct details and nested outline logs", async ({ page }) => {
  const ids = await prepare(page);
  await expect(active(page).locator(".knowledge-outline-log")).toHaveCount(3);
  await capture(page, "outline-logs.png");
  await active(page).getByRole("button", { name: "导图", exact: true }).click();
  await expect(active(page).locator("[data-map-root]")).toBeVisible();
  await capture(page, "map-readable-start.png");
  await active(page).getByRole("button", { name: "查看全貌" }).click();
  await expect(active(page).locator("[data-map-root]")).toHaveText("数据结构与算法");
  await expect(active(page).locator(".knowledge-drag-handle")).toHaveCount(0);
  await expect(node(page, ids.deep).locator(".knowledge-map-toggle")).toHaveCount(0);
  const sides = await active(page).locator('.knowledge-map-node[data-depth="0"]').evaluateAll(elements => elements.map(element => element.getAttribute("data-side")));
  expect(sides).toContain("-1"); expect(sides).toContain("1");
  await capture(page, "balanced-map.png");
  await node(page, ids.first).locator(".knowledge-map-label").click();
  const detail = active(page).getByRole("complementary", { name: "节点详情" });
  await expect(detail).toBeVisible();
  await expect(detail.locator(".knowledge-reference-link")).toHaveCount(3);
  await expect(active(page).getByRole("button", { name: "详情", exact: true })).toHaveCount(0);
  await detail.getByLabel("引用操作：" + ids.labels[0]).click();
  const metrics = await detail.evaluate(element => ({ title: parseFloat(getComputedStyle(element.querySelector(".knowledge-reference-link strong")!).fontSize), action: parseFloat(getComputedStyle(element.querySelector(".knowledge-reference-menu button")!).fontSize), overflow: element.scrollWidth > element.clientWidth }));
  expect(metrics.action).toBeLessThan(metrics.title); expect(metrics.overflow).toBe(false);
  await capture(page, "node-details.png");
  await detail.getByLabel("引用操作：" + ids.labels[0]).click();
  await detail.getByRole("button", { name: ids.labels[0], exact: true }).click();
  await expect(active(page).locator(".record-editor-page")).toBeVisible();
  await active(page).getByRole("button", { name: "返回", exact: true }).first().click();
  await expect(active(page).getByRole("complementary", { name: "节点详情" })).toBeVisible();
  await active(page).getByRole("button", { name: "关闭节点详情" }).click();
  await active(page).getByRole("button", { name: "查看全貌" }).click();
  const toggle = node(page, ids.first).getByRole("button", { name: "折叠分支" });
  await toggle.click(); await expect(node(page, ids.deep)).toHaveCount(0);
  await expect(active(page).getByRole("complementary", { name: "节点详情" })).toHaveCount(0);
  await node(page, ids.first).getByRole("button", { name: "展开分支" }).click();
  await expect(node(page, ids.deep)).toBeVisible();
  await active(page).getByRole("button", { name: "大纲", exact: true }).click();
  const row = active(page).locator('[data-outline-id="' + ids.first + '"]');
  await row.getByRole("button", { name: "折叠分支" }).click();
  await expect(active(page).locator(".knowledge-outline-log")).toHaveCount(0);
  await row.getByRole("button", { name: "展开分支" }).click();
  await active(page).locator(".knowledge-outline-log").filter({ hasText: ids.labels[1] }).click();
  await expect(active(page).locator(".record-editor-page")).toBeVisible();
});

test("drags deep and later branches, reorders siblings, rejects descendants and cancels without writes", async ({ page }) => {
  const ids = await prepare(page);
  await active(page).getByRole("button", { name: "导图", exact: true }).click();
  await expect(active(page).locator("[data-map-root]")).toBeVisible();
  await capture(page, "map-readable-start.png");
  await active(page).getByRole("button", { name: "查看全貌" }).click();
  await dragTo(page, node(page, ids.deep).locator(".knowledge-map-label"), node(page, ids.roots[3]));
  await expect.poll(() => position(page, ids.deep)).toMatchObject({ parentNodeId: ids.roots[3] });
  await active(page).getByRole("button", { name: "查看全貌" }).click();
  await dragTo(page, node(page, ids.roots[2]).locator(".knowledge-map-label"), node(page, ids.roots[1]));
  await expect.poll(() => position(page, ids.roots[2])).toMatchObject({ parentNodeId: ids.roots[1] });
  await active(page).getByRole("button", { name: "查看全貌" }).click();
  await dragTo(page, node(page, ids.second).locator(".knowledge-map-label"), node(page, ids.first), .12);
  const siblingOrder = await page.evaluate(async parentId => {
    const { knowledgeRepository: repository } = await import("/src/features/knowledgeLibrary/runtime.ts");
    const { knowledgeChildren } = await import("/src/features/knowledgeLibrary/query.ts");
    const opened = await repository.open("map-ux"); return knowledgeChildren(opened.state, opened.state.entities[parentId].workspaceId, parentId).map(entity => entity.id);
  }, ids.roots[0]);
  expect(siblingOrder.slice(0, 2)).toEqual([ids.second, ids.first]);
  const before = await position(page, ids.roots[0]);
  await dragTo(page, node(page, ids.roots[0]).locator(".knowledge-map-label"), node(page, ids.first));
  expect(await position(page, ids.roots[0])).toEqual(before);
  const bounds = (await node(page, ids.first).boundingBox())!;
  await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2); await page.mouse.down(); await page.mouse.move(bounds.x + 20, bounds.y - 50, { steps: 8 });
  await expect(active(page).locator(".knowledge-map-ghost")).toBeVisible();
  await page.keyboard.press("Escape"); await page.mouse.up();
  await expect(active(page).locator(".knowledge-map-ghost")).toHaveCount(0);
  expect(await position(page, ids.roots[0])).toEqual(before);
});

test("touch long press moves a deep node and swipe does not mutate structure", async ({ page }, info) => {
  test.skip(info.project.name !== "android-narrow", "Touch gesture acceptance uses the narrow touch context");
  const ids = await prepare(page);
  await active(page).getByRole("button", { name: "导图", exact: true }).click();
  await expect(active(page).locator("[data-map-root]")).toBeVisible();
  await capture(page, "map-readable-start.png");
  await active(page).getByRole("button", { name: "查看全貌" }).click();
  const cdp = await page.context().newCDPSession(page);
  const source = (await node(page, ids.deep).boundingBox())!; const target = (await node(page, ids.roots[3]).boundingBox())!;
  const start = { x: source.x + source.width / 2, y: source.y + source.height / 2 };
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [start] });
  await page.waitForTimeout(420);
  await expect(active(page).locator(".knowledge-map-ghost")).toBeVisible();
  await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: target.x + target.width / 2, y: target.y + target.height / 2 }] });
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  await expect.poll(() => position(page, ids.deep)).toMatchObject({ parentNodeId: ids.roots[3] });
  const count = await page.evaluate(async () => (await import("/src/db/database.ts")).db.knowledgeCommands.count());
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: 60, y: 150 }] });
  await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: 100, y: 200 }] });
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  expect(await page.evaluate(async () => (await import("/src/db/database.ts")).db.knowledgeCommands.count())).toBe(count);
  await cdp.detach();
});


test("map colors and compact controls stay readable across themes", async ({ page }) => {
  const ids = await prepare(page);
  await active(page).getByRole("button", { name: "导图", exact: true }).click();
  for (const visual of ["reading", "modern"]) for (const theme of ["light", "dark"]) {
    await page.evaluate(({ visual, theme }) => { document.documentElement.dataset.visualTheme = visual; document.documentElement.dataset.theme = theme; }, { visual, theme });
    await active(page).getByRole("button", { name: "查看全貌" }).click();
    const geometry = await active(page).locator(".knowledge-workspace").evaluate(element => ({ width: document.documentElement.scrollWidth, viewport: innerWidth, height: element.getBoundingClientRect().height }));
    expect(geometry.width).toBeLessThanOrEqual(geometry.viewport); expect(geometry.height).toBeGreaterThan(450);
    await capture(page, "map-" + visual + "-" + theme + ".png");
    await node(page, ids.first).locator(".knowledge-map-label").click();
    await expect(active(page).getByRole("complementary", { name: "节点详情" })).toBeVisible();
    await capture(page, "details-" + visual + "-" + theme + ".png");
    await active(page).getByRole("button", { name: "关闭节点详情" }).click();
  }
});
