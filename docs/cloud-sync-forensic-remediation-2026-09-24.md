# 云同步取证修复与收口（2026-09-24）

本文记录提交 `e0b3b09`（`fix(cloud-sync): close GC/MIME/archive/cursor/merge integrity gaps from forensic audit`）的实际改动、跑过的门与通过数、以及**仍未关闭**的发布门。它是 `docs/cloud-sync-backup-restore-hardening-report-2026-09-23.md`（提交 `cf4713c` 的阶段 0–6 加固）的**后续**：一轮双 AI 对抗式取证审计在已加固的链路上又定位出 6 个残留缺口，本次逐一修复。

面向读者：第一次接触这条链路的外部同事 / 下游接手者。 adjudicated 缺陷清单见 `docs/audit/cloud-sync-backup-restore-final-buglist-and-remediation-2026-09-23.md`；加固本体见上述 hardening report。

## 范围边界（与加固一致，未扩大）

- **没有**改数据库 schema（仍是 26；`src/db/` 零改动），**没有**改云同步协议版本、实体集合或既有写入语义。
- **没有**部署 Firebase 规则，**没有**访问真实账号，**没有**构建或安装任何 APK/EXE。
- 改动仅 6 个文件（+486/−28）：`assetIntegrity.ts`、`cloudSyncModel.ts`、`cloudSyncService.ts` 及各自对应的 `.test.ts`。
- 每个修复都**先在对未修复基线证明回归变红**，再恢复字节一致后确认变绿。

## 修复的 6 个缺口

### #1 Storage GC 不可逆误删（P1）
`cleanUpUnreferencedStorage` 现在有三条**无条件**安全判断（即使手动 `force + allowExpensiveStorageGc` 入口也生效，因为该入口同样会触发不可逆删除）：

1. **判断①**：云端状态不可信即跳过。`parseRemoteState` 过去把缺失/非数字的 `headRevision` 静默默认为 0；现在会打上只读诊断标记 `headRevisionUntrusted`（从不落盘）。`headRevisionUntrusted` 为真，或 `headRevision === 0 但仍有同步实体`（矛盾态），一律 `deferred-cost` 跳过，绝不基于被清零的 head 做删除。
2. **判断③**：引用集改用**全集合**读取 `getAllRemoteDocuments(uid)`，不再用按 `revision <= head` 过滤的 `getAllRemote`。一次中断的发布会先上传 blob、后提交实体元数据并推进 head，因此可能存在 `revision > head` 的 pending 文档，其 blob 已在 Storage；过滤读取会让 GC 删掉发起设备仍需要的 blob。
3. **判断②**：删除前证明容错读取没有漏文档。`e0b3b09` 的实现比对 `referenced.length !== protectedReferenceCount`，并**假设**两侧同用全集合谓词、pending 文档同时落在两侧、只有真正的容错丢弃才会触发。**该假设对快照子集合不成立**：`makeRemoteSnapshot` 把实体文档与复习事件文档写进同一个 `entities` 子集合，服务器原始计数（右侧）含两者，而容错实体解析（左侧）丢弃复习事件，于是任何含复习事件的真实快照都让左侧恒少、GC 永久 `deferred-cost`。这是 `e0b3b09` 之后定位并修复的 P0，详见下方「后续修复」。

回归：`cloudSyncWhitebox.test.ts` 的 N2-1..N2-4。

### #2 MIME 单边豁免（P1）
`assetIntegrity.ts` 的 `assetByteFailure`：字节已匹配哈希后，通用回退类型 `application/octet-stream` 的豁免过去**只在声明侧**生效。一个字节相同、blob 类型为 `application/octet-stream` 而声明为具体类型（如 `image/png`）的对象会被判 `mime` 违约，导致**每次同步（含增量拉取）永久失败且无逃生**。现改为**对称**：任一侧为 `application/octet-stream` 即豁免，只有两个**具体且不同**的类型才算违约。回归：`cloudSnapshotIntegrity.test.ts` 的 MIME-A。

### #3 / #3b 假 `complete:true` 恢复点（P1）
`replaceCloudWithLocal`（"以本机为准"）在创建"冲突前的云端版本"恢复点前，先用两次服务器计数自证完整：confirmed（`revision <= head`）与 pending（`revision > head`）各自对实体与复习事件计数。

- `makeRemoteSnapshot` 会用**同一个过滤数组**的长度盖 `complete:true`，而 `assertStrictCloudSnapshot` 只把该声明与它刚写入的文档比对——一个数和自己比，结构上永远抓不到截断。
- 触发不需要畸形数据：发布把实体批次与推进 head 分成两次非原子写，中断的发布会让 `(head, next]` 文档对所有读取不可见。
- 现在：集合不可证明（有容错丢弃 **或** 有 pending 写）时**跳过创建恢复点**并给出诚实 `progress` 告警；"以本机为准"的覆盖**仍继续**（它是用户显式选择，也是越过另一台设备未确认写入的受制裁方式）。**绝不**伪造声称完整的恢复点，也**绝不**写 `complete:false`（旧客户端会忽略它，且 `classifyCloudRecoverySnapshot` 会把它读成 `writing`——一个谎言，且会被 GC 回收）。

回归：CONTROL + F-A-1 + F-A-2。

### #4 完整性声明被污染（P1，#3 的上游）
`getRemoteChanges` 现在返回 `droppedCount`（容错解析丢弃的文档数）。两个完整性分支（已应用分支、无下载分支）在 `droppedCount > 0` 时**冻结** `remoteDatasetCompleteThroughRevision`（保持旧值，与已推进的 `lastPulledRevision` 分叉，于是 `complete` 为假），而**拉取游标仍前进**。这样一次静默缩水的数据集不会再被后续破坏性入口当作"本机已等于云端到 head"而信任。回归：N1-A/B/C。

### #5 空 `basePayload {}` 真值（P2）
`>阈值` 的 settings/template 载荷会被外部化，ledger 过去把清空后的载荷记成 `basePayload: {}`。`{}` 是真值，于是三方合并跳过了保守的"无共同祖先 ⇒ 实体级冲突"分支，转而针对空祖先做字段合并：云端删除的字段相对 `{}` 看起来"未变"、本机看起来"已变"，本机胜出，被删字段**静默复活**。现在 `mergeCloudSyncSmallEntity` 与**两处 ledger 记录点**都把空 base 当作 `undefined`（无共同祖先）。因为历史 ledger 行已存 `{}`，修复落在合并本身而不只是记录点。回归：N7-A。

### #6a–#6d 次要项
- **#6a**（注释）：旧版 zip 迁移**有意不**走云快照严格分类——zip 没有可分类的快照父文档，其完整性门是 `zipToSnapshot` 自身的容器校验（manifest 格式/版本、v7 外层校验和、逐资源字节校验），均在破坏性恢复前抛错；pre-v7 无校验和的归档按 `legacy-unverified` 语义信任接收。
- **#6b**（消息）：`(head, next]` 间隙守卫的报错现在指明逃生路径——等待发起设备完成同步，或在本机执行一次"以本机为准"越过未确认写入。
- **#6c**（注释，已知局限不修）：快照按墙钟 `createdAt` 排序回收，时钟落后的设备可能让新建恢复点被当作最旧而立即回收。天真修法更糟（按 `revision`/serverTimestamp 排序会让 Firestore **排除**缺该字段的旧快照，可能删掉仍被引用的 Storage 对象；去掉 limit 改内存排序会移除读取上限）。影响有界——回收只丢一个恢复点，活动集仍引用的资源受保护。真正修复需要部署索引 + 旧数据回填，另行处理。
- **#6d**（注释 + 重抛）：`resolveCloudSyncConflict` 里那个本意为"传输级失败回退旧 zip"的 catch，现在遇到 `CloudSnapshotIntegrityError` 会**重抛**而非回退——严格拒绝意味着当前云数据集被故意判为损坏，回退旧 zip 会掩盖该拒绝并恢复陈旧数据。

## #0 严格解析器过度拒绝率（真实数据只读重放）

发布门 #7 问的是：严格化加固到底"保护"了用户还是"锁死"了用户。用一份**临时只读**脚本，把 `D:\StudyJournal_backup\study-journal-backup\snapshots\*.json` 的 5 份真实快照跑过**真实的** `exportCloudSync` 转换与**真实的**严格校验器（`assertStrictRemoteDataset` → `parseStrictEntity` / `parseStrictReviewEvent`）。全程不开数据库、不连 Firebase、不写任何东西；脚本跑完即删（它引用本机专有路径，不作为常驻测试）。

| 指标 | 结果 |
|------|------|
| 重放文档总数 | 2797 实体 + 1980 复习事件 = **4777**（5 份快照） |
| 实体 / 事件过度拒绝 | **0 / 0** |
| 外部化错误 | **0** |
| 全集重复/身份矛盾失败 | **0 / 5** |
| **过度拒绝率** | **0.0000%** |

每份约 559–560 实体（197 资源、93 块、92 复习状态、77–78 日统计、49 条目、13 标签、27 教练实体、各 1 设置/模板/日计划）。

**诚实局限（#7 据此未完全关闭）：**
1. 5 份快照的 `externalized(>750KB 阈值) = 0`——真实数据从未触发"外部化空载荷走严格解析"这条分支，该路径未用真实字节验证。
2. 资源字节 / `assetByteFailure`（#2 MIME）属于另一条下载校验链，不在此严格解析测量内，未用真实资源字节跑过。
3. 5 份快照高度雷同（同 197 资源 / 108MB），实为"同一套数据测 5 遍"，不是 5 个独立用户样本。

## 后续修复（2026-09-24，`e0b3b09` 之后）

### P0：判断② 两侧计数不同源 ⇒ 自动/手动 Storage GC 永久静默失效

**缺陷**：`e0b3b09` 的判断②（`cleanUpUnreferencedStorage`）比对 `referenced.length !== protectedReferenceCount`。右侧 `protectedReferenceCount` 含 `getCountFromServer(snapshotEntitiesRef(uid,id))`——快照 `entities` 子集合的**全部**文档；左侧 `referenced` 由 `collectSnapshotEntities` → `parseAndNormalizeRemoteEntities` 得出，只保留能通过**实体**解析器的文档。而 `makeRemoteSnapshot` 把复习事件也写进同一子集合（`review-event:` 前缀，`{ id, contentHash, payload, revision, kind:"review-event" }`，无 `entityType`/`entityId`），`parseRemoteEntity` 对其返回 `undefined` 并被 `.filter(Boolean)` 丢弃。⇒ 只要受保护快照含 ≥1 个复习事件，左侧恒少，判断② 恒触发，`cleanUpUnreferencedStorage` 恒返回 `deferred-cost`，一个对象都不删。

**影响面**：判断② 无条件（不受 `allowExpensive` 约束），所以**自动后台清理与手动强制 GC 双双永久失效**；孤儿 blob 永久累积。且**静默 + 误诊**——维护流程记为 `deferred-cost`（非 `failed`）不报警，文案"云端存在无法读取的同步数据"把根因指向错误方向（数据其实正常，只是复习事件被合法排除）。常规自动备份走 `makeLocalSnapshot`，它把 `exported.reviewEvents`（源自 `recordReviewLogs`）传入 `makeRemoteSnapshot`，所以**任何有复习历史的用户每个快照都含复习事件**。

**修复**（`cloudSyncService.ts`）：`collectSnapshotEntities` 改为按 `REVIEW_EVENT_DOCUMENT_PREFIX` 分区（与恢复路径 `assertStrictCloudSnapshot` 同一判据），实体走 `parseAndNormalizeRemoteEntities`、复习事件走 `parseRemoteReviewEvent`，返回 `{ entities, consumed }`——`entities` 仍只喂保护集（复习事件不引用任何 blob），`consumed` 是两类容错解析成功的文档总数。判断② 改为比对 `active.length + snapshotRead.consumed !== protectedReferenceCount`，两侧同源。解析为两类的文档都不算（真正的畸形丢弃）仍会让 `consumed` 短缺，故畸形文档保护不变。

**回归**：`cloudSyncWhitebox.test.ts` 新增 **N2-5**——受保护快照 `snap1` 的子集合混装 1 个实体文档 + 1 个复习事件文档，Storage 播一个真孤儿；断言维护 `completed` 且孤儿被回收、活动集与快照引用的资源均存活。**先证红**：对未修复的 `e0b3b09` 报 `expected 'deferred-cost' to be 'completed'`；修复后变绿，白盒套件 43/43。

**为何 N2-1..N2-4 漏掉**：它们的 `seedSnapshots` 只写父标记、`entityCount:0`、**不写任何子文档**（测试注释自陈 "childless"），快照侧计数与解析恒为 0、天然相等，判断② 只在 N2-2 因**活性**畸形文档触发。从未给受保护快照播下子文档、更未播复习事件——正是盲区。

> 状态：本节修复在撰写时是**工作区未提交**改动（`cloudSyncService.ts` + `cloudSyncWhitebox.test.ts`），等待提交授权。

## 门（Node v24.16.0，全绿）

- `tsc -b --pretty false` 干净，exit 0。
- 有界全量套件 `npx vitest run --mode test --exclude "**/*.live.test.ts" --maxWorkers=4 --minWorkers=1`：**235 文件 / 1906 测试全过**（加固基线 1894；+12 为本次新用例；此前偶发的并发 sync-integration 超时本轮也通过）。
- Firebase Emulator：**6/6**。
- `git diff --check`：干净。
- 白盒套件 43/43（含后续修复新增的 N2-5）；新增回归均为正向断言（审计阶段的 `it.fails` 已重写为正向断言，未静默删除）。
- 后续 P0 修复后重跑有界全量套件：1906 通过 / 1 失败，该 1 例是既有的并发 sync-integration 超时（`cloudSyncService.integration.test.ts` 的 "reconciles the committed part of a failed multi-batch publish"），单独跑 1840ms 通过，属环境伪影而非本次改动。

为打通 GC 删除路径，顺带修了白盒测试脚手架三处缺口：`getCountFromServer` 桩现在尊重 where/limit；storage `list`/`deleteObject` 从抛错改为可用（新增 `storageProbe.objects`/`deleted`）；`snap()` 补 `.ref`（过期快照 `batch.delete(item.ref)` 曾在 undefined 上读 `.path`）。这些是测试基础设施修复，不改产品行为。

## 仍未关闭（发布前需单独处理）

1. **#7 的两条分支**：>阈值外部化载荷、资源字节/`assetByteFailure`，均未在真实数据上证明（见上"诚实局限"）。需要一份含 >750KB 外部化载荷的真实备份，或对真实资源字节单独重放。
2. **Desktop / Android / Web 宿主验收未跑**（与加固一致）。
3. **`src/services/nativeAutoBackupStreamService.ts` 整条链**与 Android Java `beginZipLatest` 仍是无引用死代码，等待用户"删除或接线"决定。
4. **未构建/部署任何安装包**，未部署规则，未触真实账号或真实数据。
5. 双 AI 收敛清单是本地审计产物（`output/forensics-full-chain-review-2026-09-23/merged-final-checklist-2026-09-23.md`，未纳入版本控制）；本文与 adjudicated 缺陷清单是已纳入版本控制的权威记录。
