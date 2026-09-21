import { describe, expect, it } from "vitest";
import type { Asset } from "../types";
import { ASSET_OPERATIONAL_FIELDS, restoreAssetOcrState } from "./assetOcrState";
import { describeOcrForAi } from "./ocrDiagnostics";

const image: Asset = {
  id: "image", createdAt: "2026-09-21T00:00:00Z", updatedAt: "2026-09-21T00:00:00Z",
  kind: "image", fileName: "test.png", mimeType: "image/png", size: 4, data: new Blob(["test"]),
};

describe("local OCR state and portable results", () => {
  it.each(["idle", "running", "failed", "timeout"] as const)("uses accepted text independently of local %s state", (status) => {
    const restored = restoreAssetOcrState({ ...image, ocrText: "accepted result", ocrJobId: "foreign-job", ocrError: "foreign-error" }, { ...image, ocrStatus: status, ocrJobId: "local-job" });
    expect(restored.ocrStatus).toBe(status);
    expect(restored.ocrJobId).toBe("local-job");
    expect(restored.ocrError).toBeUndefined();
    expect(describeOcrForAi(restored).included).toBe(true);
  });

  it("does not inherit foreign jobs on a new device", () => {
    const restored = restoreAssetOcrState({ ...image, ocrText: "accepted", ocrStatus: "running", ocrJobId: "foreign", ocrError: "foreign" });
    expect(restored.ocrStatus).toBe("done");
    for (const key of ASSET_OPERATIONAL_FIELDS.filter((field) => field !== "ocrStatus")) expect(restored[key]).toBeUndefined();
  });

  it.each([undefined, "", "   "])("does not treat empty OCR as usable", (ocrText) => {
    const restored = restoreAssetOcrState({ ...image, ocrText, ocrStatus: "done" });
    expect(restored.ocrStatus).toBe("idle");
    expect(describeOcrForAi(restored).included).toBe(false);
  });
});
