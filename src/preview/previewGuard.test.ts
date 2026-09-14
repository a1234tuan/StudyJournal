import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * F-10 regression coverage.
 *
 * Both prototype shells originally gated on `window.location.hostname` alone. The
 * Capacitor Android WebView and the Electron shell *also* serve the bundle from a
 * `localhost` host, so that check did not exclude them: a deep link such as
 * `/?preview=ui-v2` reached the prototype shell inside the shipping app.
 */

const capacitor = vi.hoisted(() => ({
  isNativePlatform: vi.fn(() => false),
  getPlatform: vi.fn(() => "web"),
}));

vi.mock("@capacitor/core", () => ({
  Capacitor: capacitor,
  registerPlugin: vi.fn(() => ({})),
}));

const setLocation = (hostname: string, search = "") =>
  vi.stubGlobal("location", { hostname, search, href: `http://${hostname}/${search}`, pathname: "/", protocol: "http:" });

const setDesktop = (isDesktop: boolean) => {
  (window as unknown as { studyJournalDesktop?: { isDesktop: boolean } }).studyJournalDesktop = isDesktop
    ? { isDesktop: true }
    : undefined;
};

describe("prototype shell guards", () => {
  beforeEach(() => {
    capacitor.isNativePlatform.mockReturnValue(false);
    capacitor.getPlatform.mockReturnValue("web");
    setDesktop(false);
    setLocation("127.0.0.1", "?preview=ui-v2");
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    setDesktop(false);
    vi.resetModules();
  });

  const load = async () => {
    const ui = await import("./UiV2PrototypeApp");
    const voice = await import("./VoiceRecallPrototypeApp");
    return { ui, voice };
  };

  it("enables the shells on a local web origin", async () => {
    const { ui, voice } = await load();
    expect(ui.isUiV2PrototypeRequest()).toBe(true);

    setLocation("localhost", "?preview=voice-recall");
    expect(voice.isVoiceRecallPrototypeRequest()).toBe(true);
  });

  it("refuses the ui-v2 shell inside the native app even though it serves from localhost", async () => {
    capacitor.isNativePlatform.mockReturnValue(true);
    setLocation("localhost", "?preview=ui-v2");

    const { ui, voice } = await load();
    expect(ui.isUiV2PrototypeRequest()).toBe(false);
    expect(voice.isVoiceRecallPrototypeRequest()).toBe(false);
  });

  it("refuses the shells inside the desktop shell", async () => {
    setDesktop(true);
    setLocation("localhost", "?preview=voice-recall");

    const { voice } = await load();
    expect(voice.isVoiceRecallPrototypeRequest()).toBe(false);
  });

  it("still requires the host and the matching preview parameter", async () => {
    const { ui, voice } = await load();

    setLocation("127.0.0.1", "");
    expect(ui.isUiV2PrototypeRequest()).toBe(false);
    expect(voice.isVoiceRecallPrototypeRequest()).toBe(false);

    setLocation("127.0.0.1", "?preview=voice-recall");
    expect(ui.isUiV2PrototypeRequest()).toBe(false);

    setLocation("127.0.0.1", "?preview=ui-v2");
    expect(voice.isVoiceRecallPrototypeRequest()).toBe(false);

    setLocation("study.example.com", "?preview=ui-v2");
    expect(ui.isUiV2PrototypeRequest()).toBe(false);
    setLocation("study.example.com", "?preview=voice-recall");
    expect(voice.isVoiceRecallPrototypeRequest()).toBe(false);
  });
});
