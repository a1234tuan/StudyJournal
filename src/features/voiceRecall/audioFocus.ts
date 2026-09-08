export type VoiceAudioFocusReason = "background" | "pagehide" | "focus-lost";

export class VoiceAudioFocusManager {
  private active = false;
  private removeDesktopListener?: () => void;

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
