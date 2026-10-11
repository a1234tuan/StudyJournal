import { expect, test, type Page } from "@playwright/test";

const active = (page: Page) => page.locator('.page-transition-layer:not([aria-hidden="true"])').last();
const enter = async (page: Page) => {
  await page.getByRole("button", { name: "更多", exact: true }).last().click();
  await active(page).getByRole("button", { name: "知识库", exact: true }).click();
};
const seed = async (page: Page) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "今天", exact: true })).toBeVisible();
  return page.evaluate(async () => {
    const { knowledgeRepository: repository } = await import("/src/features/knowledgeLibrary/runtime.ts");
    const { createKnowledgeEntity } = await import("/src/features/knowledgeLibrary/commands.ts");
    await repository.createLibrary("专题记忆", "resume-library");
    const opened = await repository.open("resume-library");
    const ids: string[] = [];
    for (const title of ["专题甲", "专题乙"]) {
      const command = createKnowledgeEntity("resume-library", "workspace", title);
      await repository.execute(opened.context, command); ids.push(command.entity.id);
      await repository.execute(opened.context, createKnowledgeEntity("resume-library", "node", title + "节点", command.entity.id));
    }
    return ids;
  });
};

test("opens maps by default and resumes the last topic after a fresh page without trapping back navigation", async ({ page, context }) => {
  const ids = await seed(page);
  await enter(page);
  await active(page).getByRole("button", { name: /专题甲/ }).click();
  await expect(active(page).getByRole("button", { name: "导图", exact: true })).toHaveAttribute("aria-pressed", "true");
  await expect(active(page).locator("[data-map-root]")).toBeVisible();
  await active(page).getByRole("button", { name: "返回", exact: true }).click();
  await expect(active(page).locator(".knowledge-topics")).toBeVisible();
  await active(page).getByRole("button", { name: /专题乙/ }).click();
  await active(page).getByRole("button", { name: "大纲", exact: true }).click();
  await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem("study-journal-knowledge-last-topic:deviceGuest") ?? "null")?.workspaceId)).toBe(ids[1]);
  const next = await context.newPage(); await page.close();
  await next.goto("/"); await expect(next.getByRole("heading", { name: "今天", exact: true })).toBeVisible();
  await enter(next);
  await expect(active(next).getByRole("heading", { name: "专题乙", exact: true })).toBeVisible();
  await expect(active(next).getByRole("button", { name: "导图", exact: true })).toHaveAttribute("aria-pressed", "true");
  await expect(active(next).locator("[data-map-root]")).toBeVisible();
  await active(next).getByRole("button", { name: "返回", exact: true }).click();
  await expect(active(next).locator(".knowledge-topics")).toBeVisible();
  await active(next).getByRole("button", { name: /专题甲/ }).click();
  await expect(active(next).getByRole("heading", { name: "专题甲", exact: true })).toBeVisible();
});

for (const reason of ["archived", "missing", "other-owner"] as const) {
  test("safely falls back from a remembered topic: " + reason, async ({ page }) => {
    const ids = await seed(page);
    await page.evaluate(async ({ reason, id }) => {
      const { rememberKnowledgeTopic } = await import("/src/features/knowledgeLibrary/navigation.ts");
      rememberKnowledgeTopic(reason === "other-owner" ? "account:someone-else" : "deviceGuest", "resume-library", reason === "missing" ? "missing-topic" : id);
      if (reason === "archived") {
        const { knowledgeRepository: repository } = await import("/src/features/knowledgeLibrary/runtime.ts");
        const { editKnowledgeEntity } = await import("/src/features/knowledgeLibrary/commands.ts");
        const opened = await repository.open("resume-library");
        await repository.execute(opened.context, editKnowledgeEntity("resume-library", opened.state, opened.state.entities[id], "archived", true));
      }
    }, { reason, id: ids[1] });
    await enter(page);
    await expect(active(page).locator(".knowledge-topics")).toBeVisible();
    await active(page).getByRole("button", { name: /专题甲/ }).click();
    await expect(active(page).locator("[data-map-root]")).toBeVisible();
  });
}
