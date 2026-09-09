import type { VoiceAudioFrame, VoiceCaptureAdapter, VoiceCaptureOptions, VoiceRecallSessionRequest } from "./contracts";
import { VoicePlaybackQueue, type VoicePlaybackSink } from "./playbackQueue";
import { VoiceRecallCancellationTree } from "./cancellation";
import { VoiceAudioFocusManager } from "./audioFocus";
import { createVoiceRecallState, transitionVoiceRecallState, type VoiceRecallAction, type VoiceRecallState } from "./domain";
import type { VoiceRecallSessionLocal, VoiceRecallStructuredMemory, VoiceRecallTurnLocal } from "./localTypes";
import { VoiceRecallRepository, voiceRecallRepository } from "./repository";
import { WebAudioPlaybackSink } from "./webAudioPlaybackSink";

type RuntimeListener = (state: VoiceRecallState | undefined) => void;

const silentSink: VoicePlaybackSink = { play: async () => undefined, stop: () => undefined };

export const createVoiceRecallRuntimeSink = (): VoicePlaybackSink => {
  if (typeof window !== "undefined" && (window.AudioContext ?? (window as { webkitAudioContext?: unknown }).webkitAudioContext)) {
    return new WebAudioPlaybackSink();
  }
  return silentSink;
};

export class VoiceRecallRuntimeController {
  private session?: VoiceRecallSessionLocal;
  private state?: VoiceRecallState;
  private readonly listeners = new Set<RuntimeListener>();
  private cancellation = new VoiceRecallCancellationTree();
  private readonly playback: VoicePlaybackQueue;
  private capture?: VoiceCaptureAdapter;
  private persistTimer?: ReturnType<typeof setTimeout>;
  private captureTask?: Promise<void>;
  private readonly focus: VoiceAudioFocusManager;

  constructor(
    private readonly repository: VoiceRecallRepository = voiceRecallRepository,
    playbackSink: VoicePlaybackSink = silentSink,
  ) {
    this.playback = new VoicePlaybackQueue(playbackSink);
    this.focus = new VoiceAudioFocusManager(() => { void this.pause(); });
  }

  get snapshot() {
    return this.state;
  }

  get activeSessionId() {
    return this.session?.id;
  }

  subscribe(listener: RuntimeListener) {
    this.listeners.add(listener);
    listener(this.state);
    return () => this.listeners.delete(listener);
  }

  async initialize() {
    await this.repository.repairInterruptedSessions();
    return this.repository.listResumableSessions();
  }

  async createSession(request: VoiceRecallSessionRequest, now = new Date().toISOString()) {
    if (this.session) await this.end();
    this.cancellation = new VoiceRecallCancellationTree();
    const id = crypto.randomUUID();
    this.state = createVoiceRecallState(request.mode);
    this.state = transitionVoiceRecallState(this.state, { type: "SET_INPUT_MODE", mode: request.inputMode });
    this.session = {
      id,
      mode: request.mode,
      sourceKind: request.source.kind,
      source: structuredClone(request.source),
      sourceRecordIds: [...(request.source.recordIds ?? [])],
      sourceTaskId: request.source.taskId,
      status: this.state.status,
      provider: {},
      memory: { learningGoal: "", coveredPoints: [], misconceptions: [], pendingTopics: [] },
      checkpoint: { nextSequence: 0, elapsedMs: 0, inputMode: request.inputMode, userMuted: false },
      createdAt: now,
      updatedAt: now,
    };
    await this.repository.putSession(this.session);
    this.focus.start();
    this.emit();
    return id;
  }

  async restoreSession(id: string) {
    if (this.session) await this.end();
    const session = await this.repository.getSession(id);
    if (!session || session.sourceUnavailable || ["completed", "ending", "ended"].includes(session.status)) {
      throw new Error("该语音复述会话已无法恢复");
    }
    this.cancellation = new VoiceRecallCancellationTree();
    this.session = session;
    this.state = {
      ...createVoiceRecallState(session.mode),
      status: "paused",
      inputMode: session.checkpoint.inputMode,
      userMuted: session.checkpoint.userMuted,
      transcript: session.checkpoint.lastConfirmedText ?? "",
    };
    this.focus.start();
    this.emit();
  }

  async updateMemory(memory: Partial<VoiceRecallStructuredMemory>) {
    if (!this.session) throw new Error("当前没有活动的语音复述会话");
    this.session = { ...this.session, memory: { ...this.session.memory, ...memory } };
    await this.persistNow();
  }

  async commitTurn(turn: VoiceRecallTurnLocal) {
    if (!this.session || turn.sessionId !== this.session.id) throw new Error("语音复述轮次与当前会话不匹配");
    this.session = await this.repository.commitTurn(turn, turn.confirmedText ?? "");
    return turn;
  }

  dispatch(action: VoiceRecallAction) {
    if (!this.state) throw new Error("当前没有活动的语音复述会话");
    this.state = transitionVoiceRecallState(this.state, action);
    this.schedulePersist();
    this.emit();
    return this.state;
  }

  async startCapture(adapter: VoiceCaptureAdapter, options: VoiceCaptureOptions, onFrame: (frame: VoiceAudioFrame) => void) {
    if (!this.state || !this.session) throw new Error("当前没有活动的语音复述会话");
    await this.stopCapture();
    this.capture = adapter;
    const turnSignal = this.cancellation.beginTurn();
    this.captureTask = (async () => {
      for await (const frame of adapter.start(options, turnSignal)) {
        if (turnSignal.aborted) break;
        onFrame(frame);
      }
    })();
    this.captureTask.catch(() => undefined);
  }

  async stopCapture() {
    this.cancellation.cancelTurn("capture-stopped");
    await this.capture?.stop();
    this.capture = undefined;
    await this.captureTask?.catch(() => undefined);
    this.captureTask = undefined;
  }

  /** Begins a turn-scoped abort signal linked to the session. Cancelling any
   * prior turn. The pipeline feeds this to ASR/LLM/TTS so interrupt/end can
   * abort an in-flight turn. */
  beginTurnSignal(): AbortSignal {
    return this.cancellation.beginTurn();
  }

  /** Aborts the active turn signal (ASR/LLM/TTS streaming) without touching
   * the state machine. */
  cancelActiveTurn(reason: unknown = "turn-cancelled") {
    this.cancellation.cancelTurn(reason);
  }

  enqueueAudio(chunk: Uint8Array, generation?: number): boolean {
    return this.playback.enqueue(chunk, generation);
  }

  interruptPlayback(): Promise<number> {
    return this.playback.interrupt();
  }

  awaitPlaybackDrained(): Promise<void> {
    return this.playback.waitUntilIdle();
  }

  get playbackGeneration() {
    return this.playback.currentGeneration;
  }

  async pause() {
    if (!this.state || this.state.status === "paused" || this.state.status === "ended") return;
    await Promise.all([this.stopCapture(), this.playback.interrupt()]);
    this.dispatch({ type: "PAUSE" });
    await this.persistNow();
  }

  async end() {
    if (!this.state || !this.session) return;
    await Promise.all([this.stopCapture(), this.playback.interrupt()]);
    if (this.state.status !== "ending" && this.state.status !== "ended") this.dispatch({ type: "END" });
    if (this.state.status === "ending") this.dispatch({ type: "END_COMPLETE" });
    this.session.endedAt = new Date().toISOString();
    await this.persistNow();
    this.focus.stop();
    this.cancellation.cancelSession();
    this.session = undefined;
  }

  disposeView() {
    return this.pause();
  }

  private emit() {
    for (const listener of this.listeners) listener(this.state);
  }

  private schedulePersist() {
    if (this.persistTimer) clearTimeout(this.persistTimer);
    this.persistTimer = setTimeout(() => { void this.persistNow(); }, 300);
  }

  private async persistNow() {
    if (!this.session || !this.state) return;
    if (this.persistTimer) clearTimeout(this.persistTimer);
    this.persistTimer = undefined;
    this.session = {
      ...this.session,
      status: this.state.status,
      checkpoint: {
        ...this.session.checkpoint,
        inputMode: this.state.inputMode,
        userMuted: this.state.userMuted,
        lastConfirmedText: this.state.transcript || this.session.checkpoint.lastConfirmedText,
      },
      updatedAt: new Date().toISOString(),
    };
    let attempt = 0;
    while (attempt < 3) {
      try {
        await this.repository.putSession(this.session);
        return;
      } catch (error) {
        attempt += 1;
        if (attempt >= 3) throw error;
        await new Promise((resolve) => setTimeout(resolve, attempt * 50));
      }
    }
  }
}

export const voiceRecallRuntime = new VoiceRecallRuntimeController(voiceRecallRepository, createVoiceRecallRuntimeSink());
