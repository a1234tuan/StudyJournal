package com.noteproject.study408;

import android.util.Base64;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.text.SimpleDateFormat;
import java.util.Date;
import java.util.Locale;
import java.util.UUID;
import javax.crypto.Mac;
import javax.crypto.spec.SecretKeySpec;
import org.json.JSONObject;

@CapacitorPlugin(name = "NativeTts")
public class NativeTtsPlugin extends Plugin {
    private static final class RequestState {
        private boolean cancelled;
        private final java.util.List<HttpURLConnection> connections = new java.util.ArrayList<>();
        synchronized HttpURLConnection track(HttpURLConnection connection) throws java.io.IOException {
            if (cancelled) { connection.disconnect(); throw new java.io.IOException("TTS cancelled"); }
            connections.add(connection);
            return connection;
        }
        synchronized void close() {
            cancelled = true;
            for (HttpURLConnection connection : connections) connection.disconnect();
            connections.clear();
        }
    }
    private final java.util.Map<String, RequestState> activeRequests = new java.util.concurrent.ConcurrentHashMap<>();
    private final ThreadLocal<RequestState> currentRequest = new ThreadLocal<>();

    @PluginMethod
    public void cancel(PluginCall call) {
        RequestState state = activeRequests.get(call.getString("requestId", ""));
        if (state != null) state.close();
        call.resolve();
    }

    private HttpURLConnection trackedConnection(String url) throws Exception {
        HttpURLConnection connection = (HttpURLConnection) new URL(url).openConnection();
        RequestState state = currentRequest.get();
        return state == null ? connection : state.track(connection);
    }

    @PluginMethod
    public void synthesize(PluginCall call) {
        String providerId = call.getString("providerId", "fish-audio");
        String apiKey = call.getString("apiKey", "").trim();
        String apiKeySecondary = call.getString("apiKeySecondary", "").trim();
        String model = call.getString("model", "").trim();
        String voiceId = call.getString("voiceId", "").trim();
        String text = call.getString("text", "");
        String region = call.getString("region", "ap-guangzhou").trim();
        String languageCode = call.getString("languageCode", "cmn-CN").trim();
        if (apiKey.isEmpty() || voiceId.isEmpty() || text.trim().isEmpty()) {
            call.reject("TTS 请求配置不完整。");
            return;
        }
        String requestId = call.getString("requestId", UUID.randomUUID().toString());
        RequestState state = new RequestState();
        if (activeRequests.putIfAbsent(requestId, state) != null) { call.reject("重复的 TTS 操作"); return; }
        execute(() -> {
            currentRequest.set(state);
            try {
                switch (providerId) {
                    case "aliyun": synthesizeAliyun(call, apiKey, model, voiceId, text); break;
                    case "tencent": synthesizeTencent(call, apiKey, apiKeySecondary, voiceId, text, region); break;
                    case "google": synthesizeGoogle(call, apiKey, voiceId, text, languageCode); break;
                    case "doubao": synthesizeDoubao(call, apiKey, model, voiceId, text); break;
                    default: synthesizeFishAudio(call, apiKey, model, voiceId, text); break;
                }
            } catch (Exception error) {
                call.reject(error.getMessage() != null ? error.getMessage() : "TTS 请求失败。", error);
            } finally {
                state.close();
                activeRequests.remove(requestId, state);
                currentRequest.remove();
            }
        });
    }

    private void synthesizeFishAudio(PluginCall call, String apiKey, String model, String voiceId, String text) throws Exception {
        String fishModel = model.isEmpty() ? "s2.1-pro-free" : model;
        JSONObject payload = new JSONObject();
        payload.put("text", text);
        payload.put("reference_id", voiceId);
        payload.put("format", "mp3");
        payload.put("normalize", true);
        double speed = call.getDouble("speed", 1.0);
        if (!Double.isFinite(speed) || speed < 0.5 || speed > 2.0) throw new IllegalArgumentException("无效语速");
        payload.put("prosody", new JSONObject().put("speed", speed));
        payload.put("mp3_bitrate", 64);
        payload.put("latency", "normal");
        payload.put("chunk_length", 300);
        HttpURLConnection conn = openPost("https://api.fish.audio/v1/tts");
        conn.setRequestProperty("Authorization", "Bearer " + apiKey.replaceFirst("(?i)^Bearer\\s+", ""));
        conn.setRequestProperty("Accept", "audio/mpeg");
        conn.setRequestProperty("model", fishModel);
        writeBody(conn, payload.toString());
        int code = conn.getResponseCode();
        byte[] bytes = readAll(code >= 400 ? conn.getErrorStream() : conn.getInputStream());
        if (code < 200 || code >= 300) {
            String detail = truncate(new String(bytes, StandardCharsets.UTF_8));
            call.reject("Fish Audio 请求失败（" + code + "）：" + detail);
            return;
        }
        resolveAudio(call, bytes);
    }

    private void synthesizeAliyun(PluginCall call, String apiKey, String model, String voiceId, String text) throws Exception {
        String aliyunModel = model.isEmpty() ? "qwen3-tts-flash" : model;
        JSONObject input = new JSONObject();
        input.put("text", text);
        input.put("voice", voiceId);
        JSONObject parameters = new JSONObject();
        parameters.put("format", "mp3");
        parameters.put("sample_rate", 16000);
        JSONObject payload = new JSONObject();
        payload.put("model", aliyunModel);
        payload.put("input", input);
        payload.put("parameters", parameters);
        HttpURLConnection conn = openPost("https://dashscope.aliyuncs.com/api/v1/services/aigc/text2audio");
        conn.setRequestProperty("Authorization", "Bearer " + apiKey);
        writeBody(conn, payload.toString());
        int code = conn.getResponseCode();
        byte[] respBytes = readAll(code >= 400 ? conn.getErrorStream() : conn.getInputStream());
        if (code < 200 || code >= 300) {
            call.reject("阿里云 TTS 请求失败（" + code + "）：" + truncate(new String(respBytes, StandardCharsets.UTF_8)));
            return;
        }
        JSONObject json = new JSONObject(new String(respBytes, StandardCharsets.UTF_8));
        String audioUrl = json.getJSONObject("output").getJSONObject("audio").getString("url");
        HttpURLConnection audioConn = trackedConnection(audioUrl);
        audioConn.setConnectTimeout(30000);
        audioConn.setReadTimeout(120000);
        int audioCode = audioConn.getResponseCode();
        byte[] audioBytes = readAll(audioCode >= 400 ? audioConn.getErrorStream() : audioConn.getInputStream());
        if (audioCode < 200 || audioCode >= 300) {
            call.reject("阿里云音频下载失败（" + audioCode + "）");
            return;
        }
        resolveAudio(call, audioBytes);
    }

    private void synthesizeDoubao(PluginCall call, String apiKey, String model, String voiceId, String text) throws Exception {
        String resourceId = model.isEmpty() ? "seed-tts-2.0" : model;
        JSONObject payload = new JSONObject();
        JSONObject request = new JSONObject();
        request.put("text", text);
        request.put("speaker", voiceId);
        JSONObject audioParams = new JSONObject();
        audioParams.put("format", "mp3");
        audioParams.put("sample_rate", 16000);
        request.put("audio_params", audioParams);
        payload.put("req_params", request);
        HttpURLConnection conn = openPost("https://openspeech.bytedance.com/api/v3/tts/unidirectional");
        conn.setRequestProperty("X-Api-Key", apiKey);
        conn.setRequestProperty("X-Api-Resource-Id", resourceId);
        conn.setRequestProperty("X-Api-Request-Id", UUID.randomUUID().toString());
        conn.setRequestProperty("Accept", "application/json");
        writeBody(conn, payload.toString());
        int code = conn.getResponseCode();
        byte[] responseBytes = readAll(code >= 400 ? conn.getErrorStream() : conn.getInputStream());
        if (code < 200 || code >= 300) {
            call.reject("豆包 TTS 请求失败（" + code + "）：" + truncate(new String(responseBytes, StandardCharsets.UTF_8)));
            return;
        }
        ByteArrayOutputStream audio = new ByteArrayOutputStream();
        String responseText = new String(responseBytes, StandardCharsets.UTF_8);
        for (String line : responseText.split("\\r?\\n")) {
            String trimmed = line.trim();
            if (trimmed.isEmpty()) continue;
            JSONObject item = new JSONObject(trimmed);
            Object itemCode = item.opt("code");
            String codeText = itemCode == null ? "" : String.valueOf(itemCode).trim();
            if (!codeText.isEmpty() && !"0".equals(codeText) && !"20000000".equals(codeText)) {
                throw new IllegalStateException("豆包 TTS 请求失败：" + item.optString("message", "错误码 " + itemCode));
            }
            String data = item.optString("data", "");
            if (!data.isEmpty()) audio.write(Base64.decode(data, Base64.DEFAULT));
        }
        byte[] result = audio.toByteArray();
        if (result.length == 0) {
            call.reject("豆包 TTS 未返回音频数据。");
            return;
        }
        resolveAudio(call, result);
    }

    private void synthesizeTencent(PluginCall call, String secretId, String secretKey, String voiceId, String text, String region) throws Exception {
        if (secretKey.isEmpty()) {
            call.reject("腾讯云 TTS 需要 SecretKey（API Key Secondary）。");
            return;
        }
        int voiceType;
        try {
            voiceType = Integer.parseInt(voiceId);
        } catch (NumberFormatException e) {
            call.reject("腾讯云 VoiceType 必须为数字。");
            return;
        }
        String host = "tts.tencentcloudapi.com";
        String service = "tts";
        long timestamp = System.currentTimeMillis() / 1000;
        String date = new SimpleDateFormat("yyyy-MM-dd", Locale.US).format(new Date(timestamp * 1000));
        JSONObject payloadObj = new JSONObject();
        payloadObj.put("Text", text);
        payloadObj.put("SessionId", UUID.randomUUID().toString());
        payloadObj.put("VoiceType", voiceType);
        payloadObj.put("Codec", "mp3");
        payloadObj.put("SampleRate", 16000);
        String payloadStr = payloadObj.toString();
        String hashedPayload = sha256Hex(payloadStr);
        String canonicalRequest = "POST\n/\n\ncontent-type:application/json\nhost:" + host + "\n\ncontent-type;host\n" + hashedPayload;
        String credentialScope = date + "/" + service + "/tc3_request";
        String stringToSign = "TC3-HMAC-SHA256\n" + timestamp + "\n" + credentialScope + "\n" + sha256Hex(canonicalRequest);
        byte[] secretDate = hmacSha256(("TC3" + secretKey).getBytes(StandardCharsets.UTF_8), date);
        byte[] secretService = hmacSha256(secretDate, service);
        byte[] secretSigning = hmacSha256(secretService, "tc3_request");
        String signature = hexEncode(hmacSha256(secretSigning, stringToSign));
        String authorization = "TC3-HMAC-SHA256 Credential=" + secretId + "/" + credentialScope + ", SignedHeaders=content-type;host, Signature=" + signature;
        HttpURLConnection conn = openPost("https://" + host);
        conn.setRequestProperty("Authorization", authorization);
        conn.setRequestProperty("Host", host);
        conn.setRequestProperty("X-TC-Action", "TextToVoice");
        conn.setRequestProperty("X-TC-Timestamp", String.valueOf(timestamp));
        conn.setRequestProperty("X-TC-Version", "2019-08-23");
        conn.setRequestProperty("X-TC-Region", region);
        writeBody(conn, payloadStr);
        int code = conn.getResponseCode();
        byte[] respBytes = readAll(code >= 400 ? conn.getErrorStream() : conn.getInputStream());
        JSONObject json = new JSONObject(new String(respBytes, StandardCharsets.UTF_8));
        if (code < 200 || code >= 300 || json.optJSONObject("Response") != null && json.getJSONObject("Response").has("Error")) {
            String errDetail = json.optJSONObject("Response") != null ? truncate(json.getJSONObject("Response").optString("Error", json.toString())) : truncate(new String(respBytes, StandardCharsets.UTF_8));
            call.reject("腾讯云 TTS 请求失败：" + errDetail);
            return;
        }
        String audio = json.getJSONObject("Response").getString("Audio");
        JSObject result = new JSObject();
        result.put("data", audio);
        result.put("mimeType", "audio/mpeg");
        call.resolve(result);
    }

    private void synthesizeGoogle(PluginCall call, String apiKey, String voiceId, String text, String languageCode) throws Exception {
        JSONObject input = new JSONObject();
        input.put("text", text);
        JSONObject voice = new JSONObject();
        voice.put("languageCode", languageCode.isEmpty() ? "cmn-CN" : languageCode);
        voice.put("name", voiceId);
        JSONObject audioConfig = new JSONObject();
        audioConfig.put("audioEncoding", "MP3");
        audioConfig.put("sampleRateHertz", 16000);
        JSONObject payload = new JSONObject();
        payload.put("input", input);
        payload.put("voice", voice);
        payload.put("audioConfig", audioConfig);
        String urlStr = "https://texttospeech.googleapis.com/v1/text:synthesize?key=" + java.net.URLEncoder.encode(apiKey, "UTF-8");
        HttpURLConnection conn = trackedConnection(urlStr);
        conn.setRequestMethod("POST");
        conn.setConnectTimeout(30_000);
        conn.setReadTimeout(30_000);
        conn.setRequestProperty("Content-Type", "application/json; charset=utf-8");
        conn.setDoOutput(true);
        writeBody(conn, payload.toString());
        int code = conn.getResponseCode();
        byte[] respBytes = readAll(code >= 400 ? conn.getErrorStream() : conn.getInputStream());
        if (code < 200 || code >= 300) {
            call.reject("Google TTS 请求失败（" + code + "）：" + truncate(new String(respBytes, StandardCharsets.UTF_8)));
            return;
        }
        JSONObject json = new JSONObject(new String(respBytes, StandardCharsets.UTF_8));
        String audioContent = json.getString("audioContent");
        JSObject result = new JSObject();
        result.put("data", audioContent);
        result.put("mimeType", "audio/mpeg");
        call.resolve(result);
    }

    private void resolveAudio(PluginCall call, byte[] bytes) {
        JSObject result = new JSObject();
        result.put("data", Base64.encodeToString(bytes, Base64.NO_WRAP));
        result.put("mimeType", "audio/mpeg");
        call.resolve(result);
    }

    private HttpURLConnection openPost(String urlStr) throws Exception {
        HttpURLConnection conn = trackedConnection(urlStr);
        conn.setRequestMethod("POST");
        conn.setConnectTimeout(30000);
        conn.setReadTimeout(120000);
        conn.setRequestProperty("Content-Type", "application/json; charset=utf-8");
        conn.setDoOutput(true);
        return conn;
    }

    private void writeBody(HttpURLConnection conn, String body) throws Exception {
        try (OutputStream out = conn.getOutputStream()) {
            out.write(body.getBytes(StandardCharsets.UTF_8));
        }
    }

    private byte[] readAll(InputStream input) throws Exception {
        if (input == null) return new byte[0];
        try (InputStream stream = input; ByteArrayOutputStream output = new ByteArrayOutputStream()) {
            byte[] buffer = new byte[8192];
            int length;
            while ((length = stream.read(buffer)) != -1) output.write(buffer, 0, length);
            return output.toByteArray();
        }
    }

    private byte[] hmacSha256(byte[] key, String data) throws Exception {
        Mac mac = Mac.getInstance("HmacSHA256");
        mac.init(new SecretKeySpec(key, "HmacSHA256"));
        return mac.doFinal(data.getBytes(StandardCharsets.UTF_8));
    }

    private String sha256Hex(String data) throws Exception {
        MessageDigest digest = MessageDigest.getInstance("SHA-256");
        return hexEncode(digest.digest(data.getBytes(StandardCharsets.UTF_8)));
    }

    private String hexEncode(byte[] bytes) {
        StringBuilder sb = new StringBuilder(bytes.length * 2);
        for (byte b : bytes) sb.append(String.format("%02x", b));
        return sb.toString();
    }

    private String truncate(String s) {
        return s.length() > 200 ? s.substring(0, 200) : s;
    }
}
