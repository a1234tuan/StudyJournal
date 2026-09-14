# 当前 APP 云同步与备份数据边界审查报告

- 审查日期：2026-09-13
- 审查性质：**只读审查**。未修改同步逻辑、未改 schema、未改云端 API、未改冲突算法、未改 UI。
- 代码基线：Dexie schema 21（`src/db/reviewCoachSchema.ts`），云同步协议 `PROTOCOL_VERSION = 2`（`src/services/cloudSyncService.ts:72`）。
- 方法：从 Dexie store 定义、快照导出/恢复路径、云同步实体映射表、冲突判定与解决分支四条链路逐项追踪，不依赖 UI 呈现。

---

## 0. 一句话结论

**云同步与云备份是两套完全不同的机制，参与范围差异很大；新增功能整体守住了边界（语音复述、批注、AI 问答、播客、密钥都没有进云同步），但存在 4 个真实的数据丢失/覆盖风险点，其中 1 个是「本地恢复旧备份后再同步会删掉云端较新数据」。**

---

## 1. 当前数据实体清单（区分「真持久化」与「运行时/缓存」）

### 1.1 真正持久化（Dexie 表）

**A. 参与云同步的实体（26 类实体 + 1 类追加事件）**
`src/types.ts:816-842` + `src/services/cloudSyncModel.ts:322-367`

| 分类 | 实体 |
| --- | --- |
| 日志 | `entry`（日期条目）、`block`（日志/正文块，含 `RecordBlock.contentHtml`）、`draft`（本机草稿 `recordDrafts`） |
| 组织 | `tag`（标签）、`template`（模板）、`study-session`（学习会话） |
| 复习 | `review-state`（`recordReviews`，FSRS 状态）、`review-day-stat`（`recordReviewDayStats`）、`review-event`（`recordReviewLogs`，追加式） |
| 资源 | `asset`（图片/音频/附件，**排除 `generatedBy === "knowledge-podcast"`**） |
| 设置 | `settings`（脱敏后） |
| AI 驾驶舱 / Review Coach 正式事实 | `decision-block`、`decision-block-archive`、`decision-block-feedback`、`feedback-interpretation`、`analysis-queue-item`、`analysis-batch`、`session-blueprint`、`adaptive-review-task`、`adaptive-quiz-turn`、`task-outcome-event`、`delayed-verification`、`ai-role-config` |
| 遗留知识点（已确认事实，只读） | `legacy-learning-evidence`、`legacy-knowledge-point`、`legacy-record-kp-link`、`legacy-knowledge-relation` |

**B. 本地持久化但完全不参与云同步**

| 实体 | 说明 | 依据 |
| --- | --- | --- |
| `aiSessions` / `aiMessages` / `aiAttachments` | AI 问答历史、消息、附件（含 Blob） | 不在 `exportCloudSync` 映射中 |
| `aiSecrets` | API Key / SecretId / SecretKey（LLM、TTS、ASR 共用此表） | 同上 |
| `knowledgePodcasts` | 知识播客行（脚本、自定义 prompt、TTS 配置） | 同上；音频资产也被 `asset` 过滤排除 |
| `reviewAnnotationDrafts` | 复习批注草稿（schema 20） | `AGENTS.md` 明示；代码确认未进同步 |
| `voiceRecallSessions` / `voiceRecallTurns` / `voiceRecallLocalHistory` | 语音复述会话/轮次/本地历史（schema 21） | `src/db/reviewCoachSchema.ts:89-91` |
| `autoBackupState` | 自动备份开关、绑定文件夹、上次结果 | 未进同步 |
| `cloudSyncState` / `cloudSyncLedger` / `cloudSyncOperations` / `cloudSyncMutation` | 同步游标、账本、操作日志、本机写入纪元 | 同步元数据本体 |
| `coachMigrationBackups` | schema 17 迁移检查点 | 未进同步 |
| `decisionBlockStates` / `interventionEffectSummaries` | **投影**，可由正式事实重建 | 不在实体枚举中（`AGENTS.md` 明确规定） |
| `restoreStagingAssets` | 导入过程中的事务暂存 | 瞬态 |
| `mistakes` / `reviews` | 旧错题卡表，实际始终为空，仅保留兼容 | `createSnapshot` 恒导出 `mistakes: []`、`reviews: []` |

### 1.2 运行时 / 非持久化（不进 DB，更不进同步）

- 视觉主题：`localStorage["study-journal-visual-theme-v1"]`（`src/lib/visualTheme.ts:3`）
- 语音复述语速、首次披露标记：`study-journal.voice-recall.*`（localStorage）
- 评分撤销历史：`src/features/reviewSession/runtime.ts`（App 级内存，不序列化）
- Tab/导航记忆、云同步按钮状态、冲突弹窗状态：内存
- 搜索索引：`src/lib/search.ts` 内存计算，无持久化表
- `?preview=*` 预览数据：仅本地开发

### 1.3 判断结论

- 真正的「学习成果」持久化数据 = 日志 + 正文 + 标签 + 模板 + 会话 + FSRS 三表 + 资源 + AI 驾驶舱正式事实 + 遗留知识点。
- **AI 问答历史、语音复述历史、批注草稿、播客、各类密钥**都是「本地持久化但不同步」——这是设计选择，不是遗漏（见 §4）。

---

## 2. 云同步 ≠ 云备份：两套机制明细

### 2.1 云同步到底同步什么

**机制**：Firebase Firestore 增量同步（`users/{uid}/entities` + `users/{uid}/reviewEvents` + Storage 存放超大 payload 与资源），由**用户手动点击云同步按钮**触发（`src/components/CloudSyncButton.tsx:21-83`），没有后台自动同步。

| 数据 | 本地保存 | 云同步 | 原因 |
| --- | --- | --- | --- |
| 日志 / 正文 `blocks` | ✅ | ✅ 实体级（含 `deletedAt` 墓碑） | 核心学习成果 |
| 日期条目 `entries` | ✅ | ✅ 实体级 | 核心 |
| 标签 `tags` | ✅ | ✅ 实体级（含软删除） | 核心 |
| 模板 `templates` | ✅ | ✅ **字段级三方合并**（仅 `title`/`contentHtml`） | 可独立编辑的小实体 |
| 本机草稿 `recordDrafts` | ✅ | ✅ 实体级 | ⚠️ 见 §7.7（草稿跨设备） |
| 学习会话 `studySessions` | ✅ | ✅ 实体级 | 统计来源 |
| 资源 `assets`（非播客） | ✅ | ✅ 实体 + Storage 内容寻址 | 正文引用 |
| FSRS 状态 `recordReviews` | ✅ | ✅ 实体级，但**不进冲突检测**（`NON_CONFLICTING_ENTITY_TYPES`） | 可由事件重建 |
| 复习日志 `recordReviewLogs` | ✅ | ✅ **追加式事件，只增不删** | 收敛真源 |
| 每日复习统计 `recordReviewDayStats` | ✅ | ✅ 实体级，**不进冲突检测** | 可由事件重建 |
| AI 驾驶舱正式事实（decision block / feedback / blueprint / task / turn / outcome / verification / aiRoleConfig） | ✅ | ✅ 实体级 + 墓碑 | Stage 8 明确要求 |
| 遗留知识点三类 + learning evidence | ✅ | ✅ 实体级 | 已确认事实 |
| 设置 `settings` | ✅ | ✅ **字段级三方合并**；`ai` / `tts` / `knowledgePodcastModeTemplates` / `lastBackupAt` / `syncFolderName` **被剥离** | 便携字段同步、设备专属字段留在本机 |
| AI 问答历史 `aiSessions/aiMessages/aiAttachments` | ✅ | ❌ | 设备本地对话缓存 |
| 密钥 `aiSecrets` | ✅ | ❌ | 安全红线 |
| 播客行 + 播客音频 `knowledgePodcasts` | ✅ | ❌ | AI 派生内容 + 大音频，不做跨端 |
| 批注草稿 `reviewAnnotationDrafts` | ✅ | ❌ | 半成品批注，不污染云端 |
| 语音复述三表 | ✅ | ❌ | 本地练习媒介 |
| 自动备份状态 `autoBackupState` | ✅ | ❌ | 设备专属路径 |
| 同步元数据四表 | ✅ | ❌ | 每设备独立 |
| 投影 `decisionBlockStates` / `interventionEffectSummaries` | ✅ | ❌ | 可重建 |
| `mistakes` / `reviews` | 空表 | ❌ | 遗留 |

**关键边界实现**（`src/services/exportPrivacy.ts`）：
- `stripPrivateExportFields` 递归删除 `apikey / authorization / prompt / providerresponse / rawresponse / responsebody / secret / systemprompt` 这些 key；
- `sanitizeSettingsForExport` 额外摘掉 `lastBackupAt / syncFolderName / knowledgePodcastModeTemplates / ai / tts`；
- `preserveLocalSettings` 在收到远端设置后，用本机值回填这些设备专属字段。

### 2.2 云备份到底备份什么

本项目**没有「云端完整备份」这一概念**。实际有 4 条备份/救援通道：

| # | 通道 | 内容 | 位置 | 保留 |
| --- | --- | --- | --- | --- |
| 1 | 手动完整 ZIP 导出（`snapshotToZip`） | 全量快照（见下表），含资源二进制；**不含**播客音频 | 用户自选（下载/系统分享） | 用户自行管理 |
| 2 | 原生流式 ZIP（Android/Desktop 大库） | 同上，流式写入避免内存峰值 | 用户自选 | 同上 |
| 3 | 自动备份到本机文件夹（`autoBackupAdapter` + `nativeRepositoryBackupService`） | zip-latest 或 `folder-repository-v1`，**保留 5 份快照** | Desktop：文件系统访问 API 选目录；Android：SAF 目录 | 5 |
| 4 | 云端恢复快照（`makeRemoteSnapshot`，Firestore 文档） | 冲突解决**前**自动生成的实体 + 事件副本（大数据走 Storage） | `users/{uid}/snapshots` | **3**（`SNAPSHOT_LIMIT`，`cloudSyncService.ts:77`） |

**进入 ZIP / 原生备份的内容**：`entries`、`blocks`（含正文与 decision block 内容）、`templates`、`recordDrafts`、`tags`、`studySessions`、`settings`（脱敏）、`assets`（排除播客音频）、`recordReviews`、`recordReviewLogs`、`recordReviewDayStats`、`reviewCoach` 正式快照、`podcasts`（**行会进，音频不会**）。

**不进入任何备份的内容**（除云端恢复快照只含同步实体外）：
`aiSessions` / `aiMessages` / `aiAttachments`、`aiSecrets`、`reviewAnnotationDrafts`、`voiceRecall*`、`autoBackupState`、`cloudSync*`、`coachMigrationBackups`、`decisionBlockStates` / `interventionEffectSummaries`（投影）。

**⚠️ 必须说清楚的一点：同步 ≠ 备份。**
- 云端只有「当前数据集」，没有历史版本；
- 唯一的云端历史 = 3 份恢复快照，且只在**冲突解决**时创建 —— 普通同步的删除/覆盖不会自动留恢复点；
- 设备本机的自动备份（通道 3）是**每台设备独立**的，Desktop 的自动备份不会自动出现在 Android 上，除非该文件夹本身被 OneDrive/iCloud 等工具同步。

---

## 3. 数据生命周期图

```
                         ┌────────────── 云同步（手动触发，增量，revision 单调递增）──────────────┐
本地创建/编辑                                                                                  │
   │                                                                                          │
   ▼                                                                                          ▼
Dexie (schema 21)  ──createCloudSyncSnapshot──▶ exportCloudSync ──▶ 与 cloudSyncLedger 比对 ──▶ Firestore
   │  26 类实体                                        │                    │                  entities / reviewEvents
   │                                                  │                    │                  + Storage(大 payload / 资源)
   │  本地专属表（aiSessions / aiSecrets /             │             墓碑(tombstone)           │
   │   voiceRecall* / annotationDrafts /               │             for ledger 有、本地没有的 key │
   │   knowledgePodcasts / cloudSync* / autoBackupState）                     │                │
   │        │                                            │                │                  ▼
   │        │ 永不出本机                                  │                │              其它设备
   │        ▼                                            ▼                │           applyRemote → materialize
   │   仅参与通道 1/2 的部分内容                    拉取远端增量 ◀─────────┘                → restoreCloudSyncSnapshot
   │   （注意：podcasts 行会进 ZIP）                 mergeRemoteFieldChanges                （本地被整体替换）
   │                                                   │
   └──────────── 备份链路 ─────────────────────────────┘
        │
        ├─ 通道 1/2：手动 ZIP（含资源，不含播客音频）
        ├─ 通道 3：自动备份目录（本机，5 份）
        └─ 通道 4：云端恢复快照（仅冲突解决时创建，3 份）

恢复链路：
   ZIP / 文件夹备份 ──▶ restoreSnapshot → restoreSnapshotData（清空并整体替换，**不动 cloudSyncLedger**）
   云端          ──▶ restoreCloudSyncSnapshot → restoreSnapshotData（preservePodcasts + preserveLocalSettings）
```

---

## 4. 新增功能逐项检查（有没有偷偷突破边界）

### 4.1 AI 驾驶舱（Review Coach / 学习教练）

**结论：会同步，Desktop 与 Android 可共享，换设备不会丢。**

- 同步内容：decision block 索引、块反馈、反馈解读、分析队列/批次、SessionBlueprint、自适应任务、问答轮次、任务结局事件、延迟验证、AI 角色配置（providerId + model，**不含密钥**）。
- 冲突保护：decision block 有 `contentVersion` 与 `deletedAt`；当「正文内容冲突」导致选择云端版本时，`withDecisionBlockConflictCopies` 会把本地版本归档进 `decisionBlockArchives`（`src/services/cloudSyncModel.ts:474-515`），即**决策块内容有内容级救援副本**。
- 投影（`decisionBlockStates`、`interventionEffectSummaries`）不同步，收到数据后由 `rebuildProjections()` 重建 —— 符合「投影必须可从正式事实重建」的约束。
- schema 19 已删除旧的 `learningCoachSnapshot/Tasks/AiRuns`、`knowledgePointExtractionRuns`、`knowledgePointCoachSnapshots` 运行时表，不再有「跑了一半的 AI 会话被同步」的问题。

### 4.2 AI 问答（AI 问答 / 知识库问答）

**结论：只在本地，不同步，换设备会丢（设计如此）。**

| 数据 | 是否同步 | 说明 |
| --- | --- | --- |
| 问答历史 `aiSessions` / `aiMessages` | ❌ | 设备本地 |
| 附件 `aiAttachments`（图 + OCR 文本） | ❌ | 设备本地，体积大 |
| 知识库选择状态 `AiChatSession.scope` / `scopeTitle` | ❌ | 随会话存本地 |
| 上下文包 `AiContextPack` / `memorySummary` / `lastContextHash` | ❌ | 本地缓存 |
| 消息中的模型用量、错误信息 | ❌ | 本地 |

⚠️ 唯一需要说明的风险：**AI 角色配置 `aiRoleConfigs` 会同步（providerId + model）**，但 `aiSecrets` 不同步。换设备后角色配置还在，但对应 provider 的密钥为空 → 表现为「配置在、跑不起来」，需要重新填 Key。这是可接受的，但会给用户造成困惑。

### 4.3 语音复述

**结论：全部本地，不同步、不进任何备份，是本轮审查中边界守得最干净的一块。**

| 数据 | 是否同步 | 是否进备份 |
| --- | --- | --- |
| `voiceRecallSessions` / `voiceRecallTurns` | ❌ | ❌ |
| `voiceRecallLocalHistory` | ❌ | ❌ |
| ASR/LLM/TTS 凭据（`aiSecrets` 的 `voice-asr-*` 槽位） | ❌ | ❌ |
| 服务商配置（`settings.ai` / `settings.tts` / `providerProfiles`） | ❌（被 `sanitizeSettingsForExport` 剥离） | ❌ |
| 语速、披露标记（localStorage） | ❌ | ❌ |
| 确认后创建的正式日志 | ✅（走正常记录创建路径） | ✅ |

补充证据：语音仓库写入完全不触碰 `cloudSyncMutation`（`src/features/voiceRecall/repository.ts` 无该表引用），因此不会误触发云变更记账。全量恢复（`restoreSnapshot`）会清空会话/轮次但保留本地历史（`clearLocalVoiceRecallTransient`），云同步恢复则三表全部保留（`src/services/storageAdapter.ts:2152-2162`）。

### 4.4 知识点 / Knowledge Point

**结论：知识点本体、父子关系、链接、AI 依据都会同步，但当前已是「遗留只读事实」，没有活跃的自动写入路径。**

| 数据 | 是否同步 | 备注 |
| --- | --- | --- |
| 知识点本体 `knowledgePoints`（= `legacy-knowledge-point`） | ✅ | schema 19 已把未确认的候选清理掉，只保留 `status === "active"` |
| 关联记录 `recordKnowledgePointLinks` | ✅ | 仅保留 `status === "active"` 且两端都存在 |
| 父子/关系 `knowledgeRelations` | ✅ | 仅保留 `status === "confirmed"` |
| AI 依据 `learningEvidence` | ✅ | 仅保留用户确认的 |
| 提取运行记录 `knowledgePointExtractionRuns` | 表已删除 | 不再存在 |

代码全文检索确认：`knowledgePoints.bulkPut` 只出现在 `src/features/reviewCoach/repository.ts:393`（恢复正式快照时），**没有任何 AI 流程在运行期自动写入知识点**。因此「AI 自动改知识点状态」当前不会发生。

### 4.5 批注（Review Annotation）

**结论：批注不进任何同步或备份链路，且不会把日志标脏。**

- 存储：`reviewAnnotationDrafts`，索引 `[recordId+reviewOccurrenceKey]` + `pendingClear`。
- 仓库写入只操作该表（`src/features/reviewAnnotations/repository.ts:18-45`），不引用 `cloudSyncMutation`、不写 `RecordBlock.contentHtml`。
- 后果（符合预期）：**换设备后批注一定丢**；评分成功后清草稿、撤销评分不会恢复批注。
- 批注画在只读复习编辑器之上，因此不会制造正文冲突。

### 4.6 FSRS / 间隔复习

**结论：状态表会同步但被排除在冲突检测外，真实收敛靠「追加式复习日志 + 本地重建投影」，整体是可用的；但双设备离线各评同一张卡会产生两条记录且没有冲突提示。**

| 字段/数据 | 是否同步 | 说明 |
| --- | --- | --- |
| `recordReviews`（status / nextReviewDate / lastReviewDate / stability 等） | ✅ | 实体级，**不参与冲突检测**，同一 key 直接被远端覆盖 |
| `recordReviewLogs`（评分日志，含 `stateAfter` 快照） | ✅ | **追加式事件，永不删除、永不覆盖**（`mergeReviewEvents` 只做 byId 合并） |
| `recordReviewDayStats` | ✅ | 实体级，同样不参与冲突检测 |
| 投影重建 | 本地 | 每次恢复后 `rebuildReviewProjectionFromEvents()` 用合并后的日志重算 `recordReviews` 与 `recordReviewDayStats`（`src/services/storageAdapter.ts:541-603`） |

**为什么这不算最高的风险**：`recordReviewLogs` 是追加式真源，且每条日志携带 `stateAfter`，恢复时本地会用**合并后的完整日志集**重算状态表。所以即使 `review-state` 实体被远端静默覆盖，重算也会把它拉回日志推导的结果。

**仍然存在的真实问题**：
1. 两台设备离线各评同一张卡 → 两条日志都会被保留 → 状态取「`reviewedAt:updatedAt` 较晚」的那条，**没有任何冲突提示**；而两次评分各自的 FSRS 间隔是基于各自不同的旧状态计算的，间隔可能出现不符合用户预期的取值。
2. 本地 `compactOldReviewLogs` 会在启动时删除 90 天前的本地日志（`storageAdapter.ts:598-603`），但云端事件永不压缩 → 云端 `reviewEvents` 无上限增长（这是已知未完成项，见 §14-D）。

### 4.7 其他新增（2026-09-09 ~ 09-12 的编辑器/引导类改动）

编辑器 chrome、代码语言选择器、使用指南章节等均为纯 UI/CSS/静态资源，作用域限定在 `.record-editor-page` 与 `public/guide/`，**不触碰持久化与同步语义**。使用指南只是静态页面，没有引入任何新数据实体。

---

## 5. Desktop ↔ Android 合并能力

同步的核心实现是：**拉取远端增量 → 与本机实体按 key 合并 → 用合并后的结果整体替换本地 DB**（`applyRemote` → `restoreCloudSyncSnapshotIfUnchanged` → `restoreSnapshotData` 清表后 `bulkPut`）。所以「合并」不是逐字段合并，而是「key 集合取并集，同 key 冲突则按类型分流」。

| 数据 | 跨端可安全合并 | 说明 |
| --- | --- | --- |
| 日志/正文（不同 id） | ✅ | 各设备新增产生不同 id → 并集天然合并（Desktop 加日志 A + Android 加日志 B = A + B） |
| 复习日志（追加事件） | ✅ | 只增不改，天然并集 |
| 标签、模板（不同 id） | ✅ | 并集；⚠️ 同名标签有例外，见 §6.5 |
| 学习会话、资源（不同 id） | ✅ | 并集 |
| 设置、模板字段 | ✅ | 唯一支持字段级三方合并的两类（需要账本里有 `basePayload`） |
| 遗留知识点、驾驶舱正式事实（不同 id） | ✅ | 并集；同一 id 冲突走实体级二选一 |
| **同一日志正文** | ⚠️ 只能二选一 | 实体级冲突 → 弹窗选择「本机为准 / 云端为准」 |
| **同一 reviewed 卡片的 FSRS** | ⚠️ 事后收敛 | 无冲突提示，靠事件并集 + 投影重建收敛 |
| AI 问答、语音复述、批注、播客、密钥 | ❌ 无法跨端 | 本地独有，换设备即丢 |
| 投影（blocks 状态、干预效果） | ❌ 不跨端 | 收到正式事实后本机重建 |

---

## 6. 冲突风险清单

### 6.1 同一日志同时修改正文 → **只能二选一，且有救援副本**

- 判定：`findConflictingChanges`（内容哈希不同）→ 返回 `kind: "conflict"`，UI 弹出选择（`cloudSyncService.ts:2521-2537`）。
- 解决：选「云端为准」→ 下载云端 + 把本地缺失的变更继续保留上传（`preserveLocalChangesForCloudWins`）；同时把本地版本上传成云端恢复快照「冲突前的本机版本」。
- 选「本机为准」→ 先用 `makeRemoteSnapshot("冲突前的云端版本")` 保存云端旧版，再用本机覆盖云端，并为云端独有的 key 写墓碑（`replaceCloudWithLocal`，`cloudSyncService.ts:2058-2061`）。
- **决策块内容**额外归档进 `decisionBlockArchives`；**决策块以外的正文没有内容级合并**，输掉的那一版只能从恢复快照里找回，而恢复快照只保留 3 份。

### 6.2 同一条日志：一边改正文、一边改 FSRS

- 属于**两个不同实体**（`block` vs `review-state`），互不覆盖：
  - `block` 内容变化走实体级（若对端未改正文则不冲突，正常合并）；
  - `review-state` 不进冲突检测，同 key 直接取远端；但恢复后本机 `rebuildReviewProjectionFromEvents` 会用合并后的日志重算。
- 结论：**不会互相覆盖正文**；FSRS 以日志推导为准。

### 6.3 同一知识点并发修改（父级/子级/状态/关联）

- 知识点、关系、链接都是独立实体，各有 `status` 与 `updatedAt`，没有跨实体不变量校验。
- 可能的**不一致**：A 设备把关系置为 `confirmed`、B 设备把其中一个知识点置为非 active → 恢复后可能出现「关系指向非 active 知识点」。目前 `validateReviewCoachFormalSnapshot` 只校验 decision block 与记录 id 的一致性，**不校验知识点关系两端状态**。
- 由于当前没有活跃的知识点写入路径，实际触发概率低。风险：低—中。

### 6.4 删除与修改同时发生 → tombstone + 冲突弹窗，不会静默

- 删除是软删除：记录写 `deletedAt`（`storageAdapter.ts:1429`），进回收站；实体以 `deleted: true` 上行。
- 清空回收站是物理删除（`storageAdapter.ts:1488` 附近，按 `deletedAt` 早于阈值清理）；物理删除后本地不再有该 key，`deriveLocalCloudChanges` 会依据账本生成墓碑（`cloudSyncService.ts:629-642`、`tombstoneFor:599`）→ 删除可传播。
- 若一边删除、一边编辑 → 哈希不同 → 判定为冲突 → 用户选择；不会出现「静默复活」。
- ⚠️ 例外见 §6.5 与 §14-D 第 2 条（账本与本地数据不一致时墓碑会反向生成）。

### 6.5 风险清单（按等级）

| 风险 | 等级 | 机制与后果 |
| --- | --- | --- |
| **本地恢复旧 ZIP 后再云同步 → 云端较新数据被删** | **极高** | 恢复路径（`restoreSnapshot`）**不重置 `cloudSyncLedger`**（`storageAdapter.ts:2065-2088` 的事务表列表里没有它）。恢复一个较小/较旧的备份后，账本仍记录着「曾经存在但现在本地没有」的 key → 下一次同步 `deriveLocalCloudChanges` 把它们全部生成为**墓碑并上传**，云端与其它设备上的较新数据被一并删除；且该路径**不创建恢复快照**，只能靠更早的备份。 |
| 同一日志正文在两台设备同时编辑 | 高 | 无字段级/CRDT 合并，必须二选一；输掉版本仅存在于云端恢复快照（**仅 3 份**），超出即被 GC，等于永久丢失。 |
| 云端恢复快照被顶掉 | 高 | 只有 3 份，冲突频繁时旧恢复点被淘汰；普通同步（非冲突）不产生恢复点，所以「被静默覆盖」的数据没有任何云端历史。 |
| 同名标签跨设备 | 中—高 | `tags` 有唯一索引 `&name`，但 id 是随机生成的（`upsertTag`，`storageAdapter.ts:1543` 起）。两台设备离线各自新建同名标签 → 云端出现两个同 name 实体 → 恢复时 `db.tags.bulkPut` 可能触发唯一索引冲突，导致**整次恢复失败**；同时 UI 上表现为重复标签。 |
| 日期条目 `entries` 跨设备重复 | 中 | `createDayEntry` 用随机 id（`src/db/defaults.ts:212`）。两台设备同一天各自新建条目 → 同一 `date` 出现两行，按 `date` 查询取「第一条」，另一条成为孤儿但仍持续同步。 |
| 双设备离线各评同一张卡 | 中 | 两条日志都保留、状态取较晚者，无提示；FSRS 间隔可能不符合预期。 |
| `review-state` / `review-day-stat` 静默远端覆盖 | 中 | 被排除在冲突检测外，同 key 直接取远端；但有日志重建兜底，故不列为高。 |
| 知识点关系与状态不一致 | 低—中 | 无跨实体不变量校验（当前无活跃写入路径）。 |
| 草稿 `recordDrafts` 跨设备 | 低—中 | 草稿是普通同步实体，编辑器可能把另一台设备的未保存草稿拉过来；草稿冲突也走实体级二选一。 |
| 云端复习事件无上限增长 | 低（成本） | 本地 90 天后压缩，云端永不压缩。 |

---

## 7. 有没有多个模块同时写入同一个持久化实体

这是本轮最值得关注的一类问题。逐实体核查结果：

### 7.1 `blocks`（日志正文）—— 有 2 类写入者，但已收敛到单一事务

- `src/services/storageAdapter.ts`：保存/删除/恢复/导入/日志互通（多条路径）；
- `src/features/reviewCoach/repository.ts:572-588`（`saveRecordWithDecisionBlocks`）：编辑器保存时**同一事务内**写 `blocks` + `decisionBlocks` 索引 + 清理草稿 + `bumpMutation()`。

结论：`contentHtml` 仍是唯一内容真源，`DecisionBlock` 只是索引，两者在同一事务内更新。**满足了「不允许出现第二个内容副本」的约束。**

### 7.2 `recordReviews` / `recordReviewDayStats` —— 多写者，但有重建兜底

- 写入者：复习评分流程（直接写状态）、`rebuildReviewProjectionFromEvents`（从日志重算）、恢复流程。
- 合并顺序：恢复时先 `migrateRecordReviewsToMixedSystem`，再 `rebuildReviewProjectionFromEvents`，所以**日志优先**，投影只做兜底。

### 7.3 `assets` —— 写入者多，但 OCR 运行时字段被显式隔离

- `stripAssetOperationalFields` 把 `ocrStatus/ocrError/ocrJobId/ocrUpdatedAt/ocrResultSummary` 从同步哈希中剔除，`preserveAssetOperationalFields` 在应用远端资源时保留本机队列状态（`cloudSyncModel.ts:192-220`）。
- 结论：**OCR 队列状态不会跨端互相踩**，但 OCR 文本本身会同步。

### 7.4 `cloudSyncMutation`（写入纪元）—— 只被「正式事实」写入者递增

- `storageAdapter.ts` 与 `reviewCoach/repository.ts` 共 26+ 处调用；
- **批注仓库、语音复述仓库完全不触碰它** —— 这两类本地写入不会误触发云变更记账，也不会让并发云端恢复被误判为冲突。这是边界守得好的证据。

### 7.5 结论

目前**没有发现两个模块在同一实体上做互不相识的自动写入**。真正的多写者风险集中在 §6.5 表格里的「跨设备同一实体」场景，而不是「同设备多模块」场景。

---

## 8. 同步粒度

**结论：记录级（实体级）+ 两处字段级例外 + 一类事件级。**

| 机制 | 适用范围 |
| --- | --- |
| **实体级（整行覆盖 / 冲突则二选一）** | 除下表之外的所有同步实体：`block`、`entry`、`tag`、`draft`、`study-session`、`asset`、全部驾驶舱实体、遗留知识点 |
| **字段级三方合并**（`mergeCloudSyncSmallEntity`，需账本有 `basePayload`） | 仅 `settings`（忽略 `updatedAt/lastBackupAt/syncFolderName`）与 `template`（只允许 `title`/`contentHtml`，其他字段被改动即视为冲突） |
| **事件级（只增不改，天然无冲突）** | `review-event`（`recordReviewLogs`） |
| **不参与冲突判定，直接取远端** | `review-state`、`review-day-stat`（随后由日志重建投影） |
| **无 merge 的兜底** | 账本缺少 `basePayload`（老账本/新设备）时，`settings`/`template` 退化回实体级 |

**是否足够支撑当前复杂度？**

- 「不同记录」的并发（最常见的多设备场景）完全够用：id 不同 → 纯并集。
- 「同一条记录」的并发不够：正文整体是一个实体，无法把「标题改了」和「正文段落改了」分开合并；两个用户同时编辑同一篇长日志必然有一方要从恢复快照里捞。
- 也**没有 CRDT / 版本向量 / 操作变换**，所以不存在自动化解同一行冲突的能力。
- 结论：粒度对「多设备各自记录」是足够的，对「多设备协作编辑同一篇日志」不足；考虑到产品定位是个人学习日志，这属于可接受的设计取舍，但**必须让恢复快照更可靠**（当前只有 3 份），否则「二选一」的代价过高。

---

## 9. 同步元数据

| 检查项 | 现状 |
| --- | --- |
| 全局单调 revision | ✅ 云端 `headRevision` + 每实体 `revision`，事务内分配（`acquireLock`，`cloudSyncService.ts:1300-1347`） |
| 每设备游标 | ✅ `cloudSyncState.lastPulledRevision` / `lastReviewEventRevision` |
| 设备 ID | ✅ `deviceId`（本地生成，随 `cloudSyncState` 保存） |
| 内容哈希 | ✅ SHA-256（`contentHashAlgorithm: "sha256"`），并保留 fnv1a 老哈希的兼容迁移路径 |
| 实体 ID | ✅ 均为字符串 id（`newId()` 生成，非自增） |
| `createdAt` / `updatedAt` | ✅ 每实体都有（`CoachBaseEntity` / `BaseEntity`） |
| **`updatedAt` 是否参与同步** | ✅ 会存，但**被排除在哈希之外**（`stripUpdatedAt`，`cloudSyncModel.ts:182-186`）→ 设计正确：单纯重复保存不会被误判为改动 |
| 墓碑 / 删除标记 | ✅ 实体级 `deleted: true`（`tombstoneFor`）+ 实体自带 `deletedAt`（记录、标签、决策块） |
| 冲突元数据 | ✅ 账本持久化 `basePayload`（供字段级三方合并）；云端有 `lock` + `lastLockRecovery` + 操作记录表 |
| 账本一致性 | ✅ 先推进 `headRevision` 再写本地账本，失败可自愈（`publish` 注释详细说明） |
| 事件压缩 | ❌ 云端无压缩、无事件墓碑（**已知未完成项**） |

**「只有 `updatedAt` 会不会后写覆盖前写？」**

- 判定冲突**不看 `updatedAt`**，看内容哈希，因此不会因为时间戳精度问题误判。
- 但**冲突发生后**的解决是「人工二选一」，不是自动比较时间戳 —— 这意味着**时钟偏差不会造成静默丢数据**（不会出现「谁的时钟快谁赢」）。这一点是安全的。
- 真正会静默覆盖的是被排除在冲突检测外的 `review-state` / `review-day-stat`，但它们有日志重建兜底。

---

## 10. 离线场景

**这是 Local-first 设计，离线修改不会丢；但「恢复网络后的合并」取决于是否改到同一条记录。**

| 场景 | 行为 |
| --- | --- |
| Desktop 离线修改 → 联网同步 | 离线写入同时递增 `cloudSyncMutation.epoch` 并被账本记录；联网后 `deriveLocalCloudChanges` 只上传与账本不同的实体（**增量**，不是整库上传）。 |
| Android 离线修改 → 联网同步 | 同上，路径完全对称。 |
| 两台设备长时间离线、改的是**不同记录** | 完全自动合并（key 并集），不需要人工介入。 |
| 两台设备长时间离线、改的是**同一条记录** | 联网后第二次同步会返回 `kind: "conflict"`，必须人工选择保留哪一侧；两侧各留一份「冲突前」恢复快照。 |
| 两台设备离线各评同一张卡 | 不报冲突；日志并集 + 投影重建，状态取较晚的一条。 |
| 同步过程中本机又被编辑 | `restoreCloudSyncSnapshotIfUnchanged(expectedEpoch)` 检测到纪元变化 → 抛 `CloudSyncLocalMutationError` → 中止，**不覆盖本地**。这是当前最有效的一条防覆盖护栏。 |

**「是否真正支持离线 → 修改 → 恢复网络 → 增量合并？」**

✅ 是真正的增量合并，不是「联网后整库上传」：
- 上传只看与账本的差异，未改动的实体不会产生写入（`no-op sync` 甚至会跳过云锁，`canSkipCloudSyncLock`）；
- 下载只看 `revision > lastPulledRevision` 的实体；
- 有守护式锁（30 分钟租约、5 分钟续约、心跳失联可安全接管）避免两台设备同时写坏云端。

⚠️ 唯一的例外就是 §6.5 的「本地恢复旧备份」路径 —— 那条路径按设计重置了本地数据但没重置账本，于是增量算法会把「本地少了」误读为「用户删除了」。

---

## 11. 删除操作

| 问题 | 结论 |
| --- | --- |
| Desktop 删除，Android 会知道吗？ | ✅ 会。软删除写 `deletedAt` → 实体 `deleted: true` 上行 → Android 拉取后记录进回收站。 |
| 物理删除（清空回收站）会传播吗？ | ✅ 会。本地 key 消失 → 依据 `cloudSyncLedger` 生成墓碑上传。 |
| Android 会不会把已删数据又传回来？ | ❌ 不会（正常路径）。墓碑会覆盖：`mergeCloudSyncEntities` 用远端墓碑替换本地同 key 实体。 |
| 有没有 tombstone？ | ✅ 有，两层：实体字段 `deletedAt`（软删除语义）+ `contentHash: "deleted:..."` / `payload: {}` / `deleted: true` 的墓碑实体（硬删除语义）。 |
| 删除数据会进备份吗？ | 软删除的记录**会**进 ZIP（带 `deletedAt`，恢复后仍在回收站）；硬删除的数据不进备份。已上传的墓碑保留在云端，不会因为本地清理而消失。 |
| ⚠️ 反向风险 | 若某台设备的**本地数据比账本少**（恢复旧备份、手动清表、从旧 ZIP 导入），增量算法会把这些 key 当成「被删除」→ **上传墓碑删除云端数据**。见 §6.5 第 1 条。 |

---

## 12. 备份 / 恢复后，到底能恢复什么

### 12.1 从 ZIP / 本机文件夹备份恢复（`restoreSnapshot`）

| 数据 | 能否恢复 | 备注 |
| --- | --- | --- |
| 日志 + 正文 + decision block 内容 | ✅ 完整 | |
| 标签、模板、日期条目 | ✅ 完整 | |
| 本机草稿 `recordDrafts` | ✅ 完整 | |
| 学习会话、资源（非播客音频） | ✅ 完整 | 缺失资源会留占位并提示 |
| FSRS 三表 | ✅ 完整 | 恢复后按日志重建投影 |
| AI 驾驶舱正式事实 | ✅ 完整 | |
| 遗留知识点 | ✅ 完整 | |
| 设置（便携字段） | ✅ | |
| **AI / TTS / ASR 密钥** | ❌ | 从不进备份 |
| **AI 问答历史** | ❌ | 从不进备份 |
| **语音复述历史** | ❌ | 从不进备份 |
| **批注草稿** | ❌ | 恢复时会被清空（`clearLocalAnnotationDrafts`） |
| **播客行** | ⚠️ 部分 | 行会随 ZIP 恢复；音频资产不进备份 → 恢复后需重新生成音频 |
| 视觉主题、语音语速等本机偏好 | ❌ | localStorage，不进备份 |
| 投影 | ❌ 但可重建 | 恢复后自动重建 |

### 12.2 设备损坏 → 重装 → 登录 → 云恢复（全新设备首次同步）

走 `firstEmptyDevice` 分支：先整库拉取云端，再对齐账本（`cloudSyncService.ts:2493-2514`），**不会把新设备的随机 bootstrap 数据（默认设置 + 内置标签）当作改动上传**（`isBootstrapOnlyCloudData` 保证）。

| 数据 | 能否恢复 |
| --- | --- |
| 日志、卡片、FSRS、知识点、AI 驾驶舱正式事实、标签、模板、会话 | ✅ 完整 |
| 设置（便携字段） | ✅ |
| AI 角色配置（providerId/model） | ✅ |
| **AI / TTS / ASR 密钥** | ❌ 必须重新填写 |
| **AI 问答历史** | ❌ 永久丢失 |
| **语音复述历史 / 会话** | ❌ 永久丢失 |
| **批注草稿** | ❌ 永久丢失 |
| **播客脚本与音频** | ❌ 不同步 → 永久丢失（音频本机资产也不在云端） |
| 视觉主题 | ❌（本机偏好） |

---

## 13. 敏感配置是否进入同步 / 备份

| 数据 | 存储位置 | 云同步 | 云备份/恢复快照 | ZIP/原生备份 | 结论 |
| --- | --- | --- | --- | --- | --- |
| LLM API Key | `aiSecrets` | ❌ | ❌ | ❌ | ✅ 安全 |
| TTS Key（Fish Audio 等） | `aiSecrets` | ❌ | ❌ | ❌ | ✅ 安全 |
| ASR Key（豆包 / 阿里云百炼，`voice-asr-*` 槽位） | `aiSecrets` | ❌ | ❌ | ❌ | ✅ 安全 |
| 腾讯云 SecretId + SecretKey（`apiKeySecondary`） | `aiSecrets` | ❌ | ❌ | ❌ | ✅ 安全 |
| LLM/TTS 服务商配置（`settings.ai` / `settings.tts`，含 baseUrl、model、voiceId、region） | `settings` | ❌ 被 `sanitizeSettingsForExport` 剥离 | ❌ | ❌ | ✅ 安全 |
| 备份目录路径 `syncFolderName` / `lastBackupAt` | `settings` | ❌ 剥离 | ❌ | ❌ | ✅ 安全 |
| 云端 AI 角色配置 `aiRoleConfigs`（providerId + model，无 Key） | 实体表 | ✅ | ✅ | ✅ | ✅ 无密钥，可接受 |
| 教练实体的 promptVersion / token 计数 | 实体表 | ✅ | ✅ | ✅ | ✅ 只有版本号与用量，无 prompt 正文 |
| 供应商原始响应 / systemPrompt | 实体表 | ✅ 存但被 `stripPrivateExportFields` 递归剥离 | ✅ 剥离 | ✅ 剥离 | ✅ 安全 |

**唯一需要人工确认的发现（不涉及密钥，但违反了文档表述）：**

播客行的 `customMode.prompt`、`creativeBrief`、`focusInstruction` 属于**用户自己撰写或 AI 生成的提示方向**，它们**不在云同步里**（✅ 正确），但**会进入 ZIP / 原生流式 / 文件夹备份的 `data.json`** —— 因为 `snapshotToZip` 与 `sanitizeStreamableSnapshotForExport` 都只对 `reviewCoach` 和 `settings` 做隐私剥离，没有对 `podcasts` 做。`AGENTS.md` 的表述是「knowledge-podcast rows/audio outside cloud and portable exports」，与实现存在偏差。

- 严重度：低（是用户自己的内容、不含 Key、不含第三方数据）；
- 但性质属于「文档与实现不一致」，建议在本轮之后要么补剥离、要么修文档。

---

## 14. 同步边界地图

### A. 数据分类

| 分类 | 数据 |
| --- | --- |
| **本地独有** | 视觉主题、语音语速/披露标记、评分撤销历史、Tab 记忆、云同步按钮与弹窗状态、搜索索引 |
| **可同步（不进备份）** | — （所有同步实体都同时进 ZIP 备份） |
| **可备份（不同步）** | 播客行（ZIP 有、云端无）、本机自动备份目录与状态、云同步账本/游标/操作日志、迁移检查点、投影表 |
| **同步 + 备份** | 日志、正文、日期条目、标签、模板、草稿、学习会话、资源（非播客）、FSRS 三表、AI 驾驶舱正式事实、遗留知识点、设置（可携带字段） |
| **既不同步也不备份** | `aiSecrets`（密钥）、`aiSessions` / `aiMessages` / `aiAttachments`、`voiceRecallSessions` / `voiceRecallTurns` / `voiceRecallLocalHistory`、`reviewAnnotationDrafts`、播客**音频资产** |

### B. 跨端能力

| 能力 | 数据 |
| --- | --- |
| ✅ 可安全自动合并 | 不同 id 的日志/正文、标签、模板、会话、资源、驾驶舱实体、知识点；追加式复习日志；`settings` / `template` 的字段级合并 |
| ⚠️ 可能冲突（需人工/事后收敛） | 同一日志正文、同一决策块内容、同名标签、同一日期条目、同一卡片的 FSRS、草稿、知识点关系一致性 |
| ❌ 无法跨端同步 | 密钥、AI 问答历史与附件、语音复述三表、批注草稿、播客行与音频、主机路径与备份状态、本机 UI 偏好 |

### C. 冲突风险等级

| 等级 | 数据/场景 |
| --- | --- |
| **极高** | 本地恢复旧备份后执行云同步（账本未重置 → 反向墓碑 → 删除云端较新数据） |
| **高** | 同一日志正文并发编辑；云端恢复快照仅 3 份且普通同步不留恢复点 |
| **中** | 同名标签（唯一索引冲突可能让整次恢复失败）；同一日期条目重复；同卡双设备评分；`review-state` / `review-day-stat` 静默远端覆盖；草稿跨设备 |
| **低** | 知识点关系跨实体不一致；播客行进入 ZIP 备份；云端复习事件无上限增长；AI 角色配置同步但密钥不同步导致的「配置在、跑不动」 |

### D. 当前最可能出事故的地方（按优先级）

1. **【极高】恢复旧 ZIP/文件夹备份之后再按云同步 → 云端较新的数据被墓碑删除。**
   机制：`restoreSnapshot` 只清空并整体替换业务表，**不动 `cloudSyncLedger`**；下一次增量同步把「账本里有、本地没有」的 key 全部当作删除上传。这条路径不创建恢复快照，删除会传播到所有设备。
   影响：跨设备不可逆的数据丢失（只能靠更早的备份找回）。
   建议方向（本轮未实施）：恢复时同步重置账本与游标，或在恢复后强制进入「以本机为准」的显式确认流程并先生成云端恢复快照。

2. **【高】同一篇日志在两台设备被同时编辑，输掉的一版只存在于 3 份恢复快照里。**
   机制：`block` 是整体一个实体，无字段级合并；二选一之后，落败版本仅由 `makeLocalSnapshot` / `makeRemoteSnapshot` 保住，而 `SNAPSHOT_LIMIT = 3`。
   影响：冲突频繁时旧快照被 GC，落败正文永久丢失。

3. **【中—高】两台设备离线各自新建同名标签 → 恢复时唯一索引冲突。**
   机制：`tags` 索引 `&name` 唯一，但 id 随机；云端会出现两个同 name 实体，`restoreSnapshotData` 里 `db.tags.bulkPut` 在清表后写入重复 name 会抛约束错误，导致整次同步/恢复失败（而不是优雅降级）。
   影响：同步被卡住，用户看到「同步失败」且难以自行定位。

4. **【中】同名日期条目在云端并存。**
   机制：`entries` 以随机 id 存储，按 `date` 查询取第一条；两台设备同一天各建一次就会出现两行，其中一行长期成为持续同步的孤儿数据。

5. **【中】双设备离线各评同一张卡，状态取较晚者且无提示。**
   机制：`review-state` 被排除在冲突检测之外，而两条复习日志都会保留；最终状态由 `rebuildReviewProjectionFromEvents` 按 `reviewedAt:updatedAt` 取较晚的一条决定，FSRS 间隔基于各自不同的旧状态算出，可能与用户预期不符。

---

## 15. 本轮未修改任何代码

按要求，本轮只做了审查与数据流追踪，未改动：同步逻辑、Dexie schema、云端 API/规则、冲突算法、UI、备份格式。

审查过程中发现的两处「文档与实现不一致」（不属于安全漏洞），仅作记录，留待后续决策：

1. `AGENTS.md` 称 knowledge-podcast 行在便携导出之外，但实现里播客行（含自定义 prompt）会进入 ZIP / 原生流式 / 文件夹备份的 `data.json`；
2. 设置中的 `editorFontScale` 自我描述为「设备本地缩放」，但未被 `sanitizeSettingsForExport` 剥离，因此会随设置同步到其它设备。

上面 §14-D 的 1 与 3 是本轮最值得优先处理的两点；其中第 1 条具备明确的用户数据丢失路径，建议在下一轮作为独立任务评估修复方案。
