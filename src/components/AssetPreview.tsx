import { Download, File, Image, Pause, Play, Trash2, Volume2, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import type { Asset, RecordAssetRef } from "../types";
import { storage } from "../services/storageAdapter";
import { downloadAsset } from "../services/assetDownloadService";
import { runOcrForAsset } from "../services/ocrJobService";
import { describeOcrForAi } from "../services/ocrDiagnostics";
import { formatUiError } from "../lib/uiError";
import { usePlayback } from "./PlaybackProvider";

type AssetPreviewProps = {
  assetRef?: RecordAssetRef;
  assetId?: string;
  variant?: Asset["kind"];
  mode?: "view" | "edit";
  showOcrDetails?: boolean;
  editableTitle?: string;
  onTitleChange?: (title: string) => void;
  onTitleCommit?: (title: string) => void;
  onAssetChanged?: () => void;
  onOpenImage?: () => void;
  onDeleteImage?: () => void;
  highlight?: boolean;
};

const SPEEDS = [1, 1.25, 1.5, 2] as const;

const formatSize = (size: number): string => {
  if (size < 1024) {
    return `${size} B`;
  }
  if (size < 1024 * 1024) {
    return `${Math.round(size / 1024)} KB`;
  }
  return `${Math.round((size / 1024 / 1024) * 10) / 10} MB`;
};

export const AssetPreview = (props: AssetPreviewProps) => {
  const playback = usePlayback();
  const {
    assetRef,
    assetId,
    variant,
    mode = "edit",
    showOcrDetails = mode === "edit",
    editableTitle,
    onTitleChange,
    onTitleCommit,
    onAssetChanged,
    onOpenImage,
    onDeleteImage,
    highlight,
  } = props;
  const isViewMode = mode === "view";
  const resolvedRef = assetRef ?? {
    id: assetId ?? "",
    title: "资源",
    kind: variant ?? "attachment",
  };
  const [url, setUrl] = useState<string | null>(null);
  const [asset, setAsset] = useState<Asset | null>(null);
  const [missing, setMissing] = useState(false);
  const [playerOpen, setPlayerOpen] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState<(typeof SPEEDS)[number]>(1);
  const [message, setMessage] = useState("");
  const [ocrDetailsOpen, setOcrDetailsOpen] = useState(false);
  const audioRef = useRef<HTMLAudioElement | null>(null);

  useEffect(() => {
    let objectUrl: string | undefined;
    let active = true;
    setUrl(null);
    setAsset(null);
    setMissing(false);
    void storage.getAsset(resolvedRef.id).then((nextAsset) => {
      if (!active) {
        return;
      }
      if (!nextAsset) {
        setMissing(true);
        return;
      }
      objectUrl = URL.createObjectURL(nextAsset.data);
      setAsset(nextAsset);
      setUrl(objectUrl);
    });
    return () => {
      active = false;
      if (objectUrl) {
        URL.revokeObjectURL(objectUrl);
      }
    };
  }, [resolvedRef.id]);

  useEffect(() => {
    if (audioRef.current) {
      audioRef.current.playbackRate = speed;
    }
  }, [speed, playerOpen]);

  if (missing) {
    return (
      <div className={`asset-placeholder asset-missing${highlight ? " highlighted" : ""}`}>
        资源丢失：{resolvedRef.title || resolvedRef.id}
        <small>{resolvedRef.id}</small>
      </div>
    );
  }

  if (!url || !asset) {
    return <div className="asset-placeholder">正在读取资源...</div>;
  }

  const title = editableTitle ?? resolvedRef.title ?? asset.title ?? asset.fileName;
  const nativeAudio = asset.kind === "audio" && playback.nativeAvailable;
  const activeNativeItem = nativeAudio && playback.state.queueId === `preview:${asset.id}` && playback.state.itemId === asset.id;
  const effectivePlaying = activeNativeItem ? playback.state.status === "playing" : playing;
  const activeSpeed = nativeAudio && activeNativeItem ? playback.state.speed : speed;
  const handleDownload = async () => {
    try {
      setMessage(await downloadAsset(asset));
    } catch (error) {
      setMessage(formatUiError(error, "generic"));
    }
  };

  const runOcr = async () => {
    try {
      setMessage("正在提交 OCR...");
      const updated = await runOcrForAsset(asset.id, {
        force: true,
        onAssetChanged,
      });
      if (updated) {
        setAsset(updated);
      }
      setMessage("OCR 已完成。");
    } catch (error) {
      const updated = await storage.getAsset(asset.id);
      if (updated) {
        setAsset(updated);
      }
      onAssetChanged?.();
      setMessage(formatUiError(error, "generic"));
    }
  };

  const toggleAudio = async () => {
    if (nativeAudio) {
      setPlayerOpen(true);
      setMessage("");
      try {
        if (activeNativeItem) {
          if (playback.state.status === "playing") await playback.pause(); else await playback.play();
        } else {
          await playback.startQueue({
            queueId: `preview:${asset.id}`,
            items: [{ asset, title, subtitle: "笔记录音" }],
            initialAssetId: asset.id,
            speed,
          });
        }
      } catch (error) {
        setMessage(formatUiError(error, "generic"));
      }
      return;
    }
    setPlayerOpen(true);
    const audio = audioRef.current;
    if (!audio) {
      window.setTimeout(() => {
        const nextAudio = audioRef.current;
        if (!nextAudio) {
          return;
        }
        nextAudio
          .play()
          .then(() => setPlaying(true))
          .catch((error) => setMessage(formatUiError(error, "generic")));
      }, 0);
      return;
    }
    if (audio.paused) {
      await audio.play();
      setPlaying(true);
    } else {
      audio.pause();
      setPlaying(false);
    }
  };
  const ocrDiagnostic = describeOcrForAi(asset);
  const ocrDone = ocrDiagnostic.included;
  const ocrBusy = asset.ocrStatus === "running" || asset.ocrStatus === "queued";
  const ocrBusyLabel = asset.ocrStatus === "queued" ? "排队中" : "识别中";
  const canRetryOcr = asset.kind === "image" && !ocrBusy && !ocrDone;
  const viewTitle = title === asset.fileName && asset.kind === "image" ? "" : title;
  const ocrBadge = asset.kind === "image"
    ? ocrDone
      ? `OCR✅${ocrBusy ? ` · 本机${ocrBusyLabel}` : ""}`
      : ocrBusy
        ? ocrBusyLabel
        : asset.ocrStatus === "failed" || asset.ocrStatus === "timeout"
          ? "OCR失败"
          : "OCR未完成"
    : "";

  if (isViewMode) {
    if (asset.kind === "image") {
      return (
        <article className={`asset-card asset-card-view compact-image-card${highlight ? " highlighted" : ""}`} data-asset-id={asset.id}>
          <button type="button" className="compact-image-button" title="预览图片" onClick={onOpenImage}>
            <img className="image-preview" src={url} alt={title} />
          </button>
          <div className="compact-image-meta">
            {viewTitle && <strong>{viewTitle}</strong>}
            <span className={`ocr-badge ${ocrDone ? "success" : ocrBusy ? "busy" : "muted"}`}>{ocrBadge}</span>
          </div>
          {message && <small className="status-message compact-status">{message}</small>}
        </article>
      );
    }

    if (asset.kind === "audio") {
      return (
        <article className={`asset-card asset-card-view compact-audio-card${highlight ? " highlighted" : ""}`} data-asset-id={asset.id}>
          <div className="compact-asset-row">
            <div className="compact-asset-title">
              <Volume2 size={17} />
              <strong>{viewTitle || "录音"}</strong>
            </div>
            <div className="compact-asset-actions">
              <button type="button" className="icon-button" title={effectivePlaying ? "暂停" : "播放"} onClick={() => void toggleAudio()}>
                {effectivePlaying ? <Pause size={16} /> : <Play size={16} />}
              </button>
              <select
                value={activeSpeed}
                aria-label="播放倍速"
                onChange={(event) => {
                  const nextSpeed = Number(event.target.value) as (typeof SPEEDS)[number];
                  setSpeed(nextSpeed);
                  if (nativeAudio) void playback.setSpeed(nextSpeed);
                }}
              >
                {SPEEDS.map((item) => (
                  <option key={item} value={item}>{item}x</option>
                ))}
              </select>
              <button type="button" className="icon-button" title="下载" onClick={() => void handleDownload()}>
                <Download size={16} />
              </button>
            </div>
          </div>
          {playerOpen && (
            <div className="compact-audio-player">
              {nativeAudio ? (
                <>
                  <input type="range" min={0} max={Math.max(1, playback.state.durationSeconds || asset.durationSeconds || 1)} value={Math.min(playback.state.positionSeconds, playback.state.durationSeconds || asset.durationSeconds || 1)} onChange={(event) => void playback.seekTo(Number(event.target.value))} />
                  <small>{Math.floor(playback.state.positionSeconds)} 秒</small>
                </>
              ) : (
                <audio ref={audioRef} src={url} controls onPlay={() => setPlaying(true)} onPause={() => setPlaying(false)} onEnded={() => setPlaying(false)} />
              )}
              <button
                type="button"
                className="icon-button"
                title="关闭播放器"
                onClick={() => {
                  if (nativeAudio) void playback.stop(); else audioRef.current?.pause();
                  setPlaying(false);
                  setPlayerOpen(false);
                }}
              >
                <X size={16} />
              </button>
            </div>
          )}
          {message && <small className="status-message compact-status">{message}</small>}
        </article>
      );
    }

    return (
      <article className={`asset-card asset-card-view compact-attachment-card${highlight ? " highlighted" : ""}`} data-asset-id={asset.id}>
        <div className="compact-asset-row">
          <div className="compact-asset-title">
            <File size={17} />
            <strong>{viewTitle || "附件"}</strong>
          </div>
          <button type="button" className="icon-button" title="下载" onClick={() => void handleDownload()}>
            <Download size={16} />
          </button>
        </div>
        {message && <small className="status-message compact-status">{message}</small>}
      </article>
    );
  }

  return (
    <article className={`asset-card asset-card-${asset.kind}${highlight ? " highlighted" : ""}`} data-asset-id={asset.id}>
      <div className="asset-card-head">
        <div>
          {asset.kind === "image" && <Image size={18} />}
          {asset.kind === "attachment" && <File size={18} />}
          {asset.kind === "audio" && <Volume2 size={18} />}
          {onTitleChange ? (
            <input
              value={title}
              onChange={(event) => onTitleChange(event.target.value)}
              onBlur={(event) => onTitleCommit?.(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.currentTarget.blur();
                }
              }}
              aria-label="资源标题"
            />
          ) : (
            <strong>{title}</strong>
          )}
          <small>{asset.fileName} / {formatSize(asset.size)}</small>
        </div>
        <div className="asset-card-actions">
          <button type="button" className="icon-button" title="下载" onClick={() => void handleDownload()}>
            <Download size={17} />
          </button>
          {asset.kind === "image" && onDeleteImage && (
            <button
              type="button"
              className="icon-button danger"
              title="删除图片"
              aria-label="删除图片"
              onClick={onDeleteImage}
            >
              <Trash2 size={17} />
            </button>
          )}
        </div>
      </div>

      {asset.kind === "image" && (
        <>
        <button type="button" className="image-preview-button" title="预览图片" onClick={onOpenImage}>
          <img className="image-preview" src={url} alt={title} />
        </button>
        <div className="ocr-row">
          <span>
            {ocrDone ? ocrBadge : `OCR：${ocrBusy ? ocrBusyLabel : asset.ocrStatus === "failed" ? "失败" : asset.ocrStatus === "timeout" ? "超时" : "未识别"}`}
          </span>
          {showOcrDetails && (
            <button type="button" className="subtle-button" onClick={() => setOcrDetailsOpen((value) => !value)}>
              {ocrDetailsOpen ? "收起详情" : "OCR 详情"}
            </button>
          )}
          {canRetryOcr && (
            <button type="button" className="subtle-button" onClick={() => void runOcr()}>
              {asset.ocrStatus === "failed" || asset.ocrStatus === "timeout" ? "重新 OCR" : "手动 OCR"}
            </button>
          )}
        </div>
        {asset.ocrText && <p className="ocr-snippet">{asset.ocrText.slice(0, 120)}</p>}
        {!ocrDone && asset.ocrError && <p className="status-message">{asset.ocrError}</p>}
        {ocrDetailsOpen && (
          <dl className="ocr-details">
            <div>
              <dt>参与 AI</dt>
              <dd>{ocrDiagnostic.included ? "是" : "否"}</dd>
            </div>
            <div>
              <dt>原因</dt>
              <dd>{ocrDiagnostic.reason}</dd>
            </div>
            <div>
              <dt>文本长度</dt>
              <dd>{ocrDiagnostic.textLength}</dd>
            </div>
            <div>
              <dt>本机任务状态</dt>
              <dd>{asset.ocrStatus ?? "idle"}</dd>
            </div>
            {ocrDone && asset.ocrError && (
              <div>
                <dt>本机上次错误</dt>
                <dd>{asset.ocrError}</dd>
              </div>
            )}
            <div>
              <dt>Job ID</dt>
              <dd>{asset.ocrJobId ?? "无"}</dd>
            </div>
            <div>
              <dt>更新时间</dt>
              <dd>{asset.ocrUpdatedAt ?? "无"}</dd>
            </div>
          </dl>
        )}
        </>
      )}

      {asset.kind === "attachment" && (
        <button type="button" className="attachment-link" onClick={() => void handleDownload()}>
          下载到本地
        </button>
      )}

      {asset.kind === "audio" && (
        <div className="audio-asset">
          <button type="button" className="secondary-button" onClick={() => void toggleAudio()}>
            {effectivePlaying ? <Pause size={17} /> : <Play size={17} />}
            {effectivePlaying ? "暂停" : "播放"}
          </button>
          {playerOpen && (
            <div className="audio-player-panel">
              <div className="audio-player-controls">
                {nativeAudio ? (
                  <>
                    <input type="range" min={0} max={Math.max(1, playback.state.durationSeconds || asset.durationSeconds || 1)} value={Math.min(playback.state.positionSeconds, playback.state.durationSeconds || asset.durationSeconds || 1)} onChange={(event) => void playback.seekTo(Number(event.target.value))} />
                    <small>{Math.floor(playback.state.positionSeconds)} 秒</small>
                  </>
                ) : (
                  <audio ref={audioRef} src={url} controls onPlay={() => setPlaying(true)} onPause={() => setPlaying(false)} onEnded={() => setPlaying(false)} />
                )}
                <button
                  type="button"
                  className="icon-button"
                  title="关闭播放器"
                  onClick={() => {
                    if (nativeAudio) void playback.stop(); else audioRef.current?.pause();
                    setPlaying(false);
                    setPlayerOpen(false);
                  }}
                >
                  <X size={17} />
                </button>
              </div>
              <div className="speed-row" aria-label="播放倍速">
                {SPEEDS.map((item) => (
                  <button
                    key={item}
                    type="button"
                    className={activeSpeed === item ? "active" : ""}
                    onClick={() => {
                      setSpeed(item);
                      if (nativeAudio) void playback.setSpeed(item);
                    }}
                  >
                    {item}x
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
      {message && <small className="status-message">{message}</small>}
    </article>
  );
};
