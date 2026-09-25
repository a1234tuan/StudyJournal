import { knowledgeHash } from "./canonical";
import { KnowledgeError, type KnowledgeContext, type KnowledgeLibraryMigration } from "./domain";
import { buildKnowledgeImport, prepareKnowledgeImport, resumeKnowledgeImport } from "./import";
import { initialKnowledgeScope, KnowledgeRepository, knowledgeTables, readKnowledgeState } from "./repository";
import { readKnowledgeRemote } from "./sync";
import type { KnowledgeSyncOptions } from "./syncResult";

export const KNOWLEDGE_SYNC_LEASE_MS = 90_000;
export const withKnowledgeSyncLease = async <Result>(repository: KnowledgeRepository, options: KnowledgeSyncOptions, work: (guard: () => Promise<void>) => Promise<Result>): Promise<Result> => {
  const database = repository.database;
  const owner = repository.currentOwner();
  const generation = repository.contextGeneration();
  const leaseId = crypto.randomUUID();
  const active = () => {
    if (options.isCurrent?.() === false) throw new KnowledgeError("cancelled", "同步操作已结束");
    if (repository.currentOwner() !== owner || repository.contextGeneration() !== generation) throw new KnowledgeError("scope", "同步期间账号已变化");
  };
  active();
  if (!owner.startsWith("account:")) throw new KnowledgeError("scope", "请先登录再同步知识库");
  await database.transaction("rw", database.knowledgeSyncBindings, async () => {
    active();
    const binding = await database.knowledgeSyncBindings.get(owner);
    if (binding?.leaseId && (binding.leaseUntil ?? 0) > Date.now()) throw new KnowledgeError("busy", "另一窗口正在同步知识库");
    await database.knowledgeSyncBindings.put({ ownerScope: owner, localLibraryId: null, cloudLibraryId: null, policyVersion: 1, generation: 0, ...binding, leaseId, leaseUntil: Date.now() + KNOWLEDGE_SYNC_LEASE_MS });
  });
  const guard = async () => {
    active();
    await database.transaction("rw", database.knowledgeSyncBindings, async () => {
      active();
      const binding = await database.knowledgeSyncBindings.get(owner);
      if (binding?.leaseId !== leaseId || (binding.leaseUntil ?? 0) <= Date.now()) throw new KnowledgeError("cancelled", "同步执行权已失效");
      if ((binding.leaseUntil ?? 0) < Date.now() + KNOWLEDGE_SYNC_LEASE_MS / 2) await database.knowledgeSyncBindings.update(owner, { leaseUntil: Date.now() + KNOWLEDGE_SYNC_LEASE_MS });
    });
  };
  try { return await work(guard); }
  finally {
    await database.transaction("rw", database.knowledgeSyncBindings, async () => {
      const binding = await database.knowledgeSyncBindings.get(owner);
      if (binding?.leaseId === leaseId) {
        const { leaseId: _leaseId, leaseUntil: _leaseUntil, ...idle } = binding;
        await database.knowledgeSyncBindings.put(idle);
      }
    });
  }
};

const verifyImported = async (repository: KnowledgeRepository, migration: KnowledgeLibraryMigration, remote: boolean): Promise<boolean> => {
  const source = await readKnowledgeState(repository.database, migration.sourceLibraryId);
  if (knowledgeHash(source) !== migration.sourceHash) throw new KnowledgeError("migration", "保留来源已被其他版本修改，停止重复导入");
  const target = remote ? await readKnowledgeRemote(repository.database, migration.targetLibraryId) : await readKnowledgeState(repository.database, migration.targetLibraryId);
  return buildKnowledgeImport(source, migration.cloudLibraryId, migration.sessionId).every(command => target.receipts[command.id]?.hash === knowledgeHash(command));
};

export const migrateKnowledgeSources = async (repository: KnowledgeRepository, target: KnowledgeContext, guard: () => Promise<void>, progress: (message: string) => void): Promise<number> => {
  const database = repository.database;
  const owner = target.ownerScope;
  const targetLibrary = (await repository.assertContext(target)).library;
  if (!targetLibrary.cloudLibraryId) throw new KnowledgeError("missing", "默认知识库尚未连接");
  const sources = await database.knowledgeLibraries.where("ownerScope").anyOf([owner, "deviceGuest"]).toArray();
  const migrations = await database.knowledgeLibraryMigrations.where("ownerScope").equals(owner).toArray();
  const orderedIds = [...new Set([...migrations.filter(migration => migration.phase === "local-copying").map(migration => migration.sourceLibraryId), ...sources.filter(source => !source.cloudLibraryId && !source.detached && !source.restoreSessionId).map(source => source.id)])];
  let migrated = 0;
  for (const sourceId of orderedIds) {
    if (sourceId === target.libraryId) continue;
    await guard();
    if (await repository.isRecoveryProtected(sourceId)) continue;
    const migration = await database.transaction("rw", knowledgeTables(database), async () => {
      await guard();
      await repository.assertContext(target);
      const existing = await database.knowledgeLibraryMigrations.where("sourceLibraryId").equals(sourceId).first();
      if (existing) {
        if (existing.ownerScope !== owner || existing.targetLibraryId !== target.libraryId) throw new KnowledgeError("scope", "旧库已由其他同步工作区接管");
        const sourceSync = await database.knowledgeSyncState.get(sourceId);
        const source = await database.knowledgeLibraries.get(sourceId);
        if (!sourceSync || !source || source.ownerScope !== owner || sourceSync.epoch !== existing.sourceEpoch) throw new KnowledgeError("migration", "保留来源已变化，请核对旧内容");
        return existing;
      }
      const source = await database.knowledgeLibraries.get(sourceId);
      const sourceSync = await database.knowledgeSyncState.get(sourceId);
      if (!source || !sourceSync || ![owner, "deviceGuest"].includes(source.ownerScope) || source.cloudLibraryId || source.detached || source.restoreSessionId) throw new KnowledgeError("stale", "来源已变化");
      if (await repository.isRecoveryProtected(sourceId)) throw new KnowledgeError("protected", "来源正在保全未确认内容");
      if (sourceSync.failure || await database.knowledgeCommands.where("libraryId").equals(sourceId).filter(command => command.status === "blocked" || command.status === "unknown").count()) throw new KnowledgeError("migration", "来源有尚未核对的操作");
      const state = await readKnowledgeState(database, sourceId);
      const sourceHash = knowledgeHash(state);
      const sessions = (await repository.listImportSessions(target)).filter(session => session.sourceLibraryId === sourceId);
      if (sessions.some(session => session.sourceHash !== sourceHash)) throw new KnowledgeError("migration", "旧复制开始后来源又被编辑，需要保全核对");
      const sessionId = sessions[0]?.id ?? "auto-v1-" + knowledgeHash({ owner, cloudLibraryId: targetLibrary.cloudLibraryId, sourceId, sourceHash });
      const next: KnowledgeLibraryMigration = { ownerScope: owner, sourceLibraryId: sourceId, targetLibraryId: target.libraryId, cloudLibraryId: targetLibrary.cloudLibraryId!, sessionId, sourceHash, sourceGeneration: sourceSync.dataGeneration, sourceEpoch: sourceSync.epoch, phase: "local-copying" };
      if (sessions[0]?.status === "completed" && !await verifyImported(repository, next, false)) throw new KnowledgeError("migration", "旧复制完成证据不完整");
      await prepareKnowledgeImport(repository, sourceId, target, sessionId);
      if (source.ownerScope !== owner) {
        await database.knowledgeLibraries.put({ ...source, ownerScope: owner });
        for (const scopeOwner of [source.ownerScope, owner]) {
          const scope = await database.knowledgeBackupScopes.get(scopeOwner) ?? initialKnowledgeScope(scopeOwner);
          await database.knowledgeBackupScopes.put({ ...scope, membershipGeneration: scope.membershipGeneration + 1 });
        }
      }
      await database.knowledgeSyncState.put({ ...sourceSync, dataGeneration: sourceSync.dataGeneration + 1, dirtyGeneration: sourceSync.dirtyGeneration + 1 });
      await database.knowledgeLibraryMigrations.add(next);
      return next;
    });
    if (migration.phase !== "local-copying") continue;
    await resumeKnowledgeImport(repository, target, migration.sessionId, async (completed, total) => {
      await guard();
      progress("正在整理本机知识库：" + completed + " / " + total + " 项。");
    }, guard);
    await database.transaction("rw", knowledgeTables(database), async () => {
      await guard();
      await repository.assertContext(target);
      if (!await verifyImported(repository, migration, false)) throw new KnowledgeError("migration", "本机整理结果未完整保存");
      await database.knowledgeLibraryMigrations.update([owner, sourceId], { phase: "awaiting-cloud" });
    });
    migrated += 1;
  }
  for (const session of await repository.listImportSessions(target)) {
    if (session.status !== "active") continue;
    await resumeKnowledgeImport(repository, target, session.id, async (completed, total) => { await guard(); progress("正在继续已保存的整理：" + completed + " / " + total + " 项。"); }, guard);
  }
  await database.transaction("rw", knowledgeTables(database), async () => {
    await guard();
    await repository.assertContext(target);
    const binding = await database.knowledgeSyncBindings.get(owner);
    if (!binding) throw new KnowledgeError("cancelled", "同步执行权不存在");
    if (binding.cloudLibraryId && binding.cloudLibraryId !== targetLibrary.cloudLibraryId) throw new KnowledgeError("scope", "默认云库身份变化");
    await database.knowledgeSyncBindings.put({ ...binding, localLibraryId: target.libraryId, cloudLibraryId: targetLibrary.cloudLibraryId, generation: binding.generation + (binding.localLibraryId === target.libraryId ? 0 : 1) });
  });
  return migrated;
};

export const confirmKnowledgeMigrations = async (repository: KnowledgeRepository, target: KnowledgeContext, guard: () => Promise<void>): Promise<number> => {
  return repository.database.transaction("rw", knowledgeTables(repository.database), async () => {
    await guard();
    await repository.assertContext(target);
    const migrations = await repository.database.knowledgeLibraryMigrations.where("targetLibraryId").equals(target.libraryId).toArray();
    let pending = 0;
    for (const migration of migrations) {
      if (migration.phase === "confirmed") continue;
      if (migration.phase === "awaiting-cloud" && await verifyImported(repository, migration, true)) await repository.database.knowledgeLibraryMigrations.update([migration.ownerScope, migration.sourceLibraryId], { phase: "confirmed" });
      else pending += 1;
    }
    return pending;
  });
};
