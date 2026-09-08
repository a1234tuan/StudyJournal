import { describe, expect, it } from "vitest";

import {
  VoiceRecallTransitionError,
  createVoiceRecallState,
  isVoiceCaptureActive,
  transitionVoiceRecallState,
} from "./domain";

const startListening = () => {
  let state = createVoiceRecallState();
  state = transitionVoiceRecallState(state, { type: "OPEN_PREFLIGHT" });
  state = transitionVoiceRecallState(state, { type: "CONFIRM_DISCLOSURE", confirmed: true });
  state = transitionVoiceRecallState(state, { type: "CONNECT" });
  return transitionVoiceRecallState(state, { type: "CONNECTED" });
};

describe("voice recall state machine", () => {
  it("moves through one complete automatic turn", () => {
    let state = startListening();
    expect(isVoiceCaptureActive(state)).toBe(true);

    state = transitionVoiceRecallState(state, { type: "SUBMIT_CAPTURE" });
    state = transitionVoiceRecallState(state, { type: "ASR_FINALIZED", transcript: "主动回忆需要提取。" });
    state = transitionVoiceRecallState(state, { type: "LLM_REPLIED", teacherText: "继续比较两种练习。" });
    expect(state.status).toBe("speaking");
    expect(state.systemCaptureGate).toBe(true);

    state = transitionVoiceRecallState(state, { type: "PLAYBACK_FINISHED" });
    expect(state.status).toBe("listening");
    expect(state.systemCaptureGate).toBe(false);
    expect(state.captureRequested).toBe(true);
  });

  it("keeps user mute independent from playback capture gating", () => {
    let state = startListening();
    state = transitionVoiceRecallState(state, { type: "SET_USER_MUTED", muted: true });
    state = transitionVoiceRecallState(state, { type: "SET_CAPTURE_REQUESTED", requested: false });
    state = transitionVoiceRecallState(state, { type: "SET_CAPTURE_REQUESTED", requested: true });
    expect(isVoiceCaptureActive(state)).toBe(false);

    state = transitionVoiceRecallState(state, { type: "SUBMIT_CAPTURE" });
    state = transitionVoiceRecallState(state, { type: "ASR_FINALIZED", transcript: "答案" });
    state = transitionVoiceRecallState(state, { type: "LLM_REPLIED", teacherText: "反馈" });
    state = transitionVoiceRecallState(state, { type: "PLAYBACK_FINISHED" });
    expect(state.userMuted).toBe(true);
    expect(state.captureRequested).toBe(false);
  });

  it("invalidates a late playback generation when interrupted", () => {
    let state = startListening();
    state = transitionVoiceRecallState(state, { type: "SUBMIT_CAPTURE" });
    state = transitionVoiceRecallState(state, { type: "ASR_FINALIZED", transcript: "答案" });
    state = transitionVoiceRecallState(state, { type: "LLM_REPLIED", teacherText: "反馈" });
    const playbackGeneration = state.generation;
    state = transitionVoiceRecallState(state, { type: "INTERRUPT_AND_LISTEN" });
    expect(state.generation).toBeGreaterThan(playbackGeneration);
    expect(state.systemCaptureGate).toBe(false);
  });

  it("only permits input mode changes before a call or while paused", () => {
    let state = startListening();
    expect(() => transitionVoiceRecallState(state, { type: "SET_INPUT_MODE", mode: "push-to-talk" }))
      .toThrow(VoiceRecallTransitionError);
    state = transitionVoiceRecallState(state, { type: "PAUSE" });
    state = transitionVoiceRecallState(state, { type: "SET_INPUT_MODE", mode: "push-to-talk" });
    expect(state.inputMode).toBe("push-to-talk");
  });

  it("requires disclosure confirmation before connecting", () => {
    const state = transitionVoiceRecallState(createVoiceRecallState(), { type: "OPEN_PREFLIGHT" });
    expect(() => transitionVoiceRecallState(state, { type: "CONNECT" })).toThrow(VoiceRecallTransitionError);
  });

  it("allows a newly created session to be ended before preflight", () => {
    let state = transitionVoiceRecallState(createVoiceRecallState(), { type: "END" });
    state = transitionVoiceRecallState(state, { type: "END_COMPLETE" });
    expect(state.status).toBe("ended");
  });
});
