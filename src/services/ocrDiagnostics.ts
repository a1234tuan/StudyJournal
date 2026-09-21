import type { Asset } from "../types";

export const describeOcrForAi = (
  asset: Asset | undefined,
): { included: boolean; reason: string; textLength: number } => {
  if (!asset) {
    return { included: false, reason: "资源丢失，未参与 AI 问答。", textLength: 0 };
  }
  if (asset.kind !== "image") {
    return { included: false, reason: "不是图片资源，未参与 AI 问答。", textLength: 0 };
  }
  const textLength = asset.ocrText?.trim().length ?? 0;
  if (textLength > 0) {
    return { included: true, reason: "图片 OCR 文本已参与 AI 问答。", textLength };
  }
  if (asset.ocrStatus === "done" && textLength === 0) {
    return { included: false, reason: "OCR 成功但文本为空，未参与 AI 问答。", textLength: 0 };
  }
  if (asset.ocrStatus === "failed" || asset.ocrStatus === "timeout") {
    return { included: false, reason: asset.ocrError ?? "OCR 失败，未参与 AI 问答。", textLength };
  }
  if (asset.ocrStatus === "queued" || asset.ocrStatus === "running") {
    return { included: false, reason: "OCR 仍在识别中，暂未参与 AI 问答。", textLength };
  }
  return { included: false, reason: "图片尚未 OCR，未参与 AI 问答。", textLength };
};
