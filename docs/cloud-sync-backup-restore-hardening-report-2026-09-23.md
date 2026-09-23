# 云同步、备份与恢复链路加固（2026-09-23）

按 `docs/cloud-sync-backup-restore-hardening-plan-2026-09-23.md` 的阶段 0–6 实施。本文记录实际改动、实际跑过的命令与通过数、兼容与回滚口径，以及尚未覆盖的部分。

## 范围的边界

- **没有**修改数据库 schema（仍是 26；`src/db/` 全程零改动），**没有**修改云同步协议版本、实体集合或既有写入语义。
- **没有**部署生产 Firebase 规则，**没有**访问真实账号或真实数据，**没有**安装或覆盖任何 APK/EXE。
- 备份包与仓库新增的校验字段都是**可选**的：旧备份包、旧云快照、旧仓库仍按各自既有路径处理。
- 破坏性用例一律以"关键表快照、ledger/cursor、restore intent、知识库 backup generations 的前后值"验证"失败无副作用"，不停留在"抛了异常"。

## 阶段实施

### 阶段 1：云恢复快照完整性与严格全量校验

原来一个解析器同时服务于两种语义完全不同的输入：**增量拉取**（容错合并是对的，坏文档跳过即可，ledger/cursor 不会声称收到没到达的数据）与**破坏性全量替换**（一条缺失、重复或畸形的文档就意味着集合不可证明，绝不能落到本地库、ledger 或 cursor）。加固把第二种语义独立出来。

- 新增 `src/services/cloudSnapshotIntegrity.ts`（纯函数、同步，不依赖模拟器即可测）：
  - `classifyCloudRecoverySnapshot` 把恢复点判为 `complete` / `writing` / `legacy-unverified` / `unverifiable`；只有前两者可按严格规则恢复。`writing` 是写入方自己声明未完成；`unverifiable`（缺少或为零的条目数）一律不提供恢复。
  - `assertStrictCloudSnapshot`：逐条严格解析、拒绝重复 id、校验类型与身份一致（文档 id 必须等于 `entityType:entityId`，`key` 不一致即拒绝）、载荷非空且身份自洽、tombstone 不得携带矛盾的存活载荷，最后比对**声明条目数与实际读取数**。任何一条不成立即整体拒绝，**没有"过滤后继续"模式**。
  - `assertStrictRemoteDataset`：针对"以云端活动集合（而非单一快照）为输入"的破坏性替换，验证每个成员都是良构且身份唯一的协议实体。
  - `CLOUD_SNAPSHOT_ENTITY_TYPES_EXHAUSTIVE`：覆盖 `CloudSyncEntityType` 全集的**编译期证明**——给联合类型加成员却忘了加进运行时清单会直接编译失败，而不是静默拒收真实快照。
- `cloudSyncService.ts`：新增 `parseRemoteEntitiesStrict` / `parseRemoteReviewEventsStrict`，并把 `strict` 标志贯穿 `getRemoteChanges`、`getTargetedRemoteDocuments`、`getAllRemoteDocuments`、`getAllRemote`、`buildFullRemoteDataset`。增量合并路径保持容错，破坏性替换路径走严格校验。
- 新增 `src/services/cloudSnapshotIntegrity.test.ts`（17 项）。

### 阶段 2：云端资源字节校验与恢复提交一致性

内容寻址本身**不是**证明：`assets/<hash>` 可能返回另一个对象、被截断的对象，或由旧版/故障客户端写坏的对象。因此下载后的字节在进入快照前必须重新哈希比对。

- 新增 `src/services/assetIntegrity.ts`，作为"这批字节就是声明所承诺的对象"的**唯一定义**，供云下载、ZIP 归档、文件夹仓库共用：
  - `assetByteFailure` 区分四类失败：声明哈希不是本客户端可复现的格式（`unsupported-hash`，硬失败，而不是"无法校验就放行"）、哈希不符（`hash`）、哈希相符但声明的字节数/类型与字节矛盾（`size` / `mime`）。唯一的刻意例外：字节一致、而声明的 MIME 恰是上传兜底值 `application/octet-stream`（该值含义是"未知类型"），此时传输层报出真实类型不算矛盾。
  - `SHA256_HEX_PATTERN` 固定 `hashBlob` 的输出形状（小写 SHA-256 十六进制）。实体层的 `contentHashAlgorithm`／`contentHashVersion` 描述的是**实体载荷**的哈希方式，与 blob 地址无关，**刻意不参与** blob 校验——旧资源文档在这两个字段上合法地是 `fnv1a`，而 `payload.contentHash` 仍是 `hashBlob` 结果；把该字段当作 blob 哈希格式会误拒有效旧数据。
  - `describeAssetByteFailure` 让错误带上**具体是哪个资源**，而不是类级别文案。
- `assertDownloadedAssetVerified`：下载的 Storage 对象在进入快照前重新哈希；失败时明确告知"本机数据、同步游标与云同步记录均未改变"。
- 恢复提交一致性：资源暂存失败时保留本机数据并清除已暂存资源（`storageAdapter.restore.test.ts` 覆盖）。

### 阶段 3：完整 ZIP 的生成、读取与替换保护

四条归档通道（Web ZIP、Android 流式、Android 自动备份 ZIP、Desktop/Android 仓库）在生成前**和**读取时都做逐资源字节声明与校验。

- `backup.ts`：
  - `assetChecksumsFor` 为每个资源产出 `{ id, hash, size }`，写入 `payload.assetChecksums`——**位于 v7 容器校验和覆盖范围内**，因此每个被打包资源的字节都被容器校验和间接覆盖。
  - `archiveAssetDeclarations`、`requireArchiveEntry`、`assertArchiveAssetBytes`、`requireAssetBytes`，以及 `BackupArchiveIntegrityError`（用户可见的可操作文案）。
  - `ImportSummary.unverifiedAssets`：导入旧备份包（写于逐资源校验之前）时如实报告"多少个资源只能按文件存在性导入、无法比对字节内容"，并在界面上提示"需要完整校验请重新导出一份新备份"。**不把旧包当作坏包拒收**，也不假装已校验。
- `nativeAutoBackupStreamService.ts`：资源字节缺失时**拒绝打包**（不写 manifest、不产 ZIP），并声明每个已打包资源的真实字节。
- `nativeRepositoryBackupService.ts`：见阶段 4。
- `streamingBackupService.ts`：接入同一份 `assetIntegrity` 判定，不再各自实现比较规则。
- **仅被草稿引用的资源**：`storageAdapter.assertSnapshotIntegrity` 现在同时覆盖新布局（`payload.recordDrafts`）与旧字段（`snapshot.recordDrafts`），用 `it.each` 两条用例证明——归档缺了这类资源同样在动任何表之前就拒绝。

### 阶段 4：自动备份目的地写入、last-known-good 与状态语义

**接线现状（纠正了方案的风险前提）**：`autoBackupAdapter.writeLatest` 是唯一生产入口；Android 与 Desktop 都走**增量代际仓库**（`writeNativeRepositoryBackup`），Web 走 File System Access 的 `createWritable()`。方案点名的"Android latest 直接截断"路径（`beginZipLatest`／`writeNativeLatestBackup`／`writeNativeAutoBackupStream*`）在全仓库内**除测试外无任何调用方 = 死代码**，因此产品层面 Android 并不存在"截断掉唯一有效备份"的问题。

- **Web 回读校验**：`createWritable()` 只保证"崩溃安全"（swap file），不等于"写对了"。原先 `getFile()` 之后直接报成功，`size: 0` 也算成功。现在要求 `zip.size > 0 && file.size === zip.size`，否则抛"自动备份写入后核对失败"，结果标记 `destination-readback`。
- **仓库写入回读与 manifest 晋升分离**：`readBackSnapshot()` 在写 manifest **之前**重新读取快照、解析、验 v7 容器、验声明清单。任何不符即不写 manifest ⇒ **上一份已验证快照仍是 latest 且仍可恢复**。成功结果标记 `archive-verified`。
- **`lastBackupVerifiedAt` 不再伪造**：原实现是 `timestampToISO(result.verifiedAt) ?? nowISO()`——适配器什么都没验证也会盖上"刚刚验证"的时间戳。现改为不伪造，并新增 `AutoBackupVerification`（`archive-verified` / `destination-readback` / `destination-visible`）与 `lastBackupVerification`。
- **状态语义**（`AutoBackupPanel.tsx`）：绑定文件夹、启用开关、完成一次写入、通过归档校验是**四件不同的事**，把它们压成一个"已备份"正是让用户在"只授予了权限"时误以为已有备份的原因。界面新增"备份校验"行，按实际强度显示"已回读校验归档结构 / 已核对写入字节数 / 仅确认文件存在"；从未成功写入显示"尚无成功备份"，写入过但无验证证据显示"未验证"。
- **修掉阶段 3 自身引入的静默陈旧缺陷**：原增量逻辑"文件大小相同就跳过改写"并从上一份快照**沿用**声明。若资源内容变了而字节数不变，就会既不改写、又沿用旧 hash ⇒ 新旧快照指向同一份**旧字节**，而校验却能通过 ⇒ **静默恢复出陈旧图片**。改为**内容寻址代际路径** `assets/<id>-<完整sha256>-<fileName>`：
  - 内容不变 ⇒ 同路径 ⇒ 仍然跳过写入（增量性保留）；
  - 内容变了 ⇒ 新路径 ⇒ 旧快照所引用的字节完整无损；
  - 本地字节已不可读 ⇒ 回退到"上一份已验证副本"（该文件与该声明当初是一起验证过的，因此是配对复用而非重新拼凑）；连副本都没有则 fail-fast，并给出精确原因。
  - 代价：每次备份需读取全部资源字节以计算哈希（原先只读变化项）。这与 Web/ZIP 路径的 `assetChecksumsFor` 行为一致，属正确性换 I/O。
- 新增 `src/services/autoBackupAdapter.web.test.ts`（4 项：回读通过、字节数不符被拒、空文件被拒、仅绑定未写入的语义）。

### 阶段 5：知识库备份并发与恢复边界

- `runtime.ts`：从 `liveQuery` 中抽出纯异步函数 `isKnowledgeBackupPending(owner)`，dirty 判定改为比较**捕获时的 `capturedGenerations`** 与**当前库集合 + dirtyGeneration**。
- 新增并发回归（`knowledgeLibrary/autoBackup.test.ts`，P5-T1–T4）：
  - 冻结读取之后、写盘期间新增库 B ⇒ 本轮不能把 B 标为已备份，**B 必须留待下一轮**；
  - 捕获之后某库内容变化 ⇒ 仍 pending；
  - 回执写入失败 ⇒ scope 不变，重试可成功（不会"失败了还当成功"）；
  - 写入期间 owner 变化 ⇒ 该轮完成被拒绝（stale token 不能确认新范围）。
- `acknowledgeKnowledgeBackup` 的守卫（ownerScope、destinationId、consented 三者任一变化即拒绝）现已被上述用例覆盖。
- **普通云端恢复不得清空知识库表**：`storageAdapter.restore.test.ts` 新增回归，并给 fake `Db` 补上 `knowledgeLibraries`／`knowledgeSyncState`／`knowledgeBackupScopes` 三张表。
- **文案**：`BackupPage.tsx` 在"完整备份"下说明——普通日志与图片、录音、附件是**设备本地**集合、不按账号分区；其中知识库属账号维度，恢复时**不覆盖也不连接**现有库，而是为当前身份创建**独立副本**（detached），副本保持离线、需要时可在云同步设置里单独选择是否上传。`CloudSyncPanel.tsx` 同步同一口径。

## 回归矩阵对应

| 场景 | 承接用例 |
|---|---|
| 云恢复快照第 N 批写入失败/超时 | 快照状态 `writing` 即不可恢复；仓库回读失败不晋升 manifest（R4-02/R4-03） |
| 完整云恢复含格式错误记录/事件 | `assertStrictCloudSnapshot` 整体拒绝；`parseRemoteEntitiesStrict`／`parseRemoteReviewEventsStrict` |
| Storage 返回错误内容但对象读取成功 | `assetByteFailure` 的 `hash`/`size`/`mime`/`unsupported-hash` 四类 |
| 写本地后、ledger 提交前崩溃 | 恢复事务与 ledger/cursor 提交顺序（既有用例 + 阶段 2 回归） |
| ZIP 缺资源/中途不可读/哈希不符（含仅草稿引用） | ZIP-02 / ZIP-03 / ZIP-06、S3-02、AB-01、R3-03、R3-04、草稿专有引用 `it.each` |
| 自动备份写一半、封口失败或强杀 | R4-02（旧 latest 仍可恢复）、W2/W3（写入核对） |
| 仅绑定权限、未执行写入 | `AutoBackupPanel.test.tsx`（显示"尚无成功备份"，不显示"最近备份成功"） |
| 知识库备份中新增 B/删除 A/切换 owner | P5-T1–T4 |
| 普通云端恢复 vs 完整 ZIP 恢复 | `storageAdapter.restore.test.ts`（普通恢复不动知识库表） |
| 老版本 ZIP、旧快照及新客户端 | `unverifiedAssets` 如实计数；`legacy-unverified` 需通过同一套严格校验；`assetIntegrity` 不误拒旧 `fnv1a` 实体 |

## 验证结果

| 命令 | 结果 |
|---|---|
| 全部被改动测试文件 | **12 文件 / 147 用例通过**，0 失败（原记录"14 个文件"与同行"13 文件/164 用例"自相矛盾；2026-09-23 二次复查在干净工作区实测为 12/147，见 `output/p0-p1-remediation-2026-09-23/baseline/04-targeted12.log`） |
| `npm test`（有界全量） | **口径需标注**：含 5 个 `*.live.test.ts` 时 239 文件 / 1894 用例；排除 live 时 234 文件 / 1889 用例 = **1888 通过 / 1 失败**（`05-full.log`，失败为下述并发超时，单跑通过）。原记录的 3 条 aliyun 跨 realm Blob 失败在干净工作区两种 mode 下均未复现（8/8 通过，`02-single-aliyun.log`），该现象按环境敏感噪声处理 |
| `npx tsc -b` | 通过，无输出 |
| `npm run build` | 退出码 0，`✓ built in 17.82s`，4963 模块 |
| `npm run test:firebase` | **2 文件 / 6 用例通过**，退出码 0 |

全量套件中 4 条失败**均不在本次改动范围内**，两个文件本次均未被修改（`git status --porcelain` 为空）：（下为当时原始记录；2026-09-23 干净工作区复测仅剩第 2 类并发超时 1 条，单跑通过；第 1 类未复现，见上表）

1. `src/services/aliyunTtsProvider.test.ts` ×3，`expected 13 to be 3`。跨 realm Blob 问题：用外部 realm 的 `Response` 打桩时，`Response.blob()` 不满足本 realm 的 `instanceof Blob`，`new Blob([blob])` 退化为字符串化（`"[object Blob]"`，13 字节）。一次性探针实测：`response.blob().size = 3`、`instanceof globalThis.Blob = false`、`new Blob([blob]).size = 13`、`new Blob([Uint8Array]).size = 3`。只有用外部 realm `Response` 打桩的测试才会命中，属既有测试环境问题，与本次改动无关。
2. `src/services/cloudSyncService.integration.test.ts` ×1，`Test timed out in 5000ms`（`reconciles the committed part of a failed multi-batch publish…`）。**单跑通过**（22/22，该用例约 1.6s），属项目已知的全量并发下偶发超时。

`npm run test:firebase` 输出中的 `PERMISSION_DENIED` 是 `assertFails` 负路径用例的预期证据（验证越权访问被规则拒绝），不是失败。

## 兼容与回滚

- **格式兼容**：备份包新增的 `payload.assetChecksums` 是可选字段，且被 v7 容器校验和覆盖；旧包导入时按"只能按文件存在性导入"如实计数并提示，不拒收。旧云快照按 `legacy-unverified` 处理，恢复前须通过同一套严格校验，**不会因为"是老格式"而跳过完整性校验**。
- **无 schema 变更** ⇒ 无需数据迁移，也不存在新增的 intent/staging 隐形状态需要用户手工清表。
- **回滚**：本次改动集中在服务层与少量 UI 文案，未触碰 `src/db/`、未改云协议版本。若需回退，直接回退这些文件即可；已产生的旧格式快照/备份包/仓库**不被自动清理**，回退后仍可读取。
- 新旧客户端共存：新客户端能识别旧数据；写出的新字段对旧客户端是未知字段，旧客户端忽略它不会破坏写入（`assetChecksums` 需要读起来不报错）。

## 未覆盖与待决策

1. **Android `beginZipLatest` 死代码**（`NativeAutoBackupPlugin.java`）：仍是"截断写 + 仅可见性校验"。本轮**未改动**——沙箱内无法编译或运行 Android，改 Java 等于引入未验证风险。建议在"删除该死链路"与"真正接线时按临时代际写入 → 封口 → 回读验证 → 晋升 实现（需真机验收）"之间二选一。
2. **真实 host 门禁未运行，需单独授权**：
   - Desktop：实际临时目录、写入中断/重启、repository 快照与 manifest 保留；
   - Android SAF：至少一个系统文件 provider（首次/重新绑定、latest 写入中断、应用强杀、空间不足、文件被外部同步服务占用或改名、恢复上一份已验证归档）——窄屏浏览器**不能**替代 Android host；
   - Web：下载/恢复，以及浏览器权限撤销与站点数据限制。
3. **真实账号 / 双设备**：需先取得授权、使用可销毁合成数据、记录两端 build 与哈希。生产 Firebase 规则如需变更须另行批准。

## 限制

- 上述自动化与模拟器结果**不代表**生产规则已部署、真实账号已通过、或任何设备已安装新版本。
- 阶段 6 的 host 验收与用户验收脚本（第 10 节）**尚未执行**，因此本链路状态为"待最终用户验收"。
- 构建保留了既有的分块体积警告，未做拆包优化。

## 附：P0/P1 二次复查与修复（2026-09-23 当夜，方案 `docs/cloud-sync-backup-restore-p0-p1-remediation-plan-2026-09-23.md`）

依据 `docs/audit/cloud-sync-backup-restore-final-buglist-and-remediation-2026-09-23.md` 裁定的 B-01/B-02/B-03 已完成修复并按阶段门禁 G0–G5 留档（`output/p0-p1-remediation-2026-09-23/`）：

| ID | 修复 | 判别性证据 |
| :-- | :-- | :-- |
| **B-01（P0）** | `firstEmptyDevice` 首同步与 `restoreRemote` 均改为 `getAllRemote(…, true)` + `assertStrictRemoteDataset`，破坏性全量替换的四条入口与 cloud-wins/快照恢复共用同一 strict 规则；任何拒绝先于本地写、ledger 行与 cursor 移动 | `cloudSyncFirstEmptyDevice.test.ts` 3 用例；回退后负向①以 `{kind:'synced'}` 静默放行、负向②抛非 `CloudSnapshotIntegrityError`（`G2/G3-discriminative-revert.log` 系列） |
| **B-02（P1）** | `assertKnowledgeOwner` 前置于 `completeKnowledgeBackup`，纯 owner 切换（不重绑目的地）不再把回执提交到旧 owner 的 scope 行 | `P5-T4b`；回退后失败签名 `expected { 'a-only': 1 } to deeply equal {}`（`G3-discriminative-revert.log`）；`P5-T5` 补齐 capture 后删库分支 |
| **B-03（P1）** | 本报告与 `AGENTS.md` 的 strict 全称宣告、测试数字口径、死代码披露（`nativeAutoBackupStreamService.ts` 整链 + Java `beginZipLatest`）已按实测更正 | 修复后同 commit 复测：定向 13 文件 / 152 用例全绿；有界全量（排除 live）235 文件 / 1894 用例 = 1893 通过 / 1 失败（既有并发超时，单跑 22/22 通过）；`tsc -b`、`npm run build`、`git diff --check`、Firebase Emulator 6/6 全绿（`G5-final-chain.log`） |

**B-14 顺带清理**：`cloudSyncWhitebox.test.ts` EOF 空行（`git diff --check` 现为 0）、`nativeRepositoryBackupService.test.ts:330` 永真断言改为真实的"第二轮不重写任何 assets/ 文件"断言、`autoBackupAdapter.web.test.ts` W4 增加"仅绑定目的地不得触发 `writeLatest`"断言。

**B-04 书面豁免（本轮记录在案）**：Emulator 维持 6/6 未新增用例。理由：strict 拒绝（B-01）是**客户端解析防线**，不依赖 Firestore 规则，已由真实 Dexie/fake-indexeddb + 受控 in-memory transport 的判别性用例覆盖；"子批失败不留可列恢复点"已有 `cloudSyncService.integration.test.ts` 的多批发布对账用例覆盖。真机 Emulator 增益限于规则回归，与本轮修复面无交叠。后续若改 `firestore.rules` 需连同该语义补 Emulator 用例。

**剩余 P2（B-05…B-13 中未随本轮关闭者）与发布门禁**（真机双端首同步、老数据 strict 过拒性、Desktop/Android/Web host 验收、用户验收）逐项列于最终 Bug 清单 §2，未因本轮修复而视为完成。
