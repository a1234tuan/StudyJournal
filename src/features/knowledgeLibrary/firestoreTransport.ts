import { collection, doc, getDocFromServer, getDocsFromServer, limit, orderBy, query, runTransaction, where, type Firestore } from "firebase/firestore";
import { knowledgeHash } from "./canonical";
import { KnowledgeError } from "./domain";
import { normalizeKnowledgeCloudSlot, type KnowledgeCloudCommit, type KnowledgeCloudPacket, type KnowledgeCloudReceipt, type KnowledgeCloudRow } from "./cloudProtocol";
import { registerDefaultLibrary, type KnowledgeRegistry } from "./scope";
import type { KnowledgeTransport } from "./sync";

export const withKnowledgeTimeout = async <Value>(promise: Promise<Value>): Promise<Value> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([promise, new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new KnowledgeError("timeout", "知识同步请求超时，提交结果待核对；本机内容仍保留")), 30000); })]); }
  finally { if (timer) clearTimeout(timer); }
};
export const createKnowledgeTransport = (database: Firestore, uid: string): KnowledgeTransport => {
  if (!uid || uid.includes("/")) throw new KnowledgeError("scope", "知识同步账号无效");
  const root = (libraryId: string) => `knowledgeUsers/${uid}/libraries/${libraryId}`;
  const registryRef = doc(database, `knowledgeUsers/${uid}/registry/default`);
  return {
    async discover() {
      const snapshot = await withKnowledgeTimeout(getDocFromServer(registryRef));
      return snapshot.exists() ? registerDefaultLibrary(snapshot.data() as KnowledgeRegistry, "", "") : null;
    },
    async register(proposedLibraryId, requestId) {
      return withKnowledgeTimeout(runTransaction(database, async transaction => {
        const snapshot = await transaction.get(registryRef);
        if (snapshot.exists()) return registerDefaultLibrary(snapshot.data() as KnowledgeRegistry, "", "");
        const registry = registerDefaultLibrary(null, proposedLibraryId, requestId);
        transaction.set(registryRef, registry);
        transaction.set(doc(database, root(registry.cloudLibraryId) + "/state/head"), { protocolVersion: 1, sequence: 0, commandId: requestId });
        transaction.set(doc(database, root(registry.cloudLibraryId) + "/receipts/" + requestId), { protocolVersion: 1, sequence: 0, commandId: requestId, commandHash: knowledgeHash({ proposedLibraryId, requestId }), registration: true });
        return registry;
      }));
    },
    async head(libraryId) {
      const snapshot = await withKnowledgeTimeout(getDocFromServer(doc(database, root(libraryId) + "/state/head")));
      const head = snapshot.data();
      if (!head || head.protocolVersion !== 1 || !Number.isSafeInteger(head.sequence) || head.sequence < 0) throw new KnowledgeError("missing", "账号知识库提交头缺失或版本不兼容，未新建替代库");
      return head.sequence as number;
    },
    async receipt(libraryId, commandId) {
      const snapshot = await withKnowledgeTimeout(getDocFromServer(doc(database, root(libraryId) + "/receipts/" + commandId)));
      if (!snapshot.exists()) return null;
      const receipt = snapshot.data() as KnowledgeCloudReceipt;
      if (receipt.protocolVersion !== 1 || receipt.registration !== false || receipt.commandId !== commandId || !Number.isSafeInteger(receipt.sequence) || receipt.sequence < 1 || !/^[a-f0-9]{64}$/.test(receipt.commandHash)) throw new KnowledgeError("receipt", "知识命令回执格式不兼容");
      return receipt;
    },
    async commits(libraryId, after, through) {
      const documents = await withKnowledgeTimeout(getDocsFromServer(query(collection(database, root(libraryId) + "/commits"), where("sequence", ">", after), where("sequence", "<=", through), orderBy("sequence"), limit(20))));
      const packets: KnowledgeCloudPacket[] = [];
      for (const document of documents.docs) {
        const commit = document.data() as KnowledgeCloudCommit;
        if (commit.protocolVersion !== 1 || !Array.isArray(commit.slots) || commit.slots.length > 15) throw new KnowledgeError("invalid", "知识提交版本或范围无效");
        const rows: KnowledgeCloudPacket["rows"] = [];
        for (const [slot, rawItem] of commit.slots.entries()) {
          const item = normalizeKnowledgeCloudSlot(rawItem);
          if (item.collection === "revisions") {
            const revision = await withKnowledgeTimeout(getDocFromServer(doc(database, root(libraryId) + "/revisions/" + item.id)));
            if (!revision.exists()) throw new KnowledgeError("missing", "知识不可变版本尚未完整到达");
            const data = revision.data() as KnowledgeCloudRow;
            if (data.kind !== "revisions") throw new KnowledgeError("invalid", "知识版本行类型不一致，请重新同步");
            rows.push({ collection: item.collection, id: item.id, data });
          } else {
            rows.push({ collection: item.collection, id: item.id, data: { protocolVersion: 1, sequence: commit.sequence, commandId: commit.commandId, slot, payload: item.payload, hash: item.hash, kind: item.kind } });
          }
        }
        packets.push({ commit, rows, head: { protocolVersion: 1, sequence: commit.sequence, commandId: commit.commandId }, receipt: { protocolVersion: 1, sequence: commit.sequence, commandId: commit.commandId, commandHash: commit.commandHash, registration: false } });
      }
      return packets;
    },
    async publish(libraryId, expectedHead, packet) {
      return withKnowledgeTimeout(runTransaction(database, async transaction => {
        const receiptRef = doc(database, root(libraryId) + "/receipts/" + packet.receipt.commandId);
        const receipt = await transaction.get(receiptRef);
        if (receipt.exists()) {
          if (receipt.data().commandHash !== packet.receipt.commandHash) throw new KnowledgeError("receipt", "云端命令身份已被另一意图使用");
          return receipt.data() as KnowledgeCloudReceipt;
        }
        const headRef = doc(database, root(libraryId) + "/state/head");
        const head = await transaction.get(headRef);
        if (!head.exists() || head.data().protocolVersion !== 1 || head.data().sequence !== expectedHead || packet.head.sequence !== expectedHead + 1) throw new KnowledgeError("stale", "知识库云端已更新，正在重新核对");
        transaction.set(headRef, packet.head);
        transaction.set(receiptRef, packet.receipt);
        transaction.set(doc(database, root(libraryId) + "/commits/" + packet.commit.commandId), packet.commit);
        for (const row of packet.rows) transaction.set(doc(database, root(libraryId) + "/" + row.collection + "/" + row.id), row.data);
        return packet.receipt;
      }));
    },
  };
};
