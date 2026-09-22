import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import Dexie from "dexie";
import { IDBKeyRange, indexedDB } from "fake-indexeddb";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { StudyJournalDatabase } from "../../db/database";
import { DEFAULT_SETTINGS } from "../../db/defaults";
import type { VoiceRecallNavigationRoute } from "../../lib/tabNavigation";
import type { RecordBlock, SubjectConfig } from "../../types";
import { MockAsrStreamAdapter, MockLlmStreamAdapter, MockTtsStreamAdapter } from "./mockProviders";
import { VoiceRecallPipeline } from "./pipeline";
import type { ProductionVoiceSession } from "./productionPipeline";
import { VoiceRecallRepository } from "./repository";
import { VoiceRecallRuntimeController } from "./runtimeController";
import { VoiceRecallWorkspace } from "./VoiceRecallWorkspace";
import { WebVoiceCaptureAdapter } from "./webVoiceCapture";
import { VoiceAudioFocusManager } from "./audioFocus";

Dexie.dependencies.indexedDB = indexedDB;
Dexie.dependencies.IDBKeyRange = IDBKeyRange;

const databases = new Set<string>();
const now = "2026-09-08T08:00:00.000Z";
const subjects: SubjectConfig[] = [{ id: "subject-1", name: "计算机", order: 0, createdAt: now, updatedAt: now }];

const fakeSession = (): ProductionVoiceSession => ({
  pipeline: new VoiceRecallPipeline(new MockAsrStreamAdapter(), new MockLlmStreamAdapter(), new MockTtsStreamAdapter()),
  asrFormat: { encoding: "pcm-s16le", sampleRate: 16_000, channelCount: 1 },
  ttsVoice: "mock-teacher",
  ttsEncoding: "pcm-s16le",
  ttsSampleRate: 16_000,
  summary: { asr: "Mock ASR", llm: "Mock LLM", tts: "Mock TTS" },
});

const openWorkspace = async (options: { initialRoute?: VoiceRecallNavigationRoute; blocks?: RecordBlock[]; useRealSessionFactory?: boolean; playbackSinkFactory?: () => { play: () => Promise<void>; stop: () => void } } = {}) => {
  const name = `voice-workspace-${crypto.randomUUID()}`;
  databases.add(name);
  const database = new StudyJournalDatabase(name);
  await database.open();
  const repository = new VoiceRecallRepository(database);
  const runtime = new VoiceRecallRuntimeController(repository);
  const onCreateJournal = vi.fn(async () => undefined);
  const onBack = vi.fn();
  const initialRoute: VoiceRecallNavigationRoute = options.initialRoute ?? {
    screen: "start",
    returnTab: "review",
    sourceKind: "review-home",
    recordIds: [],
  };

  const Harness = () => {
    const [route, setRoute] = useState(initialRoute);
    return <VoiceRecallWorkspace
      route={route}
      blocks={options.blocks ?? []}
      assets={[]}
      subjects={subjects}
      templates={[]}
      settings={{ ...DEFAULT_SETTINGS, ai: undefined }}
      onRouteChange={setRoute}
      onBack={onBack}
      onCreateJournal={onCreateJournal}
      repository={repository}
      runtime={runtime}
      {...(options.useRealSessionFactory ? {} : {
        sessionFactory: async () => fakeSession(),
        playbackSinkFactory: options.playbackSinkFactory ?? (() => ({ play: async () => undefined, stop: () => undefined })),
      })}
    />;
  };

  return { database, repository, runtime, onBack, onCreateJournal, Harness };
};

afterEach(async () => {
  vi.restoreAllMocks();
  window.localStorage.clear();
  await Promise.all([...databases].map((name) => Dexie.delete(name)));
  databases.clear();
});

describe("VoiceRecallWorkspace", () => {
  it("makes an oversized history summary editable without truncation and reports a failed write", async () => {
    const { database, runtime, repository } = await openWorkspace();
    const sessionId = await runtime.createSession({ mode: "free-topic", inputMode: "tap-to-record", source: { kind: "free-topic" } });
    await repository.putTurn({ id: "long-turn", sessionId, sequence: 0, operationId: "long-operation", status: "completed", teacherText: "回复", confirmedText: "文".repeat(13000), createdAt: now, updatedAt: now });
    await runtime.end();
    const save = vi.spyOn(repository, "saveHistory").mockRejectedValueOnce(new Error("database unavailable"));
    const view = render(<VoiceRecallWorkspace route={{ screen: "summary", sessionId, sourceKind: "free-topic", recordIds: [], returnTab: "review", topic: "主题" }} blocks={[]} assets={[]} subjects={subjects} templates={[]} settings={DEFAULT_SETTINGS} onRouteChange={() => undefined} onBack={() => undefined} onCreateJournal={async () => undefined} repository={repository} runtime={runtime} />);
    const editor = await screen.findByLabelText("本机历史摘要");
    await waitFor(() => expect((editor as HTMLTextAreaElement).value.length).toBeGreaterThan(12000));
    expect(screen.getByRole("button", { name: "保留为本机历史" })).toBeDisabled();
    expect(screen.getByText(/不会自动截断/)).toBeInTheDocument();
    fireEvent.change(editor, { target: { value: "保".repeat(12000) } });
    fireEvent.click(screen.getByRole("button", { name: "保留为本机历史" }));
    await screen.findByRole("alert");
    expect(editor).toHaveValue("保".repeat(12000));
    expect(await repository.listHistory()).toHaveLength(0);
    fireEvent.click(screen.getByRole("button", { name: "保留为本机历史" }));
    await screen.findByRole("button", { name: "已保留在本机" });
    expect(save).toHaveBeenCalledTimes(2);
    expect((await repository.listHistory())[0].summary).toBe("保".repeat(12000));
    expect((await repository.listTurns(sessionId))[0].confirmedText).toHaveLength(13000);
    view.unmount();
    database.close();
  });
  it("does not send previously selected record content after switching to a free topic", async () => {
    const record: RecordBlock = { id: "private", type: "record", date: "2026-09-22", order: 0, subject: "计算机", title: "Private", contentHtml: "<p>PRIVATE_MATERIAL_MARKER_482</p>", tags: [], assets: [], formulas: [], mistakeRefs: [], createdAt: now, updatedAt: now };
    const { database, runtime, repository, Harness } = await openWorkspace({ blocks: [record], initialRoute: { screen: "start", returnTab: "review", sourceKind: "coach-task", taskId: "task", recordIds: [record.id] } });
    const respond = vi.spyOn(runtime, "respondTurn");
    const view = render(<Harness />);
    fireEvent.click(screen.getByRole("tab", { name: "自由主题" }));
    fireEvent.click(screen.getByRole("tab", { name: "从学习资料开始" }));
    expect(screen.getByRole("heading", { name: "Private" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("tab", { name: "自由主题" }));
    fireEvent.click(screen.getByRole("button", { name: /点击录音/ }));
    fireEvent.change(screen.getByPlaceholderText("例如：解释事件循环"), { target: { value: "NEW_TOPIC_596" } });
    fireEvent.click(screen.getByRole("button", { name: "开始语音复述" }));
    fireEvent.click(screen.getByRole("checkbox", { name: /我了解本次发送范围/ }));
    fireEvent.click(screen.getByRole("button", { name: "确认并连接" }));
    await waitFor(() => expect(runtime.snapshot?.status).toBe("listening"));
    fireEvent.click(screen.getByRole("button", { name: "字幕与键盘输入" }));
    fireEvent.change(screen.getByLabelText("本轮转写校对"), { target: { value: "开始讨论" } });
    fireEvent.click(screen.getByRole("button", { name: "确认并发送" }));
    await waitFor(() => expect(respond).toHaveBeenCalled());
    const request = JSON.stringify(respond.mock.calls[0][0].messages);
    expect(request).not.toContain("PRIVATE_MATERIAL_MARKER_482");
    expect(request).toContain("NEW_TOPIC_596");
    const stored = await repository.getSession(runtime.activeSessionId!);
    expect(stored?.sourceRecordIds).toEqual([]);
    expect(stored?.sourceTaskId).toBeUndefined();
    await runtime.end();
    view.unmount();
    database.close();
  });

  it.each(["pointerUp", "pointerCancel", "lostPointerCapture"])("cancels push-to-talk startup on %s before audio focus is acquired", async (eventName) => {
    let release!: () => void;
    const focus = vi.spyOn(VoiceAudioFocusManager.prototype, "acquire").mockImplementation(() => new Promise<void>((resolve) => { release = resolve; }));
    const capture = vi.spyOn(WebVoiceCaptureAdapter.prototype, "start").mockImplementation(async function* () {});
    const { database, runtime, Harness } = await openWorkspace();
    const view = render(<Harness />);
    fireEvent.click(screen.getByRole("tab", { name: "自由主题" }));
    fireEvent.change(screen.getByPlaceholderText("例如：解释事件循环"), { target: { value: "事件循环" } });
    fireEvent.click(screen.getByRole("button", { name: /按住讲话/ }));
    fireEvent.click(screen.getByRole("button", { name: "开始语音复述" }));
    fireEvent.click(screen.getByRole("checkbox", { name: /我了解本次发送范围/ }));
    fireEvent.click(screen.getByRole("button", { name: "确认并连接" }));
    await waitFor(() => expect(runtime.snapshot?.status).toBe("listening"));
    const button = screen.getByRole("button", { name: "按住说话" });
    fireEvent.pointerDown(button);
    await waitFor(() => expect(focus).toHaveBeenCalled());
    if (eventName === "pointerUp") fireEvent.pointerUp(button);
    else if (eventName === "pointerCancel") fireEvent.pointerCancel(button);
    else fireEvent.lostPointerCapture(button);
    await act(async () => { release(); });
    expect(capture).not.toHaveBeenCalled();
    expect(button).not.toHaveClass("is-capturing");
    await runtime.end();
    view.unmount();
    database.close();
  });

  it("offers a paused checkpoint after pause-and-leave without starting capture", async () => {
    const capture = vi.spyOn(WebVoiceCaptureAdapter.prototype, "start").mockImplementation(async function* () {});
    const { database, runtime, repository, Harness } = await openWorkspace();
    const view = render(<Harness />);
    fireEvent.click(screen.getByRole("tab", { name: "自由主题" }));
    fireEvent.change(screen.getByPlaceholderText("例如：解释事件循环"), { target: { value: "保留的主题" } });
    fireEvent.click(screen.getByRole("button", { name: /点击录音/ }));
    fireEvent.click(screen.getByRole("button", { name: "开始语音复述" }));
    fireEvent.click(screen.getByRole("checkbox", { name: /我了解本次发送范围/ }));
    fireEvent.click(screen.getByRole("button", { name: "确认并连接" }));
    await waitFor(() => expect(runtime.snapshot?.status).toBe("listening"));
    const sessionId = runtime.activeSessionId;
    fireEvent.click(screen.getByRole("button", { name: "返回" }));
    fireEvent.click(await screen.findByRole("button", { name: /暂停并离开/ }));
    fireEvent.click(await screen.findByRole("button", { name: /恢复暂停通话/ }));
    await screen.findByRole("button", { name: "继续通话" });
    expect(runtime.activeSessionId).toBe(sessionId);
    expect(runtime.snapshot?.status).toBe("paused");
    expect(capture).not.toHaveBeenCalled();
    expect(await repository.listHistory()).toEqual([]);
    await runtime.end();
    view.unmount();
    database.close();
  });
  it("starts automatic capture after the user-first connection", async () => {
    let finishPlayback: () => void = () => undefined;
    const capture = vi.spyOn(WebVoiceCaptureAdapter.prototype, "start").mockImplementation(async function* () { return; });
    const { database, runtime, Harness } = await openWorkspace({
      playbackSinkFactory: () => ({
        play: () => new Promise<void>((resolve) => { finishPlayback = resolve; }),
        stop: () => undefined,
      }),
    });
    const view = render(<Harness />);
    fireEvent.click(screen.getByRole("tab", { name: "自由主题" }));
    fireEvent.change(screen.getByPlaceholderText("例如：解释事件循环"), { target: { value: "事件循环" } });
    fireEvent.click(screen.getByRole("button", { name: "开始语音复述" }));
    fireEvent.click(screen.getByRole("checkbox", { name: /我了解本次发送范围/ }));
    fireEvent.click(screen.getByRole("button", { name: "确认并连接" }));

    await waitFor(() => expect(runtime.snapshot?.status).toBe("listening"));
    await waitFor(() => expect(capture).toHaveBeenCalledOnce());

    await runtime.end();
    view.unmount();
    database.close();
  });

  it("returns selected records to the production start screen instead of silently blocking on disclosure", async () => {
    const record: RecordBlock = {
      id: "scope-record-1",
      type: "record",
      date: "2026-09-08",
      order: 0,
      subject: "计算机",
      title: "间隔复习与主动回忆",
      contentHtml: "<p>主动回忆正文</p>",
      tags: [],
      assets: [],
      formulas: [],
      mistakeRefs: [],
      createdAt: now,
      updatedAt: now,
    };
    const { database, Harness } = await openWorkspace({ blocks: [record] });
    const view = render(<Harness />);

    fireEvent.click(screen.getByRole("button", { name: "调整范围" }));
    fireEvent.click(screen.getByRole("tab", { name: "选择日志" }));
    fireEvent.click(screen.getByRole("button", { name: "计算机 1 条日志" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "选择日志 间隔复习与主动回忆" }));
    fireEvent.click(screen.getByRole("button", { name: "使用这些资料" }));

    await screen.findByRole("heading", { name: "间隔复习与主动回忆" });
    expect(screen.getByText("1 条日志 · 资料为主，允许适度补充")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "开始语音复述" })).toBeEnabled();

    view.unmount();
    database.close();
  });

  it("starts from a contextual review card only after disclosure confirmation", async () => {
    const contextualRecord: RecordBlock = {
      id: "record-1",
      type: "record",
      date: "2026-09-08",
      order: 0,
      subject: "计算机",
      title: "事件循环",
      contentHtml: "<p>事件循环正文</p>",
      tags: [],
      assets: [],
      formulas: [],
      mistakeRefs: [],
      createdAt: now,
      updatedAt: now,
    };
    const { database, runtime, Harness } = await openWorkspace({
      blocks: [contextualRecord],
      initialRoute: {
        screen: "start",
        returnTab: "review",
        sourceKind: "review-card",
        recordIds: [contextualRecord.id],
        learningGoal: "闭卷复述《事件循环》并发现理解缺口",
      },
    });
    const view = render(<Harness />);

    const start = screen.getByRole("button", { name: "开始语音复述" });
    expect(screen.getByRole("heading", { name: "事件循环" })).toBeInTheDocument();
    expect(start).toBeEnabled();
    fireEvent.click(start);
    expect(screen.getByRole("button", { name: "确认并连接" })).toBeDisabled();
    fireEvent.click(screen.getByRole("checkbox", { name: /我了解本次发送范围/ }));
    fireEvent.click(screen.getByRole("button", { name: "确认并连接" }));

    await waitFor(() => expect(runtime.snapshot?.status).toBe("listening"));
    await waitFor(() => expect(runtime.snapshot?.status).toBe("listening"));
    expect(screen.getByText("1 条学习资料")).toBeInTheDocument();
    await runtime.disposeView();
    view.unmount();
    database.close();
  });

  it("requires disclosure, commits only confirmed text, and explicitly hands a summary to journal creation", async () => {
    const { database, repository, runtime, onCreateJournal, Harness } = await openWorkspace();
    const view = render(<Harness />);
    fireEvent.click(screen.getByRole("tab", { name: "自由主题" }));
    fireEvent.click(screen.getByRole("button", { name: /点击录音/ }));
    const start = screen.getByRole("button", { name: "开始语音复述" });

    fireEvent.change(screen.getByPlaceholderText("例如：解释事件循环"), { target: { value: "事件循环" } });
    fireEvent.click(start);
    expect(screen.getByRole("button", { name: "确认并连接" })).toBeDisabled();
    fireEvent.click(screen.getByRole("checkbox", { name: /我了解本次发送范围/ }));
    fireEvent.click(screen.getByRole("button", { name: "确认并连接" }));

    await waitFor(() => expect(runtime.snapshot?.status).toBe("listening"));
    await waitFor(() => expect(runtime.snapshot?.status).toBe("listening"));
    fireEvent.click(screen.getByRole("button", { name: "字幕与键盘输入" }));
    fireEvent.change(screen.getByLabelText("本轮转写校对"), { target: { value: "这是人工确认后的正式回答" } });
    fireEvent.click(screen.getByRole("button", { name: "确认并发送" }));

    await waitFor(async () => expect(await repository.listTurns((await repository.listResumableSessions())[0].id)).toEqual([
      expect.objectContaining({ confirmedText: "这是人工确认后的正式回答", sequence: 0, status: "completed", playbackStatus: "completed" }),
    ]));
    const replay = vi.spyOn(VoiceRecallPipeline.prototype, "speakText");
    fireEvent.click(screen.getByRole("button", { name: "再次播放学习助教回复" }));
    await waitFor(() => expect(runtime.snapshot?.status).toBe("listening"));
    expect(replay).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "清理本次通话缓存" }));
    fireEvent.click(screen.getByRole("button", { name: "再次播放学习助教回复" }));
    await waitFor(() => expect(replay).toHaveBeenCalledWith(expect.objectContaining({ text: expect.any(String) })));
    await waitFor(() => expect(runtime.snapshot?.status).toBe("listening"));
    fireEvent.click(screen.getByRole("button", { name: "结束并查看摘要" }));

    await screen.findByRole("heading", { name: "本次复述摘要" });
    expect((screen.getByLabelText("本机历史摘要") as HTMLTextAreaElement).value).toContain("这是人工确认后的正式回答");
    fireEvent.click(screen.getByRole("button", { name: "保留为本机历史" }));
    await waitFor(async () => expect(await repository.listHistory()).toHaveLength(1));

    fireEvent.click(screen.getByRole("button", { name: "整理为日志" }));
    expect(screen.getByRole("dialog", { name: "确认创建正式日志" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "确认创建并编辑" }));
    await waitFor(() => expect(onCreateJournal).toHaveBeenCalledWith(
      "计算机",
      expect.stringContaining("这是人工确认后的正式回答"),
    ));

    view.unmount();
    database.close();
  });

  it("refuses to start instead of simulating a call when the provider chain is unavailable", async () => {
    const { database, Harness } = await openWorkspace({ useRealSessionFactory: true });
    const view = render(<Harness />);

    fireEvent.click(screen.getByRole("tab", { name: "自由主题" }));
    fireEvent.change(screen.getByPlaceholderText("例如：解释事件循环"), { target: { value: "事件循环" } });
    fireEvent.click(screen.getByRole("button", { name: "开始语音复述" }));
    fireEvent.click(screen.getByRole("checkbox", { name: /我了解本次发送范围/ }));
    fireEvent.click(screen.getByRole("button", { name: "确认并连接" }));

    await screen.findByText(/请先在“更多 → AI 设置”里配置 AI 供应商/);
    expect(screen.queryByText("正在听")).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "把刚学过的内容讲出来" })).toBeInTheDocument();

    view.unmount();
    database.close();
  });

  it("honors an explicit stop without another LLM turn and pauses at the completion choices", async () => {
    const { database, repository, runtime, Harness } = await openWorkspace();
    const respond = vi.spyOn(runtime, "respondTurn");
    const view = render(<Harness />);
    fireEvent.click(screen.getByRole("tab", { name: "自由主题" }));
    fireEvent.click(screen.getByRole("button", { name: /点击录音/ }));
    fireEvent.change(screen.getByPlaceholderText("例如：解释事件循环"), { target: { value: "事件循环" } });
    fireEvent.click(screen.getByRole("button", { name: "开始语音复述" }));
    fireEvent.click(screen.getByRole("checkbox", { name: /我了解本次发送范围/ }));
    fireEvent.click(screen.getByRole("button", { name: "确认并连接" }));

    await waitFor(() => expect(runtime.snapshot?.status).toBe("listening"));
    await waitFor(() => expect(runtime.snapshot?.status).toBe("listening"));
    expect(respond).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "字幕与键盘输入" }));
    fireEvent.change(screen.getByLabelText("本轮转写校对"), { target: { value: "结束" } });
    fireEvent.click(screen.getByRole("button", { name: "确认并发送" }));

    await screen.findByRole("heading", { name: "要继续补充，还是查看总结？" });
    expect(respond).not.toHaveBeenCalled();
    expect(runtime.snapshot?.status).toBe("paused");
    const stored = (await repository.listResumableSessions())[0];
    expect(stored.memory.completionReason).toBe("user-requested");
    expect(await repository.listTurns(stored.id)).toEqual([]);

    fireEvent.click(screen.getByRole("button", { name: "继续补充" }));
    await waitFor(() => expect(runtime.snapshot?.status).toBe("listening"));
    expect(screen.queryByRole("heading", { name: "要继续补充，还是查看总结？" })).not.toBeInTheDocument();
    expect((await repository.getSession(stored.id))?.memory.completionReason).toBeUndefined();

    await runtime.end();
    view.unmount();
    database.close();
  });
});
