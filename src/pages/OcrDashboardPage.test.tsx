import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { Asset, RecordBlock } from "../types";
import { buildOcrDashboardItems, OcrDashboardPanel } from "./OcrDashboardPage";

afterEach(cleanup);

const stamp = "2026-06-21T00:00:00.000Z";

const record = (id: string, assets: RecordBlock["assets"]): RecordBlock => ({
  id,
  createdAt: stamp,
  updatedAt: stamp,
  type: "record",
  date: "2026-06-21",
  order: 0,
  subject: "数学",
  tags: [],
  title: `日志 ${id}`,
  contentHtml: "<p>正文</p>",
  assets,
  formulas: [],
  mistakeRefs: [],
});

const asset = (id: string, status?: Asset["ocrStatus"]): Asset => ({
  id,
  createdAt: stamp,
  updatedAt: stamp,
  fileName: `${id}.png`,
  title: `图片 ${id}`,
  mimeType: "image/png",
  size: 1,
  kind: "image",
  data: new Blob([id], { type: "image/png" }),
  ocrStatus: status,
  ocrText: status === "done" ? "识别结果" : undefined,
});

describe("OCR dashboard", () => {
  it.each([undefined, "idle", "failed", "timeout", "done"] as const)("does not list usable results with local %s status as missing OCR", (status) => {
    const image = { ...asset("synced", status), ocrText: "来自另一端的识别结果", ocrError: "本机旧错误" };
    const records = [record("r1", [{ id: image.id, kind: "image", title: "图片" }])];
    expect(buildOcrDashboardItems(records, [image])).toEqual([]);
    render(<OcrDashboardPanel records={records} assets={[image]} onRetry={vi.fn()} />);
    expect(screen.getByText("没有待处理的图片")).toBeInTheDocument();
    expect(screen.queryByText(/本机旧错误/)).not.toBeInTheDocument();
    expect(image.ocrStatus).toBe(status);
  });

  it.each(["queued", "running"] as const)("keeps local %s work visible alongside an existing result", (status) => {
    const image = { ...asset("synced", status), ocrText: "已有识别结果" };
    const records = [record("r1", [{ id: image.id, kind: "image", title: "图片" }])];
    expect(buildOcrDashboardItems(records, [image])).toHaveLength(1);
    render(<OcrDashboardPanel records={records} assets={[image]} onRetry={vi.fn()} />);
    expect(screen.getByText(/已有可用 OCR 文字/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "重新 OCR" })).toBeEnabled();
  });

  it("keeps an empty successful result actionable", () => {
    const image = { ...asset("empty", "done"), ocrText: "   " };
    expect(buildOcrDashboardItems([record("r1", [{ id: image.id, kind: "image", title: "图片" }])], [image]))
      .toMatchObject([{ status: "idle" }]);
  });

  it("lists every referenced image that is not done and preserves log attribution", () => {
    const items = buildOcrDashboardItems(
      [record("r1", [
        { id: "a-idle", kind: "image", title: "未识别" },
        { id: "a-done", kind: "image", title: "已完成" },
      ])],
      [asset("a-idle"), asset("a-done", "done"), asset("orphan", "failed")],
    );

    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      key: "r1:a-idle",
      status: "idle",
      record: { id: "r1", title: "日志 r1" },
      asset: { id: "a-idle" },
    });
  });

  it("keeps queued, running, failed and timed-out states visible", () => {
    const records = [record("r1", [
      { id: "queued", kind: "image", title: "排队" },
      { id: "running", kind: "image", title: "识别" },
      { id: "failed", kind: "image", title: "失败" },
      { id: "timeout", kind: "image", title: "超时" },
    ])];
    const items = buildOcrDashboardItems(records, [
      asset("queued", "queued"),
      asset("running", "running"),
      asset("failed", "failed"),
      asset("timeout", "timeout"),
    ]);

    expect(items.map((item) => item.status)).toEqual(expect.arrayContaining(["queued", "running", "failed", "timeout"]));
  });
});
