const { app, BrowserWindow, dialog, ipcMain, net, protocol, session, shell } = require("electron");
const { cpSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } = require("node:fs");
const fs = require("node:fs/promises");
const http = require("node:http");
const { randomUUID, createHmac, createHash } = require("node:crypto");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { recognizePaddleOcr } = require("./ocr.cjs");

const APP_SCHEME = "study-journal";
const APP_HOST = "app";
const FIREBASE_AUTH_HOST = "study-journal-408-9f31.firebaseapp.com";
const FIREBASE_STORAGE_BUCKET = "study-journal-408-9f31.firebasestorage.app";
const FIREBASE_STORAGE_TEST_URL = `https://firebasestorage.googleapis.com/v0/b/${encodeURIComponent(FIREBASE_STORAGE_BUCKET)}/o?maxResults=1`;
const FIREBASE_STORAGE_METADATA_TIMEOUT_MS = 30_000;
const FIREBASE_STORAGE_REQUEST_TIMEOUT_MS = 120_000;
const _oauth = require("./oauth-config.cjs");
const DESKTOP_GOOGLE_CLIENT_ID = _oauth.clientId;
const DESKTOP_GOOGLE_CLIENT_SECRET = _oauth.clientSecret;
const UPDATE_QUIT_ARGUMENT = "--quit-for-update";
const DIST_ROOT = path.resolve(__dirname, "..", "dist");
const APP_ID = "com.noteproject.study408.desktop";
const DESKTOP_ROOT = path.resolve("D:\\StudyJournal");
const DESKTOP_DATA_ROOT = path.join(DESKTOP_ROOT, "Data");
const LEGACY_COPY_EXCLUDED_NAMES = new Set([
  "DevToolsActivePort",
  "LOCK",
  "SingletonCookie",
  "SingletonLock",
  "SingletonSocket",
]);
const PROFILE_DATA_ENTRIES = ["IndexedDB", "Local Storage", "WebStorage"];

const PROXY_CONFIG_PATH = path.join(DESKTOP_DATA_ROOT, "proxy-config.json");

const readProxyUrl = () => {
  try {
    const data = JSON.parse(readFileSync(PROXY_CONFIG_PATH, "utf8"));
    return typeof data.proxyUrl === "string" ? data.proxyUrl : "";
  } catch {
    return "";
  }
};

const writeProxyUrl = (url) => {
  try {
    writeFileSync(PROXY_CONFIG_PATH, JSON.stringify({ proxyUrl: url }), "utf8");
  } catch {}
};

const applyProxy = async (proxyUrl) => {
  if (!proxyUrl) {
    await session.defaultSession.setProxy({ mode: "system" });
  } else {
    // Chromium proxyRules: bare "host:port" applies to ALL schemes including HTTPS.
    // With the "http://" prefix it would only proxy http:// traffic, leaving HTTPS
    // (e.g. Firebase Storage) unproxied. Strip the http:// prefix; keep socks5://.
    const rules = proxyUrl.replace(/^http:\/\//i, "");
    await session.defaultSession.setProxy({ proxyRules: rules });
  }
  // Existing HTTP/2 and direct connections may otherwise be reused after a
  // proxy change, making a retry appear to ignore the newly saved setting.
  await session.defaultSession.closeAllConnections();
};

const requireMainWindowSender = (event, message) => {
  if (!mainWindow || mainWindow.isDestroyed() || event.sender !== mainWindow.webContents) {
    throw new Error(message);
  }
};

const isAllowedFirebaseStoragePath = (uid, objectPath) => {
  if (typeof uid !== "string" || typeof objectPath !== "string" || !uid || objectPath.length > 1024) {
    return false;
  }
  const currentUserPrefix = `users/${uid}/`;
  return objectPath.startsWith(currentUserPrefix) || objectPath === `${uid}/snapshots/current.zip`;
};

const firebaseStorageObjectUrl = (objectPath) =>
  `https://firebasestorage.googleapis.com/v0/b/${encodeURIComponent(FIREBASE_STORAGE_BUCKET)}/o/${encodeURIComponent(objectPath)}?alt=media`;

const firebaseStorageObjectMetadataUrl = (objectPath) =>
  `https://firebasestorage.googleapis.com/v0/b/${encodeURIComponent(FIREBASE_STORAGE_BUCKET)}/o/${encodeURIComponent(objectPath)}`;

const firebaseStorageObjectUploadUrl = (objectPath) =>
  `https://firebasestorage.googleapis.com/v0/b/${encodeURIComponent(FIREBASE_STORAGE_BUCKET)}/o?uploadType=media&name=${encodeURIComponent(objectPath)}`;

const responseDetail = async (response) => (await response.text()).replace(/\s+/g, " ").slice(0, 240);

const decodeDoubaoTtsNdjson = (payload) => {
  const chunks = [];
  for (const line of payload.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let item;
    try {
      item = JSON.parse(trimmed);
    } catch {
      throw new Error("豆包 TTS 返回了无法解析的响应。");
    }
    const code = item.code == null ? "" : String(item.code).trim();
    // Doubao V3 terminates a successful stream with code 20000000/message OK.
    if (code && code !== "0" && code !== "20000000") {
      throw new Error(`豆包 TTS 请求失败：${typeof item.message === "string" ? item.message : `错误码 ${String(item.code)}`}`);
    }
    if (typeof item.data === "string" && item.data) chunks.push(Buffer.from(item.data, "base64"));
  }
  if (!chunks.length) throw new Error("豆包 TTS 未返回音频数据。");
  return Buffer.concat(chunks);
};

const fetchFirebaseStorageObject = async (uid, objectPath, idToken) => {
  if (!isAllowedFirebaseStoragePath(uid, objectPath) || typeof idToken !== "string" || !idToken) {
    throw new Error("Firebase Storage 下载请求无效。");
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FIREBASE_STORAGE_REQUEST_TIMEOUT_MS);
  try {
    const response = await session.defaultSession.fetch(firebaseStorageObjectUrl(objectPath), {
      headers: { Authorization: `Firebase ${idToken}` },
      signal: controller.signal,
    });
    if (!response.ok) {
      const detail = await responseDetail(response);
      throw new Error(`Firebase Storage 返回 HTTP ${response.status}${detail ? `：${detail}` : ""}`);
    }
    return {
      data: await response.arrayBuffer(),
      contentType: response.headers.get("content-type") || "application/octet-stream",
    };
  } catch (error) {
    if (controller.signal.aborted) {
      throw new Error(`Firebase Storage 在 ${FIREBASE_STORAGE_REQUEST_TIMEOUT_MS / 1000} 秒内未响应。`);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
};

const checkFirebaseStorageObject = async (uid, objectPath, idToken) => {
  if (!isAllowedFirebaseStoragePath(uid, objectPath) || typeof idToken !== "string" || !idToken) {
    throw new Error("Firebase Storage 检查请求无效。");
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FIREBASE_STORAGE_METADATA_TIMEOUT_MS);
  try {
    const response = await session.defaultSession.fetch(firebaseStorageObjectMetadataUrl(objectPath), {
      headers: { Authorization: `Firebase ${idToken}` },
      signal: controller.signal,
    });
    if (response.status === 404) return false;
    if (response.status === 407) {
      throw new Error("代理服务器要求认证，当前桌面端不支持需要用户名和密码的代理。");
    }
    if (!response.ok) {
      const detail = await responseDetail(response);
      throw new Error(`Firebase Storage 检查返回 HTTP ${response.status}${detail ? `：${detail}` : ""}`);
    }
    return true;
  } catch (error) {
    if (controller.signal.aborted) {
      throw new Error(`Firebase Storage 检查在 ${FIREBASE_STORAGE_METADATA_TIMEOUT_MS / 1000} 秒内未响应。`);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
};

const uploadFirebaseStorageObject = async (uid, objectPath, idToken, data, contentType) => {
  if (!isAllowedFirebaseStoragePath(uid, objectPath) || typeof idToken !== "string" || !idToken) {
    throw new Error("Firebase Storage 上传请求无效。");
  }
  if (typeof contentType !== "string" || !contentType) {
    throw new Error("Firebase Storage 上传缺少内容类型。");
  }
  let body;
  if (data instanceof ArrayBuffer) {
    body = Buffer.from(data);
  } else if (ArrayBuffer.isView(data)) {
    body = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  } else {
    throw new Error("Firebase Storage 上传数据无效。");
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FIREBASE_STORAGE_REQUEST_TIMEOUT_MS);
  try {
    const response = await session.defaultSession.fetch(firebaseStorageObjectUploadUrl(objectPath), {
      method: "POST",
      headers: {
        Authorization: `Firebase ${idToken}`,
        "Content-Type": contentType,
      },
      body,
      signal: controller.signal,
    });
    if (response.status === 407) {
      throw new Error("代理服务器要求认证，当前桌面端不支持需要用户名和密码的代理。");
    }
    if (!response.ok) {
      const detail = await responseDetail(response);
      throw new Error(`Firebase Storage 上传返回 HTTP ${response.status}${detail ? `：${detail}` : ""}`);
    }
  } catch (error) {
    if (controller.signal.aborted) {
      throw new Error(`Firebase Storage 上传在 ${FIREBASE_STORAGE_REQUEST_TIMEOUT_MS / 1000} 秒内未完成。`);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
};

const testFirebaseStorageConnection = async () => {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15_000);
  try {
    const proxy = await session.defaultSession.resolveProxy(FIREBASE_STORAGE_TEST_URL);
    const response = await session.defaultSession.fetch(FIREBASE_STORAGE_TEST_URL, { signal: controller.signal });
    if (response.status === 407) {
      throw new Error("代理服务器要求认证，当前桌面端不支持需要用户名和密码的代理。");
    }
    if (![200, 401, 403].includes(response.status)) {
      throw new Error(`Firebase Storage 返回 HTTP ${response.status}。`);
    }
    return { proxy, status: response.status };
  } catch (error) {
    if (controller.signal.aborted) {
      throw new Error("15 秒内未能连接 Firebase Storage。");
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
};

// Firebase Storage (*.firebasestorage.app) prefers QUIC (HTTP/3 over UDP).
// Most proxy/VPN setups only tunnel TCP, so QUIC packets are silently dropped
// and Chromium waits ~60 s before falling back to TCP — exactly long enough to
// hit our asset download timeout. Force TCP for all connections.
app.commandLine.appendSwitch("disable-quic");

protocol.registerSchemesAsPrivileged([
  {
    scheme: APP_SCHEME,
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      corsEnabled: true,
    },
  },
]);

app.setName("学习日志");

let mainWindow;
let voiceCaptureActive = false;
const desktopBackupWriteSessions = new Map();
const desktopBackupFlushRequests = new Map();
let closeAfterDesktopBackup = false;

const isSamePath = (left, right) => path.normalize(left).toLowerCase() === path.normalize(right).toLowerCase();

const hasProfileData = (dataPath) => PROFILE_DATA_ENTRIES.some((entry) => existsSync(path.join(dataPath, entry)));

const findLegacyDesktopDataPath = () => {
  const candidates = [
    DESKTOP_ROOT,
    path.join(app.getPath("appData"), app.getName()),
  ];
  return candidates.find((candidate) => !isSamePath(candidate, DESKTOP_DATA_ROOT) && hasProfileData(candidate));
};

const migrateLegacyDesktopData = () => {
  const legacyDataPath = findLegacyDesktopDataPath();
  if (!legacyDataPath || existsSync(DESKTOP_DATA_ROOT)) {
    return { status: "not-needed" };
  }

  // Electron may already hold its profile lock when this script starts. Locks contain no user data
  // and copying them would make a cross-drive migration fail before the IndexedDB is copied.
  const stagingPath = path.join(
    path.dirname(DESKTOP_ROOT),
    `${path.basename(DESKTOP_ROOT)}.data-migration-${process.pid}`,
  );

  try {
    cpSync(legacyDataPath, stagingPath, {
      recursive: true,
      force: false,
      errorOnExist: true,
      preserveTimestamps: true,
      filter: (source) => {
        if (LEGACY_COPY_EXCLUDED_NAMES.has(path.basename(source))) {
          return false;
        }
        const isLegacyDesktopRoot = isSamePath(legacyDataPath, DESKTOP_ROOT);
        return !isLegacyDesktopRoot || path.relative(legacyDataPath, source).split(path.sep)[0] !== "App";
      },
    });
    renameSync(stagingPath, DESKTOP_DATA_ROOT);
    return { status: "migrated", legacyDataPath };
  } catch (error) {
    console.error("Failed to migrate desktop data to D drive", error);
    return {
      status: "failed",
      error: error instanceof Error ? error.message : String(error),
    };
  }
};

const configureDesktopDataPaths = () => {
  const migration = migrateLegacyDesktopData();
  if (migration.status === "failed") {
    return { ...migration, usingLegacyDataPath: true };
  }

  try {
    mkdirSync(DESKTOP_DATA_ROOT, { recursive: true });
    app.setPath("userData", DESKTOP_DATA_ROOT);
    app.setPath("sessionData", DESKTOP_DATA_ROOT);
    app.setPath("temp", path.join(DESKTOP_DATA_ROOT, "temp"));
    app.setPath("crashDumps", path.join(DESKTOP_DATA_ROOT, "crash-dumps"));
    app.setAppLogsPath(path.join(DESKTOP_DATA_ROOT, "logs"));
    return migration;
  } catch (error) {
    console.error("Failed to configure D drive desktop data paths", error);
    return {
      status: "failed",
      error: error instanceof Error ? error.message : String(error),
      usingLegacyDataPath: true,
    };
  }
};

const dataPathSetup = configureDesktopDataPaths();

const DESKTOP_BACKUP_REPOSITORY_NAME = "study-journal-backup";
const DESKTOP_BACKUP_BINDING_FILE = "desktop-auto-backup.json";

const desktopBackupBindingPath = () => path.join(app.getPath("userData"), DESKTOP_BACKUP_BINDING_FILE);

const readDesktopBackupBinding = async () => {
  try {
    const parsed = JSON.parse(await fs.readFile(desktopBackupBindingPath(), "utf8"));
    if (!parsed || typeof parsed.folderPath !== "string" || !path.isAbsolute(parsed.folderPath)) {
      return undefined;
    }
    return { folderPath: path.normalize(parsed.folderPath) };
  } catch {
    return undefined;
  }
};

const writeDesktopBackupBinding = async (folderPath) => {
  await fs.mkdir(app.getPath("userData"), { recursive: true });
  const temporaryPath = `${desktopBackupBindingPath()}.${process.pid}.tmp`;
  await fs.writeFile(temporaryPath, JSON.stringify({ folderPath, updatedAt: new Date().toISOString() }), "utf8");
  await fs.rename(temporaryPath, desktopBackupBindingPath());
};

const safeRepositoryRelativePath = (value) => {
  if (typeof value !== "string" || !value || path.isAbsolute(value)) {
    throw new Error("备份仓库文件路径无效。");
  }
  const normalized = path.normalize(value).replace(/\\/g, "/");
  if (normalized === ".." || normalized.startsWith("../") || normalized.includes("/../")) {
    throw new Error("备份仓库文件路径超出绑定目录。");
  }
  return normalized;
};

const isInsideDirectory = (root, candidate) => candidate === root || candidate.startsWith(`${root}${path.sep}`);

const resolveDesktopBackupRepositoryRoot = async (create = false) => {
  const binding = await readDesktopBackupBinding();
  if (!binding || !existsSync(binding.folderPath)) {
    throw new Error("尚未绑定有效的自动备份文件夹。");
  }
  const repositoryRoot = path.resolve(binding.folderPath, DESKTOP_BACKUP_REPOSITORY_NAME);
  if (!isInsideDirectory(path.resolve(binding.folderPath), repositoryRoot)) {
    throw new Error("备份仓库路径无效。");
  }
  if (create) {
    await fs.mkdir(repositoryRoot, { recursive: true });
  }
  return { repositoryRoot, folderName: path.basename(binding.folderPath) || binding.folderPath };
};

const resolveDesktopBackupFilePath = async (relativePath, createRepository = false) => {
  const { repositoryRoot, folderName } = await resolveDesktopBackupRepositoryRoot(createRepository);
  const targetPath = path.resolve(repositoryRoot, safeRepositoryRelativePath(relativePath));
  if (!isInsideDirectory(repositoryRoot, targetPath)) {
    throw new Error("备份仓库文件路径超出绑定目录。");
  }
  return { repositoryRoot, targetPath, folderName };
};

const desktopBackupStatus = async () => {
  const binding = await readDesktopBackupBinding();
  if (!binding || !existsSync(binding.folderPath)) {
    return { bound: false };
  }
  return { bound: true, folderName: path.basename(binding.folderPath) || binding.folderPath };
};

const bindDesktopBackupFolder = async () => {
  const selection = await dialog.showOpenDialog(mainWindow, {
    title: "选择自动备份文件夹",
    properties: ["openDirectory", "createDirectory"],
  });
  if (selection.canceled || !selection.filePaths[0]) {
    throw new Error("已取消绑定自动备份文件夹。");
  }
  const selectedPath = path.resolve(selection.filePaths[0]);
  const folderPath = path.basename(selectedPath).toLowerCase() === DESKTOP_BACKUP_REPOSITORY_NAME
    ? path.dirname(selectedPath)
    : selectedPath;
  await fs.mkdir(folderPath, { recursive: true });
  await writeDesktopBackupBinding(folderPath);
  return { folderName: path.basename(folderPath) || folderPath };
};

const listDesktopBackupRepositoryFiles = async (directory) => {
  const relativeDirectory = directory ? safeRepositoryRelativePath(directory) : "";
  const { repositoryRoot } = await resolveDesktopBackupRepositoryRoot(false);
  const directoryPath = path.resolve(repositoryRoot, relativeDirectory);
  if (!isInsideDirectory(repositoryRoot, directoryPath)) {
    throw new Error("备份仓库目录超出绑定文件夹。");
  }
  try {
    const entries = await fs.readdir(directoryPath, { withFileTypes: true });
    return Promise.all(entries.filter((entry) => entry.isFile()).map(async (entry) => {
      const filePath = path.join(directoryPath, entry.name);
      const stat = await fs.stat(filePath);
      return {
        path: relativeDirectory ? `${relativeDirectory}/${entry.name}` : entry.name,
        displayName: entry.name,
        size: stat.size,
        lastModified: stat.mtimeMs,
      };
    }));
  } catch (error) {
    if (error && typeof error === "object" && error.code === "ENOENT") {
      return [];
    }
    throw error;
  }
};

const beginDesktopBackupRepositoryFileWrite = async (relativePath) => {
  const { targetPath } = await resolveDesktopBackupFilePath(relativePath, true);
  await fs.mkdir(path.dirname(targetPath), { recursive: true });
  const sessionId = randomUUID();
  const temporaryPath = `${targetPath}.${sessionId}.partial`;
  const handle = await fs.open(temporaryPath, "w");
  desktopBackupWriteSessions.set(sessionId, { targetPath, temporaryPath, handle, size: 0 });
  return { sessionId, path: safeRepositoryRelativePath(relativePath) };
};

const appendDesktopBackupRepositoryFileWrite = async (sessionId, data) => {
  const session = desktopBackupWriteSessions.get(sessionId);
  if (!session || typeof data !== "string") {
    throw new Error("备份写入会话不存在或已结束。");
  }
  const bytes = Buffer.from(data, "base64");
  if (bytes.byteLength === 0 && data) {
    throw new Error("备份写入数据格式无效。");
  }
  await session.handle.write(bytes);
  session.size += bytes.byteLength;
  return { size: session.size };
};

const finishDesktopBackupRepositoryFileWrite = async (sessionId) => {
  const session = desktopBackupWriteSessions.get(sessionId);
  if (!session) {
    throw new Error("备份写入会话不存在或已结束。");
  }
  desktopBackupWriteSessions.delete(sessionId);
  try {
    await session.handle.close();
    await fs.rename(session.temporaryPath, session.targetPath);
    const stat = await fs.stat(session.targetPath);
    return {
      path: path.basename(session.targetPath),
      displayName: path.basename(session.targetPath),
      size: stat.size,
      lastModified: stat.mtimeMs,
    };
  } catch (error) {
    await fs.rm(session.temporaryPath, { force: true }).catch(() => undefined);
    throw error;
  }
};

const cancelDesktopBackupRepositoryFileWrite = async (sessionId) => {
  const session = desktopBackupWriteSessions.get(sessionId);
  if (!session) {
    return;
  }
  desktopBackupWriteSessions.delete(sessionId);
  await session.handle.close().catch(() => undefined);
  await fs.rm(session.temporaryPath, { force: true }).catch(() => undefined);
};

const requestDesktopBackupFlush = (reason) => {
  if (!mainWindow || mainWindow.isDestroyed()) {
    return Promise.resolve();
  }
  const requestId = randomUUID();
  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      desktopBackupFlushRequests.delete(requestId);
      resolve();
    }, 30_000);
    desktopBackupFlushRequests.set(requestId, () => {
      clearTimeout(timeout);
      resolve();
    });
    mainWindow.webContents.send("study-journal:backup-flush-request", { requestId, reason });
  });
};

const closeMainWindowAfterBackup = () => {
  if (closeAfterDesktopBackup) {
    return;
  }
  closeAfterDesktopBackup = true;
  void requestDesktopBackupFlush("close").finally(() => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.close();
    } else {
      app.quit();
    }
  });
};

ipcMain.handle("study-journal:desktop-backup-bind", bindDesktopBackupFolder);
ipcMain.handle("study-journal:voice-capabilities", () => ({
  rendererCapture: true,
  pcmSampleRates: [16000, 24000, 48000],
  protocolProxy: true,
}));
ipcMain.handle("study-journal:voice-capture-active", (_event, active) => {
  voiceCaptureActive = Boolean(active);
  return { active: voiceCaptureActive };
});
ipcMain.handle("study-journal:desktop-ocr-recognize", (event, options) => {
  if (!mainWindow || mainWindow.isDestroyed() || event.sender !== mainWindow.webContents) {
    throw new Error("桌面 OCR 请求来源无效。");
  }
  return recognizePaddleOcr(options);
});
ipcMain.handle("study-journal:tts-synthesize", async (event, options) => {
  if (!mainWindow || mainWindow.isDestroyed() || event.sender !== mainWindow.webContents) {
    throw new Error("TTS 请求来源无效。");
  }
  const providerId = typeof options?.providerId === "string" ? options.providerId : "fish-audio";
  const apiKey = typeof options?.apiKey === "string" ? options.apiKey.trim() : "";
  const apiKeySecondary = typeof options?.apiKeySecondary === "string" ? options.apiKeySecondary.trim() : "";
  const model = typeof options?.model === "string" ? options.model.trim() : "";
  const voiceId = typeof options?.voiceId === "string" ? options.voiceId.trim() : "";
  const text = typeof options?.text === "string" ? options.text : "";
  const region = typeof options?.region === "string" ? options.region.trim() : "ap-guangzhou";
  const languageCode = typeof options?.languageCode === "string" ? options.languageCode.trim() : "cmn-CN";
  if (!apiKey || !voiceId || !text.trim()) throw new Error("TTS 请求配置不完整。");

  if (providerId === "doubao") {
    const resourceId = model || "seed-tts-2.0";
    const resp = await net.fetch("https://openspeech.bytedance.com/api/v3/tts/unidirectional", {
      method: "POST",
      headers: {
        "X-Api-Key": apiKey,
        "X-Api-Resource-Id": resourceId,
        "X-Api-Request-Id": randomUUID(),
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      // Voice-only speech is fully intelligible well below the 24kHz/default bitrate these
      // providers ship with — lowering it here shrinks every generated podcast asset before it
      // ever reaches storage or cloud sync, without touching already-synced audio.
      body: JSON.stringify({ req_params: { text, speaker: voiceId, audio_params: { format: "mp3", sample_rate: 16000 } } }),
    });
    const payload = await resp.text();
    if (!resp.ok) throw new Error(`豆包 TTS 请求失败（${resp.status}）：${payload.replace(/\s+/g, " ").slice(0, 240)}`);
    const buffer = decodeDoubaoTtsNdjson(payload);
    return { data: buffer.toString("base64"), mimeType: "audio/mpeg" };
  }

  if (providerId === "aliyun") {
    const aliyunModel = model || "qwen3-tts-flash";
    const resp = await net.fetch("https://dashscope.aliyuncs.com/api/v1/services/aigc/text2audio", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model: aliyunModel, input: { text, voice: voiceId }, parameters: { format: "mp3", sample_rate: 16000 } }),
    });
    const json = await resp.json();
    if (!resp.ok) throw new Error(`阿里云 TTS 请求失败（${resp.status}）：${JSON.stringify(json).slice(0, 200)}`);
    const audioUrl = json?.output?.audio?.url;
    if (!audioUrl) throw new Error("阿里云 TTS 未返回音频链接。");
    const audioResp = await net.fetch(audioUrl);
    if (!audioResp.ok) throw new Error(`阿里云音频下载失败（${audioResp.status}）`);
    const buffer = Buffer.from(await audioResp.arrayBuffer());
    return { data: buffer.toString("base64"), mimeType: "audio/mpeg" };
  }

  if (providerId === "tencent") {
    const secretId = apiKey;
    const secretKey = apiKeySecondary;
    if (!secretKey) throw new Error("腾讯云 TTS 需要 SecretKey（API Key Secondary）。");
    const voiceType = parseInt(voiceId, 10);
    if (isNaN(voiceType)) throw new Error("腾讯云 VoiceType 必须为数字。");
    const host = "tts.tencentcloudapi.com";
    const service = "tts";
    const action = "TextToVoice";
    const version = "2019-08-23";
    const timestamp = Math.floor(Date.now() / 1000);
    const date = new Date(timestamp * 1000).toISOString().slice(0, 10);
    const payload = JSON.stringify({ Text: text, SessionId: randomUUID(), VoiceType: voiceType, Codec: "mp3", SampleRate: 16000 });
    const hashedPayload = createHash("sha256").update(payload).digest("hex");
    const canonicalRequest = `POST\n/\n\ncontent-type:application/json\nhost:${host}\n\ncontent-type;host\n${hashedPayload}`;
    const credentialScope = `${date}/${service}/tc3_request`;
    const stringToSign = `TC3-HMAC-SHA256\n${timestamp}\n${credentialScope}\n${createHash("sha256").update(canonicalRequest).digest("hex")}`;
    const secretDate = createHmac("sha256", `TC3${secretKey}`).update(date).digest();
    const secretService = createHmac("sha256", secretDate).update(service).digest();
    const secretSigning = createHmac("sha256", secretService).update("tc3_request").digest();
    const signature = createHmac("sha256", secretSigning).update(stringToSign).digest("hex");
    const authorization = `TC3-HMAC-SHA256 Credential=${secretId}/${credentialScope}, SignedHeaders=content-type;host, Signature=${signature}`;
    const resp = await net.fetch(`https://${host}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Host: host,
        Authorization: authorization,
        "X-TC-Action": action,
        "X-TC-Timestamp": String(timestamp),
        "X-TC-Version": version,
        "X-TC-Region": region,
      },
      body: payload,
    });
    const json = await resp.json();
    if (!resp.ok || json?.Response?.Error) throw new Error(`腾讯云 TTS 请求失败：${JSON.stringify(json?.Response?.Error ?? json).slice(0, 200)}`);
    const audio = json?.Response?.Audio;
    if (!audio) throw new Error("腾讯云 TTS 未返回音频数据。");
    return { data: audio, mimeType: "audio/mpeg" };
  }

  if (providerId === "google") {
    const resp = await net.fetch(`https://texttospeech.googleapis.com/v1/text:synthesize?key=${encodeURIComponent(apiKey)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ input: { text }, voice: { languageCode, name: voiceId }, audioConfig: { audioEncoding: "MP3", sampleRateHertz: 16000 } }),
    });
    const json = await resp.json();
    if (!resp.ok) throw new Error(`Google TTS 请求失败（${resp.status}）：${JSON.stringify(json).slice(0, 200)}`);
    const audioContent = json?.audioContent;
    if (!audioContent) throw new Error("Google TTS 未返回音频数据。");
    return { data: audioContent, mimeType: "audio/mpeg" };
  }

  // Fish Audio (default)
  const fishModel = model || "s2.1-pro-free";
  const fishToken = apiKey.replace(/^Bearer\s+/i, "");
  const response = await net.fetch("https://api.fish.audio/v1/tts", {
    method: "POST",
    headers: { Authorization: `Bearer ${fishToken}`, "Content-Type": "application/json", Accept: "audio/mpeg", model: fishModel },
    body: JSON.stringify({ text, reference_id: voiceId, format: "mp3", normalize: true, mp3_bitrate: 64, latency: "normal", chunk_length: 300 }),
  });
  const buffer = Buffer.from(await response.arrayBuffer());
  if (!response.ok) throw new Error(`Fish Audio 请求失败（${response.status}）：${buffer.toString("utf8").slice(0, 200)}`);
  return { data: buffer.toString("base64"), mimeType: "audio/mpeg" };
});
ipcMain.handle("study-journal:desktop-backup-status", desktopBackupStatus);
ipcMain.handle("study-journal:desktop-backup-ensure", async () => {
  const { folderName } = await resolveDesktopBackupRepositoryRoot(true);
  return { folderName, repositoryName: DESKTOP_BACKUP_REPOSITORY_NAME };
});
ipcMain.handle("study-journal:desktop-backup-list", (_event, directory) => listDesktopBackupRepositoryFiles(directory));
ipcMain.handle("study-journal:desktop-backup-begin-write", (_event, pathValue) => beginDesktopBackupRepositoryFileWrite(pathValue));
ipcMain.handle("study-journal:desktop-backup-append-write", (_event, sessionId, data) => appendDesktopBackupRepositoryFileWrite(sessionId, data));
ipcMain.handle("study-journal:desktop-backup-finish-write", (_event, sessionId) => finishDesktopBackupRepositoryFileWrite(sessionId));
ipcMain.handle("study-journal:desktop-backup-cancel-write", (_event, sessionId) => cancelDesktopBackupRepositoryFileWrite(sessionId));
ipcMain.handle("study-journal:desktop-backup-read-text", async (_event, pathValue) => {
  const { targetPath } = await resolveDesktopBackupFilePath(pathValue, false);
  const text = await fs.readFile(targetPath, "utf8");
  return { text, size: Buffer.byteLength(text, "utf8") };
});
ipcMain.handle("study-journal:desktop-backup-read-chunk", async (_event, pathValue, offset, length) => {
  const { targetPath } = await resolveDesktopBackupFilePath(pathValue, false);
  const stat = await fs.stat(targetPath);
  const safeOffset = Number.isSafeInteger(offset) && offset >= 0 ? offset : 0;
  const safeLength = Number.isSafeInteger(length) && length > 0 ? Math.min(length, 2 * 1024 * 1024) : 768 * 1024;
  if (safeOffset >= stat.size) {
    return { data: "", bytesRead: 0, done: true };
  }
  const bytesToRead = Math.min(safeLength, stat.size - safeOffset);
  const handle = await fs.open(targetPath, "r");
  try {
    const bytes = Buffer.allocUnsafe(bytesToRead);
    const result = await handle.read(bytes, 0, bytesToRead, safeOffset);
    return {
      data: bytes.subarray(0, result.bytesRead).toString("base64"),
      bytesRead: result.bytesRead,
      done: safeOffset + result.bytesRead >= stat.size,
    };
  } finally {
    await handle.close();
  }
});
ipcMain.handle("study-journal:desktop-backup-delete", async (_event, pathValue) => {
  const { targetPath } = await resolveDesktopBackupFilePath(pathValue, false);
  await fs.rm(targetPath, { force: true });
});
ipcMain.on("study-journal:backup-flush-complete", (_event, requestId) => {
  const complete = desktopBackupFlushRequests.get(requestId);
  desktopBackupFlushRequests.delete(requestId);
  complete?.();
});

ipcMain.handle("study-journal:google-sign-in", (event) => {
  if (!mainWindow || mainWindow.isDestroyed() || event.sender !== mainWindow.webContents) {
    throw new Error("Google 登录请求来源无效。");
  }
  const codeVerifier = randomUUID().replace(/-/g, "") + randomUUID().replace(/-/g, "");
  const codeChallenge = createHash("sha256").update(codeVerifier).digest("base64url");
  const state = randomUUID();
  return new Promise((resolve, reject) => {
    const server = http.createServer();
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      const redirectUri = `http://127.0.0.1:${port}/callback`;
      const timeout = setTimeout(() => {
        server.close();
        reject(new Error("Google 登录超时（90 秒内未完成），请重试。"));
      }, 90_000);
      server.on("request", async (req, res) => {
        try {
          const url = new URL(req.url, `http://127.0.0.1:${port}`);
          if (url.pathname !== "/callback") {
            res.writeHead(404);
            res.end();
            return;
          }
          clearTimeout(timeout);
          const code = url.searchParams.get("code");
          const returnedState = url.searchParams.get("state");
          res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
          res.end("<html><body><p>登录成功，可以关闭此窗口。</p><script>window.close()</script></body></html>");
          server.close();
          if (returnedState !== state) {
            reject(new Error("OAuth state 不匹配，请重试。"));
            return;
          }
          if (!code) {
            reject(new Error("Google 未返回授权码。"));
            return;
          }
          const tokenResp = await net.fetch("https://oauth2.googleapis.com/token", {
            method: "POST",
            headers: { "Content-Type": "application/x-www-form-urlencoded" },
            body: new URLSearchParams({
              code,
              client_id: DESKTOP_GOOGLE_CLIENT_ID,
              client_secret: DESKTOP_GOOGLE_CLIENT_SECRET,
              redirect_uri: redirectUri,
              grant_type: "authorization_code",
              code_verifier: codeVerifier,
            }).toString(),
          });
          const tokenData = await tokenResp.json();
          if (!tokenResp.ok) {
            reject(new Error(`Google token 交换失败：${JSON.stringify(tokenData).slice(0, 200)}`));
            return;
          }
          const idToken = tokenData.id_token;
          if (!idToken) {
            reject(new Error("Google 未返回 id_token，请确认 OAuth 客户端类型为桌面应用。"));
            return;
          }
          resolve({ idToken });
        } catch (err) {
          server.close();
          reject(err);
        }
      });
      server.on("error", (err) => {
        clearTimeout(timeout);
        reject(err);
      });
      const authUrl = new URL("https://accounts.google.com/o/oauth2/v2/auth");
      authUrl.searchParams.set("client_id", DESKTOP_GOOGLE_CLIENT_ID);
      authUrl.searchParams.set("redirect_uri", redirectUri);
      authUrl.searchParams.set("response_type", "code");
      authUrl.searchParams.set("scope", "openid email profile");
      authUrl.searchParams.set("code_challenge", codeChallenge);
      authUrl.searchParams.set("code_challenge_method", "S256");
      authUrl.searchParams.set("state", state);
      authUrl.searchParams.set("access_type", "online");
      void shell.openExternal(authUrl.toString());
    });
  });
});

ipcMain.handle("study-journal:get-proxy", (event) => {
  requireMainWindowSender(event, "代理设置请求来源无效。");
  return { proxyUrl: readProxyUrl() };
});

ipcMain.handle("study-journal:set-proxy", async (event, proxyUrl) => {
  requireMainWindowSender(event, "代理设置请求来源无效。");
  const url = typeof proxyUrl === "string" ? proxyUrl.trim() : "";
  await applyProxy(url);
  writeProxyUrl(url);
  return { proxyUrl: url };
});

ipcMain.handle("study-journal:test-firebase-storage", async (event) => {
  requireMainWindowSender(event, "Firebase 连通性测试请求来源无效。");
  return testFirebaseStorageConnection();
});

ipcMain.handle("study-journal:firebase-storage-download", async (event, uid, objectPath, idToken) => {
  requireMainWindowSender(event, "Firebase Storage 下载请求来源无效。");
  return fetchFirebaseStorageObject(uid, objectPath, idToken);
});

ipcMain.handle("study-journal:firebase-storage-exists", async (event, uid, objectPath, idToken) => {
  requireMainWindowSender(event, "Firebase Storage 检查请求来源无效。");
  return checkFirebaseStorageObject(uid, objectPath, idToken);
});

ipcMain.handle("study-journal:firebase-storage-upload", async (event, uid, objectPath, idToken, data, contentType) => {
  requireMainWindowSender(event, "Firebase Storage 上传请求来源无效。");
  await uploadFirebaseStorageObject(uid, objectPath, idToken, data, contentType);
});

const isInsideDist = (filePath) => filePath === DIST_ROOT || filePath.startsWith(`${DIST_ROOT}${path.sep}`);

const resolveAppFile = (requestUrl) => {
  const url = new URL(requestUrl);
  if (url.host !== APP_HOST) {
    return null;
  }
  const requestedPath = decodeURIComponent(url.pathname || "/");
  const relativePath = requestedPath === "/" ? "index.html" : `.${requestedPath}`;
  const resolvedPath = path.resolve(DIST_ROOT, relativePath);
  return isInsideDist(resolvedPath) && existsSync(resolvedPath) ? resolvedPath : null;
};

const registerAppProtocol = () => {
  protocol.handle(APP_SCHEME, async (request) => {
    const filePath = resolveAppFile(request.url);
    if (!filePath) {
      return new Response("Not found", { status: 404, headers: { "content-type": "text/plain" } });
    }
    return net.fetch(pathToFileURL(filePath).toString());
  });
};

const openExternalUrl = (url) => {
  if (/^https?:\/\//i.test(url)) {
    void shell.openExternal(url);
  }
};

const isFirebaseAuthPopupUrl = (urlValue) => {
  try {
    const url = new URL(urlValue);
    return url.protocol === "https:" && url.hostname === FIREBASE_AUTH_HOST && url.pathname.startsWith("/__/auth/");
  } catch {
    return false;
  }
};

const createMainWindow = () => {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 960,
    minHeight: 640,
    show: false,
    backgroundColor: "#f7f3ec",
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
    },
  });

  mainWindow.once("ready-to-show", () => mainWindow.show());
  mainWindow.on("minimize", () => {
    if (voiceCaptureActive) {
      voiceCaptureActive = false;
      mainWindow?.webContents.send("study-journal:voice-suspend", { reason: "minimize" });
    }
    void requestDesktopBackupFlush("minimize");
  });
  mainWindow.on("close", (event) => {
    if (closeAfterDesktopBackup) {
      return;
    }
    event.preventDefault();
    closeMainWindowAfterBackup();
  });
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (isFirebaseAuthPopupUrl(url)) {
      return {
        action: "allow",
        overrideBrowserWindowOptions: {
          autoHideMenuBar: true,
          width: 520,
          height: 720,
          webPreferences: {
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: true,
            webSecurity: true,
          },
        },
      };
    }
    openExternalUrl(url);
    return { action: "deny" };
  });
  mainWindow.webContents.on("will-navigate", (event, url) => {
    if (!url.startsWith(`${APP_SCHEME}://${APP_HOST}/`)) {
      event.preventDefault();
      openExternalUrl(url);
    }
  });
  void mainWindow.loadURL(`${APP_SCHEME}://${APP_HOST}/index.html`);
};

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", (_event, commandLine) => {
    if (commandLine.includes(UPDATE_QUIT_ARGUMENT)) {
      closeMainWindowAfterBackup();
      return;
    }
    if (!mainWindow) {
      return;
    }
    if (mainWindow.isMinimized()) {
      mainWindow.restore();
    }
    mainWindow.focus();
  });

  app.whenReady().then(async () => {
    app.setAppUserModelId(APP_ID);
    registerAppProtocol();
    await applyProxy(readProxyUrl());
    session.defaultSession.setPermissionCheckHandler((_webContents, permission, requestingOrigin) =>
      permission === "media" && requestingOrigin.startsWith(`${APP_SCHEME}://${APP_HOST}`));
    session.defaultSession.setPermissionRequestHandler((webContents, permission, callback) => {
      const allowed = permission === "media" && webContents.getURL().startsWith(`${APP_SCHEME}://${APP_HOST}/`);
      callback(allowed);
    });
    createMainWindow();

    if (dataPathSetup.status === "migrated") {
      const migrationDetail = isSamePath(dataPathSetup.legacyDataPath, DESKTOP_ROOT)
        ? "早期版本的根目录副本仍被保留。请确认日志和资源正常后，再按需清理根目录中的旧缓存文件；不要删除 Data 或 App 目录。"
        : `旧数据仍保留在 ${dataPathSetup.legacyDataPath}，请确认日志和资源正常后再手动删除该目录。`;
      void dialog.showMessageBox(mainWindow, {
        type: "info",
        title: "数据已迁移到 D 盘",
        message: "旧桌面版数据已经复制到 D:\\StudyJournal\\Data。",
        detail: migrationDetail,
      });
    } else if (dataPathSetup.status === "failed") {
      void dialog.showMessageBox(mainWindow, {
        type: "warning",
        title: "D 盘数据迁移未完成",
        message: "为了保护你的日志，本次继续使用旧的 C 盘数据目录。",
        detail: `请检查 D:\\StudyJournal\\Data 的可用空间和权限后重新打开应用。错误信息：${dataPathSetup.error}`,
      });
    }

    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        createMainWindow();
      }
    });
  });

  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") {
      app.quit();
    }
  });
}
