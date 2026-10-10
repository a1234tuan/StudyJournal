import { beforeEach, describe, expect, it, vi } from "vitest";
import { effectiveSidebarWidth, normalizeSidebarPreference, readSidebarPreference, sidebarWidthLimit, writeSidebarPreference, SIDEBAR_LAYOUT_KEY } from "./sidebarLayout";

describe("sidebar layout preference", () => {
  beforeEach(() => localStorage.clear());
  it("uses a bounded width and rejects malformed values", () => {
    expect(normalizeSidebarPreference(null)).toEqual({ collapsed: false, width: 208 });
    expect(normalizeSidebarPreference({ collapsed: "true", width: "320" })).toEqual({ collapsed: false, width: 208 });
    expect(normalizeSidebarPreference({ collapsed: true, width: Infinity })).toEqual({ collapsed: true, width: 208 });
    expect(normalizeSidebarPreference({ width: 900 }).width).toBe(320);
    expect(normalizeSidebarPreference({ width: 0 }).width).toBe(192);
  });
  it("persists only local layout preference", () => {
    expect(readSidebarPreference()).toBeUndefined();
    writeSidebarPreference({ collapsed: true, width: 280 });
    expect(readSidebarPreference()).toEqual({ collapsed: true, width: 280 });
    expect(localStorage.length).toBe(1);
    localStorage.setItem(SIDEBAR_LAYOUT_KEY, "bad json");
    expect(readSidebarPreference()).toBeUndefined();
  });
  it("survives denied storage", () => {
    const read = vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw Error("denied"); });
    const write = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw Error("denied"); });
    expect(readSidebarPreference()).toBeUndefined();
    expect(() => writeSidebarPreference({ collapsed: false, width: 240 })).not.toThrow();
    read.mockRestore(); write.mockRestore();
  });
  it("clamps the displayed width without erasing the saved expanded width", () => {
    const preference = { collapsed: false, width: 320 };
    expect(effectiveSidebarWidth(preference, 1440)).toBe(320);
    expect(effectiveSidebarWidth(preference, 960)).toBe(240);
    expect(effectiveSidebarWidth(preference, 921)).toBe(201);
    expect(effectiveSidebarWidth(preference, 920)).toBe(0);
    expect(effectiveSidebarWidth(preference, 921, 911)).toBe(192);
    expect(effectiveSidebarWidth({ ...preference, collapsed: true }, 1440)).toBe(64);
    expect(preference.width).toBe(320);
    expect(sidebarWidthLimit(1024)).toBe(304);
  });
});
