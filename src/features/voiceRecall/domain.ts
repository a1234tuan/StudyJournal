export type VoiceRecallSessionMode = "task-bound" | "scope-practice" | "free-topic";

export type VoiceRecallInputMode = "auto-half-duplex" | "push-to-talk" | "tap-to-record";

export type VoiceRecallStatus =
  | "idle"
  | "preflight"
  | "connecting"
  | "listening"
  | "finalizing-asr"
  | "thinking"
  | "speaking"
  | "paused"
  | "reconnecting"
  | "ending"
  | "failed"
  | "ended";

export interface VoiceRecallState {
  status: VoiceRecallStatus;
  sessionMode: VoiceRecallSessionMode;
  inputMode: VoiceRecallInputMode;
  userMuted: boolean;
  systemCaptureGate: boolean;
  captureRequested: boolean;
  preflightConfirmed: boolean;
  transcript: string;
  teacherText: string;
  errorCode?: string;
  generation: number;
}

export type VoiceRecallAction =
  | { type: "OPEN_PREFLIGHT" }
  | { type: "SET_SESSION_MODE"; mode: VoiceRecallSessionMode }
  | { type: "SET_INPUT_MODE"; mode: VoiceRecallInputMode }
  | { type: "CONFIRM_DISCLOSURE"; confirmed: boolean }
  | { type: "CONNECT" }
  | { type: "CONNECTED" }
  | { type: "SET_CAPTURE_REQUESTED"; requested: boolean }
  | { type: "SET_USER_MUTED"; muted: boolean }
  | { type: "SET_SYSTEM_CAPTURE_GATE"; gated: boolean }
  | { type: "SUBMIT_CAPTURE" }
  | { type: "ASR_FINALIZED"; transcript: string }
  | { type: "LLM_REPLIED"; teacherText: string }
  | { type: "PLAYBACK_FINISHED" }
  | { type: "INTERRUPT_AND_LISTEN" }
  | { type: "CANCEL_TURN" }
  | { type: "PAUSE" }
  | { type: "RESUME" }
  | { type: "FAIL"; code: string }
  | { type: "RETRY" }
  | { type: "END" }
  | { type: "END_COMPLETE" };

export class VoiceRecallTransitionError extends Error {
  constructor(status: VoiceRecallStatus, action: VoiceRecallAction["type"]) {
    super(`Invalid voice recall transition: ${status} -> ${action}`);
    this.name = "VoiceRecallTransitionError";
  }
}

export const createVoiceRecallState = (
  sessionMode: VoiceRecallSessionMode = "scope-practice",
): VoiceRecallState => ({
  status: "idle",
  sessionMode,
  inputMode: "auto-half-duplex",
  userMuted: false,
  systemCaptureGate: false,
  captureRequested: false,
  preflightConfirmed: false,
  transcript: "",
  teacherText: "先不看笔记，说说为什么间隔复习比连续重复更有效？",
  generation: 0,
});

const activeStatuses = new Set<VoiceRecallStatus>([
  "connecting",
  "listening",
  "finalizing-asr",
  "thinking",
  "speaking",
  "reconnecting",
  "failed",
]);

const inputModeStatuses = new Set<VoiceRecallStatus>(["idle", "preflight", "paused"]);

export const isVoiceCaptureActive = (state: VoiceRecallState): boolean =>
  state.captureRequested && !state.userMuted && !state.systemCaptureGate;

export const transitionVoiceRecallState = (
  state: VoiceRecallState,
  action: VoiceRecallAction,
): VoiceRecallState => {
  switch (action.type) {
    case "OPEN_PREFLIGHT":
      if (state.status !== "idle") break;
      return { ...state, status: "preflight" };
    case "SET_SESSION_MODE":
      if (state.status !== "idle" && state.status !== "preflight") break;
      return { ...state, sessionMode: action.mode };
    case "SET_INPUT_MODE":
      if (!inputModeStatuses.has(state.status)) break;
      return { ...state, inputMode: action.mode, captureRequested: false };
    case "CONFIRM_DISCLOSURE":
      if (state.status !== "preflight") break;
      return { ...state, preflightConfirmed: action.confirmed };
    case "CONNECT":
      if (state.status !== "preflight" || !state.preflightConfirmed) break;
      return { ...state, status: "connecting", errorCode: undefined };
    case "CONNECTED":
      if (state.status !== "connecting" && state.status !== "reconnecting") break;
      return {
        ...state,
        status: "listening",
        captureRequested: state.inputMode === "auto-half-duplex",
        systemCaptureGate: false,
        errorCode: undefined,
      };
    case "SET_CAPTURE_REQUESTED":
      if (state.status !== "listening") break;
      return { ...state, captureRequested: action.requested };
    case "SET_USER_MUTED":
      if (state.status === "ended") break;
      return { ...state, userMuted: action.muted };
    case "SET_SYSTEM_CAPTURE_GATE":
      if (state.status === "ended") break;
      return { ...state, systemCaptureGate: action.gated };
    case "SUBMIT_CAPTURE":
      if (state.status !== "listening" || !state.captureRequested) break;
      return { ...state, status: "finalizing-asr", captureRequested: false };
    case "ASR_FINALIZED":
      if (state.status !== "finalizing-asr") break;
      return { ...state, status: "thinking", transcript: action.transcript };
    case "LLM_REPLIED":
      if (state.status !== "thinking") break;
      return {
        ...state,
        status: "speaking",
        teacherText: action.teacherText,
        systemCaptureGate: true,
        generation: state.generation + 1,
      };
    case "PLAYBACK_FINISHED":
      if (state.status !== "speaking") break;
      return {
        ...state,
        status: "listening",
        systemCaptureGate: false,
        captureRequested: state.inputMode === "auto-half-duplex" && !state.userMuted,
      };
    case "INTERRUPT_AND_LISTEN":
      if (state.status !== "speaking") break;
      return {
        ...state,
        status: "listening",
        systemCaptureGate: false,
        captureRequested: !state.userMuted,
        generation: state.generation + 1,
      };
    case "CANCEL_TURN":
      if (state.status !== "finalizing-asr" && state.status !== "thinking") break;
      return {
        ...state,
        status: "listening",
        captureRequested: state.inputMode === "auto-half-duplex" && !state.userMuted,
        generation: state.generation + 1,
      };
    case "PAUSE":
      if (!activeStatuses.has(state.status)) break;
      return {
        ...state,
        status: "paused",
        captureRequested: false,
        systemCaptureGate: false,
        generation: state.generation + 1,
      };
    case "RESUME":
      if (state.status !== "paused") break;
      return { ...state, status: "reconnecting", errorCode: undefined };
    case "FAIL":
      if (!activeStatuses.has(state.status)) break;
      return {
        ...state,
        status: "failed",
        captureRequested: false,
        systemCaptureGate: false,
        errorCode: action.code,
        generation: state.generation + 1,
      };
    case "RETRY":
      if (state.status !== "failed") break;
      return { ...state, status: "reconnecting", errorCode: undefined };
    case "END":
      if (state.status === "ended" || state.status === "ending") break;
      return {
        ...state,
        status: "ending",
        captureRequested: false,
        systemCaptureGate: false,
        generation: state.generation + 1,
      };
    case "END_COMPLETE":
      if (state.status !== "ending") break;
      return { ...state, status: "ended" };
  }
  throw new VoiceRecallTransitionError(state.status, action.type);
};
