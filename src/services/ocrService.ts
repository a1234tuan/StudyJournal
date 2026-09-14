import type { Asset } from "../types";
import { canUseDesktopOcr, runDesktopOcr } from "./desktopOcr";
import { canUseNativeOcr, runNativeOcr } from "./nativeOcr";
import { getPaddleOcrToken } from "./ocrSettings";

const JOB_URL = "https://paddleocr.aistudio-app.com/api/v2/ocr/jobs";
const MODEL = "PaddleOCR-VL-1.6";
const POLL_INTERVAL_MS = 5000;
const MAX_WAIT_MS = 5 * 60 * 1000;

const optionalPayload = {
  useDocOrientationClassify: true,
  useDocUnwarping: true,
  useChartRecognition: false,
};

const sleep = (ms: number) => new Promise((resolve) => window.setTimeout(resolve, ms));

export const OCR_CONFIG = {
  JOB_URL,
  MODEL,
  optionalPayload,
};

const requirePaddleOcrToken = async (): Promise<string> => {
  const token = await getPaddleOcrToken();
  if (!token) {
    throw new Error("请先在 OCR 设置中配置 PaddleOCR Token。");
  }
  return token;
};

const normalizeTextChunks = (chunks: string[]): string =>
  Array.from(new Set(chunks.map((chunk) => chunk.trim()).filter(Boolean))).join("\n\n").trim();

const collectTextChunks = (value: unknown): string[] => {
  const chunks: string[] = [];

  const visit = (node: unknown, key?: string) => {
    if (typeof node === "string") {
      if (
        key === "text" ||
        key === "recText" ||
        key === "rec_text" ||
        key === "markdownText" ||
        key === "markdown_text"
      ) {
        chunks.push(node);
      }
      return;
    }
    if (!node || typeof node !== "object") {
      return;
    }
    if (Array.isArray(node)) {
      for (const item of node) {
        if (typeof item === "string" && (key === "recTexts" || key === "texts" || key === "rec_texts")) {
          chunks.push(item);
        } else {
          visit(item, key);
        }
      }
      return;
    }

    for (const [childKey, child] of Object.entries(node)) {
      visit(child, childKey);
    }
  };

  visit(value);
  return chunks;
};

export const extractPaddleOcrText = (value: unknown): string => {
  if (typeof value === "string") {
    const chunks: string[] = [];
    for (const line of value.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) {
        continue;
      }
      chunks.push(...collectTextChunks(JSON.parse(trimmed)));
    }
    return normalizeTextChunks(chunks);
  }

  return normalizeTextChunks(collectTextChunks(value));
};

export const extractOcrTextFromJsonl = (jsonl: string): string => {
  return extractPaddleOcrText(jsonl);
};

export const extractOcrTextFromJson = (value: unknown): string => {
  return extractPaddleOcrText(value);
};

export const runPaddleOcr = async (
  asset: Asset,
  onProgress?: (patch: Partial<Asset>) => Promise<void> | void,
): Promise<string> => {
  if (asset.kind !== "image") {
    throw new Error("OCR 只支持图片资源。");
  }

  await onProgress?.({ ocrStatus: "queued", ocrError: undefined });
  const token = await requirePaddleOcrToken();
  if (canUseNativeOcr()) {
    await onProgress?.({ ocrStatus: "running" });
    const result = await runNativeOcr(asset, token);
    if (result.jobId) {
      await onProgress?.({ ocrJobId: result.jobId });
    }
    if (!result.text.trim()) {
      throw new Error("上游返回空 OCR 文本。");
    }
    return result.text.trim();
  }

  if (canUseDesktopOcr()) {
    await onProgress?.({ ocrStatus: "running" });
    const result = await runDesktopOcr(asset, token);
    if (result.jobId) {
      await onProgress?.({ ocrJobId: result.jobId });
    }
    if (!result.text.trim()) {
      throw new Error("上游返回空 OCR 文本。");
    }
    return result.text.trim();
  }

  throw new Error("Web 端 OCR 需要服务器代理；请在 Android App 内识别，或后续接入服务器代理。");
};

// Deliberately kept, currently unreferenced. `runPaddleOcr` (above) is the only
// production entry point and throws on web because the PaddleOCR job API is not
// reachable directly from the browser (CORS + credential exposure). This browser
// direct-connect implementation is retained as a working reference for a future
// server-proxy or direct-connect mode; do not delete it. Enabling it requires
// validating CORS, credential handling, and the ocrStatus/ocrJobId progress
// contract first. Decision recorded 2026-09-14 (audit F-19).
export const runPaddleOcrViaBrowserFetch = async (
  asset: Asset,
  onProgress?: (patch: Partial<Asset>) => Promise<void> | void,
): Promise<string> => {
  if (asset.kind !== "image") {
    throw new Error("OCR 只支持图片资源。");
  }

  await onProgress?.({ ocrStatus: "queued", ocrError: undefined });
  const token = await requirePaddleOcrToken();
  const formData = new FormData();
  formData.append("model", MODEL);
  formData.append("optionalPayload", JSON.stringify(optionalPayload));
  formData.append("file", asset.data, asset.fileName);

  const jobResponse = await fetch(JOB_URL, {
    method: "POST",
    headers: {
      Authorization: `bearer ${token}`,
    },
    body: formData,
  });

  if (!jobResponse.ok) {
    throw new Error(`OCR 提交失败：${jobResponse.status} ${await jobResponse.text()}`);
  }

  const jobJson = await jobResponse.json() as { data?: { jobId?: string } };
  const jobId = jobJson.data?.jobId;
  if (!jobId) {
    throw new Error("OCR 提交失败：没有返回 jobId。");
  }

  await onProgress?.({ ocrStatus: "running", ocrJobId: jobId });
  const startedAt = Date.now();
  while (Date.now() - startedAt < MAX_WAIT_MS) {
    await sleep(POLL_INTERVAL_MS);
    const resultResponse = await fetch(`${JOB_URL}/${jobId}`, {
      headers: {
        Authorization: `bearer ${token}`,
      },
    });
    if (!resultResponse.ok) {
      throw new Error(`OCR 查询失败：${resultResponse.status} ${await resultResponse.text()}`);
    }
    const resultJson = await resultResponse.json() as {
      data?: {
        state?: string;
        errorMsg?: string;
        resultUrl?: {
          jsonUrl?: string;
        };
      };
    };
    const state = resultJson.data?.state;
    if (state === "failed") {
      throw new Error(resultJson.data?.errorMsg ?? "OCR 识别失败。");
    }
    if (state !== "done") {
      continue;
    }
    const jsonUrl = resultJson.data?.resultUrl?.jsonUrl;
    if (!jsonUrl) {
      throw new Error("OCR 已完成，但没有返回结果地址。");
    }
    const jsonlResponse = await fetch(jsonUrl);
    if (!jsonlResponse.ok) {
      throw new Error(`OCR 结果下载失败：${jsonlResponse.status}`);
    }
    const text = extractOcrTextFromJsonl(await jsonlResponse.text());
    if (!text) {
      throw new Error("上游返回空 OCR 文本。");
    }
    return text;
  }

  throw new Error("OCR 识别超时，请稍后重试。");
};
