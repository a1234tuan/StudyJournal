export interface MapCamera { zoom: number; panX: number; panY: number }
export interface MapPoint { x: number; y: number }
export const zoomMapAt = (view: MapCamera, requested: number, anchor: MapPoint): MapCamera => {
  const zoom = Math.min(2, Math.max(.2, requested));
  return { zoom, panX: anchor.x - (anchor.x - view.panX) * zoom / view.zoom, panY: anchor.y - (anchor.y - view.panY) * zoom / view.zoom };
};
export const wheelMapZoom = (zoom: number, delta: number, mode: number, height: number) => zoom * Math.exp(-Math.max(-250, Math.min(250, delta * (mode === 1 ? 16 : mode === 2 ? height : 1))) * .003);
export const pinchMap = (initial: MapCamera, anchor: MapPoint, midpoint: MapPoint, ratio: number): MapCamera => {
  const zoomed = zoomMapAt(initial, initial.zoom * ratio, anchor);
  return { ...zoomed, panX: zoomed.panX + midpoint.x - anchor.x, panY: zoomed.panY + midpoint.y - anchor.y };
};
