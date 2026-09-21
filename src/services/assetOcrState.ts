import type { Asset } from "../types";

export const ASSET_OPERATIONAL_FIELDS = ["ocrStatus", "ocrError", "ocrJobId", "ocrUpdatedAt", "ocrResultSummary"] as const;

export const stripAssetOperationalFields = (value: unknown): unknown => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  return Object.fromEntries(Object.entries(value).filter(([key]) =>
    !ASSET_OPERATIONAL_FIELDS.some((field) => field === key)));
};

export const restoreAssetOcrState = (incoming: Asset, current?: Asset): Asset => {
  const portable = stripAssetOperationalFields(incoming) as Asset;
  const operational = current ? Object.fromEntries(ASSET_OPERATIONAL_FIELDS
    .filter((key) => current[key] !== undefined)
    .map((key) => [key, current[key]])) : {};
  return {
    ...portable,
    ...(incoming.kind === "image" ? { ocrStatus: incoming.ocrText?.trim() ? "done" as const : "idle" as const } : {}),
    ...operational,
  };
};
