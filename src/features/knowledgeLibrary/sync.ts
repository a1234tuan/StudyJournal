import type { StudyJournalDatabase } from "../../db/database";
import { knowledgeHash } from "./canonical";
import { emptyKnowledgeState, KnowledgeError, type KnowledgeCommand, type KnowledgeContext, type KnowledgeLibrary, type KnowledgeState } from "./domain";
import { applyKnowledgeCommand } from "./protocol";
import { applyKnowledgeCloudPacket, knowledgeCloudPacket, type KnowledgeCloudPacket, type KnowledgeCloudReceipt } from "./cloudProtocol";
import { KnowledgeRepository, knowledgeTables, readKnowledgeState, writeKnowledgeStateDelta, initialKnowledgeScope } from "./repository";
import type { KnowledgeRegistry } from "./scope";

export interface KnowledgeTransport {
  discover(): Promise<KnowledgeRegistry | null>;
  register(proposedLibraryId: string, requestId: string): Promise<KnowledgeRegistry>;
  head(libraryId: string): Promise<number>;
  commits(libraryId: string, after: number, through: number): Promise<KnowledgeCloudPacket[]>;
  receipt(libraryId: string, commandId: string): Promise<KnowledgeCloudReceipt | null>;
  publish(libraryId: string, expectedHead: number, packet: KnowledgeCloudPacket): Promise<KnowledgeCloudReceipt>;
}
export const readKnowledgeRemote = async (database: StudyJournalDatabase, libraryId: string): Promise<KnowledgeState> => {
  const state = emptyKnowledgeState();
  state.sequence = (await database.knowledgeSyncState.get(libraryId))?.cursor ?? 0;
  for (const row of await database.knowledgeRemoteEntities.where("libraryId").equals(libraryId).toArray()) {
    (state[row.collection] as Record<string, unknown>)[row.id.slice(row.collection.length + 1)] = row.value;
  }
  return state;
};
const writeRemote = async (database: StudyJournalDatabase, libraryId: string, state: KnowledgeState): Promise<void> => {
  await database.knowledgeRemoteEntities.where("libraryId").equals(libraryId).delete();
  for (const collection of ["entities", "revisions", "candidates", "groups", "receipts"] as const) {
    await database.knowledgeRemoteEntities.bulkPut(Object.entries(state[collection]).map(([id, value]) => ({ libraryId, id: collection + ":" + id, collection, value })));
  }
};
export class KnowledgeSync {
  constructor(readonly repository: KnowledgeRepository, readonly transport: KnowledgeTransport, readonly assertActive: () => Promise<void> = async () => undefined) {}

  async connect(localLibraryId?: string): Promise<{ library: KnowledgeLibrary; importSourceId?: string }> {
    await this.assertActive();
    const owner = this.repository.currentOwner();
    const generation = this.repository.contextGeneration();
    if (!owner.startsWith("account:")) throw new KnowledgeError("scope", "请先登录账号再启用知识同步");
    const localSource = localLibraryId ? await this.repository.database.knowledgeLibraries.get(localLibraryId) : undefined;
    if (localSource && localSource.ownerScope !== owner && localSource.ownerScope !== "deviceGuest") throw new KnowledgeError("scope", "不能连接其他账号的本机库");
    const existing = await this.transport.discover();
    const proposedId = localSource && !localSource.detached ? localSource.id : crypto.randomUUID();
    const registry = existing ?? await this.transport.register(proposedId, "register-" + crypto.randomUUID());
    if (this.repository.currentOwner() !== owner || generation !== this.repository.contextGeneration()) throw new KnowledgeError("scope", "发现期间账号已变化");
    await this.transport.head(registry.cloudLibraryId);
    const database = this.repository.database;
    let library: KnowledgeLibrary | undefined;
    let importSourceId: string | undefined;
    await database.transaction("rw", knowledgeTables(database), async () => {
      await this.assertActive();
      if (this.repository.currentOwner() !== owner || generation !== this.repository.contextGeneration()) throw new KnowledgeError("scope", "绑定期间账号已变化");
      library = await database.knowledgeLibraries.where("[ownerScope+cloudLibraryId]").equals([owner, registry.cloudLibraryId]).first();
      if (library) { if (localSource && localSource.id !== library.id) importSourceId = localSource.id; return; }
      const source = localLibraryId ? await database.knowledgeLibraries.get(localLibraryId) : undefined;
      if (source && source.ownerScope !== owner && source.ownerScope !== "deviceGuest") throw new KnowledgeError("scope", "不能连接其他账号的本机库");
      if (source && source.id === registry.cloudLibraryId && !source.cloudLibraryId && !source.detached) {
        library = { ...source, ownerScope: owner, cloudLibraryId: registry.cloudLibraryId, detached: false };
        await database.knowledgeLibraries.put(library);
        if (source.ownerScope !== owner) {
          for (const scopeOwner of [source.ownerScope, owner]) {
            const backupScope = await database.knowledgeBackupScopes.get(scopeOwner) ?? initialKnowledgeScope(scopeOwner);
            await database.knowledgeBackupScopes.put({ ...backupScope, membershipGeneration: backupScope.membershipGeneration + 1 });
          }
          const sourceSync = await database.knowledgeSyncState.get(source.id);
          if (sourceSync) await database.knowledgeSyncState.put({ ...sourceSync, dataGeneration: sourceSync.dataGeneration + 1 });
        }
      } else {
        const id = "cloud-" + knowledgeHash({ owner, cloudLibraryId: registry.cloudLibraryId });
        library = await this.repository.createLibrary("账号知识库", id);
        library = { ...library, cloudLibraryId: registry.cloudLibraryId };
        await database.knowledgeLibraries.put(library);
        if (source) importSourceId = source.id;
      }
    });
    if (!library) throw new KnowledgeError("missing", "无法建立知识库映射");
    const opened = await this.repository.open(library.id);
    await this.pull(opened.context);
    return { library, ...(importSourceId ? { importSourceId } : {}) };
  }

  async pull(context: KnowledgeContext): Promise<void> {
    await this.assertActive();
    const baseline = await this.repository.assertContext(context);
    let failed = { cursor: baseline.sync.cursor, sequence: baseline.sync.cursor + 1, fingerprint: knowledgeHash({ cursor: baseline.sync.cursor, phase: "transport" }) };
    try {
      await this.pullValidated(context, detail => { failed = detail; });
      await this.repository.database.transaction("rw", knowledgeTables(this.repository.database), async () => {
        await this.assertActive();
        const { sync } = await this.repository.assertContext(context);
        if (sync.failure) { const { failure: _failure, ...current } = sync; await this.repository.database.knowledgeSyncState.put(current); }
      });
    } catch (error) {
      if (error instanceof KnowledgeError && ["invalid", "receipt", "cycle"].includes(error.code)) {
        await this.repository.recordSyncFailure(context, error.code as "invalid" | "receipt" | "cycle", failed);
        throw new KnowledgeError("corrupt", "知识库历史校验失败，游标与本机内容保留");
      }
      throw error;
    }
  }

  private async pullValidated(context: KnowledgeContext, onPacket: (detail: { cursor: number; sequence: number; fingerprint: string }) => void): Promise<void> {
    const database = this.repository.database;
    const { library, sync } = await this.repository.assertContext(context);
    if (!library.cloudLibraryId) return;
    const end = await this.transport.head(library.cloudLibraryId);
    if (end < sync.cursor) throw new KnowledgeError("invalid", "云知识提交历史不能倒退");
    let cursor = sync.cursor;
    while (cursor < end) {
      onPacket({ cursor, sequence: cursor + 1, fingerprint: knowledgeHash({ cursor, end, phase: "transport" }) });
      const packets = await this.transport.commits(library.cloudLibraryId, cursor, end);
      if (!packets.length) throw new KnowledgeError("missing", "云提交尚未完整到达，请稍后重试");
      await database.transaction("rw", knowledgeTables(database), async () => {
        await this.assertActive();
        const checked = await this.repository.assertContext(context);
        if (checked.sync.cursor !== cursor) throw new KnowledgeError("stale", "另一窗口已拉取，请重试");
        let remote = await readKnowledgeRemote(database, library.id);
        for (const packet of packets) {
          onPacket({ cursor, sequence: remote.sequence + 1, fingerprint: knowledgeHash(packet) });
          if (packet.commit.sequence > end) throw new KnowledgeError("invalid", "拉取超出固定终点");
          remote = applyKnowledgeCloudPacket(remote, packet);
        }
        const before = await readKnowledgeState(database, library.id);
        const pending = (await database.knowledgeCommands.where("libraryId").equals(library.id).toArray()).sort((left, right) => left.localSequence - right.localSequence || (left.id < right.id ? -1 : 1));
        let working = structuredClone(remote);
        for (const entry of pending) {
          const receipt = remote.receipts[entry.id];
          if (receipt) {
            if (receipt.hash !== entry.hash) throw new KnowledgeError("receipt", "远端命令回执与本地意图不一致");
            await database.knowledgeCommands.delete([library.id, entry.id]);
          } else if (entry.status !== "blocked") {
            try {
              working = applyKnowledgeCommand(working, entry.command);
            } catch (error) {
              if (!(error instanceof KnowledgeError) || !["stale", "missing", "invalid"].includes(error.code)) throw error;
              const recoveryLibraryId = "recovery-" + knowledgeHash({ libraryId: library.id, epoch: checked.sync.epoch });
              if (!await database.knowledgeLibraries.get(recoveryLibraryId)) {
                await this.repository.createLibrary("同步待确认保留副本", recoveryLibraryId, true);
                const preserved = structuredClone(before);
                preserved.receipts = {};
                await writeKnowledgeStateDelta(database, recoveryLibraryId, emptyKnowledgeState(), preserved);
                await database.knowledgeSyncState.update(recoveryLibraryId, { epoch: before.sequence });
              }
              await database.knowledgeCommands.update([library.id, entry.id], { status: "blocked", blockedReason: error.code as "stale" | "missing" | "invalid", recoveryLibraryId });
            }
          }
        }
        working.revisions = { ...Object.fromEntries(Object.entries(before.revisions).filter(([, revision]) => working.entities[revision.entityId])), ...working.revisions };
        await writeRemote(database, library.id, remote);
        await writeKnowledgeStateDelta(database, library.id, before, working);
        await database.knowledgeSyncState.put({ ...checked.sync, cursor: remote.sequence, epoch: Math.max(checked.sync.epoch, working.sequence), dirtyGeneration: checked.sync.dirtyGeneration + 1 });
        cursor = remote.sequence;
      });
    }
  }

  async synchronize(context: KnowledgeContext): Promise<{ pending: number; uploaded: number }> {
    const database = this.repository.database;
    const { library } = await this.repository.assertContext(context);
    await this.assertActive();
    await this.repository.assertWritable(library.id);
    if (!library.cloudLibraryId) return { pending: await database.knowledgeCommands.where("libraryId").equals(library.id).count(), uploaded: 0 };
    await this.pull(context);
    let uploaded = 0;
    const pending = (await database.knowledgeCommands.where("libraryId").equals(library.id).toArray()).sort((left, right) => left.localSequence - right.localSequence || (left.id < right.id ? -1 : 1));
    for (const entry of pending) {
      if (entry.status === "blocked") continue;
      let done = false;
      for (let attempt = 0; attempt < 3 && !done; attempt += 1) {
        await this.repository.assertContext(context);
        const receipt = await this.transport.receipt(library.cloudLibraryId, entry.id);
        if (receipt) {
          if (receipt.commandHash !== entry.hash) throw new KnowledgeError("receipt", "知识命令回执哈希不匹配");
          await this.pull(context);
          done = true;
          continue;
        }
        await this.pull(context);
        if ((await database.knowledgeCommands.get([library.id, entry.id]))?.status === "blocked") break;
        const remote = await database.transaction("r", knowledgeTables(database), () => readKnowledgeRemote(database, library.id));
        let after = applyKnowledgeCommand(remote, entry.command);
        if (after === remote) {
          after = structuredClone(remote);
          after.sequence += 1;
          after.receipts[entry.id] = { id: entry.id, hash: entry.hash, sequence: after.sequence };
        }
        const packet = knowledgeCloudPacket(remote, after, entry.command);
        await database.transaction("rw", knowledgeTables(database), async () => {
          await this.assertActive();
          await this.repository.assertContext(context);
          await database.knowledgeCommands.update([library.id, entry.id], { status: "unknown" });
        });
        try {
          await this.transport.publish(library.cloudLibraryId, remote.sequence, packet);
          uploaded += 1;
          await this.pull(context);
          done = true;
        } catch (error) {
          if (!(error instanceof KnowledgeError) || error.code !== "stale" || attempt === 2) throw error;
          await new Promise(resolve => setTimeout(resolve, 100 * 2 ** attempt));
        }
      }
    }
    return { pending: await database.knowledgeCommands.where("libraryId").equals(library.id).count(), uploaded };
  }
}
