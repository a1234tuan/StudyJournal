import { afterEach, expect, it, vi } from "vitest";
import { initialKnowledgeNavigation, loadKnowledgeNavigation, rememberKnowledgeTopic, patchKnowledgeNavigation, knowledgeOutlineScroll, restoreKnowledgeNavigation } from "./navigation";
it("resets position on topic/library change and ignores outgoing scroll callbacks", () => {
  const initial = { ...initialKnowledgeNavigation(), libraryId: "library", workspaceId: "A" };
  const scrolled = patchKnowledgeNavigation(initial, { scrollTop: 1200, scrollLibraryId: "library", scrollWorkspaceId: "A" });
  expect(knowledgeOutlineScroll(scrolled, "library", "A")).toBe(1200);
  const next = patchKnowledgeNavigation(scrolled, { workspaceId: "B" });
  expect(next.scrollTop).toBe(0);
  expect(patchKnowledgeNavigation(next, { scrollTop: 1200, scrollLibraryId: "library", scrollWorkspaceId: "A" })).toBe(next);
  expect(patchKnowledgeNavigation(scrolled, { libraryId: "other" }).scrollTop).toBe(0);
});
it("preserves automatic pane sizing and an explicit saved width", () => {
  expect(restoreKnowledgeNavigation({}).recordPaneWidth).toBeUndefined();
  expect(restoreKnowledgeNavigation({ recordPaneWidth: 520 }).recordPaneWidth).toBe(520);
  expect(restoreKnowledgeNavigation({ recordPaneWidth: 900 }).recordPaneWidth).toBe(560);
});
it("restores matching history position and resets old unowned history", () => {
  expect(knowledgeOutlineScroll(restoreKnowledgeNavigation({ libraryId: "library", workspaceId: "A", scrollTop: 100 }), "library", "A")).toBe(0);
  const restored = restoreKnowledgeNavigation({ libraryId: "library", workspaceId: "A", scrollTop: 100, scrollLibraryId: "library", scrollWorkspaceId: "A" });
  expect(knowledgeOutlineScroll(restored, "library", "A")).toBe(100);
});


afterEach(() => { localStorage.clear(); vi.restoreAllMocks(); });
it("defaults fresh and unspecified navigation to map but preserves explicit outline history", () => {
  expect(initialKnowledgeNavigation().view).toBe("map");
  expect(restoreKnowledgeNavigation({}).view).toBe("map");
  expect(restoreKnowledgeNavigation({ view: "outline" }).view).toBe("outline");
  expect(loadKnowledgeNavigation("deviceGuest")).toEqual(initialKnowledgeNavigation());
});
it("resumes only the most recently opened topic in map without transient state", () => {
  rememberKnowledgeTopic("deviceGuest", "library", "first");
  rememberKnowledgeTopic("deviceGuest", "library", "last");
  expect(loadKnowledgeNavigation("deviceGuest")).toEqual({ ...initialKnowledgeNavigation(), libraryId: "library", workspaceId: "last" });
});
it("isolates guest and account topic memories", () => {
  rememberKnowledgeTopic("deviceGuest", "guest", "topic-guest");
  rememberKnowledgeTopic("account:one", "one", "topic-one");
  expect(loadKnowledgeNavigation("deviceGuest").libraryId).toBe("guest");
  expect(loadKnowledgeNavigation("account:one").libraryId).toBe("one");
  expect(loadKnowledgeNavigation("account:two")).toEqual(initialKnowledgeNavigation());
});
it.each(["broken-json", "null", '{"version":2,"libraryId":"lib","workspaceId":"topic"}', '{"version":1,"libraryId":"lib","workspaceId":""}', '{"version":1,"libraryId":7,"workspaceId":"topic"}'])("ignores invalid persisted topic: %s", value => {
  vi.spyOn(Storage.prototype, "getItem").mockReturnValue(value);
  expect(loadKnowledgeNavigation("deviceGuest")).toEqual(initialKnowledgeNavigation());
});
it("keeps navigation usable when local storage is unavailable", () => {
  vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw new Error("unavailable"); });
  vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("unavailable"); });
  expect(() => rememberKnowledgeTopic("deviceGuest", "library", "topic")).not.toThrow();
  expect(loadKnowledgeNavigation("deviceGuest")).toEqual(initialKnowledgeNavigation());
});
