import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ user: { currentUser: { uid: "A" } as { uid: string } | null }, owner: "account:A", synchronize: vi.fn() }));
vi.mock("../../services/firebase", () => ({ firebaseAuth: mocks.user, firestore: {} }));
vi.mock("../../services/autoBackupService", () => ({ markAutoBackupDirty: vi.fn() }));
vi.mock("./context", () => ({ currentKnowledgeOwner: () => mocks.owner, knowledgeContextGeneration: () => 0, changeKnowledgeOwner: vi.fn() }));
vi.mock("./firestoreTransport", () => ({ createKnowledgeTransport: () => ({}) }));
vi.mock("./oneClickSync", () => ({ synchronizeKnowledge: mocks.synchronize }));
import { synchronizeBoundKnowledge } from "./runtime";
beforeEach(() => {
  vi.clearAllMocks(); mocks.user.currentUser = { uid: "A" }; mocks.owner = "account:A";
  mocks.synchronize.mockResolvedValue({ status: "success", uploaded: 3, pending: 0, message: "知识库：同步完成。" });
});
describe("global knowledge sync entry", () => {
  it("delegates automatic adoption and forwards operation guards and progress", async () => {
    const options = { isCurrent: () => true, onProgress: vi.fn() };
    expect(await synchronizeBoundKnowledge(options)).toMatchObject({ status: "success", uploaded: 3 });
    expect(mocks.synchronize).toHaveBeenCalledWith(expect.anything(), options);
  });
  it.each(["deviceGuest", "account:B"])("does not synchronize across a stale owner: %s", async owner => {
    mocks.owner = owner;
    expect(await synchronizeBoundKnowledge()).toMatchObject({ status: "skipped" });
    expect(mocks.synchronize).not.toHaveBeenCalled();
  });
  it("requires an authenticated app session", async () => {
    mocks.user.currentUser = null;
    expect(await synchronizeBoundKnowledge()).toMatchObject({ status: "skipped", message: expect.stringContaining("尚未登录") });
    expect(mocks.synchronize).not.toHaveBeenCalled();
  });
});
