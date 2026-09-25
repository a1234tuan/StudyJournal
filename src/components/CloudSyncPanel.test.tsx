import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi, type MockInstance } from "vitest";

import { CloudSnapshotIntegrityError } from "../services/cloudSnapshotIntegrity";
import { cloudSyncStore } from "../services/cloudSyncStore";

const mocks = vi.hoisted(() => ({
  signInToCloudSync: vi.fn(),
  currentUser: null as { uid: string; email: string } | null,
  snapshots: [] as any[],
  restore: vi.fn(async () => undefined),
}));

const status = {
  protocolVersion: 2,
  cloudRevision: 4,
  localPending: 0,
  remotePending: 0,
  snapshotCount: 1,
  legacySnapshotAvailable: false,
  storageBytes: 0,
  storageObjectCount: 0,
  storageKnown: false,
};

vi.mock("../services/cloudSyncService", () => ({
  cleanupCloudRecoverySnapshotsIfDue: vi.fn(),
  completeGoogleRedirect: vi.fn().mockResolvedValue(null),
  getCloudSyncStatus: vi.fn(async () => structuredClone(status)),
  getCurrentCloudUser: vi.fn(() => mocks.currentUser),
  listCloudRecoverySnapshots: vi.fn(async () => structuredClone(mocks.snapshots)),
  listenToCloudUser: vi.fn((listener: (user: unknown) => void) => {
    listener(mocks.currentUser);
    return vi.fn();
  }),
  restoreCloudRecoverySnapshot: mocks.restore,
  signInToCloudSync: mocks.signInToCloudSync,
  signOutOfCloudSync: vi.fn(),
  synchronizeCloudChanges: vi.fn(),
}));

vi.mock("../services/firebaseStorageUsageService", () => ({
  getFirebaseStorageUsage: vi.fn(),
}));

import { CloudSyncPanel } from "./CloudSyncPanel";

let confirmSpy: MockInstance<(message?: string) => boolean> | undefined;

const stubConfirm = (accepted: boolean) => {
  const spy = vi.spyOn(window, "confirm").mockReturnValue(accepted);
  confirmSpy = spy;
  return spy;
};

const snapshot = (id: string, snapshotStatus: string, label = id) => ({
  id,
  createdAt: "2026-09-23T00:00:00.000Z",
  label,
  entityCount: 12,
  revision: 3,
  status: snapshotStatus,
});

describe("CloudSyncPanel Google sign-in", () => {
  it("explains one-click knowledge sync without source selection or misleading combined counts", async () => {
    mocks.currentUser = { uid: "user", email: "user@example.com" };
    render(<CloudSyncPanel onRestored={vi.fn()} />);
    expect(screen.getByText(/将已保存的日志和知识库同步到当前账号/)).toBeInTheDocument();
    expect(screen.queryByText("知识库同步范围", { exact: true })).toBeNull();
    expect(screen.queryByLabelText("复制来源知识库")).toBeNull();
    expect(await screen.findByText("普通日志：本机待同步 0 项 / 云端待拉取 0 项")).toBeInTheDocument();
    expect(screen.getByText(/知识库会一起同步/)).toBeInTheDocument();
  });
  afterEach(resetAll);

  it("shows cancellation and network causes while keeping the sign-in button retryable", async () => {
    mocks.signInToCloudSync
      .mockRejectedValueOnce(new Error("GetCredentialCancellationException: activity cancelled"))
      .mockRejectedValueOnce(new Error("Unable to resolve host accounts.google.com"));
    render(<CloudSyncPanel onRestored={vi.fn()} />);

    const button = screen.getByRole("button", { name: "使用 Google 登录" });
    fireEvent.click(button);
    expect(await screen.findByRole("status")).toHaveTextContent("Google 登录已取消。你可以再次点击「使用 Google 登录」重试。");
    await waitFor(() => expect(button).toBeEnabled());

    fireEvent.click(button);
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent(
      "Google 登录无法连接 Google 或 Firebase。请确认系统代理或 VPN 已接管本应用流量，然后重试。",
    ));
    await waitFor(() => expect(button).toBeEnabled());
    expect(mocks.signInToCloudSync).toHaveBeenCalledTimes(2);
  });
});

describe("CloudSyncPanel recovery point status", () => {
  afterEach(resetAll);

  it("offers a restore action only for usable recovery points and explains why the others cannot be used", async () => {
    mocks.currentUser = { uid: "cloud-user", email: "user@example.com" };
    mocks.snapshots = [snapshot("writing-1", "writing", "半成品"), snapshot("orphaned", "unverifiable", "无法证明"), snapshot("grouped", "complete")];
    render(<CloudSyncPanel onRestored={vi.fn()} />);

    const broken = await screen.findByRole("button", { name: /半成品/ });
    expect(broken).toBeDisabled();
    expect(broken).toHaveTextContent("不可恢复：写入未完成");
    const unprovable = screen.getByRole("button", { name: /无法证明/ });
    expect(unprovable).toBeDisabled();
    expect(unprovable).toHaveTextContent("不可恢复：无法证明完整，不可恢复");
    const usable = screen.getByRole("button", { name: /grouped/ });
    expect(usable).toBeEnabled();

    fireEvent.click(broken);
    fireEvent.click(unprovable);
    expect(mocks.restore).not.toHaveBeenCalled();
  });

  it("routes a usable recovery point through the restore action and states that knowledge libraries are not included", async () => {
    mocks.currentUser = { uid: "cloud-user", email: "user@example.com" };
    mocks.snapshots = [snapshot("legacy-1", "legacy-unverified", "旧版恢复点")];
    const confirm = stubConfirm(true);
    render(<CloudSyncPanel onRestored={vi.fn()} />);

    const row = await screen.findByRole("button", { name: /旧版恢复点/ });
    fireEvent.click(row);
    await waitFor(() => expect(mocks.restore).toHaveBeenCalledTimes(1));
    expect(confirm.mock.calls[0][0]).toContain("不包含知识库");
    expect(screen.getByText(/这里的恢复只覆盖普通云同步数据，不包含知识库。/)).toBeInTheDocument();
  });

  it("shows the actionable integrity reason verbatim instead of the generic cloud-sync message", async () => {
    mocks.currentUser = { uid: "cloud-user", email: "user@example.com" };
    mocks.snapshots = [snapshot("broken-1", "complete", "损坏恢复点")];
    mocks.restore.mockRejectedValueOnce(new CloudSnapshotIntegrityError("云端恢复快照不完整：记录应有 9 项，实际读取到 3 项。请选择其他恢复点。"));
    stubConfirm(true);
    render(<CloudSyncPanel onRestored={vi.fn()} />);

    fireEvent.click(await screen.findByRole("button", { name: /损坏恢复点/ }));
    expect(await screen.findByRole("status")).toHaveTextContent("云端恢复快照不完整：记录应有 9 项，实际读取到 3 项。请选择其他恢复点。");
  });
});

function resetAll() {
  cleanup();
  confirmSpy?.mockRestore();
  confirmSpy = undefined;
  mocks.signInToCloudSync.mockReset();
  mocks.restore.mockReset();
  mocks.restore.mockResolvedValue(undefined);
  mocks.currentUser = null;
  mocks.snapshots = [];
  cloudSyncStore.setBusy(null);
  cloudSyncStore.setMessage("");
  cloudSyncStore.setConflict(undefined);
  cloudSyncStore.dismissOutcome();
}
