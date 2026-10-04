import { describe, expect, it } from "vitest";
import { pinchMap, wheelMapZoom, zoomMapAt } from "./mapViewport";

describe("map camera invariants", () => {
  it("keeps the world point under the pointer during zoom", () => {
    const view = { zoom: .5, panX: 90, panY: -30 };
    const anchor = { x: 420, y: 220 };
    const result = zoomMapAt(view, 1.2, anchor);
    expect((anchor.x - result.panX) / result.zoom).toBe((anchor.x - view.panX) / view.zoom);
    expect((anchor.y - result.panY) / result.zoom).toBe((anchor.y - view.panY) / view.zoom);
  });
  it("follows the fingers midpoint and clamps zoom", () => {
    const result = pinchMap({ zoom: 1, panX: 0, panY: 0 }, { x: 100, y: 80 }, { x: 140, y: 120 }, 3);
    expect(result).toEqual({ zoom: 2, panX: -60, panY: -40 });
  });
  it("normalizes wheel units and preserves fine trackpad deltas", () => {
    expect(wheelMapZoom(1, 16, 0, 800)).toBe(wheelMapZoom(1, 1, 1, 800));
    expect(wheelMapZoom(1, 1, 0, 800)).toBeGreaterThan(.99);
    expect(wheelMapZoom(1, 2, 0, 800)).toBeLessThan(wheelMapZoom(1, 1, 0, 800));
  });
});
