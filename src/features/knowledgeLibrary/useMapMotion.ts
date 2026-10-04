import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { MapNode } from "./presentation";
import type { MapCamera } from "./mapViewport";

export function useMapCamera(initial: MapCamera) {
  const [view, commit] = useState(initial);
  const current = useRef(initial);
  const frame = useRef<number>();
  const setView = useCallback((next: MapCamera | ((previous: MapCamera) => MapCamera)) => {
    current.current = typeof next === "function" ? next(current.current) : next;
    if (frame.current !== undefined) return;
    frame.current = requestAnimationFrame(() => { frame.current = undefined; commit(current.current); });
  }, []);
  useEffect(() => () => { if (frame.current !== undefined) cancelAnimationFrame(frame.current); }, []);
  return { view, setView, camera: current };
}

export function useMapLayoutMotion(target: MapNode[]) {
  const [nodes, setNodes] = useState(target);
  const current = useRef(target);
  useLayoutEffect(() => {
    const before = new Map(current.current.map(node => [node.id, node]));
    if (!before.size || window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      current.current = target;
      setNodes(target);
      return;
    }
    const started = performance.now();
    let frame: number;
    const tick = (now: number) => {
      const progress = Math.min(1, (now - started) / 180);
      const eased = 1 - Math.pow(1 - progress, 3);
      const next = target.map(node => {
        const previous = before.get(node.id) ?? before.get(node.parentId) ?? node;
        return { ...node, x: previous.x + (node.x - previous.x) * eased, y: previous.y + (node.y - previous.y) * eased };
      });
      current.current = next;
      setNodes(next);
      if (progress < 1) frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [target]);
  return nodes;
}
