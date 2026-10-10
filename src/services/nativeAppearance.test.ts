import { afterEach, describe, expect, it, vi } from "vitest";
const bridge = vi.hoisted(() => ({ android: false, setColors: vi.fn().mockResolvedValue(undefined) }));
vi.mock("@capacitor/core", () => ({ registerPlugin: () => ({ setColors: bridge.setColors }) }));
vi.mock("../lib/platform", () => ({ isAndroidPlatform: () => bridge.android }));
import { syncNativeAppearance } from "./nativeAppearance";

afterEach(() => {
  bridge.android = false;
  bridge.setColors.mockClear();
  document.documentElement.style.removeProperty("--color-bg");
  document.documentElement.style.removeProperty("--color-surface");
});

describe("native appearance boundary", () => {
  it("does not call native code on web or desktop", async () => {
    await syncNativeAppearance(false);
    expect(bridge.setColors).not.toHaveBeenCalled();
  });
  it("uses the current mobile theme colors without changing insets", async () => {
    bridge.android = true;
    document.documentElement.style.setProperty("--color-bg", "#211e1b");
    document.documentElement.style.setProperty("--color-surface", "#292521");
    await syncNativeAppearance(true);
    expect(bridge.setColors).toHaveBeenCalledWith({ statusBarColor: "#211e1b", navigationBarColor: "#292521", dark: true });
  });
});
