# 云同步、备份与恢复链路加固开发方案（2026-09-23）

## 1. 目的与交付

本方案把当前云同步、云恢复快照、完整备份/恢复、自动备份以及知识库加入后的数据边界，拆成可独立实施、逐阶段验收的工程任务。接手的 AI coding agent 应先按本方案补回归测试、再按阶段实现；每一阶段都要报告变更、测试证据、未覆盖项和是否需要用户/设备授权。最终由用户依据第 10 节验收，不以“测试绿了”代替端到端验收。

本文是基于当前仓库的实施计划，不是修复完成证明。此前云同步修复与知识库审查/整改文档仍是既有历史和证据，不在本任务中改写或复述为新发现：

- `docs/cloud-sync-convergence-fixes-2026-09-21.md`
- `docs/cloud-sync-content-boundary-fixes-2026-09-21.md`
- `docs/audit/cloud-sync-whitebox-remediation-2026-09-21.md`
- `docs/knowledge-library-review-2026-09-23.md`
- `docs/knowledge-library-three-reports-recheck-and-p0-p1-plan-2026-09-23.md`
- `docs/knowledge-library-p0-p1-remediation-2026-09-23.md`

实施前先确认代码/分支是否已包含以上知识库 P0/P1 remediation；不要按旧审查报告的“实施前状态”重复修复，也不要覆盖工作区已有的未跟踪报告或 `output/` 目录。

## 2. 范围和不可破坏的边界

### 本轮范围

1. 普通云同步增量与全量读取、冲突选择云端/本机、云恢复快照的完整性和中断一致性。
2. ZIP 完整备份（手动、流式、自动备份）的生成、导入校验与恢复前保护。
3. Web、Android、Desktop 自动备份的写入/验证/状态表达及目的地切换。
4. 知识库加入完整备份之后的 owner scope、并发新增/删除、目的地授权和 detached restore 回归。
5. 用户可理解的恢复覆盖范围、风险确认、恢复结果和失败诊断。

### 不在范围 / 不得顺手改变

- 普通日志仍是设备本机集合，不改成账号分区；普通云同步协议仍不含知识库。
- 知识库仍走隔离的知识同步协议。完整备份包含**当前身份 owner scope 下的全部本机知识库**；知识库导入/恢复为 detached copy，不把备份恢复悄悄绑定到云端库。
- 不改变 Firestore 知识库协议、命令/组冲突语义、学习事实、复习投影、AI/隐私边界或现有账号隔离规则。
- 不删除历史云快照/旧备份、不自动“修复”未知数据、不在校验失败时降级成空数据恢复。
- 不以放宽 Firebase rules、吞掉异常、覆盖冲突、静默跳过记录/资源或提高超时掩盖完整性问题。
- 不升级数据库 schema，除非实施阶段证明无法避免并先提出独立迁移理由、旧库升级矩阵和回滚方案；本方案没有预先授权 schema 变更。
- 不部署生产规则、不访问/覆盖真实用户数据、不安装 APK/EXE、不调用付费服务，除非用户另行明确授权。

## 3. 已确认的现状与风险等级

定级表示现有实现可观察到的缺口及潜在影响，不代表已有用户数据损坏或已经复现生产事故。

| 级别 | 观察到的现状 | 工程含义 |
|---|---|---|
| P1：应先关闭 | `makeRemoteSnapshot` 先创建可见父文档，再分批写子文档；失败时可能留下部分快照。`listCloudRecoverySnapshots` 会列出父文档，`restoreCloudRecoverySnapshot` 读取子项但不比较父文档 `entityCount`；结构不合格的实体/复习事件会被共享的 tolerant parser 过滤。 | 某次快照写入部分成功/远端文档损坏时，恢复入口无法证明数据集完整，可能把部分集合当成全量数据写入本机。先加完成性证明及仅用于破坏性全量恢复的 strict 校验。 |
| P1：应先关闭 | 云 Storage 资源按 `payload.contentHash` 读取，但 `downloadRemoteAssets` 没有对返回 Blob 的字节重算 hash；之后物化快照只确认对应 Blob 存在。 | 路径存在不等于下载内容与声明内容相同；下载损坏/错对象可能进入恢复。需在写本地库之前验证，校验失败不得改本地数据或 ledger。 |
| P1：备份可用性 | `writeNativeStreamableBackupSnapshot` 在 `getAsset(id)` 返回空时 `continue`，仍可能完成 ZIP；`zipToSnapshot` 对缺失 ZIP 资源也会跳过。后者在 `restoreSnapshotData` 的引用完整性断言处通常会拒绝恢复，但错误发现太晚；导出的不完整 ZIP 仍可能被报告为成功。 | 生成端必须 fail-closed；导入端必须在确认覆盖/写数据库之前给出资源缺失/损坏错误。已有 `assertSnapshotIntegrity` 是最后防线，不要移除或弱化。 |
| P1：完整性缺口 | 完整备份恢复的 `assertSnapshotIntegrity` 检查 record 和 template 资源引用，但不检查 draft 中的资源引用；ZIP 解析跳过缺失资源时，若资源只被草稿引用，可能进入数据库并留下损坏草稿。 | 把草稿引用纳入恢复前完整性断言，并覆盖“仅草稿引用缺失资源”的回归；不能只测正文记录和模板。 |
| P1：平台写入保护 | Android `beginZipLatest` 对 latest 文件直接以截断写模式打开，归档结束后检查目录可见性/大小，但不回读验证 ZIP。进程中断时存在覆盖上一份 latest 的风险；当前检查证明目的地可见，不证明 ZIP 可恢复。 | 保留 last-known-good；写入、封口、完整性验证、晋升 latest 应有明确状态。SAF provider 的原子重命名能力因 provider 而异，不得假定全平台都支持。 |
| P2：一致性硬化 | 云恢复的本地快照写入和 `resetAndPersistLedgers` 是两个本地事务。恢复成功后若进程在两者之间退出，数据已换成本次云快照但 ledger/cursor 还旧。 | 未证明会造成永久数据丢失；增加崩溃注入并设计原子提交或可恢复意图，避免重启后误判/重复发布。 |
| P2：边界与范围表达 | 普通云恢复恢复的是普通云同步实体，不包括知识库；自动备份目的地绑定、自动备份开关、一次写入成功、目的地观察到文件、归档可读/可恢复是不同状态。 | 文案和状态要准确区分；不把“已绑定”说成“已备份”，也不把 Web/Android 绑定后没有立即上传定成产品缺陷。 |

### 有意保持的既有正确行为

- `bindAutoBackupFolder` 轮换目的地授权，不等于已完成备份。Desktop 绑定流程会开启并立即 flush；Web/Android 绑定只授予权限并提示用户随后开启/手动同步，这是明确的平台 UX 差异。本方案只要求状态清楚、实际写入可验证，不强制所有平台绑定后立即上传。
- 知识库备份通过 `freezeKnowledgeBackup` 捕获范围与普通快照；写入成功后才 `completeKnowledgeBackup`。`acknowledgeKnowledgeBackup` 会根据 membership generation 处理删除库。必须增加“捕获 A -> 写入期间新增 B -> 完成 A 后 B 仍待备份”的时序回归；不要重复报告“删除库必然永久 dirty”。
- 完整 ZIP 恢复已经有 `assertSnapshotIntegrity`、knowledge envelope 校验、Review Coach 关系校验，以及流式资源暂存完再事务替换的保护。修复应扩展保护而不是另造一条绕开这些 guard 的路径。
- Desktop repository 的快照数据先写、manifest 后更新，并保留旧索引的保护。先保留并回归这一设计，不为统一实现而回退成原位覆盖。

## 4. 实施原则和工作协议

1. 先检查 `git status`、分支、schema 版本及上述历史文档的实际状态；保留用户已有未提交文件。每阶段只改本阶段范围。
2. 每个缺口先新增能在旧实现上失败的确定性测试（或明确记录该性质只能通过 host/device acceptance 验证），再做最小实现。不要只测 helper 而漏掉调用恢复入口。
3. 全量破坏性恢复和增量同步采用不同验证策略：增量 pull 的兼容旧数据 tolerant merge 可继续保留；全量替换本地库必须先 strict validate 全部输入，再开始任何本地替换。
4. 任何数据完整性失败都应在本地库、cloud cursor、ledger、Knowledge backup acknowledgment 均未前进的状态下结束。验证步骤应先于 `restoreSnapshotData`/流式替换/ledger reset。
5. 为新 ZIP 完整性元数据和云快照状态引入兼容规则：老版本完整备份仍可按原版本规则导入；新格式验证失败不得静默回退到旧入口。旧云快照只有在可依据其历史 `entityCount` 证明完整、且所有内容严格校验通过时才可恢复；无法证明的显示为不可恢复/需另选来源，不猜测其完整。
6. 写测试时用独立 Dexie DB/远端桩注入确定性的时序与第 N 批失败。Emulator、单进程双库测试、真实双端/真机测试分别报告，不互相冒充。
7. 使用当前仓库既有格式、错误呈现方式和测试命令。异常经现有 UI 时仍遵守 `src/lib/uiError.ts` 规范。每阶段结束给出变更文件、测试命令/结果、剩余风险和下一阶段。

## 5. 分阶段实施

### 阶段 0：基线盘点与失败测试

**目标**：冻结实施前行为和数据契约，不先改业务逻辑。

**检查位置**：

- `src/services/cloudSyncService.ts`：`makeRemoteSnapshot`、`listCloudRecoverySnapshots`、`restoreCloudRecoverySnapshot`、`restoreRemote`、`parseAndNormalizeRemoteEntities`、`downloadRemoteAssets`、`resetAndPersistLedgers`。
- `src/services/cloudSyncModel.ts`：`hashBlob`、`materializeCloudSyncSnapshot`、资产 entity/hash 生成。
- `src/services/backup.ts`、`src/services/streamingBackupService.ts`、`src/services/nativeRepositoryBackupService.ts`、`src/services/autoBackupService.ts`。
- `src/services/storageAdapter.ts`：`assertSnapshotIntegrity`、`restoreSnapshotData`、`restoreStreamableSnapshot`、`createSnapshot`、`createStreamableSnapshot`。
- `src/features/knowledgeLibrary/autoBackup.ts`、`scope.ts`、`schema.ts`、`src/components/AutoBackupPanel.tsx`、`src/components/CloudSyncPanel.tsx`。

**先加/整理回归**：使用现有 `cloudSyncWhitebox.test.ts`、`cloudSyncService.integration.test.ts`、`backup.test.ts`、`streamingBackupService.test.ts`、`nativeRepositoryBackupService.test.ts`、`nativeAutoBackupStreamService.test.ts`、`autoBackupService.test.ts`、`autoBackup.test.ts`、`CloudSyncPanel.test.tsx`、`AutoBackupPanel.test.tsx`。新增测试需落在实际维护相应行为的套件中。

**门禁**：记录当前通过/失败的定向测试；确认测试在旧实现上能稳定暴露阶段 1–5 的目标缺口。只做测试/基线记录，不借机改协议或生产行为。

### 阶段 1：云恢复快照完整性与严格全量校验（P1）

**目标**：任何不完整、无法验证、含畸形数据的云集合都不能清空/替换本地库。

**实现要求**：

1. 兼容旧客户端的首选方案是先写快照子文档，所有批次成功后再创建包含 `complete` 状态、预期数量与 revision 的父文档，把父文档作为可见提交标记；这样旧客户端也不会列出半成品父文档。若必须先写父文档，必须证明旧客户端无法发现/恢复 `writing` 快照，否则方案不合格。批量写失败留下的孤儿子文档不可恢复，且不自动清理；父文档写入结果未知时重读并核实所有子项后再决定是否显示为可恢复。
2. 恢复入口不得只依赖“子集合非空”。核实实际子文档总数与父文档预期数量相符；确保 entity/review-event 身份、类型、必要字段、revision、ID 唯一性和 payload 校验完整。任何一项异常整份拒绝。
3. `restoreCloudRecoverySnapshot` 和冲突操作中真正执行全量覆盖的分支在本地写入前使用 strict validator。共享增量 pull 可继续 tolerant，但不能复用其“过滤后成功”的结果做 destructive restore。
4. 对旧云快照设计保守兼容：无新状态字段的旧快照只能在历史预期数量可核验、数量相等且 strict 校验全通过时恢复；缺少可靠数量或不匹配时标为不可验证，UI 给出可操作错误。不要自动删掉不完整快照。
5. 列表/API/UI 对 `writing`、`complete`、legacy-unverified 的呈现要明确；若不显示未完成项目，应保留诊断/后续人工清理入口。确认当前每用户 Firestore 文档规则允许该用户访问这些字段，不放宽到其他用户或新增知识库权限。

**主要代码/测试**：`src/services/cloudSyncService.ts`、`src/components/CloudSyncPanel.tsx`、`src/services/cloudSyncWhitebox.test.ts`、`src/services/cloudSyncService.integration.test.ts`、`src/components/CloudSyncPanel.test.tsx`。如新增 validator，可放相邻模块并纯函数测试。

**必须通过的断言**：第 2 批失败后恢复列表不能提供可恢复操作；人为少/多一个实体、缺失 review event、非法实体类型/载荷、重复 ID 或坏 revision 均在任何本地数据/ledger 变化之前拒绝；计数一致且严格有效的旧快照可恢复；完整新快照成功可恢复；超时未知可重试且不会误把半成品当完整版本。

### 阶段 2：云端资源字节校验与恢复提交一致性（P1 + P2）

**目标**：云对象按地址找到后仍验证内容；恢复数据与 ledger/cursor 在崩溃后保持可判定的一致状态。

**实现要求**：

1. 在 `downloadRemoteAssets` 下载后、放入供物化快照使用的 `assetBlobs` 前重算 `hashBlob`，与实体声明的内容哈希比较。处理旧哈希版本时严格按已有版本算法/迁移规则显式分支；不能将不认识的 hash 视为通过。
2. 在验证失败、缺 Blob 或 hash 不符时，本地资产/记录/知识库、cloud ledger、cursor 都保持原值。增量收到资源校验失败也不能先落其他更新再以成功游标确认。
3. 为云端全量恢复及恢复快照评估本地恢复与 `resetAndPersistLedgers` 分开的崩溃窗。优先把“应用快照 + ledger/cursor 完成状态”纳入同一可原子提交边界；若 Dexie 事务和恢复后投影重建不能安全合并，则实现持久、幂等、可重启协调的 restore intent/operation 状态，并先于下一次同步恢复到明确前/后态。
4. 不更改云端同步 revision、实体 hash 格式或 knowledge sync protocol。若确需协议字段，必须提供旧/新客户端兼容矩阵和 Firestore Emulator 覆盖。

**主要代码/测试**：`src/services/cloudSyncService.ts`、`src/services/cloudSyncModel.ts`、`src/services/storageAdapter.ts`、`src/services/cloudSyncWhitebox.test.ts`、`src/services/cloudSyncService.integration.test.ts`、`src/services/cloudSyncService.timeout.test.ts`。

**必须通过的断言**：正确 blob 成功；同路径错误字节、截断字节、错误 MIME/size 或不支持的哈希声明按合同拒绝；失败时本机快照与 ledger/cursor 逐字段不变；在“本地替换后、ledger 写入前”注入进程重启，重启后能幂等完成或安全回滚，后续同步不将整个数据集误发布/误删除；旧 hash 兼容用真实旧 fixture 覆盖。

### 阶段 3：完整 ZIP 的生成、读取与替换保护（P1）

**目标**：不生成/报告成功一份缺资源或无法恢复的归档，并在恢复写库前把错误完整暴露。

**实现要求**：

1. `writeNativeStreamableBackupSnapshot` 中 `getAsset(meta.id)` 缺失必须 fail-fast 并 cancel session，不能 `continue` 后 finish。其他 ZIP writer 也逐项确认 snapshot metadata 与实际写入条目一一对应。
2. `zipToSnapshot` 对声明存在但归档缺失/无法读取的资源应返回带文件/资源身份的校验错误，不继续构造可被误认为完整的 `StorageSnapshot`。恢复 UI 必须在 destructive transaction 前完成解析和校验。
3. 为新完整备份的每个资产字节建立可校验的完整性声明（进入被校验的版本化 payload/container checksum 范围）。如需改变 payload schema，沿现有版本迁移方式增加明确版本并更新导入兼容；不要静默改变历史版本含义。旧备份继续按历史能力导入，并明确其无法核验的部分，不要伪造 hash。
4. 继续在 `restoreSnapshotData`/`restoreStreamableSnapshot` 保留 `assertSnapshotIntegrity`、knowledge envelope 和 Review Coach 校验。流式导入仍须先完成全部资源读取/字节校验和 staging，再进入替换事务；失败清理临时 staging，不触碰正式库。
5. 完整性检查还必须覆盖 draft 内容中的资源引用，包括 `recordDrafts` 与兼容旧字段 `snapshot.recordDrafts`；至少有一条“资源只被草稿引用、归档缺资源”的回归。继续保持 podcast 资源有意排除及 record/template/draft 引用 reconcile 的既有产品规则；不能把“明确排除”误报为 dangling，也不要在此改变内容边界。

**主要代码/测试**：`src/services/backup.ts`、`src/services/streamingBackupService.ts`、`src/services/nativeRepositoryBackupService.ts`、`src/services/storageAdapter.ts`、`src/features/knowledgeLibrary/backupContainer.ts`、`src/services/backup.test.ts`、`src/services/streamingBackupService.test.ts`、`src/services/nativeRepositoryBackupService.test.ts`、`src/services/nativeAutoBackupStreamService.test.ts`、`src/services/recordDraftBackup.test.ts`。

**必须通过的断言**：生成中任一资源缺失/损坏不产生成功结果；旧有有效 ZIP 可正常导入；损坏/缺条目新 ZIP 在数据库事务开始前失败；失败不改任何正式表；多个资产中后部损坏时前面 staging 全清理；新格式 manifest/checksum 与 data 和资产字节不一致时必拒绝；Web/Android/Native stream/Desktop repository 各路径都不能有“清单写了但 ZIP 没有”的通过用例。

### 阶段 4：自动备份目的地写入、last-known-good 与状态语义（P1/P2）

**目标**：绑定、启用、写入、目的地验证、归档验证分别可观察；中断不能静默毁掉最后一份有效备份。

**实现要求**：

1. 建立状态/文案合同，至少区分：目的地已绑定（permission/grant）、自动备份开关已开、最近一次写入结束、目的地已观察到文件及元信息、归档结构/校验已通过。若平台当前只做到其中一部分，就只展示实际做到的部分；`lastBackupVerifiedAt` 的含义必须准确。
2. 不改变现有平台交互承诺：Desktop 绑定后立即执行首次 flush；Web/Android 绑定后提示需要开启/立即同步。可以增强提示和诊断，不得强制绑定动作自动上传。
3. Android latest 不得直接截断唯一有效备份后才验证。使用 provider 能支持的临时/新代际写入、封口、重新打开验证、完成后晋升 latest 的策略；无法原子 rename 时采用保留旧代际+安全 manifest/pointer 或等价恢复策略。写入/rename/验证中断后至少保留上一份已验证归档。验证不只是文件可见/size>0。
4. Web、Android 和 Desktop 分别沿现有 adapter 实现与测试。Desktop repository 应保留“snapshot data 成功后才更新 manifest/索引”的 last-known-good 顺序；不要为了复用抽象改变其隔离目录、代际或保留策略。
5. 目的地重新绑定仍须按现有 knowledge backup consent/scope 规则重新确认；已知 A->B->A 过期回调保护不能回归。

**主要代码/测试**：`src/services/autoBackupService.ts`、`src/services/autoBackupAdapter.ts`、`src/services/nativeBackupAdapter.ts`、`src/services/nativeRepositoryBackupService.ts`、`src/services/nativeAutoBackup.ts`、`src/components/AutoBackupPanel.tsx`、`android/app/src/main/java/com/noteproject/study408/NativeAutoBackupPlugin.java`、`src/services/autoBackupService.test.ts`、`src/services/autoBackupAdapter.test.ts`、`src/services/nativeAutoBackup.desktop.test.ts`、`src/services/nativeAutoBackupStreamService.test.ts`、`src/services/nativeRepositoryBackupService.test.ts`、`src/components/AutoBackupPanel.test.tsx`。

**必须通过的断言**：在开始写入、写到一半、ZIP finish、回读验证、晋升 latest、manifest 更新每一边界注入失败；原先已验证版本始终可列出并恢复；只有完全校验成功的文件可更新“最近成功/已验证”状态；目的地仅绑定但未写入不显示成已有备份；绑定后 Web/Android 不立即上传符合原交互；Desktop 绑定首次 flush 成功/失败都给出准确状态；重新绑定目的地后旧目的地授权不能确认新目的地备份。

### 阶段 5：知识库备份并发与恢复边界验收（P1 回归 + UX）

**目标**：云同步与完整备份不会互相越界；备份捕获期间的库成员变化不会被错误确认成已备份。

**实现/回归要求**：

1. 对 `freezeKnowledgeBackup`、`captureKnowledgeBackupScope`、`completeKnowledgeBackup`、`acknowledgeKnowledgeBackup` 增加确定性时序测试：capture A -> 写入阻塞 -> 新建 B/写入 B -> complete A -> B generation 仍 dirty，下一轮归档包含 B 后才被确认。
2. 覆盖 capture 后删除 A、membership generation 改变、改绑目的地、owner 切换、写失败、验证失败、完成回执失败重试。检查 token 与 scope epoch；不能让旧回调确认新身份/新目的地范围。
3. 完整备份多库范围仍是当前 owner 的全部本机知识库；不能丢掉 detached/local libraries，也不能把其他账号库带入。空知识库 envelope 的恢复继续创建 detached empty copy，不清空既有库。验证库的内容在新身份 detached restore 下可读，且不会意外连云。
4. `CloudSyncPanel` 的云数据“以云端为准”提示明确说明该普通云恢复不包含知识库；完整备份恢复页说明普通日志设备本地范围和知识库 detached copy 语义。普通云恢复不得误清知识库表；完整 ZIP restore 才依据当前备份契约处理知识库。
5. 自动备份状态提示不把绑定当备份完成，也不将 Web/Android 延后/手动 flush 定义成缺陷。确认日志不含密钥、敏感正文或无必要路径信息。

**主要代码/测试**：`src/features/knowledgeLibrary/autoBackup.ts`、`scope.ts`、`backup.ts`、`syncService.ts`（只做边界核对，非计划重写协议）、`src/services/autoBackupService.ts`、`src/components/CloudSyncPanel.tsx`、`src/pages/BackupPage.tsx`、`src/features/knowledgeLibrary/autoBackup.test.ts`、`src/features/knowledgeLibrary/scope.test.ts`、`src/components/CloudSyncPanel.test.tsx`、`src/components/AutoBackupPanel.test.tsx`。

**必须通过的断言**：上述并发用例及已有 P0/P1 remediation 回归全部通过；普通云恢复不改变知识库实体/registry；完整备份只携当前 owner 所有库；detached restore 不覆盖/连接现有库；Web/Android bind 不触发隐式上传但 UI 指令可完成下一步。

### 阶段 6：跨链路回归、真实环境门禁与用户验收包

**目标**：证明阶段之间组合后无新的状态分叉，并将自动化/部署/真机/用户验收清晰分开。

**执行顺序**：

1. 每个阶段先跑其列出的定向测试；全部合并后有界 worker 串行跑非 live Vitest、TypeScript、production build。不要把大构建并发导致的超时当产品回归；按项目已知的测试环境规则复跑并记录。
2. 跑 Firebase Emulator：覆盖快照完成标记、批次失败、strict restore、旧/新快照兼容、权限不越界、操作结果未知重试。Emulator 通过不代表生产 rules 已部署或真实账号通过。
3. Desktop host 验收实际临时目录、写入中断/重启、repository 快照和 manifest 保留。
4. Android SAF 物理设备验收至少一个系统文件 provider，并在允许时覆盖第二类 provider：首次绑定/重新绑定、latest 写入中断、应用强杀、存储空间不足、文件被外部同步服务占用/改名、恢复上一份已验证归档。不得用窄屏浏览器替代 Android host。
5. Web 验收下载/恢复和浏览器权限撤销/站点数据限制；用户数据变更前使用合成资料或单独授权的副本。
6. 真实账号/两台独立设备测试须先获用户授权、用可销毁合成数据、记录两端 build/hash 并分别验证云同步和知识库同步边界；不对正式数据做破坏性覆盖。生产规则如需变更须另经批准。

## 6. 必备回归矩阵

| 场景 | 必须观察的结果 |
|---|---|
| 云恢复快照第 N 批写入失败/超时 | 未完成快照不可恢复；之前的完整快照仍在；重试不会误判完成 |
| 完整云恢复含一条格式错误记录/事件 | 整体拒绝且本地数据、ledger、cursor 不变，不可“过滤后成功” |
| Storage 返回错误内容但对象读取成功 | hash 校验前不得应用；本地与游标不变；用户看到可操作错误 |
| 云数据写本地后、ledger 提交前崩溃 | 重启后协调至明确前/后态；下一轮不会重复全量覆盖或产生反向 tombstone |
| ZIP 缺资源/资源中途不可读/哈希不符（含仅草稿引用资源） | 导出或导入失败；不报成功、不启动 destructive restore、不残留 staging |
| 自动备份写一半、封口失败或应用强杀 | last-known-good 仍可恢复；状态不更新成最新成功 |
| 仅绑定权限、未执行写入 | UI 只显示已绑定；不显示“最近备份成功” |
| 知识库备份中新增 B/删除 A/切换 owner | stale token 不能确认新范围；仍 dirty 的库留待下次备份 |
| 普通云端恢复 vs 完整 ZIP 恢复 | 前者不动知识库；后者只恢复备份携带的当前 owner 知识库为 detached copies |
| 老版本 ZIP、旧快照及新客户端 | 兼容路径明确、保守；不降级忽略新格式 checksum/完整性失败 |

所有破坏性用例都应通过记录关键表快照/hash、ledger/cursor、restore intent、知识库 backup generations 的前后值验证“失败无副作用”，不能只断言抛出了异常。

## 7. 数据兼容、恢复与回滚

- 只新增可选云快照状态字段时，新客户端必须能识别旧数据；旧客户端忽略未知字段不应破坏写入。新客户端对旧快照按阶段 1 的严格 legacy 规则处理。
- 新 ZIP payload/container schema 必须保留至少一个真实的旧版本 fixture；确认旧备份可导入，新版本 hash 错误不会被当旧版绕过。若需要 schema 号升级，单独列出升级和回滚，不重写用户原始 ZIP。
- 不覆盖或自动清理老快照/老备份；Android 晋升新 latest 前保留 last-known-good，Desktop 保留现有 generation/manifest 机制。
- 对意外的格式/校验拒绝提供“保留原数据并导出诊断”的路径；不提供忽略校验继续覆盖的按钮，除非单独形成有风险确认的产品决策。
- 数据库恢复的任何新增 intent/staging 状态必须有重启清理/续做策略和 quota/事务失败测试，不能成为需用户手动清表的隐形状态。

## 8. 测试命令与报告格式

先检查 `package.json` 的当前 script 名称和测试参数，再按项目实际脚本运行；参考现有文档的已用命令：

```text
npm run test -- <定向测试文件>
npm run test -- --exclude "**/*.live.test.ts" --maxWorkers=4 --minWorkers=1
npx tsc -b
npm run build
npm run test:firebase
```

如果脚本参数格式在当前分支不同，以脚本配置为准并记录实际命令。依次测试、避免大型任务并行导致资源争抢。每阶段报告：

```text
阶段 / commit 或工作区基线：
代码变更：
新增或修复的回归：
实际测试命令与通过数：
失败/跳过/未覆盖：
数据库/云协议/备份格式变更：
是否访问真实数据、部署或安装：否（如有授权则逐项说明）
下一阶段阻塞与用户决策：
```

## 9. 完成定义

只有以下项目逐项有证据才可报告“开发阶段完成”：

1. 阶段 1–5 的自动化断言通过，既有相关云同步、备份、知识库 P0/P1 回归无退化。
2. 失败注入证明校验失败/中断不会清库、确认未验证备份、推进 cursor/ledger 或错误确认知识库 scope。
3. 旧/新云快照与 ZIP 的兼容矩阵明确，Firestore rules 没有越权变化；若修改规则，部署状态单独记录。
4. TypeScript、生产 build、有界全量测试、Firebase Emulator 结果分别报告。
5. Desktop/Android/Web 各自的实际 host gate 明确标为通过、未运行或需授权，不能合并成一个“全平台通过”。
6. 用户收到最终验收清单和任何风险/限制，并明确确认结果。用户确认之前标记为“待最终用户验收”。

## 10. 最终用户验收脚本

全部先用合成资料；若涉及真实账号或真实设备，先备份两端并取得用户明确授权。

1. **基线与边界**：设备 A 建立日志 L1、本地知识库 K1；设备 B 有不同日志 L2/知识库 K2。确认普通云同步只按已有普通云协议同步内容，知识库单独按知识同步协议处理；完整备份范围/目的地/当前账号提示准确。
2. **完整备份 round-trip**：创建至少两个当前 owner 知识库（含 detached/local 库）和日志附件/模板附件；执行 Web ZIP、Android 流式/SAF、Desktop repository 自动备份中适用的路径。恢复到隔离的空测试 profile，核对日志正文、草稿、标签、附件、知识库数量和条目、恢复为 detached copy，且未混入其他 owner 的库。
3. **不完整/篡改保护**：在副本上移除一个附件、篡改一个资产字节、删改 manifest/checksum；尝试导入。每次必须在写库前报错，原 profile 数据不变，错误指明资源/校验范围。
4. **云恢复保护**：用测试云快照构造完整快照并恢复；再注入不完整 batch/畸形实体/损坏资源，确认不完整版本不提供“以云端为准”或“恢复”成功结果，且本地数据、ledger/cursor 和知识库均保持基线。
5. **自动备份中断与状态**：确认绑定后不自动误报已备份；按各平台既定 UX 执行首次备份。备份成功后模拟第二次中断/强杀，仍能从上一份 last-known-good 恢复；UI 显示绑定/启用/最近写入/验证状态各自真实。
6. **并发知识库成员变化**：自动备份读取冻结后、写盘期间新增库 B，再完成该轮；确认 B 仍显示待备份，第二轮备份后才清 dirty。另测试账号切换/改目的地时旧任务不会确认新 scope。
7. **验收记录**：记录平台、OS/provider、应用 build/version/hash、数据是否合成、每步结果及恢复文件标识；自动化、Emulator、真实设备、生产部署、用户最终接受分栏填写。

## 11. 方案实施限制

本方案只授权编写方案和后续在本仓库内按阶段做本地开发/自动化验证；不授权生产 Firebase 规则部署、真实账号破坏性操作、发布、安装或覆盖用户现有 APK/EXE。开始某项真实设备/账号验收前单独取得用户同意。

