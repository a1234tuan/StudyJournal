import { App as CapacitorApp } from "@capacitor/app";
import { Capacitor } from "@capacitor/core";
import { useCallback, useEffect, useRef, useState } from "react";
import { todayISO } from "../lib/date";

export const DAILY_PLAN_REMINDER_KEY = "study-journal-daily-plan-reminder-date";
const sessionSeen = new Set<string>();

export const hasSeenDailyPlanReminder = (date: string): boolean => {
  try { return localStorage.getItem(DAILY_PLAN_REMINDER_KEY) === date || sessionSeen.has(date); }
  catch { return sessionSeen.has(date); }
};

export const claimDailyPlanReminder = async (date: string, isReady: () => boolean): Promise<boolean> => {
  const claim = () => {
    if (!isReady() || todayISO() !== date || hasSeenDailyPlanReminder(date)) return false;
    try { localStorage.setItem(DAILY_PLAN_REMINDER_KEY, date); } catch { sessionSeen.add(date); }
    return true;
  };
  try {
    return navigator.locks ? await navigator.locks.request(DAILY_PLAN_REMINDER_KEY, claim) : claim();
  } catch { return false; }
};

const otherOverlayOpen = () => Array.from(document.querySelectorAll<HTMLElement>('dialog[open], [aria-modal="true"], .image-lightbox'))
  .some(element => !element.closest('.daily-plan-reminder') && !element.closest('[aria-hidden="true"]') && element.getClientRects().length > 0);

export const useDailyPlanReminder = (eligible: boolean) => {
  const [activation, setActivation] = useState(() => ({ date: todayISO(), foreground: document.visibilityState !== "hidden", sequence: 0 }));
  const [shownDate, setShownDate] = useState<string>();
  const [checked, setChecked] = useState(false);
  const readyRef = useRef(false);
  readyRef.current = eligible && activation.foreground;
  const dismiss = useCallback(() => setShownDate(undefined), []);

  useEffect(() => {
    let disposed = false;
    const activate = () => {
      if (disposed || document.visibilityState === "hidden") return;
      setActivation(current => ({ date: todayISO(), foreground: true, sequence: current.sequence + 1 }));
    };
    const background = () => { if (disposed) return; readyRef.current = false; setActivation(current => ({ ...current, foreground: false })); setShownDate(undefined); };
    const visibility = () => { if (document.visibilityState === "hidden") background(); else activate(); };
    window.addEventListener("focus", activate);
    document.addEventListener("visibilitychange", visibility);
    const native = Capacitor.isNativePlatform()
      ? CapacitorApp.addListener("appStateChange", ({ isActive }) => { if (isActive) activate(); else background(); }).catch(() => undefined)
      : undefined;
    return () => {
      disposed = true;
      window.removeEventListener("focus", activate);
      document.removeEventListener("visibilitychange", visibility);
      void native?.then(listener => listener?.remove()).catch(() => undefined);
    };
  }, []);

  useEffect(() => {
    if (!eligible || !activation.foreground) { setShownDate(undefined); return; }
    if (hasSeenDailyPlanReminder(activation.date)) { setChecked(true); return; }
    setChecked(false);
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    const ready = () => !cancelled && readyRef.current && document.visibilityState !== "hidden" && !otherOverlayOpen();
    const attempt = async () => {
      if (cancelled) return;
      if (!ready()) { timer = setTimeout(() => void attempt(), 500); return; }
      const claimed = await claimDailyPlanReminder(activation.date, ready);
      if (cancelled) return;
      if (!claimed && !hasSeenDailyPlanReminder(activation.date) && todayISO() === activation.date) { timer = setTimeout(() => void attempt(), 500); return; }
      if (claimed) setShownDate(activation.date);
      setChecked(true);
    };
    timer = setTimeout(() => void attempt(), 700);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [eligible, activation]);

  return { open: Boolean(shownDate && shownDate === activation.date && eligible && activation.foreground), date: activation.date, checked, dismiss };
};
