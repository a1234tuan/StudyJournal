package com.noteproject.study408;

import android.media.AudioFormat;
import android.media.AudioRecord;
import android.media.MediaRecorder;
import android.os.Process;
import java.io.IOException;

final class VoiceCaptureController {
    interface FrameListener {
        void onFrame(byte[] data, long sequence, double capturedAtMonotonicMs, int sampleRate);
        void onError(String message);
    }

    private static AudioRecord recorder;
    private static Thread captureThread;
    private static volatile boolean running;
    private static volatile boolean paused;
    private static int activeSampleRate;
    private static android.media.audiofx.AcousticEchoCanceler echoCanceler;
    private static android.media.audiofx.NoiseSuppressor noiseSuppressor;
    private static android.media.audiofx.AutomaticGainControl gainControl;
    private static boolean echoEnabled;
    private static boolean noiseEnabled;
    private static boolean gainEnabled;

    static synchronized boolean isEchoEnabled() { return echoEnabled; }
    static synchronized boolean isNoiseEnabled() { return noiseEnabled; }
    static synchronized boolean isGainEnabled() { return gainEnabled; }

    private static void enableProcessing(int sessionId) {
        try {
            if (android.media.audiofx.AcousticEchoCanceler.isAvailable()) { echoCanceler = android.media.audiofx.AcousticEchoCanceler.create(sessionId); if (echoCanceler != null) echoEnabled = echoCanceler.setEnabled(true) == 0 && echoCanceler.getEnabled(); }
            if (android.media.audiofx.NoiseSuppressor.isAvailable()) { noiseSuppressor = android.media.audiofx.NoiseSuppressor.create(sessionId); if (noiseSuppressor != null) noiseEnabled = noiseSuppressor.setEnabled(true) == 0 && noiseSuppressor.getEnabled(); }
            if (android.media.audiofx.AutomaticGainControl.isAvailable()) { gainControl = android.media.audiofx.AutomaticGainControl.create(sessionId); if (gainControl != null) gainEnabled = gainControl.setEnabled(true) == 0 && gainControl.getEnabled(); }
        } catch (RuntimeException error) { releaseProcessing(); }
    }

    private static void releaseProcessing() {
        if (echoCanceler != null) echoCanceler.release();
        if (noiseSuppressor != null) noiseSuppressor.release();
        if (gainControl != null) gainControl.release();
        echoCanceler = null; noiseSuppressor = null; gainControl = null;
        echoEnabled = false; noiseEnabled = false; gainEnabled = false;
    }

    private VoiceCaptureController() {}

    static synchronized boolean isCapturing() {
        return running && recorder != null;
    }

    static synchronized boolean isPaused() {
        return paused;
    }

    static synchronized int getSampleRate() {
        return activeSampleRate;
    }

    static synchronized void start(int sampleRate, int requestedFrameSize, FrameListener listener) throws IOException {
        if (isCapturing()) throw new IOException("实时语音采集已经在进行中。");
        if (AudioRecordingController.isRecording()) throw new IOException("请先结束当前录音，再开始语音复述。");
        int minimum = AudioRecord.getMinBufferSize(sampleRate, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT);
        if (minimum <= 0) throw new IOException("当前设备不支持所选语音采样率。");
        int frameSize = Math.max(requestedFrameSize, 512);
        int bufferSize = Math.max(minimum * 2, frameSize * 2);
        AudioRecord next = new AudioRecord(
            MediaRecorder.AudioSource.VOICE_RECOGNITION,
            sampleRate,
            AudioFormat.CHANNEL_IN_MONO,
            AudioFormat.ENCODING_PCM_16BIT,
            bufferSize
        );
        if (next.getState() != AudioRecord.STATE_INITIALIZED) {
            next.release();
            throw new IOException("无法初始化实时语音采集。");
        }
        recorder = next;
        enableProcessing(next.getAudioSessionId());
        activeSampleRate = sampleRate;
        paused = false;
        running = true;
        try { next.startRecording(); } catch (RuntimeException error) { stop(); throw new IOException("无法启动麦克风", error); }
        captureThread = new Thread(() -> captureLoop(next, frameSize, listener), "native-voice-capture");
        captureThread.start();
    }

    private static void captureLoop(AudioRecord activeRecorder, int frameSize, FrameListener listener) {
        Process.setThreadPriority(Process.THREAD_PRIORITY_AUDIO);
        byte[] buffer = new byte[frameSize];
        long sequence = 0;
        while (running && recorder == activeRecorder) {
            if (paused) {
                try { Thread.sleep(20L); } catch (InterruptedException ignored) { Thread.currentThread().interrupt(); }
                continue;
            }
            int count = activeRecorder.read(buffer, 0, buffer.length, AudioRecord.READ_BLOCKING);
            if (count > 0) {
                byte[] frame = new byte[count];
                System.arraycopy(buffer, 0, frame, 0, count);
                listener.onFrame(frame, sequence++, android.os.SystemClock.elapsedRealtimeNanos() / 1_000_000.0, activeSampleRate);
            } else if (count < 0 && running) {
                listener.onError("实时语音采集失败：" + count);
                break;
            }
        }
    }

    static synchronized void pause() {
        if (isCapturing()) paused = true;
    }

    static synchronized void resume() {
        if (isCapturing()) paused = false;
    }

    static synchronized void stop() {
        running = false;
        paused = false;
        releaseProcessing();
        AudioRecord current = recorder;
        recorder = null;
        activeSampleRate = 0;
        if (current != null) {
            try { current.stop(); } catch (IllegalStateException ignored) {}
            current.release();
        }
        Thread thread = captureThread;
        captureThread = null;
        if (thread != null && thread != Thread.currentThread()) {
            try { thread.join(500L); } catch (InterruptedException ignored) { Thread.currentThread().interrupt(); }
        }
    }
}
