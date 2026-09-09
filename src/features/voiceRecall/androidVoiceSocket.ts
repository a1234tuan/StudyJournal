import { registerPlugin, type PluginListenerHandle } from "@capacitor/core";

import type { VoiceSocketFactory } from "./aliyunAsrTransport";
import { createBridgeVoiceSocketFactory, type VoiceSocketBridge, type VoiceSocketBridgeEvent } from "./bridgeVoiceSocket";

interface NativeVoiceAsrEvent {
  sessionId: string;
  kind: "open" | "message" | "error" | "close";
  dataBase64?: string;
  code?: number;
  reason?: string;
  message?: string;
}

export interface NativeVoiceAsrPlugin {
  open(options: { url: string; headers: Record<string, string> }): Promise<{ sessionId: string }>;
  send(options: { sessionId: string; dataBase64: string }): Promise<{ sent: boolean }>;
  close(options: { sessionId: string }): Promise<{ closed: boolean }>;
  addListener(eventName: "voiceAsrEvent", listener: (event: NativeVoiceAsrEvent) => void): Promise<PluginListenerHandle>;
}

export const NativeVoiceAsr = registerPlugin<NativeVoiceAsrPlugin>("NativeVoiceAsr");

const decodeBase64 = (value: string): Uint8Array => {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
};

const encodeBase64 = (value: Uint8Array): string => {
  let binary = "";
  for (const byte of value) binary += String.fromCharCode(byte);
  return btoa(binary);
};

/** Android relays frames through Capacitor's JSON bridge, so bytes are base64. */
export const createAndroidVoiceSocketFactory = (plugin: NativeVoiceAsrPlugin = NativeVoiceAsr): VoiceSocketFactory => {
  const bridge: VoiceSocketBridge = {
    open: (options) => plugin.open(options),
    send: (sessionId, data) => plugin.send({ sessionId, dataBase64: encodeBase64(data) }),
    close: (sessionId) => plugin.close({ sessionId }),
    onEvent: (listener) => {
      let handle: PluginListenerHandle | undefined;
      let disposed = false;
      void plugin.addListener("voiceAsrEvent", (event) => {
        const payload: VoiceSocketBridgeEvent = {
          sessionId: event.sessionId,
          kind: event.kind,
          data: event.dataBase64 ? decodeBase64(event.dataBase64) : undefined,
          code: event.code,
          reason: event.reason,
          message: event.message,
        };
        listener(payload);
      }).then((created) => {
        if (disposed) void created.remove();
        else handle = created;
      });
      return () => {
        disposed = true;
        void handle?.remove();
      };
    },
  };
  return createBridgeVoiceSocketFactory(bridge);
};
