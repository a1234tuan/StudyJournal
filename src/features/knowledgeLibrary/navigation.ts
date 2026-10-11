import type { KnowledgeOwner } from "./domain";

export interface KnowledgeNavigation {
  libraryId?: string;
  recoveryView?: boolean;
  workspaceId?: string;
  selectedNodeId?: string;
  view: "outline" | "map";
  query: string;
  collapsed: string[];
  zoom: number;
  panX: number;
  panY: number;
  scrollTop: number;
  scrollLibraryId?: string;
  scrollWorkspaceId?: string;
  addRecordId?: string;
  detailsOpen?: boolean;
  recordPreviewId?: string;
  recordPaneWidth?: number;
  recordPreviewScroll?: number;
  sidebarCollapsed?: boolean;
  mapWorkspaceId?: string;
  mapSides?: Record<string, number>;
}
export const initialKnowledgeNavigation = (): KnowledgeNavigation => ({ view: "map", query: "", collapsed: [], zoom: 1, panX: 0, panY: 0, scrollTop: 0 });

export const patchKnowledgeNavigation = (current: KnowledgeNavigation, patch: Partial<KnowledgeNavigation>): KnowledgeNavigation => {
  if (patch.scrollWorkspaceId && (patch.scrollWorkspaceId !== current.workspaceId || (current.libraryId && patch.scrollLibraryId !== current.libraryId))) return current;
  const next = { ...current, ...patch };
  if (next.libraryId !== current.libraryId || next.workspaceId !== current.workspaceId || next.selectedNodeId !== current.selectedNodeId || patch.detailsOpen === false) {
    if (!("recordPreviewId" in patch)) next.recordPreviewId = undefined;
  }
  if (next.recordPreviewId !== current.recordPreviewId) next.recordPreviewScroll = 0;
  if (next.libraryId !== current.libraryId || next.workspaceId !== current.workspaceId) {
    next.scrollTop = 0;
    next.scrollLibraryId = next.libraryId;
    next.scrollWorkspaceId = next.workspaceId;
  }
  return next;
};
export const knowledgeOutlineScroll = (navigation: KnowledgeNavigation, libraryId: string | undefined, workspaceId: string): number =>
  navigation.scrollLibraryId === libraryId && navigation.scrollWorkspaceId === workspaceId ? navigation.scrollTop : 0;

export const restoreKnowledgeNavigation = (input: unknown): KnowledgeNavigation => {
  if (!input || typeof input !== "object") return initialKnowledgeNavigation();
  const value = input as Record<string, unknown>;
  const identifier = (candidate: unknown): string | undefined => typeof candidate === "string" && candidate.length <= 200 ? candidate : undefined;
  const finite = (candidate: unknown, fallback: number): number => typeof candidate === "number" && Number.isFinite(candidate) ? candidate : fallback;
  return { recoveryView: value.recoveryView === true, scrollLibraryId: identifier(value.scrollLibraryId), scrollWorkspaceId: identifier(value.scrollWorkspaceId), mapWorkspaceId: identifier(value.mapWorkspaceId), mapSides: value.mapSides && typeof value.mapSides === "object" ? Object.fromEntries(Object.entries(value.mapSides).filter(([id, side]) => id.length <= 200 && (side === -1 || side === 1 || side === -2 || side === 2)).slice(0, 10000)) : {}, detailsOpen: value.detailsOpen === true, recordPreviewId: identifier(value.recordPreviewId), recordPaneWidth: value.recordPaneWidth === undefined ? undefined : Math.min(560, Math.max(360, finite(value.recordPaneWidth, 420))), recordPreviewScroll: Math.max(0, finite(value.recordPreviewScroll, 0)), sidebarCollapsed: value.sidebarCollapsed === true, libraryId: identifier(value.libraryId), workspaceId: identifier(value.workspaceId), selectedNodeId: identifier(value.selectedNodeId), addRecordId: identifier(value.addRecordId), view: value.view === "outline" ? "outline" : "map", query: typeof value.query === "string" ? value.query.slice(0, 1000) : "", collapsed: Array.isArray(value.collapsed) ? value.collapsed.filter((item): item is string => typeof item === "string" && item.length <= 200).slice(0, 10000) : [], zoom: Math.min(2, Math.max(0.2, finite(value.zoom, 1))), panX: finite(value.panX, 0), panY: finite(value.panY, 0), scrollTop: Math.max(0, finite(value.scrollTop, 0)) };
};


const lastTopicKey = (owner: KnowledgeOwner) => "study-journal-knowledge-last-topic:" + encodeURIComponent(owner);
const validTopicId = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= 200;

export const loadKnowledgeNavigation = (owner: KnowledgeOwner): KnowledgeNavigation => {
  const initial = initialKnowledgeNavigation();
  try {
    const saved: unknown = JSON.parse(localStorage.getItem(lastTopicKey(owner)) ?? "null");
    if (!saved || typeof saved !== "object") return initial;
    const value = saved as Record<string, unknown>;
    return value.version === 1 && validTopicId(value.libraryId) && validTopicId(value.workspaceId)
      ? { ...initial, libraryId: value.libraryId, workspaceId: value.workspaceId } : initial;
  } catch { return initial; }
};

export const rememberKnowledgeTopic = (owner: KnowledgeOwner, libraryId: string, workspaceId: string): void => {
  if (!validTopicId(libraryId) || !validTopicId(workspaceId)) return;
  try { localStorage.setItem(lastTopicKey(owner), JSON.stringify({ version: 1, libraryId, workspaceId })); } catch {}
};
