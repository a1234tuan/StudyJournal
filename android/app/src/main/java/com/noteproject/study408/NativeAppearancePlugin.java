package com.noteproject.study408;

import android.content.Context;
import android.graphics.Color;
import androidx.core.view.WindowInsetsControllerCompat;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

@CapacitorPlugin(name = "NativeAppearance")
public class NativeAppearancePlugin extends Plugin {
    @PluginMethod
    public void setColors(PluginCall call) {
        String statusColor = call.getString("statusBarColor", "");
        String navigationColor = call.getString("navigationBarColor", "");
        boolean dark = Boolean.TRUE.equals(call.getBoolean("dark", false));
        if (!statusColor.matches("#[0-9a-fA-F]{6}") || !navigationColor.matches("#[0-9a-fA-F]{6}")) {
            call.reject("Invalid appearance colors");
            return;
        }
        int status = Color.parseColor(statusColor);
        int navigation = Color.parseColor(navigationColor);
        getActivity().runOnUiThread(() -> {
            getActivity().getWindow().setStatusBarColor(status);
            getActivity().getWindow().setNavigationBarColor(navigation);
            WindowInsetsControllerCompat insets = new WindowInsetsControllerCompat(getActivity().getWindow(), getActivity().getWindow().getDecorView());
            insets.setAppearanceLightStatusBars(!dark);
            insets.setAppearanceLightNavigationBars(!dark);
            getContext().getSharedPreferences("mobile-appearance", Context.MODE_PRIVATE).edit()
                .putInt("status", status).putInt("navigation", navigation).putBoolean("dark", dark).apply();
            call.resolve();
        });
    }
}
