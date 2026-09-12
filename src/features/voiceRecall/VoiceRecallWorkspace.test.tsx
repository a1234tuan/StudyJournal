import { fireEvent, render, screen, waitFor } from "@testing-library/react";
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
  it("does not start automatic capture until the generated opening question finishes playback", async () => {
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

    await screen.findByRole("heading", { name: "先说说你对“事件循环”的整体理解。" });
    expect(capture).not.toHaveBeenCalled();
    finishPlayback();
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

    await screen.findByRole("heading", { name: "先说说你对“事件循环”的整体理解。" });
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

    await screen.findByRole("heading", { name: "先说说你对“事件循环”的整体理解。" });
    await waitFor(() => expect(runtime.snapshot?.status).toBe("listening"));
    fireEvent.click(screen.getByRole("button", { name: "字幕与键盘输入" }));
    fireEvent.change(screen.getByLabelText("本轮转写校对"), { target: { value: "这是人工确认后的正式回答" } });
    fireEvent.click(screen.getByRole("button", { name: "确认并发送" }));

    await waitFor(async () => expect(await repository.listTurns((await repository.listResumableSessions())[0].id)).toEqual([
      expect.objectContaining({ confirmedText: "这是人工确认后的正式回答", sequence: 0 }),
    ]));
    await screen.findByRole("button", { name: "查看总结" });
    fireEvent.click(screen.getByRole("button", { name: "查看总结" }));

    await screen.findByRole("heading", { name: "本次复述摘要" });
    expect(screen.getByText(/这是人工确认后的正式回答/)).toBeInTheDocument();
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

    await screen.findByRole("heading", { name: "先说说你对“事件循环”的整体理解。" });
    await waitFor(() => expect(runtime.snapshot?.status).toBe("listening"));
    expect(respond).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole("button", { name: "字幕与键盘输入" }));
    fireEvent.change(screen.getByLabelText("本轮转写校对"), { target: { value: "结束" } });
    fireEvent.click(screen.getByRole("button", { name: "确认并发送" }));

    await screen.findByRole("heading", { name: "要继续补充，还是查看总结？" });
    expect(respond).toHaveBeenCalledOnce();
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
