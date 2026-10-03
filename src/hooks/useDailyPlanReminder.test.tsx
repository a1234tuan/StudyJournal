import { StrictMode } from "react";
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const native = vi.hoisted(() => ({ isNativePlatform: vi.fn(() => false), addListener: vi.fn(), remove: vi.fn().mockResolvedValue(undefined) }));
vi.mock("@capacitor/core", () => ({ Capacitor: { isNativePlatform: native.isNativePlatform } }));
vi.mock("@capacitor/app", () => ({ App: { addListener: native.addListener } }));
import { claimDailyPlanReminder, DAILY_PLAN_REMINDER_KEY, hasSeenDailyPlanReminder, useDailyPlanReminder } from "./useDailyPlanReminder";

const settle = async (ms = 800) => { await act(async () => { await vi.advanceTimersByTimeAsync(ms); }); };
beforeEach(() => {
  localStorage.clear();
  vi.useFakeTimers();
  vi.setSystemTime(new Date(2026, 9, 3, 9));
  native.isNativePlatform.mockReturnValue(false);
  native.addListener.mockReset();
  native.remove.mockClear();
});
afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("daily plan reminder", () => {
  it("claims the local day on display, not on button confirmation", async () => {
    const { result } = renderHook(() => useDailyPlanReminder(true));
    expect(result.current.open).toBe(false);
    await settle();
    expect(result.current.open).toBe(true);
    expect(localStorage.getItem(DAILY_PLAN_REMINDER_KEY)).toBe("2026-10-03");
    act(() => result.current.dismiss());
    act(() => window.dispatchEvent(new Event("focus")));
    await settle();
    expect(result.current.open).toBe(false);
  });
  it("does not repeat on same-day remount or restart", async () => {
    localStorage.setItem(DAILY_PLAN_REMINDER_KEY, "2026-10-03");
    const { result } = renderHook(() => useDailyPlanReminder(true));
    await settle();
    expect(result.current.open).toBe(false);
    expect(result.current.checked).toBe(true);
  });
  it("waits for initialization and a safe route without consuming the day", async () => {
    const { result, rerender } = renderHook(({ ready }) => useDailyPlanReminder(ready), { initialProps: { ready: false } });
    await settle();
    expect(localStorage.getItem(DAILY_PLAN_REMINDER_KEY)).toBeNull();
    rerender({ ready: true });
    await settle();
    expect(result.current.open).toBe(true);
  });
  it("cancels a delayed popup when the user starts editing", async () => {
    const { result, rerender } = renderHook(({ ready }) => useDailyPlanReminder(ready), { initialProps: { ready: true } });
    await settle(300);
    rerender({ ready: false });
    await settle();
    expect(result.current.open).toBe(false);
    expect(localStorage.getItem(DAILY_PLAN_REMINDER_KEY)).toBeNull();
  });
  it("does not interrupt an active session at midnight, but checks next foreground", async () => {
    const { result } = renderHook(() => useDailyPlanReminder(true));
    await settle();
    act(() => result.current.dismiss());
    vi.setSystemTime(new Date(2026, 9, 4, 9));
    await settle(1000);
    expect(result.current.open).toBe(false);
    act(() => window.dispatchEvent(new Event("focus")));
    await settle();
    expect(result.current.open).toBe(true);
    expect(result.current.date).toBe("2026-10-04");
  });
  it("never displays or marks the reminder while hidden", async () => {
    const visibility = vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
    const { result } = renderHook(() => useDailyPlanReminder(true));
    await settle();
    expect(result.current.open).toBe(false);
    expect(localStorage.getItem(DAILY_PLAN_REMINDER_KEY)).toBeNull();
    visibility.mockReturnValue("visible");
    act(() => document.dispatchEvent(new Event("visibilitychange")));
    await settle();
    expect(result.current.open).toBe(true);
  });
  it("waits for existing dialogs rather than stacking", async () => {
    const overlay = document.createElement("section");
    overlay.setAttribute("aria-modal", "true");
    vi.spyOn(overlay, "getClientRects").mockReturnValue([{}] as unknown as DOMRectList);
    document.body.append(overlay);
    const { result } = renderHook(() => useDailyPlanReminder(true));
    await settle();
    expect(result.current.open).toBe(false);
    expect(localStorage.getItem(DAILY_PLAN_REMINDER_KEY)).toBeNull();
    overlay.remove();
    await settle();
    expect(result.current.open).toBe(true);
  });
  it("survives StrictMode without losing or duplicating the first popup", async () => {
    const { result } = renderHook(() => useDailyPlanReminder(true), { wrapper: StrictMode });
    await settle();
    expect(result.current.open).toBe(true);
    act(() => result.current.dismiss());
    await settle();
    expect(result.current.open).toBe(false);
  });
  it("rechecks eligibility after waiting for a cross-window lock", async () => {
    let callback!: () => boolean;
    let resolve!: (value: boolean) => void;
    Object.defineProperty(navigator, "locks", { configurable: true, value: { request: vi.fn((_name, claim) => { callback = claim; return new Promise<boolean>(done => { resolve = done; }); }) } });
    let ready = true;
    const pending = claimDailyPlanReminder("2026-10-03", () => ready);
    ready = false;
    resolve(callback());
    expect(await pending).toBe(false);
    expect(localStorage.getItem(DAILY_PLAN_REMINDER_KEY)).toBeNull();
    Object.defineProperty(navigator, "locks", { configurable: true, value: undefined });
  });
  it("allows only one of two concurrent claimants", async () => {
    const outcomes = await Promise.all([claimDailyPlanReminder("2026-10-03", () => true), claimDailyPlanReminder("2026-10-03", () => true)]);
    expect(outcomes.filter(Boolean)).toHaveLength(1);
  });
  it("falls back to session-only deduplication if device storage is unavailable", async () => {
    vi.setSystemTime(new Date(2026, 9, 8, 9));
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("blocked"); });
    expect(await claimDailyPlanReminder("2026-10-08", () => true)).toBe(true);
    expect(hasSeenDailyPlanReminder("2026-10-08")).toBe(true);
    expect(await claimDailyPlanReminder("2026-10-08", () => true)).toBe(false);
  });
  it("handles Android foreground and removes the listener", async () => {
    native.isNativePlatform.mockReturnValue(true);
    native.addListener.mockResolvedValue({ remove: native.remove });
    const { result, unmount } = renderHook(() => useDailyPlanReminder(true));
    await settle();
    const listener = native.addListener.mock.calls[0][1] as (state: { isActive: boolean }) => void;
    act(() => listener({ isActive: false }));
    vi.setSystemTime(new Date(2026, 9, 4, 8));
    act(() => listener({ isActive: true }));
    await settle();
    expect(result.current.date).toBe("2026-10-04");
    expect(result.current.open).toBe(true);
    unmount();
    await act(async () => undefined);
    expect(native.remove).toHaveBeenCalledOnce();
  });
});
