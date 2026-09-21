import type { Asset, RecordBlock } from "../types";
import { nowISO } from "../lib/date";
import { runPaddleOcr } from "./ocrService";
import { storage } from "./storageAdapter";
import { markAutoBackupDirty } from "./autoBackupService";

const OCR_QUEUE_RETRY_DELAYS_MS = [10_000, 30_000, 60_000, 120_000, 300_000] as const;

type OcrPriority = "auto" | "manual";

type OcrJob = {
  assetId: string;
  priority: OcrPriority;
  retryCount: number;
  onAssetChanged: Set<() => void>;
  promise: Promise<Asset | undefined>;
  resolve: (asset: Asset | undefined) => void;
  reject: (error: unknown) => void;
  ready: boolean;
  retryTimer?: number;
};

const jobsByAssetId = new Map<string, OcrJob>();
const manualJobs: OcrJob[] = [];
const autoJobs: OcrJob[] = [];
let activeJob: OcrJob | undefined;
let drainScheduled = false;

const shouldAutoOcr = (asset: Asset): boolean =>
  asset.kind === "image" && !asset.ocrText?.trim() && (!asset.ocrStatus || asset.ocrStatus === "idle");

const patchOcrAsset = async (assetId: string, patch: Partial<Omit<Asset, "id" | "data">>) => {
  const hasResultChange = Object.prototype.hasOwnProperty.call(patch, "ocrText");
  const updated = await storage.patchAsset(assetId, {
    ...patch,
    ocrUpdatedAt: nowISO(),
  }, { mutation: hasResultChange ? "content" : "operational" });
  await markAutoBackupDirty("ocr");
  return updated;
};

const notifyAssetChanged = (job: OcrJob) => {
  for (const callback of job.onAssetChanged) {
    callback();
  }
};

const removeQueuedJob = (job: OcrJob) => {
  const queue = job.priority === "manual" ? manualJobs : autoJobs;
  const index = queue.indexOf(job);
  if (index >= 0) {
    queue.splice(index, 1);
  }
};

const enqueueJob = (job: OcrJob) => {
  if (!job.ready) {
    return;
  }
  if (job.priority === "manual") {
    manualJobs.push(job);
  } else {
    autoJobs.push(job);
  }
  scheduleDrain();
};

const promoteToManual = (job: OcrJob) => {
  if (job === activeJob) {
    return;
  }
  if (job.retryTimer !== undefined) {
    window.clearTimeout(job.retryTimer);
    job.retryTimer = undefined;
  }
  if (!job.ready) {
    job.priority = "manual";
    return;
  }
  removeQueuedJob(job);
  job.priority = "manual";
  manualJobs.push(job);
  scheduleDrain();
};

const isOcrQueueFullError = (error: unknown): boolean => {
  if (typeof error === "object" && error !== null && "code" in error && (error as { code?: unknown }).code === "OCR_QUEUE_FULL") {
    return true;
  }
  const message = error instanceof Error ? error.message : String(error ?? "");
  return /OCR_QUEUE_FULL|["']code["']\s*:\s*10010\b/.test(message);
};

const getOcrTraceId = (error: unknown): string | undefined => {
  const message = error instanceof Error ? error.message : String(error ?? "");
  return message.match(/["']traceId["']\s*:\s*["']([^"']+)["']/i)?.[1]
    ?? message.match(/trace(?:Id| ID)\s*[:=]\s*([^\s)\],]+)/i)?.[1];
};

const queueBusyMessage = (retryNumber: number, delayMs: number, traceId?: string) =>
  `百度 OCR 服务繁忙，正在等待第 ${retryNumber} 次重试（约 ${Math.round(delayMs / 1000)} 秒）${traceId ? `，追踪 ID：${traceId}` : ""}。`;

const queueExhaustedMessage = (traceId?: string) =>
  `百度 OCR 服务繁忙，已自动重试 ${OCR_QUEUE_RETRY_DELAYS_MS.length} 次，请稍后重新 OCR。${traceId ? `追踪 ID：${traceId}` : ""}`;

const finalizeJob = (job: OcrJob) => {
  if (job.retryTimer !== undefined) {
    window.clearTimeout(job.retryTimer);
  }
  removeQueuedJob(job);
  job.ready = false;
  jobsByAssetId.delete(job.assetId);
};

const finishJobWithError = async (job: OcrJob, error: unknown) => {
  const message = error instanceof Error ? error.message : "OCR 识别失败。";
  const status = message.includes("超时") ? "timeout" : "failed";
  const updated = await patchOcrAsset(job.assetId, {
    ocrStatus: status,
    ocrError: message,
    ocrResultSummary: {
      textLength: 0,
      includedInAi: false,
      parserVersion: "paddle-ocr-v2",
    },
  });
  notifyAssetChanged(job);
  finalizeJob(job);
  job.reject(error);
  return updated;
};

const scheduleRetry = async (job: OcrJob, error: unknown) => {
  const traceId = getOcrTraceId(error);
  const delayMs = OCR_QUEUE_RETRY_DELAYS_MS[job.retryCount];
  if (delayMs === undefined) {
    const finalError = new Error(queueExhaustedMessage(traceId));
    await finishJobWithError(job, finalError);
    return;
  }

  job.retryCount += 1;
  await patchOcrAsset(job.assetId, {
    ocrStatus: "queued",
    ocrError: queueBusyMessage(job.retryCount, delayMs, traceId),
  });
  notifyAssetChanged(job);
  job.retryTimer = window.setTimeout(() => {
    job.retryTimer = undefined;
    enqueueJob(job);
  }, delayMs);
};

const nextQueuedJob = (): OcrJob | undefined => manualJobs.shift() ?? autoJobs.pop();

const runQueuedJob = async (job: OcrJob) => {
  const asset = await storage.getAsset(job.assetId);
  if (!asset) {
    finalizeJob(job);
    job.resolve(undefined);
    return;
  }
  if (asset.kind !== "image") {
    await finishJobWithError(job, new Error("OCR 只支持图片资源。"));
    return;
  }

  try {
    await patchOcrAsset(job.assetId, { ocrStatus: "running", ocrError: undefined });
    notifyAssetChanged(job);
    const updateAsset = async (patch: Partial<Asset>) => {
      await patchOcrAsset(job.assetId, patch);
      notifyAssetChanged(job);
    };
    const text = (await runPaddleOcr(asset, updateAsset)).trim();
    if (!text) {
      throw new Error("上游返回空 OCR 文本。");
    }
    const updated = await patchOcrAsset(job.assetId, {
      ocrStatus: "done",
      ocrText: text,
      ocrError: undefined,
      ocrResultSummary: {
        textLength: text.length,
        includedInAi: true,
        parserVersion: "paddle-ocr-v2",
      },
    });
    notifyAssetChanged(job);
    finalizeJob(job);
    job.resolve(updated);
  } catch (error) {
    if (isOcrQueueFullError(error)) {
      await scheduleRetry(job, error);
      return;
    }
    await finishJobWithError(job, error);
  }
};

const prepareJob = async (job: OcrJob) => {
  const asset = await storage.getAsset(job.assetId);
  if (!asset) {
    finalizeJob(job);
    job.resolve(undefined);
    return;
  }
  if (asset.kind !== "image") {
    await finishJobWithError(job, new Error("OCR 只支持图片资源。"));
    return;
  }
  if (job.priority === "auto" && !shouldAutoOcr(asset)) {
    finalizeJob(job);
    job.resolve(asset);
    return;
  }

  await patchOcrAsset(job.assetId, {
    ocrStatus: "queued",
    ocrError: undefined,
  });
  job.ready = true;
  notifyAssetChanged(job);
  enqueueJob(job);
};

const drainQueue = async () => {
  drainScheduled = false;
  if (activeJob) {
    return;
  }
  const job = nextQueuedJob();
  if (!job) {
    return;
  }

  activeJob = job;
  try {
    await runQueuedJob(job);
  } finally {
    activeJob = undefined;
    scheduleDrain();
  }
};

function scheduleDrain() {
  if (drainScheduled || activeJob) {
    return;
  }
  drainScheduled = true;
  queueMicrotask(() => void drainQueue());
}

const addJobCallback = (job: OcrJob, callback?: () => void) => {
  if (callback) {
    job.onAssetChanged.add(callback);
  }
};

const createJob = (assetId: string, priority: OcrPriority, callback?: () => void): OcrJob => {
  let resolve!: (asset: Asset | undefined) => void;
  let reject!: (error: unknown) => void;
  const job: OcrJob = {
    assetId,
    priority,
    retryCount: 0,
    onAssetChanged: new Set(),
    promise: new Promise<Asset | undefined>((nextResolve, nextReject) => {
      resolve = nextResolve;
      reject = nextReject;
    }),
    resolve,
    reject,
    ready: false,
  };
  addJobCallback(job, callback);
  return job;
};

export const runOcrForAsset = (
  assetId: string,
  options: {
    force?: boolean;
    onAssetChanged?: () => void;
  } = {},
): Promise<Asset | undefined> => {
  const priority: OcrPriority = options.force ? "manual" : "auto";
  const existingJob = jobsByAssetId.get(assetId);
  if (existingJob) {
    addJobCallback(existingJob, options.onAssetChanged);
    if (priority === "manual") {
      promoteToManual(existingJob);
    }
    return existingJob.promise;
  }

  const job = createJob(assetId, priority, options.onAssetChanged);
  jobsByAssetId.set(assetId, job);
  void prepareJob(job).catch(async (error) => {
    if (!jobsByAssetId.has(job.assetId)) {
      return;
    }
    try {
      await finishJobWithError(job, error);
    } catch {
      finalizeJob(job);
      job.reject(error);
    }
  });
  return job.promise;
};

export const enqueueAutoOcrForRecord = (
  record: RecordBlock,
  options: {
    onAssetChanged?: () => void;
  } = {},
): void => {
  for (const assetRef of record.assets) {
    if (assetRef.kind !== "image") {
      continue;
    }
    void runOcrForAsset(assetRef.id, {
      force: false,
      onAssetChanged: options.onAssetChanged,
    }).catch(() => {
      // The asset card shows the persisted OCR error state.
    });
  }
};

export const resetOcrQueueForTests = () => {
  for (const job of jobsByAssetId.values()) {
    if (job.retryTimer !== undefined) {
      window.clearTimeout(job.retryTimer);
    }
  }
  jobsByAssetId.clear();
  manualJobs.splice(0, manualJobs.length);
  autoJobs.splice(0, autoJobs.length);
  activeJob = undefined;
  drainScheduled = false;
};

export const OCR_QUEUE_TESTING = {
  retryDelaysMs: OCR_QUEUE_RETRY_DELAYS_MS,
};
