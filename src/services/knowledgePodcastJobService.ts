import type { KnowledgePodcast, KnowledgePodcastAudioUnit, KnowledgePodcastGenerationProgress, KnowledgePodcastTtsDiagnostic } from "../types";
import { newId } from "../lib/entity";
import { isLikelyMp3Audio, normalizeMp3Segment, readBlobBytes } from "../lib/audio";
import { getCurrentAiProvider } from "../lib/aiProviders";
import { normalizeTtsConfig, getCurrentTtsProvider, TTS_PROVIDER_LABELS } from "../lib/ttsProviders";
import {
  createTtsProvider,
  createPodcastAudioUnits,
  reconcilePodcastAudioUnits,
  generatePodcastScript,
  hashText,
  KnowledgePodcastScriptError,
  splitTtsText,
} from "./knowledgePodcastService";
import { storage } from "./storageAdapter";
import {
  acknowledgeNativePodcastTtsArtifact,
  base64ToPodcastAudioBlob,
  cancelNativePodcastTts,
  getNativePodcastTtsState,
  isNativePodcastTtsAvailable,
  requestNativePodcastTtsNotificationPermission,
  startNativePodcastTts,
  takeNativePodcastTtsArtifact,
  type NativePodcastTtsState,
} from "./nativePodcastTts";

type PodcastJobKind = "script" | "audio";

const controllers = new Map<string, AbortController>();
const listeners = new Set<() => void>();
const nativePollTimers = new Map<string, ReturnType<typeof setInterval>>();

const jobKey = (podcastId: string, kind: PodcastJobKind) => `${podcastId}:${kind}`;
const now = () => new Date().toISOString();

const emit = () => listeners.forEach((listener) => listener());

const savePodcast = async (podcast: KnowledgePodcast): Promise<KnowledgePodcast> => {
  const saved = await storage.saveKnowledgePodcast?.(podcast) ?? podcast;
  emit();
  return saved;
};

const generatedAssetIds = (podcast: KnowledgePodcast): string[] => [
  ...podcast.segments.flatMap((segment) => segment.audioAssetId ? [segment.audioAssetId] : []),
  ...(podcast.audioUnits ?? []).flatMap((unit) => unit.audioAssetId ? [unit.audioAssetId] : []),
  ...(podcast.pendingAudioCleanupAssetIds ?? []),
];

const unitText = (podcast: KnowledgePodcast, unit: KnowledgePodcastAudioUnit): string => {
  if (unit.kind === "opening") return podcast.opening?.trim() ?? "";
  if (unit.kind === "closing") return podcast.closing?.trim() ?? "";
  return podcast.segments.find((segment) => segment.id === unit.segmentId)?.text.trim() ?? "";
};

const updateUnit = (
  podcast: KnowledgePodcast,
  unitId: string,
  patch: Partial<KnowledgePodcastAudioUnit>,
): KnowledgePodcast => {
  const target = podcast.audioUnits?.find((unit) => unit.id === unitId);
  return {
    ...podcast,
    audioUnits: podcast.audioUnits?.map((unit) => unit.id === unitId ? { ...unit, ...patch } : unit),
    segments: target?.kind === "segment" ? podcast.segments.map((segment) => segment.id === target.segmentId ? {
      ...segment,
      ...(patch.textHash ? { textHash: patch.textHash } : {}),
      ...(patch.audioAssetId !== undefined ? { audioAssetId: patch.audioAssetId } : {}),
      ...(patch.audioStatus ? { audioStatus: patch.audioStatus } : {}),
      ...(patch.durationSeconds !== undefined ? { durationSeconds: patch.durationSeconds } : {}),
      ...(patch.error !== undefined ? { error: patch.error } : {}),
    } : segment) : podcast.segments,
  };
};

const audioStatusForUnits = (units: KnowledgePodcastAudioUnit[]): KnowledgePodcast["audioStatus"] => {
  if (!units.length || units.some((unit) => unit.audioStatus !== "ready" || !unit.audioAssetId)) return "partial";
  return "ready";
};

const ensureAudioLayout = async (podcast: KnowledgePodcast): Promise<KnowledgePodcast> => {
  if (podcast.audioLayoutVersion === 2 && podcast.audioUnits) return reconcilePodcastAudioUnits(podcast);
  const audioUnits = await createPodcastAudioUnits(podcast);
  return {
    ...podcast,
    audioLayoutVersion: 2,
    audioUnits,
    audioStatus: "idle",
    pendingAudioCleanupAssetIds: Array.from(new Set(generatedAssetIds(podcast))),
  };
};

const cleanupReplacedAudio = async (podcast: KnowledgePodcast): Promise<KnowledgePodcast> => {
  const activeIds = new Set((podcast.audioUnits ?? []).flatMap((unit) => unit.audioAssetId ? [unit.audioAssetId] : []));
  for (const id of podcast.pendingAudioCleanupAssetIds ?? []) {
    if (activeIds.has(id)) continue;
    const asset = await storage.getAsset(id);
    if (asset?.generatedBy === "knowledge-podcast") await storage.deleteAsset?.(id);
  }
  return { ...podcast, pendingAudioCleanupAssetIds: undefined };
};

const appendTtsDiagnostics = (
  podcast: KnowledgePodcast,
  diagnostics: NativePodcastTtsState["diagnostics"] | undefined,
): KnowledgePodcast => diagnostics?.length ? {
  ...podcast,
  ttsDiagnostics: diagnostics.slice(-10).map((diagnostic) => ({ ...diagnostic } satisfies KnowledgePodcastTtsDiagnostic)),
} : podcast;

const stopNativeMonitor = (podcastId: string): void => {
  const timer = nativePollTimers.get(podcastId);
  if (timer) clearInterval(timer);
  nativePollTimers.delete(podcastId);
};

const startNativeMonitor = (podcastId: string): void => {
  if (nativePollTimers.has(podcastId)) return;
  const timer = setInterval(() => { void syncNativeKnowledgePodcastTtsJobs(); }, 5_000);
  nativePollTimers.set(podcastId, timer);
};

const progress = (
  kind: PodcastJobKind,
  stage: KnowledgePodcastGenerationProgress["stage"],
  message: string,
  startedAt: string,
  patch: Partial<KnowledgePodcastGenerationProgress> = {},
): KnowledgePodcastGenerationProgress => ({
  kind,
  status: "running",
  stage,
  message,
  startedAt,
  updatedAt: now(),
  heartbeatAt: now(),
  ...patch,
});

export const subscribeKnowledgePodcastJobs = (listener: () => void): (() => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

export const isKnowledgePodcastJobRunning = (podcastId: string, kind: PodcastJobKind): boolean =>
  controllers.has(jobKey(podcastId, kind));

export const cancelKnowledgePodcastJob = (podcastId: string, kind: PodcastJobKind): void => {
  controllers.get(jobKey(podcastId, kind))?.abort();
  if (kind === "audio") void cancelNativePodcastTts(undefined, podcastId);
};

export const cancelAllKnowledgePodcastJobs = (podcastId: string): void => {
  cancelKnowledgePodcastJob(podcastId, "script");
  cancelKnowledgePodcastJob(podcastId, "audio");
};

/**
 * Imports completed files from the Android foreground service and mirrors its
 * durable state into Dexie. It is safe to invoke at startup, resume and while
 * a page is mounted: imported assets are tagged by podcast/unit and reused.
 */
export const syncNativeKnowledgePodcastTtsJobs = async (): Promise<Set<string>> => {
  const activePodcastIds = new Set<string>();
  if (!isNativePodcastTtsAvailable()) return activePodcastIds;
  const state = await getNativePodcastTtsState().catch(() => undefined);
  if (!state?.podcastId || !state.jobId) return activePodcastIds;
  const key = jobKey(state.podcastId, "audio");
  const nativeRunning = state.status === "running" && state.runnerActive !== false;
  if (nativeRunning) {
    activePodcastIds.add(state.podcastId);
    if (!controllers.has(key)) controllers.set(key, new AbortController());
    startNativeMonitor(state.podcastId);
  }
  let podcast = await storage.getKnowledgePodcast?.(state.podcastId);
  if (!podcast) return activePodcastIds;

  // Artifacts stay in the native private directory until this acknowledgement,
  // making imports idempotent across an activity recreation or a crash.
  for (;;) {
    const artifact = await takeNativePodcastTtsArtifact().catch(() => undefined);
    if (!artifact || artifact.podcastId !== podcast.id) break;
    const unit = podcast.audioUnits?.find((item) => item.id === artifact.unitId);
    if (!unit) {
      await acknowledgeNativePodcastTtsArtifact(artifact.jobId, artifact.unitId);
      continue;
    }
    const assets = await storage.listAssets();
    let asset = assets.find((item) => item.generatedForPodcastId === podcast!.id && item.generatedForAudioUnitId === unit.id);
    if (!asset) {
      const blob = base64ToPodcastAudioBlob(artifact.data, artifact.mimeType);
      const file = new File([blob], `${podcast.title}-${String(unit.order + 1).padStart(2, "0")}-${unit.title}.mp3`, { type: artifact.mimeType || "audio/mpeg" });
      asset = await storage.saveAsset(file, "audio", unit.title);
      await storage.patchAsset?.(asset.id, {
        generatedBy: "knowledge-podcast",
        generatedForPodcastId: podcast.id,
        generatedForAudioUnitId: unit.id,
      });
    }
    const textHash = await hashText(unitText(podcast, unit));
    podcast = await savePodcast(updateUnit(podcast, unit.id, {
      textHash,
      audioAssetId: asset.id,
      audioStatus: "ready",
      error: undefined,
    }));
    await acknowledgeNativePodcastTtsArtifact(artifact.jobId, artifact.unitId);
  }

  const nativeUnits = new Map(state.units.map((unit) => [unit.unitId, unit]));
  for (const unit of podcast.audioUnits ?? []) {
    const nativeUnit = nativeUnits.get(unit.id);
    if (!nativeUnit || nativeUnit.status === "ready") continue;
    if (nativeUnit.status === "failed") {
      podcast = updateUnit(podcast, unit.id, { audioStatus: "failed", error: nativeUnit.error || `${TTS_PROVIDER_LABELS[podcast.ttsConfig.providerId] ?? podcast.ttsConfig.providerId} 生成失败。` });
    } else if (nativeRunning) {
      podcast = updateUnit(podcast, unit.id, { audioStatus: nativeUnit.status === "generating" ? "generating" : "pending", error: undefined });
    } else if (unit.audioStatus !== "ready") {
      // Service ended without producing an artifact for this unit — reset to pending so user can retry.
      podcast = updateUnit(podcast, unit.id, { audioStatus: "pending", error: undefined });
    }
  }
  podcast = appendTtsDiagnostics(podcast, state.diagnostics);
  const startedAt = podcast.generation?.startedAt || state.startedAt || now();
  if (nativeRunning) {
    podcast = await savePodcast({
      ...podcast,
      audioStatus: "generating",
      generation: progress("audio", "generating-segment", state.message, startedAt, {
        providerName: TTS_PROVIDER_LABELS[podcast.ttsConfig.providerId] ?? podcast.ttsConfig.providerId,
        model: podcast.ttsConfig.model,
        current: state.current,
        total: state.total,
        partCurrent: state.partCurrent,
        partTotal: state.partTotal,
        nativeJobId: state.jobId,
        heartbeatAt: state.heartbeatAt || state.updatedAt,
        requestStartedAt: state.requestStartedAt,
      }),
    });
    return activePodcastIds;
  }

  const allReady = (podcast.audioUnits?.length ?? 0) > 0 && podcast.audioUnits!.every((unit) => unit.audioStatus === "ready" && unit.audioAssetId);
  if (allReady) podcast = await cleanupReplacedAudio(podcast);
  const cancelled = state.status === "cancelled";
  const failed = state.status === "failed" || state.status === "running";
  const terminalMessage = state.status === "running"
    ? "后台音频任务没有活动服务，任务可能已中断，请继续生成。"
    : (!allReady && state.status === "completed")
      ? "音频生成完成，部分章节未能生成，请点击重试缺失章节。"
      : state.message;
  await savePodcast({
    ...podcast,
    audioStatus: allReady ? "ready" : audioStatusForUnits(podcast.audioUnits ?? []),
    lastError: failed ? terminalMessage : undefined,
    generation: {
      ...progress("audio", cancelled ? "cancelled" : failed ? "failed" : "completed", terminalMessage, startedAt, {
        providerName: TTS_PROVIDER_LABELS[podcast.ttsConfig.providerId] ?? podcast.ttsConfig.providerId,
        model: podcast.ttsConfig.model,
        current: state.current,
        total: state.total,
        nativeJobId: state.jobId,
        heartbeatAt: state.heartbeatAt || state.updatedAt,
      }),
      status: cancelled ? "cancelled" : failed ? "failed" : "completed",
    },
  });
  controllers.delete(key);
  stopNativeMonitor(state.podcastId);
  emit();
  return activePodcastIds;
};

export const recoverKnowledgePodcastJobs = async (): Promise<void> => {
  const active = await syncNativeKnowledgePodcastTtsJobs();
  await storage.recoverInterruptedKnowledgePodcastJobs?.(active);
  await syncNativeKnowledgePodcastTtsJobs();
  emit();
};

export const startKnowledgePodcastScriptJob = async (podcastId: string): Promise<void> => {
  const key = jobKey(podcastId, "script");
  if (controllers.has(key)) throw new Error("这期播客正在生成脚本，请勿重复提交。");
  const podcast = await storage.getKnowledgePodcast?.(podcastId);
  if (!podcast) throw new Error("知识播客不存在或已被删除。");
  const settings = await storage.getSettings();
  const provider = getCurrentAiProvider(settings.ai);
  const startedAt = now();
  const controller = new AbortController();
  controllers.set(key, controller);
  await savePodcast({
    ...podcast,
    scriptStatus: "generating",
    audioStatus: "idle",
    lastError: undefined,
    generation: progress("script", "preparing", "正在准备播客脚本任务…", startedAt, {
      providerName: provider?.providerName,
      model: provider?.model,
      attempt: 1,
    }),
  });

  void (async () => {
    let current = await storage.getKnowledgePodcast?.(podcastId) ?? podcast;
    try {
      const [blocks, assets, currentSettings] = await Promise.all([
        storage.listBlocks(),
        storage.listAssets(),
        storage.getSettings(),
      ]);
      const result = await generatePodcastScript({
        podcast: current,
        blocks,
        assets,
        settings: currentSettings,
        signal: controller.signal,
        onProgress: async (stage, message, attempt) => {
          current = await savePodcast({
            ...current,
            generation: progress("script", stage, message, startedAt, {
              providerName: provider?.providerName,
              model: provider?.model,
              attempt,
            }),
          });
        },
      });
      current = await savePodcast({
        ...current,
        generation: progress("script", "saving-script", "脚本已返回，正在保存播客草稿…", startedAt, {
          providerName: provider?.providerName,
          model: provider?.model,
          attempt: result.diagnostic.attempts,
        }),
      });
      const previousAudioIds = generatedAssetIds(current);
      const audioUnits = await createPodcastAudioUnits(result.script);
      current = await savePodcast({
        ...current,
        ...result.script,
        ...result.estimate,
        audioLayoutVersion: 2,
        audioUnits,
        pendingAudioCleanupAssetIds: Array.from(new Set(previousAudioIds)),
        contextHash: result.context.contextHash,
        sourceRecordIds: result.context.recordIds,
        scriptStatus: "ready",
        audioStatus: "idle",
        lastError: undefined,
        scriptDiagnostic: result.diagnostic,
        generation: {
          ...progress("script", "completed", "脚本已生成并永久保存。", startedAt),
          status: "completed",
        },
      });
    } catch (error) {
      const aborted = controller.signal.aborted;
      const message = aborted ? "脚本生成已取消。" : error instanceof Error ? error.message : "脚本生成失败。";
      await savePodcast({
        ...current,
        scriptStatus: "failed",
        lastError: message,
        scriptDiagnostic: error instanceof KnowledgePodcastScriptError ? error.diagnostic : current.scriptDiagnostic,
        generation: {
          ...progress("script", aborted ? "cancelled" : "failed", message, startedAt),
          status: aborted ? "cancelled" : "failed",
        },
      });
    } finally {
      controllers.delete(key);
      emit();
    }
  })();
};

export const startKnowledgePodcastAudioJob = async (podcastId: string, onlyUnitId?: string): Promise<void> => {
  const key = jobKey(podcastId, "audio");
  if (controllers.has(key)) throw new Error("这期播客正在生成音频，请勿重复提交。");
  const storedPodcast = await storage.getKnowledgePodcast?.(podcastId);
  const podcast = storedPodcast ? await ensureAudioLayout(storedPodcast) : undefined;
  if (!podcast) throw new Error("知识播客不存在或已被删除。");
  if (!podcast?.segments.length || !podcast.audioUnits?.length) throw new Error("请先生成脚本。");
  const settings = await storage.getSettings();
  const ttsConfig = normalizeTtsConfig(settings.tts);
  const ttsProfile = getCurrentTtsProvider(ttsConfig);
  if (!ttsProfile) throw new Error("请先在 AI 工具设置中配置 TTS 供应商。");
  const ttsSecret = (await storage.getAiSecret?.(ttsProfile.id))
    ?? (ttsProfile.providerId === "fish-audio" ? await storage.getAiSecret?.("fish-audio") : undefined)
    ?? (ttsProfile.providerId === "fish-audio" ? await storage.getAiSecret?.("default") : undefined);
  if (!ttsSecret?.apiKey) throw new Error(`请先在 AI 工具设置中填写 ${ttsProfile.providerName} 的 API Key。`);
  if (ttsProfile.providerId === "tencent" && !ttsSecret.apiKeySecondary) throw new Error("腾讯云 TTS 需要同时填写 SecretId（API Key）和 SecretKey。");
  if (!ttsProfile.voice) throw new Error(`请先在 AI 工具设置中为 ${ttsProfile.providerName} 配置语音 ID。`);

  const startedAt = now();
  const controller = new AbortController();
  controllers.set(key, controller);
  let current = await savePodcast({
    ...podcast,
    audioStatus: "generating",
    lastError: undefined,
    ttsConfig: { ...podcast.ttsConfig, providerId: ttsProfile.providerId, model: ttsProfile.model, voiceId: ttsProfile.voice, region: ttsProfile.region, languageCode: ttsProfile.languageCode },
    generation: progress("audio", "preparing-audio", "正在准备播客音频…", startedAt, {
      providerName: ttsProfile.providerName,
      model: ttsProfile.model,
      current: 0,
      total: podcast.audioUnits.length,
    }),
  });

  if (isNativePodcastTtsAvailable()) {
    const queue = [] as Array<{ unitId: string; title: string; order: number; parts: string[] }>;
    for (const unit of current.audioUnits ?? []) {
      if (onlyUnitId && unit.id !== onlyUnitId) continue;
      const existing = unit.audioAssetId ? await storage.getAsset(unit.audioAssetId) : undefined;
      if (unit.audioStatus === "ready" && existing) continue;
      const text = unitText(current, unit);
      if (text) queue.push({ unitId: unit.id, title: unit.title, order: unit.order, parts: splitTtsText(text) });
    }
    if (queue.length === 0) {
      controllers.delete(key);
      current = await savePodcast({
        ...current,
        audioStatus: audioStatusForUnits(current.audioUnits ?? []),
        generation: { ...progress("audio", "completed", "没有需要生成的音频单元。", startedAt), status: "completed" },
      });
      return;
    }
    const nativeJobId = newId();
    current = await savePodcast({
      ...current,
      generation: progress("audio", "preparing-audio", "正在启动 Android 后台音频服务…", startedAt, {
        providerName: ttsProfile.providerName,
        model: ttsProfile.model,
        current: 0,
        total: queue.length,
        nativeJobId,
      }),
    });
    try {
      await requestNativePodcastTtsNotificationPermission();
      await startNativePodcastTts({
        jobId: nativeJobId,
        podcastId: current.id,
        podcastTitle: current.title,
        apiKey: ttsSecret.apiKey,
        apiKeySecondary: ttsSecret.apiKeySecondary,
        providerId: ttsProfile.providerId,
        model: ttsProfile.model,
        voiceId: ttsProfile.voice,
        appId: ttsProfile.appId,
        region: ttsProfile.region,
        languageCode: ttsProfile.languageCode,
        units: queue,
      });
      startNativeMonitor(current.id);
      void syncNativeKnowledgePodcastTtsJobs();
      return;
    } catch (error) {
      controllers.delete(key);
      const message = error instanceof Error ? error.message : "无法启动 Android 后台音频服务。";
      await savePodcast({
        ...current,
        audioStatus: "partial",
        lastError: message,
        generation: { ...progress("audio", "failed", message, startedAt), status: "failed" },
      });
      throw error;
    }
  }

  void (async () => {
    const provider = createTtsProvider(ttsProfile, ttsSecret.apiKey, ttsSecret.apiKeySecondary);
    try {
      for (const unit of current.audioUnits ?? []) {
        if (onlyUnitId && unit.id !== onlyUnitId) continue;
        if (controller.signal.aborted) break;
        const existing = unit.audioAssetId ? await storage.getAsset(unit.audioAssetId) : undefined;
        if (unit.audioStatus === "ready" && existing) continue;
        const text = unitText(current, unit);
        if (!text) continue;
        const parts = splitTtsText(text);
        current = await savePodcast(updateUnit({
          ...current,
          generation: progress("audio", "generating-segment", `正在生成${unit.title}音频…`, startedAt, {
            providerName: ttsProfile.providerName,
            model: ttsProfile.model,
            current: unit.order + 1,
            total: current.audioUnits?.length ?? 0,
          }),
        }, unit.id, { audioStatus: "generating", error: undefined }));
        try {
          const blobs: Blob[] = [];
          for (const [partIndex, part] of parts.entries()) {
            current = await savePodcast({
              ...current,
              generation: progress("audio", "generating-segment", `${unit.title}语音片段 ${partIndex + 1}/${parts.length}`, startedAt, {
                providerName: ttsProfile.providerName,
                model: ttsProfile.model,
                current: unit.order + 1,
                total: current.audioUnits?.length ?? 0,
                partCurrent: partIndex + 1,
                partTotal: parts.length,
              }),
            });
            const synthesized = await provider.synthesize(part, { signal: controller.signal });
            const bytes = await readBlobBytes(synthesized);
            const normalized = normalizeMp3Segment(bytes);
            if (!isLikelyMp3Audio(normalized)) {
              throw new Error("TTS 返回的内容不是有效的 MP3 音频。");
            }
            const payload = normalized.buffer.slice(normalized.byteOffset, normalized.byteOffset + normalized.byteLength) as ArrayBuffer;
            blobs.push(new Blob([payload], { type: "audio/mpeg" }));
          }
          current = await savePodcast({
            ...current,
            generation: progress("audio", "saving-audio", `正在保存${unit.title}音频…`, startedAt, {
              providerName: ttsProfile.providerName,
              model: ttsProfile.model,
              current: unit.order + 1,
              total: current.audioUnits?.length ?? 0,
            }),
          });
          const blob = new Blob(blobs, { type: "audio/mpeg" });
          const file = new File([blob], `${current.title}-${String(unit.order + 1).padStart(2, "0")}-${unit.title}.mp3`, { type: "audio/mpeg" });
          const asset = await storage.saveAsset(file, "audio", unit.title);
          await storage.patchAsset?.(asset.id, {
            generatedBy: "knowledge-podcast",
            generatedForPodcastId: current.id,
            generatedForAudioUnitId: unit.id,
          });
          if (unit.audioAssetId && unit.audioAssetId !== asset.id) {
            const previous = await storage.getAsset(unit.audioAssetId);
            if (previous?.generatedBy === "knowledge-podcast") await storage.deleteAsset?.(unit.audioAssetId);
          }
          const textHash = await hashText(text);
          current = await savePodcast(updateUnit(current, unit.id, { textHash, audioAssetId: asset.id, audioStatus: "ready", error: undefined }));
        } catch (error) {
          if (controller.signal.aborted) {
            current = await savePodcast(updateUnit({
              ...current,
              audioStatus: "partial",
            }, unit.id, { audioStatus: "pending", error: undefined }));
            break;
          }
          const message = error instanceof Error ? error.message : `${unit.title}音频生成失败。`;
          current = await savePodcast(updateUnit({
            ...current,
            audioStatus: "partial",
            lastError: message,
          }, unit.id, { audioStatus: "failed", error: message }));
        }
      }
      const allReady = (current.audioUnits?.length ?? 0) > 0 && current.audioUnits!.every((unit) => unit.audioStatus === "ready" && unit.audioAssetId);
      const cancelled = controller.signal.aborted;
      if (allReady) current = await cleanupReplacedAudio(current);
      await savePodcast({
        ...current,
        audioStatus: allReady ? "ready" : audioStatusForUnits(current.audioUnits ?? []),
        generation: {
          ...progress("audio", cancelled ? "cancelled" : "completed", cancelled ? "音频生成已取消，已完成章节仍然保留。" : allReady ? "全部章节音频已生成。" : "音频生成完成，部分章节需要重试。", startedAt),
          status: cancelled ? "cancelled" : "completed",
        },
      });
    } catch (error) {
      const aborted = controller.signal.aborted;
      const message = aborted ? "音频生成已取消。" : error instanceof Error ? error.message : "音频生成失败。";
      await savePodcast({
        ...current,
        audioStatus: "partial",
        lastError: message,
        generation: {
          ...progress("audio", aborted ? "cancelled" : "failed", message, startedAt),
          status: aborted ? "cancelled" : "failed",
        },
      });
    } finally {
      controllers.delete(key);
      emit();
    }
  })();
};
