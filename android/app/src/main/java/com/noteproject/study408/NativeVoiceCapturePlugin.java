package com.noteproject.study408;

import android.Manifest;
import android.util.Base64;
import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;

@CapacitorPlugin(
    name = "NativeVoiceCapture",
    permissions = { @Permission(strings = { Manifest.permission.RECORD_AUDIO }, alias = "microphone") }
)
public final class NativeVoiceCapturePlugin extends Plugin {
    private PluginCall pendingStartCall;
    private String activeRequestId;
    private android.media.AudioFocusRequest focusRequest;
    private android.media.AudioManager audioManager;
    private boolean legacyFocusHeld;
    private final android.media.AudioManager.OnAudioFocusChangeListener legacyFocusListener = change -> {
        if (change < 0) { cancelPendingStart(); VoiceCaptureController.stop(); activeRequestId = null; notifyListeners("focusLost", new JSObject()); releaseAudioFocus(); }
    };

    @PluginMethod
    public void acquireFocus(PluginCall call) {
        getActivity().runOnUiThread(() -> {
            if (focusRequest != null || legacyFocusHeld) { call.resolve(); return; }
            audioManager = (android.media.AudioManager) getContext().getSystemService(android.content.Context.AUDIO_SERVICE);
            if (audioManager == null) { call.reject("系统音频焦点不可用"); return; }
            if (android.os.Build.VERSION.SDK_INT < 26) {
                legacyFocusHeld = audioManager.requestAudioFocus(legacyFocusListener, android.media.AudioManager.STREAM_VOICE_CALL, android.media.AudioManager.AUDIOFOCUS_GAIN_TRANSIENT) == android.media.AudioManager.AUDIOFOCUS_REQUEST_GRANTED;
                if (legacyFocusHeld) call.resolve(); else call.reject("无法获得音频焦点");
                return;
            }
            focusRequest = new android.media.AudioFocusRequest.Builder(android.media.AudioManager.AUDIOFOCUS_GAIN_TRANSIENT)
                .setAudioAttributes(new android.media.AudioAttributes.Builder().setUsage(android.media.AudioAttributes.USAGE_VOICE_COMMUNICATION).setContentType(android.media.AudioAttributes.CONTENT_TYPE_SPEECH).build())
                .setAcceptsDelayedFocusGain(false)
                .setOnAudioFocusChangeListener(change -> {
                    if (change < 0) {
                        cancelPendingStart();
                        VoiceCaptureController.stop();
                        activeRequestId = null;
                        notifyListeners("focusLost", new JSObject());
                        releaseAudioFocus();
                    }
                }).build();
            if (audioManager.requestAudioFocus(focusRequest) != android.media.AudioManager.AUDIOFOCUS_REQUEST_GRANTED) { releaseAudioFocus(); call.reject("无法获得音频焦点，请暂停其他音频后重试"); return; }
            call.resolve();
        });
    }

    private void releaseAudioFocus() {
        if (audioManager != null && focusRequest != null && android.os.Build.VERSION.SDK_INT >= 26) audioManager.abandonAudioFocusRequest(focusRequest);
        if (audioManager != null && legacyFocusHeld) audioManager.abandonAudioFocus(legacyFocusListener);
        legacyFocusHeld = false;
        focusRequest = null;
    }

    @PluginMethod
    public void releaseFocus(PluginCall call) { getActivity().runOnUiThread(() -> { releaseAudioFocus(); call.resolve(); }); }

    @PluginMethod
    public void start(PluginCall call) {
        if (pendingStartCall != null) { call.reject("正在等待麦克风权限。", "BUSY"); return; }
        if (getPermissionState("microphone") != PermissionState.GRANTED) {
            pendingStartCall = call;
            requestPermissionForAlias("microphone", call, "microphonePermissionCallback");
            return;
        }
        startCapture(call);
    }

    @PermissionCallback
    public void microphonePermissionCallback(PluginCall call) {
        if (pendingStartCall == null || !pendingStartCall.getCallbackId().equals(call.getCallbackId())) return;
        PluginCall target = pendingStartCall;
        pendingStartCall = null;
        if (getPermissionState("microphone") == PermissionState.GRANTED) startCapture(target);
        else target.reject("麦克风权限被拒绝，请在系统设置中允许本 App 使用麦克风。");
    }

    private void startCapture(PluginCall call) {
        int sampleRate = call.getInt("sampleRate", 16000);
        int frameSize = call.getInt("frameSize", 2048);
        String requestId = call.getString("requestId", "");
        try {
            MediaPlaybackService.pauseForRecording(getContext());
            VoiceCaptureController.start(sampleRate, frameSize, new VoiceCaptureController.FrameListener() {
                @Override
                public void onFrame(byte[] data, long sequence, double capturedAtMonotonicMs, int actualSampleRate) {
                    JSObject event = new JSObject();
                    event.put("requestId", requestId);
                    event.put("sequence", sequence);
                    event.put("capturedAtMonotonicMs", capturedAtMonotonicMs);
                    event.put("sampleRate", actualSampleRate);
                    event.put("channelCount", 1);
                    event.put("data", Base64.encodeToString(data, Base64.NO_WRAP));
                    notifyListeners("audioFrame", event);
                }

                @Override
                public void onError(String message) {
                    JSObject event = new JSObject();
                    event.put("requestId", requestId);
                    event.put("message", message);
                    notifyListeners("captureError", event);
                    VoiceCaptureController.stop();
                }
            });
            activeRequestId = requestId;
            call.resolve();
        } catch (Exception error) {
            call.reject(error.getMessage(), error);
        }
    }

    @PluginMethod public void pause(PluginCall call) { VoiceCaptureController.pause(); call.resolve(); }
    @PluginMethod public void resume(PluginCall call) { VoiceCaptureController.resume(); call.resolve(); }
    @PluginMethod public void stop(PluginCall call) {
        String requestId = call.getString("requestId", "");
        if (pendingStartCall != null && requestId.equals(pendingStartCall.getString("requestId", ""))) cancelPendingStart();
        if (requestId.equals(activeRequestId)) {
            VoiceCaptureController.stop();
            activeRequestId = null;
        }
        call.resolve();
    }

    private void cancelPendingStart() {
        if (pendingStartCall != null) {
            pendingStartCall.reject("麦克风请求已取消。", "CANCELLED");
            pendingStartCall = null;
        }
    }

    @PluginMethod
    public void status(PluginCall call) {
        JSObject result = new JSObject();
        result.put("capturing", VoiceCaptureController.isCapturing());
        result.put("paused", VoiceCaptureController.isPaused());
        result.put("echoCancellation", VoiceCaptureController.isEchoEnabled());
        result.put("noiseSuppression", VoiceCaptureController.isNoiseEnabled());
        result.put("autoGainControl", VoiceCaptureController.isGainEnabled());
        if (VoiceCaptureController.getSampleRate() > 0) result.put("sampleRate", VoiceCaptureController.getSampleRate());
        call.resolve(result);
    }

    @Override
    public void handleOnDestroy() {
        releaseAudioFocus();
        cancelPendingStart();
        VoiceCaptureController.stop();
        super.handleOnDestroy();
    }
}
