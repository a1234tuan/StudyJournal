import { act, cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DesktopTitleBar } from "./DesktopTitleBar";

describe("desktop title bar", () => {
  let listener: (state: StudyJournalWindowChromeState) => void;
  let queries: EventTarget[];
  const unsubscribe = vi.fn();
  const setAppearance = vi.fn().mockResolvedValue(undefined);
  const installBridge = (getState = () => Promise.resolve({ enabled: true, fullscreen: false })) => {
    Object.defineProperty(window, "studyJournalDesktop", { configurable: true, value: {
      isDesktop: true,
      windowChrome: { getState, setAppearance, onStateChange: (next: typeof listener) => { listener = next; return unsubscribe; } },
    } });
  };

  beforeEach(() => {
    queries = [];
    vi.stubGlobal("matchMedia", () => { const target = new EventTarget(); queries.push(target); return target; });
    vi.stubGlobal("requestAnimationFrame", (callback: () => void) => window.setTimeout(callback, 0));
    vi.stubGlobal("cancelAnimationFrame", (handle: number) => window.clearTimeout(handle));
    vi.spyOn(window, "getComputedStyle").mockReturnValue({ backgroundColor: "rgb(255, 253, 248)", color: "rgb(51, 47, 41)" } as CSSStyleDeclaration);
    setAppearance.mockReset().mockResolvedValue(undefined);
    unsubscribe.mockClear();
  });

  afterEach(() => {
    cleanup();
    delete window.studyJournalDesktop;
    delete document.documentElement.dataset.theme;
    delete document.documentElement.dataset.visualTheme;
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("does not add chrome in web, mobile or an older desktop host", async () => {
    const view = render(<DesktopTitleBar />);
    expect(view.container).toBeEmptyDOMElement();
    expect(document.documentElement.dataset.desktopChrome).toBeUndefined();
    expect(setAppearance).not.toHaveBeenCalled();
  });

  it("syncs resolved colors after theme and system changes and cleans up listeners", async () => {
    installBridge();
    const view = render(<DesktopTitleBar />);
    await waitFor(() => expect(document.documentElement.dataset.desktopChrome).toBe("true"));
    await waitFor(() => expect(setAppearance).toHaveBeenCalledWith({ color: "#fffdf8", symbolColor: "#332f29" }));
    setAppearance.mockClear();
    act(() => { document.documentElement.dataset.visualTheme = "modern"; });
    await waitFor(() => expect(setAppearance).toHaveBeenCalledOnce());
    setAppearance.mockClear();
    act(() => queries[0].dispatchEvent(new Event("change")));
    await waitFor(() => expect(setAppearance).toHaveBeenCalledOnce());
    view.unmount();
    expect(unsubscribe).toHaveBeenCalledOnce();
    expect(document.documentElement.dataset.desktopChrome).toBeUndefined();
    setAppearance.mockClear();
    act(() => queries[0].dispatchEvent(new Event("change")));
    expect(setAppearance).not.toHaveBeenCalled();
  });

  it("hides in native fullscreen and restores the content inset on exit", async () => {
    installBridge();
    const view = render(<DesktopTitleBar />);
    await waitFor(() => expect(view.container.querySelector(".desktop-titlebar")).not.toBeNull());
    act(() => listener({ enabled: true, fullscreen: true }));
    expect(view.container).toBeEmptyDOMElement();
    expect(document.documentElement.dataset.desktopChrome).toBeUndefined();
    act(() => listener({ enabled: true, fullscreen: false }));
    expect(view.container.querySelector(".desktop-titlebar")).not.toBeNull();
    expect(document.documentElement.dataset.desktopChrome).toBe("true");
  });

  it("does not let a late initial response overwrite a fullscreen event", async () => {
    let resolve!: (state: StudyJournalWindowChromeState) => void;
    installBridge(() => new Promise(done => { resolve = done; }));
    const view = render(<DesktopTitleBar />);
    act(() => listener({ enabled: true, fullscreen: true }));
    await act(async () => resolve({ enabled: true, fullscreen: false }));
    expect(view.container).toBeEmptyDOMElement();
    expect(document.documentElement.dataset.desktopChrome).toBeUndefined();
  });

  it("does not render an extra title bar on unsupported hosts", async () => {
    installBridge(() => Promise.resolve({ enabled: false, fullscreen: false }));
    const view = render(<DesktopTitleBar />);
    await act(async () => {});
    expect(view.container).toBeEmptyDOMElement();
    expect(setAppearance).not.toHaveBeenCalled();
  });
});
