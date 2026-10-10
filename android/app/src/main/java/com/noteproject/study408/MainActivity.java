package com.noteproject.study408;

import com.getcapacitor.BridgeActivity;
import android.graphics.Color;
import androidx.core.view.WindowCompat;
import androidx.core.view.WindowInsetsControllerCompat;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(android.os.Bundle savedInstanceState) {
        registerPlugin(NativeAppearancePlugin.class);
        registerPlugin(NativeAudioRecorderPlugin.class);
        registerPlugin(NativeVoiceCapturePlugin.class);
        registerPlugin(NativeOcrPlugin.class);
        registerPlugin(NativeAutoBackupPlugin.class);
        registerPlugin(NativeZipArchivePlugin.class);
        registerPlugin(NativeAiPlugin.class);
        registerPlugin(NativeVoiceAsrPlugin.class);
        registerPlugin(NativeFirebaseStoragePlugin.class);
        registerPlugin(NativeTtsPlugin.class);
        registerPlugin(NativePodcastTtsPlugin.class);
        registerPlugin(NativeMediaPlaybackPlugin.class);
        super.onCreate(savedInstanceState);
        WindowCompat.setDecorFitsSystemWindows(getWindow(), true);
        android.content.SharedPreferences appearance = getSharedPreferences("mobile-appearance", MODE_PRIVATE);
        getWindow().setStatusBarColor(appearance.getInt("status", Color.rgb(250, 248, 244)));
        getWindow().setNavigationBarColor(appearance.getInt("navigation", Color.rgb(255, 253, 250)));
        WindowInsetsControllerCompat insets = new WindowInsetsControllerCompat(getWindow(), getWindow().getDecorView());
        insets.setAppearanceLightStatusBars(!appearance.getBoolean("dark", false));
        insets.setAppearanceLightNavigationBars(!appearance.getBoolean("dark", false));
    }
}
