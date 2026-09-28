import { App as CapacitorApp } from "@capacitor/app";
import { Capacitor } from "@capacitor/core";
import { useEffect, useState } from "react";

import { todayISO } from "../lib/date";

export const useLocalToday = () => {
  const [today, setToday] = useState(todayISO);

  useEffect(() => {
    let disposed = false;
    let timer: ReturnType<typeof setTimeout>;
    const update = () => {
      if (disposed) return;
      clearTimeout(timer);
      setToday(todayISO());
      const now = new Date();
      const midnight = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
      timer = setTimeout(update, Math.min(midnight.getTime() - now.getTime(), 60_000));
    };
    const onVisible = () => {
      if (document.visibilityState === "visible") update();
    };
    update();
    window.addEventListener("focus", update);
    document.addEventListener("visibilitychange", onVisible);
    const nativeListener = Capacitor.isNativePlatform()
      ? CapacitorApp.addListener("appStateChange", ({ isActive }) => {
        if (isActive) update();
      }).catch(() => undefined)
      : undefined;

    return () => {
      disposed = true;
      clearTimeout(timer);
      window.removeEventListener("focus", update);
      document.removeEventListener("visibilitychange", onVisible);
      void nativeListener?.then((listener) => listener?.remove()).catch(() => undefined);
    };
  }, []);

  return today;
};
