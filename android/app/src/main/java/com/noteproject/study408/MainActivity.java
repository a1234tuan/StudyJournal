package com.noteproject.study408;

import com.getcapacitor.BridgeActivity;
import android.graphics.Color;
import androidx.core.view.WindowCompat;

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
        WindowCompat.setDecorFitsSystemWindows(getWindow(), false);
        getWindow().setStatusBarColor(Color.TRANSPARENT);
        getWindow().setNavigationBarColor(Color.TRANSPARENT);
    }
}
