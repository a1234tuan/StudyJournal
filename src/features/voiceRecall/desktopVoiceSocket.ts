import { createBridgeVoiceSocketFactory, type VoiceSocketBridge, type VoiceSocketBridgeEvent } from "./bridgeVoiceSocket";
import type { VoiceSocketFactory } from "./aliyunAsrTransport";

export type DesktopVoiceAsrBridge = NonNullable<Window["studyJournalDesktop"]>["voiceAsr"];
export type DesktopVoiceAsrEvent = VoiceSocketBridgeEvent;

/** Electron main already relays `Uint8Array` frames, so the bridge maps 1:1. */
export const createDesktopVoiceSocketFactory = (bridge: DesktopVoiceAsrBridge): VoiceSocketFactory =>
  createBridgeVoiceSocketFactory(bridge as VoiceSocketBridge);
