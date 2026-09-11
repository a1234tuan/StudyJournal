package com.noteproject.study408;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.BufferedReader;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

@CapacitorPlugin(name = "NativeAi")
public class NativeAiPlugin extends Plugin {
    /** In-flight chat requests, keyed by the renderer-supplied request id, so a
     * cancelled generation stops the paid request instead of running to completion. */
    private final Map<String, HttpURLConnection> activeConnections = new ConcurrentHashMap<>();
    private final Map<String, java.util.concurrent.atomic.AtomicBoolean> streamRequests = new ConcurrentHashMap<>();

    @PluginMethod
    public void stream(PluginCall call) {
        String requestId = call.getString("requestId", "");
        String apiKey = call.getString("apiKey", "").trim();
        String baseUrl = call.getString("baseUrl", "");
        String model = call.getString("model", "");
        if (requestId.isEmpty() || apiKey.isEmpty() || baseUrl.isEmpty() || model.isEmpty()) { call.reject("语音 AI 配置不完整", "CONFIGURATION"); return; }
        java.util.concurrent.atomic.AtomicBoolean cancelled = new java.util.concurrent.atomic.AtomicBoolean();
        if (streamRequests.putIfAbsent(requestId, cancelled) != null) { call.reject("重复请求", "CONFIGURATION"); return; }
        execute(() -> {
            HttpURLConnection connection = null;
            try {
                if (cancelled.get()) throw new java.io.IOException("cancelled");
                JSONObject payload = new JSONObject();
                payload.put("model", model);
                payload.put("messages", new JSONArray(call.getString("messagesJson", "[]")));
                payload.put("temperature", call.getDouble("temperature", 0.7));
                payload.put("max_tokens", Math.min(call.getInt("maxTokens", 320), 320));
                payload.put("thinking", new JSONObject().put("type", "disabled"));
                payload.put("stream", true);
                payload.put("stream_options", new JSONObject().put("include_usage", true));
                connection = openConnection(normalizeChatUrl(baseUrl), call.getInt("timeoutMs", 20000));
                activeConnections.put(requestId, connection);
                if (cancelled.get()) throw new java.io.IOException("cancelled");
                connection.setRequestProperty("Authorization", "Bearer " + apiKey.replaceFirst("(?i)^Bearer\\s+", ""));
                connection.setRequestProperty("Accept", "text/event-stream");
                connection.setRequestProperty("Content-Type", "application/json; charset=utf-8");
                connection.setDoOutput(true);
                try (OutputStream output = connection.getOutputStream()) { output.write(payload.toString().getBytes(StandardCharsets.UTF_8)); }
                int status = connection.getResponseCode();
                if (status < 200 || status >= 300) { call.reject("语音 AI 请求失败", "HTTP_" + status); return; }
                boolean completed = false;
                StringBuilder data = new StringBuilder();
                try (BufferedReader reader = new BufferedReader(new InputStreamReader(connection.getInputStream(), StandardCharsets.UTF_8))) {
                    String line;
                    while (!cancelled.get() && (line = reader.readLine()) != null) {
                        if (line.isEmpty()) {
                            if (data.length() == 0) continue;
                            String event = data.toString().trim();
                            data.setLength(0);
                            if (event.equals("[DONE]")) { completed = true; break; }
                            JSONObject json = new JSONObject(event);
                            JSONArray choices = json.optJSONArray("choices");
                            JSONObject choice = choices == null ? null : choices.optJSONObject(0);
                            JSONObject delta = choice == null ? null : choice.optJSONObject("delta");
                            if (delta != null && !delta.isNull("content")) {
                                String text = delta.optString("content", "");
                                if (!text.isEmpty()) { JSObject token = new JSObject(); token.put("requestId", requestId); token.put("type", "token"); token.put("text", text); notifyListeners("voiceAiEvent", token); }
                            }
                            JSONObject usage = json.optJSONObject("usage");
                            if (usage != null) {
                                JSObject metering = new JSObject(); metering.put("requestId", requestId); metering.put("type", "usage");
                                if (!usage.isNull("prompt_tokens")) metering.put("inputTokens", usage.optInt("prompt_tokens"));
                                if (!usage.isNull("completion_tokens")) metering.put("outputTokens", usage.optInt("completion_tokens"));
                                notifyListeners("voiceAiEvent", metering);
                            }
                        } else if (line.startsWith("data:")) { if (data.length() > 0) data.append("\n"); data.append(line.substring(5).trim()); }
                        if (data.length() > 1048576) throw new java.io.IOException("event too large");
                    }
                }
                if (cancelled.get() || !completed) throw new java.io.IOException("incomplete stream");
                JSObject done = new JSObject(); done.put("requestId", requestId); done.put("type", "completed"); notifyListeners("voiceAiEvent", done);
                call.resolve();
            } catch (Exception error) {
                call.reject("语音 AI 流未完成", cancelled.get() ? "CANCELLED" : error instanceof java.net.SocketTimeoutException ? "TIMEOUT" : "RESPONSE", error);
            } finally {
                streamRequests.remove(requestId);
                activeConnections.remove(requestId);
                if (connection != null) connection.disconnect();
            }
        });
    }

    @PluginMethod
    public void chat(PluginCall call) {
        String baseUrl = call.getString("baseUrl", "");
        String apiKey = call.getString("apiKey", "");
        String model = call.getString("model", "");
        String messagesJson = call.getString("messagesJson", "[]");
        double temperature = call.getDouble("temperature", 0.7);
        int maxTokens = call.getInt("maxTokens", 4096);
        boolean structuredOutput = Boolean.TRUE.equals(call.getBoolean("structuredOutput", false));
        String thinkingMode = call.getString("thinkingMode", "");
        String reasoningEffort = call.getString("reasoningEffort", "");
        int timeoutMs = call.getInt("timeoutMs", 120000);
        String cancellationId = call.getString("requestId", "").trim();

        if (baseUrl.trim().isEmpty() || apiKey.trim().isEmpty() || model.trim().isEmpty()) {
            call.reject("AI 接口配置不完整。", "CONFIGURATION");
            return;
        }

        execute(() -> {
            HttpURLConnection connection = null;
            try {
                JSONArray messages = new JSONArray(messagesJson);
                JSONObject payload = new JSONObject();
                payload.put("model", model);
                payload.put("messages", messages);
                payload.put("temperature", temperature);
                payload.put("max_tokens", maxTokens);
                if (structuredOutput) {
                    payload.put("response_format", new JSONObject().put("type", "json_object"));
                }
                if (!thinkingMode.trim().isEmpty()) {
                    payload.put("thinking", new JSONObject().put("type", thinkingMode.trim()));
                }
                if (!reasoningEffort.trim().isEmpty()) {
                    payload.put("reasoning_effort", reasoningEffort.trim());
                }

                String requestUrl = normalizeChatUrl(baseUrl);
                connection = openConnection(requestUrl, timeoutMs);
                if (!cancellationId.isEmpty()) {
                    activeConnections.put(cancellationId, connection);
                }
                connection.setRequestProperty("Authorization", "Bearer " + apiKey);
                connection.setRequestProperty("Content-Type", "application/json; charset=utf-8");
                connection.setDoOutput(true);

                try (OutputStream output = connection.getOutputStream()) {
                    output.write(payload.toString().getBytes(StandardCharsets.UTF_8));
                }

                String body = readResponse(connection);
                int code = connection.getResponseCode();
                String contentType = connection.getContentType() != null ? connection.getContentType() : "";
                if (code < 200 || code >= 300) {
                    JSObject details = new JSObject();
                    details.put("retryAfter", connection.getHeaderField("Retry-After"));
                    call.reject("AI 接口请求失败。", "HTTP_" + code, details);
                    return;
                }

                JSONObject json = parseJsonBody(body, contentType, code, requestUrl);
                JSONArray choices = json.optJSONArray("choices");
                if (choices == null || choices.length() == 0) {
                    call.reject("AI 接口返回为空，或不是 OpenAI 兼容格式。", "RESPONSE");
                    return;
                }
                JSONObject first = choices.optJSONObject(0);
                JSONObject message = first != null ? first.optJSONObject("message") : null;
                String content = message != null && !message.isNull("content")
                    ? message.optString("content", "")
                    : first != null && !first.isNull("text") ? first.optString("text", "") : "";

                JSObject result = new JSObject();
                result.put("content", content.trim());
                if (first != null && !first.isNull("finish_reason")) {
                    result.put("finishReason", first.optString("finish_reason", ""));
                }
                JSONObject usage = json.optJSONObject("usage");
                if (usage != null) {
                    JSObject usageResult = new JSObject();
                    putOptionalInt(usageResult, "promptTokens", usage, "prompt_tokens");
                    putOptionalInt(usageResult, "completionTokens", usage, "completion_tokens");
                    putOptionalInt(usageResult, "totalTokens", usage, "total_tokens");
                    putOptionalInt(usageResult, "reasoningTokens", usage, "reasoning_tokens");
                    putOptionalInt(usageResult, "cachedPromptTokens", usage, "prompt_cache_hit_tokens");
                    JSONObject completionDetails = usage.optJSONObject("completion_tokens_details");
                    if (completionDetails != null && completionDetails.has("reasoning_tokens")) {
                        usageResult.put("reasoningTokens", completionDetails.optInt("reasoning_tokens"));
                    }
                    JSONObject promptDetails = usage.optJSONObject("prompt_tokens_details");
                    if (promptDetails != null && promptDetails.has("cached_tokens")) {
                        usageResult.put("cachedPromptTokens", promptDetails.optInt("cached_tokens"));
                    }
                    result.put("usage", usageResult);
                }
                String requestId = connection.getHeaderField("x-request-id");
                if (requestId == null || requestId.trim().isEmpty()) requestId = connection.getHeaderField("request-id");
                if ((requestId == null || requestId.trim().isEmpty()) && !json.isNull("id")) requestId = json.optString("id", "");
                if (requestId != null && !requestId.trim().isEmpty()) result.put("requestId", requestId.trim());
                call.resolve(result);
            } catch (Exception error) {
                call.reject("AI 请求失败。", error instanceof java.net.SocketTimeoutException ? "TIMEOUT" : error instanceof java.io.IOException ? "NETWORK" : "RESPONSE", error);
            } finally {
                if (!cancellationId.isEmpty()) {
                    activeConnections.remove(cancellationId);
                }
            }
        });
    }

    @PluginMethod
    public void cancel(PluginCall call) {
        String requestId = call.getString("requestId", "").trim();
        java.util.concurrent.atomic.AtomicBoolean pending = streamRequests.get(requestId);
        if (pending != null) pending.set(true);
        JSObject result = new JSObject();
        HttpURLConnection connection = requestId.isEmpty() ? null : activeConnections.remove(requestId);
        if (connection == null) {
            result.put("cancelled", false);
            call.resolve(result);
            return;
        }
        try {
            connection.disconnect();
        } catch (Exception ignored) {
            // The request may already have completed; cancelling is best-effort.
        }
        result.put("cancelled", true);
        call.resolve(result);
    }

    private String normalizeChatUrl(String baseUrl) {
        String trimmed = baseUrl.trim();
        while (trimmed.endsWith("/")) {
            trimmed = trimmed.substring(0, trimmed.length() - 1);
        }
        if (trimmed.endsWith("/chat/completions")) {
            return trimmed;
        }
        return trimmed + "/chat/completions";
    }

    private JSONObject parseJsonBody(String body, String contentType, int code, String requestUrl) throws JSONException {
        try {
            return new JSONObject(body);
        } catch (JSONException error) {
            String hint = isLikelyHtmlResponse(body, contentType)
                ? "接口返回的是 HTML 页面，Base URL 可能缺少 /v1 或填成了网页入口。"
                : "接口返回的不是 JSON。";
            throw new JSONException(
                "AI 接口返回的不是 OpenAI 兼容 JSON，可能 Base URL 路径错误。"
                    + formatResponseMeta(code, contentType, requestUrl)
                    + "，" + hint
                    + "响应片段：" + responseSnippet(body)
            );
        }
    }

    private String extractErrorMessage(String body, String contentType, String requestUrl) {
        try {
            JSONObject json = new JSONObject(body);
            JSONObject error = json.optJSONObject("error");
            String message = error != null ? error.optString("message", "") : json.optString("message", "");
            if (!message.trim().isEmpty()) {
                return message.trim();
            }
        } catch (JSONException ignored) {
            // Fall through to a compact response summary below.
        }

        if (isLikelyHtmlResponse(body, contentType)) {
            return "接口返回的是 HTML 页面，Base URL 可能缺少 /v1 或填成了网页入口。请求地址：" + requestUrl + "，响应片段：" + responseSnippet(body);
        }
        return responseSnippet(body);
    }

    private String formatResponseMeta(int code, String contentType, String requestUrl) {
        String meta = "HTTP " + code;
        if (contentType != null && !contentType.trim().isEmpty()) {
            meta += "，Content-Type：" + contentType.trim();
        }
        return meta + "，请求地址：" + requestUrl;
    }

    private boolean isLikelyHtmlResponse(String body, String contentType) {
        String lowerContentType = contentType != null ? contentType.toLowerCase() : "";
        String trimmed = body != null ? body.trim().toLowerCase() : "";
        return lowerContentType.contains("text/html") || trimmed.startsWith("<!doctype") || trimmed.startsWith("<html");
    }

    private String responseSnippet(String body) {
        if (body == null || body.trim().isEmpty()) {
            return "响应体为空。";
        }
        String compact = body.replaceAll("\\s+", " ").trim();
        return compact.length() > 180 ? compact.substring(0, 180) + "..." : compact;
    }

    private void putOptionalInt(JSObject target, String targetName, JSONObject source, String sourceName) throws JSONException {
        if (source.has(sourceName) && !source.isNull(sourceName)) target.put(targetName, source.getInt(sourceName));
    }

    private HttpURLConnection openConnection(String url, int timeoutMs) throws Exception {
        HttpURLConnection connection = (HttpURLConnection) new URL(url).openConnection();
        connection.setRequestMethod("POST");
        connection.setConnectTimeout(30000);
        connection.setReadTimeout(Math.max(30000, timeoutMs));
        return connection;
    }

    private String readResponse(HttpURLConnection connection) throws Exception {
        InputStream input = connection.getResponseCode() >= 400 ? connection.getErrorStream() : connection.getInputStream();
        if (input == null) {
            return "";
        }
        try (BufferedReader reader = new BufferedReader(new InputStreamReader(input, StandardCharsets.UTF_8))) {
            StringBuilder builder = new StringBuilder();
            String line;
            while ((line = reader.readLine()) != null) {
                builder.append(line).append("\n");
            }
            return builder.toString().trim();
        }
    }
}
