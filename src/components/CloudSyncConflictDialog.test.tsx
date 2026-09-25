import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { cloudSyncStore } from "../services/cloudSyncStore";

const mocks = vi.hoisted(() => ({
  resolveCloudSyncConflict: vi.fn(),
  synchronizeCloudChanges: vi.fn(),
}));

vi.mock("../services/cloudSyncService", () => ({
  getCurrentCloudUser: () => ({ uid: "user-1" }),
  resolveCloudSyncConflict: mocks.resolveCloudSyncConflict,
  synchronizeCloudChanges: mocks.synchronizeCloudChanges,
}));

vi.mock("../features/knowledgeLibrary/runtime", () => ({ synchronizeBoundKnowledge: vi.fn(async () => ({ status: "no-change", message: "知识库：没有新变化。" })) }));

import { CloudSyncConflictDialog } from "./CloudSyncConflictDialog";

const readEstimate = {
  mode: "full" as const,
  estimatedReads: 50_000,
  entityReads: 50_000,
  reviewEventReads: 0,
  targetedReads: 0,
  overheadReads: 0,
  storageObjectCount: 0,
  storageBytes: 0,
  storageKnown: true,
};

const writeEstimate = {
  estimatedWrites: 5_000,
  entityWrites: 5_000,
  reviewEventWrites: 0,
  overheadWrites: 0,
  storageObjectCount: 0,
  storageBytes: 0,
};

describe("CloudSyncConflictDialog budget approvals", () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
    cloudSyncStore.setBusy(null);
    cloudSyncStore.setConflict(undefined);
    cloudSyncStore.setReadBudget(undefined);
    cloudSyncStore.setReadBudgetChoice(undefined);
    cloudSyncStore.setWriteBudget(undefined);
    cloudSyncStore.setWriteBudgetChoice(undefined);
    cloudSyncStore.dismissOutcome();
  });

  it("requires separate confirmation for expensive reads and writes", async () => {
    mocks.resolveCloudSyncConflict
      .mockResolvedValueOnce({ kind: "write-budget", estimate: writeEstimate, message: "confirm write", choice: "local" })
      .mockResolvedValueOnce({ kind: "synced", uploaded: 5_000, downloaded: 0, revision: 2, pending: 0 });
    cloudSyncStore.setConflict({ reason: "concurrent-changes", localChanges: 1, remoteChanges: 1, cloudRevision: 1 });
    cloudSyncStore.setReadBudget(readEstimate);
    cloudSyncStore.setReadBudgetChoice("local");

    render(<CloudSyncConflictDialog onRestored={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "继续高成本以本机为准" }));

    await waitFor(() => expect(mocks.resolveCloudSyncConflict).toHaveBeenCalledTimes(1));
    expect(mocks.resolveCloudSyncConflict.mock.calls[0][2]).toMatchObject({
      allowExpensiveRead: true,
      allowExpensiveWrite: false,
    });
    expect(await screen.findByRole("button", { name: "继续高成本同步" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "继续高成本同步" }));

    await waitFor(() => expect(mocks.resolveCloudSyncConflict).toHaveBeenCalledTimes(2));
    expect(mocks.resolveCloudSyncConflict.mock.calls[1][2]).toMatchObject({
      allowExpensiveRead: true,
      allowExpensiveWrite: true,
    });
  });
});
