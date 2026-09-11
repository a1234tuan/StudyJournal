import { createContext, useContext, useEffect, useRef, useState, type HTMLAttributes, type ReactNode } from "react";
import { createPortal } from "react-dom";

import { usePageTransitionLayerState } from "./PageTransition";

export type MotionPresencePhase = "entering" | "entered" | "exiting";
export type MotionPresenceVariant = "modal" | "sheet" | "drawer" | "popover";

const ViewportOverlayContext = createContext<HTMLElement | null>(null);

export const ViewportOverlayProvider = ({ host, children }: { host: HTMLElement | null; children: ReactNode }) => (
  <ViewportOverlayContext.Provider value={host}>{children}</ViewportOverlayContext.Provider>
);

const prefersReducedMotion = () => typeof window !== "undefined"
  && typeof window.matchMedia === "function"
  && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

interface MotionPresenceProps extends Omit<HTMLAttributes<HTMLDivElement>, "children"> {
  present: boolean;
  variant: MotionPresenceVariant;
  portal?: boolean;
  children: ReactNode;
}

export const MotionPresence = ({
  present,
  variant,
  portal = true,
  className = "",
  children,
  ...props
}: MotionPresenceProps) => {
  const overlayHost = useContext(ViewportOverlayContext);
  const pageLayerState = usePageTransitionLayerState();
  const [rendered, setRendered] = useState(present);
  const [phase, setPhase] = useState<MotionPresencePhase>(present ? "entering" : "entered");
  const timerRef = useRef<number>();
  const visibleChildrenRef = useRef(children);
  if (present) visibleChildrenRef.current = children;

  useEffect(() => {
    if (timerRef.current) window.clearTimeout(timerRef.current);
    const duration = prefersReducedMotion() ? 0 : 200;
    if (present) {
      setRendered(true);
      setPhase("entering");
      timerRef.current = window.setTimeout(() => setPhase("entered"), duration);
    } else if (rendered) {
      setPhase("exiting");
      timerRef.current = window.setTimeout(() => setRendered(false), duration);
    }
    return () => {
      if (timerRef.current) window.clearTimeout(timerRef.current);
    };
  }, [present]);

  if (!rendered || pageLayerState === "exiting") return null;
  const content = (
    <div
      {...props}
      {...(phase === "exiting" ? { inert: "" } : {})}
      className={`motion-presence motion-presence-${variant} motion-presence-${phase}${className ? ` ${className}` : ""}`}
      data-motion-phase={phase}
      data-motion-variant={variant}
      aria-hidden={phase === "exiting" ? true : props["aria-hidden"]}
    >
      {present ? children : visibleChildrenRef.current}
    </div>
  );
  return portal && overlayHost ? createPortal(content, overlayHost) : content;
};
