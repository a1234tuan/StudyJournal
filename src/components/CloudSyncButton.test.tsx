import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cloudSyncStore } from "../services/cloudSyncStore";
const mocks = vi.hoisted(() => ({ journal: vi.fn(), knowledge: vi.fn(), user: { uid: "owner" } as { uid: string } | null }));
vi.mock("../services/cloudSyncService", () => ({ getCurrentCloudUser: () => mocks.user, synchronizeCloudChanges: mocks.journal }));
vi.mock("../features/knowledgeLibrary/runtime", () => ({ synchronizeBoundKnowledge: mocks.knowledge }));
import { CloudSyncButton } from "./CloudSyncButton";
beforeEach(() => {
  vi.clearAllMocks(); mocks.user = { uid: "owner" };
  mocks.journal.mockResolvedValue({ kind: "synced", uploaded: 0, downloaded: 0, pending: 0 });
  mocks.knowledge.mockResolvedValue({ status: "no-change", uploaded: 0, downloaded: 0, pending: 0, conflicts: 0, message: "知识库：没有新变化。" });
});
afterEach(() => { cleanup(); cloudSyncStore.setBusy(null); cloudSyncStore.setConflict(undefined); cloudSyncStore.dismissOutcome(); });
describe("one-click combined sync", () => {
  it("does not show success when only knowledge sync is denied", async () => {
    mocks.knowledge.mockResolvedValue({ status: "error", message: "知识库：云端权限配置有误，本机内容保留。", error: { category: "permission-denied" } });
    render(<CloudSyncButton onSignedOut={vi.fn()} onRestored={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "云同步" }));
    await waitFor(() => expect(cloudSyncStore.getSnapshot().busy).toBeNull());
    expect(cloudSyncStore.getSnapshot().outcome).toMatchObject({ status: "error", message: expect.stringContaining("知识库：云端权限") });
  });
  it("runs journals first and does not upload knowledge before a journal conflict is resolved", async () => {
    mocks.journal.mockResolvedValue({ kind: "conflict", conflict: { reason: "concurrent-changes", localChanges: 1, remoteChanges: 1, cloudRevision: 1 } });
    render(<CloudSyncButton onSignedOut={vi.fn()} onRestored={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "云同步" }));
    await waitFor(() => expect(cloudSyncStore.getSnapshot().busy).toBeNull());
    expect(mocks.knowledge).not.toHaveBeenCalled();
    expect(cloudSyncStore.getSnapshot().message).toContain("知识库本次尚未同步");
  });
  it("reports actual knowledge changes even when journals have no changes", async () => {
    mocks.knowledge.mockResolvedValue({ status: "success", uploaded: 3, downloaded: 0, pending: 0, conflicts: 0, message: "知识库：上传 3 项更改。" });
    render(<CloudSyncButton onSignedOut={vi.fn()} onRestored={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "云同步" }));
    await waitFor(() => expect(cloudSyncStore.getSnapshot().busy).toBeNull());
    expect(cloudSyncStore.getSnapshot().outcome).toMatchObject({ status: "success", message: expect.stringContaining("上传 3 项更改") });
    expect(mocks.journal.mock.invocationCallOrder[0]).toBeLessThan(mocks.knowledge.mock.invocationCallOrder[0]);
  });
});
