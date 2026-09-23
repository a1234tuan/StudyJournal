# 云同步/备份/恢复加固 —— 两份独立审计的裁定与整合报告（2026-09-23）

审查对象：两份针对同一实施（`docs/cloud-sync-backup-restore-hardening-plan-2026-09-23.md` 阶段 0–6）的独立审计报告：

- **甲** = `云同步备份恢复加固 —— 独立发布前审查报告（2026-09-23，第二轮）`（下称"第二轮审查"）
- **乙** = `cloud-sync-backup-restore-hardening-independent-review-2026-09-23.md`（下称"第一轮审查"）

审查方式：只读。**未修改任何被审文件**。唯一新建文件即本报告；一次性探针 `zz-tmp-owner-probe.test.ts` 与构建产物 `dist-adjudicate-20260923/` 均已删除，复核 `git status --porcelain` 回到基线 **34 项**，无残留。

审查基线：`HEAD = 4cd3e00`；全部实施为**未提交工作区改动**（24 修改 + 10 未跟踪）。文件 mtime 显示：`cloudSyncService.ts` 16:10、`assetIntegrity.ts` 16:13、`cloudSnapshotIntegrity.ts` 16:14、`autoBackupAdapter.ts` 16:41、`autoBackupService.ts` 16:41、`nativeRepositoryBackupService.ts` 16:47、`runtime.ts` 16:51、`storageAdapter.ts` 16:54、`AGENTS.md` 17:04。

**关键判据：两份审计读的是同一份工作区快照。** 乙报告称"24 修改 + 9 未跟踪"，甲报告称"24 修改 + 10 未跟踪"；实测为 24 + 10（甲正确）。但**代码文件在 16:10–17:04 之间持续被改动**，早于两份报告定稿 ⇒ 两者都应视为"审查了 17:04 前某时刻的工作区"，本报告**一律以当前工作区（含 17:04 版 `AGENTS.md`）为事实来源**，所有结论自行从源码与实跑重新推导。

---

## 1. 结论摘要

**共识正确**：两份审计在**核心结论**上完全一致，且**双方共同指出的唯一 P1（新设备首同步的破坏性全量替换未走 strict）经我独立复核确认真实存在**。两份审计对"不通过"的判定、对四条全量替换入口的枚举方法、对 Emulator/设备验收缺口的定级，均成立且可复现。

**分歧裁定**：两份审计的实质分歧**只有 1 处**（`aliyunTtsProvider` 3 个失败是否可复现），另有 3 处属"同一事实的不同表述精度"。**乙在第一轮报告中的测试数字（12/147、234/1889）与 aliyunTts 失败判定上完全正确；甲在第二轮报告中对 aliyunTts 的"本环境未复现"判断错误。**

**两份都漏掉的一条**：`completeKnowledgeBackup` 在**纯 owner 切换（不伴随目的地重绑）**下**会成功提交回执**——甲已用静态分析把这一组合标为"无测试、未见可达路径"，我**用一次性探针实跑证实回执确实 resolve 并写入旧 owner 的 scope**，因此这不是"未见缺陷"，而是一个**已证实的记账缺陷**。

| 判定项 | 结论 |
| :--- | :--- |
| 是否可发布 | **不通过**（两份审计一致，我维持） |
| P0 | **无**（两份一致；我复核确认） |
| P1 数量 | **1 项**（`firstEmptyDevice` 容错 + 推进 complete 标志）——两份一致，**实测成立** |
| 自动化门禁是否可复现 | **是**，但**只有乙的数字可复现**（12 文件/147 用例；234 文件/1889 用例，3 失败 0 跳过） |
| P2/P3 项合计 | 甲列 1 P1 + 3 P2 + 8 P3；乙列 1 P1 + 7 P3。**两份的 P3 项经我逐条复核，绝大多数成立** |
| 设备/真机/用户验收 | **全部未进行**（两份一致） |

---

## 2. 矛盾矩阵（同一争议点，A 说什么、B 说什么、事实是什么）

| # | 争议点 | 甲（第二轮） | 乙（第一轮） | **事实（我实跑/回源码）** | 谁对 |
| :--- | :--- | :--- | :--- | :--- | :--- |
| M-1 | 改动测试文件数与用例数 | 认同"12 文件/147 用例"，判报告"14 文件/164 用例"失实 | 同判失实，实跑 147 | `git status` 计 10 改 + 2 新 = **12**；实跑 **12 文件 / 147 用例全绿** | **双方对** |
| M-2 | 全量套件数字 | 234/1889，**0 失败 0 跳过** | 234/1889 = **1886 通过 / 3 失败 / 0 跳过** | **234 文件 / 1889 用例，3 失败 / 1886 通过 / 0 跳过**（180s） | **乙对**（甲漏报 3 失败） |
| M-3 | `aliyunTtsProvider` 的 3 个失败是否可复现 | "在我的环境（并发全量与单跑）**均通过**" | "**单跑仍失败**，预先存在、非并发导致" | **单跑即稳定 3 失败**（`AssertionError: expected 13 to be 3`），文件**未被本次改动触碰** | **乙对，甲错** |
| M-4 | 超时项：报告称有 1 个 sync 并发超时 | 未复现（我方亦未复现） | 未复现 | 我全量实跑**未出现**超时；报告自身 §"已知失败"已注明"单跑通过、属全量并发下偶发" | **双方对**（该条确是并发抖动） |
| M-5 | `restoreRemote` 是否构成第二处 P1 | 独立裁定"**不可达**，不构成第二处 P1" | 未展开 | 唯一调用点在 `cloudSyncService.ts:3003`，位于 `if (remote.exists && remote.state.headRevision > 0) { … return }` 的 legacy 分支内 ⇒ 激活路径下**确实不可达** | **甲对**（且是增量贡献） |
| M-6 | 生产归档是否恒 v7（"v6 声明脱检"是否成立） | 裁定**生产恒 v7，不成立**（纠正子代理疑点） | 未展开该争点 | `createSnapshot(includeKnowledge = true)`、`createStreamableSnapshot` 内 `includeKnowledge = true` ⇒ 四通道归档**恒 v7**；v6 仅 `createCloudSyncSnapshot()`（云同步，非归档） | **甲对** |
| M-7 | `nativeAutoBackupStreamService` 死代码是否应披露 | **应披露**（报告只披露了 `beginZipLatest`） | 未提 | `writeNativeAutoBackupStream*` **生产零调用方**（grep 全仓仅自身定义） ⇒ 与 `beginZipLatest` 同族死代码 | **甲对**（漏项） |
| M-8 | 未跟踪文件数 9 还是 10 | 10 | 9 | **10** | **甲对** |

> **结论：没有一处是两份都判对的。** 乙在测试数字与 aliyunTts 上对；甲在可达性裁定、v6/v7 裁定、死代码披露、未跟踪计数上对。**两份都只能当线索用，任何一条落地前必须回源码/实跑。**

---

## 3. 逐条裁定与证据

### 3.1 共识 P1-01 —— **成立（两份都对，且机制比两份描述得更强）**

**甲的断言**：`cloudSyncService.ts:2726` `getAllRemote(user.uid, remote.state)` 默认 `strict=false` ⇒ 容错解析静默丢弃畸形文档 ⇒ `applyRemote` 破坏性全量替换 ⇒ `:2728` `persistLedgersInTransaction(…, headRevision)` 推进 `remoteDatasetCompleteThroughRevision`。

**乙的断言**：同一条（引 `:2726-2728`、`:1377-1406`、`:1745-1761`）；补充"`cloudSyncService.integration.test.ts` 无该场景用例"。

**回源码复核**：

- `cloudSyncService.ts:2726` 原文 `const allRemote = await getAllRemote(user.uid, remote.state);` —— **第三参未传，`strict` 默认 `false`**（定义在 `:1108`）。✅ 成立
- `parseRemoteEntity`（`:463`）对缺 `entityType`/`entityId`/`contentHash`/`revision`/`payload` 的文档**返回 `undefined`**（`:474`），`parseAndNormalizeRemoteEntities` 随即 `.filter(Boolean)` **静默丢弃**。✅ 成立
- `applyRemote`（`:1375`）→ `expectedEpoch === undefined` 时走 `storage.restoreCloudSyncSnapshot(snapshot, commitCloudState)` ⇒ **破坏性全量替换**。✅ 成立
- `persistLedgersInTransaction`（`:1719`）以 `completeThroughRevision = remote.state.headRevision` 调用，`:1754` 写 `remoteDatasetCompleteThroughRevision`、并推进 `lastPulledRevision`。✅ 成立
- 对照：cloud-wins 分支（`:2916-2926`）**同时**传 `strict=true` 并调 `assertStrictRemoteDataset` ⇒ 两类"破坏性替换"入口的加固**不对称**。✅ 成立

**我比两份审计更进一步的一点（机制精度）**：`getAllRemote`（`:1108`）**根本不返回任何期望计数**，它只返回 `entities`/`reviewEvents` 数组：

```ts
const getAllRemote = async (uid, state, strict = false) => {
  const all = await getAllRemoteDocuments(uid, strict);
  return { entities: all.entities.filter(...), reviewEvents: all.reviewEvents.filter(...) };
};
```

⇒ 该路径**不只是"未启用 strict 解析"，而是缺失了那条"声明计数 vs 实读计数"的第二道防线**（`assertStrictCloudSnapshot` 的 `actualCount !== expectedCount` 校验）。即便日后有人只把第三参补成 `true`，仍**不会**获得计数校验；必须同时补 `assertStrictRemoteDataset`（这也正是两份审计共同给出的最小修复方向）。

**过三关**：
1. 机制成立 ✅（上述逐行）
2. 路径可达 ✅（`firstEmptyDevice` = `ledger.length === 0 && isBootstrapOnlyCloudData(initialExport)`，即"新设备/空库加入已有账号"这一**产品明确支持的正常流程**）
3. 后果有害 ✅ —— 会把"部分集合"当全量写入并宣告完整，`getRemoteChanges` 只取 `revision > lastPulledRevision` ⇒ **无自愈**。**不损毁本机既有数据**（首同步时本机为空库），故非本地数据丢失，但属静默不完整。

**新增断言（两份都缺，我复核确认成立）**：
```ts
const firstEmptyDevice = ledger.length === 0 && isBootstrapOnlyCloudData(initialExport);  // :2661
if (firstEmptyDevice && remote.exists && remote.state.headRevision > 0) {                  // :2715
  const allRemote = await getAllRemote(user.uid, remote.state);                            // :2726  ← 缺 strict
  await applyRemote(..., () => persistLedgersInTransaction(..., remote.state.headRevision)); // :2727-2728
```

**测试覆盖（两份一致，我复核确认）**：`grep -rn "firstEmptyDevice" src/` 仅命中 `cloudSyncService.ts` 自身；`cloudSyncModel.test.ts:507/513` 只覆盖非破坏性的 `isBootstrapOnlyCloudData` 纯函数 ⇒ **该分支零用例**。✅ 成立

**裁定：P1-01 成立，两份审计都对；甲对机制的补充（"完整性宣告"维度）比乙更完整。维持 P1。**

---

### 3.2 M-2/M-3 测试数字与 aliyunTts —— **乙对，甲错**

**实测**（我亲自运行，两次独立）：

| 命令 | 结果 |
| :--- | :--- |
| 12 个改动测试文件 | **12 文件 / 147 用例全绿** |
| `--exclude "**/*.live.test.ts"` 全量 | **234 文件 / 1889 用例：1886 通过 / 3 失败 / 0 跳过**（180s） |
| `aliyunTtsProvider.test.ts` **单跑** | **3 失败 / 5 通过**，`AssertionError: expected 13 to be 3`（`aliyunTtsProvider.test.ts:32`） |

- `git status --porcelain src/services/aliyunTtsProvider.test.ts` → **空**，该文件未被本次改动触碰。其失败根因是 `new Response(new Uint8Array([1,2,3]))` 在该 Node/jsdom 组合下 `Blob.size` 为 13（跨 realm Blob），属**既有环境性失败**。
- 甲称"单跑亦通过"⇒ **与实测相反**。甲的运行环境与基线跟本次不同（其 §5 #3 记"8/8 通过"），但**无法据此声称"报告定性有误"**——相反，报告的定性（"预先存在"）**正确**，只是数字（239/1894/4 失败/5 跳过）源于**未排除 5 个 live 文件**（234+5=239、1889+5=1894、5 skipped 恰为 live 文件数，`find src -name "*.live.test.ts" | wc -l` = **5**）。

**裁定**：乙全面正确。甲对 P2-01 的**结论**（报告数字失实）成立，但其"aliyunTts 失败不可复现 ⇒ 报告定性错误"的**推论错误**——该失败是确定性的，报告的"预先存在"定性是对的。

---

### 3.3 `restoreRemote` 可达性（M-5）—— **甲对，是增量贡献**

`restoreRemote` 定义在 `:2291`，全仓唯一调用点在 `:3003`。`:3003` 位于 `resolveCloudSyncConflict(choice="cloud")` 的**legacy 分支**内，其前置守卫为 `:2916` 的 `if (remote.exists && remote.state.headRevision > 0) { … return }`。⇒ **只要存在增量云端数据就提前返回，`restoreRemote` 不可达**；仅当 `headRevision === 0` 且无云状态时才落到 legacy 路径。

**裁定**：甲"其容错解析不可能携畸形活跃集落地，不构成第二处 P1"**成立**。这是甲相对乙的净增量（乙把 `restoreRemote` 列入"检查过的恢复入口"，但未给可达性结论）。

---

### 3.4 v6/v7 与生产归档（M-6）—— **甲对**

`storageAdapter.ts:2349` `createSnapshot(includeKnowledge = true)`；归档四通道（`backup.ts`、`streamingBackupService`、`nativeAutoBackupStreamService`、`nativeRepositoryBackupService`）均以**无参**调用 `createSnapshot()`/`createStreamableSnapshot()` ⇒ `includeKnowledge === true` ⇒ `version: 7`（`:2387`/`:2472`）。v6 仅由 `createCloudSyncSnapshot()`（`:2430` → `createSnapshot(false)`）产生，**属云同步而非归档**。

**裁定**：甲"生产恒 v7 ⇒ 'v6 声明脱检'不成立于生产路径"**成立**。乙的 P3-2 表述（"当前导出在带知识库时为 v7"）**部分对但不够精确**——它把 v6 的存在描述得比实际更含糊，甲的排除更彻底。

---

### 3.5 死代码披露（M-7）—— **甲对（乙漏项）**

- `beginZipLatest` / `writeNativeLatestBackup`：报告**已披露**。实测（两份一致）确认。
- `nativeAutoBackupStreamService.ts` 的 `writeNativeAutoBackupStream` / `writeNativeAutoBackupStreamSnapshot`：`grep -rn` 全仓（src/android/desktop）**仅命中自身定义**，**零生产调用方**。报告**未披露**，`AGENTS.md` 亦未提。

**裁定**：甲 P2-01 第三项成立，且是乙完全没提的漏项。**同族死代码应一并披露待用户决策。**

---

### 3.6 甲 P2-02「阶段 5.2 两类场景无测试」—— **部分成立，但其"未见可达路径"的判断被我用探针推翻**

甲的断言分两半：

**(a) "capture 后删除 A 零用例"** —— 成立。`runtime.ts:49` 有实现（`Object.keys(scope.capturedGenerations).some(id => !libraries.some(...))`），但四个 P5 用例只做新增/改名。

**(b) "纯 owner 切换下 `completeKnowledgeBackup` 先于 `assertKnowledgeOwner`；静态分析未见'确认新范围'的可达路径"** —— **甲的实现在位判断对，但结论保守了。**

甲的观察：`autoBackupService.ts:145` `if (scope) await completeKnowledgeBackup(scope);` 在 `:146` `assertKnowledgeOwner(taskOwner, taskGeneration)` **之前**。

**我用一次性探针实跑（`zz-tmp-owner-probe.test.ts`，已删除）**：

```
PROBE_OUTCOME::resolved                 ← 回执成功，未抛错
PROBE_A_CAPTURED::{"a-only":1}          ← 写入了旧 owner A 的 scope
PROBE_B_SCOPE_EXISTS::undefined         ← B 完全没有 scope
```

即：**纯 owner 切换（A→B，不重绑目的地）时，`completeKnowledgeBackup` 会成功 resolve，并把 `capturedGenerations` 写入 A 的 scope 行。**

机理：`completeKnowledgeBackup`（`autoBackup.ts:31-37`）按 **`token.ownerScope`（= A）** 查行，`acknowledgeKnowledgeBackup`（`scope.ts:32`）的四条件守卫中，`scope.ownerScope !== token.ownerScope` 仍**相等**（都是 A）、`token.destinationId !== verifiedDestinationId` 也**相等**（传入的正是 `token.destinationId` 自身，`autoBackup.ts:35`）⇒ 守卫**全部通过**。**当前 owner 是不是 B，这个函数根本不看。**

**为什么 P5-T4 没抓到**：`autoBackup.test.ts:133-145` 在 `changeKnowledgeOwner("account:B")` 之后**还调用了 `await authorizeKnowledgeBackup()`**，后者轮换 `destinationId`（`autoBackup.ts:16`）⇒ 拒绝其实由**目的地重绑**触发，而非 owner 切换。甲的判断完全正确。

**危害定级（我的裁定）**：回执写入的是**A 的 scope**，而 A 的库**确实已被写进归档**（`capture` 取自 A 上下文）⇒ **不是"错误地确认了 B 的库"，也不造成数据丢失**。但它是一处**语义落空**：代码意图显然是"owner 变了就不得确认"，`assertKnowledgeOwner` 被放在了无法阻止提交的位置。后续 A 若再次登录、且 `isKnowledgeBackupPending` 以 A 为当前 owner 求值，会看到"已捕获"而**跳过重新备份**，尽管那次写入发生在 owner 已切换、归档过程可能已被打断的窗口里。

**裁定：甲 P2-02(b) 的"无测试"成立；其"未见可达路径"部分错误——可达且实测 resolve。定级 P2（记账/语义），非数据丢失。** 建议修复：把 `assertKnowledgeOwner(taskOwner, taskGeneration)` **提到** `completeKnowledgeBackup` 之前，或在 `completeKnowledgeBackup` 内比较 `currentKnowledgeOwner() !== token.ownerScope` 时抛错。

---

### 3.7 两份的 P3 项逐条裁定（我复核后的合并清单）

| 项 | 出处 | 我的裁定 | 证据 |
| :--- | :--- | :--- | :--- |
| `meta.size`（DB 元数据）vs `data.size`（实际字节）声明不一致 | 甲 P3-2 | **成立（潜在可用性风险，未证实触发）** | `streamingBackupService.ts:125` 与 `nativeAutoBackupStreamService.ts:105` 用 `meta.size`；`backup.ts:67` 与 `nativeRepositoryBackupService.ts:418` 用 `data.size`。`Asset.size` 在 `storageAdapter.ts:2027` 创建时取自 `file.size`，patch 路径（`:2145`）不动 size ⇒ 漂移需外部改库。**但 `streamingBackupService` 是活通道**（`nativeBackupAdapter.ts:213/267` 调用），`nativeAutoBackupStreamService` 是死代码 |
| `destination-visible` 死枚举 | 甲 P3-7 / 乙 P3-6 | **成立** | `types.ts:376` 与 `AutoBackupPanel.tsx:67` 有定义与文案，`grep` 全 `src/` 无任何产出点；实际产出只有 `destination-readback`（`autoBackupAdapter.ts:128`）与 `archive-verified`（`nativeRepositoryBackupService.ts:89/528`） |
| 遗留永真断言 | 甲 P3-8 / 乙 P3-5 | **成立** | `nativeRepositoryBackupService.test.ts:330` `not.toContain("assets/asset-1-asset-1.png")`，而新写入器只产 `assets/<id>-<sha256>-<fileName>` ⇒ 任何实现下都成立。性质由 R5-02（`:599` `some(p => p.startsWith("assets/")) === false`）真实覆盖 |
| 空快照边界 | 甲 P3-6 | **成立（仅记录）** | `complete:true, entityCount:0` 通过 `assertStrictCloudSnapshot`（`:309-322`）且 `classify` 归 `complete` ⇒ 形式上可"以空清本机"。生产 writer 不可构造（`expectedCount` 来自实际数组长度，`:1949`），规则限本用户 |
| Emulator 未覆盖新语义 | 甲 P2-03 / 乙 P3-7 | **成立** | 我实跑 `npm run test:firebase`：2 文件 / 6 用例通过（`PERMISSION_DENIED` 为 `assertFails` 预期）；`knowledge-library-emulator.test.ts` + cloud-sync，**无**快照完成标记/批次失败/strict restore 覆盖 |
| `archive-verified` 语义偏强 | 乙 P3-3 | **成立（标签精确性）** | `readBackSnapshot`（`nativeRepositoryBackupService.ts:349-391`）回读的是快照 JSON + 容器校验和 + 声明清单，**不逐个回读资源字节** |
| v7 无 `assetChecksums` 旧包零 fixture | 甲 P3-1 / 乙 P3-2 | **成立** | 代码路径静态正确（`archiveAssetDeclarations(undefined)` → 空表 → 跳过字节比对但保留"文件必须存在"，`backup.ts:121` `if (!declaration) return;`），但无 fixture |
| `loadKeptAssetPaths` 静默 catch | 甲 P3-5 | **成立（既有代码）** | `nativeRepositoryBackupService.ts:279-281` 静默 catch 可致仍被保留快照引用的代际文件被清理；代际命名使后果更实际 |
| W4 断言弱 | 甲 P3-7 | **成立** | `autoBackupAdapter.web.test.ts:161-170` 只断 `isBound()` 前后态，**未断"`writeLatest` 未被调用"**，与用例名声称的性质不符 |
| 阶段 0 无基线证据 | 甲未列（视为未验证）/ 乙 P3-1 | **成立** | 无 Stage-0 记录产物；两份都未做 mutation check（只读授权下的合理取舍） |

---

## 4. 它漏掉的问题（我在两份之外独立发现）

### N-1（P2，两份都只擦边）`completeKnowledgeBackup` 在纯 owner 切换下会提交回执

见 §3.6。**甲把它标为"未见可达路径"，我实测可达。** 这是本轮唯一由实跑新增的缺陷，也是"双方都没说准的一条"。

### N-2（P3，两份都未展开）`restoreRemote` 也会推进 `remoteDatasetCompleteThroughRevision`

`restoreRemote`（`:2291`）虽在激活路径不可达（§3.3），但它调用 `resetAndPersistLedgersInTransaction`（`:1789`），后者**无条件**写 `remoteDatasetCompleteThroughRevision: revision`。⇒ 若未来某次重构让该路径重新可达（例如放宽 `:2916` 前置守卫），它会**继承 P1-01 完全相同的形态**，且当前**没有任何测试在场**。两份审计都只讨论其容错解析，未指出它同样会宣告"数据集完整"。建议在 P1-01 修复时把这条路径一并纳入回归网。

### N-3（提示，两份都只提了一半）`assertStrictRemoteDataset` 与 `assertStrictCloudSnapshot` 的覆盖差

cloud-wins 分支走 `assertStrictRemoteDataset`（对 `buildIncrementalRemoteDataset`/`buildFullRemoteDataset` 的结果校验），恢复点走 `assertStrictCloudSnapshot`（对子文档集合 + 父文档计数校验）。**二者都不是"父文档计数"的统一实现**：前者校验的是"读到的集合"，后者才比对"声明计数 vs 实读计数"。因此 §3.1 的结论（`firstEmptyDevice` 修复不能只补 `strict` 参数）是独立于两份审计的净结论。

---

## 5. 可执行修订清单

| 编号 | 位置 | 动作 | 优先级 |
| :--- | :--- | :--- | :--- |
| **R-1** | `cloudSyncService.ts:2726-2728` | `getAllRemote(user.uid, remote.state, **true**)` **并**追加 `assertStrictRemoteDataset({ entities, reviewEvents })`，均在任何本地写 / ledger / cursor 之前 | **P1（阻塞发布）** |
| **R-2** | `src/services/*.test.ts`（新增） | 新设备首同步前，向 `syncEntities` 注入缺 `contentHash`（或未知 `entityType`）的文档 → 断言拒绝且 `blocks/assets/cloudSyncLedger/cloudSyncState` 逐字段不变，或（若采纳"有意接受"）断言 `remoteDatasetCompleteThroughRevision` **未推进** | **P1（随 R-1）** |
| **R-3** | `autoBackupService.ts:145-146` | 把 `assertKnowledgeOwner(taskOwner, taskGeneration)` **提到** `completeKnowledgeBackup(scope)` **之前**；或在 `completeKnowledgeBackup` 内加 `currentKnowledgeOwner() !== token.ownerScope` 即抛 | **P2（本轮新增发现 N-1）** |
| **R-4** | `autoBackup.test.ts` | 新增"**纯 owner 切换且不重绑目的地**"用例：断言回执被拒、A/B 两侧 `capturedGenerations` 均不变；再补"capture 后删除 A"用例 | P2 |
| **R-5** | `AGENTS.md:5` | 把"Destructive full replacement **now uses** strict snapshot validation"收敛为限定表述（如"恢复点与 cloud-wins 路径"），或待 R-1 落地后再改为全称 | P2（证据纪律） |
| **R-6** | `AGENTS.md:5` / `docs/cloud-sync-backup-restore-hardening-report-2026-09-23.md:97` | 测试数字按实测更正：`12 changed files / 147 tests`；全量 `234 files / 1889 tests = 1886 passed / 3 failed / 0 skipped`，并注明 `--exclude "**/*.live.test.ts"`；说明"239/1894/5 skipped"来自**未排除 5 个 live 文件** | P2（证据纪律） |
| **R-7** | `AGENTS.md:5` | 补披露 `nativeAutoBackupStreamService.ts` 的 `writeNativeAutoBackupStream*` 同为**零调用方死代码**，与 `beginZipLatest` 一并待用户决策（"删除或真接线"二选一） | P2 |
| **R-8** | `docs/cloud-sync-backup-restore-hardening-plan-2026-09-23.md` §6.2 / 报告 | 补 Emulator 覆盖（"子批次失败不留可列恢复点" + "strict 拒绝畸形集合"），或**书面标注豁免** | P2 |
| **R-9** | `nativeRepositoryBackupService.test.ts:330` | 改为派生断言 `assetPathIn(firstSnapshotId, "asset-1")`，或直接删除该行 | P3 |
| **R-10** | `streamingBackupService.ts:125` | 声明改用**实际字节** `blob.size` 而非 `meta.size`（与 `backup.ts:67` / `nativeRepositoryBackupService.ts:418` 对齐），消除"自产归档被自家 size 校验拒收"的 fail-closed 风险；若维持现状则记录为已知取舍 | P3 |
| **R-11** | `types.ts:376` / `AutoBackupPanel.tsx:67` | `destination-visible` 为死枚举：删除，或注释说明"为未来平台保留、当前三端均至少 `destination-readback`" | P3 |
| **R-12** | `autoBackupAdapter.web.test.ts:161-170` | W4 补"`writeLatest` 未被调用"的直接断言，否则改名以免误导 | P3 |
| **R-13** | `cloudSyncWhitebox.test.ts:1010` | `git diff --check` 提示 EOF 空行，清理 | P3 |
| **R-14** | `cloudSyncService.ts:2291` + `:1789` | 若接受"legacy 路径不可达"为前提，加注释固化该前提；并在 R-1 的回归网中覆盖 `resetAndPersistLedgersInTransaction` 的 complete 标志语义（见 N-2） | P3 |

---

## 6. 两份审计做对的地方（不要动）

1. **两份都抓住了唯一的 P1，且定性准确**（"不损毁本机既有数据，但把部分集合当全量"）。没有一份把它误报成数据丢失，也没有一份放过它。这在"两份互相矛盾的审计"里是罕见的共识质量。
2. **两份都用"枚举全部同语义入口"的方法**找出 P1（而不是只审一个公共 helper）——正是本工作区 skill 明确要求的最易踩坑处，两份都做对了。
3. **乙的测试数字完全可复现**（12/147、234/1889/3/0），且**在 `aliyunTtsProvider` 上的判断经我独立单跑证实**（确定性的 3 失败，非并发抖动）。乙对"5 skipped = live 文件未排除"的对账逻辑也正确。
4. **甲的三处独立裁定经我复核全部成立**：`restoreRemote` 不可达（M-5）、生产恒 v7（M-6）、`nativeAutoBackupStreamService` 死代码应披露（M-7）。这三条都是乙没给出的净增量。
5. **甲 P2-02 对 P5-T4 的机理判断精准**：它指出"P5-T4 实际触发的是重绑撤 consent 分支而非 owner 分支"——我回读 `autoBackup.test.ts:133-145` 确认**完全正确**（该用例在 owner 切换后确实又调了 `authorizeKnowledgeBackup()`）。
6. **两份都未做越界动作**：未改源码/规则/数据、未部署、未登录真实账号、未接触付费服务；临时产物两份都申报并清理。
7. **两份都诚实区分了分层**（自动化 / Emulator / host / 真机 / 账号 / 部署 / 用户验收），并据此拒绝"通过"。

---

## 7. 附：核对中被证实正确的条目（"不要动"清单）

- `cloudSnapshotIntegrity.ts` 的四态分类（`complete`/`writing`/`legacy-unverified`/`unverifiable`）与 `writing`/`unverifiable` 永不提供恢复 —— **正确**（`:132-152`，`isCloudRecoverySnapshotRestorable` 仅放行前两者）。
- `assertStrictCloudSnapshot` 的"声明计数 vs 实读计数"校验、重复 ID 拒绝、身份一致性校验 —— **正确**（`:305-336`、`:170-198`）。撰写器 doc id = `entity.key` = `${entityType}:${entityId}`（`:243`、`cloudSyncModel.ts:295`），与校验器 `documentId !== expectedKey` 的期望**一致**，故严格校验对写入器产出的数据不会误拒。真实老账号数据仍属未验证（两份一致，我维持）。
- `assetIntegrity.ts` 刻意忽略实体级 `contentHashAlgorithm`（旧资源合法 `fnv1a`）—— **正确**（`:14-15` 注释即解释；`:74-88` 四类失败）。
- 数据替换与 ledger/cursor 同事务：`commitCloudState()` 是事务内**最后**一条语句（`storageAdapter.ts:2640`，"Last, so any failure here rolls the data replacement back as well"）—— **正确**。
- 普通云恢复的事务表清单**不含**任何 knowledge 表（`storageAdapter.ts:2570-2585`）—— **正确**。
- `AutoBackupVerification` 不伪造 `lastBackupVerifiedAt`：`timestampToISO(result.verifiedAt)`，适配器不报 `verifiedAt` 时不写时间戳（`autoBackupService.ts:164-165`）—— **正确**。
- 内容寻址代际路径修"同尺寸陈旧"缺陷（`assetGenerationPath`，`nativeRepositoryBackupService.ts:413`）—— **正确**，R5-01 真实覆盖。
- `freezeKnowledgeBackup` 与 `liveQuery` 共用 `isKnowledgeBackupPending`（`runtime.ts:43`）—— **正确**（避免测试自实现偏离）。
- Emulator 6/6、`tsc -b` exit 0、生产 build exit 0（我以全新目录 `dist-adjudicate-20260923` 实跑，38.61s，零删除故未被沙箱守卫拦截）—— **全部可复现**。

---

## 8. 方法论：本轮暴露的失败模式

1. **甲的"环境差异"自我豁免是危险的**（失败模式 #7 变体）。甲把 3 个确定性失败记为"我的环境未复现 ⇒ 报告定性有误"，用环境差异**否定了一个可复现的事实**。判别方法很便宜：单跑一次。**凡"两种环境结果不同"的断言，必须至少在一侧给出单跑证据。**
2. **甲的漏报同样值得记**：甲 §5 声称"全量 0 失败 0 跳过"，但实测恒定 3 失败。甲的 `--maxWorkers=4` 配置与乙相同，却得出不同结论 ⇒ 说明其运行**未失败**；这与乙、与我的两次运行都矛盾。**"我跑挂了没有"本身也需要留原始日志**，否则无法对账。
3. **静态分析不能替代一次探针**（本报告最大收获）。甲对 N-1 的组合做了正确的位置分析、却止步于"未见可达路径"。**"未见可达"与"已证实不可达"之间隔着一次 `expect(...)`**——而这个探针只花了约 40 行、一个文件、一次 44ms 的运行。甲的克制是诚实的（它如实标注了"未见"），但结论保守了一个等级。
4. **两份都在同一处（`AGENTS.md` 的"一律 strict"表述）只做文字批评，未去数"到底几条全量替换入口"**。数一遍是 4 条；其中 1 条（`firstEmptyDevice`）真缺、1 条（`restoreRemote`）不可达、1 条（cloud-wins）已修、1 条（恢复点）已修。**"一律"这个词被两份同时指出不够精确，却没人给出"4 条里 3 条真修了 1 条没修"这个可直接落地的数字。**
5. **对临时产物的时点解释双方都克制**：甲声明"以当前工作区为事实来源"并列出 mtime，乙声明了产物清理与 `git status` 回基线。两者都未编造未跟踪文件的来源时点——**这一点做得对，值得固定为习惯**。

---

## 最终自检

1. 是否亲自查了当前工作区与基线？**是**（34 项，24 改 + 10 未跟踪；核了 9 个关键文件 mtime）。
2. 是否逐条回源码复核了两份的全部可验证断言？**是**（§3，含 P1 + 双方全部 P2/P3；"不存在"类断言全部 `grep -rn` 复核）。
3. 是否实跑并记录，且与两份对账？**是**（定向 12/147；全量 234/1889/3/0；`aliyunTts` 单跑 3 失败；`tsc -b` 0；build 0；emulator 6/6）。
4. 是否设计了判别性测试？**是**（N-1 的纯 owner 切换探针，实跑证实回执 resolve；跑完即删，载荷快照已写入 §3.6）。
5. 是否对明显的事实错误和稀泥？**否**（明判 M-3 甲错、M-2 甲漏报；同时明记甲在 M-5/M-6/M-7 上对）。
6. 是否区分"结论"与"机制"？**是**（§3.2、§3.6 分列）。
7. 是否给出可执行修订编号与精确位置？**是**（R-1…R-14，逐条给文件:行与动作）。
8. 是否遵守"不修改任何文件"？**是**（唯一新建文件为本报告；探针与构建产物已删，工作树回基线 34 项）。
9. 有无未验证项？**有**：设备/真机/双设备/真实账号/生产部署/用户验收全部未进行；真实旧账号数据对 strict 校验的"过拒"风险未验证。**已据此维持"不通过"。**

**结论限制**：本报告为"独立代码 + 自动化 + 一次判别性探针"的裁定结论。即便 R-1/R-2 关闭 P1-01，仍必须完成两份审计共同要求的设备与用户验收，才可谈论发布。
