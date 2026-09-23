# 云同步/备份/恢复加固 —— 独立发布前审查报告（2026-09-23）

审查对象：另一位 coding agent 对 `docs/cloud-sync-backup-restore-hardening-plan-2026-09-23.md` 阶段 0–6 的实施。
审查方式：只读。未修改任何生产代码、测试、既有文档、生产数据或配置；未提交、未推送、未部署规则、未安装/覆盖 APK/EXE、未登录真实账号、未调用付费服务。
审查基线：`HEAD = 4cd3e00`（`main`，与 `origin/main` 一致），实施者为**未提交的工作区改动**：24 个已修改文件 + 9 个未跟踪文件（含 2 份新文档、2 个新源文件、2 个新测试文件、`output/` 两份产物目录）。

---

## 1. 结论

**不通过。**

> 未发现 P0；未发现已证实的数据丢失缺陷；本任务的自动化门禁在同一基线上基本可复现（定向测试全绿、类型检查通过、生产构建通过）。
> 但存在 **1 项未关闭 P1**（唯一一处"真正执行全量覆盖"的入口仍复用容错解析并宣称数据集完整），以及 **证据不足项**（设备/真机/用户验收全部未跑；加密归档之外的旧格式兼容无真实旧包 fixture）。
> 因此按验收判据不能给"通过/可发布"，也不能给"有条件通过"（该项要求不得有未关闭 P1）。

单列状态：

| 项 | 状态 |
|---|---|
| 用户最终验收 | **未进行** |
| 生产部署 | **未进行**（`firestore.rules` / `storage.rules` 零改动、未部署） |
| 真机 / 双设备 | **未进行**（无授权，未登录真实账号） |
| Desktop / Android / Web host 门禁 | **未进行**（实施者已如实申报；本审查仅跑通一个无关的 e2e 冒烟） |

---

## 2. 证据追踪矩阵

状态取值：通过 / 失败 / 未验证 / 不适用（需理由）。

### 阶段 0：基线盘点与失败测试

| 方案断言 | 实现位置（文件/符号） | 测试名及关键断言 | 本次命令/证据 | 状态 | 备注 |
|---|---|---|---|---|---|
| 先记录实施前定向测试通过/失败 | 无产物 | —— | 无 Stage-0 基线记录文档 | 未验证 | 报告与 `AGENTS.md` 均未留"改前基线"证据；未证明新用例在旧实现上会失败（见 §3 P3-1） |
| 确认测试能在旧实现上稳定暴露缺口 | 无产物 | —— | 仅能由代码静态推导（如 `parseRemoteEntity` 对缺失 `contentHash` 返回 `undefined`，旧 `restoreCloudRecoverySnapshot` 会据此继续恢复） | 未验证 | 未做隔离工作树 mutation check（见 §3 说明） |

### 阶段 1：云恢复快照完整性与严格全量校验

| 方案断言 | 实现位置（文件/符号） | 测试名及关键断言 | 本次命令/证据 | 状态 | 备注 |
|---|---|---|---|---|---|
| 先写子文档、最后写父文档作为可见提交标记 | `cloudSyncService.ts:1946-1955`（`makeRemoteSnapshot`：`writeInBatches(children…)` → `await beforeBatch?.()` → `setDoc(parent)`) | SNAP-01（首批失败无父文档）、SNAP-01b（第二批失败→有孤儿子文档、无父文档、旧恢复点仍可恢复） | `npx vitest run … cloudSyncWhitebox.test.ts`（本次，147 用例全绿） | 通过 | 旧客户端只列父文档，故`writing`半成品不可见 ✓ |
| 父写结果未知时读回核实 | `cloudSyncService.ts:1963-1974`（catch → `getDoc` → 比对 `complete`/`entityCount`） | SNAP-05（提交标记失败→列表为空、子项存在；重试产出 `complete`） | 同上 | 通过 | 仅读回父文档、未重读全部子项；因父写发生在所有子批次成功之后，该推理成立（与方案 §5.1.1 字面略有差异，非缺陷） |
| 父文档预期计数 = 实际子项数 | `cloudSnapshotIntegrity.ts:305-333`（`assertStrictCloudSnapshot`） | `cloudSnapshotIntegrity.test.ts`「rejects a count mismatch…」；SNAP-02（`legacy-short` 拒绝） | 同上 | 通过 | |
| 畸形实体/事件、重复 ID、坏 revision、身份不一致整体拒绝 | `cloudSnapshotIntegrity.ts:154-246`（`parseStrictEntity`/`parseStrictReviewEvent`）+ `cloudSyncService.ts:539-568`（`parseRemoteEntitiesStrict`） | SNAP-03、SNAP-04、`cloudSnapshotIntegrity.test.ts` 全部严格用例 | 同上 | 通过 | SNAP-03 的文档 `{entityType,entityId,revision,payload}` 缺 `contentHash` → 容错解析丢弃、严格解析抛错，差分可静态确证 |
| 恢复入口写入前走 strict validator | `cloudSyncService.ts:3100-3151`（`restoreCloudRecoverySnapshot`：先读父+子→校验→`hydrate`→下载资源→最后替换） | SNAP-02/03、P2-01~P2-04 | 同上 | 通过 | 失败发生在任何本地写入之前，并以 ledger/cursor 前后相等断言 |
| 冲突"以云端为准"走 strict | `cloudSyncService.ts:2920-2926`（`buildIncrementalRemoteDataset(...,true)` / `buildFullRemoteDataset(...,true)` + `assertStrictRemoteDataset`） | SNAP-04、P2-05 | 同上 | 通过 | 正向对照（健康云集合可恢复）也在 SNAP-04 内 |
| **其它执行全量覆盖的分支也走 strict** | `cloudSyncService.ts:1377-1406`（`applyRemote`）+ `:2726-2728`（`firstEmptyDevice` 分支）——**仍用 `getAllRemote(uid, state)` 容错解析** | **无对应用例** | 静态核对：`getAllRemote` 默认 `strict=false`；分支内无 `assertStrictRemoteDataset`；随后 `persistLedgersInTransaction(..., headRevision)` | **失败** | 见 §3 P1-01 |
| 旧快照保守兼容、不自动删除 | `cloudSnapshotIntegrity.ts:132-152`（`classify…`/`isCloudRecoverySnapshotRestorable`） | SNAP-02（`writing`/`unverifiable` 拒绝、计数一致的 legacy 可恢复） | 同上 | 通过 | `cleanupCloudRecoverySnapshotsIfDue` 仅按数量保留窗口清理，不因"不可验证"删除 |
| UI 呈现状态、不可恢复项不得提供恢复操作 | `CloudSyncPanel.tsx:243-290`、`:407-430` | `CloudSyncPanel.test.tsx`「offers a restore action only for usable recovery points…」等 3 用例 | 同上 | 通过 | 不可恢复项 `disabled` + `aria-disabled` + 原因文案；"恢复最新快照"取的是 `restorableSnapshots[0]` |

### 阶段 2：云端资源字节校验与恢复提交一致性

| 方案断言 | 实现位置 | 测试名及关键断言 | 本次命令/证据 | 状态 | 备注 |
|---|---|---|---|---|---|
| 下载后重算 `hashBlob` 比对；不认识的哈希硬失败 | `assetIntegrity.ts:68-90`、`cloudSnapshotIntegrity.ts:353-372`、`cloudSyncService.ts:1290-1320` | `cloudSnapshotIntegrity.test.ts`「downloaded asset byte verification」6 用例（wrong/truncated/size/mime/unsupported-hash/legacy `fnv1a`） | 本次定向测试 | 通过 | 刻意忽略实体级 `contentHashAlgorithm`，旧资源 `fnv1a` 不被误拒（P2-01 覆盖） |
| 校验失败时本机表、ledger、cursor 均不变 | `cloudSyncService.ts:1310-1320`（`CloudSnapshotIntegrityError` 直接抛出，包裹层不吞） | P2-02（4 类失败后 `localBookkeeping` 与 `blockIds` 前后相等）、P2-03（增量拉取不落更新） | 同上 | 通过 | |
| 本地替换与 ledger/cursor 同一原子边界 | `storageAdapter.ts:2571-2650`（`commitCloudState` 在事务末尾、事务表清单新增 `db.cloudSyncState`/`db.cloudSyncLedger`） | P2-04（ledger 失败→数据也回滚）、P2-05（cloud-wins 同理） | 同上 | 通过 | 事务提交后仍有 `migrateRecordReviewsToMixedSystem`/`rebuildProjections`（可重入，既有行为） |
| 增量 pull 保持容错、不与破坏性恢复混用 | `cloudSyncService.ts:744-840`、`1016-1095` | 既有 W-* 用例 + 上述 P2 用例 | 同上 | 通过（除 §3 P1-01 的分支） | |

### 阶段 3：完整 ZIP 的生成、读取与替换保护

| 方案断言 | 实现位置 | 测试名及关键断言 | 本次命令/证据 | 状态 | 备注 |
|---|---|---|---|---|---|
| 生成端资源缺失 fail-fast（不再 `continue`） | `backup.ts:46-58`、`streamingBackupService.ts:78-110`、`nativeAutoBackupStreamService.ts:64-95`、`nativeRepositoryBackupService.ts:405-460` | ZIP-05、S3-01、AB-01、R3-01、R5-04 | 本次定向测试 | 通过 | 四处 writer 全部改为抛错并取消会话 |
| 导入端缺文件/不可读/hash 不符在事务前拒绝 | `backup.ts:304-337`、`streamingBackupService.ts:262-275`、`nativeRepositoryBackupService.ts:604-627` | ZIP-02/03、S3-02、R3-03/R3-04 | 同上 | 通过 | |
| 每资产字节进入被校验的 v7 容器范围 | `backup.ts:assetChecksumsFor` + `payload.assetChecksums`；`backupContainer.ts:containerForPayload` 对整份 payload 取 checksum | ZIP-01（声明存在）、ZIP-06（payload 与容器不一致必拒）、R3-02 | 同上 | 通过 | 声明与被校验载荷同体，篡改字节而不改声明必被 `assertArchiveAssetBytes` 抓住 |
| 旧备份按历史能力导入并如实报告未核验部分 | `backup.ts:archiveAssetDeclarations`（缺省合法、格式非法失败）、`summarizeSnapshot.unverifiedAssets`、`BackupPage.tsx` 文案 | ZIP-04（v4 无声明包可导入且 `unverifiedAssets>0`）、R3-05 | 同上 | 通过 | **无真实旧包 fixture**，兼容形状由测试重构（与 HEAD 写入器形状一致，已静态核对）；v7-无声明包未覆盖（§3 P3-2） |
| 草稿引用纳入完整性断言（含旧字段来源） | `storageAdapter.ts:195-212`（`assertSnapshotIntegrity(..., drafts)`）、`:2550`、`:2682` | `storageAdapter.restore.test.ts` `it.each(["payload","legacy"])`「rejects an archive whose only asset reference is a draft」 | 同上 | 通过 | 反例正是"归档无任何资源、仅草稿引用" |
| 流式 restore 先完成全部读取/校验/staging 再替换 | `storageAdapter.ts:2691-2750` | 「keeps current data when resource staging fails and removes staged assets」 | 同上 | 通过 | 失败清 staging，正式表不动 |
| 知识库 envelope/detached 恢复语义 | 未改动（`validateKnowledgeEnvelope`、`restorePortableKnowledge` 保留） | 既有知识库用例 | 未跑设备级 | 未验证 | 本次未触碰该语义，但也无本次证据 |

### 阶段 4：自动备份目的地写入、last-known-good 与状态语义

| 方案断言 | 实现位置 | 测试名及关键断言 | 本次命令/证据 | 状态 | 备注 |
|---|---|---|---|---|---|
| 四级状态可区分、`lastBackupVerifiedAt` 不伪造 | `autoBackupService.ts:157-166`、`types.ts:355-376`、`AutoBackupPanel.tsx:57-76` | `autoBackupService.test.ts` 5 用例；`AutoBackupPanel.test.tsx` 3 用例 | 本次定向测试 | 通过 | 未写入显示"尚无成功备份"，无验证证据显示"未验证" |
| Web 写入后回读核对 | `autoBackupAdapter.ts:107-129`（`zip.size>0 && file.size===zip.size`） | `autoBackupAdapter.web.test.ts` W1-W4 | 同上 | 通过 | 结果标记 `destination-readback` |
| 仓库写前写后：快照先写、回读通过才更新 manifest | `nativeRepositoryBackupService.ts:readBackSnapshot` + 写入段（`write → readBackSnapshot → readManifest → manifest`） | R4-01/02/03（回读失败不晋升，旧 latest 仍 latest） | 同上 | 通过 | 回读校验快照 JSON + 容器校验和 + 声明清单；**不逐个校验资源文件字节**（见 §3 P3-3） |
| 内容寻址代际路径修掉"同尺寸跳过改写却沿用旧声明" | `nativeRepositoryBackupService.ts:assetGenerationPath` + 写入段 | R5-01（同长度改动→新路径、旧字节不变）、R5-02（未变化不重写）、R5-03/R5-04（前一份已验证副本/彻底缺失） | 同上 | 通过 | 清理由 `loadKeptAssetPaths` 按各保留快照的 `assetPaths` 保留，代际命名不破坏清理 |
| Android latest 不得截断唯一有效备份 | `nativeAutoBackup.ts:writeNativeLatestBackup` / `NativeAutoBackupPlugin.beginZipLatest` | 无 | `grep` 确认生产代码无调用方；`autoBackupAdapter.writeLatest` 原生端恒定走仓库 | 不适用（需用户决策） | 报告已如实披露为死代码；方案 §4.3 的平台风险在当前接线下不成立 |
| 绑定/启用 UX 不擅改、Desktop 首次 flush | `AutoBackupPanel.tsx` 仅新增展示行；绑定逻辑未改 | `AutoBackupPanel.test.tsx`「desktop binding keeps its first-flush promise accurate」2 用例 | 本次定向测试 | 通过 | |
| 重绑目的地后旧授权不能确认新目的地 | `scope.ts:31-40`（ownerScope / token.destinationId / scope.destinationId / consented 四重守卫） | P5-T3、P5-T4 | 同上 | 通过 | `authorizeKnowledgeBackup` 每次轮换 `destinationId`，测试构造真实 |

### 阶段 5：知识库备份并发与恢复边界

| 方案断言 | 实现位置 | 测试名及关键断言 | 本次命令/证据 | 状态 | 备注 |
|---|---|---|---|---|---|
| capture A → 写期间新增 B → 完成 A 后 B 仍 dirty | `runtime.ts:isKnowledgeBackupPending`（从 `liveQuery` 抽出的同一份判定）+ `autoBackup.ts` + `scope.ts` | P5-T1（`capturedGenerations` 仍为 `{first:1}`、pending 为 true、第二轮后清） | 本次定向测试 | 通过 | 交错由**顺序调用**模拟而非阻塞写入器（无真实 writer 进程）；但断言目标正是 `capturedGenerations` 与当前库集合/`dirtyGeneration` 的契约，且与运行时 `liveQuery` 共用同一函数，避免了测试自实现偏离 |
| 捕获后库变化仍 pending | 同上 | P5-T2 | 同上 | 通过 | |
| 回执失败不误确认、可重试 | `scope.ts:31-40` | P5-T3（`capturedGenerations` 保持 `{}`，重试成功） | 同上 | 通过 | 拒绝原因为目的地被重绑（守卫真实），但断言只写 `rejects.toThrow()` 未校验具体原因 |
| owner 变化拒绝 completion | 同上 | P5-T4（A/B 两侧 `capturedGenerations` 均 `{}`） | 同上 | 通过 | |
| 普通云恢复不得清空知识库表 | `storageAdapter.ts:2571-2590` 事务表清单不含知识库表 | `storageAdapter.restore.test.ts`「does not clear knowledge tables during an ordinary cloud restore」 | 同上 | 通过 | |
| 文案边界（云恢复不含知识库；完整备份为 detached 副本） | `CloudSyncPanel.tsx`（恢复确认语+说明）、`BackupPage.tsx:334-338` | `CloudSyncPanel.test.tsx` 2 用例 | 同上 | 通过 | |
| 完整备份只携当前 owner 全部本机库 | 本次未改动该逻辑 | 无本次新增用例 | 未跑设备级 | 未验证 | 属既有能力，本次无新增证据 |

### 阶段 6 / 完成定义

| 方案断言 | 证据 | 状态 | 备注 |
|---|---|---|---|
| 定向测试通过 | 我亲自跑：12 文件 / 147 用例全绿（exit 0） | 通过 | 报告写"14 文件 / 164 用例"，与改动的 12 个测试文件不符（§3 P3-4） |
| 有界全量测试 | 234 文件 / 1889 用例 = 1886 通过 / 3 失败 / 0 跳过（exit 1）；失败为 `aliyunTtsProvider.test.ts`（未改动、单跑仍失败） | 通过（含预先存在失败） | 报告的"239 文件 / 1894 / 4 失败 / 5 跳过"未复现；第 4 个 sync 超时本次未复现 |
| `tsc -b` | exit 0 | 通过 | |
| 生产 build | `npm run build` 被沙箱安全删除守卫拦截；改用全新目录 `npx vite build --outDir dist-verify-20260923` → exit 0，4963 模块，17.88s | 通过 | 环境限制，非产品问题 |
| Firebase Emulator | `npm run test:firebase` → exit 0，2 文件 / 6 用例 | 通过 | 内容仍是知识库协议用例，**未新增**覆盖快照完成标记/批次失败/strict restore（方案 §6.2 未满足） |
| Desktop/Android/Web host | 未运行 | 未验证 | 需用户授权；本审查仅跑通 1 个无关 e2e 冒烟（desktop+android-narrow 4/4） |
| 真机/双设备/真实账号 | 未运行 | 未验证 | 需用户授权 |
| 用户确认 | 未进行 | 未验证 | |

---

## 3. 发现的问题

### P1-01 「新设备全量拉取」分支仍是容错解析 + 宣称数据集完整

- **级别**：P1（机制已由代码确证；触发条件为云端存在畸形/未知类型实体文档，未在真实账号观测到）
- **证据**：
  - `src/services/cloudSyncService.ts:2661` —— `const firstEmptyDevice = ledger.length === 0 && isBootstrapOnlyCloudData(initialExport);`（"新设备加入已有账号"这一真实场景）
  - `src/services/cloudSyncService.ts:2726-2728` —— `const allRemote = await getAllRemote(user.uid, remote.state);`（`strict` 默认 `false`，即容错解析：`parseRemoteEntity` 对缺 `entityId`/`contentHash`/`revision`/`payload` 的文档返回 `undefined`，第 463-472、517-522 行会静默丢弃）→ `applyRemote(...)` 无任何 `assertStrictRemoteDataset`/`assertStrictCloudSnapshot`
  - `src/services/cloudSyncService.ts:1377-1406` —— `applyRemote` 直接 `materializeCloudSyncSnapshot` + `storage.restoreCloudSyncSnapshot`（无 `expectedEpoch` ⇒ **破坏性全量替换**本地库）
  - `src/services/cloudSyncService.ts:2728` —— 提交 `persistLedgersInTransaction(..., remote.state.headRevision)`，`persistLedgersInTransaction` 同时写入 `lastPulledRevision` 与 `remoteDatasetCompleteThroughRevision`（第 1745-1761 行）
- **触发时序**：账号云端 `syncEntities` 中有一份畸形实体（如缺 `contentHash`，或类型在本客户端清单外）→ 用户在**新设备/空库**上首次同步 → `firstEmptyDevice` 成立 → 容错解析丢掉该实体 → 本地库被剩余集合整体替换，且 `lastPulledRevision = remoteDatasetCompleteThroughRevision = headRevision`
- **影响**：该设备此后**永久**缺少这些实体（`getRemoteChanges` 只取 `revision > lastPulledRevision`），且自身宣称"数据集完整"；后续 `resolveCloudSyncConflict` 会因完整性标志为真而走增量路径，同样不会重读它们 ⇒ 无自愈路径。不会破坏本机原有数据（新库为空），故不是本地数据丢失，但属于"把部分集合当成全量数据写入本机"的静默不完整。
- **为什么现有测试漏掉**：SNAP-03/04 只覆盖 `restoreCloudRecoverySnapshot` 与 cloud-wins 冲突分支；`cloudSyncService.integration.test.ts` 无"畸形云端文档 + 新设备首同步"用例（`grep firstEmptyDevice src/services/*.test.ts` 无结果）。报告 §阶段 1 声称"strict 标志贯穿…破坏性替换路径走严格校验"，`AGENTS.md` 也写"Destructive full replacement now uses strict snapshot validation"，与该分支实际行为不符（表述过宽）。
- **最小修复建议**：在该分支改用严格读取并在本地写入前校验，例如
  `const allRemote = await getAllRemote(user.uid, remote.state, true); assertStrictRemoteDataset({ entities: allRemote.entities, reviewEvents: allRemote.reviewEvents });`
  （均在写入、ledger、cursor 之前）。若产品上**有意**接受未知类型被忽略，则应改为：只声明 `lastPulledRevision`、不设置 `remoteDatasetCompleteThroughRevision`，并同步修正报告与 `AGENTS.md` 的措辞。
- **新增回归断言**：新设备首同步前，向 `syncEntities` 注入一份缺 `contentHash`（或未知 `entityType`）的文档 → 断言 `sync()` 拒绝、`blocks/assets/cloudSyncLedger/cloudSyncState` 前后逐字段不变，或（若采纳"有意接受"）断言 `remoteDatasetCompleteThroughRevision` 未被推进。

### P3-1 阶段 0 未留基线证据，未证明新用例能抓旧缺陷

- **级别**：P3。无 Stage-0 基线记录；也未做隔离工作树 mutation check。
- 说明：本审查**未执行** mutation check（在只读授权下不修改工作树的决定，且沙箱内无可复用的隔离工作树），故"新用例在旧实现上必然失败"仅有静态差分支撑。
- 可静态确证的部分：`parseRemoteEntity`（`cloudSyncService.ts:463-488`）对缺 `contentHash` 的文档返回 `undefined`，旧版 `restoreCloudRecoverySnapshot` 正是复用该解析器后继续 `restoreCloudSyncSnapshotIfUnchanged`（`git show HEAD:src/services/cloudSyncService.ts`），因此 SNAP-03 在旧实现上必然走到恢复而非抛错。
- 建议：补一条 Stage-0 记录（或 CI 里对该分支做一次 mutation 断言）。

### P3-2 缺少"v7 且无 `assetChecksums`"这一最现实旧包的回归

- **级别**：P3（代码路径静态核对为正确，但无测试）。当前导出在带知识库时为 v7（`storageAdapter.ts:2387/2472`：`version: includeKnowledge ? 7 : 6`），因此"本次改动前刚导出的备份"是 **v7 + 容器 + 无逐资源声明**；而 ZIP-04 用的是 v4（`data.json` 入口）包，R3-05 是 version<7 的仓库快照。
- 静态核对结论：`archiveAssetDeclarations(undefined)` 返回空表 → 跳过字节比对但保留"文件必须存在"；`validateBackupContainer` 对该包仍能通过（声明字段缺失时写入器与读取器对同一 payload 取 checksum）；`summarizeSnapshot` 会把全部资源计入 `unverifiedAssets`。逻辑成立。
- 建议：补一个"v7 无声明包"用例，断言可导入、`unverifiedAssets` = 资源总数、且篡改字节不因"无声明"被放过。

### P3-3 `archive-verified` 的含义略强于实际校验范围

- **级别**：P3（非功能缺陷，标签精确性）。`readBackSnapshot`（`nativeRepositoryBackupService.ts:349-390`）回读的是快照 JSON + 容器校验和 + 声明清单是否合法，**不逐个回读资源文件字节**；资源字节的保证来自写入时的 `result.size === meta.size` 与恢复时的 `verifyRepositoryAssets` 重算。故 `archive-verified` = "归档结构与声明已回读校验；资源字节在写入时按大小确认、在恢复时按哈希重算"。
- 建议：把该含义写进 `types.ts:376` 的注释或 UI 帮助文案，避免被读成"每个资源字节都已回读验证"。

### P3-4 报告/`AGENTS.md` 的测试数字不可复现

- **级别**：P3（报告准确性）。报告与 `AGENTS.md` 写"14 changed files 164 tests passed"，但本次改动仅涉及 **12** 个测试文件（10 修改 + 2 新增），我实跑为 **147** 用例全绿；全量写"239 files / 1894 tests / 1885 passed / 4 failed / 5 skipped"，我实跑为 **234 files / 1889 tests / 1886 passed / 3 failed / 0 skipped**（第 4 个 `cloudSyncService.integration.test.ts` 超时未复现；未观察到任何 skipped）。
- 建议：按实际命令与输出更新报告与 `AGENTS.md`，并把 `--exclude "**/*.live.test.ts"` 等参数写清，避免后续无法对账。

### P3-5 遗留"永远为真"的断言（陈旧路径断言）

- **级别**：P3（回归网局部失效）。`src/services/nativeRepositoryBackupService.test.ts:331`（用例 "skips unchanged assets on the second sync and only writes metadata"）仍断言 `expect(writtenPaths).not.toContain("assets/asset-1-asset-1.png")`，而新写入器只会产出 `assets/<id>-<sha256>-<fileName>`，该断言**在任何实现下都成立**（包括"每次都重写资源"）。
- 缓解：同一性质已由新增 R5-02（`writtenPaths.some(p => p.startsWith("assets/")) === false`）真实覆盖。
- 建议：把该行改为 `assetPathIn(firstSnapshotId, "asset-1")` 或直接删除。

### P3-6 `destination-visible` 级别永不产生

- **级别**：P3（死分支）。`types.ts:376` 与 `AutoBackupPanel.tsx:67` 定义了"仅确认文件存在"，但 `grep -rn "destination-visible" src/` 只在类型与文案表命中，无适配器产出。当前三端都至少做到 `destination-readback`。契约本身合理（为未来平台保留），仅提示避免被误读为"三端现状"。

### P3-7 Emulator 未覆盖本轮新增语义

- **级别**：P3（证据结构）。方案 §6.2 要求 Emulator 覆盖"快照完成标记、批次失败、strict restore、旧/新快照兼容、权限不越界、操作结果未知重试"，但 `npm run test:firebase` 只跑 2 个知识库协议用例（规则零改动，故越权验证仍有效）。本轮新语义全部依赖 `cloudSyncWhitebox.test.ts` 的内存 Firestore 替身。
- 建议：至少把"子批次失败不留可列恢复点"与"strict 拒绝畸形集合"两条在 Emulator 上跑一遍，或明确在文档中标注该限制。

---

## 4. 变更与副作用审查

- **改动范围（24 修改 + 9 未跟踪，全部未提交）**：`src/services/{cloudSyncService,storageAdapter,backup,streamingBackupService,nativeAutoBackupStreamService,nativeRepositoryBackupService,autoBackupService,autoBackupAdapter}.ts`、`src/features/knowledgeLibrary/runtime.ts`、`src/components/{CloudSyncPanel,AutoBackupPanel}.tsx`、`src/pages/BackupPage.tsx`、`src/types.ts`、对应测试、`AGENTS.md`；新增 `src/services/cloudSnapshotIntegrity.ts`、`src/services/assetIntegrity.ts`、两个新测试文件、两份文档、`output/` 两份产物目录。
- **超出计划的改动**：无越界实现。仅两处判定需注意：①知识库 `isKnowledgeBackupPending` 属等价抽取（函数体与旧 `liveQuery` 内联实现逐行一致，仅补 `?? 0` 语义不变）；②`AGENTS.md` 新增基线段落（符合仓库"改动落地即更新 AGENTS.md"约定）。
- **schema / 迁移**：**无**。`src/db/` 零改动（`git status` 未列任何 `src/db/` 文件），schema 仍为 26；新增的 `assetChecksums`、`lastBackupVerification` 都是可选字段（前者在备份载荷内、后者在设备本地设置行内），不需要索引或迁移。
- **云协议 / 备份格式**：云同步协议版本、实体集合、revision 语义未改。新增的父文档字段 `complete`/`completedAt` 对旧客户端是未知字段、不影响写入；子写→父写顺序使旧客户端看不到半成品。备份新增 `payload.assetChecksums`（可选、被 v7 容器校验和覆盖）；**v7 容器与 v6 入口的兼容路径未变**（旧 v7 包的容器同样对整份 payload 取 checksum）。
- **Firestore rules / storage rules**：零改动、未部署 ✓。
- **UI / 学习事实 / 隐私**：学习事实与复习投影未改；新增文案只做范围说明与错误呈现（`formatActionableError` + `cloud-sync`，该 context 已在 `UiErrorContext` 闭集内）。新增错误文案含资源文件名/ID 与仓库内相对路径，属用户可见诊断信息，未新增 `console.*`（`git diff -U0 | grep '^+.*console\.'` 为空），未发现密钥或正文进入日志。
- **知识库与普通云同步边界**：保持隔离 ✓ —— 普通云恢复的事务表清单不含任何知识库表（并由新用例断言），完整备份才处理知识库 envelope；`acknowledgeKnowledgeBackup` 的 owner/destination/consent 守卫未放宽。
- **回滚**：无 schema/协议变更，回退上述服务层与 UI 文件即可；已产生的旧格式快照/备份/仓库不被自动清理，回退后仍可读取。

---

## 5. 测试证据（本次亲自运行；原始日志在 `/tmp/`，非仓库内）

| # | 命令 | 退出码 | 结果 | 日志 |
|---|---|---|---|---|
| 1 | `npx vitest run --mode test <12 个被改动测试文件> --maxWorkers=4 --minWorkers=1 --reporter=basic` | 0 | **12 文件 / 147 用例全绿**，0 失败 0 跳过 | `/tmp/vitest-targeted-1.log` |
| 2 | `npx tsc -b` | 0 | 无输出 | `/tmp/verify-tsc-build.log` |
| 3 | `npm run build` | **1** | 失败于沙箱安全删除守卫：`[safe-delete][SAFE_DELETE_BULK_CONFIRM_REQUIRED] count:142 … targets:["dist\assets"]`（`emptyDir(dist)` 触发），**非产品问题** | `/tmp/verify-tsc-build.log` |
| 4 | `npx vite build --outDir dist-verify-20260923`（全新目录，零删除） | 0 | `✓ built in 17.88s`，4963 模块，PWA precache 115 项 | `/tmp/verify-build2.log` |
| 5 | `npx vitest run --mode test --exclude "**/*.live.test.ts" --maxWorkers=4 --minWorkers=1 --reporter=basic` | **1** | **234 文件（1 失败 / 233 通过）/ 1889 用例（3 失败 / 1886 通过 / 0 跳过）** | `/tmp/verify-full-suite.log` |
| 6 | `npx vitest run --mode test src/services/aliyunTtsProvider.test.ts`（单跑复核） | 1 | 仍 3 失败 / 5 通过，`AssertionError: expected 13 to be 3`；该文件 `git status` 未修改 ⇒ **预先存在**，且**非**并发导致 | 终端输出 |
| 7 | `npm run test:firebase` | 0 | 2 文件 / 6 用例通过（`PERMISSION_DENIED` 为 `assertFails` 负路径预期证据） | `/tmp/verify-emulator.log` |
| 8 | `npx playwright test e2e/ui-v2-stage5-surfaces.spec.ts --output=test-results-verify-20260923 --workers=1` | 0 | desktop + android-narrow 4/4 通过（22.2s，冒烟：应用可启动、设置表面可用；**不覆盖备份/恢复**） | 终端输出 |

首轮失败与未复现项如实记录：全量首轮 3 失败（全部 `aliyunTtsProvider`，未改动文件、单跑同样失败）；报告声称的第 4 个失败（`cloudSyncService.integration.test.ts` 并发超时）**本次未出现**；报告声称的 5 个 skipped **本次为 0**。

分层声明：**unit/integration** 见 #1/#5；**Emulator** 见 #7；**Desktop host / Android host**：未运行；**真机/双端**：未运行。以上 8 条命令均未触及真实账号、生产规则、付费服务或用户真实数据。

审查过程中产生的临时产物（`dist-verify-20260923/`、`test-results-verify-20260923/`）已删除；复核 `git status --porcelain` 回到基线 33 项，`dist/` 的六类扩展名计数与审查前快照逐一相同，未污染工作区。

---

## 6. 尚缺的用户验收

按方案第 10 节，以下全部**尚未执行**，需要用户/设备/账号提供：

1. **完整备份 round-trip（设备/宿主）**：Web ZIP、Android SAF 流式、Desktop repository 三条路径各做一次"合成资料 → 恢复到隔离空 profile"，核对正文/草稿/标签/附件/知识库条目数与 detached 语义。→ 需用户在自己设备上操作；本环境无法编译/安装。
2. **篡改与缺件保护（用户侧）**：副本上移除附件、篡改资产字节、删改 manifest/checksum，确认每次都在写库前报错且原 profile 不变。→ 需真实备份文件与设备。
3. **云恢复保护（真实账号或可销毁测试账号）**：构造不完整 batch/畸形实体，确认不提供"以云端为准"，且本地数据、ledger/cursor、知识库均保持基线。→ 需用户授权使用合成账号。
4. **自动备份中断与状态（真机）**：Android 强杀、空间不足、目标被外部同步服务占用/改名，确认上一份 last-known-good 仍可列出并恢复。→ 需 Android 真机 + 至少一个系统文件 provider（建议再覆盖第二类 provider）。
5. **并发知识库成员变化（真机/真账号）**：自动备份读冻结后、写盘期间新增库 B，确认 B 仍待备份、第二轮才清 dirty；测试账号切换/改目的地时旧任务不确认新 scope。
6. **验收记录**：平台、OS/provider、应用 build/version/hash、数据是否合成、每步结果与恢复文件标识，按"自动化 / Emulator / 真实设备 / 生产部署 / 用户最终接受"分栏填写。

**最小、安全的下一步**（不暗示已完成）：先关闭 P1-01（改动很小，且不需要设备），并把报告/`AGENTS.md` 的测试数字与"破坏性替换一律 strict"的措辞按事实收敛；随后由用户授权在 Android 真机上跑第 4、5 项的合成数据验收。

---

## 最终自检

1. 是否亲自检查了当前 diff 与用户已有工作区改动？**是**（`git status`/`git diff --stat`/逐文件 diff，确认全部为未提交工作区改动、`src/db/` 与规则零改动）。
2. 是否核对了所有实施方案断言，而不仅是挑选成功测试？**是**（§2 覆盖阶段 0–6、回归矩阵与完成定义；阶段 0 与设备门禁标为未验证）。
3. 是否验证了失败时正式库、附件、ledger/cursor、知识库 scope 的前后状态？**部分**：自动化用例断言了这些前后值并被我实跑复核；**设备级**前后状态未验证（未运行 host）。
4. 是否检查了所有恢复入口与平台 writer，而非只审查一个公共 helper？**是**（`restoreCloudRecoverySnapshot`、cloud-wins、`restoreRemote`、`applyRemote` 全量分支、ZIP/流式/repository 四条 writer 与三条 reader；并据此发现 P1-01）。
5. 是否检查旧客户端、旧 ZIP、旧云快照的兼容与失败关闭语义？**是**（旧快照 `legacy-unverified` 规则、父写顺序对旧客户端的可见性、v6/v7 容器对称性、`unverifiedAssets`）；**未验证**：无真实旧包 fixture（P3-2）。
6. 是否亲自运行并记录测试，保留首次失败信息？**是**（§5 八条命令，含 `npm run build` 的环境失败与全量首轮 3 失败）。
7. 是否明确区分自动化、Emulator、host、真机、真实账号、生产部署与用户验收？**是**（§1 单列 + §5 分层）。
8. 是否有任何一项因权限/环境/时间未验证？**有**：Desktop/Android/Web host、真机/双端、真实账号、旧包 fixture、Emulator 对新增语义的覆盖、mutation check。**已因此不给无条件通过。**

结论限制：本报告为"独立代码与自动化审查"结论；即便 P1-01 关闭，仍必须完成第 6 节的设备与用户验收，才可谈论发布。
