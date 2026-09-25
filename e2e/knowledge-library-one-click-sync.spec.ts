import { expect, test } from "@playwright/test";

test.setTimeout(60000);
const active = (page: import("@playwright/test").Page) => page.locator('.page-transition-layer:not([aria-hidden="true"])').last();

test("automatically redirects an open local topic to its synchronized copy and keeps old drafts in recovery", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "今天想记下什么？" })).toBeVisible();
  await page.evaluate(async () => {
    const { changeKnowledgeOwner } = await import("/src/features/knowledgeLibrary/context.ts");
    const { knowledgeRepository: repository } = await import("/src/features/knowledgeLibrary/runtime.ts");
    const { createKnowledgeEntity } = await import("/src/features/knowledgeLibrary/commands.ts");
    const { firebaseAuth } = await import("/src/services/firebase.ts");
    await firebaseAuth.authStateReady();
    changeKnowledgeOwner("account:isolated-e2e"); window.dispatchEvent(new Event("knowledge-owner-changed"));
    await repository.createLibrary("电脑本机内容", "desktop-local");
    const opened = await repository.open("desktop-local");
    const topic = createKnowledgeEntity("desktop-local", "workspace", "自动同步专题");
    await repository.execute(opened.context, topic);
    const node = createKnowledgeEntity("desktop-local", "node", "原本机节点", topic.entity.id);
    await repository.execute(opened.context, node);
    const state = (await repository.open("desktop-local")).state;
    await repository.saveDraft(opened.context, { ...opened.context, id: node.entity.id + ":note", entityId: node.entity.id, unit: "note", text: "未上传草稿原文", expectedRevision: state.entities[node.entity.id].units.note! });
  });
  await page.getByRole("button", { name: "更多", exact: true }).last().click();
  await active(page).getByRole("button", { name: "知识库", exact: true }).click();
  await active(page).getByRole("button", { name: "自动同步专题", exact: true }).click();
  await expect(active(page).getByRole("heading", { name: "自动同步专题", exact: true })).toBeVisible();
  const result = await page.evaluate(async () => {
    const { knowledgeRepository: repository } = await import("/src/features/knowledgeLibrary/runtime.ts");
    const { KnowledgeSync } = await import("/src/features/knowledgeLibrary/sync.ts");
    const { synchronizeKnowledge } = await import("/src/features/knowledgeLibrary/oneClickSync.ts");
    const { registerDefaultLibrary } = await import("/src/features/knowledgeLibrary/scope.ts");
    const packets: any[] = []; let registry: any = null;
    const transport = {
      discover: async () => registry,
      register: async (id: string, request: string) => registry ??= registerDefaultLibrary(null, id, request),
      head: async () => packets.length,
      commits: async (_id: string, after: number, through: number) => structuredClone(packets.slice(after, through)),
      receipt: async (_id: string, command: string) => packets.find(packet => packet.receipt.commandId === command)?.receipt ?? null,
      publish: async (_id: string, _head: number, packet: any) => { packets.push(structuredClone(packet)); return packet.receipt; },
    };
    return synchronizeKnowledge(new KnowledgeSync(repository, transport));
  });
  expect(result, JSON.stringify(result)).toMatchObject({ status: "success" });
  await expect(active(page).getByRole("heading", { name: "自动同步专题", exact: true })).toBeVisible();
  await expect(active(page).getByRole("button", { name: "原本机节点", exact: true })).toBeVisible();
  await active(page).getByRole("button", { name: "添加节点", exact: true }).first().click();
  await active(page).getByRole("textbox", { name: "新建节点", exact: true }).fill("后续编辑进入同步库");
  await active(page).getByRole("button", { name: "保存节点", exact: true }).click();
  expect(await page.evaluate(async () => {
    const { db } = await import("/src/db/database.ts");
    const binding = await db.knowledgeSyncBindings.get("account:isolated-e2e");
    const source = await db.knowledgeNodes.where("libraryId").equals("desktop-local").count();
    const target = await db.knowledgeNodes.where("libraryId").equals(binding!.localLibraryId!).count();
    return { source, target };
  })).toEqual({ source: 1, target: 2 });
  await active(page).getByRole("button", { name: "返回", exact: true }).click();
  await active(page).getByRole("button", { name: /当前库：/ }).click();
  await expect(page.getByRole("dialog").locator(".knowledge-library-list button")).toHaveCount(1);
  await page.getByText(/恢复管理 ·/).click();
  await page.getByText("未提交草稿", { exact: true }).click();
  await expect(page.getByRole("textbox", { name: "保留的草稿" })).toHaveValue("未上传草稿原文");
  await expect(page.getByLabel("复制来源知识库")).toHaveCount(0);
  await page.screenshot({ path: test.info().outputPath("one-click-recovery.png"), animations: "disabled" });
});
