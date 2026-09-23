import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  user: { currentUser: { uid: "A" } as { uid: string } | null },
  owner: "account:A", libraries: [] as Array<{ id: string; cloudLibraryId: string | null }>,
  connect: vi.fn(), synchronize: vi.fn(), open: vi.fn(), offlineCount: vi.fn(),
}));
vi.mock("../../services/firebase", () => ({ firebaseAuth: mocks.user, firestore: {} }));
vi.mock("../../services/autoBackupService", () => ({ markAutoBackupDirty: vi.fn() }));
vi.mock("./context", () => ({ currentKnowledgeOwner: () => mocks.owner, knowledgeContextGeneration: () => 0, changeKnowledgeOwner: vi.fn() }));
vi.mock("./firestoreTransport", () => ({ createKnowledgeTransport: () => ({}) }));
vi.mock("./repository", () => ({ KnowledgeRepository: class { listLibraries() { return Promise.resolve(mocks.libraries); } open = mocks.open; } }));
vi.mock("./sync", () => ({ KnowledgeSync: class { connect = mocks.connect; synchronize = mocks.synchronize; } }));
vi.mock("../../db/database", () => ({ db: { knowledgeLibraries: { where: () => ({ anyOf: () => ({ filter: () => ({ count: mocks.offlineCount }) }) }) } } }));
import { synchronizeBoundKnowledge } from "./runtime";
beforeEach(() => {
  vi.clearAllMocks(); mocks.user.currentUser = { uid: "A" }; mocks.owner = "account:A"; mocks.libraries = [];
  mocks.connect.mockResolvedValue({ library: { id: "default", cloudLibraryId: "cloud" } });
  mocks.open.mockImplementation(async libraryId => ({ context: { libraryId } }));
  mocks.synchronize.mockResolvedValue({ pending: 0, uploaded: 0 }); mocks.offlineCount.mockResolvedValue(0);
});
describe("global knowledge sync entry", () => {
  it("connects the default account library on first global sync without uploading independent libraries", async () => {
    mocks.libraries = [{ id: "offline", cloudLibraryId: null }]; mocks.offlineCount.mockResolvedValue(1);
    expect(await synchronizeBoundKnowledge()).toContain("本机独立库未上传");
    expect(mocks.connect).toHaveBeenCalledWith();
    expect(mocks.open).toHaveBeenCalledWith("default");
    expect(mocks.open).not.toHaveBeenCalledWith("offline");
    expect(mocks.synchronize).toHaveBeenCalledTimes(1);
  });
  it("reuses the existing bound library and reports pending changes", async () => {
    mocks.libraries = [{ id: "bound", cloudLibraryId: "cloud" }]; mocks.synchronize.mockResolvedValue({ pending: 2 });
    expect(await synchronizeBoundKnowledge()).toContain("2 项待同步");
    expect(mocks.connect).not.toHaveBeenCalled();
    expect(mocks.synchronize).toHaveBeenCalledWith({ libraryId: "bound" });
  });
  it("does not connect as a guest or cross a stale account context", async () => {
    mocks.owner = "deviceGuest";
    expect(await synchronizeBoundKnowledge()).toContain("尚未登录");
    expect(mocks.connect).not.toHaveBeenCalled();
  });
  it("reports discovery failure without blocking the ordinary journal sync caller", async () => {
    mocks.connect.mockRejectedValueOnce(new Error("unavailable"));
    expect(await synchronizeBoundKnowledge()).toContain("同步未完成，本机内容保留");
    expect(mocks.synchronize).not.toHaveBeenCalled();
  });
  it("explains permission failure rather than presenting only an opaque diagnostic code", async () => {
    mocks.connect.mockRejectedValueOnce({ code: "permission-denied" });
    expect(await synchronizeBoundKnowledge()).toContain("反复重试不会解决权限问题");
  });
});
