import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Asset } from "../types";
import { AssetPreview } from "./AssetPreview";

const storageMock = vi.hoisted(() => ({ getAsset: vi.fn() }));
vi.mock("../services/storageAdapter", () => ({ storage: storageMock }));
vi.mock("../services/ocrJobService", () => ({ runOcrForAsset: vi.fn() }));
vi.mock("../services/assetDownloadService", () => ({ downloadAsset: vi.fn() }));
vi.mock("./PlaybackProvider", () => ({ usePlayback: () => ({ nativeAvailable: false }) }));

const image: Asset = {
  id: "image", kind: "image", fileName: "image.png", mimeType: "image/png", size: 1,
  data: new Blob(["image"], { type: "image/png" }),
  createdAt: "2026-09-26T00:00:00Z", updatedAt: "2026-09-26T00:00:00Z",
};

beforeEach(() => {
  vi.stubGlobal("URL", { createObjectURL: vi.fn(() => "blob:test"), revokeObjectURL: vi.fn() });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("AssetPreview OCR results and local tasks", () => {
  it.each(["view", "edit"] as const)("shows a synced result as usable in %s mode despite an old failure", async (mode) => {
    storageMock.getAsset.mockResolvedValue({ ...image, ocrText: "已同步的识别结果", ocrStatus: "failed", ocrError: "本机旧错误" });
    const { container } = render(<AssetPreview assetId={image.id} variant="image" mode={mode} />);
    expect(await screen.findByText("OCR✅")).toBeInTheDocument();
    expect(screen.queryByText("OCR失败")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "重新 OCR" })).not.toBeInTheDocument();
    expect(container.querySelector(".status-message")).toBeNull();
    if (mode === "edit") {
      fireEvent.click(screen.getByRole("button", { name: "OCR 详情" }));
      expect(screen.getByText("本机任务状态")).toBeInTheDocument();
      expect(screen.getByText("failed")).toBeInTheDocument();
      expect(screen.getByText("本机旧错误")).toBeInTheDocument();
      expect(screen.getByText("图片 OCR 文本已参与 AI 问答。")).toBeInTheDocument();
    }
  });

  it.each(["queued", "running"] as const)("shows a usable result without hiding the local %s task", async (status) => {
    storageMock.getAsset.mockResolvedValue({ ...image, ocrText: "已有结果", ocrStatus: status });
    render(<AssetPreview assetId={image.id} variant="image" />);
    expect(await screen.findByText(status === "queued" ? "OCR✅ · 本机排队中" : "OCR✅ · 本机识别中")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /OCR$/ })).not.toBeInTheDocument();
  });

  it("keeps a failure with no usable result visible and retryable", async () => {
    storageMock.getAsset.mockResolvedValue({ ...image, ocrText: "   ", ocrStatus: "failed", ocrError: "识别失败" });
    render(<AssetPreview assetId={image.id} variant="image" />);
    expect(await screen.findByText("OCR：失败")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "重新 OCR" })).toBeEnabled();
    expect(screen.getByText("识别失败")).toBeInTheDocument();
  });
});
