export type UiErrorContext =
  | "review-rating"
  | "review-undo"
  | "review-feedback"
  | "review-annotation"
  | "adaptive-review"
  | "voice-recall"
  | "record-save"
  | "ai-request"
  | "cloud-sync"
  | "generic";

export interface UiError {
  message: string;
  diagnosticId: string;
}

const CONTEXT_MESSAGES: Record<UiErrorContext, string> = {
  "review-rating": "复习评分失败。当前复习内容仍保留，请重试。",
  "review-undo": "撤回评分失败。原评分仍然有效，请稍后重试。",
  "review-feedback": "暂时无法完成这项复习操作，请重试。",
  "review-annotation": "批注暂时无法读取或保存。正文内容不受影响，请重试。",
  "adaptive-review": "暂时无法更新学习助教任务。当前回答仍保留在本页，请重试。",
  "voice-recall": "语音复述操作没有完成。当前转写和本机学习数据不会因此上传，请重试。",
  "record-save": "保存失败。内容已存于本机草稿，请重试。",
  "ai-request": "AI 暂时无法完成本次请求。你的提问已保留，可以重试。",
  "cloud-sync": "云同步未完成。请检查网络后重试，本机数据不会因此删除。",
  generic: "操作没有完成，请稍后重试。",
};

let diagnosticSequence = 0;

const diagnosticPrefix = (context: UiErrorContext): string => context
  .split("-")
  .map((part) => part[0]?.toUpperCase() ?? "X")
  .join("")
  .slice(0, 3);

export const normalizeUiError = (_error: unknown, context: UiErrorContext): UiError => {
  diagnosticSequence = (diagnosticSequence + 1) % 46_656;
  const time = Date.now().toString(36).slice(-5).toUpperCase();
  const sequence = diagnosticSequence.toString(36).padStart(3, "0").toUpperCase();
  return {
    message: CONTEXT_MESSAGES[context],
    diagnosticId: `${diagnosticPrefix(context)}-${time}${sequence}`,
  };
};

export const formatUiError = (error: unknown, context: UiErrorContext): string => {
  const normalized = normalizeUiError(error, context);
  return `${normalized.message}（诊断编号 ${normalized.diagnosticId}）`;
};
