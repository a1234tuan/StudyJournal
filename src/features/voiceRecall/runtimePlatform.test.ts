import { beforeEach, describe, expect, it, vi } from "vitest";

const capacitor = vi.hoisted(() => ({ native: false, platform: "web" }));
vi.mock("@capacitor/core", () => ({
  Capacitor: {
    isNativePlatform: () => capacitor.native,
    getPlatform: () => capacitor.platform,
  },
}));

const desktop = vi.hoisted(() => ({ value: false }));
vi.mock("../../lib/platform", () => ({
  isDesktopPlatform: () => desktop.value,
}));

import { voicePlatformUnsupportedMessage, voiceRuntimePlatform } from "./runtimePlatform";

describe("voiceRuntimePlatform", () => {
  beforeEach(() => {
    capacitor.native = false;
    capacitor.platform = "web";
    desktop.value = false;
  });

  it("reports android only for the native Android shell", () => {
    capacitor.native = true;
    capacitor.platform = "android";
    expect(voiceRuntimePlatform()).toBe("android");
  });

  it("reports desktop for the Electron shell", () => {
    desktop.value = true;
    expect(voiceRuntimePlatform()).toBe("desktop");
  });

  it("falls back to web and explains why the chain is unavailable there", () => {
    expect(voiceRuntimePlatform()).toBe("web");
    expect(voicePlatformUnsupportedMessage("web")).toContain("桌面端或 Android");
  });
});
