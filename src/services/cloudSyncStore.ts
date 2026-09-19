import { useSyncExternalStore } from "react";
import type { CloudSyncBudgetChoice, CloudSyncConflict, CloudSyncConflictChoice, CloudSyncReadEstimate, CloudSyncWriteEstimate } from "./cloudSyncService";

export type BusyAction = "sign-in" | "sign-out" | "sync" | "restore" | "resolve" | null;

/** Result of the most recently finished sync/resolve operation, shown in a small toast so a
 *  click on the sync button always produces visible feedback — not just when there's a conflict. */
export type SyncOutcomeStatus = "success" | "no-change" | "error" | "uncertain";

export interface SyncOutcome {
  status: SyncOutcomeStatus;
  message: string;
}

interface CloudSyncState {
  busy: BusyAction;
  message: string;
  conflict: CloudSyncConflict | undefined;
  /** Bumped whenever a new operation starts (or a stale one is force-cleared). Lets an in-flight
   *  async call check `isCurrent(token)` before writing results, so an interrupted/superseded sync
   *  can never clobber state set by a later one. */
  token: number;
  /** Result of the last completed operation, rendered by CloudSyncStatusToast. Cleared when a new
   *  operation starts, dismissed manually, or auto-dismissed a few seconds after a benign result. */
  outcome: SyncOutcome | undefined;
  readBudget: CloudSyncReadEstimate | undefined;
  readBudgetChoice: CloudSyncConflictChoice | undefined;
  writeBudget: CloudSyncWriteEstimate | undefined;
  writeBudgetChoice: CloudSyncBudgetChoice | undefined;
}

/**
 * Safety net for a sync that never reaches its finally block (for example, when Android
 * suspends the WebView mid-request). A single Storage download is allowed to run for five
 * minutes on native, so this must be longer than that request timeout. Otherwise a perfectly
 * healthy, large restore is reported as a suspended app at the two-minute mark.
 */
export const CLOUD_SYNC_WATCHDOG_MS = 6 * 60_000;

let state: CloudSyncState = { busy: null, message: "", conflict: undefined, token: 0, outcome: undefined, readBudget: undefined, readBudgetChoice: undefined, writeBudget: undefined, writeBudgetChoice: undefined };
const listeners = new Set<() => void>();
let watchdogTimer: number | undefined;
let backgroundedWhileBusy = false;
let outcomeTimer: number | undefined;
let outcomeToken = 0;

/** Benign results (nothing to report, or a normal upload/download) clear themselves so the toast
 *  doesn't linger. Failures and unresolved network states stay until the user dismisses them —
 *  the whole point is to stop the user from editing on top of a sync they didn't notice failed. */
export const AUTO_DISMISS_MS = 5000;

const notify = () => listeners.forEach((l) => l());

const clearOutcomeTimer = () => {
  if (outcomeTimer !== undefined) {
    window.clearTimeout(outcomeTimer);
    outcomeTimer = undefined;
  }
};

/** Shared by the public setOutcome() and the watchdog/background guards below, so every path that
 *  force-clears a stuck sync also leaves behind a visible (non-auto-dismissing) outcome. */
const applyOutcome = (status: SyncOutcomeStatus, message: string) => {
  clearOutcomeTimer();
  outcomeToken += 1;
  const token = outcomeToken;
  state = { ...state, outcome: { status, message } };
  notify();
  if (status === "success" || status === "no-change") {
    outcomeTimer = window.setTimeout(() => {
      if (outcomeToken === token) {
        state = { ...state, outcome: undefined };
        notify();
      }
    }, AUTO_DISMISS_MS);
  }
};

const clearWatchdog = () => {
  if (watchdogTimer !== undefined) {
    window.clearTimeout(watchdogTimer);
    watchdogTimer = undefined;
  }
};

const armWatchdog = (token: number) => {
  clearWatchdog();
  watchdogTimer = window.setTimeout(() => {
    if (state.token === token && state.busy !== null) {
      const message = "同步结果未知，应用可能在后台中断，请点击同步核对上一次操作。";
      state = { ...state, busy: null, token: state.token + 1, message, conflict: undefined };
      backgroundedWhileBusy = false;
      applyOutcome("uncertain", message);
    }
  }, CLOUD_SYNC_WATCHDOG_MS);
};

const finishBusy = (token: number) => {
  if (state.token !== token) return false;
  state = { ...state, busy: null };
  backgroundedWhileBusy = false;
  notify();
  clearWatchdog();
  return true;
};

export const cloudSyncStore = {
  getSnapshot: () => state,
  subscribe: (listener: () => void) => {
    listeners.add(listener);
    return () => { listeners.delete(listener); };
  },
  setBusy: (busy: BusyAction) => {
    // A new operation starting supersedes whatever outcome toast was showing for the previous one.
    if (busy !== null) {
      clearOutcomeTimer();
      backgroundedWhileBusy = typeof document !== "undefined" && document.visibilityState === "hidden";
      state = { ...state, busy, token: state.token + 1, outcome: undefined, readBudget: undefined, readBudgetChoice: undefined, writeBudget: undefined, writeBudgetChoice: undefined };
    } else {
      backgroundedWhileBusy = false;
      state = { ...state, busy };
    }
    notify();
    if (busy !== null) armWatchdog(state.token);
    else clearWatchdog();
  },
  /** A progress message proves the operation is still alive, so give its watchdog a fresh window. */
  setMessage: (message: string) => {
    state = { ...state, message };
    if (state.busy !== null) armWatchdog(state.token);
    notify();
  },
  setConflict: (conflict: CloudSyncConflict | undefined) => { state = { ...state, conflict }; notify(); },
  setReadBudget: (estimate: CloudSyncReadEstimate | undefined) => { state = { ...state, readBudget: estimate }; notify(); },
  setReadBudgetChoice: (choice: CloudSyncConflictChoice | undefined) => { state = { ...state, readBudgetChoice: choice }; notify(); },
  setWriteBudget: (estimate: CloudSyncWriteEstimate | undefined) => { state = { ...state, writeBudget: estimate }; notify(); },
  setWriteBudgetChoice: (choice: CloudSyncBudgetChoice | undefined) => { state = { ...state, writeBudgetChoice: choice }; notify(); },
  /** Records the final result of a sync/resolve so CloudSyncStatusToast can show it. Success and
   *  no-change auto-dismiss after a few seconds; error and uncertain stay until dismissOutcome(). */
  setOutcome: (status: SyncOutcomeStatus, message: string) => applyOutcome(status, message),
  dismissOutcome: () => {
    clearOutcomeTimer();
    state = { ...state, outcome: undefined };
    notify();
  },
  finishBusy,
  /** Token for the operation just started by setBusy(). Capture right after setBusy and pass to isCurrent(). */
  currentToken: () => state.token,
  /** False once a newer operation started, or the watchdog/background guard force-cleared this one —
   *  callers should skip writing their result when this returns false. */
  isCurrent: (token: number) => state.token === token,
};

export const useCloudSyncStore = () =>
  useSyncExternalStore(cloudSyncStore.subscribe, cloudSyncStore.getSnapshot);

/** Cross-platform "app left/returned to foreground" signal (visibilitychange covers web, desktop
 *  Electron, and Android WebView). If we go to background mid-sync and come back still busy, the
 *  in-flight request most likely got suspended by the OS — clear busy immediately instead of making
 *  the user wait out the watchdog, and tell them what happened. Native Google sign-in is the one
 *  exception: its account chooser intentionally backgrounds the WebView, so invalidating that token
 *  would hide its eventual cancellation/error and allow overlapping native auth requests. */
if (typeof document !== "undefined") {
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") {
      if (state.busy !== null && state.busy !== "sign-in") backgroundedWhileBusy = true;
      return;
    }
    if (document.visibilityState === "visible") {
      if (backgroundedWhileBusy && state.busy !== null) {
        clearWatchdog();
        const message = "同步结果未知，应用切到后台时请求被中断，请点击同步核对上一次操作。";
        state = { ...state, busy: null, token: state.token + 1, message, conflict: undefined };
        backgroundedWhileBusy = false;
        applyOutcome("uncertain", message);
      }
      backgroundedWhileBusy = false;
    }
  });
}
