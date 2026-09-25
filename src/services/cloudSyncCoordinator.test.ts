import { beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ knowledge: vi.fn() }));
vi.mock("../features/knowledgeLibrary/runtime", () => ({ synchronizeBoundKnowledge: mocks.knowledge }));
import { completeCloudSync } from "./cloudSyncCoordinator";
beforeEach(() => { vi.clearAllMocks(); });
it.each(["pending", "needs-attention", "skipped"])("does not show success for knowledge status %s", async status => {
  mocks.knowledge.mockResolvedValue({ status, message: "知识库尚未完成" });
  expect(await completeCloudSync({ uploaded: 1, downloaded: 0 }, {})).toMatchObject({ status: "uncertain", message: expect.stringContaining("知识库尚未完成") });
});
it("does not start knowledge after its operation expired", async () => {
  expect(await completeCloudSync({ uploaded: 0, downloaded: 0 }, { isCurrent: () => false })).toBeUndefined();
  expect(mocks.knowledge).not.toHaveBeenCalled();
});
it("does not surface a late result after the operation expired", async () => {
  let active = true;
  mocks.knowledge.mockImplementation(async () => { active = false; return { status: "success", message: "知识成功" }; });
  expect(await completeCloudSync({ uploaded: 1, downloaded: 0 }, { isCurrent: () => active })).toBeUndefined();
});
it("preserves journal success when the knowledge module throws unexpectedly", async () => {
  mocks.knowledge.mockRejectedValue({ code: "permission-denied" });
  expect(await completeCloudSync({ uploaded: 2, downloaded: 0 }, {})).toMatchObject({ status: "error", message: expect.stringContaining("普通日志：上传 2 项") });
});
it("reports pending journals even if knowledge completes", async () => {
  mocks.knowledge.mockResolvedValue({ status: "no-change", message: "知识无更改" });
  expect(await completeCloudSync({ uploaded: 0, downloaded: 0, pending: 1 }, {})).toMatchObject({ status: "uncertain", message: expect.stringContaining("普通日志仍有 1 项") });
});
