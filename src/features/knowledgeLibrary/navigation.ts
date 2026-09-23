export interface KnowledgeNavigation {
  libraryId?: string;
  workspaceId?: string;
  selectedNodeId?: string;
  view: "outline" | "map";
  query: string;
  collapsed: string[];
  zoom: number;
  panX: number;
  panY: number;
  scrollTop: number;
  addRecordId?: string;
  detailsOpen?: boolean;
  mapWorkspaceId?: string;
  mapSides?: Record<string, number>;
}
export const initialKnowledgeNavigation = (): KnowledgeNavigation => ({ view: "outline", query: "", collapsed: [], zoom: 1, panX: 0, panY: 0, scrollTop: 0 });
export const restoreKnowledgeNavigation = (input: unknown): KnowledgeNavigation => {
  if (!input || typeof input !== "object") return initialKnowledgeNavigation();
  const value = input as Record<string, unknown>;
  const identifier = (candidate: unknown): string | undefined => typeof candidate === "string" && candidate.length <= 200 ? candidate : undefined;
  const finite = (candidate: unknown, fallback: number): number => typeof candidate === "number" && Number.isFinite(candidate) ? candidate : fallback;
  return { mapWorkspaceId: identifier(value.mapWorkspaceId), mapSides: value.mapSides && typeof value.mapSides === "object" ? Object.fromEntries(Object.entries(value.mapSides).filter(([id, side]) => id.length <= 200 && (side === -1 || side === 1)).slice(0, 10000)) : {}, detailsOpen: value.detailsOpen === true, libraryId: identifier(value.libraryId), workspaceId: identifier(value.workspaceId), selectedNodeId: identifier(value.selectedNodeId), addRecordId: identifier(value.addRecordId), view: value.view === "map" ? "map" : "outline", query: typeof value.query === "string" ? value.query.slice(0, 1000) : "", collapsed: Array.isArray(value.collapsed) ? value.collapsed.filter((item): item is string => typeof item === "string" && item.length <= 200).slice(0, 10000) : [], zoom: Math.min(2, Math.max(0.2, finite(value.zoom, 1))), panX: finite(value.panX, 0), panY: finite(value.panY, 0), scrollTop: Math.max(0, finite(value.scrollTop, 0)) };
};
