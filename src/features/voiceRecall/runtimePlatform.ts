import { Capacitor } from "@capacitor/core";

import { isDesktopPlatform } from "../../lib/platform";
import type { VoiceRuntimePlatform } from "./providerProfiles";

export type { VoiceRuntimePlatform };

/** Which host the voice runtime is running in. Real provider profiles are all
 * `browserDirectSupported: false`, so this decides which transport is legal. */
export const voiceRuntimePlatform = (): VoiceRuntimePlatform => {
  if (Capacitor.isNativePlatform() && Capacitor.getPlatform() === "android") {
    return "android";
  }
  if (isDesktopPlatform()) {
    return "desktop";
  }
  return "web";
};

/** Human-readable reason shown when the current platform cannot reach a provider. */
export const voicePlatformUnsupportedMessage = (platform: VoiceRuntimePlatform): string =>
  platform === "web"
    ? "浏览器无法直连语音服务（缺少跨域许可与自定义请求头）。请在桌面端或 Android 端使用语音复述。"
    : "当前平台无法连接语音服务，请检查网络与代理设置。";
