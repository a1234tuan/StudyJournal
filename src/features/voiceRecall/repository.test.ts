import Dexie from "dexie";
import { IDBKeyRange, indexedDB } from "fake-indexeddb";
import { afterEach, describe, expect, it } from "vitest";

import { StudyJournalDatabase } from "../../db/database";
import type { VoiceRecallLocalHistory, VoiceRecallSessionLocal, VoiceRecallTurnLocal } from "./localTypes";
import { VOICE_RECALL_LIMITS, VoiceRecallRepository } from "./repository";

Dexie.dependencies.indexedDB = indexedDB;
Dexie.dependencies.IDBKeyRange = IDBKeyRange;

const databases = new Set<string>();
const now = "2026-09-08T08:00:00.000Z";

const session = (id = "session-1", status: VoiceRecallSessionLocal["status"] = "listening"): VoiceRecallSessionLocal => ({
  id,
  mode: "scope-practice",
  sourceKind: "review-card",
  source: { kind: "review-card", recordIds: ["record-1"] },
  sourceRecordIds: ["record-1"],
  status,
  provider: {},
  memory: { learningGoal: "复述", coveredPoints: [], misconceptions: [], pendingTopics: [] },
  checkpoint: { nextSequence: 1, elapsedMs: 1200, inputMode: "auto-half-duplex", userMuted: false },
  createdAt: now,
  updatedAt: now,
});

const turn = (id = "turn-1", sequence = 0): VoiceRecallTurnLocal => ({
  id,
  sessionId: "session-1",
  sequence,
  operationId: `operation-${sequence}`,
  status: "confirmed",
  teacherText: "问题",
  confirmedText: "回答",
  createdAt: now,
  updatedAt: now,
});

const history = (): VoiceRecallLocalHistory => ({
  id: "history-1",
  sessionId: "session-1",
  sourceKind: "review-card",
  source: { kind: "review-card", recordIds: ["record-1"] },
  title: "复述摘要",
  summary: "用户主动保存的本机摘要。",
  usage: { capturedSeconds: 12, asrSentSeconds: 10, llmInputTokens: 20, llmOutputTokens: 10, ttsCharacters: 18 },
  savedAt: now,
});

const openRepository = async () => {
  const name = `voice-recall-${crypto.randomUUID()}`;
  databases.add(name);
  const database = new StudyJournalDatabase(name);
  await database.open();
  return { database, repository: new VoiceRecallRepository(database) };
};

afterEach(async () => {
  await Promise.all([...databases].map((name) => Dexie.delete(name)));
  databases.clear();
});

describe("VoiceRecallRepository", () => {
  it("uses schema 21 local-only tables without marking a cloud mutation", async () => {
    const { database, repository } = await openRepository();
    expect(database.verno).toBe(21);
    await repository.putSession(session());
    await repository.putTurn(turn());
    await repository.saveHistory(history());
    expect(await database.cloudSyncMutation.count()).toBe(0);
    database.close();
  });

  it("rejects sequence reuse by a different turn", async () => {
    const { database, repository } = await openRepository();
    await repository.putSession(session());
    await repository.putTurn(turn());
    await expect(repository.putTurn(turn("turn-2", 0))).rejects.toThrow("序号不能复用");
    database.close();
  });

  it("commits a confirmed turn and advances the session checkpoint atomically", async () => {
    const { database, repository } = await openRepository();
    await repository.putSession({ ...session(), checkpoint: { ...session().checkpoint, nextSequence: 0 } });

    const nextMemory = { ...session().memory, currentTopic: "宏任务", currentTopicFollowUpCount: 1 };
    const updated = await repository.commitTurn(turn(), "人工确认后的回答", () => true, nextMemory);

    expect(updated.checkpoint).toMatchObject({ nextSequence: 1, lastConfirmedText: "人工确认后的回答" });
    expect(updated.memory).toMatchObject({ currentTopic: "宏任务", currentTopicFollowUpCount: 1 });
    expect(await repository.listTurns("session-1")).toEqual([turn()]);
    expect(await repository.getSession("session-1")).toMatchObject({
      checkpoint: { nextSequence: 1, lastConfirmedText: "人工确认后的回答" },
      memory: { currentTopic: "宏任务", currentTopicFollowUpCount: 1 },
    });
    database.close();
  });

  it("rejects out-of-order commits without persisting a partial turn", async () => {
    const { database, repository } = await openRepository();
    await repository.putSession(session());

    await expect(repository.commitTurn(turn(), "回答")).rejects.toThrow("必须按顺序提交");

    expect(await repository.listTurns("session-1")).toEqual([]);
    expect(await repository.getSession("session-1")).toMatchObject({ checkpoint: { nextSequence: 1 } });
    database.close();
  });

  it("repairs active sessions without changing the user's explicit mute choice", async () => {
    const { database, repository } = await openRepository();
    await repository.putSession(session());
    expect(await repository.repairInterruptedSessions("2026-09-08T09:00:00.000Z")).toBe(1);
    expect(await repository.getSession("session-1")).toMatchObject({
      status: "interrupted",
      checkpoint: { userMuted: false },
    });
    database.close();
  });

  it("clears transient checkpoints while preserving explicitly saved local history", async () => {
    const { database, repository } = await openRepository();
    await repository.putSession(session());
    await repository.putTurn(turn());
    await repository.saveHistory(history());
    await repository.clearTransient();
    expect(await database.voiceRecallSessions.count()).toBe(0);
    expect(await database.voiceRecallTurns.count()).toBe(0);
    expect(await database.voiceRecallLocalHistory.count()).toBe(1);
    database.close();
  });

  it("cleans expired voice sessions without touching formal Coach facts", async () => {
    const { database, repository } = await openRepository();
    await repository.putSession({ ...session("expired", "ended"), updatedAt: "2026-08-01T00:00:00.000Z" });
    await database.adaptiveQuizTurns.put({
      id: "coach-turn", taskId: "coach-task", sequence: 0, question: "正式问题", answerText: "正式答案",
      questionQuality: { status: "passed", checkedAt: now }, status: "answered", createdAt: now, updatedAt: now,
    } as never);

    await expect(repository.cleanupCompleted(new Date("2026-09-08T00:00:00.000Z").getTime())).resolves.toBe(1);
    expect(await database.adaptiveQuizTurns.get("coach-turn")).toMatchObject({ answerText: "正式答案" });
    database.close();
  });

  it("marks missing record sources without deleting local history", async () => {
    const { database, repository } = await openRepository();
    await repository.putSession(session());
    await repository.saveHistory(history());
    await expect(repository.markSourceUnavailable({ recordId: "record-1" })).resolves.toEqual({ sessions: 1, histories: 1 });
    expect(await repository.getSession("session-1")).toMatchObject({ status: "interrupted", sourceUnavailable: true });
    expect(await repository.listHistory()).toEqual([expect.objectContaining({ sourceUnavailable: true })]);
    database.close();
  });

  it("retains all explicitly saved history beyond 200 entries", async () => {
    const { database, repository } = await openRepository();
    const total = 203;
    for (let index = 0; index < total; index += 1) {
      await repository.saveHistory({
        ...history(),
        id: `history-${index}`,
        savedAt: new Date(Date.parse("2026-09-08T08:00:00.000Z") + index * 1_000).toISOString(),
      });
    }
    const list = await repository.listHistory();
    expect(list).toHaveLength(total);
    expect(list.some((item) => item.id === "history-0")).toBe(true);
    expect(list[0].id).toBe(`history-${total - 1}`);
    database.close();
  }, 30_000);
});

it("paginates over 200 histories with equal timestamps without dropping or duplicating rows", async () => {
  const { database, repository } = await openRepository();
  await database.voiceRecallLocalHistory.bulkPut(Array.from({ length: 205 }, (_, index) => ({ ...history(), id: "page-" + String(index).padStart(3, "0") })));
  let cursor: { savedAt: string; id: string } | undefined;
  const ids: string[] = [];
  do {
    const page = await repository.listHistoryPage(cursor);
    expect(page.items.length).toBeLessThanOrEqual(50);
    ids.push(...page.items.map((item) => item.id));
    cursor = page.nextCursor;
  } while (cursor);
  expect(ids).toHaveLength(205);
  expect(new Set(ids).size).toBe(205);
  expect(ids[0]).toBe("page-204");
  expect(ids.at(-1)).toBe("page-000");
  expect(await database.voiceRecallLocalHistory.count()).toBe(205);
  database.close();
});

it("replayed usage observations replace operation totals and survive checkpoint saves", async () => {
  const { database, repository } = await openRepository();
  const original = session();
  await repository.putSession(original);
  await repository.recordUsage(original.id, "operation-1", { llmOutputTokens: 8 });
  await repository.recordUsage(original.id, "operation-1", { llmOutputTokens: 8 });
  await repository.putSession(original);
  expect((await repository.getSession(original.id))?.usageOperations).toEqual({ "operation-1": { llmOutputTokens: 8 } });
  database.close();
});

it("rolls back formal turn and checkpoint when cancellation wins the commit", async () => {
  const { database, repository } = await openRepository();
  await repository.putSession({ ...session(), checkpoint: { ...session().checkpoint, nextSequence: 0 } });
  await expect(repository.commitTurn(turn(), "回答", () => false)).rejects.toThrow();
  expect(await repository.listTurns("session-1")).toEqual([]);
  expect((await repository.getSession("session-1"))?.checkpoint.nextSequence).toBe(0);
  database.close();
});
