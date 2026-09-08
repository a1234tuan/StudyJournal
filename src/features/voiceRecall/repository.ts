import type { StudyJournalDatabase } from "../../db/database";
import { db } from "../../db/database";
import type { VoiceRecallLocalHistory, VoiceRecallSessionLocal, VoiceRecallTurnLocal } from "./localTypes";

export const VOICE_RECALL_LIMITS = {
  maxTurnTextCharacters: 24_000,
  maxSessionTurns: 160,
  maxHistorySummaryCharacters: 12_000,
  completedSessionRetentionDays: 7,
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
    await this.database.voiceRecallSessions.put(structuredClone(session));
    return session;
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

  async commitTurn(turn: VoiceRecallTurnLocal, lastConfirmedText: string) {
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
