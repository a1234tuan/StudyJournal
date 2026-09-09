import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import Dexie from "dexie";
import { IDBKeyRange, indexedDB } from "fake-indexeddb";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { StudyJournalDatabase } from "../../db/database";
import type { VoiceRecallNavigationRoute } from "../../lib/tabNavigation";
import type { RecordBlock, SubjectConfig } from "../../types";
import { VoiceRecallRepository } from "./repository";
import { VoiceRecallRuntimeController } from "./runtimeController";
import { VoiceRecallWorkspace } from "./VoiceRecallWorkspace";

Dexie.dependencies.indexedDB = indexedDB;
Dexie.dependencies.IDBKeyRange = IDBKeyRange;

const databases = new Set<string>();
const now = "2026-09-08T08:00:00.000Z";
const subjects: SubjectConfig[] = [{ id: "subject-1", name: "计算机", order: 0, createdAt: now, updatedAt: now }];

const openWorkspace = async (options: { initialRoute?: VoiceRecallNavigationRoute; blocks?: RecordBlock[] } = {}) => {
  const name = `voice-workspace-${crypto.randomUUID()}`;
  databases.add(name);
  const database = new StudyJournalDatabase(name);
  await database.open();
  const repository = new VoiceRecallRepository(database);
  const runtime = new VoiceRecallRuntimeController(repository);
  const onCreateJournal = vi.fn(async () => undefined);
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
      onRouteChange={setRoute}
      onBack={vi.fn()}
      onCreateJournal={onCreateJournal}
      repository={repository}
      runtime={runtime}
    />;
  };

  return { database, repository, runtime, onCreateJournal, Harness };
};

afterEach(async () => {
  window.localStorage.clear();
  await Promise.all([...databases].map((name) => Dexie.delete(name)));
  databases.clear();
});

describe("VoiceRecallWorkspace", () => {
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
    fireEvent.click(screen.getByRole("checkbox"));
    fireEvent.click(screen.getByRole("button", { name: "确认并连接" }));

    await screen.findByRole("heading", { name: "先闭卷复述你记得的核心内容。" });
    expect(screen.getByText("1 条学习资料")).toBeInTheDocument();
    await runtime.disposeView();
    view.unmount();
    database.close();
  });

  it("requires disclosure, commits only confirmed text, and explicitly hands a summary to journal creation", async () => {
    const { database, repository, onCreateJournal, Harness } = await openWorkspace();
    const view = render(<Harness />);
    fireEvent.click(screen.getByRole("tab", { name: "自由主题" }));
    const start = screen.getByRole("button", { name: "开始语音复述" });

    fireEvent.change(screen.getByPlaceholderText("例如：解释事件循环"), { target: { value: "事件循环" } });
    fireEvent.click(start);
    expect(screen.getByRole("button", { name: "确认并连接" })).toBeDisabled();
    fireEvent.click(screen.getByRole("checkbox"));
    fireEvent.click(screen.getByRole("button", { name: "确认并连接" }));

    await screen.findByRole("heading", { name: "先闭卷复述你记得的核心内容。" });
    fireEvent.click(screen.getByRole("button", { name: "键盘输入校对" }));
    fireEvent.change(screen.getByLabelText("本轮转写校对"), { target: { value: "这是人工确认后的正式回答" } });
    fireEvent.click(screen.getByRole("button", { name: "确认并发送" }));

    await waitFor(async () => expect(await repository.listTurns((await repository.listResumableSessions())[0].id)).toEqual([
      expect.objectContaining({ confirmedText: "这是人工确认后的正式回答", sequence: 0 }),
    ]));
    fireEvent.click(screen.getByRole("button", { name: "结束并查看摘要" }));
    expect(screen.getByRole("dialog", { name: "要暂停还是结束本次通话？" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /结束通话/ }));

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

  it("routes the turn through the real Mock ASR→LLM→TTS pipeline and persists non-zero usage", async () => {
    const { database, repository, Harness } = await openWorkspace();
    const view = render(<Harness />);
    fireEvent.click(screen.getByRole("tab", { name: "自由主题" }));
    fireEvent.change(screen.getByPlaceholderText("例如：解释事件循环"), { target: { value: "事件循环" } });
    fireEvent.click(screen.getByRole("button", { name: "开始语音复述" }));
    fireEvent.click(screen.getByRole("checkbox"));
    fireEvent.click(screen.getByRole("button", { name: "确认并连接" }));

    await screen.findByRole("heading", { name: "先闭卷复述你记得的核心内容。" });
    fireEvent.click(screen.getByRole("button", { name: "键盘输入校对" }));
    fireEvent.change(screen.getByLabelText("本轮转写校对"), { target: { value: "主动回忆强化长期记忆" } });
    fireEvent.click(screen.getByRole("button", { name: "确认并发送" }));

    const sessions = await repository.listResumableSessions();
    const turns = await waitFor(async () => {
      const list = await repository.listTurns(sessions[0].id);
      expect(list).toHaveLength(1);
      return list;
    });
    // teacherText comes from the Mock LLM, not the removed createTeacherReply template.
    expect(turns[0].teacherText).toContain("再举一个");
    expect(turns[0].providerFinalText).not.toBe(turns[0].confirmedText);
    expect(turns[0].playedCharacterCount).toBeGreaterThan(0);

    fireEvent.click(screen.getByRole("button", { name: "结束并查看摘要" }));
    fireEvent.click(screen.getByRole("button", { name: /结束通话/ }));
    await screen.findByRole("heading", { name: "本次复述摘要" });
    fireEvent.click(screen.getByRole("button", { name: "保留为本机历史" }));
    await waitFor(async () => expect(await repository.listHistory()).toHaveLength(1));
    const history = (await repository.listHistory())[0];
    // usage is accumulated from the real pipeline meter, no longer the all-zero stub.
    expect(history.usage.llmOutputTokens).toBeGreaterThan(0);
    expect(history.usage.ttsCharacters).toBeGreaterThan(0);

    view.unmount();
    database.close();
  });
});
