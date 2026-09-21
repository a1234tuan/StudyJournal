import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Asset, RecordBlock } from "../types";

const stamp = "2026-06-21T00:00:00.000Z";
const blob = new Blob(["image"], { type: "image/png" });
const assetStore = new Map<string, Asset>();

vi.mock("./storageAdapter", () => ({
  storage: {
    getAsset: vi.fn((id: string) => Promise.resolve(assetStore.get(id))),
    patchAsset: vi.fn((id: string, patch: Partial<Asset>) => {
      const existing = assetStore.get(id);
      if (!existing) {
        return Promise.resolve(undefined);
      }
      const saved = { ...existing, ...patch, data: existing.data, updatedAt: stamp };
      assetStore.set(id, saved);
      return Promise.resolve(saved);
    }),
  },
}));

vi.mock("./ocrService", () => ({
  runPaddleOcr: vi.fn(async () => "识别出来的文字"),
}));

describe("ocrJobService", () => {
  it("does not automatically re-recognize an accepted synced result", async () => {
    const { enqueueAutoOcrForRecord } = await import("./ocrJobService");
    const { runPaddleOcr } = await import("./ocrService");
    assetStore.set("a1", { ...assetStore.get("a1")!, ocrText: "synced result", ocrStatus: "idle" });
    await enqueueAutoOcrForRecord({ assets: [{ id: "a1", kind: "image", title: "image" }] } as RecordBlock);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(runPaddleOcr).not.toHaveBeenCalled();
  });
  beforeEach(() => {
    assetStore.clear();
    assetStore.set("a1", {
      id: "a1",
      createdAt: stamp,
      updatedAt: stamp,
      fileName: "note.png",
      title: "截图",
      mimeType: "image/png",
      size: 5,
      kind: "image",
      data: blob,
    });
    vi.clearAllMocks();
  });

  afterEach(async () => {
    const { resetOcrQueueForTests } = await import("./ocrJobService");
    resetOcrQueueForTests();
    vi.useRealTimers();
  });

  it("updates OCR metadata without replacing image blob", async () => {
    const { runOcrForAsset } = await import("./ocrJobService");

    const updated = await runOcrForAsset("a1", { force: true });

    expect(updated?.ocrStatus).toBe("done");
    expect(updated?.ocrText).toBe("识别出来的文字");
    expect(updated?.data).toBe(blob);
    expect(assetStore.get("a1")?.data).toBe(blob);
  });

  it("queues only idle image refs for auto OCR", async () => {
    const { enqueueAutoOcrForRecord } = await import("./ocrJobService");
    const { runPaddleOcr } = await import("./ocrService");
    const record: RecordBlock = {
      id: "r1",
      createdAt: stamp,
      updatedAt: stamp,
      type: "record",
      date: "2026-06-21",
      order: 0,
      subject: "数据结构",
      tags: [],
      title: "数据结构记录块1",
      contentHtml: "<p></p>",
      assets: [
        { id: "a1", title: "截图", kind: "image" },
        { id: "missing-audio", title: "录音", kind: "audio" },
      ],
      formulas: [],
      mistakeRefs: [],
    };

    enqueueAutoOcrForRecord(record);
    await new Promise((resolve) => window.setTimeout(resolve, 0));

    expect(runPaddleOcr).toHaveBeenCalledTimes(1);
  });

  it("runs OCR jobs one at a time across different images", async () => {
    assetStore.set("a2", {
      ...assetStore.get("a1")!,
      id: "a2",
      fileName: "second.png",
    });
    const { runPaddleOcr } = await import("./ocrService");
    const { runOcrForAsset } = await import("./ocrJobService");
    let completeFirst!: (value: string) => void;
    vi.mocked(runPaddleOcr).mockImplementationOnce(
      () => new Promise((resolve) => {
        completeFirst = resolve;
      }),
    );
    vi.mocked(runPaddleOcr).mockResolvedValueOnce("第二张图片");

    const first = runOcrForAsset("a1");
    await vi.waitFor(() => expect(runPaddleOcr).toHaveBeenCalledTimes(1));
    const second = runOcrForAsset("a2");
    await new Promise((resolve) => window.setTimeout(resolve, 0));

    expect(runPaddleOcr).toHaveBeenCalledTimes(1);
    completeFirst("第一张图片");
    await Promise.all([first, second]);

    expect(runPaddleOcr).toHaveBeenCalledTimes(2);
    expect(vi.mocked(runPaddleOcr).mock.calls.map(([asset]) => asset.id)).toEqual(["a1", "a2"]);
  });

  it("promotes a waiting manual OCR ahead of automatic jobs without duplicating it", async () => {
    for (const id of ["a2", "a3"]) {
      assetStore.set(id, {
        ...assetStore.get("a1")!,
        id,
        fileName: `${id}.png`,
      });
    }
    const { runPaddleOcr } = await import("./ocrService");
    const { runOcrForAsset } = await import("./ocrJobService");
    const calls: string[] = [];
    let completeFirst!: (value: string) => void;
    vi.mocked(runPaddleOcr).mockImplementation((asset) => {
      calls.push(asset.id);
      if (asset.id === "a1") {
        return new Promise((resolve) => {
          completeFirst = resolve;
        });
      }
      return Promise.resolve(asset.id);
    });

    const first = runOcrForAsset("a1");
    await vi.waitFor(() => expect(calls).toEqual(["a1"]));
    const autoSecond = runOcrForAsset("a2");
    const autoThird = runOcrForAsset("a3");
    const manualSecond = runOcrForAsset("a2", { force: true });
    completeFirst("a1");

    await Promise.all([first, autoSecond, autoThird, manualSecond]);

    expect(calls).toEqual(["a1", "a2", "a3"]);
  });

  it("retries the upstream queue-full response after backoff and retains its trace id", async () => {
    vi.useFakeTimers();
    const { runPaddleOcr } = await import("./ocrService");
    const { OCR_QUEUE_TESTING, runOcrForAsset } = await import("./ocrJobService");
    vi.mocked(runPaddleOcr)
      .mockRejectedValueOnce(new Error('OCR 提交失败：400 {"traceId":"trace-10010","code":10010,"msg":"任务提交队列已满"}'))
      .mockResolvedValueOnce("识别成功");

    const pending = runOcrForAsset("a1", { force: true });
    await vi.advanceTimersByTimeAsync(0);

    expect(assetStore.get("a1")?.ocrStatus).toBe("queued");
    expect(assetStore.get("a1")?.ocrError).toContain("第 1 次重试");
    expect(assetStore.get("a1")?.ocrError).toContain("trace-10010");

    await vi.advanceTimersByTimeAsync(OCR_QUEUE_TESTING.retryDelaysMs[0]);
    await expect(pending).resolves.toMatchObject({ ocrStatus: "done", ocrText: "识别成功" });
    expect(runPaddleOcr).toHaveBeenCalledTimes(2);
  });

  it("fails only after all queue-full retries are exhausted", async () => {
    vi.useFakeTimers();
    const queueFull = new Error('OCR_QUEUE_FULL: 百度 OCR 服务端任务队列已满。traceId=trace-final');
    const { runPaddleOcr } = await import("./ocrService");
    const { OCR_QUEUE_TESTING, runOcrForAsset } = await import("./ocrJobService");
    vi.mocked(runPaddleOcr).mockRejectedValue(queueFull);

    const pending = runOcrForAsset("a1", { force: true });
    const rejected = expect(pending).rejects.toThrow("已自动重试 5 次");
    await vi.advanceTimersByTimeAsync(0);
    for (const delay of OCR_QUEUE_TESTING.retryDelaysMs) {
      await vi.advanceTimersByTimeAsync(delay);
    }

    await rejected;
    expect(runPaddleOcr).toHaveBeenCalledTimes(6);
    expect(assetStore.get("a1")?.ocrStatus).toBe("failed");
    expect(assetStore.get("a1")?.ocrError).toContain("trace-final");
  });

  it("marks completed empty OCR result as failed with a clear message", async () => {
    const { runPaddleOcr } = await import("./ocrService");
    vi.mocked(runPaddleOcr).mockResolvedValueOnce("");
    const { runOcrForAsset } = await import("./ocrJobService");

    await expect(runOcrForAsset("a1", { force: true })).rejects.toThrow("上游返回空 OCR 文本");

    expect(assetStore.get("a1")?.ocrStatus).toBe("failed");
    expect(assetStore.get("a1")?.ocrError).toBe("上游返回空 OCR 文本。");
    expect(assetStore.get("a1")?.ocrResultSummary?.includedInAi).toBe(false);
  });
});
