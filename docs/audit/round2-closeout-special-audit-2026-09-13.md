# StudyJournal 收口专项审查报告（第二轮）

> 审查日期：2026-09-13
> 审查性质：**只读审查，未修改任何源码 / 配置 / schema / 构建脚本，未提交 commit，未做任何「顺手修复」。**
> 基线：`main` @ `829f98d`（2026-09-12 19:36:18 +0800，`fix(sync): keep AI and TTS settings device-local`）
> 网络说明：本环境仍无法直连 GitHub（`CONNECT tunnel failed, response 502`），未拉取远端。
> 排除范围：云同步、自动备份的**内部实现**。但其他模块对它们**错误的调用/遗漏调用**已按要求报告（见 §3.3）。

**本轮与第一轮的分工**：第一轮按代码模块审查了「模块内部是否正确」。本轮改为按**真实用户流程 / 异常恢复 / 数据生命周期 / Production 发布 / 安全隐私**五个专项审查，并额外完成**修复 ROI 复核**。

**本轮最有价值的产出不是新增问题，而是对既有结论的四次复核修正 + 一个新发现：**

| 项 | 原判 | 复核后 | 位置 |
| --- | --- | --- | --- |
| H-1 配置多源分裂 | 🔴 P0/P1 | 🟡 E（localStorage 是显式覆盖层，非影子副本） | §7.1 |
| 流程 B「无题可答」 | 缺陷 | ❌ 否定（优雅降级，渲染整篇正文） | §7.2 |
| P-2「mermaid 零引用」 | 应为性能缺陷 | ❌ **更正：mermaid 被有意懒加载**，precache 是有意取舍 | §7.5 |
| R2-2 purge 漏标 | 🟠 确认 Bug | 🟡 健壮性（软删路径已覆盖 → 冗余缺失，影响≈0） | §3.3 |
| **R2-16 `sourceUnavailable` 单向不可逆** | — | 🟠 **新发现，走常规路径** | §3.3 |

---

## 1. E2E 流程审查

### 1.1 流程闭环总览

| 流程 | 是否闭环 | 发现问题 | 严重程度 |
| --- | --- | --- | --- |
| A 学习记录（创建→编辑→保存→重开→搜索） | ✅ **闭环** | 无确认缺陷。读写同源（无独立持久缓存层），搜索缓存键含 `updatedAt` + OCR 文本，编辑即失效，不会搜到旧版本 | — |
| B 学习 → 复习 | ⚠️ **基本闭环** | **删除→恢复 会永久丢失复习计划且回收站不告知**（R2-1）；重新加入会重置 FSRS 却保留 `totalReviews`（R2-5） | 🟠 中高 |
| C AI 学习闭环 | ⚠️ **基本闭环** | 两处接缝：AI Chat 自测/诊断为**纯内存态**、与 Coach 不互通；Coach 任务/evidence **不回写** `recordReviews`，与主复习流程解耦 | 🟡 中 |
| D 语音学习闭环 | ⚠️ **基本闭环** | 正常轮次/暂停恢复/主动结束/失败重试/系统杀死恢复均已落实；缺口：Android 后台暂停无 `appStateChange` 监听、`ending` 态不在修复列表、TTS 播放音频焦点未专门管理 | 🟡 中 |
| E 首次使用 / 配置 | ⚠️ **基本闭环** | LLM 与 TTS **都会正确回退到 Dexie 设置**（配置一次基本成立）；但 ASR 只能在语音服务设置内配，且 AI 与 TTS 撞用同一密钥槽会直接报错阻断 | 🟡 中 |

### 1.2 流程 A（已确认闭环，仅记证据）

- 编辑器加载优先级：草稿 > 正式记录，按 `updatedAt` 比较（`RecordEditorPage.tsx:393-433`，判定在 `:404`，取正式记录在 `:420`）。
- 保存后内存刷新：`saveBlock` 落库 + 删草稿（`storageAdapter.ts:872-938`，删草稿在 `:914`），随后 `refresh()` 重读。
- 知识块落库方式：折叠块/卡片块 = `contentHtml` 内文本节点（无独立表）；**决策块**额外镜像进 `decisionBlocks` 表（`storageAdapter.ts:879-908`）。
- 冷启动：`initialize()` → `rebuildProjections()` → 多次 `refresh()`，**全部从 `db.*.toArray()` 重读**，无独立持久缓存（`useAppData.ts:184-208`）。
- 搜索缓存：`recordTextCache` 键 = `id + updatedAt + tags + assetsUpdatedAt`（`search.ts:10/24-30`），编辑即换键 → 不会命中旧缓存。

> 残留隐患（非独立缺陷，与第一轮 A-2 同源）：若 `refresh()` 抛错，内存 `blocks` 落后于 DB → 表现为「DB 已保存但列表/搜索暂时看不到新内容」。

### 1.3 流程 B（未闭环环节：删除 → 恢复）

**已确认的完整链路（这是本轮最重要的发现之一）：**

```text
用户在日志里「删除」一条记录
  └─ deleteBlock (storageAdapter.ts:1422-1436)  ← 单事务内做三件事
       ├─ blocks:   标 deletedAt                                  (:1429)  ✓ 软删
       ├─ recordDrafts: db.recordDrafts.delete(blockId)          (:1430)  ← 草稿立即删除
       └─ recordReviews: status="removed", nextReviewDate=undefined (:1433)  ← 复习计划被置为移除

用户从「回收站」点「恢复」
  └─ restoreBlock (storageAdapter.ts:1445-1455)
       └─ 只做：清 deletedAt + 改 updatedAt                       (:1450-1453)
          ✗ 不还原 recordReviews.status  ← 复习计划永久停留在 removed

后果
  ├─ isReviewDueOn 要求 status==="active"  (reviewScheduler.ts:169-173)  → 该记录永久不再进入复习队列
  ├─ listDueRecordReviews 也按 [status+nextReviewDate] 区间查 active     (storageAdapter.ts:998-1002)  → 双重排除
  ├─ RecordCard 显示「加入复习」（review.status==="removed"）            (RecordCard.tsx:22)  → 状态可见，用户可手动重加
  └─ 若用户手动重加 → reviewStateForNewCycle (storageAdapter.ts:442-463)
       ├─ repetition: 0 / intervalDays: 1 / fsrsCard: createInitialFsrsCard()  ← FSRS 记忆曲线被清空
       └─ totalReviews: existing?.totalReviews ?? 0                            (:459) ← 但累计次数被保留
```

**两个可独立报告的问题：**

- **R2-1（🟠 中高）回收站完全不提示复习计划会丢失。** `TrashPage.tsx` 是自定义渲染（非 `RecordCard`），只显示标题、科目、日期、删除时间、剩余天数与「恢复/永久删除」按钮 —— **不显示任何复习状态**。用户在回收站点「恢复」时无法预知代价。
  证据：`src/pages/TrashPage.tsx:55-80`；`App.tsx:1176-1199` 的 `onRestore` 直连 `app.restoreBlock`。

- **R2-5（🟡 中低）重加复习后统计口径与调度口径不一致。** `reviewStateForNewCycle` 重置了 FSRS 卡与 repetition/interval，却保留 `totalReviews`（`:459`）。于是「统计显示已复习 30 次」的同时「调度器认为这是全新卡」。这是**数据模型层面的口径分裂**，会让复习统计页与真实调度状态讲不同的故事。

**已复核否定的推测（重要）**：本轮侦察曾提出「删掉正文里的复习重点后，记录仍在队列却无题可答」。
**该结论经复核为不成立**：`currentDecisionBlocks` 为空时，`ReviewPage` 会**渲染整篇记录正文**（`ReviewPage.tsx:1036-1038` 的只读 `RichTextEditor`），只是省略了「复习重点评论」区块（`:1047` 条件渲染）。这是**优雅降级**，不是缺陷。复习本来就以「整条记录」为单位。

### 1.4 流程 C（AI 学习闭环）

**已确认的接缝：**

| 接缝 | 证据 | 性质 |
| --- | --- | --- |
| AI Chat 的自测/诊断对话是**纯内存态**，不落库、不与 Coach 互通 | `AiChatPage.tsx:473-545` 只持久化 `aiSessions/aiMessages/aiAttachments` | 设计问题（非 bug），但用户会以为「AI 诊断结果留下了」，实际换个会话就没了 |
| Coach 的任务/evidence **不回写** `recordReviews` | `orchestrator.ts` 全程不碰 `recordReviews`；`getReviewCoachFormalSnapshot` 也不含它（`repository.ts:300-333`） | 设计问题：Coach 的「复习」与主复习是两套东西 |
| **AI 蓝图未经逐项确认即写入跨端同步实体** | `orchestrator.ts:506-630` 直接 `acceptBlueprint("accepted")` + `createTask("waiting")`；`sessionBlueprints`/`adaptiveReviewTasks` 在 `cloudSyncModel.ts:333-340` 的同步映射内 | **承接第一轮 F-2**，本轮再次确认；涉及数据边界 |
| `getReviewCoachFormalSnapshot` 读 `decisionBlocks.toArray()` **不过滤记录是否仍存在** | `repository.ts:318` | 已 accepted 蓝图若其记录被永久删除，读取时不复查（但 `purgeReviewCoachFactsForRecord` 已在删除侧清理，故常规路径安全） |

**正面确认（本轮新验证）：**

- RAG 范围强制排除已删除记录：`aiContextService.ts:227` `!block.deletedAt`。
- **编辑后不会取到旧版本**：`contextCache` 的指纹含 `record.updatedAt` + `contentHtml.length` + asset `ocrText`（`aiContextService.ts:602-616`），编辑即失效。
- source of truth 明确为 `blocks.contentHtml`；`decisionBlocks` 是其派生投影（`saveRecordWithDecisionBlocks:572-618`）。

### 1.5 流程 D（语音学习闭环）

**正常状态序列（已确认完整）：**

```text
idle → preflight(CONFIRM_DISCLOSURE:domain.ts:108) → connecting(CONNECT:111)
     → listening(CONNECTED:114) → finalizing-asr(SUBMIT_CAPTURE:132)
     → thinking(ASR_FINALIZED:135) → speaking(LLM_REPLIED:141)
     → listening(PLAYBACK_FINISHED:150) → …下一轮
暂停：paused(PAUSE:175) → reconnecting(RESUME:184) → listening
结束：ending(END:200) → ended(END_COMPLETE:209)
```

**正面确认：**

- **「恢复恒为 paused」的声明属实**：`runtimeController.ts:112` 置 `status:"paused"`，工作区恢复分支不派发 `CONNECTED`（`VoiceRecallWorkspace.tsx:290-300`）。
- 暂停时真正释放了资源：`cancelActiveTurn` → `stopCapture`（abort 控制器 → `aliyunAsrTransport.ts:61` → `socket.close()`）+ `playback.interrupt()` + `focus.release`（`runtimeController.ts:300-306`）。
- **失败重试不会重复写 turn**：`nextSequence` 只在 `commitTurn` 内递增（`repository.ts:113`），失败路径不发生 `commitTurn`。
- **无自动重连、每轮新 socket** → 不会重复发送同一段音频（`aliyunAsrTransport.ts:84-85` 仅 `fail`）。
- 系统杀死可恢复：`repairInterruptedSessions` 把 `connecting/listening/.../reconnecting` 全置 `interrupted`（`repository.ts:155`）。
- provider 配置快照有效：运行中改配置不影响当前会话；切换会话时比对 `configurationIdentity` 拒绝配置漂移（`VoiceRecallWorkspace.tsx:286-288`）。

**已确认缺口：**

| # | 问题 | 证据 | 严重 |
| --- | --- | --- | --- |
| R2-6 | **`ending` 态不在修复列表** → 恰在 END 期间被杀会残留不可恢复态（既不被 `repairInterruptedSessions` 修复，也不被 `cleanupCompleted` 清） | `repository.ts:155-158` 修复列表不含 `ending`；`runtimeController.ts:105` 拒绝恢复 `ending/ended` | 🟡 低 |
| R2-7 | **Android 后台暂停只依赖 `document.visibilitychange` + `pagehide`，没有 `CapacitorApp.addListener("appStateChange")`** | `audioFocus.ts:59-60`；全仓 `appStateChange` 仅出现在 `App.tsx` / `PlaybackProvider.tsx` | 🟡 中（Android WebView 后台 `visibilitychange` 的可靠性未真机验收） |
| R2-8 | VAD 端点判定为「未完成句 4s / 完成句 2s」，**换气停顿可能被误判为说完并自动发送**（自动半双工模式无人工确认步骤） | `voiceActivity.ts:51-52`；`VoiceRecallWorkspace.tsx:519-521` 直接 `submitTurn(result.transcript)` | 🟡 中（属调参/体验，非逻辑错误） |

### 1.6 流程 E（首次使用 / 配置）

**正面确认（这条修正了第一轮的一个判断）：**

- LLM：`input.config?.llmProfileId ? settings.ai.providers.find(...) : getCurrentAiProvider(settings.ai)` → **回退到用户的当前 AI 供应商**（`productionPipeline.ts:133-136`）。
- TTS：`selectedTtsId = input.config?.ttsProfileId || configuredTts?.id || baseTemplate.ttsProfileId` → **回退到 `settings.tts` 的当前 TTS**（`productionPipeline.ts:138-141`）。
- 启动页展示的生效值同样回退到设置：`llm = … ?? getCurrentAiProvider(settings.ai)?.id`（`VoiceRecallWorkspace.tsx:869`）、`ttsId = … ?? getCurrentTtsProvider(settings.tts)?.id ?? …`（`:870`）。
- `settings` 的来源确认是 Dexie（`VoiceRecallWorkspace.tsx:123/141` 由 `App.tsx` 从 `useAppData` 注入）。

**⇒ 结论：「用户只需要配置一次」基本成立。** 语音复述会沿用「更多 → AI 设置 / TTS 设置」里的当前供应商与密钥。

**已确认缺口：**

| # | 问题 | 证据 | 严重 |
| --- | --- | --- | --- |
| R2-9 | **ASR 没有 Settings 等价项**，只能在语音服务设置面板内配置；`selectedAsrId` 只回退到模板默认 | `productionPipeline.ts:140/142`；ASR 密钥走独立槽位 `voice-asr-doubao` / `voice-asr-aliyun` | 🟡 中（可接受，但与「一次配置」的心智模型不一致） |
| R2-10 | **AI 与 TTS 撞用同一密钥槽会直接抛错阻断**：「AI 与 TTS 使用了相同的本机密钥槽，请为两者建立独立配置。」 | `productionPipeline.ts:146` | 🟡 低（触发条件苛刻，但报错信息对普通用户不友好） |
| R2-11 | 首次配置**无引导流程**，各腿凭据分散在三个不同面板（AI 设置 / TTS 设置 / 语音服务设置） | `VoiceAsrCredentialSettings.tsx`、`AiSettingsPanel.tsx`、`TtsSettingsPanel` | ⚪ 纯 UX |

---

## 2. 异常与恢复审查

### 2.1 场景速览

| 场景 | 当前行为 | 是否安全恢复 | 风险 |
| --- | --- | --- | --- |
| AI 请求中断网 / 超时 | `aiRetry` 重试 → 失败落 catch → `formatUiError(error,"ai-request")` | ⚠️ 状态可恢复，但**真实错误不可见**（承接第一轮 K-1）；且流式截断未检测（第一轮 E-1） | 🟠 |
| AI 发送后立即返回页面 | abort 仅在**组件卸载**时触发（`AiChatPage.tsx:184`） | ❌ 旧请求继续跑，结果用旧会话闭包 `setMessages` 短暂覆盖新会话 UI（`:533/546`） | 🟠 承接第一轮 E-3 |
| loading 时连续点击发送 | `busy` 来自闭包，提交前不重渲染可双触发（`AiChatPage.tsx:421`） | ⚠️ 可能双提交 | 🟠 承接第一轮 E-3 |
| ASR 断网 / 失败 | `onError` → `cancelActiveTurn` + `autoBlocked`；停在 `listening` 可重试；无自动重连、不重发音频 | ✅ 安全 | 🟡 |
| TTS 请求失败 | `CANCEL_TURN` → `listening`；`commitTurn` 只在成功路径 | ✅ 安全 | 🟡 |
| API Key 失效 | provider 返回 401 → 走通用错误 → 提示 `AI 暂时无法完成本次请求` | ⚠️ 用户无法从文案判断是「key 失效」还是「网络问题」 | 🟡 承接 K-1 |
| 录音中结束 | `finish()` → `end()` → `cancelActiveTurn` → `stopCapture` + `setCapturing(false)` | ✅ 安全，无「正在听」残留（`VoiceRecallWorkspace.tsx:784-791`） | 🟡 |
| TTS 播放中结束 | `playback.interrupt()` 停止当前 source | ⚠️ 基本安全；TTS 走 Web Audio，**播放侧音频焦点未专门管理**（焦点只覆盖麦克风） | 🟡 |
| AI 回复过程中结束 Session | `cancelActiveTurn` → `turnSignal.abort` → 回调被 `!turnSignal.aborted` 拦截，`commitTurn` 不发生 | ✅ 安全（`runtimeController.ts:292-293`） | 🟡 |
| Android 切后台 | **仅 `visibilitychange` + `pagehide`**，无 `appStateChange` | ⚠️ 未真机验收（R2-7） | 🟡 |
| Android 恢复 | 恢复为 paused（不自动续听） | ✅ 符合声明 | 🟡 |
| App 被系统杀死（语音） | `connecting/listening/.../reconnecting` → `interrupted`，下次恢复为 `paused` | ✅ 安全；`ending` 态例外（R2-6） | 🟡 |
| App 被杀死（编辑器草稿） | 草稿在正常保存时删除；软删记录时也立即删除草稿（`:1430`） | ⚠️ 「软删时仍有未保存草稿」这个窗口内草稿会丢 | 🟡 R2-4 |
| 保存过程中退出 | `pagehide` 的 `void flushDraft().catch(()=>undefined)` **不 await** | ⚠️ IndexedDB 异步写可能随页面销毁丢失（`RecordEditorPage.tsx:445-464`） | 🟡 承接第一轮 B-2 |
| FSRS 评分后立即退出 | 评分在单事务内完成（`storageAdapter.ts:1138-1266`），失败整体回滚 | ✅ 安全，无 half-state | 🟡 |
| OCR 中途退出 | 重试挂内存定时器；10 分钟阈值不覆盖「刚入队就退出」 | ❌ 可能永久卡 `queued`（承接第一轮 B-4/I-2） | 🟡 |
| 卡片图片加载失败 | `getAsset` 的 fulfillment 与 rejection 分支**都**会 `setLoading(false)`；有 `active` 守卫 | ✅ 安全 | ⚪ |
| 图片加载回调内部抛错（如 `URL.createObjectURL` 对损坏 Blob 抛错） | `onFulfilled` 不在 try/catch 内 → `loading` 永久为 true，且**无全局异常兜底承接** | ❌ 极端情况 UI 卡在「正在读取图片...」 | ⚪ 低（`ImageLightbox.tsx:123-141`） |
| 快速连续点击（语音） | `captureStartingRef/captureStoppingRef/submittingRef` + `end()` 双判断 | ✅ 安全 | ⚪ |
| 快速连续点击（复习评分） | `ratingRecordId` 单飞 + 同日 correction | ⚠️ 无显式幂等键，跨日/跨标签理论可双计 | 🟡 承接第一轮 C-4 |

### 2.2 横向结论

**loading 永久残留的风险总体很低。** 我逐个文件核对了 `setBusy/setLoading/setImporting/setSaving` 与 `finally` 的配对：

| 文件 | `setXxx(true)` 次数 | `finally` 次数 | 判定 |
| --- | --- | --- | --- |
| `AutoBackupPanel.tsx` | 1 | 1 | ✅ |
| `VoiceAsrCredentialSettings.tsx` | 1 | 1 | ✅ |
| `AiChatPage.tsx` | 1 | 1 | ✅ |
| `OcrSettingsPage.tsx` | 1 | 1 | ✅ |
| `RecordingsPage.tsx` | 1 | 1 | ✅ |
| `TemplateLibraryPage.tsx` | 1 | 1 | ✅ |
| `RecordEditorPage.tsx` | 2 | 11 | ✅ |
| `VoiceRecallWorkspace.tsx` | 4 | 7 | ✅ |
| `ImageLightbox.tsx` | 1 | 0 | ⚠️ 用 `then(onFulfilled, onRejected)` 覆盖，等价安全；唯一缺口是 `onFulfilled` 内部抛错（§2.1 末行） |

**⇒ 本轮没有发现「loading 永久存在」的常规路径。** 唯一残留是 `ImageLightbox` 的极端分支。

**真正影响恢复质量的是「错误不可见」（第一轮 K-1）而不是状态回滚。** 多数失败路径的状态机是对的（都回到了可用态），但用户和开发者都看不到**为什么**失败 —— 这是「恢复体验」的决定性因素，而不是状态残留。

---

## 3. 数据生命周期审查

### 3.1 主要数据关系图

```text
blocks（记录正文 contentHtml）  ← 唯一 source of truth
│
├── decisionBlocks（决策块投影，按 recordId）        ─┐
│    ├── decisionBlockFeedback                       │
│    ├── feedbackInterpretations                     │  Learning Coach
│    ├── analysisQueueItems / analysisBatches        │  派生数据
│    ├── sessionBlueprints / adaptiveReviewTasks     │  （跨端同步实体）
│    ├── adaptiveQuizTurns / taskOutcomeEvents       │
│    ├── delayedVerifications                        │
│    ├── decisionBlockStates（投影）                 │
│    └── interventionEffectSummaries（投影）        ─┘
│
├── recordReviews（FSRS 调度状态，按 recordId，独立调度）
│    ├── recordReviewLogs（评分事件，追加式）
│    └── recordReviewDayStats（按日的统计，独立）
│
├── reviewAnnotationDrafts（批注草稿，device-local，schema 20）
│
├── studySessions（按 blockId）
├── recordDrafts（按 recordId）
├── assets（图片/音频/附件，多对多引用）
│
├── knowledgePodcasts.sourceRecordIds[]   ← 引用关系（无清理）
└── voiceRecallSessions.sourceRecordIds[] ← 引用关系（部分清理）
```

### 3.2 删除 / 恢复 / 清理行为对照表

> 依据：`deleteBlock:1422-1436`（软删）、`permanentlyDeleteBlock:1457-1480`（永久删）、`restoreBlock:1445-1455`（恢复）、`purgeExpiredDeletedBlocks:1482-1497`（30 天自动清理）、`purgeReviewCoachFactsForRecord`（`repository.ts:225+`）、`cleanupOrphanAssetsForRecord:605-642`。

| 数据实体 | 软删（进回收站） | 永久删除 | 从回收站恢复 | 孤儿风险 |
| --- | --- | --- | --- | --- |
| `blocks` | 标 `deletedAt`（`:1429`） | 删除（`:1466`） | 清 `deletedAt`（`:1450`） | 无 |
| `recordDrafts` | **立即删除**（`:1430`） | 删除（`:1467`） | **不重建 → 丢失** | 🟠 中（R2-4） |
| `recordReviews` | 置 `status:"removed"` + `nextReviewDate:undefined`（`:1433`） | 删除（`:1469`） | **仍为 `removed` → 复习永久失效** | 🔴 高（R2-1） |
| `recordReviewLogs` | 不动 | 按 `recordId` 删除（`:1470`） | 保留 | 低 |
| `recordReviewDayStats` | 不动 | **不删** | — | ⚪ 低（历史统计保留，属设计） |
| `reviewAnnotationDrafts` | 不动 | 按 `recordId` 删除（`:1471`） | 保留 | 低 |
| `studySessions` | 不动 | 按 `blockId` 删除（`:1468`） | 保留 | 低 |
| `decisionBlocks` + Coach 全套 | 不动（保留） | `purgeReviewCoachFactsForRecord` 按 `recordId`/`blockIds`/`feedbackIds` 全面清理（`repository.ts:225-265`） | 保留 → 可恢复 | 低 ✅ |
| `interventionEffectSummaries` | 不动 | **不删**（无 recordId，纯聚合） | — | ⚪ 低 |
| `assets` | 不动 | 仅孤儿清理（`:1474`） | 保留 | 🟠 见 §3.3 |
| `templates`（若引用 asset） | 不动 | **`cleanupOrphanAssetsForRecord` 不扫描 `db.templates`** → 可能误删被模板引用的资源 | — | 🔴 高（承接第一轮 R-3） |
| `knowledgePodcasts.sourceRecordIds` | 不动 | **不清理 → 悬空引用** | — | 🟠 中（R2-3） |
| `voiceRecallSessions` / `voiceRecallLocalHistory` | **标记 `interrupted` + `sourceUnavailable`**（`useAppData.ts:294-296`） | 仅应用层清理，purge 入口漏标（冗余缺失）→ §3.3 R2-2 | **不回滚 `sourceUnavailable`** → 永久作废 → §3.3 R2-16 | 🟡 R2-2 / 🟠 **R2-16** |

### 3.3 跨模块清理的**不对称**（本轮最有价值的发现）

这是第一轮按目录审查时**不可能发现**的问题：同一个逻辑操作有两个入口，只有其中一个做了下游清理。

**`markSourceUnavailable` 的四个入口，三个被接上：**

```text
语音复述有一套正确的降级设计：
  repository.ts:167-179         markSourceUnavailable → status:"interrupted" + sourceUnavailable:true
  runtimeController.ts:105     恢复时若 session.sourceUnavailable → 拒绝恢复
  VoiceRecallWorkspace.tsx:274  抛 VoiceConfigurationError("会话来源已不可用，无法恢复。")
  VoiceRecallWorkspace.tsx:657  抛 VoiceConfigurationError("语音复述会话或学习来源已不可用。")

应有四个入口触发 markSourceUnavailable(recordId)：

  ① 软删除（进回收站）
     useAppData.ts:292-301   await storage.deleteBlock(blockId)
                           + await voiceRecallRepository.markSourceUnavailable()   ✅ 有
     （这是**常规路径**，也是覆盖率的主要来源）

  ② 直接永久删除（回收站点「永久删除」）
     useAppData.ts:312-320   await storage.permanentlyDeleteBlock()
                            + await voiceRecallRepository.markSourceUnavailable()   ✅ 有

  ③ 清空回收站（循环调 permanentlyDeleteBlock）
     App.tsx:1188-1194       走 app.permanentlyDeleteBlock() → 落到 ② ✅ 有

  ④ 30 天自动清理 / 手动「清理过期」
     useAppData.ts:194        await storage.purgeExpiredDeletedBlocks(30)   ❌ 无
     useAppData.ts:322-330    purgeExpiredDeletedBlocks wrapper            ❌ 无
       └─ storage.purgeExpiredDeletedBlocks 内部循环调 storage 层的 permanentlyDeleteBlock
          （storageAdapter.ts:1493-1495），不会触发 useAppData 层的 markSourceUnavailable
```

**⇒ R2-2（修正后判为 🟡 健壮性，非 🟠 确认 Bug）：**

**必须先说明一个降低严重性的事实**：路径 ①（软删除）**已经**标记了 `sourceUnavailable`。而复核确认**所有**软删除都必经 useAppData 包装 —— `storage.deleteBlock` 的唯一调用点是 `useAppData.ts:294`（`App.tsx:1004` 走的是 `app.deleteBlock` 包装）。

**⇒ 因此路径 ④ 的漏标在常规流程中是「冗余覆盖缺失」，实际用户影响接近 0**：记录进回收站时就已经标记过了，30 天后 purge 时再标一次本属冗余。

**它真正有意义的窗口只有两个**：
1. 路径 ① 的标记被静默吞掉（`useAppData.ts:296` 是 `.catch(() => undefined)`）→ purge 是唯一的补救机会，而它没有补。
2. 早于该标记逻辑上线的**历史数据**（软删时尚未有 markSourceUnavailable）。

**⇒ 分类：C（可顺手修）**，一行调用即可补齐，属防御纵深，**不构成收口阻碍**。

---

**⇒ R2-16（🟡 中，本轮新增 —— 比 R2-2 更值得修）：`sourceUnavailable` 是单向标志，没有反向恢复路径。**

```ts
// repository.ts:175  删除时置位
await ...sessions.map((s) => ({ ...s, status: "interrupted", sourceUnavailable: true, ... }));
// repository.ts:176
await ...histories.map((h) => ({ ...h, sourceUnavailable: true }));
```

全仓 grep `markSourceAvailable` / `clearSourceUnavailable` / `sourceUnavailable: false` → **零命中**。
而 `restoreBlock`（`useAppData.ts:303-310`）只做 `storage.restoreBlock()` + `refresh()`，**不清理 `sourceUnavailable`**。

**用户可见后果（这是常规路径，不是错误路径）：**

```text
用记录 X 做语音复述 → 历史里留下一条会话
→ 误删记录 X（进回收站）        ⇒ 该语音历史被标记 sourceUnavailable:true
→ 从回收站恢复记录 X            ⇒ 记录完好，但语音历史**永久**显示「会话来源已不可用，无法恢复。」
```

即：**用户撤销了删除，记录内容能恢复，但语音复述的恢复能力被永久作废。** 这是一个「删除 ↔ 恢复」不对称，与 R2-1（复习计划丢失）同源同类。

**修复方式同样极轻**：在 `restoreBlock` 包装里加一次反向调用（按 `sourceRecordIds` 包含该 recordId 的会话重算 `sourceUnavailable = 记录是否仍不存在`）。

**⇒ 分类：B（建议现在修）**，与 R2-1 合并进「数据生命周期一致性」批次。

**同类问题（播客侧更严重）：**

**⇒ R2-3（🟠 中）：`knowledgePodcasts` 没有任何等价清理路径。** 全仓 grep `sourceUnavailable` 在 `knowledgePodcast*` 与 `reviewCoach` 中**零命中**；`knowledgePodcasts` 也不在 `permanentlyDeleteBlock` 的事务表清单内（`:1465`）。

用户可见的表现是**计数与实际不符**：

```tsx
// src/pages/KnowledgePodcastPage.tsx:697-698
<span>来源 {segment.sourceRecordIds.length} 条</span>          ← 用原始数组长度
{segment.sourceRecordIds.map((id) => sourceMap.get(id)).filter(Boolean)
  .map((record) => <button …>{record.title}</button>)}          ← 过滤掉已失效的
```

若 3 条来源中有 1 条被永久删除 → 界面显示「来源 3 条」，但只渲染出 2 个可点链接。

### 3.4 「UI 看起来已删除，但底层仍存在」的核查

| 数据 | 是否泄漏到 UI/检索 | 证据 |
| --- | --- | --- |
| 记录正文 / 标题 | ❌ 不泄漏 | `listBlocks`（`storageAdapter.ts:866-868`）过滤 `!deletedAt`；`getAiKnowledgeScopeRecords`（`aiContextService.ts:227`）同样过滤；搜索数据源是已过滤的 `app.blocks` |
| 复习队列 | ❌ 不泄漏 | `listDueRecordReviews`（`:998-1002`）要求 `status==="active"` |
| 复习日统计 | ⚠️ **仍计入历史** | `recordReviewDayStats` 永久删除时不清理（不在 `:1465` 事务清单）→ 已删记录的历史复习次数仍影响 streak / 趋势 |
| 播客来源链接 | ⚠️ 计数不符 | §3.3 R2-3 |
| 语音来源 | ⚠️ 恢复后仍标不可用 | §3.3 R2-16 |
| Coach 数据 | ❌ 不泄漏 | `purgeReviewCoachFactsForRecord` 全面清理（`repository.ts:225-265`） |

### 3.5 明确区分：已确认 vs 证据不足

**已确认的问题（有代码证据）：**
R2-1、R2-2（已降级为健壮性）、**R2-16**、R2-3、R2-4、R2-5、`recordReviewDayStats` 永久删除不清理、`cleanupOrphanAssetsForRecord` 不扫 `templates`（承接第一轮 R-3）。

**证据不足 / 理论可能存在（不作为收口阻碍）：**
- Coach 的 `evidence[].decisionBlockId` 在极边缘路径（绕过 repository 手工写入）是否产生悬空 —— `purgeReviewCoachFactsForRecord` 已按四类 ID 全面清理，常规路径无此风险。
- `decisionBlockStates` / `interventionEffectSummaries` 投影在记录删除后是否残留陈旧行 —— 它们由 `rebuildProjections()` 全量重算（`repository.ts:411-433`）覆盖，未见残留证据。

---

## 4. Production Release 审查

### 4.1 Dev / Production 差异（本轮新覆盖）

| 检查项 | 结论 | 证据 |
| --- | --- | --- |
| `import.meta.env` / `import.meta.glob` / HMR 依赖 | ✅ 无风险 | `src` 内零使用（仅 `desktop/ocr.test.ts:5`，且被排除） |
| dev-server 绝对路径依赖 | ✅ 无 | `index.html:19` 的 `/src/main.tsx` 仅 dev 占位，build 重写为哈希 bundle |
| 三宿主路径假设（PWA `/` / Android `https://localhost` / Electron 自定义协议） | ✅ 成立 | `vite.config.ts` 无 `base`（默认 `/`）；`capacitor.config.ts:8` `androidScheme:"https"` → 绝对 `/assets` 可解析；`main.cjs:950-958` 把 `/assets/x` 解析到 `DIST_ROOT` |
| PWA Service Worker | ✅ 无风险 | 原生平台不注册 SW 且先 `cleanupNativeServiceWorker()`；该函数仅 unregister + 删 `workbox-`/`pwa-` 缓存，并用 sessionStorage marker **防 reload 循环**（`nativeServiceWorker.ts:48-52`） |
| Mermaid 动态 chunk | ✅ 前提不成立 | `src` 内**无任何 `import` 引用 mermaid**（grep 零命中）→ 那些 chunk 只存在于构建产物，不会被应用请求。**注：这同时意味着 mermaid 是未使用的重量级依赖（第一轮 P-2 的 19 MB 预缓存因此完全没有收益）** |
| 预览路由在 production 改变行为 | ✅ 不会 | 所有原型均 hostname + `?preview=` 双重门控，且原生/桌面被 `isNativePlatform() \|\| isDesktopPlatform()` 短路（`stage3PreviewSeed.ts:599-650`、`App.tsx:112`）。**例外见 §7 的 2 处守卫缺口** |
| 调试开关 / `console` 开关 | ✅ 无 | 无 debug flag 改变生产行为 |

### 4.2 Android 安装包

| 检查项 | 结论 | 证据 |
| --- | --- | --- |
| 构建脚本是否会打进过期 web 资源 | ✅ 有防护 | `android-release-build.ps1:17` 先跑 `android-sync.ps1`（`npm run build` + `cap sync` + `index.html` sha256 校验）；再 aapt 校验 `versionCode=14/versionName=0.2.3`（`:58-61`）+ 输出 APK sha256 |
| 权限与代码使用是否一致 | ✅ 一致 | Manifest 声明 `INTERNET/RECORD_AUDIO/FOREGROUND_SERVICE` + 三类 + `POST_NOTIFICATIONS`（`AndroidManifest.xml:61-67`）；`@capacitor/camera` 已依赖但 `src` 无 `Camera.getPhoto` 调用（潜在无用依赖，非缺陷） |
| 前台服务类型在 targetSdk 34+ 的合法性 | ⚠️ 有风险 | 三类 FGS 已声明（`:28-46`）。`PodcastTtsForegroundService`(dataSync) 若在无可见 Activity 时启动，可能抛 `ForegroundServiceStartNotAllowedException`。**证据不足，需确认启动时机** |
| **Firebase 在 release 包中如何取配置** | ⚠️ **构建阻断风险** | 运行时 OK：`firebase.ts:9-18` 硬编码 Web config，`capacitor.config.ts:13` `skipNativeAuth:true` → 走 WebView 内 Web SDK，**不需要 `google-services.json`**。但 `@capacitor-firebase/authentication` 原生模块在 Gradle 阶段通常要求该文件才能 `assembleRelease`，而它**未入库**（`.gitignore`）→ **从源码零构建 release APK 大概率失败** |
| targetSdk 36 下的 insets | ⚠️ 承接第一轮 M-1 | `MainActivity.java:23` `setDecorFitsSystemWindows(window, true)` 自 Android 15 起被忽略，`setStatusBarColor` 亦已废弃；与 Web 侧 `env(safe-area-inset-*)` 假设冲突 |
| 首次安装无网络能否进主界面 | ✅ 可以 | `main.tsx:68` 无条件渲染 `<App/>`；`firebase.ts` 初始化不联网 |
| `allowBackup="true"` | ⚠️ 承接第一轮 H-3 | `AndroidManifest.xml:5`，无 `fullBackupContent` 排除规则 |

### 4.3 Desktop 安装包

| 检查项 | 结论 | 证据 |
| --- | --- | --- |
| ASAR 下的 `require()` 解析 | ✅ 安全 | `main.cjs:1-8` 仅 require `electron` + `node:*` + `./ocr.cjs` + （可选）`./oauth-config.cjs`；`ocr.cjs`/`voiceAsrSocket.cjs`/`preload.cjs` **无第三方 require** → 排除 `node_modules` 后全部可解析 |
| `contextIsolation` / `sandbox` | ✅ 安全 | `main.cjs:997-1000`、`:1027`：`contextIsolation:true, nodeIntegration:false, sandbox:true` |
| preload ↔ `desktop.d.ts` 一致性 | ✅ 一一对应 | 11 组 API 双向核对无遗漏 |
| 图标生成失败是否会被静默忽略 | ✅ 不会 | `create-desktop-icon.cjs:22` 是 `void createIcon()` fire-and-forget，但未捕获 rejection 会让进程以非 0 退出 → `desktop:build` 的 `&&` 链条中断，electron-builder **不会静默成功**。（小残留：`void` 模式在事件循环清空前抛错可能漏判） |
| 卸载/升级是否会误删用户数据 | ✅ 不会 | `installer.nsh:81` `RMDir /r "$INSTDIR"` 只删 `D:\StudyJournal\App`（App 目录）；数据在独立的 `D:\StudyJournal\Data`（`main.cjs:27`） |
| OAuth 回调协议 | ✅ 无需系统协议注册 | 桌面 Google 登录走 localhost loopback（`main.cjs:839-842`），不需要注册 `study-journal://`。OAuth 默认不可用是 `oauth-config.cjs` 缺失所致（承接第一轮 N-2），非协议问题 |
| **ASAR 内 `dist` 经 `net.fetch(pathToFileURL(...))` 加载是否生效** | ⚠️ **未实测（第一轮遗漏项）** | `main.cjs:24` `DIST_ROOT = path.resolve(__dirname, "..", "dist")` 落在 asar 内；`:967` 用 `net.fetch(pathToFileURL(filePath))` 指向 `app.asar/dist/...`。Electron 的 `protocol.handle` + `net.fetch` 对 asar 内路径的支持**需在真实安装包上实测**，静态审查无法定论 |

### 4.4 Release-ready 判定

| 平台 | 判定 | 理由 |
| --- | --- | --- |
| **Android** | ⚠️ **「已构建出的 APK 可用」，但「从源码零构建不可复现」** | 运行时完全就绪（离线可进、Firebase 走 Web SDK、路径正确、权限正确、有 aapt 版本校验防陈旧资源）。两个待办：① `google-services.json` 未入库 → 干净环境构建 release 大概率失败（**分发阻断**）；② dataSync 前台服务的后台启动时机需确认。另需真机核实 insets（M-1） |
| **Desktop** | ⚠️ **基本 release-ready，但有一个未实测关键路径** | 路径/数据/require/隔离/卸载/协议全部安全。唯一不能静态定论的是 **asar 内 `dist` 经 `net.fetch` 加载**。建议在真实安装包上做一次冒烟验证。OAuth 默认不可用是已知项（若你要桌面登录，必须把 `oauth-config.cjs` 纳入发布流程，但**不能**入库） |

---

## 5. Security / Privacy 审查

### 5.1 只列高可信问题

**S-1（🔴 高可信）Android Auto Backup 会带走明文 API Key —— 与产品声明直接矛盾**
- `AndroidManifest.xml:5` `android:allowBackup="true"`，全仓 grep **无** `fullBackupContent` / `dataExtractionRules` / `backupRules` 排除项。
- 密钥明文落 Dexie：`storageAdapter.ts:2309-2317` `db.aiSecrets.put({ apiKey, ...apiKeySecondary })`，位于应用私有数据目录 → 属 Auto Backup 范畴。
- 而 `docs/voice-recall-privacy.md` 与 `AGENTS.md` 均声明「API Key 不进入 native backup」。
- **⇒ 声明与实现不一致，且是真实外泄路径。**（承接第一轮 H-3，本轮补充了「声明在哪、如何矛盾」的证据）

**S-2（🟠 防御缺口）导出脱敏过滤器覆盖窄于声明**
- `exportPrivacy.ts:3-12` `PRIVATE_EXPORT_KEYS = {apikey, authorization, prompt, providerresponse, rawresponse, responsebody, secret, systemprompt}`。
- **缺**：`apiKeySecondary`、`baseUrl`、`endpoint`、`model`、`voiceId`、`token`、`appId`。
- 目前**未实际泄漏**（`sanitizeSettingsForExport:24-37` 整体剔除 `ai`/`tts`；`voiceRecall*` 不进快照），属防御纵深缺口：一旦未来有任何含上述字段的实体进入导出/同步体，`stripPrivateExportFields` 不会遮蔽。

### 5.2 已验证安全（负面确认 —— 这些不需要修）

| 项 | 结论 | 证据 |
| --- | --- | --- |
| API Key 进入日志 | ❌ 不会 | 全仓 `console.log` 为 0；`uiError.ts:39-47` 只返回通用文案 + 诊断编号 |
| API Key 进入用户可见错误 | ❌ 不会 | `describeVoiceError` → `formatUiError` 输出固定文案；`redactVoiceDiagnostic`（`providerRuntime.ts:53-59`）已脱敏 `apiKey=` / `bearer X` |
| API Key 进入 AI prompt | ❌ 不会 | `aiClientService.ts:380` 仅作 `Authorization: Bearer` 头；消息体由 system prompt + 历史 + 内容构成 |
| API Key 打包进 APK / ASAR | ❌ 不会 | 仓库内无真实 key；无 `.env*`、无 `google-services.json`；`oauth-config.cjs` 被 gitignore；仅测试/示例值 |
| renderer 拿到 OAuth client secret | ❌ 不会 | `preload.cjs:17-19` 仅 `auth.signInWithGoogle` 返回 `{idToken}`；`clientSecret` 只在 `main.cjs` |
| API Key 进入备份 / 云同步 | ❌ 不会 | `createSnapshot`（`storageAdapter.ts:1906-1975`）事务表清单**不含 `aiSecrets`**；`cloudSyncModel.ts:322-368` 映射不含；settings 经 `sanitizeSettingsForExport` 剔除 `ai`/`tts` |
| 遥测 / 埋点 / 崩溃上报 | ❌ 不存在 | grep `sentry\|telemetry\|analytics\|autoUpdater\|crashlytics` 零命中 |
| 设备本地表边界（声明 vs 实现） | ✅ 一致 | `reviewAnnotationDrafts`（`database.ts:113`）与 `recordDrafts`（`:77`）是两个独立表，快照/同步只含后者；`voiceRecallSessions/turns/localHistory` 均不在 `createSnapshot` 事务清单 |

### 5.3 数据外发清单（哪些数据离设备、去哪里、何时）

| 数据 | 离设备 | 目标 | 触发条件 |
| --- | --- | --- | --- |
| 日志正文 / 选段 + 上下文 | 是 | 用户自己配置的 LLM `baseUrl`（DeepSeek / DashScope / SiliconFlow / 任意中转） | 用户发起 AI 对话 |
| 麦克风音频 | 是 | `wss://dashscope.aliyuncs.com`（Aliyun）、`wss://openspeech.bytedance.com`（Doubao） | 语音复述 |
| 教师回复文本 / 播客文本 | 是 | Fish Audio / DashScope / Tencent TTS / Google TTS / Bytedance | 语音复述 + 知识播客 |
| 图片 | 是 | `https://paddleocr.aistudio-app.com` | OCR 识别 |
| 日志 / 块 / 模板 / 草稿 / 标签 / 复习事实 / 附件 / 附件 OCR 文本 | 是 | Firebase Firestore + Storage | **用户手动开启云同步** |
| OAuth 凭证 | 是 | `accounts.google.com`、`oauth2.googleapis.com` | Desktop 登录 |
| **API Key / secret** | **否**（除 S-1 的 OS 级备份） | — | — |

**⇒ 没有发现「不必要的外发」。** 所有外发都对应一个用户主动触发的功能。

### 5.4 OAuth / Token（Desktop）

- 获取路径：`main.cjs` 内 localhost loopback 授权码流程（`:839-842`）。
- **client secret 只在主进程**，renderer 仅经 IPC 拿到 `idToken`（`preload.cjs:17-19`）。
- 持久化：由 Electron 的 session/partition 管理，未在仓库中发现额外落盘。
- **证据不足项**：token 过期后的自动刷新与 logout 的完整清除路径，本轮未追踪到明确证据，**不做结论**。

---

## 6. 第一轮与本轮合并收口表

> 分类口径：**A 现在必须修 / B 建议现在修 / C 可顺手修 / D 暂时不要动 / E 记录技术债**
> 严重程度：🔴 高 🟠 中 🟡 低 ⚪ 极低

| ID | 模块 | 问题 | 类型 | 严重 | 用户影响 | 修复难度 | 修复波及模块 | 修复风险 | 分类 | 收口前是否必须修 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| K-1 | Error/Feedback | `normalizeUiError` 丢弃真实错误且不落日志 | 确认 Bug | 🔴 | 核心：所有失败都无法定位 | 极低（1 行） | uiError.ts（全局出口） | 低 | **A** | ✅ 必须 |
| A-1/K-3 | App 基础架构 | 无 ErrorBoundary / 无 `window.onerror` / 无 `unhandledrejection` | 确认 Bug | 🔴 | 核心：异常即白屏不可恢复 | 低（新增一层） | main.tsx / App.tsx / uiError.ts | 低 | **A** | ✅ 必须 |
| A-2 | App 基础架构 | 初始化链无 try/catch，失败永久未初始化 | 确认 Bug | 🔴 | 核心：App 永久打不开 | 低 | useAppData / storage | 低 | **A** | ✅ 必须 |
| R-1 | 备份/导出 | 完整性校验与播客音频排除策略自相矛盾 | 确认 Bug | 🔴 | 核心：记录引用播客音频即无法备份 | 中 | storageAdapter | 中 | **A** | ✅ 必须 |
| R-2 | 备份/导出 | 悬空资源引用使导出永久失败且无修复入口 | 确认 Bug | 🔴 | 核心：一条坏引用 = 永远不能备份 | 中 | storageAdapter / BackupPage | 中 | **A** | ✅ 必须 |
| R-3 | 备份/导出 | 孤儿清理不扫 `db.templates`，误删资源且不可逆 | 确认 Bug | 🔴 | 核心：资源永久丢失 + 永久打断导出 | 低 | storageAdapter | 中 | **A** | ✅ 必须 |
| R-4 | 备份/导出 | 播客行缺 `segments` 抛 TypeError | 确认 Bug | 🔴 | 核心：导出失败 | 极低（加 `?.`） | storageAdapter | 低 | **A** | ✅ 必须 |
| S-1/H-3/M-4 | 安全/Android | `allowBackup="true"` 无排除规则，明文密钥+全部学习数据可被 OS 备份出设备 | 高风险 | 🔴 | 隐私承诺被违反 | 极低 | AndroidManifest + 新增 xml | 低 | **A** | ✅ 必须 |
| **R2-1** | 记录/复习 | **删除→恢复丢失复习计划，回收站不告知；重加会重置 FSRS** | 确认 Bug | 🟠 | 用户以为恢复无代价，实际复习进度静默清零 | 低 | storageAdapter.restoreBlock / TrashPage | 中 | **A** | ✅ 必须 |
| M-1 | Android | targetSdk 36 下 insets 策略失效且与 Web 假设冲突 | 高风险 | 🔴* | 移动端布局可能被系统栏遮挡 | 中 | MainActivity + 全部 inset CSS | 中 | **A**（真机核实后定） | ✅ 必须（核实后） |
| **R2-2** | 语音/生命周期 | purge 路径漏调 `markSourceUnavailable`（软删路径已覆盖 → 属冗余覆盖缺失） | 健壮性 | 🟡 | 仅静默失败/历史数据窗口 | 低 | useAppData | 低 | **C** | 可顺手 |
| **R2-16** | 语音/生命周期 | `sourceUnavailable` 单向不可逆：软删→恢复后语音复述**永久**无法恢复 | 确认 Bug | 🟠 | 撤销删除后语音能力被静默作废 | 低 | useAppData.restoreBlock / repository | 低 | **B** | 建议 |
| **R2-3** | 播客/生命周期 | `knowledgePodcasts.sourceRecordIds` 无任何清理；UI 计数与实际链接不符 | 确认 Bug | 🟠 | 「来源 3 条」只显示 2 个 | 低 | knowledgePodcast* / KnowledgePodcastPage | 低 | **B** | 建议 |
| **R2-5** | 复习/统计 | 重加复习保留 `totalReviews` 但重置 FSRS → 统计口径分裂 | 确认 Bug | 🟡 | 统计与调度讲不同故事 | 低 | storageAdapter / learningStats | 中 | **B** | 建议 |
| F-1 | Learning Coach | 分析批次半持久化后重试抛 `duplicate-event` 永久卡死 | 确认 Bug | 🟠 | Coach 分析不可用 | 中 | orchestrator / repository | 中 | **B** | 建议 |
| F-3 | Learning Coach | in-progress 任务无超时/自动放弃，永久卡住并阻塞延迟验证 | 健壮性 | 🟠 | Coach 任务卡死 | 中 | stateMachines / orchestrator | 中 | **B** | 建议 |
| E-1 | AI | `max_tokens` 截断被忽略 → JSON 解析失败且不可重试 | 确认 Bug | 🟠 | AI 结构化输出失败 | 中 | aiClientService / aiGateway | 中 | **B** | 建议 |
| E-3 | AI | 会话切换不 abort 旧请求；`busy` 闭包可双提交 | 高风险 | 🟠 | AI 串台 / 双扣费 | 中 | AiChatPage / aiSessionService | 中 | **B** | 建议 |
| B-1 | 编辑器 | 多 tab 并发编辑无冲突检测，静默覆盖 | 高风险 | 🟠 | 内容静默丢失 | 中 | storageAdapter / RecordEditorPage | 中 | **B** | 建议 |
| Q-1 | 工程质量 | 完全没有 ESLint/Prettier，无 lint 脚本 | 技术债 | 🟠 | 无法拦 `no-floating-promises` 等 | 中 | 新增配置 + CI | 中 | **B** | 建议 |
| Q-3 | 构建 | playwright 硬编码本机 Chrome 路径 | 确认 Bug | 🟠 | CI 必失败 | 极低（删 2 行） | playwright.config.ts | 低 | **C** | 可顺手 |
| N-1 | Desktop | 安装目录/数据根硬编码 `D:\StudyJournal` | 确认 Bug | 🟠 | 无 D 盘机器无法安装 | 低 | installer.nsh / main.cjs | 低 | **B**（若要分发） | 建议 |
| N-2 | Desktop | `oauth-config.cjs` 未入库 → 安装包默认无法 Google 登录 | 高风险 | 🟠 | 桌面云同步登录不可用 | 中 | main.cjs / 发布流程 | 中 | **B**（若要该功能） | 建议 |
| **R2-13** | Android | `google-services.json` 未入库 → 干净环境构建 release APK 大概率失败 | 高风险 | 🟠 | **分发阻断** | 中 | Gradle / 发布流程 | 中 | **B** | 建议（若要分发） |
| **R2-14** | Desktop | asar 内 `dist` 经 `net.fetch(pathToFileURL)` 加载**未实测** | 待验证 | 🟠 | 若失败则桌面端完全打不开 | 极低（验证） | 仅验证 | — | **B**（先验证） | 建议 |
| **R2-4** | 编辑器 | 软删记录时立即删草稿，恢复不重建 | 健壮性 | 🟡 | 特定窗口内草稿丢失 | 低 | storageAdapter | 低 | **C** | 可顺手 |
| **R2-6** | 语音 | `ending` 态不在 `repairInterruptedSessions` 修复列表 | 健壮性 | 🟡 | 极端情况残留不可恢复态 | 极低 | repository | 低 | **C** | 可顺手 |
| **R2-7** | 语音/Android | 无 `appStateChange` 监听，Android 后台暂停仅靠 `visibilitychange` | 健壮性 | 🟡 | 后台可能未暂停采集 | 低 | audioFocus / VoiceRecallWorkspace | 中 | **C** | 可顺手 |
| **R2-8** | 语音 | VAD 换气停顿可能误判为说完并自动发送 | UX | 🟡 | 误发送 | 低（调参） | voiceActivity.ts | 中 | **C** | 可顺手 |
| **R2-9** | 配置 | ASR 无 Settings 等价项，只能在语音面板配置 | UX | 🟡 | 与「一次配置」心智不符 | 中 | providerProfiles / Settings | 中 | **D** | 不要动 |
| **R2-10** | 配置 | AI 与 TTS 撞同一密钥槽直接抛错阻断 | UX | 🟡 | 报错不友好 | 低 | productionPipeline | 中 | **C** | 可顺手 |
| R-5 | 备份/导出 | 导出写 podcasts 但导入不读 | 确认 Bug | 🟡 | 播客数据恢复后丢失 | 低 | backup.ts | 低 | **C** | 可顺手 |
| R-6 | 备份/导出 | UI 承诺「缺资源保留占位」与实际硬中止矛盾 | 确认 Bug | 🟡 | 恢复被中止 | 中 | storageAdapter / BackupPage | 中 | **C** | 可顺手 |
| C-1 | 复习 | 投影重建对缺 `stateAfter` 旧日志处理不一致 | 健壮性 | 🟡 | 投影与日统计不一致 | 中 | storageAdapter | 中 | **C** | 可顺手 |
| C-2 | 复习 | 时区双轨（UTC + 本地日），测试已依赖 UTC+8 | 健壮性 | 🟡 | 跨时区/跨设备边界错位 | 中 | date.ts / reviewScheduler | 中 | **C** | 可顺手（配 TZ 测试） |
| C-4 | 复习 | 评分无显式幂等键 | 架构 | 🟡 | 跨日/跨标签理论双计 | 中 | storageAdapter / ReviewPage | 中 | **C** | 可顺手 |
| E-2 | AI/配置 | 内置默认模型疑似无效（`deepseek-v4-pro`） | 确认 Bug | 🟠 | 开箱即用失败 | 低 | aiProviders / ttsProviders | 低 | **C**（先人工核实） | 可顺手 |
| E-6 | AI | 成功正文因写库失败而丢失 | 健壮性 | 🟡 | 回复丢失 | 低 | AiChatPage | 低 | **C** | 可顺手 |
| B-2 | 编辑器 | 卸载/隐藏时草稿 flush 不 await | 健壮性 | 🟡 | 草稿可能丢 | 低 | RecordEditorPage | 低 | **C** | 可顺手 |
| B-3 | 编辑器 | 草稿保存失败被静默吞掉 | 健壮性 | 🟡 | 用户误以为已存 | 低 | RecordEditorPage | 低 | **C** | 可顺手 |
| B-4/I-2 | OCR | 重试可能永久卡 `queued` | 健壮性 | 🟡 | OCR 卡死 | 中 | ocrJobService / storageAdapter | 中 | **C** | 可顺手 |
| J-1 | 统计 | 删除记录后复习统计仍计入（含 `recordReviewDayStats`） | 架构 | 🟡 | 统计失真 | 中 | learningStats / storageAdapter | 中 | **C** | 可顺手 |
| I-1 | 搜索 | 全文搜索全表线性扫描无索引 | 架构 | 🟡 | 大数据量慢 | 中 | search.ts / db schema | 中 | **C** | 可顺手 |
| P-2 | 性能 | PWA 预缓存 ≈19 MB，其中 mermaid chunk **606 KB**（`dist/assets/mermaid.core-*.js`，确实进了 precache） | 性能（设计取舍） | 🟡 | 安装下载体积偏大 | 低 | vite.config.ts | 低 | **C**⚠️ | 可顺手（**勿排除 mermaid**） |
| P-1 | 性能 | 主包 2,478 kB（gzip 709 kB） | 性能 | 🟡 | 首屏解析成本 | 中 | vite.config.ts | 中 | **C** | 可顺手 |
| Q-6 | 依赖 | `idb-keyval` **确认零引用**（全仓 0 命中）；`highlight.js` + `lowlight` 并存（`lowlight` 被 tiptap 使用，`highlight.js` 为伴生依赖） | 技术债 | 🟡 | 包体冗余 | 极低 | package.json | 低 | **C** | 可顺手 |
| O-1 | 持久化 | 版本号三处不一致；备份 manifest `appVersion` 硬编码 `0.1.0` | 配置 | 🟡 | 恢复时无法归属版本 | 低 | package.json / build.gradle / storageAdapter | 低 | **C** | 可顺手 |
| M-2 | Android | 无 `values-night`，DayNight 主题可能启动闪色 | 健壮性 | 🟡 | 启动观感 | 极低 | 新增 res/values-night | 低 | **C** | 可顺手 |
| Q-7 | 测试 | `desktop/installer.test.ts`、`desktop/ocr.test.ts` 无人执行 | 技术债 | 🟡 | 测试盲区 | 低 | vitest.config.ts | 低 | **C** | 可顺手 |
| **S-2** | 安全 | `exportPrivacy.PRIVATE_EXPORT_KEYS` 覆盖窄 | 防御缺口 | 🟠 | 目前未泄漏 | 极低 | exportPrivacy.ts | 低 | **C** | 可顺手 |
| H-1 | 配置 | 语音复述的 localStorage 覆盖层与 Settings **可能混搭出不一致组合** | 架构 | 🟡 | 部分场景配置不生效 | 低 | productionPipeline / providerProfiles | 中 | **E**（已下调，见 §7） | 不必 |
| H-4/H-5 | 配置 | 种子默认值不经校验；模板 `llmProfileId:"deepseek-v4-flash"` 是死值 | 技术债 | 🟡 | 无 | 低 | providerProfiles | 低 | **C** | 可顺手 |
| E-4 | AI | provider 能力未协商，强制发 `response_format`/`thinking` | 健壮性 | 🟡 | 部分供应商不兼容 | 中 | aiClientService | 中 | **C** | 可顺手 |
| E-5 | AI | token 仅本地启发式估算 | 健壮性 | 🟡 | 长上下文超窗 | 中 | aiContextService | 中 | **C** | 可顺手 |
| F-2 | Learning Coach | AI 蓝图未经逐项确认即入跨端同步实体 | 高风险 | 🟠 | 数据边界 | 中 | orchestrator / 同步白名单 / 导出 | 中 | **D**（需产品决策） | 需决策 |
| F-4 | Learning Coach | 投影一致性靠全表重算 | 架构 | 🟡 | 性能/遗漏 | 中 | repository | 中 | **C** | 可顺手 |
| F-5 | Learning Coach | 蓝图可引用已软删反馈 | 健壮性 | 🟡 | 陈旧引用 | 中 | replay / repository | 中 | **C** | 可顺手 |
| A-3 | App 基础架构 | StrictMode 双挂载重复执行初始化副作用 | 健壮性 | 🟡 | 重复后台任务 | 中 | useAppData | 中 | **C** | 可顺手 |
| A-6 | App 基础架构 | 缺 background→foreground 恢复逻辑 | 健壮性 | 🟡 | 后台返回状态停滞 | 中 | useAppData / App | 中 | **C** | 可顺手 |
| M-3 | Android | 无 `onSaveInstanceState` | 健壮性 | ⚪ | 低内存被杀后内存态丢失 | 中 | MainActivity | 中 | **E** | 不必 |
| M-5 | Android | release 未启用 minify | 技术债 | ⚪ | 包体 | 中 | build.gradle | 中 | **E** | 不必 |
| **R2-15** | 预览守卫 | `canPreviewUiV2` / `canPreviewVoiceRecall` **未排除 native/desktop**，而 Android WebView 的 hostname 就是 `localhost` | 健壮性 | 🟡 | 当前无触发路径 | 极低 | UiV2PrototypeApp / VoiceRecallPrototypeApp | 低 | **C** | 可顺手 |
| C-3 | 复习 | 同日重评 `elapsed_days=0`，不触发 lapse 惩罚 | 数据模型 | ⚪ | 语义问题 | 高 | reviewScheduler | 高 | **E** | 不必 |
| C-5 | 复习 | 切换 `reviewKind` 重置 FSRS 连续性未提示 | 技术债 | ⚪ | 语义问题 | 中 | storageAdapter | 中 | **E** | 不必 |
| D-1/D-2 | 复习 UI | 会话进度不持久化；rating 无显式提交中视觉 | UX | ⚪ | 体验 | 中 | ReviewPage | 中 | **E** | 不必 |
| L-2 | UI/UX | 评分撤回不持久化 | UX | ⚪ | 体验落差 | 中 | App.tsx | 中 | **E** | 不必 |
| G-1 | 语音 | 上一轮残流 token 污染下一轮 `teacherDraft` | 健壮性 | 🟠 | 显示污染 | 极低（加守卫） | VoiceRecallWorkspace | 低 | **C** | 可顺手 |
| G-3 | 语音 | `overridesFromConfig` 在 templateId 不匹配时静默丢弃 | 健壮性 | 🟡 | 覆盖失效无提示 | 极低 | productionPipeline | 低 | **C** | 可顺手 |
| G-4 | 语音 | barge-in 文档称未实现但代码已实现 | 文档不一致 | 🟠 | 验收口径混乱 | 极低（改文档） | docs | 低 | **C** | 可顺手 |
| G-2/G-5/G-6 | 语音 | generation 门控部分失效 / 原生回声未验收 / policy 预览共用组件 | 技术债 | ⚪ | 低 | 高 | 多处 | 高 | **E** | 不必 |
| A-4/A-5 | App 架构 | App.tsx 1821 行 / useAppData 80+ 出口 / ReviewPage 55 props | 架构 | 🟡 | 长期可维护性 | **高** | 全部页面 props 契约 | **高** | **D** | ❌ **不要动** |
| P-4 | 性能/备份 | 桌面版手动导出全内存，峰值 ≈ 体积 ×2~3 | 健壮性 | 🟠 | 大库导出卡死 | 中 | knowledgeExportService | 中 | **B** | 建议（与 R 系列同批） |
| Q-2 | 构建 | tsconfig 只覆盖 `src` | 架构 | 🟡 | desktop/e2e/scripts 无类型检查 | 中 | tsconfig.* | 中 | **C** | 可顺手 |
| Q-4 | 测试 | e2e 只测 localhost 预览路由，真实平台零自动化护栏 | 架构 | 🟡 | 平台回归无护栏 | 中 | playwright / e2e | 中 | **E** | 不必（记录即可） |
| Q-5/N-3/N-4 | 构建 | 旧 ui-v2 spec 残留 / 脚本硬编码 JDK 与版本 / icon 脚本 fire-and-forget | 技术债 | ⚪ | 无 | 低 | e2e / scripts | 低 | **E** | 不必 |

---

## 7. 本轮对第一轮的修正（重要）

**这是本轮最需要你注意的部分：三条第一轮/本轮早期的结论经复核被修正。**

### 7.1 已下调：H-1「配置体系多源分裂，无单一事实源」（原判 🔴 P0/P1 → 现判 🟡 E）

**第一轮的说法**：「语音复述走 localStorage 覆盖层，与 Dexie `settings` 互不回写 → 用户在 TtsSettingsPanel 改了模型，语音复述仍用旧值。」

**复核结论：该描述不准确，需下调。**

证据（`productionPipeline.ts:133-141`）：

```ts
const configuredLlm = input.config?.llmProfileId
  ? input.settings.ai?.providers.find((profile) => profile.id === input.config?.llmProfileId)
  : getCurrentAiProvider(input.settings.ai);          // ← 回退到 Dexie 设置里的当前 AI 供应商
const configuredTts = getCurrentTtsProvider(input.settings.tts);          // ← 读 Dexie 设置
const selectedTtsId = input.config?.ttsProfileId || configuredTts?.id || baseTemplate.ttsProfileId;  // ← 回退链
```

且启动页展示值同样回退（`VoiceRecallWorkspace.tsx:869-870`、`:882-885`）。

**⇒ localStorage 是「显式覆盖层」而非「影子副本」。** 只要用户没在语音设置面板里手动改过某条腿，语音复述就会沿用「更多 → AI 设置 / TTS 设置」里的配置。**「用户只需要配置一次」这件事基本成立。**

**真正残留的两个问题（降级后仍值得记录）：**
1. `overridesFromConfig` 在 `config.templateId !== templateId` 时**静默返回 undefined**（`:70-71`）→ stale localStorage 下的逐段覆盖被无声丢弃，用户无提示。
2. 覆盖层可能被用户改到与 Settings **混搭出不一致组合**（providerId 来自 Settings，endpoint 来自旧覆盖）。

**⇒ 修正后的分类：E（记录技术债），不再作为收口阻碍。**

### 7.2 已否定：流程 B「复习队列里出现无题可答的记录」

**本轮侦察的说法**：「删掉正文里的决策块后，复习状态仍在、`currentDecisionBlocks` 为空 → 无题可答却出现在队列中。」

**复核结论：不成立，属优雅降级。**

证据：`ReviewPage.tsx:1047` 用 `currentDecisionBlocks.length > 0 && (...)` 条件渲染「复习重点评论」区块；而 `:1036-1038` 在**所有情况下都渲染整篇记录的只读正文**：

```tsx
<RichTextEditor value={normalizeRecordContent(currentRecord)} onChange={() => undefined} … />
```

**⇒ 决策块为空时，复习卡片照样展示完整记录内容**，只是少了一个额外的反思输入区。复习以「整条记录」为单位是设计意图，不是缺陷。

### 7.3 已否定：「ImageLightbox 未拦截返回键」

（第一轮已否定，本轮复核维持）`App.tsx:739` 主动礼让，`ImageLightbox.tsx:203-217` 自行关闭。

### 7.4 本轮新发现的守卫缺口（需记录）

**R2-15（🟡 低）**：10 个预览/原型路由守卫中有 **8 个**正确排除了原生与桌面平台（`stage3PreviewSeed.ts:599-650` 的 7 个 + `App.tsx:112`），但：

```ts
// src/preview/UiV2PrototypeApp.tsx:102-106
const canPreviewUiV2 = (): boolean => {
  const host = window.location.hostname;
  return (host === "127.0.0.1" || host === "localhost") && …get("preview") === "ui-v2";
};   // ← 没有 isNativePlatform() || isDesktopPlatform() 短路

// src/preview/VoiceRecallPrototypeApp.tsx:40-43  ← 同样的写法
```

而 `capacitor.config.ts:8` 设置 `androidScheme: "https"` → **Capacitor Android WebView 的 `window.location.hostname` 就是 `localhost`**。因此「hostname === localhost」在原生环境**不构成有效排除**。

**当前无实际触发路径**（无 deep-link intent-filter，App 内无代码改写 URL），故列为健壮性缺口而非确认 Bug。但这是一个**容易在后续开发中踩雷的模式**。

### 7.5 已更正：P-2「mermaid 零引用」（错误结论 → 已修订）

**原说法**：「PWA 预缓存 ≈19 MB，mermaid chunk 被拉进 precache，而 **mermaid 实际零引用** → 19 MB 全无收益。」

**复核结论：前半句属实、后半句错误。**

- ✅ 属实：`dist/assets/mermaid.core-CTt3QPE9.js`（**606 KB**）确实出现在 `dist/sw.js` 的预缓存清单里。
- ❌ **错误**：mermaid **并非零引用**。`src/components/RecordMermaidNode.tsx:14-26` 用 `import("mermaid")` **有意懒加载**，并附注释说明「mermaid.js 体积很大，只有少数用户会用到，故延迟加载」。

**⇒ 结论翻转**：precache 里带上 mermaid，是为了**让 mermaid 图在离线状态下仍可渲染**，属**有意的功能取舍**，不是浪费。
**⇒ 行动改变**：**不要**按原建议「收窄 globPatterns 排除 mermaid」——那会破坏离线 mermaid 渲染。P-2 从此前的「优先清理」下调为 C 类技术债，且不计入收口相关项。

（同类更正：Q-6 中「`mermaid` 亦零引用」一句作废；`idb-keyval` 经全仓 grep **确认 0 命中**，死依赖结论维持。）

---

## 8. 修复 ROI 复核与收口判断

### 8.1 分类汇总（A–E）

| 分类 | 含义 | 数量 | 明细 |
| --- | --- | --- | --- |
| **A 现在必须修** | 不修就不应进入收口 | **10** | K-1、A-1/K-3、A-2、R-1、R-2、R-3、R-4、S-1/H-3/M-4、**R2-1**、M-1（真机核实后） |
| **B 建议现在修** | 收益明显高于风险 | **14** | R2-3、R2-5、**R2-16**、F-1、F-3、E-1、E-3、B-1、Q-1、N-1、N-2、R2-13、R2-14、P-4 |
| **C 可顺手修** | 局部、低风险、收益不错 | **~30** | 见 §6 表内标记 C 的行 |
| **D 暂时不要动** | 技术上有问题，但修改风险 > 当前收益 | **3** | **A-4/A-5（App.tsx 巨构拆分）**、F-2（需产品决策）、R2-9（ASR 配置项统一） |
| **E 记录为技术债** | 当前可接受 | **~12** | H-1（已下调）、C-3、C-5、D-1/D-2、L-2、G-2/G-5/G-6、M-3、M-5、Q-4、Q-5/N-3/N-4 |

### 8.2 收益 / 风险四象限

|  | **低修复风险** | **高修复风险** |
| --- | --- | --- |
| **高收益** | 🔥 **优先全做**：K-1、A-1/K-3、A-2、R-4、S-1、**R2-1**、**R2-16**、R2-3、R2-6、R2-15、G-1、G-3、G-4、S-2 | ⚠️ **做但要分批**：R-1/R-2/R-3（都在 `storageAdapter` 一处，需一起做 + 完整回归）、M-1（需真机） |
| **低收益** | ✅ 顺手清：O-1、M-2、Q-7、B-2、B-3、R2-2、R2-4、R2-10、H-4/H-5、P-2、Q-6 | ❌ **不要碰**：A-4/A-5 巨构拆分、C-3 同日重评语义、G-5 原生回声 |

> **P-2 的特别说明（修订）**：第一轮/本轮早期把它描述为「mermaid 零引用却被打进 precache，19 MB 全无收益」——**该描述有误，已更正**。mermaid 被 `RecordMermaidNode.tsx:20` 以 `import("mermaid")` **有意懒加载**（注释明写「只有少数用户会用到，故延迟加载」），chunk 606 KB 进 precache 是为了**让 mermaid 图在离线时也能渲染**，属有意取舍。
> **⇒ 不要为了缩小体积去排除 mermaid** —— 那会破坏一个真实功能。真正可做的是评估字体/KaTeX 等更次级资源的预缓存必要性。

### 8.3 特殊提醒：三类「看起来很高级、实际会引发大范围回归」的改动

1. **`App.tsx`（1821 行）/ `useAppData`（80+ 出口）/ `ReviewPage`（55 props）的拆分重构** —— 会导致**全部页面 props 契约变化**，使本轮所有修复的验收失去可归因性。**明确建议本阶段完全不做**，仅在文档记为已知债务。
2. **`assertSnapshotIntegrity` 从「硬报错」改为「降级警告」** —— 这是 backup 语义的策略变更，会同时影响导出、恢复、记录转移、decision-block 导入四处（`storageAdapter.ts:1933/2008/2062/2172`）。**必须单独一个变更窗口**，且必须先确定「缺资源时到底该导出成功还是失败」。
3. **统一 ASR 配置入口（R2-9）** —— 会牵动 `providerProfiles` / 语音设置面板 / Settings 三处，而 ASR 密钥槽与 AI/TTS 密钥槽的命名规则不同（`voice-asr-doubao` / `voice-asr-aliyun` vs provider id）。**收益是心智一致性，风险是打乱已验证的凭据解析**，建议延后。

---

## 9. 最终回答：StudyJournal 是否可以进入收口维护阶段？

### 9.1 当前项目是否已经基本达到「可以收口」的状态？

**接近，但还差 10 项 A 类。**

值得强调的是：**本轮没有发现任何新的「系统性烂掉」的模块。** 五个专项走下来，结论是：

- **流程 A 完全闭环**（数据读写同源，无独立缓存层，搜索缓存失效策略正确）。
- **流程 B / C / D / E 都是「基本闭环 + 少量接缝」**，而不是「断裂」。
- **异常恢复的总体质量超出预期**：`loading` 与 `finally` 的配对几乎完美（本轮逐个文件核对）；语音的暂停/恢复/失败重试/系统杀死恢复全部安全；FSRS 评分在单事务内，无 half-state。
- **安全边界大部分做对了**：密钥不进日志、不进 prompt、不进备份、不进云同步、不进 renderer；无遥测；`reviewAnnotationDrafts` 与 `voiceRecall*` 的 device-local 声明**逐条核对属实**。
- **Dev/Prod 差异几乎为零风险**：无 `import.meta.env` 依赖、无 dev-server 路径、三宿主路径假设成立、SW 有防循环机制。

**真正阻止收口的是三类具体问题，且都不需要大改：**
1. **错误不可见**（K-1 + A-1 + A-2）—— 让所有修复无法验证。
2. **备份与资源安全**（R-1~R-4 + R2-1）—— 备份是最后防线，且 R-3 会不可逆地删数据。
3. **隐私声明与实现矛盾**（S-1）—— `allowBackup="true"` 让「纯本地」承诺不成立。

### 9.2 如果不能收口，最主要的阻碍是什么？

**一个根因 + 两个数据安全问题：**

1. **「错误不可见」是唯一的结构性阻碍。** 58 处静默吞错 + `normalizeUiError` 丢弃错误对象 + 零 ErrorBoundary，三者叠加的后果是：**你无法知道当前系统里还藏着什么**。这也解释了为什么你最近的 ZIP 导出失败只得到一句「操作没有完成」。
   **它的修复成本是 1 行日志 + 1 层兜底组件，却是其他所有修复能被验证的前提。**
2. **R-3（孤儿清理不扫 `templates`）会不可逆地删掉仍被引用的图片**，并从此让四条备份通道一起永久失效。这是**破坏性**的，不是体验问题。
3. **「删除 ↔ 恢复」不对称** —— 两个同源问题（`useAppData.ts:292-320` 的删除族缺少对应的恢复族补偿）：
   - **R2-1**：恢复记录后**复习计划被静默清零**，回收站**完全不提示**。
   - **R2-16**：恢复记录后**语音复述被永久标记不可恢复**（`sourceUnavailable` 单向不可逆）。
   二者的共同特征是：**用户以为自己只是撤销了一次删除，实际下游能力被静默作废，且无处可查。**

### 9.3 如果现在开始修复，哪些应该一起修、哪些应该严格分开？

**建议一起修的 6 个批次：**

| 批次 | 内容 | 为什么合并 |
| --- | --- | --- |
| ① 错误可见性 | K-1 + A-1 + K-3 + A-2 | 同一根因的四个面；都在 `uiError.ts` / `main.tsx` / `App.tsx` / `useAppData.ts` |
| ② 备份与资源安全 | R-1 + R-2 + R-3 + R-4 + R-5 + R-6 + P-4 | 全部在 `storageAdapter` 的导出/恢复/清理三处；R-3 是 R-1/R-2 的根因制造者，分开修会留半成品 |
| ③ 数据生命周期一致性 | **R2-1** + **R2-16** + R2-2 + R2-3 + R2-4 + R2-5 | 全是「删除后下游数据怎么办」以及「恢复时该补偿什么」；集中一次改完 `deleteBlock`/`restoreBlock`/`permanentlyDeleteBlock`/purge 四条路径（R2-1 与 R2-16 同源于 `restoreBlock` 缺少补偿，必须同批） |
| ④ 隐私与 Android 合规 | S-1 + S-2 + M-4 + M-2 + M-1 | 全在 Android 侧；M-1 需真机，一次装包验证 |
| ⑤ AI 可靠性 | E-1 + E-3 + E-6 | 同一请求生命周期 |
| ⑥ 工具链与死代码 | Q-1 + Q-3 + Q-2 + Q-7 + Q-6 | 引入 ESLint 后能顺手拦住 `no-floating-promises`，并清掉零引用的 `idb-keyval`（⚠️ **`mermaid` 不在此列，它被有意使用**，见 §7.5） |

**必须严格分开修的 5 项：**

| 项 | 理由 |
| --- | --- |
| **A-4/A-5（App.tsx 巨构拆分）** | 会改动全部页面 props 契约，混入则其余所有修复失去可归因性。**本阶段完全不做。** |
| **M-1（Android insets）** | 必须先真机确认到底是「被遮挡」还是「环境变量为 0 但布局正常」，再二选一。**在核实前不要动 CSS 或 Manifest。** |
| **F-2（AI 蓝图入正式库边界）** | 涉及同步白名单与备份导出剥离，会跨到本轮排除的两个模块。**需要你先做产品决策。** |
| **R-2（完整性校验策略）** | 「硬报错 vs 降级警告」是产品语义变更，影响导出/恢复/记录转移/decision-block 导入四处。单独窗口 + 单独回归。 |
| **C-2（时区双轨）** | 涉及日期语义，必须配「固定 TZ 的测试」独立验收。 |

**一句话建议：**

> **先修「能不能看见错误」（批次 ①），再修「数据丢不丢」（批次 ②③），然后修「隐私承诺是否成立」（批次 ④）。**
> 批次 ① 只需一行日志 + 一层兜底，却是后面所有修复能被验证的前提。
> 至于 `App.tsx` 1821 行的巨构 —— 它确实是最大的长期架构债，但**现在动它的风险远大于收益**，建议明确记录并留到下一周期。

---

## 附录：本轮未覆盖 / 无法定论的项（如实声明）

1. **远端最新代码** —— 网络仍不通，未拉取；若远端有新 commit 需重核。
2. **云同步 / 自动备份内部策略** —— 按要求排除。
3. **Android 真机行为** —— M-1（insets）、R2-7（`appStateChange`）、`dataSync` 前台服务后台启动、原生回声消除与音频焦点，**均只有真机能定论**。
4. **Desktop 实际安装包** —— 未执行 `desktop:build` 并安装；R2-14（asar + `net.fetch`）只能实测。
5. **Android release APK 的实际构建** —— 未执行（缺 `google-services.json`，且会触发网络下载）；R2-13 是静态推断。
6. **真实 AI / ASR / TTS / OCR provider 的端到端行为** —— 涉及付费调用，未执行。
7. **Playwright e2e** —— 未运行（环境无硬编码路径上的 Chrome）。
8. **Desktop OAuth token 的过期刷新与 logout 清除** —— 本轮未追踪到明确证据，**不做结论**。
9. **性能基准** —— 仅工程层面静态审查。
