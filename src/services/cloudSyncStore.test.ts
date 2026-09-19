import { afterEach, describe, expect, it, vi } from "vitest";

import { AUTO_DISMISS_MS, CLOUD_SYNC_WATCHDOG_MS, cloudSyncStore } from "./cloudSyncStore";

describe("cloudSyncStore watchdog", () => {
  afterEach(() => {
    cloudSyncStore.setBusy(null);
    cloudSyncStore.setConflict(undefined);
    cloudSyncStore.dismissOutcome();
    vi.useRealTimers();
  });

  it("extends the timeout whenever the sync reports progress", () => {
    vi.useFakeTimers();
    cloudSyncStore.setBusy("sync");

    vi.advanceTimersByTime(CLOUD_SYNC_WATCHDOG_MS - 1);
    cloudSyncStore.setMessage("正在下载资源 3/10。");
    vi.advanceTimersByTime(CLOUD_SYNC_WATCHDOG_MS - 1);

    expect(cloudSyncStore.getSnapshot().busy).toBe("sync");

    vi.advanceTimersByTime(1);
    expect(cloudSyncStore.getSnapshot()).toMatchObject({
      busy: null,
      message: "同步结果未知，应用可能在后台中断，请点击同步核对上一次操作。",
    });
  });

  it("leaves a visible error outcome behind when the watchdog fires", () => {
    vi.useFakeTimers();
    cloudSyncStore.setBusy("sync");
    vi.advanceTimersByTime(CLOUD_SYNC_WATCHDOG_MS);

    expect(cloudSyncStore.getSnapshot().outcome).toMatchObject({
      status: "uncertain",
      message: "同步结果未知，应用可能在后台中断，请点击同步核对上一次操作。",
    });
  });

  it("closes an open conflict when the resolve operation becomes uncertain", () => {
    vi.useFakeTimers();
    cloudSyncStore.setConflict({
      reason: "concurrent-changes",
      localChanges: 1,
      remoteChanges: 1,
      cloudRevision: 4,
    });
    cloudSyncStore.setBusy("resolve");

    vi.advanceTimersByTime(CLOUD_SYNC_WATCHDOG_MS);

    expect(cloudSyncStore.getSnapshot()).toMatchObject({
      busy: null,
      conflict: undefined,
      outcome: { status: "uncertain" },
    });
  });

  it("does not let a stale operation finish a newer operation", () => {
    cloudSyncStore.setBusy("sync");
    const staleToken = cloudSyncStore.currentToken();
    cloudSyncStore.setBusy("restore");

    expect(cloudSyncStore.finishBusy(staleToken)).toBe(false);
    expect(cloudSyncStore.getSnapshot().busy).toBe("restore");
  });

  it("clears read and write budget confirmations when a new operation starts", () => {
    cloudSyncStore.setReadBudget({ mode: "full", estimatedReads: 40_000, entityReads: 40_000, reviewEventReads: 0, targetedReads: 0, overheadReads: 0, storageObjectCount: 0, storageBytes: 0, storageKnown: true });
    cloudSyncStore.setWriteBudget({ estimatedWrites: 5_000, entityWrites: 5_000, reviewEventWrites: 0, overheadWrites: 0, storageObjectCount: 0, storageBytes: 0 });

    cloudSyncStore.setBusy("sync");

    expect(cloudSyncStore.getSnapshot().readBudget).toBeUndefined();
    expect(cloudSyncStore.getSnapshot().writeBudget).toBeUndefined();
  });

  it("keeps native sign-in current while its account chooser backgrounds the WebView", () => {
    let visibility: DocumentVisibilityState = "visible";
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => visibility });
    cloudSyncStore.setBusy("sign-in");
    const token = cloudSyncStore.currentToken();

    visibility = "hidden";
    document.dispatchEvent(new Event("visibilitychange"));
    visibility = "visible";
    document.dispatchEvent(new Event("visibilitychange"));

    expect(cloudSyncStore.getSnapshot().busy).toBe("sign-in");
    expect(cloudSyncStore.isCurrent(token)).toBe(true);
    expect(cloudSyncStore.finishBusy(token)).toBe(true);
  });

  it("still invalidates a sync request interrupted by a real background transition", () => {
    let visibility: DocumentVisibilityState = "visible";
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => visibility });
    cloudSyncStore.setBusy("sync");
    const token = cloudSyncStore.currentToken();

    visibility = "hidden";
    document.dispatchEvent(new Event("visibilitychange"));
    visibility = "visible";
    document.dispatchEvent(new Event("visibilitychange"));

    expect(cloudSyncStore.getSnapshot()).toMatchObject({
      busy: null,
      outcome: { status: "uncertain" },
    });
    expect(cloudSyncStore.isCurrent(token)).toBe(false);
  });
});

describe("cloudSyncStore outcome toast", () => {
  afterEach(() => {
    cloudSyncStore.setBusy(null);
    cloudSyncStore.setConflict(undefined);
    cloudSyncStore.dismissOutcome();
    vi.useRealTimers();
  });

  it("auto-dismisses a success outcome after AUTO_DISMISS_MS", () => {
    vi.useFakeTimers();
    cloudSyncStore.setOutcome("success", "同步完成：上传 2 项，下载 0 项。");

    expect(cloudSyncStore.getSnapshot().outcome).toMatchObject({ status: "success" });

    vi.advanceTimersByTime(AUTO_DISMISS_MS - 1);
    expect(cloudSyncStore.getSnapshot().outcome).toBeDefined();

    vi.advanceTimersByTime(1);
    expect(cloudSyncStore.getSnapshot().outcome).toBeUndefined();
  });

  it("auto-dismisses a no-change outcome after AUTO_DISMISS_MS", () => {
    vi.useFakeTimers();
    cloudSyncStore.setOutcome("no-change", "同步完成：本机和云端均无新变化。");

    vi.advanceTimersByTime(AUTO_DISMISS_MS);
    expect(cloudSyncStore.getSnapshot().outcome).toBeUndefined();
  });

  it("keeps an error outcome visible until dismissed", () => {
    vi.useFakeTimers();
    cloudSyncStore.setOutcome("error", "另一台设备正在同步，请稍后再试。");

    vi.advanceTimersByTime(AUTO_DISMISS_MS * 10);
    expect(cloudSyncStore.getSnapshot().outcome).toMatchObject({ status: "error" });

    cloudSyncStore.dismissOutcome();
    expect(cloudSyncStore.getSnapshot().outcome).toBeUndefined();
  });

  it("keeps an uncertain outcome visible until dismissed", () => {
    vi.useFakeTimers();
    cloudSyncStore.setOutcome("uncertain", "操作结果未知，正在核对云端状态。");

    vi.advanceTimersByTime(AUTO_DISMISS_MS * 10);
    expect(cloudSyncStore.getSnapshot().outcome).toMatchObject({ status: "uncertain" });
  });

  it("clears a pending outcome timer when a new operation starts", () => {
    vi.useFakeTimers();
    cloudSyncStore.setOutcome("success", "同步完成：上传 1 项，下载 0 项。");
    cloudSyncStore.setBusy("sync");

    expect(cloudSyncStore.getSnapshot().outcome).toBeUndefined();

    // The old timer must not resurrect the outcome after the new operation already started.
    vi.advanceTimersByTime(AUTO_DISMISS_MS);
    expect(cloudSyncStore.getSnapshot().outcome).toBeUndefined();
  });

  it("replacing an outcome before it auto-dismisses does not let the old timer clear the new one", () => {
    vi.useFakeTimers();
    cloudSyncStore.setOutcome("success", "first");
    vi.advanceTimersByTime(AUTO_DISMISS_MS - 100);
    cloudSyncStore.setOutcome("error", "second");

    vi.advanceTimersByTime(100);
    expect(cloudSyncStore.getSnapshot().outcome).toMatchObject({ status: "error", message: "second" });
  });
});
