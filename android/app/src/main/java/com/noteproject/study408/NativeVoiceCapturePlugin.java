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

    @PluginMethod
    public void start(PluginCall call) {
        if (getPermissionState("microphone") != PermissionState.GRANTED) {
            pendingStartCall = call;
            requestPermissionForAlias("microphone", call, "microphonePermissionCallback");
            return;
        }
        startCapture(call);
    }

    @PermissionCallback
    public void microphonePermissionCallback(PluginCall call) {
        PluginCall target = pendingStartCall != null ? pendingStartCall : call;
        pendingStartCall = null;
        if (getPermissionState("microphone") == PermissionState.GRANTED) startCapture(target);
        else target.reject("麦克风权限被拒绝，请在系统设置中允许本 App 使用麦克风。");
    }

    private void startCapture(PluginCall call) {
        int sampleRate = call.getInt("sampleRate", 16000);
        int frameSize = call.getInt("frameSize", 2048);
        try {
            MediaPlaybackService.pauseForRecording(getContext());
            VoiceCaptureController.start(sampleRate, frameSize, new VoiceCaptureController.FrameListener() {
                @Override
                public void onFrame(byte[] data, long sequence, double capturedAtMonotonicMs, int actualSampleRate) {
                    JSObject event = new JSObject();
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
                    event.put("message", message);
                    notifyListeners("captureError", event);
                    VoiceCaptureController.stop();
                }
            });
            call.resolve();
        } catch (Exception error) {
            call.reject(error.getMessage(), error);
        }
    }

    @PluginMethod public void pause(PluginCall call) { VoiceCaptureController.pause(); call.resolve(); }
    @PluginMethod public void resume(PluginCall call) { VoiceCaptureController.resume(); call.resolve(); }
    @PluginMethod public void stop(PluginCall call) { VoiceCaptureController.stop(); call.resolve(); }

    @PluginMethod
    public void status(PluginCall call) {
        JSObject result = new JSObject();
        result.put("capturing", VoiceCaptureController.isCapturing());
        result.put("paused", VoiceCaptureController.isPaused());
        if (VoiceCaptureController.getSampleRate() > 0) result.put("sampleRate", VoiceCaptureController.getSampleRate());
        call.resolve(result);
    }

    @Override
    public void handleOnDestroy() {
        VoiceCaptureController.stop();
        super.handleOnDestroy();
    }
}
