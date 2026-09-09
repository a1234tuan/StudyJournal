package com.noteproject.study408;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.os.Build;
import android.os.IBinder;
import android.util.Base64;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.text.SimpleDateFormat;
import java.util.Date;
import java.util.Locale;
import java.util.TimeZone;
import java.util.UUID;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.TimeUnit;
import javax.crypto.Mac;
import javax.crypto.spec.SecretKeySpec;
import org.json.JSONArray;
import org.json.JSONObject;

/**
 * Owns an entire podcast TTS queue so Android can keep it alive while the
 * WebView is backgrounded. The API key and source text remain in memory only.
 */
public final class PodcastTtsForegroundService extends Service {
    public static final String ACTION_START = "com.noteproject.study408.PODCAST_TTS_START";
    public static final String ACTION_CANCEL = "com.noteproject.study408.PODCAST_TTS_CANCEL";
    private static final String EXTRA_JOB = "job";
    private static final String EXTRA_API_KEY = "apiKey";
    private static final String EXTRA_API_KEY_SECONDARY = "apiKeySecondary";
    private static final String CHANNEL_ID = "study_podcast_tts";
    private static final int NOTIFICATION_ID = 40802;
    private static final String PREFS = "podcast_tts_state";
    private static final String PREF_STATE = "state";
    private static final long HEARTBEAT_MS = 10_000L;
    private static final long REQUEST_STALL_MS = 150_000L;
    private static volatile boolean serviceRunning;

    private final Object stateLock = new Object();
    private ExecutorService worker;
    private ScheduledExecutorService heartbeatExecutor;
    private volatile HttpURLConnection activeConnection;
    private volatile boolean cancelled;
    private volatile long requestStartedAtMs;
    private JSONObject state;

    public static void start(Context context, String jobJson, String apiKey, String apiKeySecondary) {
        Intent intent = new Intent(context, PodcastTtsForegroundService.class)
            .setAction(ACTION_START)
            .putExtra(EXTRA_JOB, jobJson)
            .putExtra(EXTRA_API_KEY, apiKey)
            .putExtra(EXTRA_API_KEY_SECONDARY, apiKeySecondary != null ? apiKeySecondary : "");
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) context.startForegroundService(intent);
        else context.startService(intent);
    }

    public static void cancel(Context context, String jobId, String podcastId) {
        Intent intent = new Intent(context, PodcastTtsForegroundService.class)
            .setAction(ACTION_CANCEL)
            .putExtra("jobId", jobId)
            .putExtra("podcastId", podcastId);
        context.startService(intent);
    }

    public static String readState(Context context) {
        return context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getString(PREF_STATE, "");
    }

    public static boolean isServiceRunning() { return serviceRunning; }

    public static String takeNextArtifact(Context context) {
        try {
            JSONObject state = readStateObject(context);
            if (state == null) return "";
            JSONArray artifacts = state.optJSONArray("artifacts");
            if (artifacts == null) return "";
            for (int index = 0; index < artifacts.length(); index += 1) {
                JSONObject artifact = artifacts.optJSONObject(index);
                if (artifact == null || artifact.optBoolean("acknowledged", false)) continue;
                File file = new File(artifact.optString("path", ""));
                if (!file.isFile()) {
                    artifact.put("acknowledged", true);
                    saveState(context, state);
                    continue;
                }
                JSONObject result = new JSONObject();
                result.put("jobId", state.optString("jobId"));
                result.put("podcastId", state.optString("podcastId"));
                result.put("unitId", artifact.optString("unitId"));
                result.put("title", artifact.optString("title"));
                result.put("mimeType", "audio/mpeg");
                result.put("data", Base64.encodeToString(readAll(new FileInputStream(file)), Base64.NO_WRAP));
                return result.toString();
            }
        } catch (Exception ignored) {
            // The JavaScript side will keep the job recoverable and can retry.
        }
        return "";
    }

    public static void acknowledgeArtifact(Context context, String jobId, String unitId) {
        try {
            JSONObject state = readStateObject(context);
            if (state == null || !jobId.equals(state.optString("jobId"))) return;
            JSONArray artifacts = state.optJSONArray("artifacts");
            if (artifacts == null) return;
            for (int index = 0; index < artifacts.length(); index += 1) {
                JSONObject artifact = artifacts.optJSONObject(index);
                if (artifact == null || !unitId.equals(artifact.optString("unitId"))) continue;
                File file = new File(artifact.optString("path", ""));
                if (file.isFile()) file.delete();
                artifact.put("acknowledged", true);
                break;
            }
            saveState(context, state);
        } catch (Exception ignored) {
            // The artifact remains available for the next sync attempt.
        }
    }

    private static JSONObject readStateObject(Context context) {
        try {
            String value = readState(context);
            return value.isEmpty() ? null : new JSONObject(value);
        } catch (Exception error) {
            return null;
        }
    }

    private static void saveState(Context context, JSONObject state) {
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().putString(PREF_STATE, state.toString()).apply();
    }

    @Override
    public void onCreate() {
        super.onCreate();
        serviceRunning = true;
        worker = Executors.newSingleThreadExecutor();
        heartbeatExecutor = Executors.newSingleThreadScheduledExecutor();
        heartbeatExecutor.scheduleAtFixedRate(this::heartbeat, HEARTBEAT_MS, HEARTBEAT_MS, TimeUnit.MILLISECONDS);
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        String action = intent != null ? intent.getAction() : null;
        if (ACTION_CANCEL.equals(action)) {
            requestCancellation("已取消音频生成。");
            return START_NOT_STICKY;
        }
        if (!ACTION_START.equals(action)) return START_NOT_STICKY;
        String jobJson = intent.getStringExtra(EXTRA_JOB);
        String apiKey = intent.getStringExtra(EXTRA_API_KEY);
        String apiKeySecondary = intent.getStringExtra(EXTRA_API_KEY_SECONDARY);
        if (apiKeySecondary == null) apiKeySecondary = "";
        if (jobJson == null || apiKey == null || apiKey.trim().isEmpty()) {
            markInterrupted("后台服务启动参数不完整，任务已中断。");
            return START_NOT_STICKY;
        }
        try {
            JSONObject job = new JSONObject(jobJson);
            cancelled = false;
            requestStartedAtMs = 0;
            synchronized (stateLock) {
                state = createInitialState(job);
                persistLocked();
            }
            startForegroundNotification();
            final String finalApiKeySecondary = apiKeySecondary;
            worker.execute(() -> runJob(job, apiKey.trim(), finalApiKeySecondary.trim()));
        } catch (Exception error) {
            markInterrupted("无法启动后台音频任务：" + safeMessage(error));
        }
        return START_NOT_STICKY;
    }

    @Override
    public void onTaskRemoved(Intent rootIntent) {
        // A foreground service intentionally survives swiping the activity from
        // recents. Force-stop and reboot remain explicit interruption cases.
        super.onTaskRemoved(rootIntent);
    }

    @Override
    public void onDestroy() {
        serviceRunning = false;
        boolean stillRunning;
        synchronized (stateLock) {
            stillRunning = state != null && "running".equals(state.optString("status"));
        }
        if (stillRunning) markInterrupted("后台服务已停止，任务可能已中断。");
        if (worker != null) worker.shutdownNow();
        if (heartbeatExecutor != null) heartbeatExecutor.shutdownNow();
        super.onDestroy();
    }

    @Override
    public IBinder onBind(Intent intent) { return null; }

    private JSONObject createInitialState(JSONObject job) throws Exception {
        JSONObject next = new JSONObject();
        String timestamp = now();
        next.put("jobId", job.optString("jobId"));
        next.put("podcastId", job.optString("podcastId"));
        next.put("podcastTitle", job.optString("podcastTitle", "知识播客"));
        next.put("status", "running");
        next.put("runnerActive", true);
        next.put("message", "正在准备播客音频…");
        next.put("startedAt", timestamp);
        next.put("updatedAt", timestamp);
        next.put("heartbeatAt", timestamp);
        JSONArray sourceUnits = job.optJSONArray("units");
        JSONArray units = new JSONArray();
        if (sourceUnits != null) for (int index = 0; index < sourceUnits.length(); index += 1) {
            JSONObject source = sourceUnits.optJSONObject(index);
            if (source == null) continue;
            JSONObject unit = new JSONObject();
            unit.put("unitId", source.optString("unitId"));
            unit.put("title", source.optString("title", "章节"));
            unit.put("order", source.optInt("order", index));
            unit.put("status", "pending");
            units.put(unit);
        }
        next.put("units", units);
        next.put("total", units.length());
        next.put("artifacts", new JSONArray());
        next.put("diagnostics", new JSONArray());
        return next;
    }

    private void runJob(JSONObject job, String apiKey, String apiKeySecondary) {
        try {
            String providerId = job.optString("providerId", "fish-audio");
            String model = job.optString("model", "");
            String voiceId = job.optString("voiceId", "");
            String region = job.optString("region", "ap-guangzhou");
            String languageCode = job.optString("languageCode", "cmn-CN");
            JSONArray inputUnits = job.optJSONArray("units");
            if (inputUnits == null || inputUnits.length() == 0) throw new IllegalArgumentException("没有可生成的音频单元。");
            boolean anyFailure = false;
            for (int index = 0; index < inputUnits.length(); index += 1) {
                if (cancelled) break;
                JSONObject inputUnit = inputUnits.optJSONObject(index);
                if (inputUnit == null) continue;
                String unitId = inputUnit.optString("unitId");
                String title = inputUnit.optString("title", "章节");
                JSONArray parts = inputUnit.optJSONArray("parts");
                if (unitId.isEmpty() || parts == null || parts.length() == 0) {
                    anyFailure = true;
                    continue;
                }
                updateUnit(unitId, "generating", null, index + 1, inputUnits.length(), 0, parts.length(), "正在生成" + title + "音频…");
                File output = outputFile(unitId);
                if (output.exists()) output.delete();
                boolean unitSuccess = true;
                try (FileOutputStream outputStream = new FileOutputStream(output, true)) {
                    for (int partIndex = 0; partIndex < parts.length(); partIndex += 1) {
                        if (cancelled) break;
                        String text = parts.optString(partIndex, "").trim();
                        if (text.isEmpty()) continue;
                        updateUnit(unitId, "generating", null, index + 1, inputUnits.length(), partIndex + 1, parts.length(), title + "语音片段 " + (partIndex + 1) + "/" + parts.length());
                        byte[] audio = requestAudio(providerId, apiKey, apiKeySecondary, model, voiceId, region, languageCode, text, unitId, title, partIndex + 1, parts.length());
                        if (audio == null || audio.length == 0) throw new IllegalStateException("TTS 返回了空音频。");
                        byte[] normalizedAudio = normalizeMp3Segment(audio);
                        if (!isLikelyMp3Audio(normalizedAudio)) throw new IllegalStateException("TTS 返回的内容不是有效的 MP3 音频。");
                        outputStream.write(normalizedAudio);
                    }
                } catch (Exception error) {
                    unitSuccess = false;
                    if (output.exists()) output.delete();
                    String message = cancelled ? "已取消" : safeMessage(error);
                    updateUnit(unitId, cancelled ? "pending" : "failed", message, index + 1, inputUnits.length(), null, null, cancelled ? "音频生成已取消" : title + "生成失败");
                    addDiagnostic(unitId, title, null, null, null, null, null, message);
                }
                if (cancelled) break;
                if (unitSuccess) {
                    addArtifact(unitId, title, output);
                    updateUnit(unitId, "ready", null, index + 1, inputUnits.length(), null, null, title + "音频已生成，等待保存…");
                } else anyFailure = true;
            }
            synchronized (stateLock) {
                if (state == null) return;
                state.put("status", cancelled ? "cancelled" : anyFailure ? "partial" : "completed");
                state.put("runnerActive", false);
                state.put("message", cancelled ? "音频生成已取消，已完成章节仍会保留。" : anyFailure ? "部分章节生成失败，可单独重试。" : "全部章节音频已生成，正在等待导入。" );
                touchLocked();
                persistLocked();
            }
        } catch (Exception error) {
            markInterrupted("后台音频任务失败：" + safeMessage(error));
        } finally {
            activeConnection = null;
            requestStartedAtMs = 0;
            stopForeground(STOP_FOREGROUND_REMOVE);
            stopSelf();
        }
    }

    /** Failures where another attempt can only waste quota (bad key, 4xx, or a
     * download failure after a synthesis that was already billed). */
    private static final class NonRetryableTtsError extends Exception {
        NonRetryableTtsError(String message) {
            super(message);
        }
    }

    private byte[] requestAudio(String providerId, String apiKey, String apiKeySecondary, String model, String voiceId, String region, String languageCode, String text, String unitId, String title, int partCurrent, int partTotal) throws Exception {
        Exception lastError = null;
        for (int attempt = 1; attempt <= 3; attempt += 1) {
            if (cancelled) throw new InterruptedException("已取消");
            HttpURLConnection connection = null;
            requestStartedAtMs = System.currentTimeMillis();
            markRequestStarted();
            try {
                byte[] result = null;
                switch (providerId) {
                    case "aliyun": result = requestAliyun(apiKey, model, voiceId, text); break;
                    case "tencent": result = requestTencent(apiKey, apiKeySecondary, voiceId, text, region); break;
                    case "google": result = requestGoogle(apiKey, voiceId, text, languageCode); break;
                    case "doubao": result = requestDoubao(apiKey, model, voiceId, text); break;
                    default: {
                        String fishModel = model.isEmpty() ? "s2.1-pro-free" : model;
                        connection = (HttpURLConnection) new URL("https://api.fish.audio/v1/tts").openConnection();
                        activeConnection = connection;
                        connection.setRequestMethod("POST");
                        connection.setConnectTimeout(30_000);
                        connection.setReadTimeout(30_000);
                        connection.setRequestProperty("Authorization", "Bearer " + apiKey.replaceFirst("(?i)^Bearer\\s+", ""));
                        connection.setRequestProperty("Content-Type", "application/json; charset=utf-8");
                        connection.setRequestProperty("Accept", "audio/mpeg");
                        connection.setRequestProperty("model", fishModel);
                        connection.setDoOutput(true);
                        JSONObject payload = new JSONObject();
                        payload.put("text", text);
                        payload.put("reference_id", voiceId);
                        payload.put("format", "mp3");
                        payload.put("normalize", true);
                        payload.put("mp3_bitrate", 64);
                        payload.put("latency", "normal");
                        payload.put("chunk_length", 300);
                        try (OutputStream out = connection.getOutputStream()) {
                            out.write(payload.toString().getBytes(StandardCharsets.UTF_8));
                        }
                        int code = connection.getResponseCode();
                        String requestId = firstNonEmpty(connection.getHeaderField("x-request-id"), connection.getHeaderField("request-id"));
                        byte[] bytes = readAll(code >= 400 ? connection.getErrorStream() : connection.getInputStream());
                        if (code >= 200 && code < 300) {
                            addDiagnostic(unitId, title, partCurrent, partTotal, attempt, code, requestId, "Fish Audio 请求成功。");
                            result = bytes;
                        } else {
                            String detail = truncate(new String(bytes, StandardCharsets.UTF_8).replaceAll("\\s+", " ").trim(), 180);
                            String message = "Fish Audio 请求失败（" + code + "）：" + detail;
                            addDiagnostic(unitId, title, partCurrent, partTotal, attempt, code, requestId, message);
                            if (code != 429 && code < 500) throw new NonRetryableTtsError(message);
                            lastError = new IllegalStateException(message);
                        }
                    }
                }
                if (result != null) {
                    addDiagnostic(unitId, title, partCurrent, partTotal, attempt, 200, null, providerId + " 请求成功。");
                    return result;
                }
            } catch (NonRetryableTtsError error) {
                addDiagnostic(unitId, title, partCurrent, partTotal, attempt, null, null, safeMessage(error));
                throw error;
            } catch (Exception error) {
                if (cancelled) throw new InterruptedException("已取消");
                lastError = error;
                addDiagnostic(unitId, title, partCurrent, partTotal, attempt, null, null, safeMessage(error));
            } finally {
                requestStartedAtMs = 0;
                markRequestFinished();
                activeConnection = null;
                if (connection != null) connection.disconnect();
            }
            if (attempt < 3) Thread.sleep(500L * attempt);
        }
        throw lastError != null ? lastError : new IllegalStateException("TTS 请求失败。");
    }

    private byte[] requestAliyun(String apiKey, String model, String voiceId, String text) throws Exception {
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
        activeConnection = conn;
        conn.setRequestProperty("Authorization", "Bearer " + apiKey);
        writeBody(conn, payload.toString());
        int code = conn.getResponseCode();
        byte[] respBytes = readAll(code >= 400 ? conn.getErrorStream() : conn.getInputStream());
        conn.disconnect();
        activeConnection = null;
        if (code < 200 || code >= 300) {
            String message = "阿里云 TTS 请求失败（" + code + "）：" + truncate(new String(respBytes, StandardCharsets.UTF_8), 180);
            if (code != 429 && code < 500) throw new NonRetryableTtsError(message);
            throw new IllegalStateException(message);
        }
        JSONObject json = new JSONObject(new String(respBytes, StandardCharsets.UTF_8));
        String audioUrl = json.getJSONObject("output").getJSONObject("audio").getString("url");
        HttpURLConnection audioConn = (HttpURLConnection) new URL(audioUrl).openConnection();
        activeConnection = audioConn;
        audioConn.setConnectTimeout(30_000);
        audioConn.setReadTimeout(30_000);
        int audioCode = audioConn.getResponseCode();
        byte[] audioBytes = readAll(audioCode >= 400 ? audioConn.getErrorStream() : audioConn.getInputStream());
        audioConn.disconnect();
        activeConnection = null;
        if (audioCode < 200 || audioCode >= 300) throw new NonRetryableTtsError("阿里云音频下载失败（" + audioCode + "）；语音已合成，不重复计费重试。");
        return audioBytes;
    }

    private byte[] requestDoubao(String apiKey, String model, String voiceId, String text) throws Exception {
        String resourceId = model.isEmpty() ? "seed-tts-2.0" : model;
        JSONObject request = new JSONObject();
        request.put("text", text);
        request.put("speaker", voiceId);
        JSONObject audioParams = new JSONObject();
        audioParams.put("format", "mp3");
        audioParams.put("sample_rate", 16000);
        request.put("audio_params", audioParams);
        JSONObject payload = new JSONObject();
        payload.put("req_params", request);
        HttpURLConnection conn = openPost("https://openspeech.bytedance.com/api/v3/tts/unidirectional");
        activeConnection = conn;
        try {
            conn.setRequestProperty("X-Api-Key", apiKey);
            conn.setRequestProperty("X-Api-Resource-Id", resourceId);
            conn.setRequestProperty("X-Api-Request-Id", UUID.randomUUID().toString());
            conn.setRequestProperty("Accept", "application/json");
            writeBody(conn, payload.toString());
            int code = conn.getResponseCode();
            byte[] responseBytes = readAll(code >= 400 ? conn.getErrorStream() : conn.getInputStream());
            if (code < 200 || code >= 300) {
                throw new IllegalStateException("豆包 TTS 请求失败（" + code + "）：" + truncate(new String(responseBytes, StandardCharsets.UTF_8).replaceAll("\\s+", " ").trim(), 180));
            }
            ByteArrayOutputStream audio = new ByteArrayOutputStream();
            for (String line : new String(responseBytes, StandardCharsets.UTF_8).split("\\r?\\n")) {
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
            if (result.length == 0) throw new IllegalStateException("豆包 TTS 未返回音频数据。");
            return result;
        } finally {
            conn.disconnect();
            activeConnection = null;
        }
    }

    private byte[] requestTencent(String secretId, String secretKey, String voiceId, String text, String region) throws Exception {
        if (secretKey.isEmpty()) throw new IllegalStateException("腾讯云 TTS 需要 SecretKey。");
        int voiceType;
        try { voiceType = Integer.parseInt(voiceId); }
        catch (NumberFormatException e) { throw new IllegalStateException("腾讯云 VoiceType 必须为数字。"); }
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
        activeConnection = conn;
        conn.setRequestProperty("Authorization", authorization);
        conn.setRequestProperty("Host", host);
        conn.setRequestProperty("X-TC-Action", "TextToVoice");
        conn.setRequestProperty("X-TC-Timestamp", String.valueOf(timestamp));
        conn.setRequestProperty("X-TC-Version", "2019-08-23");
        conn.setRequestProperty("X-TC-Region", region);
        writeBody(conn, payloadStr);
        int code = conn.getResponseCode();
        byte[] respBytes = readAll(code >= 400 ? conn.getErrorStream() : conn.getInputStream());
        conn.disconnect();
        activeConnection = null;
        JSONObject json = new JSONObject(new String(respBytes, StandardCharsets.UTF_8));
        if (code < 200 || code >= 300 || (json.optJSONObject("Response") != null && json.getJSONObject("Response").has("Error"))) {
            throw new IllegalStateException("腾讯云 TTS 请求失败：" + truncate(json.toString(), 200));
        }
        String audio = json.getJSONObject("Response").getString("Audio");
        return Base64.decode(audio, Base64.DEFAULT);
    }

    private byte[] requestGoogle(String apiKey, String voiceId, String text, String languageCode) throws Exception {
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
        HttpURLConnection conn = (HttpURLConnection) new java.net.URL(urlStr).openConnection();
        conn.setRequestMethod("POST");
        conn.setConnectTimeout(30_000);
        conn.setReadTimeout(30_000);
        conn.setRequestProperty("Content-Type", "application/json; charset=utf-8");
        conn.setDoOutput(true);
        activeConnection = conn;
        writeBody(conn, payload.toString());
        int code = conn.getResponseCode();
        byte[] respBytes = readAll(code >= 400 ? conn.getErrorStream() : conn.getInputStream());
        conn.disconnect();
        activeConnection = null;
        if (code < 200 || code >= 300) throw new IllegalStateException("Google TTS 请求失败（" + code + "）：" + truncate(new String(respBytes, StandardCharsets.UTF_8), 180));
        JSONObject json = new JSONObject(new String(respBytes, StandardCharsets.UTF_8));
        String audioContent = json.getString("audioContent");
        return Base64.decode(audioContent, Base64.DEFAULT);
    }

    private HttpURLConnection openPost(String urlStr) throws Exception {
        HttpURLConnection conn = (HttpURLConnection) new URL(urlStr).openConnection();
        conn.setRequestMethod("POST");
        conn.setConnectTimeout(30_000);
        conn.setReadTimeout(30_000);
        conn.setRequestProperty("Content-Type", "application/json; charset=utf-8");
        conn.setDoOutput(true);
        return conn;
    }

    private void writeBody(HttpURLConnection conn, String body) throws Exception {
        try (OutputStream out = conn.getOutputStream()) {
            out.write(body.getBytes(StandardCharsets.UTF_8));
        }
    }

    private byte[] hmacSha256(byte[] key, String data) throws Exception {
        Mac mac = Mac.getInstance("HmacSHA256");
        mac.init(new SecretKeySpec(key, "HmacSHA256"));
        return mac.doFinal(data.getBytes(StandardCharsets.UTF_8));
    }

    private String sha256Hex(String data) throws Exception {
        return hexEncode(MessageDigest.getInstance("SHA-256").digest(data.getBytes(StandardCharsets.UTF_8)));
    }

    private String hexEncode(byte[] bytes) {
        StringBuilder sb = new StringBuilder(bytes.length * 2);
        for (byte b : bytes) sb.append(String.format("%02x", b));
        return sb.toString();
    }


    private void heartbeat() {
        HttpURLConnection connection = activeConnection;
        if (connection != null && requestStartedAtMs > 0 && System.currentTimeMillis() - requestStartedAtMs > REQUEST_STALL_MS) {
            connection.disconnect();
        }
        synchronized (stateLock) {
            if (state == null || !"running".equals(state.optString("status"))) return;
            try {
                state.put("heartbeatAt", now());
                state.put("updatedAt", now());
                persistLocked();
                updateNotification();
            } catch (Exception ignored) { }
        }
    }

    private void markRequestStarted() {
        synchronized (stateLock) {
            try {
                if (state == null) return;
                state.put("requestStartedAt", now());
                touchLocked();
                persistLocked();
            } catch (Exception ignored) { }
        }
    }

    private void markRequestFinished() {
        synchronized (stateLock) {
            try {
                if (state == null) return;
                state.remove("requestStartedAt");
                touchLocked();
                persistLocked();
            } catch (Exception ignored) { }
        }
    }

    private void requestCancellation(String message) {
        cancelled = true;
        HttpURLConnection connection = activeConnection;
        if (connection != null) connection.disconnect();
        synchronized (stateLock) {
            if (state == null) state = readStateObject(getApplicationContext());
            if (state == null) return;
            try {
                state.put("status", "cancelled");
                state.put("runnerActive", false);
                state.put("message", message);
                touchLocked();
                persistLocked();
            } catch (Exception ignored) { }
        }
    }

    private void markInterrupted(String message) {
        synchronized (stateLock) {
            try {
                if (state == null) state = readStateObject(getApplicationContext());
                if (state == null) return;
                state.put("status", "failed");
                state.put("runnerActive", false);
                state.put("message", message);
                touchLocked();
                persistLocked();
            } catch (Exception ignored) { }
        }
    }

    private void updateUnit(String unitId, String status, String error, int current, int total, Integer partCurrent, Integer partTotal, String message) {
        synchronized (stateLock) {
            try {
                if (state == null) return;
                JSONArray units = state.optJSONArray("units");
                if (units != null) for (int index = 0; index < units.length(); index += 1) {
                    JSONObject unit = units.optJSONObject(index);
                    if (unit != null && unitId.equals(unit.optString("unitId"))) {
                        unit.put("status", status);
                        if (error == null) unit.remove("error"); else unit.put("error", error);
                        break;
                    }
                }
                state.put("current", current);
                state.put("total", total);
                if (partCurrent == null) state.remove("partCurrent"); else state.put("partCurrent", partCurrent);
                if (partTotal == null) state.remove("partTotal"); else state.put("partTotal", partTotal);
                state.put("message", message);
                touchLocked();
                persistLocked();
                updateNotification();
            } catch (Exception ignored) { }
        }
    }

    private void addArtifact(String unitId, String title, File file) {
        synchronized (stateLock) {
            try {
                if (state == null) return;
                JSONObject artifact = new JSONObject();
                artifact.put("unitId", unitId);
                artifact.put("title", title);
                artifact.put("path", file.getAbsolutePath());
                artifact.put("acknowledged", false);
                state.getJSONArray("artifacts").put(artifact);
                touchLocked();
                persistLocked();
            } catch (Exception ignored) { }
        }
    }

    private void addDiagnostic(String unitId, String title, Integer partCurrent, Integer partTotal, Integer attempt, Integer httpStatus, String requestId, String message) {
        synchronized (stateLock) {
            try {
                if (state == null) return;
                JSONArray diagnostics = state.getJSONArray("diagnostics");
                JSONObject diagnostic = new JSONObject();
                diagnostic.put("at", now());
                diagnostic.put("unitId", unitId);
                diagnostic.put("unitTitle", title);
                if (partCurrent != null) diagnostic.put("partCurrent", partCurrent);
                if (partTotal != null) diagnostic.put("partTotal", partTotal);
                if (attempt != null) diagnostic.put("attempt", attempt);
                if (httpStatus != null) diagnostic.put("httpStatus", httpStatus);
                if (requestId != null && !requestId.isEmpty()) diagnostic.put("requestId", requestId);
                diagnostic.put("message", truncate(message, 220));
                diagnostics.put(diagnostic);
                while (diagnostics.length() > 10) diagnostics.remove(0);
                touchLocked();
                persistLocked();
            } catch (Exception ignored) { }
        }
    }

    private File outputFile(String unitId) {
        String jobId;
        synchronized (stateLock) { jobId = state != null ? state.optString("jobId", "unknown") : "unknown"; }
        File directory = new File(getFilesDir(), "podcast-tts" + File.separator + jobId);
        if (!directory.exists()) directory.mkdirs();
        return new File(directory, unitId + ".mp3");
    }

    private void startForegroundNotification() {
        createNotificationChannel();
        Notification notification = buildNotification();
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) startForeground(NOTIFICATION_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC);
        else startForeground(NOTIFICATION_ID, notification);
    }

    private void updateNotification() {
        NotificationManager manager = getSystemService(NotificationManager.class);
        if (manager != null) manager.notify(NOTIFICATION_ID, buildNotification());
    }

    private void createNotificationChannel() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;
        NotificationChannel channel = new NotificationChannel(CHANNEL_ID, "知识播客音频生成", NotificationManager.IMPORTANCE_LOW);
        channel.setDescription("知识播客正在后台生成音频");
        NotificationManager manager = getSystemService(NotificationManager.class);
        if (manager != null) manager.createNotificationChannel(channel);
    }

    private Notification buildNotification() {
        JSONObject snapshot;
        synchronized (stateLock) { snapshot = state; }
        String title = snapshot != null ? snapshot.optString("podcastTitle", "知识播客") : "知识播客";
        String message = snapshot != null ? snapshot.optString("message", "正在生成音频…") : "正在生成音频…";
        int current = snapshot != null ? snapshot.optInt("current", 0) : 0;
        int total = snapshot != null ? snapshot.optInt("total", 0) : 0;
        Intent launchIntent = new Intent(this, MainActivity.class).setFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        PendingIntent contentIntent = PendingIntent.getActivity(this, 0, launchIntent, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
        Intent cancelIntent = new Intent(this, PodcastTtsForegroundService.class).setAction(ACTION_CANCEL);
        PendingIntent cancelPendingIntent = PendingIntent.getService(this, 1, cancelIntent, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
        Notification.Builder builder = Build.VERSION.SDK_INT >= Build.VERSION_CODES.O ? new Notification.Builder(this, CHANNEL_ID) : new Notification.Builder(this);
        return builder.setContentTitle("正在生成：" + title)
            .setContentText(message)
            .setSmallIcon(android.R.drawable.ic_media_play)
            .setContentIntent(contentIntent)
            .setOngoing(true)
            .setProgress(total, current, total <= 0)
            .addAction(android.R.drawable.ic_menu_close_clear_cancel, "取消", cancelPendingIntent)
            .build();
    }

    private void touchLocked() throws Exception {
        if (state == null) return;
        String timestamp = now();
        state.put("updatedAt", timestamp);
        state.put("heartbeatAt", timestamp);
    }

    private void persistLocked() { if (state != null) saveState(getApplicationContext(), state); }

    private static byte[] readAll(InputStream input) throws Exception {
        if (input == null) return new byte[0];
        try (InputStream stream = input; ByteArrayOutputStream output = new ByteArrayOutputStream()) {
            byte[] buffer = new byte[8192];
            int length;
            while ((length = stream.read(buffer)) != -1) output.write(buffer, 0, length);
            return output.toByteArray();
        }
    }

    /** Removes per-response ID3 metadata so concatenated TTS parts remain one MP3 stream. */
    private static byte[] normalizeMp3Segment(byte[] input) {
        int start = 0;
        int end = input.length;
        if (input.length >= 10 && input[0] == 'I' && input[1] == 'D' && input[2] == '3') {
            int payload = ((input[6] & 0x7f) << 21) | ((input[7] & 0x7f) << 14) | ((input[8] & 0x7f) << 7) | (input[9] & 0x7f);
            int footer = (input[5] & 0x10) != 0 ? 10 : 0;
            int total = 10 + payload + footer;
            if (total <= input.length) start = total;
        }
        if (end >= 128 && input[end - 128] == 'T' && input[end - 127] == 'A' && input[end - 126] == 'G') {
            end -= 128;
        }
        int length = Math.max(0, end - start);
        byte[] output = new byte[length];
        System.arraycopy(input, start, output, 0, length);
        return output;
    }

    private static boolean isLikelyMp3Audio(byte[] bytes) {
        int limit = Math.min(Math.max(0, bytes.length - 3), 128 * 1024);
        for (int index = 0; index < limit; index += 1) {
            if ((bytes[index] & 0xff) != 0xff || (bytes[index + 1] & 0xe0) != 0xe0) continue;
            int version = (bytes[index + 1] >> 3) & 0x03;
            int layer = (bytes[index + 1] >> 1) & 0x03;
            int bitrate = (bytes[index + 2] >> 4) & 0x0f;
            int sampleRate = (bytes[index + 2] >> 2) & 0x03;
            if (version != 0x01 && layer != 0 && bitrate != 0 && bitrate != 0x0f && sampleRate != 0x03) return true;
        }
        return false;
    }

    private static String now() {
        SimpleDateFormat format = new SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'", Locale.US);
        format.setTimeZone(TimeZone.getTimeZone("UTC"));
        return format.format(new Date());
    }

    private static String truncate(String value, int limit) {
        if (value == null || value.isEmpty()) return "未知错误。";
        return value.length() > limit ? value.substring(0, limit) : value;
    }

    private static String safeMessage(Exception error) { return truncate(error.getMessage(), 220); }
    private static String firstNonEmpty(String first, String second) { return first != null && !first.isEmpty() ? first : second; }
}
