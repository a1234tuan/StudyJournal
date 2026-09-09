import type { StudyJournalDatabase } from "../../db/database";
import { db } from "../../db/database";
import type { VoiceRecallLocalHistory, VoiceRecallSessionLocal, VoiceRecallTurnLocal } from "./localTypes";

export const VOICE_RECALL_LIMITS = {
  maxTurnTextCharacters: 24_000,
  maxSessionTurns: 160,
  maxHistorySummaryCharacters: 12_000,
  completedSessionRetentionDays: 7,
  historyPageSize: 50,
} as const;

const serializedSize = (value: unknown): number => new Blob([JSON.stringify(value)]).size;

const validateSession = (session: VoiceRecallSessionLocal) => {
  if (!session.id || !session.sourceKind || session.checkpoint.nextSequence < 0) {
    throw new Error("语音复述会话检查点无效");
  }
  if (serializedSize(session) > 256 * 1024) {
    throw new Error("语音复述会话检查点超过 256 KiB 上限");
  }
};

const validateTurn = (turn: VoiceRecallTurnLocal) => {
  const textSize = [turn.teacherText, turn.providerFinalText, turn.cleanText, turn.confirmedText]
    .reduce((total, text) => total + (text?.length ?? 0), 0);
  if (!turn.id || !turn.sessionId || turn.sequence < 0 || !turn.operationId || textSize > VOICE_RECALL_LIMITS.maxTurnTextCharacters) {
    throw new Error("语音复述轮次无效或文本已达上限");
  }
};

const validateHistory = (history: VoiceRecallLocalHistory) => {
  if (!history.id || !history.title.trim() || history.summary.length > VOICE_RECALL_LIMITS.maxHistorySummaryCharacters) {
    throw new Error("本机通话历史无效或摘要已达上限");
  }
};

export class VoiceRecallRepository {
  constructor(private readonly database: StudyJournalDatabase = db) {}

  getSession(id: string) {
    return this.database.voiceRecallSessions.get(id);
  }

  async listResumableSessions() {
    const sessions = await this.database.voiceRecallSessions
      .filter((session) => !["completed", "ended", "ending"].includes(session.status))
      .toArray();
    return sessions.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  }

  async putSession(session: VoiceRecallSessionLocal) {
    validateSession(session);
    await this.database.transaction("rw", this.database.voiceRecallSessions, async () => {
      const existing = await this.getSession(session.id);
      await this.database.voiceRecallSessions.put(structuredClone({ ...session, checkpoint: existing && existing.checkpoint.nextSequence > session.checkpoint.nextSequence ? { ...session.checkpoint, nextSequence: existing.checkpoint.nextSequence, lastConfirmedText: existing.checkpoint.lastConfirmedText } : session.checkpoint, usageOperations: existing?.usageOperations ?? session.usageOperations, usageSources: existing?.usageSources ?? session.usageSources }));
    });
    return session;
  }

  async recordUsage(sessionId: string, operationId: string, usage: Partial<import("./providerRuntime").VoiceUsageTotals>) {
    await this.database.transaction("rw", this.database.voiceRecallSessions, async () => {
      const session = await this.getSession(sessionId);
      if (!session) return;
      const operations = { ...session.usageOperations, [operationId]: usage };
      const usageSources = { ...session.usageSources };
      for (const metric of Object.keys(usage) as Array<keyof typeof usage>) usageSources[metric] = metric === "ttsCharacters" ? "local-estimate" : "provider-reported";
      await this.database.voiceRecallSessions.update(sessionId, { usageOperations: operations, usageSources });
    });
  }

  async putTurn(turn: VoiceRecallTurnLocal) {
    validateTurn(turn);
    await this.database.transaction("rw", [this.database.voiceRecallSessions, this.database.voiceRecallTurns], async () => {
      const session = await this.database.voiceRecallSessions.get(turn.sessionId);
      if (!session) throw new Error("语音复述会话不存在");
      const existing = await this.database.voiceRecallTurns.where("[sessionId+sequence]").equals([turn.sessionId, turn.sequence]).first();
      if (existing && existing.id !== turn.id) throw new Error("语音复述轮次序号不能复用");
      if (!existing && await this.database.voiceRecallTurns.where("sessionId").equals(turn.sessionId).count() >= VOICE_RECALL_LIMITS.maxSessionTurns) {
        throw new Error("本次语音复述已达到轮次上限");
      }
      await this.database.voiceRecallTurns.put(structuredClone(turn));
    });
    return turn;
  }

  async commitTurn(turn: VoiceRecallTurnLocal, lastConfirmedText: string, isCurrent = () => true) {
    validateTurn(turn);
    return this.database.transaction("rw", [this.database.voiceRecallSessions, this.database.voiceRecallTurns], async () => {
      const session = await this.database.voiceRecallSessions.get(turn.sessionId);
      if (!session) throw new Error("语音复述会话不存在");
      const existing = await this.database.voiceRecallTurns.where("[sessionId+sequence]").equals([turn.sessionId, turn.sequence]).first();
      if (existing) {
        if (existing.id !== turn.id) throw new Error("语音复述轮次序号不能复用");
        return session;
      }
      if (turn.sequence !== session.checkpoint.nextSequence) throw new Error("语音复述轮次必须按顺序提交");
      if (await this.database.voiceRecallTurns.where("sessionId").equals(turn.sessionId).count() >= VOICE_RECALL_LIMITS.maxSessionTurns) {
        throw new Error("本次语音复述已达到轮次上限");
      }
      if (!isCurrent()) throw new DOMException("轮次已取消", "AbortError");
      const updatedSession: VoiceRecallSessionLocal = {
        ...session,
        checkpoint: {
          ...session.checkpoint,
          activeTurnId: undefined,
          nextSequence: session.checkpoint.nextSequence + 1,
          lastConfirmedText,
        },
        updatedAt: turn.updatedAt,
      };
      await this.database.voiceRecallTurns.put(structuredClone(turn));
      await this.database.voiceRecallSessions.put(structuredClone(updatedSession));
      if (!isCurrent()) throw new DOMException("轮次已取消", "AbortError");
      return updatedSession;
    });
  }

  listTurns(sessionId: string) {
    return this.database.voiceRecallTurns.where("sessionId").equals(sessionId).sortBy("sequence");
  }

  async saveHistory(history: VoiceRecallLocalHistory) {
    validateHistory(history);
    await this.database.voiceRecallLocalHistory.put(structuredClone(history));

    return history;
  }

  async listHistoryPage(cursor?: { savedAt: string; id: string }, pageSize = VOICE_RECALL_LIMITS.historyPageSize) {
    const size = Math.max(1, Math.min(50, pageSize));
    const collection = cursor
      ? this.database.voiceRecallLocalHistory.where("savedAt").belowOrEqual(cursor.savedAt).reverse()
      : this.database.voiceRecallLocalHistory.orderBy("savedAt").reverse();
    const rows = await collection.filter((item) => !cursor || item.savedAt < cursor.savedAt || (item.savedAt === cursor.savedAt && item.id < cursor.id)).limit(size + 1).toArray();
    const items = rows.slice(0, size);
    const last = items.at(-1);
    return { items, nextCursor: rows.length > size && last ? { savedAt: last.savedAt, id: last.id } : undefined };
  }

  listHistory() {
    return this.database.voiceRecallLocalHistory.orderBy("savedAt").reverse().toArray();
  }

  deleteHistory(id: string) {
    return this.database.voiceRecallLocalHistory.delete(id);
  }

  async repairInterruptedSessions(now = new Date().toISOString()) {
    const sessions = await this.database.voiceRecallSessions
      .filter((session) => ["connecting", "listening", "finalizing-asr", "thinking", "speaking", "reconnecting"].includes(session.status))
      .toArray();
    await this.database.voiceRecallSessions.bulkPut(sessions.map((session) => ({
      ...session,
      status: "interrupted" as const,
      updatedAt: now,
    })));
    return sessions.length;
  }

  async markSourceUnavailable(input: { recordId?: string; taskId?: string }, now = new Date().toISOString()) {
    const sessions = await this.database.voiceRecallSessions.filter((session) =>
      (input.recordId ? session.sourceRecordIds.includes(input.recordId) : false)
      || (input.taskId ? session.sourceTaskId === input.taskId : false)).toArray();
    const histories = await this.database.voiceRecallLocalHistory.filter((history) =>
      (input.recordId ? history.source.recordIds?.includes(input.recordId) : false)
      || (input.taskId ? history.source.taskId === input.taskId : false)).toArray();
    await this.database.transaction("rw", [this.database.voiceRecallSessions, this.database.voiceRecallLocalHistory], async () => {
      await this.database.voiceRecallSessions.bulkPut(sessions.map((session) => ({ ...session, status: "interrupted" as const, sourceUnavailable: true, updatedAt: now })));
      await this.database.voiceRecallLocalHistory.bulkPut(histories.map((history) => ({ ...history, sourceUnavailable: true })));
    });
    return { sessions: sessions.length, histories: histories.length };
  }

  async clearTransient() {
    await this.database.transaction("rw", [this.database.voiceRecallSessions, this.database.voiceRecallTurns], async () => {
      await Promise.all([this.database.voiceRecallSessions.clear(), this.database.voiceRecallTurns.clear()]);
    });
  }

  async cleanupCompleted(now = Date.now()) {
    const cutoff = new Date(now - VOICE_RECALL_LIMITS.completedSessionRetentionDays * 86_400_000).toISOString();
    const expired = await this.database.voiceRecallSessions
      .filter((session) => ["completed", "ended"].includes(session.status) && session.updatedAt < cutoff)
      .toArray();
    const ids = expired.map((session) => session.id);
    await this.database.transaction("rw", [this.database.voiceRecallSessions, this.database.voiceRecallTurns], async () => {
      await this.database.voiceRecallSessions.bulkDelete(ids);
      for (const id of ids) await this.database.voiceRecallTurns.where("sessionId").equals(id).delete();
    });
    return ids.length;
  }
}

export const voiceRecallRepository = new VoiceRecallRepository();
