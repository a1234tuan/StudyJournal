import { KnowledgeError } from "./domain";
import { knowledgeUiError } from "./uiError";
import { KnowledgeSync, type KnowledgeTransport } from "./sync";
import { confirmKnowledgeMigrations, migrateKnowledgeSources, withKnowledgeSyncLease } from "./migration";
import { emptyKnowledgeSyncResult, type KnowledgeSyncOptions, type KnowledgeSyncResult, type KnowledgeSyncStage } from "./syncResult";

export const synchronizeKnowledge = async (synchronizer: KnowledgeSync, options: KnowledgeSyncOptions = {}): Promise<KnowledgeSyncResult> => {
  const result = emptyKnowledgeSyncResult();
  const repository = synchronizer.repository;
  const database = repository.database;
  try {
    return await withKnowledgeSyncLease(repository, options, async guard => {
      const pendingBefore = await database.knowledgeCommands.toArray();
      const localCommands = new Set(pendingBefore.map(entry => entry.id));
      const progress = (message: string) => options.onProgress?.(message);
      const request = async <Value>(stage: KnowledgeSyncStage, message: string, task: () => Promise<Value>): Promise<Value> => {
        await guard();
        result.stage = stage;
        progress(message);
        const value = await task();
        await guard();
        return value;
      };
      const transport: KnowledgeTransport = {
        discover: () => request("discover", "正在连接知识库。", () => synchronizer.transport.discover()),
        register: (libraryId, requestId) => request("discover", "正在准备知识库同步。", () => synchronizer.transport.register(libraryId, requestId)),
        head: libraryId => request("pull", "正在核对知识库更改。", () => synchronizer.transport.head(libraryId)),
        receipt: (libraryId, commandId) => request("confirm", "正在确认知识库上传结果。", () => synchronizer.transport.receipt(libraryId, commandId)),
        commits: async (libraryId, after, through) => {
          const packets = await request("pull", "正在下载知识库更改。", () => synchronizer.transport.commits(libraryId, after, through));
          result.downloaded += packets.filter(packet => !localCommands.has(packet.commit.commandId)).length;
          return packets;
        },
        publish: async (libraryId, head, packet) => {
          localCommands.add(packet.commit.commandId);
          const receipt = await request("publish", "正在上传知识库更改。", () => synchronizer.transport.publish(libraryId, head, packet));
          result.uploaded += 1;
          return receipt;
        },
      };
      const sync = new KnowledgeSync(repository, transport, guard);
      const { library } = await sync.connect();
      const binding = await database.knowledgeSyncBindings.get(repository.currentOwner());
      if (binding?.cloudLibraryId && binding.cloudLibraryId !== library.cloudLibraryId) throw new KnowledgeError("scope", "云端默认知识库身份已变化");
      const others = (await repository.listLibraries()).filter(item => item.cloudLibraryId && item.cloudLibraryId !== library.cloudLibraryId);
      if (others.length) throw new KnowledgeError("migration", "本机存在另一份云知识库，需核对来源");
      const opened = await repository.open(library.id);
      result.stage = "copy";
      result.migrated = await migrateKnowledgeSources(repository, opened.context, guard, progress);
      await sync.synchronize(opened.context);
      await guard();
      const unfinished = await confirmKnowledgeMigrations(repository, opened.context, guard);
      const pending = await database.knowledgeCommands.where("libraryId").equals(library.id).toArray();
      const sources = await database.knowledgeLibraries.where("ownerScope").anyOf([repository.currentOwner(), "deviceGuest"]).toArray();
      let remainingSources = 0;
      for (const source of sources) {
        if (source.cloudLibraryId || source.detached || source.restoreSessionId || await repository.isRecoveryProtected(source.id)) continue;
        if (!await database.knowledgeLibraryMigrations.where("sourceLibraryId").equals(source.id).first()) remainingSources += 1;
      }
      result.pending = pending.length;
      result.unknown = pending.filter(entry => entry.status === "unknown").length;
      result.blocked = pending.filter(entry => entry.status === "blocked").length;
      result.conflicts = await database.knowledgeConflicts.where("libraryId").equals(library.id).filter(row => row.kind === "candidateProjection" && row.value.consumedBy === null).count();
      result.stage = "confirm";
      if (result.blocked || result.conflicts) {
        result.status = "needs-attention";
        result.message = "知识库：更改已保留，有 " + (result.blocked + result.conflicts) + " 项内容需要确认。";
      } else if (result.pending || unfinished || remainingSources) {
        result.status = "pending";
        result.message = "知识库：仍有 " + result.pending + " 项更改待同步" + (unfinished ? "，首次整理尚未全部确认" : "") + (remainingSources ? "，同步期间新增的本机内容将在下次同步处理" : "") + "。";
      } else {
        result.status = result.uploaded || result.downloaded || result.migrated ? "success" : "no-change";
        result.message = result.status === "success" ? "知识库：同步完成，上传 " + result.uploaded + " 项更改，下载 " + result.downloaded + " 项更改。" : "知识库：没有新变化。";
      }
      return result;
    });
  } catch (error) {
    const failure = knowledgeUiError(error, result.stage);
    result.status = failure.category === "migration" ? "needs-attention" : ["busy", "cancelled", "timeout"].includes(failure.category) ? "pending" : "error";
    result.error = failure;
    result.message = "知识库：同步未完成，本机内容保留。" + failure.message;
    return result;
  }
};
