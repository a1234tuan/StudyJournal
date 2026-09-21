# 云同步收敛修复：白盒测试执行报告（2026-09-21）

> 后续独立复核发现本报告存在统计、可达性与测试断言问题。下文保留原执行时的结论，不作为当前源码状态；以 [复核修复与验收](cloud-sync-whitebox-remediation-2026-09-21.md) 的勘误、修复范围及实际结果为准。

## 一、结论摘要

按 `docs/audit/cloud-sync-whitebox-regression-tests-2026-09-21.md` 的 28 组白盒用例（W-01 ~ W-28）全部实现并实际执行，**47 项用例 / 42 项通过 / 5 项不通过**。5 项不通过**全部是实现侧问题**，不是夹具问题——每一项都先排除过"夹具没写好"的可能（见 §二）。

同时执行了本次改动自带的 6 个回归文件：**162/162 通过**；页面与钩子的两个既有文件：**42/42 通过**；`npx tsc -b` 类型检查通过。合计本轮实际执行 **209 项测试 / 204 通过 / 5 不通过**。

| 编号 | 用例 | 结果 | 文件 |
|---|---|---|---|
| 全程 | 白盒 4 个新文件（47 项） | 42 通过 / 5 不通过 | 见 §三 |
| 对照 | 改动自带回归 6 文件（162 项） | 162 通过 | 见 §三 |
| 对照 | `RecordEditorPage.test.tsx` + `useAppData.cloudSync.test.tsx`（42 项） | 42 通过 | W-27 的页面侧 |
| 类型 | `npx tsc -b` | 通过 | 新测试文件已过类型检查 |

**本次只新增测试文件与文档，没有修改任何产品源码。**

### 五个不通过项（即发现）

| 编号 | 现象 | 严重度 | 判定依据 |
|---|---|---|---|
| **F-1**（W-15） | `saveDailyPlan` 没有 `deletedAt` 守卫：拿"删除前缓存的计划对象"再保存一次，会把软删除的计划**复活**，并产生一次真实云端上传 | 中 | 用例红；`storageAdapter.ts:1788-1797` |
| **F-2**（W-16） | `reclaimEmptyPlanRecords` 用**事务外**读到的计划副本写回：外层读之后、事务开始之前被软删除的计划会被写回而**复活** | 中 | 用例红（带"注入确已发生"守卫断言）；`storageAdapter.ts:1856`、`:1897-1902` |
| **F-3**（W-17b） | 同一种"正式内容已过期"条件，两条分支抛出**不同类型与文案**：决策块分支抛 `ReviewCoachValidationError`（英文，且会被 `formatActionableError` 换成通用文案 + 无语义诊断编号），普通分支抛中文 `Error` | 中 | 用例红（断言 `name` 与 `message` 相等） |
| **F-4**（W-25） | `detachVerificationTask` 在 `taskId` 悬空时抛 `dangling-task` 而不是清理；而同一悬空状态又会被 `validateReviewCoachFormalSnapshot`（`validation.ts:383-385`）判为非法 ⇒ **这个状态没有任何入口能修好** | 中低 | 用例红 + 校验器源码 |
| **F-5**（W-01） | `values()` 的软删除谓词接受 `deletedAt: ""`，拉取后该行被当作**正常记录**出现在记录列表里（一条没有标题的空记录） | 低 | 用例红；`cloudSyncModel.ts:374-377` |

---

## 二、执行方式

**被测代码状态**：提交 `390d45b`（`fix(sync): preserve convergence and reject stale asynchronous writes`）。本轮**没有改动任何产品源码**，只新增了 4 个测试文件与本报告；工作区里除这些新增文件外没有别的东西。

**命令**

```bash
npx vitest run --mode test \
  src/services/cloudSyncWhitebox.test.ts \
  src/services/storageAdapterWhitebox.test.ts \
  src/features/reviewCoach/reviewCoachWhitebox.test.ts \
  src/hooks/useAppDataWhitebox.test.tsx

# 对照：改动自带的回归文件
npx vitest run --mode test src/services/cloudSyncService.integration.test.ts \
  src/services/cloudSyncModel.test.ts src/services/cloudSyncProtocol.test.ts \
  src/services/storageAdapter.dailyPlan.test.ts \
  src/features/reviewCoach/repository.test.ts \
  src/features/reviewCoach/completeV2Verification.test.ts
```

**新增的 4 个测试文件**

| 文件 | 项数 | 覆盖 |
|---|---|---|
| `src/services/cloudSyncWhitebox.test.ts` | 18 | W-01/02/04/05/06/07/08/09/10/11/12/28 |
| `src/services/storageAdapterWhitebox.test.ts` | 13 | W-13/14/15/16/17/18/19 |
| `src/features/reviewCoach/reviewCoachWhitebox.test.ts` | 13 | W-03/14b/20/21/22/23/24/25 |
| `src/hooks/useAppDataWhitebox.test.tsx` | 3 | W-26/27 |

**夹具与隔离**：同步侧沿用改动自带的形态——两个独立命名的 `fake-indexeddb` 库（phone / desktop）、各自独立的 `cloudSyncState` 与 ledger、可控 Firestore 桩（含 `failPublishHead` / `failMetadataBatch` / `queryLog` 与 reads/queries/writes/entityWrites 计数），查询与事务写全部在内存里。助教侧用真实 `DexieReviewCoachRepository` + `reviewCoachTestFixtures`（不是 `vi.fn()` 假仓储）。**没有接触真实学习数据、没有网络请求、没有调用付费 AI/ASR。**

**一条方法论记录（值得复用）**：W-16 第一次运行是"绿"的，但绿的原因是夹具漏了——我的故障注入钩子挂在了 `db.transaction` 上，它在**后续每一个**事务里都会重复执行，于是被写坏的记录在下一次事务里又被"顺手修好"，把问题掩盖了。加上 `expect(injected).toBe(true)` 与 `expect(reclaimed).toContain('shell')` 两条"注入确已发生"的守卫断言、并把注入改成只执行一次之后，用例立刻变红。**结论：故障注入型用例必须自带"注入确实发生了"的断言，否则绿是假的。**

---

## 三、逐组结果

| 组 | 覆盖的落点 | 用例数 | 结果 |
|---|---|---|---|
| W-01 | `cloudSyncModel.values()` 软删除保留范围 | 1 | **不通过**（F-5） |
| W-02 | 远端脏 payload 健壮性 | 1 | 通过（可达性仍为 [?]） |
| W-03 | 保留软删除行 + 解读重写 | 1 | 通过 |
| W-04 | 定点核对不越过未读修订 | 1 | 通过 |
| W-05 | ledger `cloudRevision` 不回退 | 1 | 通过（**原假设已证伪，见 §五**） |
| W-06 | 空增量推进游标三组前置条件 | 3 | 通过 |
| W-07 | 隐藏修订守护：短路 / 实体 / 事件 / 空区间 | 4 | 通过 |
| W-08 | 守护抛错后的清理与分类 | 1 | 通过 |
| W-09 | 部分提交核对边界 | 1 | 通过 |
| W-10 | publish 失败分类（批中断 / head 失败） | 2 | 通过（第三种子情形不可达，见 §五） |
| W-11 | 元数据已提交时的锁释放语义 | 1 | 通过（附带观察，见 §五） |
| W-12 | "自愈"注释的证伪 | 1 | 通过（不重复上传；但注释仍错） |
| W-13 | mutation 与业务写同事务 + 回滚 | 3 | 通过 |
| W-14 | no-op 不刷 epoch（计划保存/删除/关联/回收） | 3 | 通过 |
| W-14b | no-op 不刷 epoch（队列备注/重复排期） | 1 | 通过 |
| W-15 | 旧计划副本不得复活软删除计划 | 1 | **不通过**（F-1） |
| W-16 | 回收写回不得复活软删除计划 | 1 | **不通过**（F-2） |
| W-17 | `expectedRecord`：无并发必须放行 / 两分支同一提示 | 2 | 1 通过 + **1 不通过**（F-3） |
| W-18 | 仅 `updatedAt` 变化的判定口径 | 1 | 通过（口径被钉为"拒绝"） |
| W-19 | 判空口径矩阵 + 仅含资源的记录不可回收 | 2 | 通过 |
| W-20 | 单次无并发分析必须落地蓝图与任务 | 2 | 通过 |
| W-21 | `failed` 解读重试不得被拒 | 1 | 通过 |
| W-22 | stale 拒写之后可恢复、不写别的 | 1 | 通过 |
| W-23 | 答题提交：正常 / 幂等 / 无关字段 / 任务已终态 / 快照被替换 | 3 | 通过 |
| W-24 | 时间戳保留 + 到期重检不被回退 + 未到期仍回排 | 3 | 通过 |
| W-25 | 悬空 taskId 的自愈 | 1 | **不通过**（F-4） |
| W-26 | 重启后不自动续跑、手动入口可用 | 1 | 通过 |
| W-27 | 只读会话零写入 / 启动不自动接管任务 | 1 + 1 | 通过（页面侧另由 `RecordEditorPage.test.tsx` 36 项覆盖，已跑通） |
| W-28 | 语音会话在完整恢复后的生命周期 | 1 | 通过 |

---

## 四、五个发现的详情

### F-1（W-15）拿旧对象保存 → 复活软删除计划

- **复现**：读一份存活的计划行 → `deleteDailyPlan` 使其软删除 → 用先前读到的（不含 `deletedAt` 的）对象调 `saveDailyPlan` → 该行的 `deletedAt` 变为 `undefined`，计划重新出现在 `listDailyPlans()`。
- **代码**：`storageAdapter.ts:1788-1797`。no-op 判定 `deepEqualIgnoring(current, plan, ["updatedAt"])` 只忽略 `updatedAt`，`deletedAt` 的不一致会让判定"有变化"，随后 `db.dailyPlans.put(touch(plan))` 写入一个完全没有 `deletedAt` 的行。**同批改动的 `deleteDailyPlan`（`:1809`）与 `linkPlanRecord`（`:1826`）都加了 `plan.deletedAt` 守卫，只有它没有。**
- **可达性**：页面持有计划对象、另一端（或本端别处）在此期间删除该计划，用户再点保存 —— 与黑盒 BB-05/BB-07 是同一场景的用户视角。
- **影响**：回收站内容被静默恢复 + 一次真实上传（多端可见）。

### F-2（W-16）回收写回用陈旧副本 → 复活软删除计划

- **复现**：计划 `p` 关联空壳记录 `shell` → 在 `reclaimEmptyPlanRecords` 的外层读（`plans`）之后、`db.transaction` 之前把 `p` 软删除 → 回收照常执行（`shell` 被回收）→ 写回循环用**陈旧副本**判断 `plan.deletedAt === undefined` → 写回一个没有 `deletedAt` 的行。
- **代码**：`storageAdapter.ts:1856`（外层读）与 `:1897-1902`（事务内写回仍用外层的 `plans`）。函数注释明确承诺"soft-deleted plans … Their rows are simply not written back"（`:1895-1896`），**注释与实现不一致**。
- **影响**：与 F-1 相同（复活 + 多余上传），窗口更小但方向相反——F-1 是显式保存，这是后台回收。

### F-3（W-17b）同一种"内容已过期"两种体验

- **复现**：把 DB 行改掉，然后分别走 `saveRecordWithDecisionBlocks`（有决策块）与普通分支，用同一份过期基线保存。
- **事实**：前者抛 `ReviewCoachValidationError`（`name === "ReviewCoachValidationError"`，消息为英文 "Record changed while editing; …"）；后者抛普通 `Error`（`name === "Error"`，消息为中文 "正式内容已更新，请核对本机草稿后再保存。"）。
- **为什么前者更糟**：`ReviewCoachValidationError` **不是** `ActionableError`，会被 `formatActionableError` 换成通用文案 + 本地生成的诊断编号（编号里没有可查语义）—— 也就是用户看到的是"通用错误"，而这条恰恰是最需要**可操作指引**（请核对草稿）的提示。
- **建议**：两条分支复用同一个 `ActionableError`，同 code、同中文文案，并保证草稿一定落盘。

### F-4（W-25）一条谁都修不好的悬空验证链

- **复现**：把一条 `DelayedVerification.taskId` 指向一个不存在的任务，然后调 `detachVerificationTask` → 抛 `ReviewCoachValidationError("dangling-task", "Queued verification task is missing.")`（`repository.ts:1558-1561`，本次改动新增的三行）。
- **为什么这是死锁**：`validateReviewCoachFormalSnapshot`（`validation.ts:383-385`）要求"带 `taskId` 的验证必须指向一个 `priorityTier === "due-verification"` 且各字段匹配的任务"，所以**悬空链接本身就是非法状态**；而唯一能把它清掉的入口偏偏在该状态下抛错 ⇒ 一旦产生（例如恢复备份、或记录被清理后遗留、或任务被硬删除），用户既不能用它、也无法解除它。
- **建议**：这里应当自愈（`if (!task) { 清空 taskId 并写回 }`），而不是抛错；抛错只适合"任务存在但状态不匹配"的情形。

### F-5（W-01）空串 `deletedAt` 会被当作正常记录

- **复现**：远端存在 `{ deleted: true, payload: { id, deletedAt: "" } }` 的实体 → 拉取后该行落库，`listBlocks()`（过滤条件是 `!block.deletedAt`）把它算作**正常记录**。
- **代码**：`cloudSyncModel.ts:374-377` 的谓词只做 `typeof payload.deletedAt === "string"`。
- **可达性**：`deletedAt` 在正常路径下由 `nowISO()` 产生，不会是空串；所以这需要**外部脏数据/旧客户端/手工构造的远端文档**才能触发（[?] 级可达性）。
- **建议**：谓词收紧为"非空字符串"，并把该判断抽成具名函数（例如 `isSoftDeletePayload`），避免以后再被当成"顺手放宽一点没关系"的地方。

---

## 五、被证伪或修正的原假设（很重要）

跑测过程中有三条原有判断被推翻或修正，**这些比新增的通过项更值得记住**：

1. **W-05 的假设被证伪。** 原假设："`persistLedgers` 会把 `cloudRevision` 写成传入的 `revision`，于是过期的 `unknown` 操作核对后能把账本修订号拉回去。"实际代码是 `cloudRevision: entity.revision`（`cloudSyncService.ts:1624`），即**取自远端文档自身的修订号**，与调用方传的 `revision` 无关 ⇒ 该路径不可能回退。用例转绿，这是"读代码得出的怀疑必须先被用例检验"的一个正例。
2. **W-10 的第三种子情形不可达。** 原假设："超时但元数据尚未开始写"是一条独立分支。实际上 `publish` 里唯一可能超时的位置就是元数据批量写（此时 `metadataStarted` 已为 `true`）；若超时发生在 `acquireLock`，`lock` 为 `undefined`，走不到那条分支。⇒ **`timedOut && !metadataStarted` 目前是死分支**，相关注释与守卫可以精简，但不要据此以为"超时总能被区分"。
3. **`persistLedgers` 的第 4 个参数 `revision` 已成为未使用参数**（语义被 `completeThroughRevision` / `pulledThroughRevision` 取代，函数体内不再引用）。留着会让后来者误以为"传进去就会推进游标"。建议删除或改名。
4. **W-12 的"自愈"注释确认是错的**（用例转绿 = A 不会重复上传自己已同步的内容），但 `storageAdapter.ts` 里那句"下一次同步会重新算出差异并重新上传"的注释仍在，**不要照它做修复决策**。
5. **补充观察（不是缺陷）**：head 提交失败后，原设备下一次同步会**再下载一次自己刚写的内容**（`downloaded: 1`，内容一致、随后收敛）。这会让用户看到一次"已同步 1 项"的误报，但不会覆盖或丢数据。

---

## 六、现在被钉住的断言（防回归价值）

这些断言此前要么没有、要么依赖手工验证，现在有了可复跑的钉子：

- **W-04**：`unknown` 操作定点核对成功之后，本机仍必须收到"它背后那条更低的未读修订"，且随后两轮同步零变化（P0-02/P0-03 的回归钉子）。
- **W-07**：`lock.revision === head + 1` 时**不得**发出任何"修订缺口"查询（用 queryLog 断言，不是靠感觉）；区间内有实体或事件时必须拒绝发布。
- **W-08**：守护抛错后远端锁必须已释放、本地操作必须终态、消息不得命中 `/超时|timeout/i`（否则一次确定性拒绝会被降级成"结果未知"）。
- **W-09**：部分提交只把"与预期 hash + 修订相符"的子集记入账本（逐键断言 `cloudRevision`），未提交的那条必须在上传后记为**它自己的发布修订**（4），绝不能记为 stalled 操作的修订（2）。
- **W-11**：head 提交失败后，另一台设备必须能立刻取到那份已提交的元数据。
- **W-13/W-14**：业务写失败时 epoch 与行一起回滚；重复保存/删除/关联/回收/备注/排期都不增加 epoch。
- **W-20/W-21/W-22**：真实 Dexie 仓储下，"无并发的一次分析必须落地蓝图与任务"、`failed` 解读的重试必须成功、stale 拒写之后批次不得卡在 `running` 且不得写蓝图/任务/outcome。
- **W-23**：已作答的同操作重试保持幂等（outcome 只有一行、epoch 不变）；任务离开 `in-progress` 时拒写且**不得半写**；被考记录的无关字段变化不得让答案失效。
- **W-24**：重复转换不得刷新 `endedAt`/`deletedAt`；已到期的重检在任务重新开始后**不得**被拉回队列，未到期的仍照旧回排。
- **W-28**：完整恢复后旧运行时不得重建会话、不得刷 epoch、导出里不含该会话；同时**新会话必须仍可创建**、清理后 `end()`/`dispatch()` 不得抛。

---

## 七、局限（不要过度推断）

- 双端集成是**同一进程内顺序切换两个数据库**，不证明两个独立进程的真实并发时序。
- **未跑全量套件**：本轮只跑了白盒 4 文件（47 项）+ 改动自带回归 6 文件（162 项）+ 页面/钩子 2 文件（42 项）。全量基线仍以修复文档记载的 211 文件 / 1602 项为准。
- **W-02 的可达性仍是 [?]**：远端文档 `payload: null` / 缺字段需要真实旧客户端样本或人为构造才能确认会发生；本用例证明的是"一旦发生就会失败"，不是"一定会发生"。
- **W-27 的页面侧**由本次改动自带的 `RecordEditorPage.test.tsx`（36 项，含 4 项新增：无编辑被动刷新、草稿保留原基线、正式保存等待草稿写入时收到远端更改、首次草稿读取晚于正式刷新）承担，已跑通；钩子侧由新增的 3 项承担。
- 未做真机、Firebase Emulator、真实账号、弱网/进程强杀验证；F-1/F-2 的用户可见影响仍应以真机双端（黑盒 BB-05/BB-07）复核一次。

---

## 八、建议的下一步

1. **F-1 + F-2 合并修一次**：所有计划写入路径（`saveDailyPlan` / `deleteDailyPlan` / `linkPlanRecord` / 回收写回）统一成同一套语义——**事务内重读当前行 + 保留 `deletedAt`**，并补上对应的三条用例（本轮已经有现成的）。
2. **F-3**：两条分支复用同一个 `ActionableError`（同 code、同中文可操作文案），并断言"拒写时草稿必已落盘"。
3. **F-4**：`detachVerificationTask` 遇悬空任务改为自愈（清空 `taskId` 并写回），否则它与快照校验器构成死锁。
4. **F-5**：软删除谓词收紧为"非空字符串"并抽成具名函数。
5. **清理**：删除/改名 `persistLedgers` 的死参数；修正 `storageAdapter.ts` 的两处注释（自愈、"软删除计划不写回"），避免下一次改动被误导。
