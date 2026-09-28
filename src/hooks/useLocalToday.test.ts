import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const native = vi.hoisted(() => ({
  isNativePlatform: vi.fn(() => false),
  addListener: vi.fn(),
  remove: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@capacitor/core", () => ({ Capacitor: { isNativePlatform: native.isNativePlatform } }));
vi.mock("@capacitor/app", () => ({ App: { addListener: native.addListener } }));

import { useLocalToday } from "./useLocalToday";

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(2026, 8, 28, 10));
  native.isNativePlatform.mockReturnValue(false);
  native.addListener.mockReset();
  native.remove.mockClear();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("useLocalToday", () => {
  it.each([
    [2026, 9, 30, "2026-10-01"],
    [2026, 12, 31, "2027-01-01"],
    [2028, 2, 28, "2028-02-29"],
  ] as const)("rolls over local midnight from %s-%s-%s", (year, month, day, expected) => {
    vi.setSystemTime(new Date(year, month - 1, day, 23, 59, 59, 500));
    const { result } = renderHook(useLocalToday);
    act(() => { vi.advanceTimersByTime(500); });
    expect(result.current).toBe(expected);
  });

  it("refreshes after focus and a suspended browser becomes visible", () => {
    const { result } = renderHook(useLocalToday);
    expect(result.current).toBe("2026-09-28");
    act(() => {
      vi.setSystemTime(new Date(2026, 8, 30, 10));
      window.dispatchEvent(new Event("focus"));
    });
    expect(result.current).toBe("2026-09-30");
    const visibility = vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
    act(() => {
      vi.setSystemTime(new Date(2026, 9, 1, 10));
      document.dispatchEvent(new Event("visibilitychange"));
    });
    expect(result.current).toBe("2026-09-30");
    visibility.mockReturnValue("visible");
    act(() => { document.dispatchEvent(new Event("visibilitychange")); });
    expect(result.current).toBe("2026-10-01");
  });

  it("rechecks within a minute after a system clock change and clears its timer", () => {
    const { result, unmount } = renderHook(useLocalToday);
    act(() => {
      vi.setSystemTime(new Date(2026, 9, 1, 10));
      vi.advanceTimersByTime(60_000);
    });
    expect(result.current).toBe("2026-10-01");
    expect(vi.getTimerCount()).toBe(1);
    unmount();
    expect(vi.getTimerCount()).toBe(0);
    act(() => { window.dispatchEvent(new Event("focus")); });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("uses native foreground events and removes a late native listener after unmount", async () => {
    native.isNativePlatform.mockReturnValue(true);
    let resolveListener!: (value: { remove: typeof native.remove }) => void;
    native.addListener.mockImplementation(() => new Promise((resolve) => { resolveListener = resolve; }));
    const { result, unmount } = renderHook(useLocalToday);
    expect(native.addListener).toHaveBeenCalledWith("appStateChange", expect.any(Function));
    const listener = native.addListener.mock.calls[0][1] as (state: { isActive: boolean }) => void;
    act(() => {
      vi.setSystemTime(new Date(2026, 8, 29, 10));
      listener({ isActive: false });
    });
    expect(result.current).toBe("2026-09-28");
    act(() => { listener({ isActive: true }); });
    expect(result.current).toBe("2026-09-29");
    unmount();
    await act(async () => { resolveListener({ remove: native.remove }); });
    expect(native.remove).toHaveBeenCalledOnce();
    listener({ isActive: true });
    expect(vi.getTimerCount()).toBe(0);
  });
});
