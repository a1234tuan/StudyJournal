import { SystemBarsStyle } from "@capacitor/core";
import type { AppSettings } from "../types";

export const systemBarStyleForTheme = (theme: AppSettings["theme"] | undefined): SystemBarsStyle => {
  if (theme === "dark") return SystemBarsStyle.Dark;
  if (theme === "light") return SystemBarsStyle.Light;
  return SystemBarsStyle.Default;
};
