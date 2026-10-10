import { useSyncExternalStore } from "react";
import { isAndroidPlatform, isDesktopPlatform } from "./platform";

export type PresentationHost = "android" | "desktop" | "web";
export const MOBILE_LAYOUT_QUERY = "(max-width: 920px)";

export const mobilePresentationFor = (host: PresentationHost, compact: boolean): boolean =>
  host === "android" || (host === "web" && compact);

export const presentationHost = (): PresentationHost =>
  isAndroidPlatform() ? "android" : isDesktopPlatform() ? "desktop" : "web";

const compactViewport = () => typeof window !== "undefined" && typeof window.matchMedia === "function"
  && window.matchMedia(MOBILE_LAYOUT_QUERY).matches;

const mobileSnapshot = () => mobilePresentationFor(presentationHost(), compactViewport());

const subscribe = (listener: () => void) => {
  if (typeof window.matchMedia !== "function") return () => undefined;
  const media = window.matchMedia(MOBILE_LAYOUT_QUERY);
  media.addEventListener("change", listener);
  return () => media.removeEventListener("change", listener);
};

export const useMobilePresentation = () => useSyncExternalStore(subscribe, mobileSnapshot, () => false);

export const initializePresentation = () => {
  const update = () => {
    document.documentElement.dataset.host = presentationHost();
    document.documentElement.dataset.mobileUi = String(mobileSnapshot());
    document.documentElement.dataset.compactLayout = String(compactViewport());
  };
  update();
  return subscribe(update);
};
