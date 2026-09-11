import { canUseNativeVoiceCapture, NativeVoiceCapture } from "./nativeVoiceCapture";
import type { PluginListenerHandle } from "@capacitor/core";
export type VoiceAudioFocusReason = "background" | "pagehide" | "focus-lost";

export class VoiceAudioFocusManager {
  private active = false;
  private removeDesktopListener?: () => void;
  private nativeHandle?: PluginListenerHandle;
  private focusEpoch = 0;
  private held = false;
  private focusOperations: Promise<void> = Promise.resolve();

  async acquire() {
    if (!canUseNativeVoiceCapture()) return;
    const epoch = this.focusEpoch;
    const operation = this.focusOperations.then(async () => {
      if (epoch !== this.focusEpoch) throw new DOMException("Focus request cancelled", "AbortError");
      if (this.held) return;
      const native = NativeVoiceCapture as unknown as { addListener(name: "focusLost", listener: () => void): Promise<PluginListenerHandle> };
      const handle = await native.addListener("focusLost", () => { if (epoch === this.focusEpoch) { this.held = false; this.onSuspend("focus-lost"); } });
      if (epoch !== this.focusEpoch) { await handle.remove(); throw new DOMException("Focus request cancelled", "AbortError"); }
      this.nativeHandle = handle;
      try {
        await NativeVoiceCapture.acquireFocus();
        if (epoch !== this.focusEpoch) throw new DOMException("Focus request cancelled", "AbortError");
        this.held = true;
      } catch (error) { await handle.remove(); this.nativeHandle = undefined; throw error; }
    });
    this.focusOperations = operation.catch(() => undefined);
    return operation;
  }

  async release() {
    this.focusEpoch += 1;
    this.held = false;
    const operation = this.focusOperations.then(async () => {
      const handle = this.nativeHandle;
      this.nativeHandle = undefined;
      await handle?.remove();
      if (canUseNativeVoiceCapture()) await NativeVoiceCapture.releaseFocus();
    });
    this.focusOperations = operation.catch(() => undefined);
    return operation;
  }

  constructor(private readonly onSuspend: (reason: VoiceAudioFocusReason) => void) {}

  private readonly handleVisibility = () => {
    if (this.active && document.visibilityState === "hidden") this.onSuspend("background");
  };

  private readonly handlePageHide = () => {
    if (this.active) this.onSuspend("pagehide");
  };

  start() {
    if (this.active || typeof document === "undefined") return;
    this.active = true;
    document.addEventListener("visibilitychange", this.handleVisibility);
    window.addEventListener("pagehide", this.handlePageHide);
    this.removeDesktopListener = window.studyJournalDesktop?.voice.onSuspendRequested(() => this.onSuspend("focus-lost"));
  }

  stop() {
    if (!this.active || typeof document === "undefined") return;
    this.active = false;
    document.removeEventListener("visibilitychange", this.handleVisibility);
    window.removeEventListener("pagehide", this.handlePageHide);
    this.removeDesktopListener?.();
    this.removeDesktopListener = undefined;
  }
}
