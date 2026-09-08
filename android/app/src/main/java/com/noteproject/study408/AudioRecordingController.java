package com.noteproject.study408;

import android.content.Context;
import android.media.MediaRecorder;
import android.os.Build;
import java.io.File;
import java.io.IOException;

final class AudioRecordingController {
    private static MediaRecorder recorder;
    private static File outputFile;
    private static long startedAt;
    private static String lastError;

    private AudioRecordingController() {}

    static synchronized boolean isRecording() {
        return recorder != null && outputFile != null;
    }

    static synchronized long getStartedAt() {
        return startedAt;
    }

    static synchronized String getLastError() {
        return lastError;
    }

    static synchronized void start(Context context) throws IOException {
        if (VoiceCaptureController.isCapturing()) {
            throw new IOException("请先结束语音复述，再开始普通录音。");
        }
        if (isRecording()) {
            throw new IOException("录音已经在进行中。");
        }
        try {
            outputFile = new File(context.getCacheDir(), "recording-" + System.currentTimeMillis() + ".m4a");
            recorder = Build.VERSION.SDK_INT >= Build.VERSION_CODES.S
                ? new MediaRecorder(context)
                : new MediaRecorder();
            recorder.setAudioSource(MediaRecorder.AudioSource.MIC);
            recorder.setOutputFormat(MediaRecorder.OutputFormat.MPEG_4);
            recorder.setAudioEncoder(MediaRecorder.AudioEncoder.AAC);
            // Voice-only recordings don't need music-grade quality. 32kbps AAC at 16kHz stays
            // clearly intelligible while cutting file size to roughly a quarter of the previous
            // 128kbps/44.1kHz setting — this only affects newly captured audio, so existing
            // recordings and their cloud-sync content hashes are unaffected.
            recorder.setAudioEncodingBitRate(32000);
            recorder.setAudioSamplingRate(16000);
            recorder.setOutputFile(outputFile.getAbsolutePath());
            recorder.prepare();
            recorder.start();
            startedAt = System.currentTimeMillis();
            lastError = null;
        } catch (Exception error) {
            cleanupLocked(true);
            lastError = "无法启动录音：" + error.getMessage();
            throw new IOException(lastError, error);
        }
    }

    static synchronized File stop() throws IOException {
        if (!isRecording()) {
            throw new IOException("当前没有正在进行的录音。");
        }
        File savedFile = outputFile;
        try {
            recorder.stop();
        } catch (RuntimeException error) {
            cleanupLocked(true);
            lastError = "录音时间过短或保存失败，请重新录制。";
            throw new IOException(lastError, error);
        }
        cleanupRecorderOnlyLocked();
        outputFile = null;
        startedAt = 0;
        lastError = null;
        return savedFile;
    }

    static synchronized void cancel() {
        cleanupLocked(true);
        lastError = null;
    }

    private static void cleanupRecorderOnlyLocked() {
        if (recorder != null) {
            try {
                recorder.reset();
            } catch (RuntimeException ignored) {
                // Recorder may already be released after a failed stop.
            }
            recorder.release();
            recorder = null;
        }
    }

    private static void cleanupLocked(boolean deleteFile) {
        cleanupRecorderOnlyLocked();
        if (deleteFile && outputFile != null) {
            outputFile.delete();
        }
        outputFile = null;
        startedAt = 0;
    }
}
