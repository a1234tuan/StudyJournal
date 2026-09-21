import type { AiChatAttachment, Asset } from "../types";
import { createBaseEntity } from "../lib/entity";
import { nowISO } from "../lib/date";
import { runPaddleOcr } from "./ocrService";
import { storage } from "./storageAdapter";

const attachmentToAsset = (attachment: AiChatAttachment): Asset => ({
  ...attachment,
  title: attachment.fileName,
  kind: "image",
  data: attachment.data,
});

export const createAiImageAttachment = async (
  sessionId: string,
  file: File,
): Promise<AiChatAttachment> => {
  const attachment: AiChatAttachment = {
    ...createBaseEntity(),
    sessionId,
    fileName: file.name,
    mimeType: file.type || "image/jpeg",
    size: file.size,
    data: file,
    ocrStatus: "idle",
  };
  return storage.saveAiAttachment?.(attachment) ?? attachment;
};

export const runLocalOcrForAiAttachment = async (
  attachment: AiChatAttachment,
  options: {
    onChanged?: (attachment: AiChatAttachment) => void;
    /** Training answers can use OCR without leaving an attachment row behind. */
    persist?: boolean;
  } = {},
): Promise<AiChatAttachment> => {
  let current = attachment;
  const patch = async (next: Partial<AiChatAttachment>) => {
    const updated: AiChatAttachment = {
      ...current,
      ...next,
      ocrUpdatedAt: nowISO(),
    };
    const saved = options.persist === false
      ? updated
      : await storage.saveAiAttachment?.(updated) ?? updated;
    current = saved;
    options.onChanged?.(saved);
    return saved;
  };

  try {
    await patch({ ocrStatus: "queued", ocrError: undefined });
    const text = (await runPaddleOcr(attachmentToAsset(attachment), async (assetPatch) => {
      await patch({
        ocrStatus: assetPatch.ocrStatus,
        ocrError: assetPatch.ocrError,
        ocrJobId: assetPatch.ocrJobId,
      });
    })).trim();
    if (!text) {
      throw new Error("上游返回空 OCR 文本。");
    }
    return patch({
      ocrStatus: "done",
      ocrText: text,
      ocrError: undefined,
      sentMode: "local-ocr-markdown",
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "OCR 识别失败。";
    return patch({
      ocrStatus: "failed",
      ocrError: message,
      sentMode: "local-ocr-markdown",
    }).then((failed) => {
      throw Object.assign(new Error(message), { attachment: failed });
    });
  }
};
