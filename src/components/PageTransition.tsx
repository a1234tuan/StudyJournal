import { createContext, useContext, useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";

interface PageTransitionProps {
  pageKey: string;
  motion?: NavigationMotionIntent;
  children: ReactNode;
}

export type NavigationMotionIntent = "tab" | "forward" | "back" | "replace" | "none";
export type PageTransitionLayerState = "entering" | "exiting" | "entered";

const PageTransitionLayerContext = createContext<PageTransitionLayerState>("entered");

export const usePageTransitionLayerState = () => useContext(PageTransitionLayerContext);

type TransitionLayer = {
  id: number;
  pageKey: string;
  children: ReactNode;
  state: PageTransitionLayerState;
  motion: NavigationMotionIntent;
};

export const PAGE_TRANSITION_DURATION_MS = 200;

const prefersReducedMotion = () =>
  typeof window !== "undefined" &&
  typeof window.matchMedia === "function" &&
  window.matchMedia("(prefers-reduced-motion: reduce)").matches;

export const PageTransition = ({ pageKey, motion = "replace", children }: PageTransitionProps) => {
  const nextLayerId = useRef(1);
  const activePageKey = useRef(pageKey);
  const cleanupTimer = useRef<number | null>(null);
  const [layers, setLayers] = useState<TransitionLayer[]>([
    { id: 0, pageKey, children, state: "entered", motion: "none" },
  ]);

  useEffect(() => {
    if (activePageKey.current === pageKey) {
      setLayers((current) =>
        current.map((layer) =>
          layer.state === "exiting" ? layer : { ...layer, pageKey, children },
        ),
      );
      return;
    }

    activePageKey.current = pageKey;
    const id = nextLayerId.current;
    nextLayerId.current += 1;

    if (motion === "none" || prefersReducedMotion()) {
      setLayers([{ id, pageKey, children, state: "entered", motion: "none" }]);
      return;
    }

    setLayers((current) => {
      const activeLayer = current.find((layer) => layer.state !== "exiting") ?? current[current.length - 1];
      const exitingLayer = activeLayer ? { ...activeLayer, state: "exiting" as const, motion } : undefined;
      return [
        ...(exitingLayer ? [exitingLayer] : []),
        { id, pageKey, children, state: "entering" as const, motion },
      ];
    });

    if (cleanupTimer.current) {
      window.clearTimeout(cleanupTimer.current);
    }
    cleanupTimer.current = window.setTimeout(
      () => {
        setLayers((current) => current
          .filter((layer) => layer.state !== "exiting")
          .map((layer) => layer.state === "entering" ? { ...layer, state: "entered" } : layer));
        cleanupTimer.current = null;
      },
      PAGE_TRANSITION_DURATION_MS,
    );
  }, [children, motion, pageKey]);

  useEffect(
    () => () => {
      if (cleanupTimer.current) {
        window.clearTimeout(cleanupTimer.current);
      }
    },
    [],
  );

  return (
    <div className="page-transition-frame">
      {layers.map((layer) => (
        <div
          key={layer.id}
          className={`page-transition-layer page-transition-layer-${layer.state}`}
          data-motion={layer.motion}
          aria-hidden={layer.state === "exiting" ? true : undefined}
          onAnimationEnd={() => {
            setLayers((current) => current
              .filter((item) => item.id !== layer.id || item.state !== "exiting")
              .map((item) => item.id === layer.id && item.state === "entering" ? { ...item, state: "entered" } : item));
          }}
        >
          <PageTransitionLayerContext.Provider value={layer.state}>
            {layer.children}
          </PageTransitionLayerContext.Provider>
        </div>
      ))}
    </div>
  );
};
