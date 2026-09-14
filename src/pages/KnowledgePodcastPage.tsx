import {
  ArrowLeft,
  ChevronDown,
  CircleAlert,
  FastForward,
  Headphones,
  Pause,
  Play,
  Plus,
  RotateCcw,
  Repeat,
  Repeat1,
  Rewind,
  Save,
  Settings,
  Shuffle,
  SkipBack,
  SkipForward,
  Sliders,
  Sparkles,
  Trash2,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

import { AiKnowledgeScopePicker } from "../components/AiKnowledgeScopePicker";
import { todayISO } from "../lib/date";
import type { AppSettings, Asset, Block, KnowledgePodcast, KnowledgePodcastAudioUnit, KnowledgePodcastCreativeBrief, KnowledgePodcastSegment, RecordBlock } from "../types";
import {
  applyPodcastCreativeBriefMode,
  buildPodcastPromptPreview,
  createEmptyPodcast,
  estimatePodcastScriptDuration,
  getPodcastCreativeBriefDefaults,
  getPodcastCreativeBriefWithDefaults,
  invalidatePodcastAudioUnits,
  PODCAST_DURATION_TOLERANCE,
} from "../services/knowledgePodcastService";
import { storage } from "../services/storageAdapter";
import { aiKnowledgeScopeTitle, buildAiKnowledgeContextPack, getAiKnowledgeScopeRecords } from "../services/aiContextService";
import { PageHeader } from "../components/ui";
import { usePlayback } from "../components/PlaybackProvider";
import type { PlaybackMode } from "../services/nativeMediaPlayback";
import {
  cancelKnowledgePodcastJob,
  isKnowledgePodcastJobRunning,
  startKnowledgePodcastAudioJob,
  startKnowledgePodcastScriptJob,
} from "../services/knowledgePodcastJobService";
import { normalizeTtsConfig, getCurrentTtsProvider } from "../lib/ttsProviders";
import { formatUiError } from "../lib/uiError";

interface KnowledgePodcastPageProps {
  settings?: AppSettings;
  podcasts: KnowledgePodcast[];
  blocks: Block[];
  assets: Asset[];
  podcastId?: string;
  screen?: "editor" | "scope";
  onBack: () => void;
  onOpenScope: () => void;
  onOpenPodcast: (id: string) => void;
  onSavePodcast: (podcast: KnowledgePodcast) => Promise<KnowledgePodcast>;
  onDeletePodcast: (id: string) => Promise<void>;
  onOpenRecord: (record: RecordBlock) => void;
  onOpenSettings?: () => void;
  onOpenTemplates?: () => void;
}

const recordsOf = (blocks: Block[]) => blocks.filter((block): block is RecordBlock => block.type === "record" && !block.deletedAt);

const modeLabel = (podcast: Pick<KnowledgePodcast, "mode" | "customMode">) =>
  podcast.mode === "summary" ? "精炼回顾" : podcast.mode === "explain" ? "复习讲解" : podcast.customMode?.title || "自定义模式";

const formatTime = (seconds: number) => {
  if (!Number.isFinite(seconds)) return "0:00";
  const minutes = Math.floor(seconds / 60);
  const rest = Math.floor(seconds % 60).toString().padStart(2, "0");
  return `${minutes}:${rest}`;
};

const formatElapsed = (startedAt: string | undefined, currentTime: number): string => {
  if (!startedAt) return "";
  const seconds = Math.max(0, Math.floor((currentTime - new Date(startedAt).getTime()) / 1000));
  return seconds < 60 ? `${seconds} 秒` : `${Math.floor(seconds / 60)} 分 ${seconds % 60} 秒`;
};

const formatAgo = (timestamp: string | undefined, currentTime: number): string => {
  if (!timestamp) return "";
  const seconds = Math.max(0, Math.floor((currentTime - new Date(timestamp).getTime()) / 1000));
  return seconds < 60 ? `${seconds} 秒前` : `${Math.floor(seconds / 60)} 分钟前`;
};

const formatDuration = (seconds: number) => {
  const whole = Math.max(0, Math.floor(seconds));
  return `${Math.floor(whole / 60)} 分 ${whole % 60} 秒`;
};

const getAudioUrl = (asset: Asset | undefined) => asset ? URL.createObjectURL(asset.data) : undefined;

const nextPlaybackMode = (mode: PlaybackMode): PlaybackMode =>
  mode === "order" ? "single" : mode === "single" ? "shuffle" : "order";

const playbackModeLabel: Record<PlaybackMode, string> = {
  order: "顺序播放",
  single: "单曲循环",
  shuffle: "随机播放",
};

const PLANNER_SUGGESTIONS = {
  objective: ["精炼回顾", "复习讲解", "错题抽测", "系统讲解", "知识串联"],
  audience: ["未来的自己", "入门学习者", "考前复习者", "专业同行"],
  narratorRole: ["清晰的知识整理者", "耐心的复习老师", "提问式复习教练", "自然的播客主持人"],
  tone: ["简洁、自然、重点明确", "自然口语化、清晰严谨", "严格考试导向", "鼓励式、循序渐进"],
  organization: ["按主题组织", "按难度递进", "按时间线组织", "问题解答式"],
} as const;

const PlannerInput = ({
  label,
  value,
  onChange,
  suggestions,
  placeholder,
}: {
  label: string;
  value?: string;
  onChange: (value: string) => void;
  suggestions: readonly string[];
  placeholder: string;
}) => {
  const listId = `podcast-planner-${label}`;
  return <label className="podcast-planner-field"><span>{label}</span><input list={listId} value={value ?? ""} onChange={(event) => onChange(event.target.value)} placeholder={placeholder} /><datalist id={listId}>{suggestions.map((item) => <option key={item} value={item} />)}</datalist></label>;
};

export const KnowledgePodcastPage = ({
  settings,
  podcasts,
  blocks,
  assets,
  podcastId,
  screen = "editor",
  onBack,
  onOpenScope,
  onOpenPodcast,
  onSavePodcast,
  onDeletePodcast,
  onOpenRecord,
  onOpenSettings,
  onOpenTemplates,
}: KnowledgePodcastPageProps) => {
  const records = useMemo(() => recordsOf(blocks), [blocks]);
  const selected = podcasts.find((item) => item.id === podcastId);
  if (!selected) {
    return (
        <PodcastList
        podcasts={podcasts}
        onBack={onBack}
        onOpenPodcast={onOpenPodcast}
        onOpenSettings={onOpenSettings}
        onOpenTemplates={onOpenTemplates}
        onCreate={() => {
          const next = createEmptyPodcast({ kind: "recent", days: 7 });
          void onSavePodcast(next).then((saved) => onOpenPodcast(saved.id));
        }}
      />
    );
  }
  if (screen === "scope") {
    return (
      <AiKnowledgeScopePicker
        blocks={blocks}
        assets={assets}
        initialScope={selected.scope}
        includeDate
        eyebrow="Knowledge Podcast"
        title="选择播客知识范围"
        ariaLabel="选择播客知识范围"
        confirmLabel="使用此范围"
        onBack={onBack}
        onConfirm={async (scope) => {
          const sourceRecords = getAiKnowledgeScopeRecords(scope, blocks, todayISO());
          await onSavePodcast({
            ...selected,
            scope,
            sourceRecordIds: sourceRecords.map((record) => record.id),
            scriptStatus: JSON.stringify(selected.scope) === JSON.stringify(scope) ? selected.scriptStatus : "idle",
            updatedAt: new Date().toISOString(),
          });
          onBack();
        }}
      />
    );
  }
  return (
    <PodcastEditor
      podcast={selected}
      settings={settings}
      records={records}
      assets={assets}
      onBack={onBack}
      onOpenScope={onOpenScope}
      onSavePodcast={onSavePodcast}
      onDeletePodcast={onDeletePodcast}
      onOpenRecord={onOpenRecord}
      onOpenSettings={onOpenSettings}
    />
  );
};

const PodcastList = ({
  podcasts,
  onBack,
  onOpenPodcast,
  onOpenSettings,
  onOpenTemplates,
  onCreate,
}: {
  podcasts: KnowledgePodcast[];
  onBack: () => void;
  onOpenPodcast: (id: string) => void;
  onOpenSettings?: () => void;
  onOpenTemplates?: () => void;
  onCreate: () => void;
}) => (
  <main className="page knowledge-podcast-page">
    <PageHeader
      eyebrow="Knowledge Podcast"
      title="知识播客"
      subtitle="把本地学习记录整理成可收听、可回溯的知识回顾。先生成文字稿，再按章节合成语音。"
      actions={
        <>
          {onOpenSettings && <button type="button" className="secondary-button" onClick={onOpenSettings}><Settings size={17} />TTS 设置</button>}
          {onOpenTemplates && <button type="button" className="secondary-button" onClick={onOpenTemplates}><Sliders size={17} />高级模板</button>}
          <button type="button" className="primary-button" onClick={onCreate}><Plus size={17} />新建播客</button>
          <button type="button" className="secondary-button" onClick={onBack}><ArrowLeft size={17} />返回</button>
        </>
      }
    />
    <section className="podcast-list">
      {podcasts.length === 0 ? <div className="empty-state"><h2>还没有知识播客</h2><p>从最近记录开始生成你的第一期知识回顾。</p></div> : podcasts.map((podcast) => (
        <button type="button" className="podcast-list-row" key={podcast.id} onClick={() => onOpenPodcast(podcast.id)}>
          <span className="podcast-list-icon"><Headphones size={20} /></span>
          <span><strong>{podcast.title}</strong><small>{modeLabel(podcast)} · {podcast.segments.length} 个章节 · {podcast.scope ? aiKnowledgeScopeTitle(podcast.scope) : "未设置范围"}</small></span>
          <span className={`podcast-status ${podcast.audioStatus}`}>{podcast.audioStatus === "ready" ? "可播放" : podcast.scriptStatus === "ready" ? "脚本已就绪" : "草稿"}</span>
        </button>
      ))}
    </section>
  </main>
);

const PodcastEditor = ({
  podcast: initialPodcast,
  settings,
  records,
  assets,
  onBack,
  onOpenScope,
  onSavePodcast,
  onDeletePodcast,
  onOpenRecord,
  onOpenSettings,
}: {
  podcast: KnowledgePodcast;
  settings?: AppSettings;
  records: RecordBlock[];
  assets: Asset[];
  onBack: () => void;
  onOpenScope: () => void;
  onSavePodcast: (podcast: KnowledgePodcast) => Promise<KnowledgePodcast>;
  onDeletePodcast: (id: string) => Promise<void>;
  onOpenRecord: (record: RecordBlock) => void;
  onOpenSettings?: () => void;
}) => {
  const playback = usePlayback();
  const [podcast, setPodcast] = useState(initialPodcast);
  const [message, setMessage] = useState("");
  const [voiceChangeChoiceOpen, setVoiceChangeChoiceOpen] = useState(false);
  const [currentTime, setCurrentTime] = useState(Date.now());
  const [playingUnitId, setPlayingUnitId] = useState<string>();
  const [playing, setPlaying] = useState(false);
  const [position, setPosition] = useState(initialPodcast.playback?.positionSeconds ?? 0);
  const [playbackRate, setPlaybackRate] = useState(1);
  const [nativeFallbackAssetId, setNativeFallbackAssetId] = useState<string>();
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const urlRef = useRef<string>();
  const lastPlaybackSaveRef = useRef(0);
  const scriptRunning = podcast.scriptStatus === "generating" || isKnowledgePodcastJobRunning(podcast.id, "script");
  const audioRunning = podcast.audioStatus === "generating" || isKnowledgePodcastJobRunning(podcast.id, "audio");
  const sourceMap = useMemo(() => new Map(records.map((record) => [record.id, record])), [records]);
  const currentContextHash = useMemo(() => {
    if (podcast.scriptStatus !== "ready") return podcast.contextHash;
    try { return buildAiKnowledgeContextPack(podcast.scope, records, assets).contextHash; } catch { return podcast.contextHash; }
  }, [assets, podcast.contextHash, podcast.scope, podcast.scriptStatus, records]);
  const sourceChanged = Boolean(podcast.contextHash && currentContextHash && podcast.contextHash !== currentContextHash);
  const legacyAudioLayout = podcast.audioLayoutVersion !== 2;
  const audioUnits = podcast.audioUnits ?? [];
  const useNativePlayback = playback.nativeEnabled && !nativeFallbackAssetId;
  const nativeQueueId = `podcast:${podcast.id}`;
  const nativePodcastSessionActive = useNativePlayback && playback.state.queueId === nativeQueueId;
  const nativePlayingUnitId = nativePodcastSessionActive
    ? audioUnits.find((unit) => unit.audioAssetId === playback.state.itemId)?.id
    : undefined;
  const activePlayingUnitId = nativePodcastSessionActive ? nativePlayingUnitId : useNativePlayback ? undefined : playingUnitId;
  const activePlaying = nativePodcastSessionActive ? playback.state.status === "playing" : useNativePlayback ? false : playing;
  const activePosition = nativePodcastSessionActive ? playback.state.positionSeconds : useNativePlayback ? 0 : position;
  const activePlaybackRate = nativePodcastSessionActive ? playback.state.speed : playbackRate;
  const failedUnits = audioUnits.filter((unit) => unit.audioStatus === "failed");
  const openingUnit = audioUnits.find((unit) => unit.kind === "opening");
  const closingUnit = audioUnits.find((unit) => unit.kind === "closing");
  const unitForSegment = (segmentId: string) => audioUnits.find((unit) => unit.kind === "segment" && unit.segmentId === segmentId);
  const unitStatusLabel = (unit: KnowledgePodcastAudioUnit | undefined) => unit?.audioStatus === "ready" ? "已生成" : unit?.audioStatus === "failed" ? "失败" : "待生成";
  const modeTemplates = useMemo(() => [...(settings?.knowledgePodcastModeTemplates ?? [])].sort((a, b) => a.order - b.order), [settings?.knowledgePodcastModeTemplates]);
  const scriptEstimate = useMemo(() => estimatePodcastScriptDuration(podcast, podcast.targetMinutes), [podcast]);
  const durationOutsideTarget = Boolean(scriptEstimate.speechCharacterCount) && Math.abs(scriptEstimate.durationTargetDeviation ?? 0) > PODCAST_DURATION_TOLERANCE;
  const globalVoiceId = getCurrentTtsProvider(normalizeTtsConfig(settings?.tts))?.voice?.trim();
  const voiceHasChanged = Boolean(globalVoiceId && podcast.ttsConfig.voiceId && globalVoiceId !== podcast.ttsConfig.voiceId && audioUnits.some((unit) => unit.audioStatus === "ready"));
  const creativeBrief = useMemo(
    () => getPodcastCreativeBriefWithDefaults(podcast.creativeBrief, podcast.mode, podcast.focusInstruction),
    [podcast.creativeBrief, podcast.focusInstruction, podcast.mode],
  );
  const scriptNeedsRegeneration = podcast.scriptStatus === "idle" && Boolean(podcast.opening?.trim() || podcast.closing?.trim() || podcast.segments.length);
  const scopeRecordCount = useMemo(
    () => getAiKnowledgeScopeRecords(podcast.scope, records, todayISO()).length,
    [podcast.scope, records],
  );
  const promptPreview = useMemo(() => {
    try {
      return {
        value: buildPodcastPromptPreview({
          mode: podcast.mode,
          customMode: podcast.customMode,
          creativeBrief,
          focusInstruction: podcast.focusInstruction,
          targetMinutes: podcast.targetMinutes,
          scopeTitle: aiKnowledgeScopeTitle(podcast.scope),
        }),
      };
    } catch (error) {
      return { error: formatUiError(error, "generic") };
    }
  }, [creativeBrief, podcast.customMode, podcast.focusInstruction, podcast.mode, podcast.scope, podcast.targetMinutes]);

  useEffect(() => {
    setPodcast(initialPodcast);
  }, [initialPodcast, records]);
  useEffect(() => {
    setNativeFallbackAssetId(undefined);
  }, [initialPodcast.id]);
  useEffect(() => () => {
    audioRef.current?.pause();
    if (urlRef.current) URL.revokeObjectURL(urlRef.current);
  }, []);
  useEffect(() => {
    if (podcast.generation?.status !== "running") return undefined;
    const timer = window.setInterval(() => setCurrentTime(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [podcast.generation?.status]);
  const updatePodcast = (patch: Partial<KnowledgePodcast>) => setPodcast((current) => ({ ...current, ...patch, updatedAt: new Date().toISOString() }));
  const updateCreativeBrief = (patch: Partial<KnowledgePodcastCreativeBrief>) => setPodcast((current) => ({
    ...current,
    creativeBrief: { ...getPodcastCreativeBriefWithDefaults(current.creativeBrief, current.mode, current.focusInstruction), ...patch },
    scriptStatus: "idle",
    updatedAt: new Date().toISOString(),
  }));

  const saveDraft = async () => {
    const saved = await onSavePodcast({ ...podcast, creativeBrief, ...scriptEstimate });
    setPodcast(saved);
    setMessage("播客草稿已保存。");
  };

  const generateScript = async () => {
    if (promptPreview.error) { setMessage(promptPreview.error); return; }
    const scope = podcast.scope;
    const sourceRecords = getAiKnowledgeScopeRecords(scope, records, todayISO());
    if (sourceRecords.length === 0) { setMessage("当前范围没有可用于播客的记录。"); return; }
    const draft = { ...podcast, creativeBrief, scope, audioStatus: "idle" as const, sourceRecordIds: sourceRecords.map((record) => record.id), lastError: undefined };
    try {
      const saved = await onSavePodcast(draft);
      setPodcast(saved);
      await startKnowledgePodcastScriptJob(saved.id);
      setMessage("脚本已转入后台生成，可以切换到其他页面。");
    } catch (error) {
      setMessage(formatUiError(error, "ai-request"));
    }
  };

  const startAudioGeneration = async (draft: KnowledgePodcast, onlyUnitId?: string) => {
    try {
      const saved = await onSavePodcast({ ...draft, ...estimatePodcastScriptDuration(draft, draft.targetMinutes) });
      setPodcast(saved);
      await startKnowledgePodcastAudioJob(saved.id, onlyUnitId);
      setMessage("音频已转入后台生成，可以切换到其他页面。");
    } catch (error) {
      setMessage(formatUiError(error, "ai-request"));
    }
  };

  const generateAudio = async (onlyUnitId?: string) => {
    const ttsProvider = getCurrentTtsProvider(normalizeTtsConfig(settings?.tts));
    if (!ttsProvider) {
      setMessage("请先在 AI 工具设置中配置 TTS 语音服务。");
      return;
    }
    if (!onlyUnitId && voiceHasChanged) {
      setVoiceChangeChoiceOpen(true);
      return;
    }
    await startAudioGeneration(podcast, onlyUnitId);
  };

  const playInWebView = async (unit: KnowledgePodcastAudioUnit, asset: Asset, startAt: number) => {
    audioRef.current?.pause();
    if (urlRef.current) URL.revokeObjectURL(urlRef.current);
    const url = getAudioUrl(asset); if (!url) return;
    urlRef.current = url;
    const audio = new Audio(url); audioRef.current = audio; audio.playbackRate = playbackRate;
    audio.currentTime = startAt;
    audio.ontimeupdate = () => {
      setPosition(audio.currentTime);
      if (Date.now() - lastPlaybackSaveRef.current > 2000) {
        lastPlaybackSaveRef.current = Date.now();
        void storage.saveKnowledgePodcast?.({ ...podcast, playback: { unitId: unit.id, positionSeconds: audio.currentTime } });
      }
    };
    audio.onloadedmetadata = () => {
      if (!Number.isFinite(audio.duration)) return;
      void storage.patchAsset?.(asset.id, { durationSeconds: audio.duration });
      const updated = {
        ...podcast,
        audioUnits: podcast.audioUnits?.map((item) => item.id === unit.id ? { ...item, durationSeconds: audio.duration } : item),
      };
      setPodcast(updated);
      void storage.saveKnowledgePodcast?.(updated);
    };
    audio.onerror = () => setMessage("该音频无法播放，请重新生成此章节音频。 ");
    audio.onplay = () => { setPlaying(true); setPlayingUnitId(unit.id); };
    audio.onpause = () => setPlaying(false);
    audio.onended = () => {
      const next = audioUnits.find((item) => item.order === unit.order + 1 && item.audioStatus === "ready");
      if (next) void playUnit(next); else setPlaying(false);
    };
    try {
      await audio.play();
    } catch (error) {
      setMessage(formatUiError(error, "generic"));
      return;
    }
    const saved = { ...podcast, playback: { unitId: unit.id, positionSeconds: startAt } };
    setPodcast(saved); await onSavePodcast(saved);
  };

  const playUnit = async (unit: KnowledgePodcastAudioUnit, startAt = 0) => {
    const asset = unit.audioAssetId ? assets.find((item) => item.id === unit.audioAssetId) : undefined;
    if (!asset) { setMessage("该音频单元尚未生成，请重新生成。 "); return; }
    const shouldTryNative = playback.nativeEnabled && nativeFallbackAssetId !== asset.id;
    if (shouldTryNative) {
      if (nativePodcastSessionActive && playback.state.itemId === asset.id) {
        if (playback.state.status === "playing") {
          await playback.pause();
        } else {
          await playback.play();
        }
        return;
      }
      const readyItems = audioUnits
        .filter((item) => item.audioStatus === "ready" && item.audioAssetId)
        .map((item) => {
          const itemAsset = assets.find((candidate) => candidate.id === item.audioAssetId);
          return itemAsset ? { item, asset: itemAsset } : undefined;
        })
        .filter((item): item is { item: KnowledgePodcastAudioUnit; asset: Asset } => Boolean(item));
      try {
        await playback.startQueue({
          queueId: nativeQueueId,
          items: readyItems.map(({ item, asset: itemAsset }) => ({ asset: itemAsset, title: item.title, subtitle: podcast.title })),
          initialAssetId: asset.id,
          positionSeconds: startAt,
          speed: playbackRate,
          mode: nativePodcastSessionActive ? playback.state.mode : "order",
        });
        setNativeFallbackAssetId(undefined);
        const saved = { ...podcast, playback: { unitId: unit.id, positionSeconds: startAt } };
        setPodcast(saved);
        await onSavePodcast(saved);
        return;
      } catch (error) {
        setNativeFallbackAssetId(asset.id);
        setMessage(formatUiError(error, "generic"));
      }
    }
    await playInWebView(unit, asset, startAt);
  };

  useEffect(() => {
    if (!useNativePlayback && audioRef.current) {
      audioRef.current.playbackRate = playbackRate;
    }
  }, [playbackRate, useNativePlayback]);

  useEffect(() => {
    if (!useNativePlayback || !nativePlayingUnitId || !playback.state.positionSeconds) return;
    if (Date.now() - lastPlaybackSaveRef.current < 2_000) return;
    lastPlaybackSaveRef.current = Date.now();
    void storage.saveKnowledgePodcast?.({
      ...podcast,
      playback: { unitId: nativePlayingUnitId, positionSeconds: playback.state.positionSeconds },
    });
  }, [nativePlayingUnitId, playback.state.positionSeconds, podcast, useNativePlayback]);

  const stopPlayback = () => {
    if (useNativePlayback) {
      if (activePlayingUnitId) {
        void storage.saveKnowledgePodcast?.({ ...podcast, playback: { unitId: activePlayingUnitId, positionSeconds: playback.state.positionSeconds } });
      }
      void playback.pause();
      return;
    }
    if (audioRef.current && playingUnitId) {
      void storage.saveKnowledgePodcast?.({ ...podcast, playback: { unitId: playingUnitId, positionSeconds: audioRef.current.currentTime } });
    }
    audioRef.current?.pause();
    setPlaying(false);
  };

  const playAdjacent = (direction: -1 | 1) => {
    if (useNativePlayback) {
      if (direction < 0) void playback.previous(); else void playback.next();
      return;
    }
    const activeId = playingUnitId ?? podcast.playback?.unitId ?? podcast.playback?.segmentId;
    const currentOrder = audioUnits.find((unit) => unit.id === activeId)?.order ?? -1;
    const next = audioUnits.find((unit) => unit.order === currentOrder + direction && unit.audioStatus === "ready");
    if (next) void playUnit(next);
  };

  const invalidateUnit = (current: KnowledgePodcast, kind: KnowledgePodcastAudioUnit["kind"], segmentId?: string): KnowledgePodcast => ({
    ...current,
    audioStatus: "idle",
    audioUnits: current.audioUnits?.map((unit) => unit.kind === kind && (kind !== "segment" || unit.segmentId === segmentId)
      ? { ...unit, textHash: "", audioStatus: "pending", error: undefined }
      : unit),
  });

  const updateSegment = (id: string, patch: Partial<KnowledgePodcastSegment>) => {
    setPodcast((current) => {
      const next = {
        ...current,
        segments: current.segments.map((segment) => segment.id === id ? { ...segment, ...patch, ...(patch.text !== undefined ? { textHash: "", audioStatus: "pending" as const } : {}) } : segment),
        audioUnits: patch.title !== undefined ? current.audioUnits?.map((unit) => unit.kind === "segment" && unit.segmentId === id ? { ...unit, title: patch.title?.trim() || unit.title } : unit) : current.audioUnits,
      };
      return patch.text !== undefined ? invalidateUnit(next, "segment", id) : next;
    });
  };

  const changeMode = (value: string) => {
    if (value === "summary" || value === "explain") {
      updatePodcast({
        mode: value,
        customMode: undefined,
        creativeBrief: applyPodcastCreativeBriefMode(podcast.creativeBrief, podcast.mode, value, podcast.focusInstruction),
        scriptStatus: "idle",
      });
      return;
    }
    const template = modeTemplates.find((item) => item.id === value.replace(/^custom:/, ""));
    if (!template) return;
    updatePodcast({
      mode: "custom",
      customMode: { templateId: template.id, title: template.title, prompt: template.prompt },
      creativeBrief: applyPodcastCreativeBriefMode(podcast.creativeBrief, podcast.mode, "custom", podcast.focusInstruction),
      scriptStatus: "idle",
    });
  };

  const restoreModeRecommendations = () => {
    const defaults = getPodcastCreativeBriefDefaults(podcast.mode);
    updatePodcast({
      creativeBrief: {
        ...defaults,
        ...(creativeBrief.supplementaryRequirements ? { supplementaryRequirements: creativeBrief.supplementaryRequirements } : {}),
      },
      scriptStatus: "idle",
    });
  };

  return (
    <main className="page knowledge-podcast-page podcast-editor-page">
      <PageHeader eyebrow="Knowledge Podcast" title={podcast.title || "未命名知识播客"} subtitle="编辑脚本、生成章节音频并回到来源记录。" actions={<button type="button" className="secondary-button" onClick={onBack} aria-label="返回列表"><ArrowLeft size={17} /></button>} />
      <section className="podcast-settings-band" aria-label="播客设置">
        <section className="podcast-editor-toolbar">
          <label>标题<input value={podcast.title} onChange={(event) => updatePodcast({ title: event.target.value })} /></label>
          <label>模式<select value={podcast.mode === "custom" ? `custom:${podcast.customMode?.templateId ?? ""}` : podcast.mode} onChange={(event) => changeMode(event.target.value)}><option value="summary">精炼回顾</option><option value="explain">复习讲解</option>{podcast.mode === "custom" && podcast.customMode && !modeTemplates.some((template) => template.id === podcast.customMode!.templateId) && <option value={`custom:${podcast.customMode.templateId}`}>{podcast.customMode.title}（已保存快照）</option>}{modeTemplates.map((template) => <option key={template.id} value={`custom:${template.id}`}>{template.title}</option>)}</select></label>
          <label>目标时长<select value={podcast.targetMinutes} onChange={(event) => updatePodcast({ targetMinutes: Number(event.target.value) as KnowledgePodcast["targetMinutes"], scriptStatus: "idle" })}><option value={3}>3 分钟</option><option value={5}>5 分钟</option><option value={10}>10 分钟</option></select></label>
        </section>
        <details className="podcast-settings-row podcast-planner-card">
          <summary className="podcast-settings-row-summary">
            <span className="podcast-settings-row-title">节目策划</span>
            <span className="podcast-settings-row-value">{modeLabel(podcast)} · {podcast.mode === "custom" ? "自定义要求" : "使用模式推荐"}</span>
            <ChevronDown className="podcast-settings-row-chevron" size={17} aria-hidden="true" />
          </summary>
          <div className="podcast-planner-content">
            {(podcast.mode === "summary" || podcast.mode === "explain") && <div className="podcast-planner-tools"><button type="button" className="subtle-button" onClick={restoreModeRecommendations}>恢复模式推荐设置</button></div>}
        <details className="podcast-planner-group">
          <summary>节目定位</summary>
          <div className="podcast-planner-grid">
            <PlannerInput label="节目目标" value={creativeBrief.objective} onChange={(value) => updateCreativeBrief({ objective: value })} suggestions={PLANNER_SUGGESTIONS.objective} placeholder="例如：错题抽测" />
            <PlannerInput label="目标听众" value={creativeBrief.audience} onChange={(value) => updateCreativeBrief({ audience: value })} suggestions={PLANNER_SUGGESTIONS.audience} placeholder="例如：未来的自己" />
            <PlannerInput label="讲述角色" value={creativeBrief.narratorRole} onChange={(value) => updateCreativeBrief({ narratorRole: value })} suggestions={PLANNER_SUGGESTIONS.narratorRole} placeholder="例如：耐心的复习老师" />
            <PlannerInput label="讲述风格" value={creativeBrief.tone} onChange={(value) => updateCreativeBrief({ tone: value })} suggestions={PLANNER_SUGGESTIONS.tone} placeholder="例如：自然口语化、清晰严谨" />
          </div>
        </details>
        <details className="podcast-planner-group">
          <summary>内容组织</summary>
          <div className="podcast-planner-grid">
            <PlannerInput label="组织结构" value={creativeBrief.organization} onChange={(value) => updateCreativeBrief({ organization: value })} suggestions={PLANNER_SUGGESTIONS.organization} placeholder="例如：按难度递进" />
            <label className="podcast-planner-field"><span>必须覆盖</span><textarea value={creativeBrief.mustCover ?? ""} onChange={(event) => updateCreativeBrief({ mustCover: event.target.value })} rows={2} placeholder="例如：并查集的适用条件、路径压缩和复杂度" /></label>
            <label className="podcast-planner-field"><span>避免内容</span><textarea value={creativeBrief.avoid ?? ""} onChange={(event) => updateCreativeBrief({ avoid: event.target.value })} rows={2} placeholder="例如：不要逐条复述日志；不要延伸到范围外的算法" /></label>
          </div>
        </details>
        <details className="podcast-planner-group">
          <summary>脚本结构与本期补充</summary>
          <div className="podcast-planner-grid">
            <label className="podcast-planner-field"><span>每章固定要素</span><textarea value={creativeBrief.chapterRequirements ?? ""} onChange={(event) => updateCreativeBrief({ chapterRequirements: event.target.value })} rows={2} placeholder="例如：每章包含概念、例子、易错点和一个自测问题" /></label>
            <label className="podcast-planner-field"><span>开场要求</span><textarea value={creativeBrief.openingRequirements ?? ""} onChange={(event) => updateCreativeBrief({ openingRequirements: event.target.value })} rows={2} placeholder="例如：直接提出本期要解决的问题，不要寒暄" /></label>
            <label className="podcast-planner-field"><span>结尾要求</span><textarea value={creativeBrief.closingRequirements ?? ""} onChange={(event) => updateCreativeBrief({ closingRequirements: event.target.value })} rows={2} placeholder="例如：用三个复习问题收尾" /></label>
            <label className="podcast-planner-field podcast-planner-field-full"><span>本期补充要求</span><textarea value={creativeBrief.supplementaryRequirements ?? ""} onChange={(event) => updateCreativeBrief({ supplementaryRequirements: event.target.value })} rows={2} placeholder="例如：只讲并查集的易错点和适用条件；不需要逐条复述所有日志。" /></label>
          </div>
        </details>
        {podcast.mode === "custom" && <p className="helper-text">当前高级模板：{podcast.customMode?.title || "自定义模式"}。模板 Prompt 已为本期保存快照，之后修改全局模板不会改写它。</p>}
        <details className="podcast-prompt-preview">
          <summary>查看本期生成指令预览</summary>
          {promptPreview.error ? <p className="error-text">{promptPreview.error}</p> : <><p>预览不包含完整本地日志正文；生成时会将当前范围的 RAG 上下文作为独立附件发送。</p><pre>{promptPreview.value}</pre></>}
        </details>
          </div>
        </details>
        <section className="podcast-settings-row podcast-scope-row">
          <span className="podcast-settings-row-title">知识范围</span>
          <span className="podcast-settings-row-value">{aiKnowledgeScopeTitle(podcast.scope)} · 命中 {scopeRecordCount} 条日志</span>
          <button type="button" className="podcast-scope-edit" onClick={onOpenScope}>修改知识范围</button>
        </section>
      </section>
      {message && <p className="status-message">{message}</p>}
      {podcast.generation && (
        <section className={`podcast-generation-status ${podcast.generation.status}`} role="status" aria-live="polite">
          <div>
            <strong>{podcast.generation.message}</strong>
            <small>
              {[podcast.generation.providerName, podcast.generation.model].filter(Boolean).join(" / ")}
              {podcast.generation.status === "running" ? ` · 已用时 ${formatElapsed(podcast.generation.startedAt, currentTime)}` : ""}
              {podcast.generation.status === "running" && podcast.generation.heartbeatAt ? ` · 最近活动 ${formatAgo(podcast.generation.heartbeatAt, currentTime)}` : ""}
              {podcast.generation.current !== undefined && podcast.generation.total !== undefined ? ` · ${podcast.generation.current}/${podcast.generation.total}` : ""}
              {podcast.generation.partCurrent !== undefined && podcast.generation.partTotal !== undefined ? ` · 分片 ${podcast.generation.partCurrent}/${podcast.generation.partTotal}` : ""}
            </small>
          </div>
          {podcast.generation.status === "running" && (
            <button type="button" className="secondary-button" onClick={() => cancelKnowledgePodcastJob(podcast.id, podcast.generation!.kind)}>取消</button>
          )}
        </section>
      )}
      {scriptNeedsRegeneration && <p className="status-message">当前脚本与音频会保留并可继续播放；节目策划、时长或模式已改变，重新生成脚本后才会应用新要求。</p>}
      {sourceChanged && <p className="status-message">来源记录已更新，建议重新生成脚本；当前手工编辑内容不会被自动覆盖。</p>}
      {legacyAudioLayout && podcast.segments.some((segment) => segment.audioAssetId) && <p className="status-message">音频格式已更新，需要重新生成整期音频后，开场、章节与结尾才会作为独立录音播放。</p>}
      {podcast.lastError && <p className="error-message"><CircleAlert size={16} />{podcast.lastError}</p>}
      {voiceChangeChoiceOpen && <section className="podcast-voice-change-card" role="alert">
        <strong>全局 Voice ID 已更改</strong>
        <p>已生成的 MP3 不会自动修改。继续补全会让本期可能混合两种音色；推荐按新 Voice 重生成整期。</p>
        <div className="podcast-actions">
          <button type="button" className="primary-button" onClick={() => { setVoiceChangeChoiceOpen(false); void startAudioGeneration(invalidatePodcastAudioUnits(podcast)); }}>按新 Voice 重生成整期</button>
          <button type="button" className="secondary-button" onClick={() => { setVoiceChangeChoiceOpen(false); void startAudioGeneration(podcast); }}>仅继续缺失单元</button>
          <button type="button" className="secondary-button" onClick={() => setVoiceChangeChoiceOpen(false)}>取消</button>
        </div>
      </section>}
      <p className={`podcast-duration-estimate ${durationOutsideTarget ? "out-of-range" : ""}`}>预计朗读时长 {formatDuration(scriptEstimate.estimatedDurationSeconds ?? 0)} · {scriptEstimate.speechCharacterCount ?? 0} 字 · 目标 {podcast.targetMinutes} 分钟{durationOutsideTarget ? "（偏差较大，可编辑脚本或重新生成）" : ""}</p>
      <section className="podcast-actions">
        <button type="button" className="secondary-button" onClick={() => void saveDraft()}><Save size={17} />保存草稿</button>
        <button type="button" className="primary-button" onClick={() => void generateScript()} disabled={scriptRunning || audioRunning}><Sparkles size={17} />{scriptRunning ? "生成脚本中…" : "生成脚本"}</button>
        <button type="button" className="primary-button" onClick={() => void generateAudio(undefined)} disabled={scriptRunning || audioRunning || podcast.scriptStatus !== "ready"}><Headphones size={17} />{audioRunning ? "生成音频中…" : legacyAudioLayout ? "重新生成整期音频" : "生成音频"}</button>
        {failedUnits.length > 0 && !audioRunning && <button type="button" className="secondary-button" onClick={() => void generateAudio(undefined)} disabled={scriptRunning}><RotateCcw size={17} />重试全部失败（{failedUnits.length}）</button>}
      </section>
      <section className="podcast-script-card">
        <article className="podcast-segment-card">
          <header><strong>开场</strong><span>{unitStatusLabel(openingUnit)}</span></header>
          <textarea value={podcast.opening ?? ""} onChange={(event) => setPodcast((current) => invalidateUnit({ ...current, opening: event.target.value }, "opening"))} rows={3} placeholder="生成脚本后可编辑开场" />
          {openingUnit && <footer>
            {openingUnit.audioStatus === "failed" && <button type="button" className="secondary-button" onClick={() => void generateAudio(openingUnit.id)}><RotateCcw size={15} />重试</button>}
            {openingUnit.audioStatus === "ready" && <button type="button" className="secondary-button" onClick={() => activePlaying && activePlayingUnitId === openingUnit.id ? stopPlayback() : void playUnit(openingUnit)}>{activePlaying && activePlayingUnitId === openingUnit.id ? <Pause size={15} /> : <Play size={15} />}{activePlaying && activePlayingUnitId === openingUnit.id ? "暂停" : "播放"}</button>}
            {openingUnit.error && <small className="error-text">{openingUnit.error}</small>}
          </footer>}
        </article>
        <div className="podcast-segment-list">
          {podcast.segments.length === 0 && <div className="empty-state"><h2>还没有脚本</h2><p>选择知识范围后生成一份脚本。</p></div>}
          {podcast.segments.map((segment) => {
            const unit = unitForSegment(segment.id);
            return <article className="podcast-segment-card" key={segment.id}>
              <header><input value={segment.title} onChange={(event) => updateSegment(segment.id, { title: event.target.value })} /><span>{unitStatusLabel(unit)}</span></header>
              <textarea value={segment.text} onChange={(event) => updateSegment(segment.id, { text: event.target.value })} rows={6} />
              <footer>
                <span>来源 {segment.sourceRecordIds.length} 条</span>
                {segment.sourceRecordIds.map((id) => sourceMap.get(id)).filter(Boolean).map((record) => <button type="button" className="link-button" key={record!.id} onClick={() => onOpenRecord(record!)}>{record!.title}</button>)}
                {unit?.audioStatus === "failed" && <button type="button" className="secondary-button" onClick={() => void generateAudio(unit.id)}><RotateCcw size={15} />重试</button>}
                {unit?.audioStatus === "ready" && <button type="button" className="secondary-button" onClick={() => activePlaying && activePlayingUnitId === unit.id ? stopPlayback() : void playUnit(unit)}>{activePlaying && activePlayingUnitId === unit.id ? <Pause size={15} /> : <Play size={15} />}{activePlaying && activePlayingUnitId === unit.id ? "暂停" : "播放"}</button>}
              </footer>
              {unit?.error && <small className="error-text">{unit.error}</small>}
            </article>;
          })}
        </div>
        <article className="podcast-segment-card">
          <header><strong>结尾</strong><span>{unitStatusLabel(closingUnit)}</span></header>
          <textarea value={podcast.closing ?? ""} onChange={(event) => setPodcast((current) => invalidateUnit({ ...current, closing: event.target.value }, "closing"))} rows={3} placeholder="生成脚本后可编辑结尾" />
          {closingUnit && <footer>
            {closingUnit.audioStatus === "failed" && <button type="button" className="secondary-button" onClick={() => void generateAudio(closingUnit.id)}><RotateCcw size={15} />重试</button>}
            {closingUnit.audioStatus === "ready" && <button type="button" className="secondary-button" onClick={() => activePlaying && activePlayingUnitId === closingUnit.id ? stopPlayback() : void playUnit(closingUnit)}>{activePlaying && activePlayingUnitId === closingUnit.id ? <Pause size={15} /> : <Play size={15} />}{activePlaying && activePlayingUnitId === closingUnit.id ? "暂停" : "播放"}</button>}
            {closingUnit.error && <small className="error-text">{closingUnit.error}</small>}
          </footer>}
        </article>
      </section>
      <section className="podcast-player-card">
        {legacyAudioLayout && (
          <div className="status-message">
            这是旧版整期音频。重新生成后可使用章节播放器、通知栏控制和锁屏播放。
          </div>
        )}
        {!legacyAudioLayout && <>
        {playback.notificationUnavailable && <p className="status-message">通知权限未授予，播放时不会显示通知栏或锁屏控制。</p>}
        <div className="podcast-player-heading"><strong>{activePlayingUnitId ? audioUnits.find((unit) => unit.id === activePlayingUnitId)?.title : "尚未播放"}</strong><small>{formatTime(activePosition)}</small></div>
        <input type="range" min={0} max={Math.max(1, useNativePlayback ? playback.state.durationSeconds || 1 : audioRef.current?.duration || 1)} value={activePosition} onChange={(event) => { const value = Number(event.target.value); if (useNativePlayback) void playback.seekTo(value); else { setPosition(value); if (audioRef.current) audioRef.current.currentTime = value; } }} />
        <div className="podcast-player-actions"><button type="button" className="secondary-button" title="上一项" onClick={() => playAdjacent(-1)}><SkipBack size={17} /></button><button type="button" className="secondary-button" title="后退 10 秒" onClick={() => useNativePlayback ? void playback.seekBy(-10) : audioRef.current && (audioRef.current.currentTime = Math.max(0, audioRef.current.currentTime - 10))}><Rewind size={17} /></button><button type="button" className="primary-button" onClick={() => { const unit = audioUnits.find((item) => item.id === (activePlayingUnitId ?? podcast.playback?.unitId ?? podcast.playback?.segmentId)) ?? audioUnits.find((item) => item.audioStatus === "ready"); if (unit) void playUnit(unit, activePlayingUnitId === unit.id ? activePosition : podcast.playback?.positionSeconds ?? 0); }}><Play size={17} />播放/继续</button><button type="button" className="secondary-button" onClick={stopPlayback}><Pause size={17} />暂停</button><button type="button" className="secondary-button" title="前进 10 秒" onClick={() => useNativePlayback ? void playback.seekBy(10) : audioRef.current && (audioRef.current.currentTime = Math.min(audioRef.current.duration || Infinity, audioRef.current.currentTime + 10))}><FastForward size={17} /></button><button type="button" className="secondary-button" title="下一项" onClick={() => playAdjacent(1)}><SkipForward size={17} /></button></div>
        <div className="podcast-player-options"><label>播放速度<select value={activePlaybackRate} onChange={(event) => { const rate = Number(event.target.value); setPlaybackRate(rate); if (useNativePlayback) void playback.setSpeed(rate); }} aria-label="播放速度">{[0.75, 1, 1.25, 1.5, 2].map((rate) => <option key={rate} value={rate}>{rate}x</option>)}</select></label>{useNativePlayback && <button type="button" className="secondary-button" onClick={() => void playback.setMode(nextPlaybackMode(playback.state.mode))}>{playback.state.mode === "single" ? <Repeat1 size={15} /> : playback.state.mode === "shuffle" ? <Shuffle size={15} /> : <Repeat size={15} />}{playbackModeLabel[playback.state.mode]}</button>}<span>当前位置 {formatTime(activePosition)}</span></div>
        </>}
      </section>
      <button type="button" className="danger-text-button" onClick={() => { if (window.confirm("删除这期知识播客及其生成音频吗？")) void onDeletePodcast(podcast.id).then(onBack); }}><Trash2 size={16} />删除这期播客</button>
    </main>
  );
};
