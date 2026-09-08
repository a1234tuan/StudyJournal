export {};

declare global {
  interface StudyJournalDesktopBackupFile {
    path: string;
    displayName: string;
    size: number;
    lastModified?: number;
  }

  interface Window {
    studyJournalDesktop?: Readonly<{
      isDesktop: true;
      auth: Readonly<{
        signInWithGoogle: () => Promise<{ idToken: string }>;
      }>;
      ocr: Readonly<{
        recognize: (options: {
          data: string;
          fileName: string;
          mimeType: string;
          token: string;
        }) => Promise<{ jobId?: string; text: string }>;
      }>;
      backup: Readonly<{
        bindFolder: () => Promise<{ folderName: string }>;
        getStatus: () => Promise<{ bound: boolean; folderName?: string }>;
        ensureRepository: () => Promise<{ folderName?: string; repositoryName: string }>;
        listFiles: (directory: string) => Promise<StudyJournalDesktopBackupFile[]>;
        beginWrite: (path: string) => Promise<{ sessionId: string; path: string }>;
        appendWrite: (sessionId: string, data: string) => Promise<{ size: number }>;
        finishWrite: (sessionId: string) => Promise<{ path: string; displayName: string; size: number; lastModified?: number }>;
        cancelWrite: (sessionId: string) => Promise<void>;
        readText: (path: string) => Promise<{ text: string; size: number }>;
        readChunk: (path: string, offset: number, length: number) => Promise<{ data: string; bytesRead: number; done: boolean }>;
        deleteFile: (path: string) => Promise<void>;
      }>;
      tts: Readonly<{
        synthesize: (options: {
          providerId: string;
          apiKey: string;
          apiKeySecondary?: string;
          model: string;
          voiceId: string;
          text: string;
          format: "mp3";
          region?: string;
          languageCode?: string;
        }) => Promise<{ data: string; mimeType?: string }>;
      }>;
      voice: Readonly<{
        getCapabilities: () => Promise<{ rendererCapture: boolean; pcmSampleRates: number[]; protocolProxy: boolean }>;
        setCaptureActive: (active: boolean) => Promise<{ active: boolean }>;
        onSuspendRequested: (listener: (reason: "minimize" | "focus-lost") => void) => () => void;
      }>;
      proxy: Readonly<{
        getProxy: () => Promise<{ proxyUrl: string }>;
        setProxy: (proxyUrl: string) => Promise<{ proxyUrl: string }>;
        testFirebaseStorage: () => Promise<{ proxy: string; status: number }>;
      }>;
      firebaseStorage: Readonly<{
        download: (uid: string, objectPath: string, idToken: string) => Promise<{ data: ArrayBuffer; contentType: string }>;
        exists: (uid: string, objectPath: string, idToken: string) => Promise<boolean>;
        upload: (uid: string, objectPath: string, idToken: string, data: ArrayBuffer, contentType: string) => Promise<void>;
      }>;
      onBackupFlushRequested: (listener: (reason: "minimize" | "close") => Promise<void> | void) => () => void;
    }>;
  }
}
