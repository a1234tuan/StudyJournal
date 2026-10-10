import { useEffect, useLayoutEffect, useRef, useState } from "react";

const hexColor = (value: string) => {
  const match = /^rgb\((\d+),\s*(\d+),\s*(\d+)\)$/.exec(value);
  return match ? "#" + match.slice(1).map(channel => Number(channel).toString(16).padStart(2, "0")).join("") : null;
};

export const DesktopTitleBar = () => {
  const [state, setState] = useState<StudyJournalWindowChromeState | null>(null);
  const [documentFullscreen, setDocumentFullscreen] = useState(Boolean(document.fullscreenElement));
  const bar = useRef<HTMLDivElement>(null);
  const visible = Boolean(state?.enabled && !state.fullscreen && !documentFullscreen);

  useEffect(() => {
    const bridge = window.studyJournalDesktop?.windowChrome;
    if (!bridge) return;
    let active = true;
    let receivedEvent = false;
    const unsubscribe = bridge.onStateChange(next => {
      receivedEvent = true;
      if (active) setState(next);
    });
    void bridge.getState().then(next => {
      if (active && !receivedEvent) setState(next);
    }).catch(() => undefined);
    const onFullscreen = () => setDocumentFullscreen(Boolean(document.fullscreenElement));
    document.addEventListener("fullscreenchange", onFullscreen);
    return () => {
      active = false;
      unsubscribe();
      document.removeEventListener("fullscreenchange", onFullscreen);
    };
  }, []);

  useLayoutEffect(() => {
    if (visible) document.documentElement.dataset.desktopChrome = "true";
    else delete document.documentElement.dataset.desktopChrome;
    return () => { delete document.documentElement.dataset.desktopChrome; };
  }, [visible]);

  useEffect(() => {
    const bridge = window.studyJournalDesktop?.windowChrome;
    if (!visible || !bridge) return;
    let frame = 0;
    const update = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        if (!bar.current) return;
        const style = getComputedStyle(bar.current);
        const color = hexColor(style.backgroundColor);
        const symbolColor = hexColor(style.color);
        if (color && symbolColor) void bridge.setAppearance({ color, symbolColor }).catch(() => undefined);
      });
    };
    const observer = new MutationObserver(update);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme", "data-visual-theme"] });
    const queries = [matchMedia("(prefers-color-scheme: dark)"), matchMedia("(forced-colors: active)")];
    queries.forEach(query => query.addEventListener("change", update));
    update();
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      queries.forEach(query => query.removeEventListener("change", update));
    };
  }, [visible]);

  if (!visible) return null;
  return <div ref={bar} className="desktop-titlebar" aria-hidden="true"><span>学习日志</span></div>;
};
