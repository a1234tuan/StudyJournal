package com.noteproject.study408;

import android.app.Activity;
import android.content.Intent;
import android.content.SharedPreferences;
import android.net.Uri;
import android.provider.DocumentsContract;
import android.util.Base64;
import androidx.activity.result.ActivityResult;
import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;
import java.util.zip.Deflater;
import java.util.zip.ZipEntry;
import java.util.zip.ZipOutputStream;

@CapacitorPlugin(name = "NativeAutoBackup")
public class NativeAutoBackupPlugin extends Plugin {
    private static final String PREFS = "native_auto_backup";
    private static final String KEY_TREE_URI = "tree_uri";
    private static final String KEY_FOLDER_NAME = "folder_name";
    private static final String KEY_BINDING_GENERATION = "binding_generation";
    private static final String LATEST_FILE_NAME = "study-journal-latest.zip";
    private final Map<String, WriteSession> writeSessions = new ConcurrentHashMap<>();
    private final Map<String, ZipWriteSession> zipWriteSessions = new ConcurrentHashMap<>();

    private static class VerifiedFile {
        final Uri uri;
        final String displayName;
        final long size;
        final long lastModified;
        final boolean exactName;

        VerifiedFile(Uri uri, String displayName, long size, long lastModified, boolean exactName) {
            this.uri = uri;
            this.displayName = displayName;
            this.size = size;
            this.lastModified = lastModified;
            this.exactName = exactName;
        }
    }

    private static class WriteSession {
        final Uri uri;
        final OutputStream output;
        final String path;
        final String displayName;
        long size;
        String bindingGeneration;

        WriteSession(Uri uri, OutputStream output) {
            this(uri, output, "", LATEST_FILE_NAME);
        }

        WriteSession(Uri uri, OutputStream output, String path, String displayName) {
            this.uri = uri;
            this.output = output;
            this.path = path;
            this.displayName = displayName;
            this.size = 0;
        }
    }

    private static class RepositoryDocument {
        final Uri uri;
        final String documentId;
        final String displayName;
        final String mimeType;
        final long size;
        final long lastModified;

        RepositoryDocument(Uri uri, String documentId, String displayName, String mimeType, long size, long lastModified) {
            this.uri = uri;
            this.documentId = documentId;
            this.displayName = displayName;
            this.mimeType = mimeType;
            this.size = size;
            this.lastModified = lastModified;
        }
    }

    private static class CountingOutputStream extends OutputStream {
        final OutputStream output;
        long size;

        CountingOutputStream(OutputStream output) {
            this.output = output;
            this.size = 0;
        }

        @Override
        public void write(int b) throws IOException {
            output.write(b);
            size += 1;
        }

        @Override
        public void write(byte[] b, int off, int len) throws IOException {
            output.write(b, off, len);
            size += len;
        }

        @Override
        public void flush() throws IOException {
            output.flush();
        }

        @Override
        public void close() throws IOException {
            output.close();
        }
    }

    private static class ZipWriteSession {
        final Uri uri;
        final CountingOutputStream output;
        final ZipOutputStream zip;

        ZipWriteSession(Uri uri, CountingOutputStream output, ZipOutputStream zip) {
            this.uri = uri;
            this.output = output;
            this.zip = zip;
        }
    }

    @PluginMethod
    public void bindFolder(PluginCall call) {
        Intent intent = new Intent(Intent.ACTION_OPEN_DOCUMENT_TREE);
        intent.addFlags(
            Intent.FLAG_GRANT_READ_URI_PERMISSION |
            Intent.FLAG_GRANT_WRITE_URI_PERMISSION |
            Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION |
            Intent.FLAG_GRANT_PREFIX_URI_PERMISSION
        );
        startActivityForResult(call, intent, "folderPicked");
    }

    @ActivityCallback
    private void folderPicked(PluginCall call, ActivityResult result) {
        if (call == null) {
            return;
        }
        if (result.getResultCode() != Activity.RESULT_OK || result.getData() == null || result.getData().getData() == null) {
            call.reject("未选择备份文件夹。");
            return;
        }

        Uri treeUri = result.getData().getData();
        int flags = result.getData().getFlags() &
            (Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_GRANT_WRITE_URI_PERMISSION);
        getContext().getContentResolver().takePersistableUriPermission(treeUri, flags);

        String folderName = displayName(treeUri);
        prefs().edit()
            .putString(KEY_TREE_URI, treeUri.toString())
            .putString(KEY_FOLDER_NAME, folderName)
            .putString(KEY_BINDING_GENERATION, UUID.randomUUID().toString())
            .apply();

        JSObject response = new JSObject();
        response.put("folderName", folderName);
        call.resolve(response);
    }

    @PluginMethod
    public void isBound(PluginCall call) {
        String treeUri = prefs().getString(KEY_TREE_URI, null);
        JSObject response = new JSObject();
        response.put("bound", treeUri != null);
        response.put("folderName", prefs().getString(KEY_FOLDER_NAME, null));
        call.resolve(response);
    }

    @PluginMethod
    public void diagnoseFolder(PluginCall call) {
        String treeUriText = prefs().getString(KEY_TREE_URI, null);
        int limit = call.getInt("limit", 20);
        if (treeUriText == null) {
            call.reject("尚未绑定自动备份文件夹。");
            return;
        }

        execute(() -> {
            try {
                Uri documentUri = documentUriForTree(Uri.parse(treeUriText));
                JSObject response = new JSObject();
                response.put("folderName", prefs().getString(KEY_FOLDER_NAME, null));
                response.put("files", folderDiagnostics(documentUri, limit));
                call.resolve(response);
            } catch (Exception error) {
                call.reject(error.getMessage() != null ? error.getMessage() : "读取自动备份文件夹诊断信息失败。", error);
            }
        });
    }

    @PluginMethod
    public void writeLatest(PluginCall call) {
        String data = call.getString("data");
        String mimeType = call.getString("mimeType", "application/zip");
        String treeUriText = prefs().getString(KEY_TREE_URI, null);
        if (treeUriText == null) {
            call.reject("尚未绑定自动备份文件夹。");
            return;
        }
        if (data == null || data.isEmpty()) {
            call.reject("备份数据为空。");
            return;
        }

        execute(() -> {
            try {
                byte[] bytes = Base64.decode(data, Base64.DEFAULT);
                Uri treeUri = Uri.parse(treeUriText);
                Uri documentUri = DocumentsContract.buildDocumentUriUsingTree(
                    treeUri,
                    DocumentsContract.getTreeDocumentId(treeUri)
                );
                Uri fileUri = findOrCreateFile(documentUri, mimeType);
                try (OutputStream output = getContext().getContentResolver().openOutputStream(fileUri, "wt")) {
                    if (output == null) {
                        throw new IllegalStateException("无法打开备份文件写入流。");
                    }
                    output.write(bytes);
                }

                JSObject response = new JSObject();
                response.put("folderName", prefs().getString(KEY_FOLDER_NAME, null));
                response.put("size", bytes.length);
                response.put("uri", fileUri.toString());
                call.resolve(response);
            } catch (Exception error) {
                call.reject(error.getMessage() != null ? error.getMessage() : "写入自动备份失败。", error);
            }
        });
    }

    @PluginMethod
    public void beginWriteLatest(PluginCall call) {
        String mimeType = call.getString("mimeType", "application/zip");
        String treeUriText = prefs().getString(KEY_TREE_URI, null);
        if (treeUriText == null) {
            call.reject("尚未绑定自动备份文件夹。");
            return;
        }

        execute(() -> {
            try {
                Uri treeUri = Uri.parse(treeUriText);
                Uri documentUri = DocumentsContract.buildDocumentUriUsingTree(
                    treeUri,
                    DocumentsContract.getTreeDocumentId(treeUri)
                );
                Uri fileUri = findOrCreateFile(documentUri, mimeType);
                OutputStream output = getContext().getContentResolver().openOutputStream(fileUri, "wt");
                if (output == null) {
                    throw new IllegalStateException("无法打开备份文件写入流。");
                }

                String sessionId = UUID.randomUUID().toString();
                writeSessions.put(sessionId, new WriteSession(fileUri, output));

                JSObject response = new JSObject();
                response.put("sessionId", sessionId);
                response.put("folderName", prefs().getString(KEY_FOLDER_NAME, null));
                response.put("uri", fileUri.toString());
                call.resolve(response);
            } catch (Exception error) {
                call.reject(error.getMessage() != null ? error.getMessage() : "开始自动备份写入失败。", error);
            }
        });
    }

    @PluginMethod
    public void appendWriteLatest(PluginCall call) {
        String sessionId = call.getString("sessionId");
        String data = call.getString("data");
        if (sessionId == null || sessionId.isEmpty()) {
            call.reject("缺少自动备份写入会话。");
            return;
        }
        if (data == null) {
            call.reject("备份数据为空。");
            return;
        }

        WriteSession session = writeSessions.get(sessionId);
        if (session == null) {
            call.reject("自动备份写入会话已失效。");
            return;
        }

        execute(() -> {
            try {
                if (session.bindingGeneration != null && !session.bindingGeneration.equals(prefs().getString(KEY_BINDING_GENERATION, "legacy"))) throw new IllegalStateException("备份文件夹绑定已变化，请重新备份。");
                byte[] bytes = Base64.decode(data, Base64.DEFAULT);
                session.output.write(bytes);
                session.size += bytes.length;

                JSObject response = new JSObject();
                response.put("size", session.size);
                call.resolve(response);
            } catch (Exception error) {
                writeSessions.remove(sessionId);
                closeQuietly(session.output);
                call.reject(error.getMessage() != null ? error.getMessage() : "写入自动备份分块失败。", error);
            }
        });
    }

    @PluginMethod
    public void finishWriteLatest(PluginCall call) {
        String sessionId = call.getString("sessionId");
        if (sessionId == null || sessionId.isEmpty()) {
            call.reject("缺少自动备份写入会话。");
            return;
        }

        WriteSession session = writeSessions.remove(sessionId);
        if (session == null) {
            call.reject("自动备份写入会话已失效。");
            return;
        }

        execute(() -> {
            try {
                session.output.flush();
                session.output.close();

                JSObject response = new JSObject();
                response.put("folderName", prefs().getString(KEY_FOLDER_NAME, null));
                response.put("size", session.size);
                response.put("uri", session.uri.toString());
                call.resolve(response);
            } catch (Exception error) {
                closeQuietly(session.output);
                call.reject(error.getMessage() != null ? error.getMessage() : "完成自动备份写入失败。", error);
            }
        });
    }

    @PluginMethod
    public void cancelWriteLatest(PluginCall call) {
        String sessionId = call.getString("sessionId");
        if (sessionId == null || sessionId.isEmpty()) {
            call.resolve();
            return;
        }

        WriteSession session = writeSessions.remove(sessionId);
        if (session == null) {
            call.resolve();
            return;
        }

        execute(() -> {
            closeQuietly(session.output);
            call.resolve();
        });
    }

    @PluginMethod
    public void beginZipLatest(PluginCall call) {
        String mimeType = call.getString("mimeType", "application/zip");
        String fileName = safeFileName(call.getString("fileName", LATEST_FILE_NAME));
        String treeUriText = prefs().getString(KEY_TREE_URI, null);
        if (treeUriText == null) {
            call.reject("尚未绑定自动备份文件夹。");
            return;
        }

        execute(() -> {
            try {
                Uri treeUri = Uri.parse(treeUriText);
                Uri documentUri = DocumentsContract.buildDocumentUriUsingTree(
                    treeUri,
                    DocumentsContract.getTreeDocumentId(treeUri)
                );
                Uri fileUri = findOrCreateFile(documentUri, mimeType, fileName);
                OutputStream rawOutput = getContext().getContentResolver().openOutputStream(fileUri, "wt");
                if (rawOutput == null) {
                    throw new IllegalStateException("无法打开自动备份 zip 写入流。");
                }
                CountingOutputStream countedOutput = new CountingOutputStream(rawOutput);
                ZipOutputStream zip = new ZipOutputStream(countedOutput);
                zip.setLevel(Deflater.NO_COMPRESSION);

                String sessionId = UUID.randomUUID().toString();
                zipWriteSessions.put(sessionId, new ZipWriteSession(fileUri, countedOutput, zip));

                JSObject response = new JSObject();
                response.put("sessionId", sessionId);
                response.put("folderName", prefs().getString(KEY_FOLDER_NAME, null));
                response.put("uri", fileUri.toString());
                call.resolve(response);
            } catch (Exception error) {
                call.reject(error.getMessage() != null ? error.getMessage() : "开始自动备份 zip 写入失败。", error);
            }
        });
    }

    @PluginMethod
    public void beginZipEntry(PluginCall call) {
        ZipWriteSession session = zipWriteSession(call);
        if (session == null) {
            return;
        }
        String path = call.getString("path");
        if (path == null || path.isEmpty()) {
            call.reject("缺少自动备份 zip entry 路径。");
            return;
        }

        execute(() -> {
            try {
                session.zip.putNextEntry(new ZipEntry(path));
                call.resolve();
            } catch (Exception error) {
                call.reject(error.getMessage() != null ? error.getMessage() : "开始写入自动备份 zip entry 失败。", error);
            }
        });
    }

    @PluginMethod
    public void appendZipEntry(PluginCall call) {
        ZipWriteSession session = zipWriteSession(call);
        if (session == null) {
            return;
        }
        String data = call.getString("data");
        if (data == null) {
            call.reject("自动备份 zip entry 数据为空。");
            return;
        }

        execute(() -> {
            try {
                byte[] bytes = Base64.decode(data, Base64.DEFAULT);
                session.zip.write(bytes);
                call.resolve();
            } catch (Exception error) {
                zipWriteSessions.remove(call.getString("sessionId"));
                closeQuietly(session.zip);
                call.reject(error.getMessage() != null ? error.getMessage() : "写入自动备份 zip entry 分块失败。", error);
            }
        });
    }

    @PluginMethod
    public void finishZipEntry(PluginCall call) {
        ZipWriteSession session = zipWriteSession(call);
        if (session == null) {
            return;
        }

        execute(() -> {
            try {
                session.zip.closeEntry();
                call.resolve();
            } catch (Exception error) {
                call.reject(error.getMessage() != null ? error.getMessage() : "完成自动备份 zip entry 失败。", error);
            }
        });
    }

    @PluginMethod
    public void finishZipLatest(PluginCall call) {
        String sessionId = call.getString("sessionId");
        if (sessionId == null || sessionId.isEmpty()) {
            call.reject("缺少自动备份 zip 写入会话。");
            return;
        }

        ZipWriteSession session = zipWriteSessions.remove(sessionId);
        if (session == null) {
            call.reject("自动备份 zip 写入会话已失效。");
            return;
        }

        execute(() -> {
            try {
                session.zip.finish();
                session.zip.close();
                if (session.output.size <= 0) {
                    throw new IllegalStateException("自动备份写入结果为空。");
                }
                String treeUriText = prefs().getString(KEY_TREE_URI, null);
                if (treeUriText == null) {
                    throw new IllegalStateException("尚未绑定自动备份文件夹。");
                }
                Uri documentUri = documentUriForTree(Uri.parse(treeUriText));
                VerifiedFile verified = verifyLatestFile(documentUri, session.uri);

                JSObject response = new JSObject();
                response.put("folderName", prefs().getString(KEY_FOLDER_NAME, null));
                response.put("size", verified.size);
                response.put("uri", verified.uri.toString());
                response.put("displayName", verified.displayName);
                response.put("lastModified", verified.lastModified);
                response.put("verifiedAt", System.currentTimeMillis());
                if (!verified.exactName) {
                    response.put("warning", "系统文件提供器返回的实际文件名不是 " + LATEST_FILE_NAME + "，请在备份文件夹中查找：" + verified.displayName);
                }
                call.resolve(response);
            } catch (Exception error) {
                closeQuietly(session.zip);
                call.reject(error.getMessage() != null ? error.getMessage() : "完成自动备份 zip 写入失败。", error);
            }
        });
    }

    @PluginMethod
    public void cancelZipLatest(PluginCall call) {
        String sessionId = call.getString("sessionId");
        if (sessionId == null || sessionId.isEmpty()) {
            call.resolve();
            return;
        }

        ZipWriteSession session = zipWriteSessions.remove(sessionId);
        if (session == null) {
            call.resolve();
            return;
        }

        execute(() -> {
            closeQuietly(session.zip);
            call.resolve();
        });
    }

    @PluginMethod
    public void ensureRepository(PluginCall call) {
        String repositoryName = safePathSegment(call.getString("repositoryName", "study-journal-backup"));
        String treeUriText = prefs().getString(KEY_TREE_URI, null);
        if (treeUriText == null) {
            call.reject("尚未绑定自动备份文件夹。");
            return;
        }

        execute(() -> {
            try {
                Uri repositoryUri = resolveRepositoryRoot(Uri.parse(treeUriText), repositoryName, true);
                RepositoryDocument repository = readDocument(repositoryUri);

                JSObject response = new JSObject();
                response.put("folderName", prefs().getString(KEY_FOLDER_NAME, null));
                response.put("repositoryName", repository.displayName != null ? repository.displayName : repositoryName);
                call.resolve(response);
            } catch (Exception error) {
                call.reject(error.getMessage() != null ? error.getMessage() : "创建自动备份仓库失败。", error);
            }
        });
    }

    @PluginMethod
    public void listRepositoryFiles(PluginCall call) {
        String repositoryName = safePathSegment(call.getString("repositoryName", "study-journal-backup"));
        String directory = call.getString("directory", "");
        String treeUriText = prefs().getString(KEY_TREE_URI, null);
        if (treeUriText == null) {
            call.reject("尚未绑定自动备份文件夹。");
            return;
        }

        execute(() -> {
            try {
                Uri directoryUri = resolveRepositoryDirectory(Uri.parse(treeUriText), repositoryName, directory, false);
                JSArray files = directoryUri == null ? new JSArray() : listRepositoryDocuments(directoryUri, directory);
                JSObject response = new JSObject();
                response.put("files", files);
                call.resolve(response);
            } catch (Exception error) {
                call.reject(error.getMessage() != null ? error.getMessage() : "读取自动备份仓库目录失败。", error);
            }
        });
    }

    @PluginMethod
    public void beginRepositoryFileWrite(PluginCall call) {
        String repositoryName = safePathSegment(call.getString("repositoryName", "study-journal-backup"));
        String path = normalizeRepositoryPath(call.getString("path", ""));
        String mimeType = call.getString("mimeType", mimeTypeForPath(path));
        String bindingGeneration = prefs().getString(KEY_BINDING_GENERATION, "legacy");
        String treeUriText = prefs().getString(KEY_TREE_URI, null);
        if (treeUriText == null) {
            call.reject("尚未绑定自动备份文件夹。");
            return;
        }
        if (path.isEmpty()) {
            call.reject("缺少自动备份仓库文件路径。");
            return;
        }

        execute(() -> {
            try {
                Uri treeUri = Uri.parse(treeUriText);
                if (!bindingGeneration.equals(prefs().getString(KEY_BINDING_GENERATION, "legacy")) || !treeUriText.equals(prefs().getString(KEY_TREE_URI, null))) throw new IllegalStateException("备份文件夹绑定已变化，请重新备份。");
                Uri fileUri = findOrCreateRepositoryFile(treeUri, repositoryName, path, mimeType);
                OutputStream output = getContext().getContentResolver().openOutputStream(fileUri, "wt");
                if (output == null) {
                    throw new IllegalStateException("无法打开自动备份仓库文件写入流。");
                }

                String sessionId = UUID.randomUUID().toString();
                WriteSession session = new WriteSession(fileUri, output, path, lastPathSegment(path));
                session.bindingGeneration = bindingGeneration;
                if (!bindingGeneration.equals(prefs().getString(KEY_BINDING_GENERATION, "legacy")) || !treeUriText.equals(prefs().getString(KEY_TREE_URI, null))) { closeQuietly(output); throw new IllegalStateException("备份文件夹绑定已变化，请重新备份。"); }
                writeSessions.put(sessionId, session);

                JSObject response = new JSObject();
                response.put("sessionId", sessionId);
                response.put("path", path);
                response.put("uri", fileUri.toString());
                call.resolve(response);
            } catch (Exception error) {
                call.reject(error.getMessage() != null ? error.getMessage() : "开始写入自动备份仓库文件失败。", error);
            }
        });
    }

    @PluginMethod
    public void appendRepositoryFileWrite(PluginCall call) {
        appendWriteLatest(call);
    }

    @PluginMethod
    public void finishRepositoryFileWrite(PluginCall call) {
        String sessionId = call.getString("sessionId");
        if (sessionId == null || sessionId.isEmpty()) {
            call.reject("缺少自动备份仓库写入会话。");
            return;
        }

        WriteSession session = writeSessions.remove(sessionId);
        if (session == null) {
            call.reject("自动备份仓库写入会话已失效。");
            return;
        }

        execute(() -> {
            try {
                if (session.bindingGeneration != null && !session.bindingGeneration.equals(prefs().getString(KEY_BINDING_GENERATION, "legacy"))) throw new IllegalStateException("备份文件夹绑定已变化，请重新备份。");
                session.output.flush();
                session.output.close();
                RepositoryDocument document = readDocument(session.uri);
                long size = document.size >= 0 ? document.size : session.size;
                if (size < 0) {
                    throw new IllegalStateException("无法验证自动备份仓库文件大小：" + session.path);
                }

                JSObject response = new JSObject();
                response.put("path", session.path);
                response.put("displayName", document.displayName != null ? document.displayName : session.displayName);
                response.put("size", size);
                response.put("uri", session.uri.toString());
                response.put("lastModified", document.lastModified);
                call.resolve(response);
            } catch (Exception error) {
                closeQuietly(session.output);
                call.reject(error.getMessage() != null ? error.getMessage() : "完成自动备份仓库文件写入失败。", error);
            }
        });
    }

    @PluginMethod
    public void cancelRepositoryFileWrite(PluginCall call) {
        cancelWriteLatest(call);
    }

    @PluginMethod
    public void readRepositoryTextFile(PluginCall call) {
        String repositoryName = safePathSegment(call.getString("repositoryName", "study-journal-backup"));
        String path = normalizeRepositoryPath(call.getString("path", ""));
        String treeUriText = prefs().getString(KEY_TREE_URI, null);
        if (treeUriText == null) {
            call.reject("尚未绑定自动备份文件夹。");
            return;
        }
        if (path.isEmpty()) {
            call.reject("缺少自动备份仓库文件路径。");
            return;
        }

        execute(() -> {
            try {
                Uri fileUri = resolveRepositoryFile(Uri.parse(treeUriText), repositoryName, path, true);
                byte[] bytes = readAllBytes(fileUri);
                JSObject response = new JSObject();
                response.put("text", new String(bytes, StandardCharsets.UTF_8));
                response.put("size", bytes.length);
                call.resolve(response);
            } catch (Exception error) {
                call.reject(error.getMessage() != null ? error.getMessage() : "读取自动备份仓库文本失败。", error);
            }
        });
    }

    @PluginMethod
    public void readRepositoryFileChunk(PluginCall call) {
        String repositoryName = safePathSegment(call.getString("repositoryName", "study-journal-backup"));
        String path = normalizeRepositoryPath(call.getString("path", ""));
        int offset = call.getInt("offset", 0);
        int length = call.getInt("length", 768 * 1024);
        String treeUriText = prefs().getString(KEY_TREE_URI, null);
        if (treeUriText == null) {
            call.reject("尚未绑定自动备份文件夹。");
            return;
        }
        if (path.isEmpty()) {
            call.reject("缺少自动备份仓库文件路径。");
            return;
        }

        execute(() -> {
            try {
                Uri fileUri = resolveRepositoryFile(Uri.parse(treeUriText), repositoryName, path, true);
                byte[] bytes = readChunk(fileUri, Math.max(0, offset), Math.max(1, Math.min(length, 2 * 1024 * 1024)));
                RepositoryDocument document = readDocument(fileUri);
                long size = document.size;
                boolean done = size >= 0 ? offset + bytes.length >= size : bytes.length == 0;

                JSObject response = new JSObject();
                response.put("data", Base64.encodeToString(bytes, Base64.NO_WRAP));
                response.put("bytesRead", bytes.length);
                response.put("done", done);
                call.resolve(response);
            } catch (Exception error) {
                call.reject(error.getMessage() != null ? error.getMessage() : "读取自动备份仓库文件分块失败。", error);
            }
        });
    }

    @PluginMethod
    public void deleteRepositoryFile(PluginCall call) {
        String repositoryName = safePathSegment(call.getString("repositoryName", "study-journal-backup"));
        String path = normalizeRepositoryPath(call.getString("path", ""));
        String treeUriText = prefs().getString(KEY_TREE_URI, null);
        if (treeUriText == null) {
            call.reject("尚未绑定自动备份文件夹。");
            return;
        }
        if (path.isEmpty()) {
            call.reject("缺少自动备份仓库文件路径。");
            return;
        }

        execute(() -> {
            try {
                Uri fileUri = resolveRepositoryFile(Uri.parse(treeUriText), repositoryName, path, false);
                if (fileUri != null) {
                    DocumentsContract.deleteDocument(getContext().getContentResolver(), fileUri);
                }
                call.resolve();
            } catch (Exception error) {
                call.reject(error.getMessage() != null ? error.getMessage() : "删除自动备份仓库文件失败。", error);
            }
        });
    }

    private ZipWriteSession zipWriteSession(PluginCall call) {
        String sessionId = call.getString("sessionId");
        ZipWriteSession session = zipWriteSessions.get(sessionId);
        if (session == null) {
            call.reject("自动备份 zip 写入会话已失效。");
        }
        return session;
    }

    private Uri boundRootDocumentUri() {
        String treeUriText = prefs().getString(KEY_TREE_URI, null);
        if (treeUriText == null) {
            throw new IllegalStateException("尚未绑定自动备份文件夹。");
        }
        return documentUriForTree(Uri.parse(treeUriText));
    }

    private Uri documentUriForTree(Uri treeUri) {
        return DocumentsContract.buildDocumentUriUsingTree(
            treeUri,
            DocumentsContract.getTreeDocumentId(treeUri)
        );
    }

    private RepositoryDocument findChild(Uri parentUri, String displayName) throws Exception {
        Uri childrenUri = childrenUriForDocument(parentUri);
        try (android.database.Cursor cursor = getContext().getContentResolver().query(
            childrenUri,
            new String[] {
                DocumentsContract.Document.COLUMN_DOCUMENT_ID,
                DocumentsContract.Document.COLUMN_DISPLAY_NAME,
                DocumentsContract.Document.COLUMN_MIME_TYPE,
                DocumentsContract.Document.COLUMN_SIZE,
                DocumentsContract.Document.COLUMN_LAST_MODIFIED
            },
            null,
            null,
            null
        )) {
            if (cursor != null) {
                while (cursor.moveToNext()) {
                    String name = cursor.getString(1);
                    if (displayName.equals(name)) {
                        String documentId = cursor.getString(0);
                        String mimeType = cursor.getString(2);
                        long size = cursor.isNull(3) ? -1 : cursor.getLong(3);
                        long lastModified = cursor.isNull(4) ? 0 : cursor.getLong(4);
                        Uri uri = DocumentsContract.buildDocumentUriUsingTree(parentUri, documentId);
                        return new RepositoryDocument(uri, documentId, name, mimeType, size, lastModified);
                    }
                }
            }
        }
        return null;
    }

    private Uri ensureDirectory(Uri parentUri, String name) throws Exception {
        String safeName = safePathSegment(name);
        RepositoryDocument existing = findChild(parentUri, safeName);
        if (existing != null) {
            if (!DocumentsContract.Document.MIME_TYPE_DIR.equals(existing.mimeType)) {
                throw new IllegalStateException("自动备份仓库路径已存在但不是文件夹：" + safeName);
            }
            return existing.uri;
        }
        Uri created = DocumentsContract.createDocument(
            getContext().getContentResolver(),
            parentUri,
            DocumentsContract.Document.MIME_TYPE_DIR,
            safeName
        );
        if (created == null) {
            throw new IllegalStateException("无法创建自动备份仓库文件夹：" + safeName);
        }
        return created;
    }

    private boolean isDirectoryDocument(RepositoryDocument document) {
        return document != null && DocumentsContract.Document.MIME_TYPE_DIR.equals(document.mimeType);
    }

    private boolean isRepositoryRoot(Uri rootUri, String repositoryName) throws Exception {
        RepositoryDocument root = readDocument(rootUri);
        RepositoryDocument manifest = findChild(rootUri, "manifest.json");
        RepositoryDocument snapshots = findChild(rootUri, "snapshots");
        return BackupRepositoryRootPolicy.matches(root.displayName, repositoryName, isDirectoryDocument(root), manifest != null && !isDirectoryDocument(manifest) && isDirectoryDocument(snapshots));
    }

    private Uri resolveRepositoryRoot(Uri treeUri, String repositoryName, boolean create) throws Exception {
        Uri rootUri = documentUriForTree(treeUri);
        if (isRepositoryRoot(rootUri, repositoryName)) {
            return rootUri;
        }
        return create ? ensureDirectory(rootUri, repositoryName) : childDirectory(rootUri, repositoryName, false);
    }

    private Uri resolveRepositoryDirectory(Uri treeUri, String repositoryName, String directory, boolean create) throws Exception {
        Uri current = resolveRepositoryRoot(treeUri, repositoryName, create);
        if (current == null) {
            return null;
        }

        String normalized = normalizeRepositoryPath(directory);
        if (normalized.isEmpty()) {
            return current;
        }

        for (String segment : normalized.split("/")) {
            if (segment.isEmpty()) {
                continue;
            }
            current = create ? ensureDirectory(current, segment) : childDirectory(current, segment, false);
            if (current == null) {
                return null;
            }
        }
        return current;
    }

    private Uri childDirectory(Uri parentUri, String name, boolean required) throws Exception {
        RepositoryDocument child = findChild(parentUri, safePathSegment(name));
        if (child == null) {
            if (required) {
                throw new IllegalStateException("自动备份仓库缺少文件夹：" + name);
            }
            return null;
        }
        if (!DocumentsContract.Document.MIME_TYPE_DIR.equals(child.mimeType)) {
            throw new IllegalStateException("自动备份仓库路径不是文件夹：" + name);
        }
        return child.uri;
    }

    private Uri findOrCreateRepositoryFile(Uri treeUri, String repositoryName, String path, String mimeType) throws Exception {
        String normalized = normalizeRepositoryPath(path);
        String directory = parentPath(normalized);
        String fileName = lastPathSegment(normalized);
        Uri parentUri = resolveRepositoryDirectory(treeUri, repositoryName, directory, true);
        RepositoryDocument existing = findChild(parentUri, fileName);
        if (existing != null) {
            if (DocumentsContract.Document.MIME_TYPE_DIR.equals(existing.mimeType)) {
                throw new IllegalStateException("自动备份仓库目标路径是文件夹：" + normalized);
            }
            return existing.uri;
        }
        Uri created = DocumentsContract.createDocument(
            getContext().getContentResolver(),
            parentUri,
            mimeType,
            fileName
        );
        if (created == null) {
            throw new IllegalStateException("无法创建自动备份仓库文件：" + normalized);
        }
        return created;
    }

    private Uri resolveRepositoryFile(Uri treeUri, String repositoryName, String path, boolean required) throws Exception {
        String normalized = normalizeRepositoryPath(path);
        String directory = parentPath(normalized);
        String fileName = lastPathSegment(normalized);
        Uri parentUri = resolveRepositoryDirectory(treeUri, repositoryName, directory, false);
        if (parentUri == null) {
            if (required) {
                throw new IllegalStateException("自动备份仓库缺少文件夹：" + directory);
            }
            return null;
        }
        RepositoryDocument document = findChild(parentUri, fileName);
        if (document == null) {
            if (required) {
                throw new IllegalStateException("自动备份仓库缺少文件：" + normalized);
            }
            return null;
        }
        if (DocumentsContract.Document.MIME_TYPE_DIR.equals(document.mimeType)) {
            throw new IllegalStateException("自动备份仓库目标路径是文件夹：" + normalized);
        }
        return document.uri;
    }

    private JSArray listRepositoryDocuments(Uri directoryUri, String directory) throws Exception {
        JSArray files = new JSArray();
        Uri childrenUri = childrenUriForDocument(directoryUri);
        String normalizedDirectory = normalizeRepositoryPath(directory);
        try (android.database.Cursor cursor = getContext().getContentResolver().query(
            childrenUri,
            new String[] {
                DocumentsContract.Document.COLUMN_DISPLAY_NAME,
                DocumentsContract.Document.COLUMN_MIME_TYPE,
                DocumentsContract.Document.COLUMN_SIZE,
                DocumentsContract.Document.COLUMN_LAST_MODIFIED
            },
            null,
            null,
            null
        )) {
            if (cursor != null) {
                while (cursor.moveToNext()) {
                    String name = cursor.getString(0);
                    long size = cursor.isNull(2) ? -1 : cursor.getLong(2);
                    long lastModified = cursor.isNull(3) ? 0 : cursor.getLong(3);
                    JSObject file = new JSObject();
                    file.put("path", normalizedDirectory.isEmpty() ? name : normalizedDirectory + "/" + name);
                    file.put("displayName", name);
                    file.put("size", size);
                    file.put("lastModified", lastModified);
                    files.put(file);
                }
            }
        }
        return files;
    }

    private RepositoryDocument readDocument(Uri documentUri) throws Exception {
        try (android.database.Cursor cursor = getContext().getContentResolver().query(
            documentUri,
            new String[] {
                DocumentsContract.Document.COLUMN_DOCUMENT_ID,
                DocumentsContract.Document.COLUMN_DISPLAY_NAME,
                DocumentsContract.Document.COLUMN_MIME_TYPE,
                DocumentsContract.Document.COLUMN_SIZE,
                DocumentsContract.Document.COLUMN_LAST_MODIFIED
            },
            null,
            null,
            null
        )) {
            if (cursor != null && cursor.moveToFirst()) {
                String documentId = cursor.getString(0);
                String name = cursor.getString(1);
                String mimeType = cursor.getString(2);
                long size = cursor.isNull(3) ? -1 : cursor.getLong(3);
                long lastModified = cursor.isNull(4) ? 0 : cursor.getLong(4);
                return new RepositoryDocument(documentUri, documentId, name, mimeType, size, lastModified);
            }
        }
        throw new IllegalStateException("无法读取自动备份仓库文件信息。");
    }

    private byte[] readAllBytes(Uri fileUri) throws Exception {
        try (InputStream input = getContext().getContentResolver().openInputStream(fileUri)) {
            if (input == null) {
                throw new IllegalStateException("无法打开自动备份仓库文件读取流。");
            }
            ByteArrayOutputStream output = new ByteArrayOutputStream();
            byte[] buffer = new byte[64 * 1024];
            int read;
            while ((read = input.read(buffer)) != -1) {
                output.write(buffer, 0, read);
            }
            return output.toByteArray();
        }
    }

    private byte[] readChunk(Uri fileUri, int offset, int length) throws Exception {
        try (InputStream input = getContext().getContentResolver().openInputStream(fileUri)) {
            if (input == null) {
                throw new IllegalStateException("无法打开自动备份仓库文件读取流。");
            }
            long skipped = 0;
            while (skipped < offset) {
                long step = input.skip(offset - skipped);
                if (step <= 0) {
                    if (input.read() == -1) {
                        return new byte[0];
                    }
                    step = 1;
                }
                skipped += step;
            }

            ByteArrayOutputStream output = new ByteArrayOutputStream(length);
            byte[] buffer = new byte[Math.min(length, 64 * 1024)];
            int remaining = length;
            while (remaining > 0) {
                int read = input.read(buffer, 0, Math.min(buffer.length, remaining));
                if (read == -1) {
                    break;
                }
                output.write(buffer, 0, read);
                remaining -= read;
            }
            return output.toByteArray();
        }
    }

    private Uri childrenUriForDocument(Uri documentUri) {
        return DocumentsContract.buildChildDocumentsUriUsingTree(
            documentUri,
            DocumentsContract.getDocumentId(documentUri)
        );
    }

    private Uri findOrCreateFile(Uri documentUri, String mimeType) throws Exception {
        return findOrCreateFile(documentUri, mimeType, LATEST_FILE_NAME);
    }

    private Uri findOrCreateFile(Uri documentUri, String mimeType, String fileName) throws Exception {
        Uri childrenUri = childrenUriForDocument(documentUri);
        try (android.database.Cursor cursor = getContext().getContentResolver().query(
            childrenUri,
            new String[] {
                DocumentsContract.Document.COLUMN_DOCUMENT_ID,
                DocumentsContract.Document.COLUMN_DISPLAY_NAME
            },
            null,
            null,
            null
        )) {
            if (cursor != null) {
                while (cursor.moveToNext()) {
                    String documentId = cursor.getString(0);
                    String name = cursor.getString(1);
                    if (fileName.equals(name)) {
                        return DocumentsContract.buildDocumentUriUsingTree(documentUri, documentId);
                    }
                }
            }
        }
        Uri created = DocumentsContract.createDocument(
            getContext().getContentResolver(),
            documentUri,
            mimeType,
            fileName
        );
        if (created == null) {
            throw new IllegalStateException("无法创建自动备份文件。");
        }
        return created;
    }

    private VerifiedFile verifyLatestFile(Uri documentUri, Uri writtenUri) throws Exception {
        Uri childrenUri = childrenUriForDocument(documentUri);
        String writtenDocumentId = DocumentsContract.getDocumentId(writtenUri);
        VerifiedFile matchingWrittenUri = null;
        JSArray diagnostics = new JSArray();

        try (android.database.Cursor cursor = getContext().getContentResolver().query(
            childrenUri,
            new String[] {
                DocumentsContract.Document.COLUMN_DOCUMENT_ID,
                DocumentsContract.Document.COLUMN_DISPLAY_NAME,
                DocumentsContract.Document.COLUMN_SIZE,
                DocumentsContract.Document.COLUMN_LAST_MODIFIED
            },
            null,
            null,
            null
        )) {
            if (cursor != null) {
                int inspected = 0;
                while (cursor.moveToNext()) {
                    String documentId = cursor.getString(0);
                    String name = cursor.getString(1);
                    long size = cursor.isNull(2) ? -1 : cursor.getLong(2);
                    long lastModified = cursor.isNull(3) ? 0 : cursor.getLong(3);
                    Uri fileUri = DocumentsContract.buildDocumentUriUsingTree(documentUri, documentId);

                    if (inspected < 20) {
                        diagnostics.put(fileDiagnostic(name, size, lastModified));
                        inspected += 1;
                    }

                    if (LATEST_FILE_NAME.equals(name)) {
                        return requireVisibleBackupFile(new VerifiedFile(fileUri, name, size, lastModified, true), diagnostics);
                    }
                    if (writtenDocumentId.equals(documentId)) {
                        matchingWrittenUri = new VerifiedFile(fileUri, name, size, lastModified, false);
                    }
                }
            }
        }

        if (matchingWrittenUri != null) {
            return requireVisibleBackupFile(matchingWrittenUri, diagnostics);
        }

        throw new IllegalStateException(
            "自动备份写入流已完成，但未在备份文件夹中验证到 " + LATEST_FILE_NAME + "。目录诊断：" + diagnostics.toString()
        );
    }

    private VerifiedFile requireVisibleBackupFile(VerifiedFile file, JSArray diagnostics) {
        if (file.displayName == null || file.displayName.isEmpty()) {
            throw new IllegalStateException("自动备份写入流已完成，但系统未返回备份文件名。目录诊断：" + diagnostics.toString());
        }
        if (file.size <= 0) {
            throw new IllegalStateException(
                "自动备份写入流已完成，但验证到的备份文件为空或大小未知：" + file.displayName + "。目录诊断：" + diagnostics.toString()
            );
        }
        return file;
    }

    private JSArray folderDiagnostics(Uri documentUri, int limit) throws Exception {
        JSArray files = new JSArray();
        Uri childrenUri = childrenUriForDocument(documentUri);
        try (android.database.Cursor cursor = getContext().getContentResolver().query(
            childrenUri,
            new String[] {
                DocumentsContract.Document.COLUMN_DISPLAY_NAME,
                DocumentsContract.Document.COLUMN_SIZE,
                DocumentsContract.Document.COLUMN_LAST_MODIFIED
            },
            null,
            null,
            null
        )) {
            if (cursor != null) {
                int count = 0;
                int cappedLimit = Math.max(1, Math.min(limit, 50));
                while (cursor.moveToNext() && count < cappedLimit) {
                    String name = cursor.getString(0);
                    long size = cursor.isNull(1) ? -1 : cursor.getLong(1);
                    long lastModified = cursor.isNull(2) ? 0 : cursor.getLong(2);
                    files.put(fileDiagnostic(name, size, lastModified));
                    count += 1;
                }
            }
        }
        return files;
    }

    private JSObject fileDiagnostic(String name, long size, long lastModified) {
        JSObject file = new JSObject();
        file.put("displayName", name);
        file.put("size", size);
        file.put("lastModified", lastModified);
        return file;
    }

    private void closeQuietly(OutputStream output) {
        try {
            output.close();
        } catch (Exception ignored) {
        }
    }

    private SharedPreferences prefs() {
        return getContext().getSharedPreferences(PREFS, Activity.MODE_PRIVATE);
    }

    private String displayName(Uri uri) {
        String path = uri.getLastPathSegment();
        if (path == null || path.isEmpty()) {
            return "已绑定文件夹";
        }
        int colon = path.lastIndexOf(':');
        String name = colon >= 0 ? path.substring(colon + 1) : path;
        return name.isEmpty() ? "已绑定文件夹" : name;
    }

    private String safeFileName(String name) {
        if (name == null || name.isEmpty()) {
            return LATEST_FILE_NAME;
        }
        return name.replaceAll("[\\\\/:*?\"<>|]+", "_");
    }

    private String safePathSegment(String name) {
        String value = name == null ? "" : name.trim();
        value = value.replaceAll("[\\\\/:*?\"<>|]+", "_");
        value = value.replaceAll("\\s+", " ");
        if (value.equals(".") || value.equals("..")) {
            value = "_";
        }
        return value.isEmpty() ? "unnamed" : value;
    }

    private String normalizeRepositoryPath(String path) {
        if (path == null) {
            return "";
        }
        String normalized = path.replace("\\", "/").trim();
        while (normalized.startsWith("/")) {
            normalized = normalized.substring(1);
        }
        while (normalized.endsWith("/")) {
            normalized = normalized.substring(0, normalized.length() - 1);
        }
        if (normalized.isEmpty()) {
            return "";
        }
        String[] parts = normalized.split("/");
        StringBuilder builder = new StringBuilder();
        for (String part : parts) {
            if (part == null || part.trim().isEmpty() || part.equals(".") || part.equals("..")) {
                continue;
            }
            if (builder.length() > 0) {
                builder.append('/');
            }
            builder.append(safePathSegment(part));
        }
        return builder.toString();
    }

    private String parentPath(String path) {
        int slash = path.lastIndexOf('/');
        return slash < 0 ? "" : path.substring(0, slash);
    }

    private String lastPathSegment(String path) {
        int slash = path.lastIndexOf('/');
        return safePathSegment(slash < 0 ? path : path.substring(slash + 1));
    }

    private String mimeTypeForPath(String path) {
        String lower = path == null ? "" : path.toLowerCase();
        if (lower.endsWith(".json")) {
            return "application/json";
        }
        if (lower.endsWith(".txt") || lower.endsWith(".md")) {
            return "text/plain";
        }
        if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) {
            return "image/jpeg";
        }
        if (lower.endsWith(".png")) {
            return "image/png";
        }
        if (lower.endsWith(".webp")) {
            return "image/webp";
        }
        if (lower.endsWith(".mp3")) {
            return "audio/mpeg";
        }
        if (lower.endsWith(".m4a")) {
            return "audio/mp4";
        }
        if (lower.endsWith(".pdf")) {
            return "application/pdf";
        }
        return "application/octet-stream";
    }
}
