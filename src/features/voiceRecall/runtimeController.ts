import type {
  AsrStreamEvent,
  AsrStreamRequest,
  VoiceAudioFrame,
  VoiceCaptureAdapter,
  VoiceCaptureOptions,
  VoiceRecallSessionRequest,
  VoiceTeacherMessage,
} from "./contracts";
import { VoicePlaybackQueue, type VoicePlaybackSink } from "./playbackQueue";
import { VoiceRecallCancellationTree } from "./cancellation";
import { VoiceAudioFocusManager } from "./audioFocus";
import { createVoiceRecallState, transitionVoiceRecallState, type VoiceRecallAction, type VoiceRecallState } from "./domain";
import type { VoiceRecallSessionLocal, VoiceRecallStructuredMemory, VoiceRecallTurnLocal } from "./localTypes";
import type { VoiceRecallPipeline, VoiceRecallPipelineEvents } from "./pipeline";
import { VoiceRecallRepository, voiceRecallRepository } from "./repository";

type RuntimeListener = (state: VoiceRecallState | undefined) => void;

const silentSink: VoicePlaybackSink = { play: async () => undefined, stop: () => undefined };

export class VoiceRecallRuntimeController {
  private session?: VoiceRecallSessionLocal;
  private state?: VoiceRecallState;
  private readonly listeners = new Set<RuntimeListener>();
  private cancellation = new VoiceRecallCancellationTree();
  private playback: VoicePlaybackQueue;
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

  async startCapture(
    adapter: VoiceCaptureAdapter,
    options: VoiceCaptureOptions,
    onFrame: (frame: VoiceAudioFrame) => void,
    onError?: (error: unknown) => void,
  ) {
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
    // Surface a real capture failure (dead microphone) instead of swallowing it,
    // but ignore the abort we caused ourselves.
    this.captureTask.catch((error) => {
      if (turnSignal.aborted) return;
      onError?.(error);
    });
  }

  async stopCapture() {
    this.cancellation.cancelTurn("capture-stopped");
    await this.capture?.stop();
    this.capture = undefined;
    await this.captureTask?.catch(() => undefined);
    this.captureTask = undefined;
  }

  /** Swap in the real audio sink once the TTS provider (and its encoding) is known. */
  setPlaybackSink(sink: VoicePlaybackSink) {
    const previous = this.playback;
    this.playback = new VoicePlaybackQueue(sink);
    void previous.interrupt();
  }

  enqueueAudio(chunk: Uint8Array) {
    return this.playback.enqueue(chunk);
  }

  interruptPlayback() {
    return this.playback.interrupt();
  }

  waitForPlayback() {
    return this.playback.waitUntilIdle();
  }

  /** Phase 1 of a turn: captured audio -> confirmed transcript. */
  async transcribeTurn(input: {
    pipeline: VoiceRecallPipeline;
    frames: AsyncIterable<VoiceAudioFrame>;
    format: AsrStreamRequest["format"];
    onEvent?: (event: AsrStreamEvent) => void;
  }) {
    if (!this.session) throw new Error("当前没有活动的语音复述会话");
    const turnSignal = this.cancellation.beginTurn();
    return input.pipeline.transcribe({
      sessionId: this.session.id,
      turnId: crypto.randomUUID(),
      operationId: crypto.randomUUID(),
      frames: input.frames,
      format: input.format,
      signal: turnSignal,
      onEvent: input.onEvent,
    });
  }

  /** Phase 2 of a turn: confirmed transcript -> streamed reply + real playback. */
  async respondTurn(input: {
    pipeline: VoiceRecallPipeline;
    messages: readonly VoiceTeacherMessage[];
    voice: string;
    events?: Pick<VoiceRecallPipelineEvents, "onTeacherToken" | "onAudio">;
  }) {
    if (!this.session || !this.state) throw new Error("当前没有活动的语音复述会话");
    await this.playback.interrupt();
    const turnSignal = this.cancellation.beginTurn();
    return input.pipeline.respond({
      sessionId: this.session.id,
      turnId: crypto.randomUUID(),
      operationId: crypto.randomUUID(),
      messages: input.messages,
      voice: input.voice,
      generation: this.state.generation,
      signal: turnSignal,
      events: input.events,
    });
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

export const voiceRecallRuntime = new VoiceRecallRuntimeController();
