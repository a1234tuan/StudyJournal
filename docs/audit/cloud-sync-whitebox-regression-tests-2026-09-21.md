# 云同步收敛修复：白盒回归测试清单（2026-09-21）

## 说明

**28 组白盒测试**，用来审查本轮（2026-09-21）云同步收敛修复的**实现本身**：直接以函数、表、字段、内部不变量为断言对象。

与黑盒清单（`cloud-sync-blackbox-acceptance-scenarios-2026-09-21.md`）的关系：**黑盒管"用户看到的对不对"，白盒管"实现是否真的按它自称的语义在跑"**。两组不可互相替代——黑盒能证明问题存在，白盒能定位到哪一条不变量被破坏。

每个用例给出四件事：**落点**（文件:符号）、**构造**（怎么把状态摆出来）、**断言**（可机检的不变量）、**它锁住什么**（为什么这条不能说"以后再补"）。

**"现状"列的含义**：
- `未跑` = 需要实际执行才能判定；
- `预期不通过` = 读代码可判定当前实现不满足该不变量（[码] 级，仍需用例确认）；
- `需裁定` = 实现行为已确定，但"应该怎样"是产品决策，用例的作用是把口径固定下来。

### 复用既有测试夹具

绝大部分用例可以直接建在 `src/services/cloudSyncService.integration.test.ts` 的夹具上——它已经提供了两件关键能力：

- **`auditSeed()`**：两个独立命名的 fake-indexeddb 库（phone / desktop）+ 各自独立的同步状态与 ledger，另加 `auditRecord()` 造合成记录；
- **`auditRemote`**：可控的 Firestore 桩，带 `documents / reads / queries / writes` 计数与三个故障注入开关 `failPublishHead`、`failMetadataBatch`、`onQuery`（在查询时同步插入副作用）。

事务故障注入用 `vi.spyOn(db.<table>, "put").mockRejectedValueOnce(...)`（`storageAdapter` 全部走 `db.<table>.put`，可精确打断）。**日期类 fixture 一律相对 `todayISO()` 生成**，禁止硬编码日期。

---

## 总览

| 编号 | 落点 | 锁住的不变量 | 现状 |
|---|---|---|---|
| W-01 | `cloudSyncModel.values()` | 软删除保留的**作用范围**必须是"带 id+deletedAt 的软删除行"，不能扩大到 tombstone | 未跑 |
| W-02 | `values()` / `materializeCloudSyncSnapshot` | 远端单条脏数据不得让整次同步永久失败 | 未跑（可达性 [?]） |
| W-03 | `repository.saveFeedbackInterpretation` | 保留软删除行不得让解读重写被永久挡死 | 未跑 |
| W-04 | `cloudSyncService.persistLedgers` | 定点核对不得冒充"已下载到某修订" | 未跑 |
| W-05 | `persistLedgers` / ledger 表 | ledger 的 `cloudRevision` 不得回退 | 未跑 |
| W-06 | `synchronizeCloudChanges` 空增量分支 | 推进游标的**前置条件**矩阵完整 | 未跑 |
| W-07 | `hasRemoteRevisionsBetween` | 守护只在真存在隐藏修订时触发，且不误伤 head+1 | 未跑 |
| W-08 | `synchronizeCloudChanges` catch 链 | 守护抛错后锁必须释放、op 必须终态、不得被误判为超时 | 未跑 |
| W-09 | `reconcileOperation` 部分成功分支 | 只记"与预期 hash+修订相符"的子集，且释放失败不得静默 | 未跑 |
| W-10 | `publish` 失败分类 | 三分类（未开始元数据 / 已提交 / 超时）互斥且完备 | 未跑 |
| W-11 | `releaseLockSafely(..., publish)` | 元数据已提交时必须带 publish 语义释放锁 | 未跑 |
| W-12 | 端到端自愈假设 | A 上传后 A 自己再同步必须 uploaded=0 | 未跑 |
| W-13 | `storageAdapter` mutation 同事务 | 故障时 epoch 与业务行一起回滚 | 未跑 |
| W-14 | `saveDailyPlan`/`deleteDailyPlan`/`linkPlanRecord`/`reclaimEmptyPlanRecords`/队列 no-op | no-op 不得 bump epoch | 未跑 |
| W-15 | `saveDailyPlan` | no-op 判定必须包含 `deletedAt`，不得复活软删除计划 | **预期不通过** |
| W-16 | `reclaimEmptyPlanRecords` 写回 | 写回计划行必须用事务内最新行，不得复活软删除计划 | **预期不通过** |
| W-17 | `saveBlock` 的 `expectedRecord` 双分支 | 无并发时必须放行；被拒时两分支必须同一可操作提示 | 未跑（[码]，需 UI 实测） |
| W-18 | `expectedRecord` 与 `updatedAt` | "仅时间戳变化"的判定口径必须固定 | 需裁定 |
| W-19 | `hasPlanRecordContent` | 回收判空口径的特征化矩阵 | 未跑 |
| W-20 | `orchestrator.analyzeFeedback` 循环 | 无并发的单次成功分析必须落地 blueprint+task | 未跑 |
| W-21 | `interpretFeedback` 的 `expected` 来源 | 必须取未过滤解读列表，否则 failed 重试永久失败 | 未跑 |
| W-22 | 助教三处 stale 拒绝 | 拒写之后必须留可恢复状态 | 未跑 |
| W-23 | `commitQuizAnswer` 守卫矩阵 | 答案不得因无关变化被丢弃，且不得重复计分 | 未跑 |
| W-24 | `transitionAdaptiveReviewTask` / `queueVerificationTask` | 证据时间戳保留 + 验证重排双分支 + 悬空 taskId 自愈 | 未跑 |
| W-25 | `useAppData` 解读门禁 | 自动整理只对本实例产生的反馈生效，且必须有手动入口 | 未跑 |
| W-26 | `useAppData` 冷启动 | 启动 + 只读浏览 + 语音暂停 = 零 epoch | 未跑 |
| W-27 | `RecordEditorPage.formalRecordRef` | 草稿基线与正式内容的一致性契约 | 未跑 |
| W-28 | `voiceRecall.putSession({allowCreate:false})` | 不得因"行还没落盘"自杀，也不得复活已清理会话 | 未跑 |

---

## 一、同步模型与远端协议

### W-01 `values()` 的软删除保留谓词（作用范围矩阵）
- **落点**：`src/services/cloudSyncModel.ts` → `values()`（`!entity.deleted || (typeof payload.id === "string" && typeof payload.deletedAt === "string")`）。
- **构造**：对**每一个** `CloudSyncEntityType` 各造三条实体：①`deleted:false` 正常行；②`deleted:true` + `payload = { id, deletedAt: "<ISO>" }`（软删除）；③`deleted:true` + `payload = { id }`（纯 tombstone）。跑 `materializeCloudSyncSnapshot`。
- **断言**：①必须落行；②必须落行且 `deletedAt` 保留；③**必须不落行**。另加 ④`deleted:true` + `payload = { id, deletedAt: "" }`（空串）：断言语义被显式固定（空串落行 = 一条"活着但 deletedAt 为空"的行，需确认下游 `listDeletedBlocks` 之类不会因此误判）。
- **它锁住什么**：这条谓词是对**所有**实体类型生效的通用规则。范围一放宽，硬删除就会被当成"软删除"而复活；范围一收紧，回收站内容就会在拉取时被抹掉，并引发第二轮反向 tombstone。

### W-02 远端脏 payload 不得让整次同步永久失败
- **落点**：`values()`（`entity.payload.id` 直接点取）。
- **构造**：在远端文档集合里手动塞一条 `payload: null` 的实体（以及一条完全缺 `payload` 字段的文档），然后跑一次同步。
- **断言**：同步必须**不抛异常**（或至少给出可操作的、指向具体键的错误），并且**同一设备再次同步时不会因为这条脏数据永远失败**；其余正常实体必须照常落地。
- **它锁住什么**：`payload` 是远端来的不可信数据。一条坏文档会让整包 materialize 抛错 ⇒ 该设备的同步**永久不可用**，而用户侧只看到"同步失败"。可达性标 [?]：需要真实旧客户端样本或人为构造远端文档才能证明它会发生，但**防御成本极低**。
- **注意**：`typeof undefined === "string"` 为 false，所以 `undefined.id` 会先抛 `TypeError`——这正是要点。

### W-03 保留软删除行不得挡死解读重写
- **落点**：`src/features/reviewCoach/repository.ts` → `saveFeedbackInterpretation`（`current = where("feedbackId").equals(...).first()`）。
- **构造**：设备 B 上存在一条 `deletedAt` 非空的解读行（模拟"另一端软删除后被保留下来"），随后在同一 feedback 上重跑 `interpretFeedback`（`force: true`）。
- **断言**：要么正常写入，要么抛出**可操作**的错误；**不得**出现"因为存在一个已软删除的 current 行而永久 `duplicate-feedback-interpretation` / `stale-feedback-interpretation`"。
- **它锁住什么**：`current` 的查询没有过滤 `deletedAt`。这条路径在修复前被"拉取会抹掉软删除行"掩盖着；**保留软删除行之后它才第一次变得可达**——属于修复自身引入的新面。

### W-04 `persistLedgers` 不得用定点核对冒充"已下载"
- **落点**：`cloudSyncService.ts` → `persistLedgers(..., completeThroughRevision?, pulledThroughRevision?)`。
- **构造**：分三种调用：①`pulledThroughRevision` 缺省；②显式传 3（而 `state.lastPulledRevision` 为 5）；③传 7。
- **断言**：①`lastPulledRevision` / `lastReviewEventRevision` **完全不变**；②取 `max(5,3) = 5`；③取 7。另断言 `remoteDatasetCompleteThroughRevision` 只受 `completeThroughRevision` 控制。
- **它锁住什么**：这是 P0-02/P0-03 的根因所在。只要有一个调用点漏传参数、或语义被当成 `revision`，游标就会重新越过未读修订。

### W-05 ledger 的 `cloudRevision` 必须单调不回退
- **落点**：`persistLedgers` → `db.cloudSyncLedger.bulkPut(rows)`（`cloudRevision: revision`）。
- **构造**：先对键 `block:one` 以 `revision = 5` 持久化，再以 `revision = 3` 持久化（模拟"定点核对 + 正常拉取"乱序）。
- **断言**：ledger 中该键的 `cloudRevision` **不得**从 5 降到 3（要么拒绝、要么取 max）。同时断言内容 hash 也不得被更旧的值覆盖。
- **它锁住什么**：ledger 是"我确认过什么"的唯一账本。回退会让后续核对误判"某个修订没提交"，进而触发重复上传或错误的冲突判定。

### W-06 空增量推进游标的前置条件矩阵
- **落点**：`synchronizeCloudChanges` 的 `if (!restored && downloaded === 0 && remote.state.headRevision > state.lastPulledRevision)` 分支及其后的 `afterPullState` 取值。
- **构造**：四组组合：①`head > lastPulled`、`remoteDatasetCompleteThroughRevision === lastPulled`；②同上但 complete-through 落后（`undefined` 或更小）；③`head === lastPulled`；④`head < lastPulled`（本地领先）。
- **断言**：①推进游标且下一轮**零查询零写**；②推进 `lastPulledRevision` 但 `remoteDatasetCompleteThroughRevision` 不得被伪装成已完整；③④不得推进、不得触发多余的 `localState()`/`exportCloudSync()` 重算（用调用计数断言）。
- **它锁住什么**：这就是"看起来没变化，其实游标被推过头"的入口。第④组还额外保护"本机领先于云端"时不被倒退。

### W-07 `hasRemoteRevisionsBetween` 的短路与误伤
- **落点**：`cloudSyncService.ts` → `hasRemoteRevisionsBetween`；调用点 `synchronizeCloudChanges`（在 `acquireLock` **之后**、`getRemoteState` 之后）。
- **构造**：①`beforeRevision <= afterRevision + 1`（`lock.revision === head + 1`，即正常情况）；②`head = 1, lock.revision = 3`，区间内**有**一个实体文档；③同②但区间内**只有**一个 reviewEvent 文档；④同②但区间为空。
- **断言**：①**不得发起任何查询**（短路，用 `auditRemote.queries` 计数）；②③必须抛"尚未确认的同步写入"；④必须放行。同时断言：只有在②③这两种真存在隐藏修订时才付出最多两个 `limit(1)` 查询。
- **它锁住什么**：这条守护是"宁可暂停写入，也不覆盖看不见的数据"的最后一道闸。短路条件写错（例如把 `+1` 写漏）会让**每一次正常同步都被拦死**；范围写错则完全失效。

### W-08 守护抛错后的清理与分类
- **落点**：`synchronizeCloudChanges` 的 `try/catch`（`catch` 链顺序：`CloudSyncResultUnknownError` → `isTimeoutError` → `CloudSyncLocalMutationError` → 通用）。
- **构造**：制造 W-07②的隐藏修订场景，跑同步并捕获异常。
- **断言**：①远端锁被释放（`syncState/current` 的 `lock === null`）；②本地 operation 行处于**终态**（`failed`），不得残留 `pending`/`unknown`；③异常消息**不得**命中 `/超时|timeout/i`（否则会被归成"结果未知"，把一次确定性拒绝变成一次需要核对的未知态）。
- **它锁住什么**：守护的目的是保护数据，不是把用户锁在门外。这三条任一破掉，用户就会遇到"两端都同步不了，且没有任何提示能解释"，只能等锁 TTL 过期。

### W-09 部分提交的核对边界
- **落点**：`reconcileOperation` 新增的 `partialEntities/partialEvents` 分支（过滤条件：`entity.revision === operation.revision` 且 `expected.some(key + contentHash 相符)`）。
- **构造**：造一个 `unknown` 操作，`expectedEntities` 有 3 个键；远端只有其中 2 个存在且 `revision === operation.revision`，第 3 个不存在，另塞 1 个**同键但 revision 更高**的文档。
- **断言**：①ledger 只新增那 2 个子集；②`operation.status === "failed"` 且 `reconciliationReason` 说明"部分提交"；③下一次同步只上传剩余 1 个（用 `uploaded` 数值断言）；④**同键 revision 更高的文档不得被按"最新时间"覆盖**；⑤`lockReleaseError / lockReleaseAttempts` 被清理为 `undefined`。
- **它锁住什么**：这是"一半成功"这种最难处理的状态。漏记 → 重复上传并可能与对方的更新打架；多记 → 剩下那部分永久丢失。

### W-10 `publish` 失败三分类的互斥与完备
- **落点**：`publish` 的 `metadataStarted / metadataCommitted / timedOut` 与 `catch` 分支。
- **构造**：三组注入：①`failMetadataBatch = 1`（第一批就失败，`metadataStarted = true`、`metadataCommitted = false`）；②`failPublishHead = true`（元数据全成、head 提交失败）；③在元数据之前注入一个消息含"超时"的错误。
- **断言**：①→`unknown` + 普通释放锁，且后续核对能收敛为 `failed`（不得留下永久 `unknown`）；②→`unknown` + **带 publish 语义**释放锁（见 W-11）；③→`unknown`（保持原行为）。三者的 operation 终态与 `lockReleaseError` 组合必须互不混淆。
- **它锁住什么**：分类错一个，就会出现"数据在云上但 head 没动"（隐藏写入）或"其实什么都没写却要求用户核对"（噪音）。

### W-11 元数据已提交时必须带 publish 语义释放锁
- **落点**：`releaseLockSafely(uid, lock, publish, error)` 的第三参；调用点 `publish` 的 catch。
- **构造**：用 `failPublishHead = true` 制造②，然后在 `releaseLockSafely` 上打桩记录第三参，并检查远端 `headRevision`。
- **断言**：当且仅当 `metadataCommitted === true` 时第三参为 `true`；且释放后 `headRevision` 前进到该修订（让已提交的元数据对其它设备可见）。若释放失败，必须记录 `lockReleaseError / lockReleaseErrorAt / lockReleaseAttempts` 并保留待核对状态。
- **它锁住什么**：head 不前进而元数据已提交 = 云端存在**永久不可见**的数据；这正是"隐藏修订"保护要拦的东西，不能由修复自己制造出来。

### W-12 "自愈"假设必须被证伪或证实
- **落点**：`storageAdapter.ts` 的注释声称"下一次同步会自然重算出差异并重新上传"；真实链路是 `deriveLocalCloudChanges(exportCloudSync(snapshot), ledgerFor())`。
- **构造**：A 上传一条记录 → B 拉到 → A 再同步 → B 再同步。
- **断言**：三次之后 `uploaded` 全为 0，且远端该键的 `revision` 不再增长（用 `auditRemote.writes` 断言）。
- **它锁住什么**：注释里的自愈结论在双设备下**不成立**（A 的 ledger 已记录该键，不会再当差异上传）。这条用例的作用是防止后人依据注释做出错误的修复决策。

---

## 二、本地写入、事务与 epoch

### W-13 mutation 与业务写同事务 + 故障回滚
- **落点**：`storageAdapter.ts` → `saveDailyPlan` / `deleteDailyPlan` / `linkPlanRecord` / `reclaimEmptyPlanRecords` / `saveBlock` 普通分支（`bumpCloudSyncMutationInTransaction` 均在事务内）。
- **构造**：对每个入口各跑一次成功路径与一次失败路径（用 `vi.spyOn(db.dailyPlans, "put").mockRejectedValueOnce(...)` 打断业务写）。
- **断言**：失败路径下 **epoch 与业务行一起回滚**（`getCloudSyncMutationEpoch()` 不变、行状态不变）；成功路径下 epoch **恰好 +1**（不是 +2）。
- **它锁住什么**：这正是 P0-04。epoch 与数据不同步会导致"同步器认为没有变化而跳过"或"认为有变化而反复重试"。

### W-14 no-op 路径不得 bump epoch
- **落点**：`saveDailyPlan`（相同计划）、`deleteDailyPlan`（重复删除）、`linkPlanRecord`（同值关联、目标已软删除）、`recordQueueItemNote`（note 未变）、`transitionAnalysisQueueItem`（状态与 batchId 未变）、`requeueAnalysisQueueItem`（已 eligible 且无 batchId 且无消费标记）、`transitionTask`（同状态同 reason）。
- **断言**：以上每一种，epoch 与表中的 `updatedAt` 都**不得**变化；对应地，后续同步必须是 `uploaded: 0`。
- **它锁住什么**：no-op 写是双端"互相打断"的主要来源（每端每次碰一下都制造一次差异）。

### W-15 `saveDailyPlan` 的 no-op 判定必须包含 `deletedAt` — **预期不通过**
- **落点**：`storageAdapter.ts` → `saveDailyPlan`：`if (current && deepEqualIgnoring(current, plan, ["updatedAt"])) return current;` 之后**直接** `put(touch(plan))`，**没有** `current.deletedAt` 守卫（对比 `deleteDailyPlan` / `linkPlanRecord` 都加了）。
- **构造**：先 `deleteDailyPlan("p")`（行上 `deletedAt` 有值），再拿一份**删除前**的计划对象（不含 `deletedAt`）执行 `saveDailyPlan`。
- **断言**：计划**不得**被复活（仍应为软删除态，`listDeletedDailyPlans()` 里仍在、`listDailyPlans()` 里不在）。
- **当前实现的行为（[码] 级，读代码可判定）**：`deepEqualIgnoring` 只忽略 `updatedAt`，`deletedAt` 的不一致会让它判定"不同" → `put(touch(plan))` 写入一个**没有 `deletedAt` 的行** ⇒ 复活，并产生一次真实上传。
- **它锁住什么**：页面上"打开着计划编辑器"与"另一端删除了这个计划"完全可能同时发生（黑盒 BB-05/BB-07 就是这条的用户视角）。同批改动给 `linkPlanRecord` 加了守卫却没给 `saveDailyPlan` 加，属于**不一致**。

### W-16 `reclaimEmptyPlanRecords` 写回计划行必须用事务内最新行 — **预期不通过**
- **落点**：`storageAdapter.ts` → `reclaimEmptyPlanRecords`：`plans` 数组在**事务外**读取（`db.dailyPlans.toArray()`），事务内写回时用的是这份**陈旧副本**（`for (const plan of plans) { if (plan.deletedAt || …) continue; await db.dailyPlans.put({ ...plan, linkedRecordId: undefined }) }`）。
- **构造**：用 `auditRemote.onQuery` 或事务钩子在"外层读完之后、事务开始之前"把某个候选计划改成软删除（模拟另一端刚删），然后执行 `reclaimEmptyPlanRecords`。
- **断言**：该计划**不得**被复活（写回的必须是事务内的最新行，或写回时明确保留 `deletedAt`）；注释里"soft-deleted plans … Their rows are simply not written back"的承诺必须真的成立。
- **当前实现的行为（[码] 级）**：`plan.deletedAt` 读的是陈旧值（`undefined`）→ 写回一个无 `deletedAt` 的行 ⇒ 复活 + 一次多余上传。
- **它锁住什么**：函数注释明确承诺了这条语义；实现与注释不一致时，注释会误导下一个改动者（与 W-12 同类的"注释债务"）。

### W-17 `expectedRecord` 双分支必须等价
- **落点**：`storageAdapter.ts` → `saveBlock` 的两条分支：`saveRecordWithDecisionBlocks(..., options.expectedRecord)`（抛 `ReviewCoachValidationError("stale-record")`）与普通分支（抛普通 `Error("正式内容已更新，请核对本机草稿后再保存。")`）。
- **构造**：①**无并发**：`initialize()` 之后从快照里取记录对象，直接 `saveBlock(记录)`（内容不变）与 `saveBlock({...记录, title: "改"})`；②**有并发**：保存前把 DB 行改掉，分别走"有决策块"和"无决策块"两条分支。
- **断言**：①两次保存都必须**成功**（这是最高优先级的断言：`deepEqualIgnoring(current, expectedRecord, [])` 不忽略任何键，一旦快照对象与 DB 行有任何字段差异，**所有保存都会被拒**）；②被拒时两分支必须给出**同一种可操作的中文提示**，且**本机草稿必须仍在**。
- **风险（[码]）**：`ReviewCoachValidationError` 继承 `Error`、**不是** `ActionableError`，会经过 `formatActionableError` 被换成通用文案 + 本地生成的诊断编号。于是同一种失败在两分支下呈现为两种体验（一条中文句子 vs 一段通用文案）。**需在实际 UI 上确认最终文案**。
- **它锁住什么**："拒写"必须只拒绝真正过期的保存；误杀正常保存会直接让应用不可用，而这类误杀在单测里最容易漏（单测通常用同一个对象既当 DB 行又当 expected）。

### W-18 `expectedRecord` 与"仅时间戳变化"的口径 — **需裁定**
- **落点**：同 W-17；页面侧 `RecordEditorPage` 的判断是 `remoteRecordChangedRef.current || latestRecordRef.current.updatedAt !== formalRecordRef.current.updatedAt || hasDraftChanges(...)`。
- **构造**：只在另一端对同一记录做一次"内容等价"的写入（内容一致，只有 `updatedAt` 变化），然后在本机点保存。
- **断言**：把口径**固定下来**并写成断言：要么"拒绝 + 给出口（丢弃草稿/以正式为准后可保存）"，要么"忽略 `updatedAt` 正常保存"。**不允许**出现"拒绝、但没有任何办法继续保存"。
- **它锁住什么**：这是最容易把用户卡死的一类边界，而它偏偏不会报错、只是"保存没反应"。

### W-19 判空口径的特征化矩阵
- **落点**：`src/lib/dailyPlan.ts` → `hasPlanRecordContent`（`recordToPlainText(...).trim() !== ""` || `assets.length` || `formulas.length` || `tags.length`）。
- **构造**：分别构造只含 空段落 / 只含图片 / 只含公式 / 只含标签 / 只含空表格 / 只含引用块 / 含空格的段落 的记录，跑 `hasPlanRecordContent` 与 `reclaimEmptyPlanRecords`。
- **断言**：把每一格的结论**显式固定**（哪些可回收、哪些不可回收）。特别确认：只含图片、只含公式的记录**必须不可回收**。
- **它锁住什么**：判空规则一旦只看纯文本，用户"只有图片/公式"的记录会被静默物理删除（黑盒 BB-10 的主角）。这里用特征化测试把口径钉住，避免后人"顺手简化"。

---

## 三、学习助教链路

### W-20 无并发的单次成功分析必须落地 blueprint + task
- **落点**：`orchestrator.ts` → `analyzeFeedback` 的子批循环：`runningBatchVersion = batch`（`updateAnalysisBatch` 之后）→ `persistAnalysisCandidate(..., runningBatchVersion)` → `acceptBlueprint(..., expectedBatchUpdatedAt)` / `createTask(..., expectedBatchUpdatedAt)`；同一子批成功后**又**用 `runningBatchVersion` 再 `updateAnalysisBatch` 一次。
- **构造**：AI 桩返回**一个**子批、**两个** blueprint 候选，全程无任何并发写入。
- **断言**：两个 blueprint 与两个 task 都必须落地；**不得**抛 `stale-analysis-batch`；批次最终状态为 `succeeded`。
- **它锁住什么**：`expected` 与"当前批次"必须是同一个版本快照。若 `runningBatchVersion` 的捕获点或复用点写错，**任何一次分析都产出不了蓝图与任务**——而这类失败在 UI 上只显示一条通用错误（助教链路不留痕，见项目记忆）。这是本轮改动最需要先跑通的一条。

### W-21 `expected` 必须取自未过滤的解读列表
- **落点**：`orchestrator.ts` → `interpretFeedback`：`current = allInterpretations.find(...)`（来自 `repository.listFeedbackInterpretations()`），而不是 `getFormalSnapshot().feedbackInterpretations`（后者被过滤成只剩 `succeeded` / `insufficient-context`）。
- **构造**：造一条 `status: "failed"` 的解读，走 `retryFeedbackInterpretation` → `interpretFeedback({ force: true })`。
- **断言**：重试必须**成功**（写出一条新的 `pending`/`running` 行），**不得**抛 `stale-feedback-interpretation`。
- **它锁住什么**：`expected` 传的是"我以为数据库里是什么"。一旦有人把来源换成过滤后的快照，`failed` 的解读会被当成"不存在"（`expected = null`）而数据库里明明有一行 ⇒ **重试永久失败**，且按钮看起来"点了没反应"。这条用例是防止该回归的钉子。

### W-22 stale 拒绝之后必须留可恢复状态
- **落点**：`repository.ts` → `updateAnalysisBatch` / `acceptBlueprint` / `createTask` 的 `expected` 检查。
- **构造**：在 AI 调用返回**之前**让批次被另一端更新（直接改表），再让 AI 返回并落库。
- **断言**：①抛 `stale-*`；②**不得**写入任何 blueprint/task/outcome，**不得** bump epoch；③队列项必须仍处于可重试状态（`eligible`），批次**不得**永久停在 `running`；④随后一次正常重试能成功。
- **它锁住什么**："正确拒写"只完成了一半——**拒写之后的烂摊子由谁收拾**。若批次卡在 `running`，用户会看到一个永远转圈的分析。

### W-23 `commitQuizAnswer` 的守卫矩阵
- **落点**：`repository.ts` → `commitQuizAnswer`（新增 `task` 存在性 + `task.status === "in-progress"` + `expected.turn/task` 全实体比较 + `assertCurrentDecisionBlockRef`）。
- **构造**：五组：①正常提交（`in-progress` + `displayed`，无 `expected`）；②同一答案重复提交（已 `answered`）；③提交前把 task 改成 `completed`；④提交前把 `expected.turn` 的 `updatedAt` 改掉（同时间戳、换内容）；⑤提交前只修改被考记录的**无关字段**（例如标题）。
- **断言**：①成功且计分一次；②走幂等分支返回 `current`，**不重复计分、不重复写 outcome**；③④抛 `inactive-task` / `stale-quiz-answer`，**且已输入的答案不得静默丢弃**（必须有可继续的路径）；⑤必须**成功**（无关字段变化不得让答案失效）——否则用户会在答题中途"因为改了个标题"而丢答案。
- **它锁住什么**：这条链路上"拒写"的代价是**用户刚刚手打的答案**，比其它任何一条都贵。

### W-24 任务状态转换的时间戳保留与验证重排
- **落点**：`repository.ts` → `transitionAdaptiveReviewTask`：`endedAt: terminal && current.status !== status ? updatedAt : current.endedAt`、`deletedAt` 同构，以及 verification 重排分支新增的 `&& !isVerificationRecheckDue(verification, updatedAt)`；还有 `queueVerificationTask` 的 `if (!current.taskId) return current;` / `isOpenTaskStatus` 提前返回。
- **构造**：①同状态重复转换（带/不带 reason）；②`in-progress → completed`；③verification 已到期（`nextVerificationDueAt <= today`）与未到期两种，重新开始任务。
- **断言**：①`endedAt`/`deletedAt` **不得**被刷新；②进入终态时才写 `endedAt`；③**已到期**的验证**不得**被拉回 `queued`（这是新增条件的意图），**未到期**的仍按原逻辑处理；④悬空 `taskId`（任务被硬删除）时函数必须**可恢复**，不得抛错把这条验证永久卡住。
- **它锁住什么**：证据时间戳是"延迟验证"这一整套机制的可信度来源；被刷新的时间戳会伪造出"刚做过"的假象。日期类 fixture 必须相对 `todayISO()` 生成。

---

## 四、应用层与语音

### W-25 `useAppData` 解读门禁的正反两面
- **落点**：`src/hooks/useAppData.ts` → `localInterpretationFeedbackIdsRef`（登记点：`rateRecordReview` 返回值；清理点：`runFeedbackInterpretations` 结果与快照状态；使用点：自动整理 effect 的 `filter`）。
- **构造**：①本实例给记录打分（产生 feedback）→ 观察是否自动整理；②重新挂载 hook（模拟重启）后存在 `pending/running` 的反馈 → 观察是否自动跑；③调用 `retryFeedbackInterpretation`。
- **断言**：①自动整理**必须**跑；②**不得**自动跑（避免重复计费），但 UI 必须出现"继续整理/重试整理/开始整理"入口；③手动入口**必须**能跑通；④登记必须发生在 `refresh()` **之前**（否则第一次自动判定会落空）。
- **它锁住什么**："不自动重跑"（省钱）与"用户还能跑"（功能还在）必须成对成立。只有前一半是最常见的交付缺陷。

### W-26 冷启动与只读浏览零 epoch
- **落点**：`useAppData` 启动 effect（已移除 `selectNextTask`）、`storage.initialize()`、只读页面挂载、`runtimeController.pause()`。
- **构造**：准备一个含 `eligible` 队列项与 `in-progress` 任务的库，记录 epoch；跑 `initialize()` → 挂载只读页面 → 语音 runtime 创建并暂停 → 再读 epoch。
- **断言**：全程 epoch **不变**，表中 `updatedAt` 不变；对应地，随后一次同步必须 `uploaded: 0`。
- **它锁住什么**：隐式写是双端"互相打断"的根源。特别地，`selectNextTask` 的移除与"解读只对本实例产生"都必须能在这一条里被看见（任何残留的隐式写都会立刻反映为 epoch +1）。

### W-27 `RecordEditorPage` 的基线契约
- **落点**：`src/pages/RecordEditorPage.tsx` → `formalRecordRef` / `remoteRecordChangedRef`：加载分支（`formalRecordRef.current = {...structuredClone(loadingRecord), updatedAt: storedDraft.baseUpdatedAt}`）、被动更新 effect、提交前的守卫与 `flushDraftDetached(draftRef.current, { force: true })`。
- **构造**：①草稿 `baseUpdatedAt === 正式行 updatedAt` → 保存；②草稿 `baseUpdatedAt < 正式行 updatedAt`（另一端更新过）→ 保存；③只读浏览导致 `record` prop 变化（无本机编辑）。
- **断言**：①**必须保存成功**；②**必须拒绝**并给出可操作提示，且**草稿必须真的落盘**（`db.recordDrafts` 里有行、`baseUpdatedAt` 保持旧值），随后按提示处理能继续；③**不得**生成草稿、**不得**改写正式内容。
- **它锁住什么**：`formalRecordRef` 同时承担"基线"和"页面缓存"两种角色，这是最容易写错的地方。②里"拒绝 + 保住草稿"两者缺一，用户就会丢内容。

### W-28 语音会话不得自杀、也不得复活
- **落点**：`voiceRecall/repository.ts` → `putSession(session, { allowCreate: false })`（行不存在时返回 `undefined` 且**不写**）；`runtimeController.ts` → `persistNow` 的三次重试与"未 persistence → 取消活动任务 + 清空内存状态"分支。
- **构造**：①新建会话后**立即** checkpoint（不等创建落盘）；②完整恢复（`restoreSnapshot`）掉会话后再 pause/checkpoint；③清理后重新 `createSession`；④会话被清理后调用 `end()` 与 `dispatch()`。
- **断言**：①正常会话**不得**被取消/清空（不得因"行还没落盘"自杀）；②清理后的旧运行时不重建会话、不 bump epoch、导出内容里不含该会话 id；③新会话**必须**能建；④清理后的 `end()` / `dispatch()` **不得**抛异常。
- **它锁住什么**：①与②是一对反向约束——只做②（一律禁止创建）会把语音功能整体改坏；只做①则无法阻止复活。④是"清空内存状态"这一改动的直接副作用面。

---

## 建议的执行顺序

1. **W-20 / W-21 / W-22 / W-23**（助教链路）——拒写类改动最先可能误杀正常流程，且失败时 UI 只给通用错误，最难反推。
2. **W-15 / W-16 / W-17 / W-18**（本地写入门禁）——其中 W-15/W-16 有代码级证据指向"会复活/会写坏"，需要先跑出结论；W-17 优先级最高（误杀 = 应用直接不可用）。
3. **W-01 ~ W-12**（同步核心）——直接扩展 `cloudSyncService.integration.test.ts`，夹具现成。
4. **W-24 ~ W-28**（状态机与应用层）——注意日期 fixture 相对今天生成。

## 需要一并记录的两条"注释债务"

- `storageAdapter.ts` 关于"下一次同步会重新上传"的自愈说明在双设备下不成立（见 W-12）。
- `reclaimEmptyPlanRecords` 的注释承诺"软删除计划不写回"，但实现用的是事务外的陈旧副本（见 W-16）。

两处都属于"注释比实现更乐观"，会在后续改动里误导判断：**跑完对应用例后，应让注释与实现二者取其一改齐**。
