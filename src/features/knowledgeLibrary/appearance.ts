export const NODE_COLORS = ["default", "yellow", "green", "blue", "purple", "orange"] as const;
export type NodeColor = typeof NODE_COLORS[number];
export interface NodeAppearance { background: NodeColor; color: NodeColor; bold: boolean }
export interface MapAppearance { structure: "balanced" | "logic" | "radial"; line: "curve" | "straight" | "elbow" }
export const DEFAULT_NODE_APPEARANCE: NodeAppearance = { background: "default", color: "default", bold: false };
export const DEFAULT_MAP_APPEARANCE: MapAppearance = { structure: "balanced", line: "curve" };
export const COLOR_LABELS: Record<NodeColor, string> = { default: "默认", yellow: "黄色", green: "绿色", blue: "蓝色", purple: "紫色", orange: "橙色" };
export const STRUCTURE_LABELS = { balanced: "双向导图", radial: "四向发散", logic: "单向逻辑图" } as const;
export const LINE_LABELS = { curve: "曲线", straight: "直线", elbow: "折线" } as const;
export function isNodeAppearance(value: unknown): value is NodeAppearance {
  if (!value || typeof value !== "object") return false;
  const style = value as NodeAppearance;
  return Object.keys(value).sort().join(",") === "background,bold,color" && NODE_COLORS.includes(style.background) && NODE_COLORS.includes(style.color) && typeof style.bold === "boolean";
}
export function isMapAppearance(value: unknown): value is MapAppearance {
  if (!value || typeof value !== "object") return false;
  const style = value as MapAppearance;
  return Object.keys(value).sort().join(",") === "line,structure" && Object.hasOwn(STRUCTURE_LABELS, style.structure) && Object.hasOwn(LINE_LABELS, style.line);
}
export function describeAppearance(value: unknown): string {
  if (isNodeAppearance(value)) return "背景：" + COLOR_LABELS[value.background] + "；文字：" + COLOR_LABELS[value.color] + "；" + (value.bold ? "加粗" : "常规");
  if (isMapAppearance(value)) return STRUCTURE_LABELS[value.structure] + " · " + LINE_LABELS[value.line];
  return String(value ?? "");
}
