import { afterEach, describe, expect, it, vi } from "vitest";

import type { Asset } from "../types";
import { extractOcrTextFromJson, extractOcrTextFromJsonl, extractPaddleOcrText, runPaddleOcr, runPaddleOcrViaBrowserFetch } from "./ocrService";

const ocrSettingsMock = vi.hoisted(() => ({ getPaddleOcrToken: vi.fn(async () => "test-token") }));
const nativeOcrMock = vi.hoisted(() => ({ canUseNativeOcr: vi.fn(() => false), runNativeOcr: vi.fn() }));
const desktopOcrMock = vi.hoisted(() => ({ canUseDesktopOcr: vi.fn(() => false), runDesktopOcr: vi.fn() }));

vi.mock("./ocrSettings", () => ocrSettingsMock);
vi.mock("./nativeOcr", () => nativeOcrMock);
vi.mock("./desktopOcr", () => desktopOcrMock);

describe("extractOcrTextFromJsonl", () => {
  it("extracts markdown text from PaddleOCR jsonl", () => {
    const jsonl = [
      JSON.stringify({
        result: {
          layoutParsingResults: [
            { markdown: { text: "第一段 OCR 文本" } },
            { markdown: { text: "第二段 OCR 文本" } },
          ],
        },
      }),
    ].join("\n");

    expect(extractOcrTextFromJsonl(jsonl)).toBe("第一段 OCR 文本\n\n第二段 OCR 文本");
  });

  it("extracts markdown text from nested PaddleOCR json", () => {
    expect(
      extractOcrTextFromJson({
        data: {
          result: {
            layoutParsingResults: [
              { markdown: { text: "嵌套 OCR 文本" } },
            ],
          },
        },
      }),
    ).toBe("嵌套 OCR 文本");
  });

  it("returns empty text when OCR json contains no markdown text", () => {
    expect(extractOcrTextFromJson({ result: { layoutParsingResults: [] } })).toBe("");
  });

  it("extracts text from common PaddleOCR fallback fields", () => {
    expect(
      extractPaddleOcrText({
        data: {
          result: {
            recTexts: ["倒置手写第一行", "倒置手写第二行"],
            blocks: [
              { recText: "单行识别文本" },
            ],
          },
        },
      }),
    ).toBe("倒置手写第一行\n\n倒置手写第二行\n\n单行识别文本");
  });
});

/**
 * F-19: `runPaddleOcrViaBrowserFetch` is deliberately retained but not wired up.
 *
 * These tests pin the decision in both directions: the browser implementation must
 * keep working (so a future proxy/direct-connect effort can build on it), and the
 * production entry point must keep refusing on web (so nobody silently routes real
 * users through an unvalidated CORS/credential path).
 */
describe("PaddleOCR entry points", () => {
  const stamp = "2026-09-14T00:00:00.000Z";
  const imageAsset = (): Asset => ({
    id: "asset-image",
    createdAt: stamp,
    updatedAt: stamp,
    fileName: "page.png",
    mimeType: "image/png",
    size: 3,
    kind: "image",
    data: new Blob(["img"]),
  });
  const audioAsset = (): Asset => ({ ...imageAsset(), id: "asset-audio", kind: "audio", fileName: "clip.m4a" });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.clearAllMocks();
    ocrSettingsMock.getPaddleOcrToken.mockResolvedValue("test-token");
    nativeOcrMock.canUseNativeOcr.mockReturnValue(false);
    desktopOcrMock.canUseDesktopOcr.mockReturnValue(false);
  });

  it("still refuses web OCR when no native or desktop host is available", async () => {
    await expect(runPaddleOcr(imageAsset())).rejects.toThrow("Web 端 OCR 需要服务器代理");
  });

  it("still asks for a token before doing any OCR work", async () => {
    ocrSettingsMock.getPaddleOcrToken.mockResolvedValueOnce("");
    await expect(runPaddleOcr(imageAsset())).rejects.toThrow("请先在 OCR 设置中配置 PaddleOCR Token。");
  });

  it("keeps the retained browser implementation reachable and input-validating", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    expect(typeof runPaddleOcrViaBrowserFetch).toBe("function");
    await expect(runPaddleOcrViaBrowserFetch(audioAsset())).rejects.toThrow("OCR 只支持图片资源。");
    // The guard must reject before any network traffic leaves the device.
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("can still complete a full direct-connect job when it is driven explicitly", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout"] });
    const jsonl = JSON.stringify({ result: { layoutParsingResults: [{ markdown: { text: "直连 OCR 文本" } }] } });
    const fetchSpy = vi.fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ data: { jobId: "job-1" } }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ data: { state: "done", resultUrl: { jsonUrl: "https://example.invalid/result.jsonl" } } }) })
      .mockResolvedValueOnce({ ok: true, text: async () => jsonl });
    vi.stubGlobal("fetch", fetchSpy);

    const pending = runPaddleOcrViaBrowserFetch(imageAsset());
    await vi.advanceTimersByTimeAsync(5000);

    await expect(pending).resolves.toBe("直连 OCR 文本");
    expect(fetchSpy).toHaveBeenCalledTimes(3);
  });
});
