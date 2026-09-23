# 云同步/备份/恢复加固 —— 二次审计复查裁定、最终 Bug 清单与修复方案（2026-09-23，终稿 v2）

> **版本与并发事件声明**。本文件初稿由本会话于 18:33–18:36 独立写入；随后（≈18:38）另一并发会话在改写 `src/__probe__/zz-tmp-realm*.test.ts` 探针的同窗口内对本文件做了第二段编辑（新增其 N-5/N-6/N-7、§1.5 异议表，并替换了本会话 aliyun 实测数字的表述）。应你选择，本终稿 v2 **以本会话证据链为基底重写**，对并发会话的有效修正逐条回源码验证后吸收，对其不可复现的断言如实标注。除本文件外，本次复查未修改任何被审源码。

**输入**：两份二次审计报告——《两份独立审查的对账与最终审计报告（桌面版）》（下称【对账】）与 `docs/audit/cloud-sync-backup-restore-hardening-audit-adjudication-2026-09-23.md`（下称【裁定】）。
**方法**：对两份报告的全部可验证断言逐条回源码复核（行号以当前工作区为准）；本会话实跑判别性命令：

| 时点 | 命令 | 结果 |
| :-- | :-- | :-- |
| 18:26 | `vitest run src/services/aliyunTtsProvider.test.ts` 单跑 | **8 passed / 0 failed** |
| 18:28 | 定向 12 个改动测试文件 | **12 files / 147 tests 全绿** |
| 18:29 | 有界全量 `--exclude "**/*.live.test.ts"` | 236 files / 1894 tests = 1893 passed / **1 failed**（唯一失败：`cloudSyncService.integration.test.ts` 并发 5s 超时；文件数被并发探针污染，见 B-15） |
| 18:31 | `tsc -b` | exit 0 |
| 18:31 | `git diff --check` | 唯一空白项 `cloudSyncWhitebox.test.ts:1010: new blank line at EOF`（全库 LF→CRLF warning 属 autocrlf 配置，不计缺陷） |
| 18:43 | `vitest run --mode test src/services/aliyunTtsProvider.test.ts`（探针清除后的干净复跑，命令照抄并发会话） | **8 passed / 0 failed** |

**aliyun 之争的终稿裁定：两种观测真实存在且互斥，均未定谳；但无论哪侧为真，都不是被审改动缺陷。** 支持"3 失败"的独立记录有三处（实施报告 `:104` 的一次性探针：`response.blob().size=3`、`instanceof globalThis.Blob=false`、`new Blob([blob]).size=13`＝字符串化 `"[object Blob]"`；【裁定】实跑；并发会话实跑）。本会话两次独立实测（含探针清除后、照抄对方命令的 18:43 复跑）均为 8/8。⇒ 分歧为**机器/运行时环境敏感**（Node/jsdom realm 行为），不是任何一方的逻辑错误；`aliyunTtsProvider.test.ts` 未被本次改动触碰，定性为既有测试环境缺陷（B-15）。

---

## 1. 逐条复查裁定

### 1.1 共识 P1-01 —— **真实，确证到行**（本次定级 **P0**，见 §2 定义）

触发链每一环独立复核成立：

| 环 | 位置 | 核实内容 |
| :-- | :-- | :-- |
| 1 | `cloudSyncService.ts:2661` | `firstEmptyDevice = ledger.length===0 && isBootstrapOnlyCloudData(initialExport)` —— 新设备/空库加入已有账号，产品正常流程 |
| 2 | `:2715` | `firstEmptyDevice && remote.exists && headRevision>0` ⇒ 进入全量拉取 |
| 3 | `:2726` | `getAllRemote(user.uid, remote.state)` 缺第三参 ⇒ `:1108` `strict=false` ⇒ `:1097-1104` 走容错解析 |
| 4 | `:463-472` + `:517-522` | `parseRemoteEntity` 缺 `entityType/entityId/contentHash/revision/payload` 任一字段 ⇒ `undefined` ⇒ `.filter(Boolean)` **静默丢弃** |
| 5 | `:1377-1406` | `applyRemote` 内无任何 strict 调用 ⇒ `restoreCloudSyncSnapshotIfUnchanged` 以过滤后的子集做**破坏性全量替换** |
| 6 | `:2727-2728` → `:1749-1756` | `persistLedgersInTransaction(…, headRevision)` 同时推进 `lastPulledRevision` 与 `remoteDatasetCompleteThroughRevision` ⇒ **虚假完整性宣告** |
| 7 | `:1021-1032` | 无自愈：增量只取 `revision > lastPulledRevision`；targeted 只查 ledger 已有键——被丢弃实体连 ledger 行都没有 |
| 对照 | `:2916-2926`、`:3128` | cloud-wins 与快照恢复入口均有 strict + 注释（`:531-538` 自述"strict 只被真正替换本机库的分支使用"）——本分支是**唯一漏网的破坏性全量替换入口** |

- 测试覆盖：`grep firstEmptyDevice` 仅命中实现自身与注释；`:2734` 特征文案在全部测试文件零命中 ⇒ **零用例**确证。
- 【对账】对报告 1 的勘误成立：`:2727` 传入了 `initialEpoch`（缺的是 strict，不是 epoch 保护）。
- 【裁定】"补 `strict=true` 仍不够"的机制补充成立：`getAllRemote`（`:1108-1114`）只返回实读数组、无期望计数；`assertStrictRemoteDataset`（`cloudSnapshotIntegrity.ts:264-284`）签名无 `expectedCount`，注释（`:260-262`）自述 active 集合读无外部 cardinality 可比 ⇒ 计数校验在该路径**根本无法照搬**，修复为"strict 第三参 + `assertStrictRemoteDataset`"双保险（见 §3 F-1）。

### 1.2 N-1（owner 切换回执）—— **真实，定级 P1；危害按并发会话 N-6 修正收敛（该修正已回源码验证吸收）**

机理全链静态确证：`autoBackupService.ts:142` assert 通过（owner 仍 A）→ `:143` `writeLatest` 异步窗口内 owner 切换 A→B → `:145` `completeKnowledgeBackup(scope)` 先于 `:146` 的 `assertKnowledgeOwner` 执行；`autoBackup.ts:33` 按 `token.ownerScope`（=A）查行；`scope.ts:32` 四条件守卫逐项比较的全是 **token 与 A 行自身**（`verifiedDestinationId` 由 `autoBackup.ts:35` 传 `token.destinationId` 自证）⇒ **必然全部通过，回执写入 A 行**，`:146` 才抛。与【裁定】探针实跑结果一致。
- P5-T4 未抓到的原因确证：`autoBackup.test.ts:140-141` 在 owner 切换后又调 `authorizeKnowledgeBackup()`，其 `autoBackup.ts:13-14` 把**其他 owner 行 consented 置 false** ⇒ 拒绝来自"撤 consent"分支，不是 owner 分支。
- **危害（修正后）**：`:144` `ensureValidWriteResult` 已过 ⇒ 归档内容完整，**不构成数据丢失**；且 `autoBackup.ts:14` 同时把 A 的 `autoBackupState.enabled` 置 false，`runtime.ts:44` 的早退判据（`!scope.autoBackupState?.enabled ⇒ return false`）⇒ **【裁定】所述"A 重新登录后看到已捕获而跳过重备份"的用户可见后果不存在**，仅剩弱内部记账不一致（A 行被写入回执时的 `capturedGenerations`）。维持 P1 的理由收窄为：**`assertKnowledgeOwner` 防线语义落空 + 一行级修复成本**。
- `autoBackup.test.ts:44-52` 现有用例走 `repository.assertContext`，与本函数无关——修复不与既有期望冲突。

### 1.3 其余条目裁定（合并去重）

| # | 发现 | 复核结论 | 证据（实测行号） |
| :-- | :-- | :-- | :-- |
| 1 | `restoreRemote` 不构成第二处 P1（M-5） | **裁定成立** | `:2916` 块内所有路径 return（`:2944`/`:2977`）或 throw；`:3003` 仅在 `!exists ∥ headRevision===0` 可达，`restoreRemote` 的 `:2293` 立即抛出转 legacy 回退 |
| 2 | N-2：`restoreRemote` 也推进 complete 标志 | **成立（潜在）** | `:2295` 容错读 + `:2303`→`resetAndPersistLedgersInTransaction`（`:1788+`）无条件写 complete ⇒ 修复回归网应覆盖 |
| 3 | 生产归档恒 v7（M-6） | **裁定成立** | `storageAdapter.ts:2349` 默认 `includeKnowledge=true` → `:2387`/`:2472` `version:7`；v6 仅 `:2430-2431` `createCloudSyncSnapshot()`（云同步非归档） |
| 4 | Emulator 未覆盖新语义（P2） | **成立** | `firebase-emulator/` 仅 2 文件（4+3 个 `it`），grep 无 complete 标记/批次失败/strict restore 语义用例 |
| 5 | 阶段 5.2 两类场景零用例（P2） | **成立** | `autoBackup.test.ts` 8 个用例不含"capture 后删除库"（`runtime.ts:49` 分支）与"纯 owner 切换不重绑"（即 N-1） |
| 6 | 数字失真（P2/证据纪律） | **成立** | `AGENTS.md` 与报告 `:96-97`："14 文件/164 用例"实为 **12 文件/147 用例**（本会话实测全绿）；报告 `:96` 同一行既写"14 个文件"又写"13 文件"（内部矛盾）；"239/1894/5 skipped"恰为未排除 5 个 live 文件的口径（`find src -name "*.live.test.ts"` = 5） |
| 7 | 永真断言 | **成立** | `nativeRepositoryBackupService.test.ts:330` `not.toContain("assets/asset-1-asset-1.png")` 在内容寻址路径下任何实现皆真；同性质由 R5-02（`:592`）真实覆盖 |
| 8 | `destination-visible` 死枚举 | **成立** | 全仓仅 `types.ts:376` 定义 + `AutoBackupPanel.tsx:67` 文案；产出点只有 `autoBackupAdapter.ts:128` 与 `nativeRepositoryBackupService.ts:89/528` |
| 9 | v7-无 `assetChecksums` 旧包无真实 fixture | **成立（覆盖缺口）** | 代码路径确证：`backup.ts:74-97` 缺声明⇒空表、`:335` 仍要求文件存在 + `assertArchiveAssetBytes`；无生产同源 fixture |
| 10 | `meta.size` 声明 vs 实写字节 | **成立（潜在；经并发会话 D-6 补充验证，生产管线内不可达）** | `streamingBackupService.ts:125` 与 `nativeAutoBackupStreamService.ts:105` 用 `meta.size`；`backup.ts:67`、`nativeRepositoryBackupService.ts:419` 用实际 `data.size`。**已核 `exportPrivacy.ts:53-65`**：sanitize 只过滤 `generatedBy==="knowledge-podcast"` 数组并改 counts，**不触碰 `meta.size`** ⇒ 漂移需外部改库，属未证实的 fail-closed 可用性风险；且 StreamService 半项在死代码上（见 B-07） |
| 11 | 空快照边界 `complete:true, entityCount:0` | **成立（仅记录）** | `cloudSnapshotIntegrity.ts:305-333` 0≡0 通过；生产 writer `cloudSyncService.ts:1949` expectedCount 源自实数组长度，正常不可构造 0 |
| 12 | `readBackSnapshot` 不逐字节回读资源 | **成立（标签精确性）** | `nativeRepositoryBackupService.ts:349-391`：快照 JSON 回读 + v7 容器校验 + 声明清单结构校验，无逐资源字节重哈希 |
| 13 | `loadKeptAssetPaths` 静默 catch | **成立** | `:274-281` 损坏旧快照的 assetPaths 不被保留 ⇒ 其仍引用的代际文件可被 `:298+` 清理 |
| 14 | 原生死代码链（经并发会话 N-7 精确化，已验证吸收） | **成立** | `nativeAutoBackupStreamService.ts` **整文件**生产零调用方；其依赖的 `beginNativeAutoBackupZip`/`ZipEntry`（`nativeAutoBackup.ts:176/182`）唯一消费者就是这个死文件自身；`writeNativeLatestBackup`（`:144`）同样仅测试引用。`BackupPage.tsx`/`autoBackupAdapter.ts` 等引用的是活模块 `nativeAutoBackup.ts`，勿混淆。Java 侧 `beginZipLatest`（`Plugin.java:374`）有实现无消费 |
| 15 | W4 断言弱 | **成立** | `autoBackupAdapter.web.test.ts` W4 用例只断 `isBound()` 前后态，无"未调用 writeLatest"断言 |
| 16 | `git diff --check` EOF 空行 | **成立** | `cloudSyncWhitebox.test.ts:1010: new blank line at EOF.` |
| 17 | aliyun 3 失败之争（M-2/M-3） | **互斥观测，均未定谳；非被审缺陷** | 本会话 18:26 与 18:43（干净、照抄 `--mode test`）两次 8/8；三处独立记录报 3 失败（机制解释见头部）。文件未被改动触碰 |
| 18 | 全量套件数字 | **各方口径均不可跨会话对账** | 本会话唯一失败为 sync-integration 并发超时（与 AGENTS.md 自述"单跑通过"一致）；【对账】0 失败、【裁定】3 失败、并发会话 4 失败、本会话 1 失败并存 ⇒ 门禁数字必须连同探针状态、`--mode`、worker 配置一次性留档（并入 F-3/S2） |

### 1.4 本次复查新增（两份报告之外）

- **N-4（P2，线索级）Storage GC 同样消费容错 `getAllRemote`**：`cloudSyncService.ts:2067` 的 `active` 集合是删除 Storage 对象的保护名单来源（`:2070` 仅收集 asset 实体的 `payload.contentHash`）。顶层字段畸形的 asset 实体文档会被容错解析静默丢弃（`:463-472`），其字节对象失去保护并被 `:2081-2084` **删除**——同属"容错丢弃 ⇒ 静默破坏"家族，且后果作用于云端共享数据。未证实此类文档可真实存在（写入器总是写全字段），建议随 F-1 一并评估：GC 路径改 strict（抛出则本轮延期清理，fail-closed）或以注释+计数断言固化前提。
- **N-5（门禁卫生，本会话实测教训）**：会话期间另一进程向 `src/__probe__/` 写入 realm 探针（18:29–18:31，后删除），直接污染本会话 18:29 全量跑的文件计数（236 ≠ 234）。**今后凡创建探针必须先删再跑门禁；全量数字声明必须附命令、`--mode`、pool/worker 配置与探针状态，否则不可对账。**

### 1.5 对并发会话第二段编辑的裁定（谁对谁错，逐条）

| 项 | 并发会话断言 | 本会话裁定 |
| :-- | :-- | :-- |
| N-6/D-3（N-1 危害收敛） | `isKnowledgeBackupPending` 返回 false，无用户可见后果 | **对，已吸收**（`runtime.ts:44` + `autoBackup.ts:14` 本会话回源核实） |
| N-7（死代码整文件精确化） | StreamService 整文件死代码，勿与活的 `nativeAutoBackup.ts` 混淆 | **对，已吸收**（grep 实证） |
| D-6（meta.size 生产不可达） | sanitize 不触碰 `meta.size` | **对，已吸收**（`exportPrivacy.ts:53-65` 核实） |
| D-1/N-5（"我首轮 8/8 系探针污染、'不可复现'失实"） | 其"干净环境单跑 3 失败稳定复现" | **不成立/互斥**：本会话 18:43 在探针清除后照抄其原命令复跑仍 8/8；其用"污染"解释我的观测，但其自身"稳定复现"的头条结论在干净环境被本会话直接反驳。定谳需两次会话互换环境重跑，此前按"环境敏感"并列记录 |
| 其方法段数字（1885/4、firebase 6/6 等） | 写入"本次复查"名下 | **非本会话实测**，系其自身会话记录，本终稿不沿用其口径（其 sync-integration"串行重跑 22/22"的判别方式可取，并入 S2 判据） |

---

## 2. 最终 Bug 清单（按用户定义分级）

> P0=必须修（发布阻塞）；P1=建议修（本轮低成本修掉）；P2=以后可以再修。
> **P0 级无已证实的即时数据损毁缺陷**；B-01 由共识 P1 上调（两份审计一致判发布阻塞，且按"P0=必须修"定义归位）。

| ID | 级别 | 缺陷 | 位置 |
| :-- | :-- | :-- | :-- |
| **B-01** | **P0** | `firstEmptyDevice` 首同步以容错解析做破坏性全量替换，并同步推进 `lastPulledRevision` + `remoteDatasetCompleteThroughRevision`（虚假完整性宣告，无自愈，零测试） | `cloudSyncService.ts:2726-2728` |
| **B-02** | **P1** | 纯 owner 切换（不重绑目的地）下 `completeKnowledgeBackup` 先于 owner 断言执行，回执提交到旧 owner 的 scope 行（危害已收敛为防线语义落空，无用户可见后果） | `autoBackupService.ts:145-146`、`autoBackup.ts:31-37`、`scope.ts:31-40` |
| **B-03** | **P1** | `AGENTS.md` "Destructive full replacement **now uses** strict snapshot validation" 全称宣告与 B-01 现状不符；同段与实施报告的测试数字（14/164、"14 个文件/13 文件"同行自相矛盾、239/1894 口径未标注）与实测（12/147）不符 | `AGENTS.md` 段 1；报告 `:96-97` |
| B-04 | P2 | 方案 §6.2 点名的 Emulator 新语义覆盖未做（2 文件，零覆盖 complete 标记/批次失败/strict restore） | `firebase-emulator/` |
| B-05 | P2 | 阶段 5.2 两类场景零用例：capture 后删库（`runtime.ts:49`）、纯 owner 切换（随 B-02 修复补） | `autoBackup.test.ts` |
| B-06 | P2 | GC 容错读可扩大 Storage 删除面（N-4，线索级） | `cloudSyncService.ts:2067` |
| B-07 | P2 | `nativeAutoBackupStreamService.ts` **整文件** + `writeNativeLatestBackup` + `beginNativeAutoBackupZip*` 转发层 + Java `beginZipLatest` 死代码链，待"删除或接线"决策；`AGENTS.md` 披露范围应扩到整文件 | `nativeAutoBackup*.ts` |
| B-08 | P2 | `streamingBackupService.ts:125` 以 DB `meta.size` 声明字节（活通道；生产管线内漂移不可达，属未证实的 fail-closed 可用性风险）；StreamService 半项在死代码上 | 同左 |
| B-09 | P2 | `loadKeptAssetPaths` 静默 catch 可误删仍被损坏旧快照引用的代际资源文件 | `nativeRepositoryBackupService.ts:274-281` |
| B-10 | P2 | `assertStrictCloudSnapshot` 接受 `complete:true, entityCount:0`（理论"以空清空"边界，生产 writer 不可构造） | `cloudSnapshotIntegrity.ts:305-333` |
| B-11 | P2 | `resetAndPersistLedgersInTransaction`（restoreRemote 用）无条件推进 complete 标志；路径现不可达但无形态守卫（N-2） | `cloudSyncService.ts:2295/2303/1788+` |
| B-12 | P2 | v7 无 `assetChecksums` 的真实旧包 fixture 缺失（代码路径已静态确证正确） | `backup.test.ts` |
| B-13 | P2 | `destination-visible` 死枚举；`archive-verified` 标签语义偏强（回读不含逐资源字节重哈希） | `types.ts:376`；`nativeRepositoryBackupService.ts:349-391` |
| B-14 | P2 | 测试卫生三小项：永真断言（`nativeRepositoryBackupService.test.ts:330`）、W4 弱断言（`autoBackupAdapter.web.test.ts`）、EOF 空行（`cloudSyncWhitebox.test.ts:1010`） | 同左 |
| B-15 | P2（环境/流程，非代码缺陷） | ① `aliyunTtsProvider.test.ts` 跨 realm Blob 环境敏感失败（两派观测互斥、文件未被触碰；机制候选：`knowledgePodcastService.ts:686` 的 `new Blob([blob])` 对异 realm Blob 字符串化为 13 字节）；② sync-integration 并发超时；③ 全量数字无可跨会话对账口径（探针/`--mode`/worker 配置不入档） | 环境 + 门禁流程 |
| — | 裁定不变 | `restoreRemote` 不构成第二处 P1（不可达确证）；生产恒 v7（v6 疑点排除）；P5-T4 触发的是重绑撤 consent 分支；阶段 0 无基线证据 = 申报缺口而非缺陷 | §1.1–1.3 |

---

## 3. 修复方案（P0/P1，可直接开工）

### F-1（B-01，P0）：firstEmptyDevice 分支补上与 cloud-wins 对称的双保险

**代码改动**（`src/services/cloudSyncService.ts`，任何本地写/ledger/cursor 之前）：

```ts
// :2726 现: const allRemote = await getAllRemote(user.uid, remote.state);
const allRemote = await getAllRemote(user.uid, remote.state, true);   // strict 解析：畸形/重复文档抛出而非丢弃
assertStrictRemoteDataset(allRemote);                                  // 与 :2926 同款：身份一致性 + 重复拒绝
```

- 两处改动合计 ≤3 行；`parseRemoteEntitiesStrict`/`parseRemoteReviewEventsStrict`/`assertStrictRemoteDataset` 均已存在（`:539+`、`cloudSnapshotIntegrity.ts:264`），无需新代码路径。
- **为何没有"声明 vs 实读"计数防线、也不需要新造**：`getAllRemote`（`:1108-1114`）不返回期望计数；`assertStrictRemoteDataset` 无 `expectedCount` 参数，注释（`:260-262`）自述 active 集合读无外部 cardinality 可比。消灭"静默丢弃缩小集合"的是第三参 strict 解析（遇畸形/重复即抛，替代 `.filter(Boolean)`）；`assertStrictRemoteDataset` 提供重复键与身份一致性的第二道闸。**不要照搬 `assertStrictCloudSnapshot` 的计数校验**（那个有父文档 `entityCount` 可比，`:305-333`）。
- 拒绝发生在 `applyRemote` 之前 ⇒ 保持"任何拒绝先于本地写、ledger 行、cursor 移动"的既有不变式（把 `:2923-2925` 同款注释加到本分支）。
- 顺带（B-11）：给 `restoreRemote`（`:2295`）同款 `strict=true + assertStrictRemoteDataset`，或加注释固化"`:2916` 守卫使其在 headRevision>0 时不可达"的前提——二选一并写进代码注释。

**回归测试**（新增，建议 `cloudSyncService.integration.test.ts` 或独立 `cloudSyncFirstEmptyDevice.test.ts`，走既有 in-memory transport）：

1. 判别性主用例：`ledger=[]`、本机仅 bootstrap、云端 `headRevision>0`；向 `syncEntities` 注入一条缺 `contentHash` 的文档（及一条重复 id 文档）⇒ 断言 sync 以 `CloudSnapshotIntegrityError` 失败/返回，且 `blocks/assets/records/cloudSyncLedger` 行集与 `cloudSyncState`（尤其 `remoteDatasetCompleteThroughRevision` 仍 `undefined`、`lastPulledRevision` 未推进）逐字段不变。
2. 正对照：同场景注入**良构完整**集合 ⇒ 同步成功、complete 标志推进到 `headRevision`、进度文案"已从云端恢复现有数据"出现。
3. 两用例必须先对未修复代码验证失败（临时回退 F-1 证明测试抓得住缺陷），再恢复。

### F-2（B-02，P1）：owner 断言前置于回执

**代码改动**（`src/services/autoBackupService.ts:142-146`）：

```ts
const result = await adapter.writeLatest(store, scope, captured?.snapshot);
ensureValidWriteResult(result);
assertKnowledgeOwner(taskOwner, taskGeneration);   // 移到回执之前
if (scope) await completeKnowledgeBackup(scope);
```

- 采用"移动断言"：单行改动、复用既有 `assertKnowledgeOwner`、不改变 `completeKnowledgeBackup` 对 P5-T3 重试路径的语义。**备选**（防未来其他调用方，函数级防御）：在 `autoBackup.ts:31` 事务体内加 `if (currentKnowledgeOwner() !== token.ownerScope) throw new KnowledgeError("scope", …)`（`currentKnowledgeOwner` 已在 `autoBackup.ts:2` import）。两者取一，不叠加。
- **为何四条件守卫拦不住**（写进测试注释）：`scope.ts:32` 首条件 `scope.ownerScope !== token.ownerScope` 在 owner 漂移时两侧都是 A（恒等）；其余三条件比较的全是 token 与 A 行自身 ⇒ 该守卫**结构上无法感知 owner 漂移**，必须由调用点前置断言或函数内引入"当前 owner"新输入。
- catch 分支（`:173`）已保证 owner 漂移时 settings 状态不更新，无需改。

**回归测试**（`src/features/knowledgeLibrary/autoBackup.test.ts`，与 B-05 合并）：

1. P5-T4b「纯 owner 切换不重绑目的地」：A 授权 → capture → `changeKnowledgeOwner("account:B")`（**不调** `authorizeKnowledgeBackup`）→ `completeKnowledgeBackup(capture)` 断言 reject，且 A、B 两侧 `capturedGenerations` 均不变。
2. P5-T5「capture 后删除库」：capture 后删除其中一个库 ⇒ `isKnowledgeBackupPending()` 为 true（覆盖 `runtime.ts:49` 分支）。
3. 用例 1 必须先对未修复代码验证失败。

### F-3（B-03，P1）：文档与数字对账（F-1/F-2 落地后执行）

- `AGENTS.md` 段 1：F-1 落地后 strict 宣告改为全称并点名四条破坏性入口（首同步、cloud-wins、快照恢复、legacy restoreRemote——末者"strict 或不可达+注释"）；测试数字按**干净工作区**重跑写入，并**显式标注口径**：定向 `12 files / 147 tests`；有界全量（`--exclude "**/*.live.test.ts"`，注明 `--mode`、pool/worker、探针状态）；任何失败逐条附单跑复核结论（环境噪声/真实回归二选一，须给证据）。
- `docs/cloud-sync-backup-restore-hardening-report-2026-09-23.md:96-97` 同步更正（消除"14 个文件/13 文件"同行矛盾；其 `:104` 跨 realm 探针记录与本报告头部裁定一致，保留）。
- `AGENTS.md` 死代码披露按 B-07 扩到 `nativeAutoBackupStreamService.ts` 整文件 + Java 侧 `beginZipLatest`，挂"删除或接线"用户决策。

### 分阶段验收标准

| 阶段 | 内容 | 通过判据 |
| :-- | :-- | :-- |
| **S1 代码修复** | F-1 + F-2 + 各自回归用例 | 定向文件（`cloudSyncService*`、`cloudSyncWhitebox`、`autoBackup`、`autoBackupService`、`runtime` 相关）全绿；`tsc -b` exit 0；**每条新用例对未修复基线失败过**（留失败输出记录） |
| **S2 有界全量** | 全仓回归 | 无任何 `src/__probe__`/临时产物在场；`--exclude "**/*.live.test.ts"` 无新增失败；**每条失败必须单跑 +（对超时项）`--pool=forks --poolOptions.forks.singleFork=true` 串行重跑复核**，区分"环境噪声/真实回归"并连同命令、`--mode`、worker 配置留档 |
| **S3 Emulator + 文档** | B-04 与 F-3 | Firebase Emulator 新增覆盖（快照子批失败不留可列恢复点；strict 拒绝畸形集合）**或**书面豁免记录在案；`AGENTS.md`/报告的每条可复现数字在同 commit 重跑成立；`git diff --check` 无空白项（含 B-14 三项顺带清理） |

### 最终完成定义

全部满足才算修复完成（不含发布本身）：

1. **B-01 关闭**：首同步分支与 cloud-wins、快照恢复共用同一 strict 规则，判别性回归在场且被证明能抓住原缺陷；"部分集合当全量 + 虚假完整性宣告"形态在四条破坏性入口中要么被 strict 拒绝、要么被注释固化为不可达前提（B-11）。
2. **B-02 关闭**：owner 切换后回执必被拒，且"纯切换不重绑"与"capture 后删库"用例常驻。
3. **文档=代码**：`AGENTS.md` 不再存在与当前工作区不符的全称安全宣告或不可复算数字；死代码披露完整并挂有用户决策项。
4. **门禁基线可信**：一次干净工作区的有界全量 + Emulator 记录在案（命令、`--mode`、pool 配置、探针状态四要素齐全），此后任何数字声明可复算；aliyun 跨 realm 项以"环境缺陷"定案并挂测试稳定化后续项（改用 `--mode` 一致的桩或显式 realm 检查），不再以会话观测互相推翻。
5. 剩余 P2 项（B-04…B-14）逐项修复或在报告/`AGENTS.md` 书面豁免。
6. **发布仍需另行完成**（不在本方案范围）：Desktop/Android/Web host 验收、真实账号两设备首同步、老数据对 strict 的过拒性验证、用户验收——两份审计一致维持"这些未做 ⇒ 不通过发布"。
