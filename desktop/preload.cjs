const { contextBridge, ipcRenderer } = require("electron");

const backupFlushListeners = new Set();
const voiceSuspendListeners = new Set();

ipcRenderer.on("study-journal:backup-flush-request", async (_event, payload) => {
  await Promise.allSettled(Array.from(backupFlushListeners).map((listener) => listener(payload.reason)));
  ipcRenderer.send("study-journal:backup-flush-complete", payload.requestId);
});

ipcRenderer.on("study-journal:voice-suspend", (_event, payload) => {
  for (const listener of voiceSuspendListeners) listener(payload.reason);
});

contextBridge.exposeInMainWorld("studyJournalDesktop", Object.freeze({
  isDesktop: true,
  auth: Object.freeze({
    signInWithGoogle: () => ipcRenderer.invoke("study-journal:google-sign-in"),
  }),
  ocr: Object.freeze({
    recognize: (options) => ipcRenderer.invoke("study-journal:desktop-ocr-recognize", options),
  }),
  backup: Object.freeze({
    bindFolder: () => ipcRenderer.invoke("study-journal:desktop-backup-bind"),
    getStatus: () => ipcRenderer.invoke("study-journal:desktop-backup-status"),
    ensureRepository: () => ipcRenderer.invoke("study-journal:desktop-backup-ensure"),
    listFiles: (directory) => ipcRenderer.invoke("study-journal:desktop-backup-list", directory),
    beginWrite: (path) => ipcRenderer.invoke("study-journal:desktop-backup-begin-write", path),
    appendWrite: (sessionId, data) => ipcRenderer.invoke("study-journal:desktop-backup-append-write", sessionId, data),
    finishWrite: (sessionId) => ipcRenderer.invoke("study-journal:desktop-backup-finish-write", sessionId),
    cancelWrite: (sessionId) => ipcRenderer.invoke("study-journal:desktop-backup-cancel-write", sessionId),
    readText: (path) => ipcRenderer.invoke("study-journal:desktop-backup-read-text", path),
    readChunk: (path, offset, length) => ipcRenderer.invoke("study-journal:desktop-backup-read-chunk", path, offset, length),
    deleteFile: (path) => ipcRenderer.invoke("study-journal:desktop-backup-delete", path),
  }),
  tts: Object.freeze({
    synthesize: (options) => ipcRenderer.invoke("study-journal:tts-synthesize", options),
  }),
  voice: Object.freeze({
    getCapabilities: () => ipcRenderer.invoke("study-journal:voice-capabilities"),
    setCaptureActive: (active) => ipcRenderer.invoke("study-journal:voice-capture-active", Boolean(active)),
    onSuspendRequested: (listener) => {
      voiceSuspendListeners.add(listener);
      return () => voiceSuspendListeners.delete(listener);
    },
  }),
  proxy: Object.freeze({
    getProxy: () => ipcRenderer.invoke("study-journal:get-proxy"),
    setProxy: (proxyUrl) => ipcRenderer.invoke("study-journal:set-proxy", proxyUrl),
    testFirebaseStorage: () => ipcRenderer.invoke("study-journal:test-firebase-storage"),
  }),
  firebaseStorage: Object.freeze({
    download: (uid, objectPath, idToken) => ipcRenderer.invoke("study-journal:firebase-storage-download", uid, objectPath, idToken),
    exists: (uid, objectPath, idToken) => ipcRenderer.invoke("study-journal:firebase-storage-exists", uid, objectPath, idToken),
    upload: (uid, objectPath, idToken, data, contentType) => ipcRenderer.invoke("study-journal:firebase-storage-upload", uid, objectPath, idToken, data, contentType),
  }),
  onBackupFlushRequested: (listener) => {
    backupFlushListeners.add(listener);
    return () => backupFlushListeners.delete(listener);
  },
}));
