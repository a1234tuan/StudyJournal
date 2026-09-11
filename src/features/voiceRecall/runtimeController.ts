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
import { recordVoiceStage, stageFailure } from "./diagnostics";
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
  private captureController?: AbortController;
  private operationEpoch = 0;
  currentOperationId = "";
  productionSession?: import("./productionPipeline").ProductionVoiceSession;

  get operationGeneration() { return this.operationEpoch; }
  get captureDiagnostics() { return this.capture?.diagnostics ?? {}; }

  isCurrentOperation(generation: number) { return generation === this.operationEpoch; }

  async cancelActiveTurn() {
    this.operationEpoch += 1;
    this.cancellation.cancelTurn("user-cancelled");
    await Promise.all([this.stopCapture(), this.playback.interrupt()]);
  }
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

  async attachProductionSession(production: import("./productionPipeline").ProductionVoiceSession) {
    if (!this.session) throw new Error("当前没有活动会话");
    this.productionSession = production;
    this.session = { ...this.session, provider: production.provider ?? this.session.provider };
    await this.persistNow();
  }

  async updateMemory(memory: Partial<VoiceRecallStructuredMemory>) {
    if (!this.session) throw new Error("当前没有活动的语音复述会话");
    this.session = { ...this.session, memory: { ...this.session.memory, ...memory } };
    await this.persistNow();
  }

  async commitTurn(turn: VoiceRecallTurnLocal, generation = this.operationEpoch) {
    if (!this.session || turn.sessionId !== this.session.id) throw new Error("语音复述轮次与当前会话不匹配");
    recordVoiceStage(turn.operationId, "storage", "start");
    try { this.session = await this.repository.commitTurn(turn, turn.confirmedText ?? "", () => this.isCurrentOperation(generation)); }
    catch (error) { recordVoiceStage(turn.operationId, "storage", "failed"); throw stageFailure("storage", error); }
    recordVoiceStage(turn.operationId, "storage", "completed");
    return turn;
  }

  dispatch(action: VoiceRecallAction) {
    if (!this.state) throw new Error("当前没有活动的语音复述会话");
    if (action.type === "CANCEL_TURN" || action.type === "INTERRUPT_AND_LISTEN") {
      void this.cancelActiveTurn();
    }
    if (action.type === "SET_USER_MUTED" && action.muted) void this.stopCapture();
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
    const generation = this.operationEpoch;
    await this.stopCapture();
    if (!this.isCurrentOperation(generation) || this.state?.status !== "listening" || this.state.userMuted || this.state.systemCaptureGate) return;
    await this.focus.acquire();
    if (!this.isCurrentOperation(generation) || this.state?.status !== "listening" || this.state.userMuted || this.state.systemCaptureGate) return;
    this.capture = adapter;
    this.captureController = new AbortController();
    const turnSignal = this.captureController.signal;
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
    this.captureController?.abort("capture-stopped");
    this.captureController = undefined;
    const capture = this.capture;
    this.capture = undefined;
    this.captureTask = undefined;
    await capture?.stop();
    // Android voice-capture focus is only needed while the microphone is open.
    // Keeping it across ASR/LLM/TTS lets playback compete with capture focus.
    await this.focus.release();
  }

  /** Swap in the real audio sink once the TTS provider (and its encoding) is known. */
  setPlaybackSink(sink: VoicePlaybackSink) {
    const previous = this.playback;
    this.playback = new VoicePlaybackQueue(sink);
    void previous.interrupt();
  }

  enqueueAudio(chunk: Uint8Array, segmentId?: string) {
    return this.playback.enqueue(chunk);
  }

  interruptPlayback() {
    return this.playback.interrupt();
  }

  async waitForPlayback() {
    try { await this.playback.waitUntilIdle(); } catch (error) { throw stageFailure("playback", error); }
  }

  /** Phase 1 of a turn: captured audio -> confirmed transcript. */
  private async withUsage<Result extends { usage: import("./providerRuntime").VoiceUsageTotals }>(
    sessionId: string,
    execute: (operationId: string, observe: (usage: Partial<import("./providerRuntime").VoiceUsageTotals>) => void) => Promise<Result>,
  ) {
    const operationId = crypto.randomUUID();
    this.currentOperationId = operationId;
    let observed: Partial<import("./providerRuntime").VoiceUsageTotals> = {};
    let pending = Promise.resolve();
    let persistenceError: unknown;
    const observe = (patch: Partial<import("./providerRuntime").VoiceUsageTotals>) => {
      observed = { ...observed, ...patch };
      const snapshot = { ...observed };
      pending = pending.then(() => this.repository.recordUsage(sessionId, operationId, snapshot)).catch((error) => { persistenceError = error; });
    };
    try {
      const result = await execute(operationId, observe);
      observe(Object.fromEntries(Object.entries(result.usage).filter(([, value]) => value > 0)));
      return { ...result, operationId, observedUsage: observed };
    } finally {
      await pending;
      if (persistenceError) throw stageFailure("storage", persistenceError);
    }
  }

  async transcribeTurn(input: {
    pipeline: VoiceRecallPipeline;
    frames: AsyncIterable<VoiceAudioFrame>;
    format: AsrStreamRequest["format"];
    onEvent?: (event: AsrStreamEvent) => void;
  }) {
    if (!this.session) throw new Error("当前没有活动的语音复述会话");
    const turnSignal = this.cancellation.beginTurn();
    const sessionId = this.session.id;
    const result = await this.withUsage(sessionId, (operationId, onUsage) => input.pipeline.transcribe({
      sessionId,
      turnId: crypto.randomUUID(),
      operationId,
      onUsage,
      frames: input.frames,
      format: input.format,
      signal: turnSignal,
      onEvent: (event) => { if (!turnSignal.aborted) input.onEvent?.(event); },
    }));
    if (turnSignal.aborted) throw new DOMException("语音轮次已取消", "AbortError");
    return result;
  }

  /** Phase 2 of a turn: confirmed transcript -> streamed reply + real playback. */
  async respondTurn(input: {
    rate?: number;
    pipeline: VoiceRecallPipeline;
    messages: readonly VoiceTeacherMessage[];
    voice: string;
    events?: Pick<VoiceRecallPipelineEvents, "onTeacherToken" | "onAudio">;
  }) {
    if (!this.session || !this.state) throw new Error("当前没有活动的语音复述会话");
    const operationGeneration = this.operationEpoch;
    await this.playback.interrupt();
    if (!this.isCurrentOperation(operationGeneration) || !this.session) throw new DOMException("轮次已取消", "AbortError");
    const turnSignal = this.cancellation.beginTurn();
    const sessionId = this.session.id;
    const generation = this.state.generation;
    const result = await this.withUsage(sessionId, (operationId, onUsage) => input.pipeline.respond({
      sessionId,
      turnId: crypto.randomUUID(),
      operationId,
      messages: input.messages,
      rate: input.rate,
      voice: input.voice,
      generation,
      signal: turnSignal,
      events: {
        waitForAudioCapacity: () => this.playback.waitForCapacity(2),
        onUsage,
        onTeacherToken: (token) => { if (!turnSignal.aborted) input.events?.onTeacherToken?.(token); },
        onAudio: (chunk, generation, segmentId) => { if (!turnSignal.aborted) return input.events?.onAudio?.(chunk, generation, segmentId); },
      },
    }));
    if (turnSignal.aborted) throw new DOMException("语音轮次已取消", "AbortError");
    return result;
  }

  async pause() {
    if (!this.state || this.state.status === "paused" || this.state.status === "ended") return;
    await this.cancelActiveTurn();
    this.dispatch({ type: "PAUSE" });
    await this.focus.release();
    await this.persistNow();
  }

  async end() {
    if (!this.state || !this.session) return;
    await this.cancelActiveTurn();
    if (this.state.status !== "ending" && this.state.status !== "ended") this.dispatch({ type: "END" });
    if (this.state.status === "ending") this.dispatch({ type: "END_COMPLETE" });
    this.session.endedAt = new Date().toISOString();
    await this.persistNow();
    this.focus.stop();
    await this.focus.release();
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
