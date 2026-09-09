package com.noteproject.study408;

import okhttp3.WebSocket;
import okio.ByteString;

public final class VoiceAsrFrames {
    private VoiceAsrFrames() {}

    public static boolean send(WebSocket socket, String kind, String text, byte[] binary) {
        if (socket == null) return false;
        if ("text".equals(kind)) return socket.send(text);
        if ("binary".equals(kind) && binary != null) return socket.send(ByteString.of(binary));
        return false;
    }
}
