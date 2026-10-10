import { registerPlugin } from "@capacitor/core";
import { isAndroidPlatform } from "../lib/platform";

const appearance = registerPlugin<{ setColors(options: { statusBarColor: string; navigationBarColor: string; dark: boolean }): Promise<void> }>("NativeAppearance");

export const syncNativeAppearance = async (dark: boolean) => {
  if (!isAndroidPlatform()) return;
  const styles = getComputedStyle(document.documentElement);
  await appearance.setColors({
    statusBarColor: styles.getPropertyValue("--color-bg").trim(),
    navigationBarColor: styles.getPropertyValue("--color-surface").trim(),
    dark,
  });
};
