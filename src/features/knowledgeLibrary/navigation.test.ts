import { expect, it } from "vitest";
import { initialKnowledgeNavigation, patchKnowledgeNavigation, knowledgeOutlineScroll, restoreKnowledgeNavigation } from "./navigation";
it("resets position on topic/library change and ignores outgoing scroll callbacks", () => {
  const initial = { ...initialKnowledgeNavigation(), libraryId: "library", workspaceId: "A" };
  const scrolled = patchKnowledgeNavigation(initial, { scrollTop: 1200, scrollLibraryId: "library", scrollWorkspaceId: "A" });
  expect(knowledgeOutlineScroll(scrolled, "library", "A")).toBe(1200);
  const next = patchKnowledgeNavigation(scrolled, { workspaceId: "B" });
  expect(next.scrollTop).toBe(0);
  expect(patchKnowledgeNavigation(next, { scrollTop: 1200, scrollLibraryId: "library", scrollWorkspaceId: "A" })).toBe(next);
  expect(patchKnowledgeNavigation(scrolled, { libraryId: "other" }).scrollTop).toBe(0);
});
it("restores matching history position and resets old unowned history", () => {
  expect(knowledgeOutlineScroll(restoreKnowledgeNavigation({ libraryId: "library", workspaceId: "A", scrollTop: 100 }), "library", "A")).toBe(0);
  const restored = restoreKnowledgeNavigation({ libraryId: "library", workspaceId: "A", scrollTop: 100, scrollLibraryId: "library", scrollWorkspaceId: "A" });
  expect(knowledgeOutlineScroll(restored, "library", "A")).toBe(100);
});
