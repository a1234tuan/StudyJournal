import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { cloudSyncStore } from "../services/cloudSyncStore";

const mocks = vi.hoisted(() => ({
  signInToCloudSync: vi.fn(),
}));

vi.mock("../services/cloudSyncService", () => ({
  cleanupCloudRecoverySnapshotsIfDue: vi.fn(),
  completeGoogleRedirect: vi.fn().mockResolvedValue(null),
  getCloudSyncStatus: vi.fn(),
  getCurrentCloudUser: vi.fn(() => null),
  listCloudRecoverySnapshots: vi.fn(),
  listenToCloudUser: vi.fn((listener: (user: null) => void) => {
    listener(null);
    return vi.fn();
  }),
  restoreCloudRecoverySnapshot: vi.fn(),
  signInToCloudSync: mocks.signInToCloudSync,
  signOutOfCloudSync: vi.fn(),
  synchronizeCloudChanges: vi.fn(),
}));

vi.mock("../services/firebaseStorageUsageService", () => ({
  getFirebaseStorageUsage: vi.fn(),
}));

import { CloudSyncPanel } from "./CloudSyncPanel";

describe("CloudSyncPanel Google sign-in", () => {
  afterEach(() => {
    cleanup();
    mocks.signInToCloudSync.mockReset();
    cloudSyncStore.setBusy(null);
    cloudSyncStore.setMessage("");
    cloudSyncStore.setConflict(undefined);
    cloudSyncStore.dismissOutcome();
  });

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
