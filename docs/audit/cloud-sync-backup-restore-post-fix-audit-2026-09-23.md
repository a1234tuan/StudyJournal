# 云同步 / 备份 / 恢复链路 —— 修复后链路取证式审计报告

- **审计日期**：2026-09-23
- **审计对象**：`e0b3b09`（当前 HEAD，`fix(cloud-sync): close GC/MIME/archive/cursor/merge integrity gaps from forensic audit`）
- **对照基线**：`cf4713c`（上一轮 P0/P1 加固提交）
- **审计方式**：**只读**。源码逐行取证 + 独立复跑门禁。本次审计**未修改任何代码、配置或数据**。
- **证据分级**：`[实]` 本次真实运行观测 ｜ `[码]` 回源码可判定 ｜ `[?]` 机理成立但未经判别性证据区分

---

## 0. 结论摘要

| 优先级 | 数量 | 结论 |
| --- | --- | --- |
| **P0** | **1** | `#1` GC 判据② 使**自动 Storage 清理在任何有复习记录的账号上永久静默失效**（探针实证，见 §7-P0）。不丢数据，但功能停摆，且诊断文案谎称「云端存在无法读取的同步数据」。 |
| **P1** | **4** | 见 §7：1 条功能门计数盲区、1 条告警可见性、1 条门禁实测边界、1 条已登记限制。 |

> **重要：本报告初稿曾判「P0 = 0」，该结论已被本轮补做的判别性探针推翻。** 初判把「快照半边零回归覆盖」当成纯覆盖缺口（原 P1-2），理由是「行为已由推理证明正确」。探针证明**推理是错的**：判据② 的两侧计数口径不同源（右侧会计入 **review-event 子文档**，左侧的实体解析器会丢弃它们），因此在真实数据上恒不相等。**这次的教训是：一条不可逆删除路径上的保护分支，不能靠推理结案。**

判定依据不是「没找到问题」，而是逐条走完三关：①机制在源码成立 ②从受控调用点可达 ③可达时后果真实有害。四条 P1 都在第 ①/② 关成立，但第 ③ 关的后果被证明为「弱」或「需带外篡改才触发」；唯一过完第 ③ 关的是 §7-P0。

---

## 1. 仓库现状与提交时间线

`git log --oneline -8`：

```
e0b3b09 fix(cloud-sync): close GC/MIME/archive/cursor/merge integrity gaps from forensic audit
cf4713c fix(cloud-sync): harden backup/restore integrity and remediate P0/P1 audit findings
4cd3e00 fix(knowledge-library): remediate P0 and P1 data safety issues
c9f4b68 feat(knowledge-library): refine mind map layout and node interactions
54c821a fix(knowledge-library): simplify workspace UX and unify sync controls
b19af74 fix: harden knowledge library cloud validation
b4af1f4 fix: repair voice recall and review coach audit findings
35b62f0 feat: add knowledge library v1
```

`git status --porcelain`：工作区有 **2 处已修改未提交**（`AGENTS.md`、`CHANGELOG.md`）与 **6 处未跟踪**（`docs/cloud-sync-backup-restore-integrity-fix-plan-2026-09-23.md`、`docs/cloud-sync-forensic-remediation-2026-09-24.md`、`output/` 下 4 个产物目录）。

> 观察：`AGENTS.md` 与 `CHANGELOG.md` 的改动**尚未提交**，即当前 HEAD 的 `AGENTS.md` 与工作区版本不一致。审查「文档与代码是否同步」时必须用工作区版本，不能用 `git show HEAD:AGENTS.md`。`[实]`

---

## 2. 改动面（基线 → 修复）

`git show --stat e0b3b09`：**6 文件，+486 / −28**。`[实]`

| 文件 | 增删 | 作用 |
| --- | --- | --- |
| `src/services/cloudSyncService.ts` | +131 | #1 GC 三判据、#3/#3b 归档可证性门、#4 `droppedCount`+游标冻结、#5 ledger 侧 `basePayload`、#6a/6b/6c/6d |
| `src/services/cloudSyncWhitebox.test.ts` | +335 | 白盒回归网：CONTROL + F-A-1/2、N1-A/B/C、N2-1..N2-4；并补桩（`getCountFromServer` 支持 where/limit、Storage list/deleteObject、`snap().ref`） |
| `src/services/cloudSyncModel.ts` | +7 | #5 `mergeCloudSyncSmallEntity` 空 base 保守化 |
| `src/services/cloudSyncModel.test.ts` | +17 | #5 回归 |
| `src/services/cloudSnapshotIntegrity.test.ts` | +14 | #2/#3 配套回归 |
| `src/services/assetIntegrity.ts` | +10 | #2 MIME 对称豁免 |

---

## 3. 五项收敛修复的逐项核验

### #1 Storage GC 三判据 —— `cloudSyncService.ts:2076-2105` `[码]`

```
:2076  protectedActiveCount = getCountFromServer(entitiesRef(uid))          // 无谓词，整集合
:2077  protectedSnapshotCounts = getCountFromServer(snapshotEntitiesRef(uid, id))
:2078  protectedReferenceCount = protectedActiveCount + Σ snapshotCounts
:2087  if (headRevisionUntrusted || (headRevision === 0 && protectedActiveCount > 0)) → defer
:2095  active = getAllRemoteDocuments(uid).entities                         // 无谓词，整集合（含待确认 revision > head）
:2096  snapshots = collectSnapshotEntities(uid, protectedSnapshotIds)
:2103  if (referenced.length !== protectedReferenceCount) → defer
```

核验结论：**判据①③ 正确；判据② 见 §7-P0-1 —— 它确实造成了「GC 永久停摆」的误拒。** 逐条：

1. **判据① 不可达误伤** ✅：`headRevisionUntrusted` 仅在 `headRevision` 非数值时置位（`:430`），正常云端状态文档不会触发；`headRevision === 0 && protectedActiveCount > 0` 只在「头号为零但实体仍在」的矛盾态触发。正常同步后 `head` 恒等于已发布修订号。
2. **判据② 活跃半边口径同构** ✅ / **快照半边口径不同源** ❌：左侧快照半边是**容错实体解析**（只留实体），右侧快照半边是**该子集合全部文档计数**（实体 **+ 复习事件**）。`makeRemoteSnapshot` 把复习事件写进同一子集合且不带 `entityType`/`entityId` ⇒ 左侧恒短 ⇒ 判据② 恒触发。**详见 §7-P0-1（已用探针实证）。**
3. **快照实体子文档形状兼容** ✅（但结论被错误外推）：`snapshotEntityDocument = { key, ...activeEntityDocument(entity), kind: "entity" }`（`:1858-1862`）确实携带 `parseRemoteEntity` 全部必需字段。**问题不在实体子文档，而在同一子集合里还有复习事件子文档。** `[实]`
   > **这是本次审计最值得记录的失误**：我验证了「实体子文档能解析」，就外推成「快照半边不会误拒」，漏掉了「这个子集合里还装了什么」。**推理只在读全了同一容器的内容之后才成立。**
4. **保守方向正确** ✅：唯一非对称可能是「读期间新增文档」（会使左侧偏大），但 GC 全程持有维护锁（`:2057`），其他设备无法发布 ⇒ 实际不可达；即便发生也是 `!==` ⇒ 跳过删除，方向安全。

### #2 MIME 对称豁免 —— `assetIntegrity.ts:86` `[码]`

`if (declaredMimeType && actualMimeType && declaredMimeType !== UNKNOWN && actualMimeType !== UNKNOWN && declaredMimeType !== actualMimeType) → fail`。

核验结论：**正确**。任一侧为 `application/octet-stream`（未知）即豁免，消除了「存储回传 octet-stream 导致正常附件被误拒」的单向误伤，同时保留「两侧都有具体类型且不同」的真实损坏判据。

### #3 / #3b 归档可证性门 —— `cloudSyncService.ts:2269-2341` `[码]`

在 `replaceCloudWithLocal`（以本机为准）中，创建「冲突前的云端版本」快照前，向服务端核对 `<= head`（已确认）与 `> head`（待确认）四组计数：

```
:2292  droppedUnparsable = confirmedEntities !== allRemote.entities.length || confirmedEvents !== allRemote.reviewEvents.length
:2293  hasPendingWrites  = pendingEntities > 0 || pendingEvents > 0
:2294  snapshotProvable  = !droppedUnparsable && !hasPendingWrites
:2330  if (snapshotProvable) makeRemoteSnapshot(...)  否则 :2338 progress 告警 + 跳过归档
```

核验结论：**设计正确、无「伪造完整」**（`makeRemoteSnapshot` 的 `entityCount` 取自同一数组、`assertStrictCloudSnapshot` 拿声明比对自己刚写的文档，结构上不可能发现截断 —— 这一点在注释里已说明，属实）。**但存在一处计数盲区**，见 **P1-1**。

同时确认：跳过分支**不阻断**本地优先发布（`:2343 publish` 照常执行），符合「功能不停摆」。

### #4 增量游标冻结 —— `cloudSyncService.ts:753-779`、`:2862-2876` `[码]`

`getRemoteChanges` 返回 `droppedCount = (entities.docs.length − parsed.length) + (events.docs.length − parsed.length)`（`:778`，用**原始文档数**，口径正确）。
调用侧：`droppedCount > 0` 时**冻结** `remoteDatasetCompleteThroughRevision`（置 `undefined`），但 `lastPulledRevision` 仍推进到 `head`（`:2867`、`:2875`）。

核验结论：**正确**。前者保证「不能声称已完整持有」，后者保证「不会卡在不可合并的坏文档上」。`:2874` 相比 `:2862` 少写了显式 `!== undefined`，但因 `lastPulledRevision` 恒为 number（`resetLedgersInTransaction:1790` 置 0），`undefined === number` 恒假 ⇒ 无行为差异，属风格不一致。

### #5 空 base 保守化 —— `cloudSyncModel.ts:570`、`cloudSyncService.ts:1751/1813` `[码]`

三处一致：
- `mergeCloudSyncSmallEntity`：`if (!basePayload || Object.keys(basePayload).length === 0)` ⇒ 退化为实体级冲突处理，不再对空祖先做字段级合并（避免「云端已删除的字段被静默复活」）。
- 两处 ledger 写入（`persistLedgersInTransaction:1751`、`resetAndPersistLedgersInTransaction:1813`）：`basePayload: entity.deleted || Object.keys(entity.payload).length === 0 ? undefined : entity.payload`。

grep 全仓 `basePayload` 写入点**只有这两处**，无遗漏。`[实]`

**并且确认了「活跃路径也走修好的函数」**：增量同步的字段级合并入口是 `mergeRemoteFieldChanges`（`:1376`）→ `mergeCloudSyncSmallEntity`。`[实]` 该函数同时是导出路径的辅助函数，二者同一实现，不存在「只修了辅助函数、活跃路径没修」的情况。

---

## 4. 附带项 #6a–#6d

| 项 | 位置 | 状态 |
| --- | --- | --- |
| #6a legacy-zip 迁移边界 | `:2783-2790` | 已用文档化边界替代严格校验：zip 无快照父文档可分类，其门是 `zipToSnapshot` 自身容器校验（清单格式/版本、v7 外层校验和、逐资源字节）。pre-v7 无校验和归档按「legacy-unverified」语义接受，属**明确设计决定**，非缺陷。`[码]` |
| #6b 缺口守卫文案 | `:2804` | 已改为点名「以本机为准」为绕行手段。`[码]` |
| #6c 快照墙钟回收 | `:2155-` | **未修**，注释已列明「朴素修法更糟」（改按 revision 排序会让缺字段的历史快照被排除出保护集）。见 **P1-5**。 |
| #6d legacy-zip 兜底不吞完整性异常 | `:3109` | 已修：`CloudSnapshotIntegrityError` 直接上抛，避免用旧 zip 掩盖「云端数据集被判定为损坏」的拒绝。`:1335` 资源下载侧同理。`[码]` |

---

## 5. 四条破坏性全量替换入口的严格校验核验

全部为「先校验、后落盘」，且拒绝都发生在**任何本地写入 / ledger 行 / 游标移动之前**：

| 入口 | 位置 | 校验 | 结论 |
| --- | --- | --- | --- |
| `firstEmptyDevice`（首同步） | `:2820-2823` | `getAllRemote(strict=true)` + `assertStrictRemoteDataset` | ✅ `[实]` |
| `restoreRemote`（legacy 全量） | `:2378-2379` | 同上（**该函数体实为死代码，见 O-2**） | ✅ 形式成立 |
| `resolveCloudSyncConflict` cloud-wins | `:3022-3027` | 同上 | ✅ `[实]` |
| `restoreCloudRecoverySnapshot`（快照恢复） | `:3233` | `assertStrictCloudSnapshot` | ✅ `[实]` |

严格解析器 `parseStrictEntity`（`cloudSnapshotIntegrity.ts:154`）在 `:177` 对 `revision` 施加 `isRevision` 判定并抛错 ⇒ **缺 `revision` 的文档在这三条路径上会被整体拒绝**，不会静默丢弃。`[码]` 这也正是 P1-1 之所以只影响 `#3/#3b`（那条路径用的是容错解析 + 双范围计数）的原因。

另外确认 `headRevisionUntrusted` **不会回写 Firestore**：`:1457`/`:1499`/`:1546` 虽然 `...current` 展开解析结果，但 `remoteSyncStateDocument`（`:452-467`）是**白名单投影**，只输出 `protocolVersion`/`headRevision`/`nextRevision`/`lock`/`storageSummary`（+可选 `lastLockRecovery`）。`[实]` 因此这是一个干净的只读诊断位。

---

## 6. 独立复跑门禁（本次实测）

| 门禁 | 命令 | 结果 |
| --- | --- | --- |
| 变更文件单测 | `node ./node_modules/vitest/vitest.mjs run --mode test <3 files>`（**Node v24.16.0**） | **3 文件 / 105 用例 全通过**（whitebox 42、integrity 18、model 45）`[实]` |
| 有界全量单测 | `... run --mode test --exclude "**/*.live.test.ts" --minWorkers=1 --maxWorkers=4`（**Node v24.16.0**） | **235 文件 / 1906 用例 全通过**，160.79s `[实]` |
| 类型检查 | `node ./node_modules/typescript/bin/tsc -b` | exit 0，无输出 `[实]` |
| 空白校验 | `git diff --check` | clean `[实]` |

> 本次独立复跑结果与 `e0b3b09` 提交信息 / `docs/cloud-sync-forensic-remediation-2026-09-24.md` 自述的「235 文件 / 1906 用例」**逐字一致**，回归结论得到独立证实。
> 复现注意（**O-3**）：合法命令**必须同时**给 `--minWorkers=1`；只给 `--maxWorkers=4` 会以 `RangeError: options.minThreads and options.maxThreads must not conflict` **在建池阶段直接中止**（`Test Files no tests`），极易被误读为「全量通过」。`[实]`

---

## 7. 问题清单（P0 → P1）

### P0-1 `#1` GC 判据② 两侧计数不同源 ⇒ 自动 Storage 清理永久静默失效 `[实]`

**位置**：`cloudSyncService.ts:2077` / `:2096` / `:2103`（`e0b3b09` 新增）

**问题**：判据② 比对的两个数**不同源**：

- **右侧** `protectedSnapshotCounts` = `getCountFromServer(snapshotEntitiesRef(uid, id))`（`:2077`）—— 该子集合的**全部文档**；
- **左侧** `collectSnapshotEntities` = `parseAndNormalizeRemoteEntities(children)`（`:2006`）—— 只保留能通过**实体**解析器的文档。

而 `makeRemoteSnapshot` 把**复习事件也写进同一个子集合**（`:1968`：`batch.set(doc(snapshotEntitiesRef(uid, id), REVIEW_EVENT_DOCUMENT_PREFIX + event.id), { ...event, kind: "review-event" })`）。`CloudReviewEvent = { id, contentHash, payload }`（`cloudSyncModel.ts:65-69`），加上 `revision` 与 `kind` 后**没有 `entityType` / `entityId`** ⇒ `parseRemoteEntity`（`:469-478`）直接返回 `undefined`、被 `.filter(Boolean)` 丢弃。

⇒ 只要被保护的快照里含 **≥1 个复习事件**，`referenced.length` 恒小于 `protectedReferenceCount` ⇒ 判据② 恒触发 ⇒ `cleanUpUnreferencedStorage` 恒返回 `deferred-cost`，**一个对象都不删**。

**判别性探针（临时用例，已运行并撤除，`git diff` 已确认为空）**：同一布局，唯一差别是多一个复习事件子文档：

| 用例 | 快照子文档 | `lastSnapshotMaintenanceStatus` | 实际删除 |
| --- | --- | --- | --- |
| PROBE-A | 仅实体子文档 | `completed` | `["users/…/assets/hashOrphan"]` —— 真孤儿被回收 ✅ |
| PROBE-B | 再加 1 个 `review-event` 子文档 | **`deferred-cost`** | **`[]`** —— 一个都不删 ❌ |

PROBE-B 携带的错误文案：「云端存在无法读取的同步数据，无法证明资源引用完整，已跳过资源清理以避免误删。」—— 在**没有任何损坏**的真实账号上**谎报云端数据不可读**。

**触发条件**：被保护快照含 ≥1 复习事件。`makeRemoteSnapshot` 的 `events` 参数来自 `allRemote.reviewEvents`（`:2331`）与 `exported.reviewEvents`（`:2240`）⇒ **任何有复习记录的账号都会命中**；只有「从未用过复习」的新账号不触发。`[实]`

**影响**：**不丢数据**（失败方向是保守的「跳过删除」），但：

1. 自动 Storage 清理**永久失效** ⇒ 孤儿资源 / 外置载荷对象无限累积，长期逼近 Storage 配额后**上传才会开始失败**（那一步才触及正常功能）；
2. 诊断文案误导：把「有复习事件」报成「云端存在无法读取的数据」，会把后续排查引向错误方向；
3. 每次（每日）维护都仍要全量 `listStorageObjects` 列目录 + 多组计数读，**白耗配额却什么都不做**。

**这是 `e0b3b09` 引入的回归**：判据② 系本轮新增，修复前没有这道比对，GC 正常工作。

**建议改法（小、局部）**：让两侧口径同源 —— 在 `collectSnapshotEntities`（`:2000-2008`）中把复习事件子文档也解析出来（按 doc id 前缀 `REVIEW_EVENT_DOCUMENT_PREFIX` 或 `kind === "review-event"` 用 `parseRemoteReviewEvent`），并把**两者计数之和**用于判据②。

- 实施上**建议只比较计数、不要把事件合进 `referenced` 数组**：`referenced` 目前是 `RemoteEntity[]`，混入 `RemoteReviewEvent` 会牵动类型（`referencedAssetHash`、`documentHashes` 的入参类型）。让 `collectSnapshotEntities` 返回 `{ entities, reviewEvents }`（或直接返回 `documentCount`），判据② 用 `active.length + snapshotDocumentCount` 比较，改动面最小。
- **不要改用 `where("kind","==","entity")` 计数**：早于 `kind` 字段的历史快照子文档会被右侧排除，而左侧容错解析仍会保留它们 ⇒ 反向不等、依然永久延期。

**回归建议**：把上面这对探针固化为止规用例 —— 负例「含复习事件子文档时仍应能回收真孤儿」，正例「子文档不可解析时延期」。

**本报告初判的修正**：§3 #1 第 3 点只核验了**实体**子文档的形状（该结论本身正确），但**没有核验同一个子集合里还装着复习事件** —— 于是把「形状同源」错误外推成「判据② 不会误拒」。这是本次审计里除 O-2 之外第二个「看起来对、实际错」的推理点。

---

### 已排除的高风险假设（初判 2 条，探针后仅存 1 条）

- ~~快照子文档形状不兼容 ⇒ GC 判据② 永久误拒~~ → **推翻**。实体子文档形状确与活跃文档同源，但我漏看了同一子集合里的复习事件子文档 ⇒ 误拒**真实存在**（见上方 P0-1）。
- ~~`headRevisionUntrusted` 回写 Firestore 污染云端状态文档~~ → **成立**（§5 白名单投影）。`[实]`

---

### P1-1 `#3/#3b` 归档可证性门存在「无 `revision` 字段」计数盲区 `[码]`

**问题**：`replaceCloudWithLocal` 的完整性门只用了两个**互斥的范围查询**：`where("revision","<=",head)` 与 `where("revision",">",head)`。Firestore 范围查询**要求字段存在**，因此一个 `revision` 缺失或非数值的实体文档：
- 不落入 `<= head` 计数，
- 不落入 `> head` 计数，
- 也被容错解析器丢弃（`parseRemoteEntity:476` 要求 `typeof revision === "number"`）。

两侧同时少 1 ⇒ `droppedUnparsable === false`、`hasPendingWrites === false` ⇒ `snapshotProvable === true` ⇒ **创建并声称 `complete: true` 的恢复点，而该文档被静默略过**。这恰好是这道门存在的目的（捕捉截断）未能覆盖的一类。

**与 `#1` 的口径不一致**：`#1` 判据②用的是**无谓词整集合计数**，能捕捉这一类（`referenced` 偏小 ⇒ 延期）；`#3/#3b` 用了两个范围查询，二者并集**不等于**整个集合。同一作者在同一个提交里解决了同一问题两次，只对了一次。

**触发条件**：需要云端存在 `revision` 非数值的文档 —— `publish` 恒写数值型 revision，Firestore 单文档写入又是原子的，因此**只能来自带外篡改（如控制台手改）**，正常流程不可达。`[?]`

**影响（诚实评估，弱）**：被略过的文档本来就对所有读取者不可用（容错读取丢弃、严格读取拒绝），且恢复快照是独立子集合，恢复它并不会删除 `syncEntities` 里的原文档 ⇒ 当前**不造成可用数据丢失**，主要是「`complete: true` 名不副实」，并会在未来放宽容错时变成真实丢失。

**建议改法（1 处）**：增加一个「全集」比较，口径与 `#1` 判据② 对齐 —— 例如让 `getAllRemoteDocuments` 透出原始文档数，比较 `entities.docs.length + reviewEvents.docs.length` 与 `getCountFromServer(entitiesRef|reviewEventsRef)`（无谓词）之和；或直接比较「整集合计数」与「`confirmed + pending`」。两者不等即计入 `droppedUnparsable`。

**回归建议**：新增一例「`revision` 缺失的实体文档 ⇒ 不创建声称完整的恢复点 + 给出告警」，与 F-A-1 同形。

---

### P1-2（已升级为 §7-P0-1）

原判「GC 判据② 的『快照半边』只是零回归覆盖，行为本身已由推理证明正确」—— **已被判别性探针推翻，现为 P0-1**。保留此题号以说明升级路径，不再单列。

原始观察仍然成立且值得保留：`N2-1..N2-4` 全部使用 `seedSnapshots(count)`，写入的是**无子文档**的快照父文档（`entityCount: 0`）；全仓 grep 确认**没有任何用例同时「造快照子文档」和「跑 GC」**（`snapshotChild` 只出现在 SNAP/P2 恢复类用例）。**正是这个覆盖空洞让 P0-1 一路通过 1906 个用例。**

---

### P1-3 「已跳过创建恢复点」的告警不会进入最终结果 `[码]`

**证据链**：
1. `cloudSyncService.ts:2338` 跳过归档时 `progress(options, "snapshot", "…已跳过创建「冲突前的云端版本」…")`；
2. `CloudSyncConflictDialog.tsx:45` 把它写进 `cloudSyncStore.setMessage(event.message)`；
3. 操作成功后 `CloudSyncConflictDialog.tsx:113-116` 调 `cloudSyncStore.setOutcome("success", "同步完成：上传 X 项，下载 Y 项。")`；
4. `cloudSyncStore.setOutcome` → `applyOutcome` 只改 `state.outcome`，**不动** `state.message`（`cloudSyncStore.ts:63-77`）；
5. `CloudSyncStatusToast.tsx:35-44`：`busy !== null` 时渲染 `message`，`busy === null` 后**只**渲染 `outcome.message`（`:59`）。该 toast 挂在应用壳层 root，是唯一常驻反馈面。

⇒ 操作结束后，用户看到的是**纯成功文案**，不知道恢复点被跳过。警告仅残留在 `cloudSyncStore.message` 里，由 `CloudSyncPanel.tsx:449` 的面板状态行渲染 —— 而该面板在「引导页按钮 → 冲突弹窗」这条入口下不保证挂载。

**影响**：可见性/告知缺口，**不丢数据**。用户可能在「没有恢复点」的情况下以为已有恢复点。（另注：local-wins 的操作前文案只说「正在以本机数据更新云端」，并未承诺恢复点；实际过程中会出现「正在创建恢复快照。」再由告警推翻，反差加剧误解。）

**建议改法**：把「跳过恢复点」提升到 outcome 语义 —— 例如把该句并入最终 outcome 文案，或在快照被跳过时改用可关闭的 `outcome`（而非 5 秒自动消失的 success）。服务层无需改动（F-A-1/F-A-2 已断言 `onProgress` 中出现该句）。

---

### P1-4 门禁诚实边界：「超严误拒」在两条分支上仍未实测 `[?]`

`docs/cloud-sync-forensic-remediation-2026-09-24.md` 自述的边界，本次审计确认其仍然成立：

- 真实样本量：**5 个快照、4777 文档，但 5 个快照是同一数据集 ×5** ⇒ 独立数据集实为 1 份；
- `> 750KB` 触发外置载荷（`payloadDocumentHash`）的分支**实测 0 次触发**；
- 资源字节 / MIME（`assetByteFailure`）路径**未在真实字节上验证**。

⇒ 「新门过严导致正常数据被拒 / 功能停摆」在**大模板外置载荷**与**真实附件字节**两条分支上仍只有推理、没有实测。这正是本轮修复的核心风险反向（误拒 vs 漏放）。

**建议**：用一份含大模板（> 750KB 载荷）与真实附件（含 `application/octet-stream` 回传场景）的导出快照补一次离线演练；理想情况下凑第二份彼此不同的真实数据集，让 `#0` 门禁的 0.0000% 结论脱离「单一数据集」的局限。

---

### P1-5 `#6c` 快照按墙钟 `createdAt` 排序回收（已登记限制） `[码]`

`:2155` 起注释已列明：设备时钟落后时，新创建的恢复点会被排序为「最旧」而立即被回收；并说明朴素修法（改按 `revision` 或 `serverTimestamp orderKey` 排序）会让缺少该字段的历史快照被排除出保护集，比原缺陷更糟。**属明确登记的限制，非本轮回归**，本次审计不重复计入缺陷，仅登记为待决策项。

---

## 8. 观察项（不计入 P0/P1）

**O-1 状态文档消失时 GC 会清空全部资源（当前不可达）** `[码]`
`:2095` 与 `:2076` 均以 `protectedRemote.exists` 为门：状态文档不存在时 `protectedActiveCount = 0`、`active = []`，判据① 因 `count > 0` 为假而不触发，判据② 因 `0 === 0` 而通过 ⇒ 所有 Storage 对象被当作孤儿删除。当前**不可达**：全仓无任何 `deleteDoc(stateRef(...))`，而实体/资源必须先经过 `acquireLock`/`releaseLock` 才会产生，即「实体存在 ⇒ 状态文档存在」这一不变量成立。属防御性加固建议（把 `exists === false && 整集合计数 > 0` 也纳入判据①）。

**O-2 `restoreRemote` 的严格校验是死代码** `[码]`
`:3104` 的调用点位于 `if (remote.exists && remote.state.headRevision > 0) { … }`（`:3017`）**之后**，而 `restoreRemote` 首行（`:2373`）对同一条件 `!exists || headRevision === 0` 直接抛错 ⇒ 该函数体必然抛错、其内部 `:2379` 的 `assertStrictRemoteDataset` 永不执行。该抛错随后被 `.catch` 接住，转入 legacy-zip 兜底（`:3110-3119`）——这是**有意为之的探针式写法，但极具误导性**：§5 表中「restoreRemote 入口已严格校验」在运行期实际由 legacy-zip 通道承担（其门是 `zipToSnapshot` 的容器校验，见 #6a）。建议加注释或改名，避免后续审查再次误判。

**O-3 有界全量测试的复现门槛** `[实]`
只给 `--maxWorkers=4` 会以 `RangeError: options.minThreads and options.maxThreads must not conflict` 在建池阶段中止，输出 `Test Files no tests` / `Errors 1 error`。**必须同时给 `--minWorkers=1`**。由于「no tests + 退出」在 CI 汇总里极易被当成通过，建议把该命令固化为 `package.json` 脚本（如 `test:bounded`）。

---

## 9. 本次审计**不能**证明的事

1. **未跑 Firebase Emulator**（本项目规则/协议测试需起模拟器）。本轮改动不触碰规则文件，但本报告不替代该门禁。
2. **未做桌面 / Android / Web 宿主验收**（无真机、无安装包）。`replaceCloudWithLocal` 的告警可见性（P1-3）与快照回收（P1-5）都属宿主侧行为。
3. **未触碰真实账号 / 真实数据**；`#0` 门禁的真实样本结论引自上一轮文档，非本次独立采集。
4. **`src/services/nativeAutoBackupStreamService.ts` 整链**（`beginNativeAutoBackupZip`、`writeNativeLatestBackup`、`writeNativeAutoBackupStream*`）与 Android Java `beginZipLatest` 仍为**未被引用的死代码**，其删除或接线决定仍未作出 —— 不在本次改动面内。
5. 单测通过 ≠ 无回归：**P0-1 就是「1906 个用例全绿时仍然存在」的真实回归** —— 它位于一条从未被任何用例触达的保护分支上（`N2` 系列全部使用无子文档的快照）。这也是本次审计把「覆盖空洞」从 P1 提升为 P0 判级依据的直接理由。
6. **P0-1 的触发面未在真实云端数据上统计**：探针是在内存 Firebase 桩上、按 `makeRemoteSnapshot` 的写入形状构造的判别性实验；「有多少真实账号的快照确实含复习事件」未取样（按代码路径推断为「凡有复习记录即命中」，但未实测）。
7. **P0-1 的影响未做实测量化**：孤儿对象「无限累积」到「逼近配额」的速度取决于用户上传量，本次未测量，故无法给出「多久会开始影响上传」的估计。

---

## 10. 与既有文档的一致性核对

| 文档/声明 | 本次核对 |
| --- | --- |
| `e0b3b09` 提交信息「235 files / 1906 tests」 | ✅ 逐字复现（§6） |
| `e0b3b09` 提交信息「N1-A/B/C、N2-1..N2-4、CONTROL+F-A-1+F-A-2、MIME-A、N7-A」 | ✅ 用例存在但**不足以覆盖判据② 的快照半边**（`N2` 全部使用无子文档快照）⇒ 见 §7-P0-1 |
| 提交信息称「use positive assertions, each proven red against the unfixed baseline first」 | ✅ 全仓无 `it.fails`/`test.fails`（grep 为空），F-A/N1/N2 均为正向断言 `[实]` |
| `AGENTS.md` 称四项破坏性入口均严格校验 | ✅ 形式成立（`restoreRemote` 实体不可达，见 O-2） |
| `AGENTS.md` 称「`firstEmptyDevice` 历史上把游标与完整性一起写成 head（待决策）」 | ✅ 现已由严格校验**解除该顾虑**：`getAllRemote(strict)` 保证 `revision <= head` 集合可证完整，故 `:2823` 同时写 `headRevision` 是正确的 |

---

## 附：本次审计用到的命令（可复现）

```bash
# Node 版本必须记录；默认 npx 走 v22.22.2，v24 在 /d/Node_js/node.exe
node -v && /d/Node_js/node.exe -v

git log --oneline -8 && git status --porcelain
git show --stat e0b3b09

# 变更文件单测（Node v24.16.0）
/d/Node_js/node.exe ./node_modules/vitest/vitest.mjs run --mode test \
  src/services/cloudSyncWhitebox.test.ts \
  src/services/cloudSnapshotIntegrity.test.ts \
  src/services/cloudSyncModel.test.ts

# 有界全量单测（--minWorkers 不可省，见 O-3）
/d/Node_js/node.exe ./node_modules/vitest/vitest.mjs run --mode test \
  --exclude "**/*.live.test.ts" --minWorkers=1 --maxWorkers=4

/d/Node_js/node.exe ./node_modules/typescript/bin/tsc -b
git diff --check

# P0-1 判别性探针：临时在 cloudSyncWhitebox.test.ts 的 N2 describe 内加两个用例，
# 唯一差别是快照子集合里是否含 1 个 review-event 子文档（形状照 makeRemoteSnapshot :1968 写），
# 跑完立即撤除，并以 git diff --stat -- src/services/cloudSyncWhitebox.test.ts 为空自证现场干净。
/d/Node_js/node.exe ./node_modules/vitest/vitest.mjs run --mode test \
  src/services/cloudSyncWhitebox.test.ts -t "N2-PROBE"
```

**注意**：上表的「有界全量 235/1906 全通过」与 P0-1 并不矛盾 —— P0-1 位于一条
**从未被任何用例触达**的分支上（`N2` 系列全部使用无子文档的快照）。这正是本报告 §9 第 5 条的实证。
