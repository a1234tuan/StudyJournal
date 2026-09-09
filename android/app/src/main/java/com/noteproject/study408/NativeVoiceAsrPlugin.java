package com.noteproject.study408;

import android.util.Base64;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.nio.charset.StandardCharsets;
import java.util.Iterator;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.TimeUnit;

import okhttp3.OkHttpClient;
import okhttp3.Request;
import okhttp3.Response;
import okhttp3.WebSocket;
import okhttp3.WebSocketListener;
import okio.ByteString;

/**
 * Owns the streaming-ASR WebSocket in the native layer because the renderer cannot
 * set an Authorization header on a browser WebSocket. Frames are relayed as base64
 * so the payload survives Capacitor's JSON bridge.
 */
@CapacitorPlugin(name = "NativeVoiceAsr")
public class NativeVoiceAsrPlugin extends Plugin {
    private final Map<String, WebSocket> sockets = new ConcurrentHashMap<>();
    private final OkHttpClient client = new OkHttpClient.Builder()
            .connectTimeout(15, TimeUnit.SECONDS)
            .readTimeout(0, TimeUnit.MILLISECONDS)
            .pingInterval(20, TimeUnit.SECONDS)
            .build();

    @PluginMethod
    public void open(PluginCall call) {
        String url = call.getString("url", "").trim();
        JSObject headers = call.getObject("headers", new JSObject());
        if (url.isEmpty()) {
            call.reject("缺少语音识别地址。");
            return;
        }
        Request.Builder builder = new Request.Builder().url(url);
        Iterator<String> keys = headers.keys();
        while (keys.hasNext()) {
            String key = keys.next();
            builder.addHeader(key, String.valueOf(headers.opt(key)));
        }

        String sessionId = UUID.randomUUID().toString();
        WebSocket socket = client.newWebSocket(builder.build(), new WebSocketListener() {
            @Override
            public void onOpen(WebSocket webSocket, Response response) {
                emit(sessionId, "open", null);
            }

            @Override
            public void onMessage(WebSocket webSocket, String text) {
                emit(sessionId, "message", text.getBytes(StandardCharsets.UTF_8));
            }

            @Override
            public void onMessage(WebSocket webSocket, ByteString bytes) {
                emit(sessionId, "message", bytes.toByteArray());
            }

            @Override
            public void onFailure(WebSocket webSocket, Throwable error, Response response) {
                JSObject payload = base(sessionId, "error");
                String message = response != null
                        ? "语音识别连接失败（HTTP " + response.code() + "）。"
                        : error != null && error.getMessage() != null ? error.getMessage() : "语音识别连接失败。";
                payload.put("message", message);
                notifyListeners("voiceAsrEvent", payload);
                sockets.remove(sessionId);
            }

            @Override
            public void onClosed(WebSocket webSocket, int code, String reason) {
                JSObject payload = base(sessionId, "close");
                payload.put("code", code);
                payload.put("reason", reason);
                notifyListeners("voiceAsrEvent", payload);
                sockets.remove(sessionId);
            }
        });
        sockets.put(sessionId, socket);

        JSObject result = new JSObject();
        result.put("sessionId", sessionId);
        call.resolve(result);
    }

    @PluginMethod
    public void send(PluginCall call) {
        String sessionId = call.getString("sessionId", "");
        String dataBase64 = call.getString("dataBase64", "");
        JSObject result = new JSObject();
        WebSocket socket = sockets.get(sessionId);
        boolean sent = false;
        if (socket != null && !dataBase64.isEmpty()) {
            try {
                sent = socket.send(ByteString.of(Base64.decode(dataBase64, Base64.NO_WRAP)));
            } catch (IllegalArgumentException error) {
                sent = false;
            }
        }
        result.put("sent", sent);
        call.resolve(result);
    }

    @PluginMethod
    public void close(PluginCall call) {
        String sessionId = call.getString("sessionId", "");
        JSObject result = new JSObject();
        WebSocket socket = sockets.remove(sessionId);
        boolean closed = false;
        if (socket != null) {
            try {
                socket.close(1000, "client-close");
                closed = true;
            } catch (Exception ignored) {
                closed = false;
            }
        }
        result.put("closed", closed);
        call.resolve(result);
    }

    @Override
    public void handleOnDestroy() {
        for (WebSocket socket : sockets.values()) {
            try {
                socket.cancel();
            } catch (Exception ignored) {
                // Socket already gone.
            }
        }
        sockets.clear();
        super.handleOnDestroy();
    }

    private JSObject base(String sessionId, String kind) {
        JSObject payload = new JSObject();
        payload.put("sessionId", sessionId);
        payload.put("kind", kind);
        return payload;
    }

    private void emit(String sessionId, String kind, byte[] data) {
        JSObject payload = base(sessionId, kind);
        if (data != null) {
            payload.put("dataBase64", Base64.encodeToString(data, Base64.NO_WRAP));
        }
        notifyListeners("voiceAsrEvent", payload);
    }
}
