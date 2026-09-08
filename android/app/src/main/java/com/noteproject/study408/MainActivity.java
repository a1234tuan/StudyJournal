package com.noteproject.study408;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(android.os.Bundle savedInstanceState) {
        registerPlugin(NativeAudioRecorderPlugin.class);
        registerPlugin(NativeVoiceCapturePlugin.class);
        registerPlugin(NativeOcrPlugin.class);
        registerPlugin(NativeAutoBackupPlugin.class);
        registerPlugin(NativeZipArchivePlugin.class);
        registerPlugin(NativeAiPlugin.class);
        registerPlugin(NativeFirebaseStoragePlugin.class);
        registerPlugin(NativeTtsPlugin.class);
        registerPlugin(NativePodcastTtsPlugin.class);
        registerPlugin(NativeMediaPlaybackPlugin.class);
        super.onCreate(savedInstanceState);
    }
}
