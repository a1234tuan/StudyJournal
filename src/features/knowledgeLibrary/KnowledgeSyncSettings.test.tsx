import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  owner: "account:A", connect: vi.fn(), open: vi.fn(), assertContext: vi.fn(), listImportSessions: vi.fn(), prepare: vi.fn(), resume: vi.fn(), scopes: vi.fn(), sessions: vi.fn(),
}));
vi.mock("dexie", () => ({ liveQuery: (query: () => Promise<unknown>) => ({ subscribe: ({ next }: { next: (value: unknown) => void }) => { let cancelled = false; void query().then(value => { if (!cancelled) next(value); }); return { unsubscribe: () => { cancelled = true; } }; } }) }));
vi.mock("../../db/database", () => ({ db: { knowledgeLibraries: { where: () => ({ anyOf: mocks.scopes }) }, knowledgeImportSessions: { where: () => ({ equals: () => ({ toArray: mocks.sessions }) }) } } }));
vi.mock("./context", () => ({ currentKnowledgeOwner: () => mocks.owner }));
vi.mock("./runtime", () => ({ knowledgeRepository: { open: mocks.open, assertContext: mocks.assertContext, listImportSessions: mocks.listImportSessions }, knowledgeSynchronizer: () => ({ connect: mocks.connect }) }));
vi.mock("./import", () => ({ prepareKnowledgeImport: mocks.prepare, resumeKnowledgeImport: mocks.resume }));
import KnowledgeSyncSettings from "./KnowledgeSyncSettings";
beforeEach(() => {
  vi.clearAllMocks(); mocks.owner = "account:A";
  mocks.scopes.mockReturnValue({ toArray: async () => [{ id: "guest-library", title: "未登录资料", ownerScope: "deviceGuest", cloudLibraryId: null }] });
  mocks.connect.mockResolvedValue({ library: { id: "account-library" } });
  mocks.open.mockResolvedValue({ context: { libraryId: "account-library", ownerScope: "account:A", dataGeneration: 0 } });
  mocks.listImportSessions.mockResolvedValue([]); mocks.sessions.mockResolvedValue([]);
  mocks.prepare.mockResolvedValue(undefined); mocks.resume.mockResolvedValue(undefined);
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });
describe("knowledge controls inside existing cloud settings", () => {
  it("lists only current-account and guest sources and leaves copy opt-in", async () => {
    render(<KnowledgeSyncSettings uid="A" disabled={false} />);
    await screen.findByRole("option", { name: /未登录资料/ });
    expect(mocks.scopes).toHaveBeenCalledWith(["account:A", "deviceGuest"]);
    expect(mocks.connect).not.toHaveBeenCalled();
    expect(mocks.prepare).not.toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: "立即同步" })).toBeNull();
  });
  it("cancels without writing and then resumes the existing copy after explicit consent", async () => {
    mocks.listImportSessions.mockResolvedValue([{ id: "existing", sourceLibraryId: "guest-library", next: 1, total: 2, status: "active" }]);
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    render(<KnowledgeSyncSettings uid="A" disabled={false} />);
    fireEvent.change(await screen.findByLabelText("复制来源知识库"), { target: { value: "guest-library" } });
    fireEvent.click(screen.getByRole("button", { name: "复制 / 继续复制到账号库" }));
    expect(mocks.connect).not.toHaveBeenCalled();
    confirm.mockReturnValue(true);
    fireEvent.click(screen.getByRole("button", { name: "复制 / 继续复制到账号库" }));
    await waitFor(() => expect(mocks.prepare).toHaveBeenCalledWith(expect.anything(), "guest-library", expect.objectContaining({ ownerScope: "account:A" }), "existing"));
    expect(mocks.resume).toHaveBeenCalledWith(expect.anything(), expect.anything(), "existing");
    expect(await screen.findByRole("status")).toHaveTextContent("原本机库保持不变");
  });
  it("continues a saved copy even when its source library has been deleted", async () => {
    mocks.scopes.mockReturnValue({ toArray: async () => [{ id: "account-library", title: "账号库", ownerScope: "account:A", cloudLibraryId: "cloud" }] });
    mocks.sessions.mockResolvedValue([{ libraryId: "account-library", id: "saved", sourceLibraryId: "deleted-source", status: "active", next: 1, total: 3 }]);
    vi.spyOn(window, "confirm").mockReturnValue(true);
    render(<KnowledgeSyncSettings uid="A" disabled={false} />);
    fireEvent.click(await screen.findByRole("button", { name: "继续未完成复制" }));
    await waitFor(() => expect(mocks.resume).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ libraryId: "account-library" }), "saved"));
    expect(mocks.prepare).not.toHaveBeenCalled();
    expect(await screen.findByRole("status")).toHaveTextContent("未完成的复制已继续完成");
  });
  it("blocks copying when the account has changed", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(true);
    render(<KnowledgeSyncSettings uid="A" disabled={false} />);
    fireEvent.change(await screen.findByLabelText("复制来源知识库"), { target: { value: "guest-library" } });
    mocks.owner = "account:B";
    fireEvent.click(screen.getByRole("button", { name: "复制 / 继续复制到账号库" }));
    expect(await screen.findByRole("status")).toHaveTextContent("账号已变化");
    expect(mocks.connect).not.toHaveBeenCalled();
  });
});
