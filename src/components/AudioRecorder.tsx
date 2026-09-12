import { Mic, Square } from "lucide-react";
import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from "react";
import {
  canUseNativeAudioRecorder,
  getNativeAudioRecordingStatus,
  startNativeAudioRecording,
  stopNativeAudioRecording,
} from "../services/nativeAudioRecorder";

export interface AudioRecorderHandle {
  stopAndGetFile: () => Promise<File | null>;
  isRecording: () => boolean;
}

interface AudioRecorderProps {
  onRecorded: (file: File) => void;
  compact?: boolean;
}

export const AudioRecorder = forwardRef<AudioRecorderHandle, AudioRecorderProps>(({ onRecorded, compact = false }, ref) => {
  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const chunksRef = useRef<BlobPart[]>([]);
  const pendingStopResolverRef = useRef<((file: File | null) => void) | null>(null);
  const onRecordedRef = useRef(onRecorded);
  const recordingRef = useRef(false);
  const [recording, setRecording] = useState(false);
  const [error, setError] = useState("");
  const [status, setStatus] = useState("");
  const supported = typeof navigator !== "undefined" && Boolean(navigator.mediaDevices) && typeof MediaRecorder !== "undefined";

  useEffect(() => {
    onRecordedRef.current = onRecorded;
  }, [onRecorded]);

  const setRecordingState = useCallback((nextRecording: boolean) => {
    recordingRef.current = nextRecording;
    setRecording(nextRecording);
  }, []);

  useEffect(() => {
    let mounted = true;
    if (!canUseNativeAudioRecorder()) {
      return undefined;
    }
    void getNativeAudioRecordingStatus().then((nativeStatus) => {
      if (!mounted) {
        return;
      }
      setRecordingState(nativeStatus.recording);
      setStatus(nativeStatus.recording ? "录音中" : "");
    }).catch(() => undefined);
    return () => {
      mounted = false;
    };
  }, [setRecordingState]);

  const stopWebRecording = useCallback(async (): Promise<File | null> => {
    const recorder = recorderRef.current;
    if (!recorder || recorder.state === "inactive") {
      setRecordingState(false);
      setStatus("");
      return null;
    }

    setStatus("正在保存录音...");
    return new Promise((resolve) => {
      pendingStopResolverRef.current = resolve;
      try {
        recorder.stop();
      } catch (reason) {
        pendingStopResolverRef.current = null;
        setError(reason instanceof Error ? reason.message : "停止录音失败。");
        setStatus("");
        setRecordingState(false);
        resolve(null);
      }
    });
  }, [setRecordingState]);

  const stopAndGetFile = useCallback(async (): Promise<File | null> => {
    if (canUseNativeAudioRecorder()) {
      try {
        const nativeStatus = await getNativeAudioRecordingStatus();
        if (!nativeStatus.recording) {
          setRecordingState(false);
          setStatus("");
          return null;
        }
        setStatus("正在保存录音...");
        const file = await stopNativeAudioRecording();
        setError("");
        setStatus("");
        setRecordingState(false);
        return file;
      } catch (reason) {
        setError(reason instanceof Error ? reason.message : "停止录音失败。");
        setStatus("");
        setRecordingState(false);
        return null;
      }
    }
    return stopWebRecording();
  }, [setRecordingState, stopWebRecording]);

  useImperativeHandle(ref, () => ({
    stopAndGetFile,
    isRecording: () => recordingRef.current,
  }), [stopAndGetFile]);

  const start = async () => {
    try {
      setError("");
      setStatus("正在请求麦克风权限...");
      if (canUseNativeAudioRecorder()) {
        await startNativeAudioRecording();
        setRecordingState(true);
        setStatus("录音中");
        return;
      }
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;
      chunksRef.current = [];
      // Leaving MediaRecorder() without options hands bitrate/codec choice to the browser, which
      // is typically tuned for music rather than voice and inflates recording size. Opus at
      // 32kbps stays clearly intelligible for speech. Try a few codecs a browser might support
      // before falling back to whatever MediaRecorder() picks on its own — that unconstrained
      // fallback still exists for browsers that reject every explicit mimeType below, but it's a
      // last resort rather than the common case.
      const candidateMimeTypes = ["audio/webm;codecs=opus", "audio/ogg;codecs=opus", "audio/mp4"];
      const supportedMimeType = candidateMimeTypes.find((type) => MediaRecorder.isTypeSupported?.(type));
      const recorder = supportedMimeType
        ? new MediaRecorder(stream, { mimeType: supportedMimeType, audioBitsPerSecond: 32000 })
        : new MediaRecorder(stream);
      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) {
          chunksRef.current.push(event.data);
        }
      };
      recorder.onerror = () => setError("录音过程出错，请重新授权麦克风或改用上传音频。");
      recorder.onstop = () => {
        const mimeType = recorder.mimeType || "audio/webm";
        const blob = new Blob(chunksRef.current, { type: mimeType });
        // Name the file to match what was actually recorded instead of assuming .webm — Safari's
        // fallback path, for instance, produces audio/mp4.
        const extension = mimeType.includes("mp4") ? "m4a" : mimeType.includes("ogg") ? "ogg" : "webm";
        const file = blob.size > 0
          ? new File([blob], `recording-${Date.now()}.${extension}`, { type: blob.type })
          : null;
        if (!file) {
          setError("没有录到声音，请检查麦克风权限。");
        }
        stream.getTracks().forEach((track) => track.stop());
        streamRef.current = null;
        recorderRef.current = null;
        chunksRef.current = [];
        setStatus("");
        setRecordingState(false);
        const resolver = pendingStopResolverRef.current;
        pendingStopResolverRef.current = null;
        if (resolver) {
          resolver(file);
        } else if (file) {
          onRecordedRef.current(file);
        }
      };
      recorder.start();
      recorderRef.current = recorder;
      setRecordingState(true);
      setStatus("录音中");
    } catch (reason) {
      const message = reason instanceof DOMException && reason.name === "NotAllowedError"
        ? "麦克风权限被拒绝，请在系统或浏览器设置中允许录音。"
        : reason instanceof Error
          ? reason.message
          : "当前环境无法启动录音，可先上传音频文件。";
      setError(message);
      setStatus("");
      streamRef.current?.getTracks().forEach((track) => track.stop());
      streamRef.current = null;
      setRecordingState(false);
    }
  };

  const stop = async () => {
    const file = await stopAndGetFile();
    if (file) {
      onRecorded(file);
    }
  };

  useEffect(() => () => {
    if (!canUseNativeAudioRecorder()) {
      void stopWebRecording();
    }
  }, [stopWebRecording]);

  if (!supported && !canUseNativeAudioRecorder()) {
    return (
      <span className={`audio-recorder-control${compact ? " compact" : ""}`}>
        <span className="helper-text">当前环境不支持直接录音，可上传音频文件。</span>
      </span>
    );
  }

  const buttonLabel = recording ? "停止录音" : "开始录音";
  return (
    <span className={`audio-recorder-control${compact ? " compact" : ""}`}>
      <button
        type="button"
        className={`secondary-button${recording ? " recording" : ""}`}
        title={buttonLabel}
        aria-label={buttonLabel}
        aria-pressed={recording}
        onClick={recording ? () => void stop() : () => void start()}
      >
        {recording ? <Square size={17} /> : <Mic size={17} />}
        {!compact && buttonLabel}
      </button>
      {status && <small className="status-message">{status}</small>}
      {error && <small className="status-message">{error}</small>}
    </span>
  );
});

AudioRecorder.displayName = "AudioRecorder";
