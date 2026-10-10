export const SIDEBAR_LAYOUT_KEY = "study-journal-sidebar-layout-v1";
export const SIDEBAR_DEFAULT_WIDTH = 208;
export const SIDEBAR_MIN_WIDTH = 192;
export const SIDEBAR_MAX_WIDTH = 320;
export const SIDEBAR_RAIL_WIDTH = 64;
export const SIDEBAR_BREAKPOINT = 920;

export interface SidebarPreference {
  collapsed: boolean;
  width: number;
}

export function normalizeSidebarPreference(value: unknown): SidebarPreference {
  const data = value && typeof value === "object" ? value as Partial<SidebarPreference> : {};
  return {
    collapsed: data.collapsed === true,
    width: typeof data.width === "number" && Number.isFinite(data.width)
      ? Math.round(Math.max(SIDEBAR_MIN_WIDTH, Math.min(SIDEBAR_MAX_WIDTH, data.width)))
      : SIDEBAR_DEFAULT_WIDTH,
  };
}

export function readSidebarPreference(): SidebarPreference | undefined {
  try {
    const stored = localStorage.getItem(SIDEBAR_LAYOUT_KEY);
    return stored === null ? undefined : normalizeSidebarPreference(JSON.parse(stored));
  } catch { return undefined; }
}

export function writeSidebarPreference(value: SidebarPreference) {
  try { localStorage.setItem(SIDEBAR_LAYOUT_KEY, JSON.stringify(normalizeSidebarPreference(value))); } catch { return; }
}

export function sidebarWidthLimit(viewport: number) {
  return Math.max(SIDEBAR_MIN_WIDTH, Math.min(SIDEBAR_MAX_WIDTH, Math.floor(viewport - 720)));
}

export function effectiveSidebarWidth(preference: SidebarPreference, viewport: number, availableWidth = viewport) {
  if (viewport <= SIDEBAR_BREAKPOINT) return 0;
  return preference.collapsed ? SIDEBAR_RAIL_WIDTH : Math.min(preference.width, sidebarWidthLimit(availableWidth));
}
