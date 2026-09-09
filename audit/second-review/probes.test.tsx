import "fake-indexeddb/auto";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import Dexie from "dexie";
import { IDBKeyRange, indexedDB } from "fake-indexeddb";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { StudyJournalDatabase, db } from "../../src/db/database";
import { DEFAULT_SETTINGS } from "../../src/db/defaults";
import type { VoiceRecallNavigationRoute } from "../../src/lib/tabNavigation";
import { VoiceRecallWorkspace } from "../../src/features/voiceRecall/VoiceRecallWorkspace";
import { VoiceRecallRuntimeController } from "../../src/features/voiceRecall/runtimeController";
import { VoiceRecallRepository } from "../../src/features/voiceRecall/repository";
import { VoiceRecallPipeline } from "../../src/features/voiceRecall/pipeline";
import { MockAsrStreamAdapter, MockLlmStreamAdapter, MockTtsStreamAdapter } from "../../src/features/voiceRecall/mockProviders";
import { createAliyunAsrTransport, type VoiceSocket } from "../../src/features/voiceRecall/aliyunAsrTransport";
import { BUILT_IN_ASR_PROFILES } from "../../src/features/voiceRecall/providerProfiles";
import { reviewAnnotationRepository } from "../../src/features/reviewAnnotations/repository";
import type { ReviewAnnotationDraft } from "../../src/features/reviewAnnotations/domain";
import { createBridgeVoiceSocketFactory, type VoiceSocketBridgeEvent } from "../../src/features/voiceRecall/bridgeVoiceSocket";
import { AdaptiveReviewPage } from "../../src/features/reviewCoach/AdaptiveReviewPage";
import { coachTestTask, completeCoachTestSnapshot } from "../../src/features/reviewCoach/reviewCoachTestFixtures";
import { createProductionVoiceSession } from "../../src/features/voiceRecall/productionPipeline";

Dexie.dependencies.indexedDB = indexedDB;
Dexie.dependencies.IDBKeyRange = IDBKeyRange;
const resources: Array<{ database: StudyJournalDatabase; runtime: VoiceRecallRuntimeController }> = [];
const usage = { asrSeconds: 0, llmInputTokens: 1, llmOutputTokens: 1, ttsCharacters: 1 };

afterEach(async () => {
  cleanup();
  vi.useRealTimers();
  for (const resource of resources.splice(0)) {
    await resource.runtime.end();
    resource.database.close();
    await Dexie.delete(resource.database.name);
  }
  localStorage.clear();
  vi.restoreAllMocks();
});

describe("Second audit: credential and accounting integration", () => {
  it("R10 resolves a user-created Fish profile credential from TTS settings", async () => {
    const stamp = new Date().toISOString();
    const provider = { id: "audit-llm", providerName: "Audit LLM", baseUrl: "https://unused.invalid", model: "audit", temperature: 0, maxTokens: 320 };
    const tts = { id: "audit-fish-user-profile", providerId: "fish-audio" as const, providerName: "Fish Audio", model: "s2.1", voice: "audit-voice" };
    const ids = ["voice-asr-aliyun", provider.id, tts.id];
    await db.aiSecrets.bulkPut(ids.map((id) => ({ id, apiKey: "test-only-not-real", updatedAt: stamp })));
    try {
      await expect(createProductionVoiceSession({ settings: { ...DEFAULT_SETTINGS, ai: { presets: [], currentProviderId: provider.id, providers: [provider] }, tts: { currentProviderId: tts.id, providers: [tts] } }, platform: "desktop", asrTransportFactory: () => ({ open: async () => { throw new Error("not used"); } }) })).resolves.toHaveProperty("pipeline");
    } finally {
      await db.aiSecrets.bulkDelete(ids);
    }
  });

  it("R11 saves nonzero measured usage in local history", async () => {
    const { pipeline, repository, runtime } = await openCall();
    vi.spyOn(pipeline, "respond").mockResolvedValue({ teacherText: "短回复。", usage: { asrSeconds: 0, llmInputTokens: 10, llmOutputTokens: 8, ttsCharacters: 4 } });
    submitText("本轮回答");
    await waitFor(async () => expect(await repository.listTurns(runtime.activeSessionId!)).toHaveLength(1));
    fireEvent.click(screen.getByRole("button", { name: "结束并查看摘要" }));
    fireEvent.click(screen.getByRole("button", { name: /结束通话/ }));
    await screen.findByRole("heading", { name: "本次复述摘要" });
    fireEvent.click(screen.getByRole("button", { name: "保留为本机历史" }));
    await waitFor(async () => expect(await repository.listHistory()).toHaveLength(1));
    const history = (await repository.listHistory())[0];
    expect(history.usage.llmOutputTokens).toBe(8);
    expect(history.usage.ttsCharacters).toBe(4);
  });
});

describe("Second audit: host protocol and coach cancellation", () => {
  it("R8 preserves text control messages across the host bridge", async () => {
    let receive: ((event: VoiceSocketBridgeEvent) => void) | undefined;
    const send = vi.fn(async (_sessionId: string, _data: Uint8Array) => undefined);
    const factory = createBridgeVoiceSocketFactory({ open: async () => ({ sessionId: "wire" }), send, close: async () => undefined, onEvent: (callback) => { receive = callback; return () => undefined; } });
    const socket = factory("ws://localhost/unused", {});
    await Promise.resolve();
    receive?.({ sessionId: "wire", kind: "open" });
    const control = JSON.stringify({ header: { action: "run-task" } });
    socket.send(control);
    expect(send.mock.calls[0][1]).toBe(control);
  });

  it("R9 passes the abort signal from coach generation and aborts on unmount", async () => {
    const snapshot = completeCoachTestSnapshot();
    snapshot.adaptiveReviewTasks[0] = { ...coachTestTask, status: "in-progress" };
    snapshot.adaptiveQuizTurns = [];
    const onGenerateTurn = vi.fn(async (_taskId: string, _signal?: AbortSignal) => undefined);
    const noop = async () => undefined;
    const record = { id: coachTestTask.recordId, type: "record" as const, date: "2026-09-09", order: 0, subject: "数据结构", title: "BFS", contentHtml: "<p>BFS</p>", assets: [], formulas: [], mistakeRefs: [], tags: [], createdAt: "2026-09-09T00:00:00Z", updatedAt: "2026-09-09T00:00:00Z" };
    const view = render(<AdaptiveReviewPage taskId={coachTestTask.id} snapshot={snapshot} records={[record]} onBack={() => undefined} onGenerateTurn={onGenerateTurn} onRequestHint={noop} onSubmitAnswer={noop} onSkipTurn={noop} onReportInvalid={noop} onFinish={noop} onFinishVerification={noop} onDefer={noop} onAbandon={noop} />);
    fireEvent.click(screen.getByRole("button", { name: "开始训练" }));
    await waitFor(() => expect(onGenerateTurn).toHaveBeenCalledOnce());
    const signal = onGenerateTurn.mock.calls[0][1];
    view.unmount();
    expect(signal).toBeInstanceOf(AbortSignal);
    expect(signal?.aborted).toBe(true);
  });
});

const openCall = async () => {
  const database = new StudyJournalDatabase("second-audit-" + crypto.randomUUID());
  await database.open();
  const repository = new VoiceRecallRepository(database);
  const runtime = new VoiceRecallRuntimeController(repository);
  resources.push({ database, runtime });
  const pipeline = new VoiceRecallPipeline(new MockAsrStreamAdapter(), new MockLlmStreamAdapter(), new MockTtsStreamAdapter());
  let currentRoute: VoiceRecallNavigationRoute = { screen: "start", returnTab: "review", sourceKind: "review-home", recordIds: [] };
  const sessionFactory = vi.fn(async () => ({ pipeline, asrFormat: { encoding: "pcm-s16le" as const, sampleRate: 16_000, channelCount: 1 as const }, ttsVoice: "mock", ttsEncoding: "pcm-s16le" as const, ttsSampleRate: 16_000, summary: { asr: "mock", llm: "mock", tts: "mock" } }));
  const Harness = ({ identity = 0 }: { identity?: number }) => {
    const [route, setRoute] = useState(currentRoute);
    currentRoute = route;
    return <VoiceRecallWorkspace key={identity} route={route} blocks={[]} assets={[]} subjects={[]} templates={[]} settings={{ ...DEFAULT_SETTINGS, ai: undefined }} onRouteChange={setRoute} onBack={() => undefined} onCreateJournal={async () => undefined} repository={repository} runtime={runtime} sessionFactory={sessionFactory} playbackSinkFactory={() => ({ play: async () => undefined, stop: () => undefined })} />;
  };
  const view = render(<Harness />);
  fireEvent.click(screen.getByRole("tab", { name: "自由主题" }));
  fireEvent.change(screen.getByPlaceholderText("例如：解释事件循环"), { target: { value: "二次审计" } });
  fireEvent.click(screen.getByRole("button", { name: "开始语音复述" }));
  fireEvent.click(screen.getByRole("checkbox"));
  fireEvent.click(screen.getByRole("button", { name: "确认并连接" }));
  await screen.findByRole("heading", { name: "先闭卷复述你记得的核心内容。" });
  return { database, repository, runtime, pipeline, sessionFactory, view, Harness };
};

const submitText = (text: string) => {
  fireEvent.click(screen.getByRole("button", { name: "字幕与键盘输入" }));
  fireEvent.change(screen.getByLabelText("本轮转写校对"), { target: { value: text } });
  fireEvent.click(screen.getByRole("button", { name: "确认并发送" }));
};

describe("Second audit: desired behavior regression probes (no network)", () => {
  it("R1 includes the CURRENT confirmed answer in the LLM request", async () => {
    const { runtime } = await openCall();
    const request = vi.spyOn(runtime, "respondTurn");
    submitText("UNIQUE_CURRENT_ANSWER_20260909");
    await waitFor(() => expect(request).toHaveBeenCalledOnce());
    expect(request.mock.calls[0][0].messages.some((message) => message.role === "user" && message.content.includes("UNIQUE_CURRENT_ANSWER_20260909"))).toBe(true);
  });

  it("R2 retains all finalized ASR sentences", async () => {
    const pipeline = new VoiceRecallPipeline({ profileId: "multi", async *transcribe() { yield { type: "final" as const, text: "第一句。" }; yield { type: "final" as const, text: "第二句。" }; yield { type: "completed" as const }; } }, new MockLlmStreamAdapter(), new MockTtsStreamAdapter());
    const result = await pipeline.transcribe({ sessionId: "s", turnId: "t", operationId: "o", frames: (async function* () {})(), format: { encoding: "pcm-s16le", sampleRate: 16_000, channelCount: 1 }, signal: new AbortController().signal });
    expect(result.transcript).toContain("第一句。");
    expect(result.transcript).toContain("第二句。");
  });

  it("R3 cancel-current-turn aborts the actual provider signal", async () => {
    const { pipeline, runtime } = await openCall();
    let capturedSignal: AbortSignal | undefined;
    let release: (() => void) | undefined;
    vi.spyOn(pipeline, "respond").mockImplementation((input) => {
      capturedSignal = input.signal;
      return new Promise((resolve) => { release = () => resolve({ teacherText: "", usage }); });
    });
    submitText("等待取消");
    await waitFor(() => expect(capturedSignal).toBeDefined());
    fireEvent.click(screen.getByRole("button", { name: "取消当前轮次" }));
    const wasAborted = capturedSignal!.aborted;
    await act(async () => { release?.(); });
    expect(runtime.snapshot?.status).toBe("listening");
    expect(wasAborted).toBe(true);
  });

  it("R4 mute stops capture instead of only changing its label", async () => {
    const { runtime } = await openCall();
    vi.spyOn(runtime, "startCapture").mockResolvedValue(undefined);
    const stop = vi.spyOn(runtime, "stopCapture");
    fireEvent.click(screen.getByRole("button", { name: "开始回答" }));
    await screen.findByRole("button", { name: "立即发送" });
    fireEvent.click(screen.getByRole("button", { name: "静音", exact: true }));
    await screen.findByRole("button", { name: "已静音", exact: true });
    expect(stop).toHaveBeenCalled();
  });

  it("R5 remount reconstructs the production session before resuming", async () => {
    const { view, Harness, runtime } = await openCall();
    await act(async () => { await runtime.pause(); });
    view.rerender(<Harness identity={1} />);
    await act(async () => { await Promise.resolve(); });
    const capture = vi.spyOn(runtime, "startCapture").mockResolvedValue(undefined);
    fireEvent.click(screen.getByRole("button", { name: "继续通话" }));
    fireEvent.click(screen.getByRole("button", { name: "开始回答" }));
    await act(async () => { await Promise.resolve(); });
    expect(capture).toHaveBeenCalledOnce();
  });

  it("R6 websocket task-start acknowledgement is bounded after socket open", async () => {
    vi.useFakeTimers();
    const socket: VoiceSocket = { readyState: 0, send: () => undefined, close: () => undefined, onopen: null, onmessage: null, onerror: null, onclose: null };
    const transport = createAliyunAsrTransport({ apiKey: "test-only", socketFactory: () => socket, openTimeoutMs: 10 });
    let settled = false;
    const controller = new AbortController();
    void transport.open({ profile: BUILT_IN_ASR_PROFILES.find((profile) => profile.providerId === "aliyun-bailian")!, sessionId: "s", turnId: "t", operationId: "o", language: "zh-CN", format: { encoding: "pcm-s16le", sampleRate: 16_000, channelCount: 1 }, signal: controller.signal }).then(() => { settled = true; }, () => { settled = true; });
    socket.onopen?.({});
    await vi.advanceTimersByTimeAsync(100);
    controller.abort();
    expect(settled).toBe(true);
  });

  it("R7 rating tombstone rejects a delayed nonempty autosave", async () => {
    const recordId = "audit-" + crypto.randomUUID();
    const stamp = new Date().toISOString();
    const element = { id: "stroke", kind: "pen" as const, points: [{ x: 0, y: 0 }], anchorIndex: 0, color: "black", width: 2, opacity: 1, createdAt: stamp, updatedAt: stamp };
    const draft: ReviewAnnotationDraft = { id: recordId + ":occurrence", recordId, reviewOccurrenceKey: "occurrence", contentRevision: "v1", schemaVersion: 1, elements: [element], history: [[], [element]], historyCursor: 1, updatedAt: stamp };
    try {
      await reviewAnnotationRepository.upsertDraft(draft);
      await reviewAnnotationRepository.clearAfterRating(recordId, "occurrence");
      await reviewAnnotationRepository.upsertDraft(draft);
      const after = await reviewAnnotationRepository.getDraft(recordId, "occurrence");
      expect(after?.elements).toEqual([]);
    } finally {
      await db.reviewAnnotationDrafts.delete(draft.id);
    }
  });
});
