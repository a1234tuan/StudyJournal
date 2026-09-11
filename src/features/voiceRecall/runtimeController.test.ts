import Dexie from "dexie";
import { IDBKeyRange, indexedDB } from "fake-indexeddb";
import { afterEach, describe, expect, it } from "vitest";

import { StudyJournalDatabase } from "../../db/database";
import type { VoiceCaptureAdapter } from "./contracts";
import { VoiceRecallRepository } from "./repository";
import { VoiceRecallRuntimeController } from "./runtimeController";

Dexie.dependencies.indexedDB = indexedDB;
Dexie.dependencies.IDBKeyRange = IDBKeyRange;

const names = new Set<string>();

const openRuntime = async () => {
  const name = `voice-runtime-${crypto.randomUUID()}`;
  names.add(name);
  const database = new StudyJournalDatabase(name);
  await database.open();
  const repository = new VoiceRecallRepository(database);
  return { database, runtime: new VoiceRecallRuntimeController(repository) };
};

const request = {
  mode: "scope-practice" as const,
  source: { kind: "review-card" as const, recordIds: ["record-1"] },
  inputMode: "auto-half-duplex" as const,
};

afterEach(async () => {
  await Promise.all([...names].map((name) => Dexie.delete(name)));
  names.clear();
});

describe("VoiceRecallRuntimeController", () => {
  it("persists a paused checkpoint and restores it without opening capture", async () => {
    const { database, runtime } = await openRuntime();
    const id = await runtime.createSession(request);
    runtime.dispatch({ type: "OPEN_PREFLIGHT" });
    runtime.dispatch({ type: "CONFIRM_DISCLOSURE", confirmed: true });
    runtime.dispatch({ type: "CONNECT" });
    runtime.dispatch({ type: "CONNECTED" });
    await runtime.pause();
    expect(await database.voiceRecallSessions.get(id)).toMatchObject({ status: "paused", checkpoint: { inputMode: "auto-half-duplex" } });

    const restored = new VoiceRecallRuntimeController(new VoiceRecallRepository(database));
    await restored.restoreSession(id);
    expect(restored.snapshot).toMatchObject({ status: "paused", captureRequested: false, inputMode: "auto-half-duplex" });
    database.close();
  });

  it("starts a fresh cancellation tree for the next session", async () => {
    const { database, runtime } = await openRuntime();
    const signals: AbortSignal[] = [];
    const capture: VoiceCaptureAdapter = {
      id: "test",
      requestPermission: async () => "granted",
      start: async function* (_options, signal) {
        signals.push(signal);
        await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
      },
      pause: async () => undefined,
      stop: async () => undefined,
    };
    const options = {
      inputMode: "auto-half-duplex" as const,
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
      preferredFormat: { encoding: "pcm-s16le" as const, sampleRate: 16_000, channelCount: 1 as const },
    };

    await runtime.createSession(request);
    runtime.dispatch({ type: "OPEN_PREFLIGHT" });
    runtime.dispatch({ type: "CONFIRM_DISCLOSURE", confirmed: true });
    runtime.dispatch({ type: "CONNECT" });
    runtime.dispatch({ type: "CONNECTED" });
    await runtime.startCapture(capture, options, () => undefined);
    await Promise.resolve();
    await runtime.end();
    await runtime.createSession(request);
    runtime.dispatch({ type: "OPEN_PREFLIGHT" });
    runtime.dispatch({ type: "CONFIRM_DISCLOSURE", confirmed: true });
    runtime.dispatch({ type: "CONNECT" });
    runtime.dispatch({ type: "CONNECTED" });
    await runtime.startCapture(capture, options, () => undefined);
    await Promise.resolve();

    expect(signals).toHaveLength(2);
    expect(signals[0].aborted).toBe(true);
    expect(signals[1].aborted).toBe(false);
    await runtime.end();
    database.close();
  });

  it("starts a fresh cancellation tree when restoring after another session ended", async () => {
    const { database, runtime: sourceRuntime } = await openRuntime();
    const resumableId = await sourceRuntime.createSession(request);
    sourceRuntime.dispatch({ type: "OPEN_PREFLIGHT" });
    sourceRuntime.dispatch({ type: "CONFIRM_DISCLOSURE", confirmed: true });
    sourceRuntime.dispatch({ type: "CONNECT" });
    sourceRuntime.dispatch({ type: "CONNECTED" });
    await sourceRuntime.pause();

    const runtime = new VoiceRecallRuntimeController(new VoiceRecallRepository(database));
    await runtime.createSession({ ...request, source: { kind: "free-topic" } });
    await runtime.end();
    await runtime.restoreSession(resumableId);
    expect(runtime.snapshot?.status).toBe("paused");
    runtime.dispatch({ type: "RESUME" });
    runtime.dispatch({ type: "CONNECTED" });

    let restoredSignal: AbortSignal | undefined;
    const capture: VoiceCaptureAdapter = {
      id: "test-restore",
      requestPermission: async () => "granted",
      start: async function* (_options, signal) {
        restoredSignal = signal;
        await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
      },
      pause: async () => undefined,
      stop: async () => undefined,
    };
    const options = {
      inputMode: "auto-half-duplex" as const,
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
      preferredFormat: { encoding: "pcm-s16le" as const, sampleRate: 16_000, channelCount: 1 as const },
    };

    await runtime.startCapture(capture, options, () => undefined);
    await Promise.resolve();
    expect(restoredSignal?.aborted).toBe(false);
    await runtime.end();
    database.close();
  });
});
