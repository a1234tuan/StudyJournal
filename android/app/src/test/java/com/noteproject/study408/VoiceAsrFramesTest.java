package com.noteproject.study408;

import org.junit.Test;
import static org.junit.Assert.*;
import java.util.Arrays;
import java.util.List;
import java.util.Collections;
import java.util.ArrayList;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import okhttp3.OkHttpClient;
import okhttp3.Request;
import okhttp3.Response;
import okhttp3.WebSocket;
import okhttp3.WebSocketListener;
import okhttp3.mockwebserver.MockResponse;
import okhttp3.mockwebserver.MockWebServer;
import okio.ByteString;

public class VoiceAsrFramesTest {
    @Test public void preservesActualTextAndBinaryFrames() throws Exception {
        MockWebServer server = new MockWebServer();
        OkHttpClient client = new OkHttpClient();
        List<String> frames = Collections.synchronizedList(new ArrayList<>());
        CountDownLatch received = new CountDownLatch(3);
        CountDownLatch opened = new CountDownLatch(1);
        server.enqueue(new MockResponse().withWebSocketUpgrade(new WebSocketListener() {
            @Override public void onMessage(WebSocket socket, String text) { frames.add("text:" + text); received.countDown(); }
            @Override public void onMessage(WebSocket socket, ByteString bytes) { frames.add("binary:" + bytes.hex()); received.countDown(); }
        }));
        server.start();
        WebSocket socket = client.newWebSocket(new Request.Builder().url(server.url("/asr")).build(), new WebSocketListener() {
            @Override public void onOpen(WebSocket socket, Response response) { opened.countDown(); }
        });
        try {
            assertTrue(opened.await(5, TimeUnit.SECONDS));
            assertTrue(VoiceAsrFrames.send(socket, "text", "run-task", null));
            assertTrue(VoiceAsrFrames.send(socket, "binary", "", new byte[] { 1, 2 }));
            assertTrue(VoiceAsrFrames.send(socket, "text", "finish-task", null));
            assertTrue(received.await(5, TimeUnit.SECONDS));
            assertEquals(Arrays.asList("text:run-task", "binary:0102", "text:finish-task"), frames);
            assertFalse(VoiceAsrFrames.send(socket, "unknown", "", null));
        } finally {
            socket.cancel();
            client.dispatcher().executorService().shutdownNow();
            client.connectionPool().evictAll();
            server.shutdown();
        }
    }
}
