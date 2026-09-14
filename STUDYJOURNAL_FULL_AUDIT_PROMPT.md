# StudyJournal 收口阶段 · 全规模工程审计 Prompt

> **用法**：把本文件「第 0 节」及之后的内容整段复制给 Coding Agent（Claude Code / Codex CLI / Cursor Agent 等），在仓库根目录 `D:\StudyJournal-Source` 以 Agent 模式运行。
> 建议分两轮：第一轮只审计（默认，只读）；确认报告后，再单独授权第二轮修复。
> 文末「附录 C：可调开关」列出了常用的裁剪方式。

---

## 0. 角色与总目标

你现在是本仓库的**独立第三方工程审计员**。项目即将收口，我要在冻结之前完成一次**全规模审查**，目标是找出：

- **A. 潜伏 Bug**：开发过程中被忽略、被我漏掉的；实际使用中因为路径冷门而没暴露的；目前已经存在但不明显、不定时才会触发的。
- **B. 代码与接口清理项**：已经废弃但还留着的接口；**根本不可能真正工作的「假接口」**（有壳无实现、永不进入的分支、永远为假的开关、没有接线的配置项）；**以前能用、现在不能用了的接口**（回归）。

请以「**找到真问题**」为唯一成功标准，而不是「写出一份好看的报告」。**漏报比误报更严重，但误报会浪费我的收口时间**——所以每一条都必须有代码证据。

---

## 1. 硬约束（违反即视为本轮审计失败）

1. **默认只读**。本轮不得修改任何 `src/`、`android/`、`desktop/`、`functions/`、`scripts/`、配置与数据库代码，不得提交 commit / PR / push。报告写成一个新文件即可（见 §9）。
2. **不得调用任何真实付费服务**。禁止使用或向我索要真实 API Key（阿里云、DeepSeek、Fish Audio、豆包、SiliconFlow、PaddleOCR 等），禁止执行 `*.live.test.ts`，禁止跑 `test:firebase` 之外的真实 Firebase 项目。所有验证使用确定性 mock / 本地 Emulator / 本地 WebSocket 服务端。
3. **不得动冻结面**。schema 21 的 store 定义、语音系统提示词文本与 prompt version、`docs/` 下已冻结的设计基线，本轮一律不改、不提议改（可以指出矛盾，但不要当作修复动作）。
4. **每个结论必须有证据**。格式：`文件路径:行号` + 简述「怎么读出来的」。仅靠函数名/注释/文档推断的，必须显式标注 `【仅静态推断】`，不得与已验证结论混排。
5. **区分「确认」与「怀疑」**。置信度必须显式给出（高 / 中 / 低）。无法在静态层证伪的，进「需人工或真机验证」清单，**不要**判断为已确认 Bug。
6. **不要把已声明为「未实现」的功能当成 Bug**。见 §3 降噪清单。
7. **不要输出风格偏好**（命名、缩进、注释密度、是否用 `any` 的审美问题）。只报会导致错误行为、数据不一致、不可用、误导用户、维护陷阱的问题。
8. **禁止臆造行号**。所有行号必须来自你实际读取的文件内容。行号对不上时，宁可只写文件名 + 函数名。

---

## 2. 项目基线（先建立事实，再开始审查）

**技术栈**：React 18 + TypeScript 5.7 + Vite 6 + Dexie(IndexedDB) schema 21；Capacitor 8 → Android；Electron 43 → Windows 桌面；Firebase 12（Auth / Firestore / Storage）+ Cloud Functions；PWA（vite-plugin-pwa）。
**规模**：`src/` 约 385 个 `.ts/.tsx`、约 8.0 万行；22 个页面；49 个 components 文件；`android/` 18 个 Java 源文件（11 个 Capacitor Plugin）；`desktop/` 4 个运行文件 + 1 个安装脚本；`functions/` 2 个源文件；`e2e/` 13 个 spec。
**既有审计基线**（必须先读，避免重复劳动，但**不得直接采信其结论**，要独立复核）：

- `AGENTS.md`（工程约束与边界，权威）
- `docs/audit/full-engineering-audit-2026-09-13.md`（第一轮全量审计）
- `docs/audit/round2-closeout-special-audit-2026-09-13.md`（第二轮收口专项，含对第一轮的修正）
- `docs/audit/voice-call-natural-conversation-audit-2026-09-14.md`
- `docs/audit/cloud-sync-backup-boundary-audit-2026-09-13.md`
- `docs/audit/zip-export-failure-diagnosis-2026-09-13.md`
- `STUDYJOURNAL_AUDIT_REPORT.md`、`audit/second-review/REPORT.md`（更早两轮）
- 冻结与边界：`docs/voice-recall-freeze-2026-09-11.md`、`docs/voice-call-natural-conversation-freeze-2026-09-14.md`、`docs/新的方案.md`

**你必须先执行并原样记录输出**（这是报告的「确定性证据」节）：

```bash
git status --short
git log --oneline -20
git rev-parse HEAD
npx tsc -b
npm run test -- --exclude "**/*.live.test.ts"
npm run test:voice-host
npm run test:e2e
npm run build
git diff --check
```

> 注意：工作区当前**有未提交改动**（`src/features/voiceRecall/*`、`src/lib/recordContent.ts`、`src/services/aiContextService.ts`、`AGENTS.md` 等）以及未跟踪文件（`src/lib/aiTokens.ts`、`src/features/voiceRecall/contentBoundary.ts`、`docs/audit/`、`img/`、`output/` 等）。**以工作区现状为审计对象**（不是 HEAD），并在报告中明确写出这一点。若某个测试失败，先判断是既有失败还是环境问题，如实记录，不要「跳过」。

`AGENTS.md` 声称的自动化基线为：163 个确定性 Vitest 文件 / 1021 项测试、54 个 Playwright 用例、4 个 Firebase Emulator 用例。**请核对实际数字并指出偏差**——数字对不上本身就是一条发现。

---

## 3. 降噪清单（以下不算 Bug，不要写进问题表）

1. 文档已明确声明为「未实现 / 预支持 / future work」的能力。已知包括：SiliconFlow 实时 ASR、打断（barge-in）、PCM/Opus 无缝播放、批注的选择变换/分组/图层/孤立修复/完整 Excalidraw 对齐、豆包端到端实时语音（仅预支持）、iOS。
2. 文档已明确列为「**发布门禁**」而非缺陷的项：真机物理键/IME/系统返回/图片手势、真机音频行为、按钮打断、豆包真实账号验收、Firebase 真实账号配额签署、知识导出 markdown 格式变更。
3. `candidate` 状态的 Provider 方案（`voice-default-cn@2`、豆包语音各 profile）——未验证不等于有 Bug，除非你发现**代码与它自称的能力不符**。
4. 测试用 mock / `?preview=*` 预览壳本身的存在。但**它们是否泄漏到生产构建或原生壳**，那另当别论（见 §5.2 与 §6.1）。
5. 纯样式、命名、注释、依赖版本升级建议、代码风格。

---

## 4. 覆盖矩阵（必须逐项交付，不允许留空）

请对下列 **23 个模块** 逐个交付一节结论，每节必须包含：`结论（健康 / 有隐患 / 有问题）` + `实际读取的文件` + `发现条目编号` + `已验证干净的点`。

| # | 模块 | 主要文件域 |
|---|------|-----------|
| M01 | 启动 / 全局架构 / 路由 | `src/main.tsx`、`src/App.tsx`(1821 行)、`src/types.ts`(1122 行)、`src/hooks/useAppData.ts`(1086 行)、`src/features/reviewSession/runtime.ts` |
| M02 | 数据层 / 迁移 / schema | `src/db/database.ts`、`database.migration.test.ts`、`defaults.ts`、`reviewCoachSchema.ts` |
| M03 | 日志 / 记录 / 今日 | `pages/JournalPage`、`TodayPage`、`FavoritesPage`、`TrashPage`、`components/DayLogCard`、`components/RecordTagChips` |
| M04 | 编辑器 / 富文本 / 结构块 | `pages/RecordEditorPage`、`components/RichTextEditor`、`RecordEditorNodes`、`RecordStructureNodes`、`RecordMermaidNode`、`RecordHighlightBlockNode`、`RecordDecisionBlockNode`、`StructureInsertMenu`、`TemplateInsertMenu`、`components/RecordReferencePicker`、`pages/TemplateLibraryPage`、`CategoriesPage` |
| M05 | Markdown / 序列化 / 迁移 | `lib/markdown*`、`markdownEditor`、`markdownLinkMark`、`markdownInputRules`、`markdownPasteWork`、`recordContent`、`recordMigration`、`recordStructureBlocks`、`trailingEditableParagraph` |
| M06 | 复习 / FSRS / 复习流程 | `lib/reviewScheduler`、`pages/ReviewPage`、`components/PlaybackProvider`、`components/DeferredMath` |
| M07 | 复习批注 | `features/reviewAnnotations/*` |
| M08 | Review Coach / Learning Coach | `features/reviewCoach/*`（约 30 个文件）、`AdaptiveReviewPage`、`ReviewCoachWorkbench` |
| M09 | AI 能力 / AI Cockpit | `services/aiClientService`、`aiContextService`、`aiSessionService`、`aiChatAttachmentService`、`aiRetry`、`dayLogAiContextService`、`lib/aiProviders`、`lib/aiTokens`、`pages/AiChatPage`、`AiToolsPage`、`AiExportPage`、`components/AiMarkdown`、`AiKnowledgeScopePicker` |
| M10 | 语音复述 / Voice Tutor | `features/voiceRecall/*`（约 70 个文件、含 3 个 CSS）、`android/*NativeVoiceAsrPlugin`/`NativeVoiceCapturePlugin`、`desktop/voiceAsrSocket.cjs`、`src/preview/VoiceRecallPrototypeApp.tsx` |
| M11 | TTS / 知识播客 | `lib/ttsProviders`、`lib/doubaoTts`、`services/nativeTts`、`nativePodcastTts`、`knowledgePodcastService`、`knowledgePodcastJobService`、`pages/KnowledgePodcastPage`、`PodcastTemplatesPage`、`TtsSettingsPage` |
| M12 | OCR | `services/ocrService`、`ocrSettings`、`ocrDiagnostics`、`ocrJobService`、`desktopOcr`、`nativeOcr`、`pages/OcrSettingsPage`、`desktop/ocr.cjs` |
| M13 | 搜索 | `lib/search`、`pages/SearchPage` |
| M14 | 统计 / 数据可视化 | `lib/learningStats`、`components/Heatmap`、`MonthlyHeatmap`、`pages/StatsPage` |
| M15 | 备份 / 恢复 / 导出 / 转移 | `services/backup`、`autoBackup*`、`streamingBackupService`、`nativeAutoBackup*`、`nativeRepositoryBackupService`、`nativeZipArchive`、`importRestoreService`、`restoreLockService`、`recordTransferService`、`knowledgeExportService`、`assetDownloadService`、`exportPrivacy`、`recordDraftBackup`、`pages/BackupPage` |
| M16 | 云同步 / Firebase | `services/cloudSync*`、`cloudSyncModel`、`syncAdapters`、`firebase.ts`、`firebaseStorageUsage*`、`firestore.rules`、`storage.rules`、`functions/src/*`、`pages/SettingsPage`(同步区) |
| M17 | 媒体 / 附件 / 图片 | `services/mediaPlaybackService`、`nativeMediaPlayback`、`lib/audio`、`lib/recordings`、`lib/imageTransform`、`nativeImagePicker`、`components/AssetPreview`、`ImageLightbox`、`pages/RecordingsPage` |
| M18 | 设置中心 / 导航 / 布局基础 | `pages/SettingsPage`、`MorePage`、`AiToolsPage`、`UsageGuidePage`、`lib/visualTheme`、`tabNavigation`、`webNavigationHistory`、`viewport`、`layoutOverflow`、`popoverPosition`、`lib/entity`、`subjects`、`date`、`format`、`dailyMotto`、`clipboard` |
| M19 | 视觉层 / 样式 | `src/styles/*.css`、`src/features/voiceRecall/*.css`、`src/preview/uiV2Prototype.css`、`styles.css` |
| M20 | 预览壳 / 调试入口 | `src/preview/*`、`App.tsx` 中的 `?preview=` 分支、`audit/second-review/probes.test.tsx` |
| M21 | Android 宿主 | `android/`（18 个 Java 文件、`AndroidManifest.xml`、`build.gradle`、`capacitor.config.ts`）、`scripts/android-*.ps1` |
| M22 | Desktop 宿主 | `desktop/main.cjs`、`preload.cjs`、`ocr.cjs`、`voiceAsrSocket.cjs`、`installer.nsh` |
| M23 | 构建 / 测试基础设施 / 脚本 | `vite.config`、`vitest.config`、`playwright.config.ts`、`tsconfig*.json`、`firebase.json`、`functions/package.json`、`scripts/*.ps1`、`e2e/*`、`src/test/fixtures/*` |

---

## 5. 任务 A：潜伏 Bug 排查

### 5.1 通用 Bug 分类（逐类在全部 23 个模块扫一遍）

1. **异步竞态**：`await` 之间状态被改写；缺失的取消/代次校验；StrictMode 双挂载；Stale closure 读到旧 state。
2. **静默失败**：空的 `catch`、被吞掉的 `Promise`、`catch` 里只 `console.warn` 而不上报 UI、`fire-and-forget` 的原生调用。
3. **错误路径未覆盖**：网络失败、超时、权限拒绝、磁盘满、配额超限、文件不存在、JSON 解析失败、部分写入后中断。
4. **事务与原子性**：跨表写入未包在 `db.transaction` 内；失败后留下「半写状态」；索引与数据不一致。
5. **并发与多标签页**：两个标签页同时写；同一设备重复点击导致重复创建；`restoreLockService` 的锁是否真的覆盖所有入口。
6. **数据边界泄漏**：**本设备的敏感/临时数据出现在不该出现的序列化路径里**（本项目最高价值的一类，见 §5.2）。
7. **平台分歧**：同一逻辑在 Web / Desktop / Android 三分支上行为不一致，或某分支永远不会被走到。
8. **生命周期**：组件卸载后 setState / 播放未停 / 监听器未摘 / 定时器未清 / ObjectURL 未 revoke / 摄像头麦克风未释放。
9. **时间与时区**：`new Date()` 与本地日界、跨天边界、"今天" 的计算、时区偏移导致的复习到期判断偏差。
10. **编码与文本**：UTF-8 与 UTF-16 混用、base64 编解码、代理对/emoji 被 `substring` 切断、中文被按字节切割。
11. **数值与边界**：`NaN`/`Infinity`/负数/0 的除法、空数组取 `[0]`、token 估算与实际偏差导致超限。
12. **状态机非法迁移**：本项目的状态机与编排器很多，检查是否存在未覆盖的转换、终态被再次写入、撤销后状态回退错误。
13. **ID 与哈希稳定性**：跨设备必须产生相同 hash 的 ID/时间戳是否真的确定性（随机数、`Date.now()`、`nanoid` 混入会导致同步冲突）。
14. **迁移幂等性**：重复执行迁移是否安全；迁移中断后能否重试；旧数据缺失字段时的默认值。
15. **输入校验缺口**：来自「不可信学习内容」的文本是否会被当作指令/HTML/正则注入。

### 5.2 本项目的高危怀疑点（逐条求证，不要跳过任何一条）

这一节是**种子假设**——请对每条给出「**成立 / 不成立 / 证据不足**」的明确结论，并附代码证据。不成立也要写出来（写成「已验证干净」，这对我同样有价值）。

**语音与本地数据边界（最高优先级）**

- H1. `voiceRecallSessions`、`voiceRecallTurns`、`voiceRecallLocalHistory` 是 schema 21 的**纯本机** store，`AGENTS.md` 声称它们「永不进入 Firebase、ZIP/流式/原生备份、知识导出、记录转移、云端变更记账」。请**穷举所有序列化/上传/导出路径**逐一核对：`cloudSyncModel` 的实体映射表、`syncAdapters`、`backup.ts`、`streamingBackupService`、`nativeRepositoryBackupService`、`nativeAutoBackup*`、`knowledgeExportService`、`recordTransferService`、`exportPrivacy`、以及任何直接 `db.<table>.toArray()` 的导出。**哪怕只发现一条路径漏过滤，就是 P0。**
- H2. 同理核对 `reviewAnnotationDrafts`：不进入云同步 / 备份 / 知识导出 / 记录转移，且**批注写入不得标记为云变更（cloud mutation）**。检查是否有路径调用了 mutation 记账。
- H3. `userMuted` 与 `systemCaptureGate` 是否真的互相独立？是否存在某个分支用其一去覆盖另一者的状态？
- H4. `NativeVoiceCapture` 与 `NativeAudioRecorder` 两条 Android 麦克风链路是否真的**互斥**？请找出所有可能同时打开麦克风的调用序列（含异常路径与快速切换）。
- H5. 音频焦点（`audioFocus.ts`）的引用计数是否在所有失败/异常路径上都正确释放？是否存在双重释放或泄漏导致「第二次通话没声音」？
- H6. 取消机制（`cancellation.ts` + 操作代次）：是否有回调在取消之后仍写入正式数据？失败/取消的轮次是否可能被保存为正式结果？
- H7. `max_tokens` 的 224 默认 / 250 上限是否在**所有**构造请求的路径上生效（含重试、含兜底适配器、含自然对话与非自然对话两条链）？`voiceThinkingMode` 为假时是否保证不发送 `thinking`、且 reasoning delta 不被转发给 TTS？
- H8. ASR 分片与中文边界：`sse.ts`、`sentenceBuffer.ts`、`playbackQueue.ts`、`ttsFallbackAdapters.ts` 在 chunk 恰好切断一个多字节字符 / 半句话时是否安全？base64 音频在边界处是否可能不完整？
- H9. `contentBoundary.ts`：不可信学习内容的标记是否覆盖**所有**注入提示词的入口（含历史消息、用户确认文本、摘要）？
- H10. 桌面宿主：`desktop/voiceAsrSocket.cjs` 的 IPC 通道名（`study-journal:voice-asr-*`）与 `preload.cjs` 白名单、与渲染进程调用处**三方是否完全一致**？帧类型（string / Uint8Array / text / binary）在 Electron 与 Android 两条路径上是否对称？（早期审计曾在此处发现过回归，请重点核对现状。）
- H11. 凭据（`credentials.ts`）：是否可能出现在日志、诊断导出（`diagnostics.ts`）、错误消息、崩溃报告、备份或同步数据中？

**云同步与备份**

- H12. **新增字段的同步覆盖**：`types.ts` 中比较新的实体字段，是否都进了 `cloudSyncModel` 的映射与 `syncAdapters`？漏映射 = 静默丢数据。请逐个实体做字段级对照表。
- H13. 云上 review event 历史声称「append-only，本地保留期压缩不得删除远端事件」。检查是否存在任何删除远端事件的代码路径。
- H14. 无操作同步（no-op）是否真的跳过了云锁？大读写计划是否真的需要显式确认？（检查阈值判断是否可能被绕过。）
- H15. 完整恢复 vs 云同步对「本机临时表」的处理是否与文档一致（恢复清空临时会话/轮次但保留既有本机历史；云同步三者全保留）。
- H16. 导出隐私边界：提示词、Provider 原始响应、密钥在 **四个边界**（云、ZIP、流式、原生仓库）是否都被剥离？是否存在某个边界漏剥？
- H17. ZIP 路径与编码：Windows 反斜杠、中文文件名、大文件流式写入、中断后的残留临时文件。
- H18. `restoreLockService`：恢复期间的用户写入是否被真正阻止（而不只是 UI 禁用）？

**复习与 Coach**

- H19. 正式写入是否**全部**经由 `src/features/reviewCoach/repository.ts`？在整个仓库 grep 直接写 Coach 相关表的位置（例如绕过 repository 的 `db.*.put/add/bulkPut`），列出任何越权写入。
- H20. `orchestrator.ts` 与 `useAppData.ts` 的职责边界是否被打破（跨实体流程是否混进了 hook）？
- H21. 投影（projection）是否真的可以仅从正式事实重建？是否存在「AI 响应 / 本地执行缓存」被当作真相源读取的路径？
- H22. 记录级 FSRS 是否被决策块事实静默改写？语音练习是否真的**从不**写 FSRS、不自动评分？
- H23. 启动时创建验证任务所用的 ID 与队列时间戳是否**确定性地**由验证事实推导（两台设备是否会产生同一 hash）？请实际验证推导链中不含 `Date.now()` / `random`。
- H24. schema 11/16 → 21 迁移是否事务化且可重试？中断后重跑是否幂等？
- H25. 撤销评分的补丁：跨标签页、重新打开数据库、以及「撤回后旧批注不恢复」的语义是否与文档一致？

**编辑器与内容**

- H26. `recordContent.ts` 最近修过「折叠块/高亮块中嵌套公式被重复计入纯文本」的问题。请检查**同类重复提取**是否在其它节点（模板、引用块、代码块、任务列表、mermaid）仍然存在。
- H27. `RecordBlock.contentHtml` 是唯一可编辑真相源，`DecisionBlock` 只是索引。是否存在反向写回、双写、或从索引回写正文的路径？
- H28. Markdown 往返（`markdown.ts` / `markdownEditor.ts`）：特定嵌套结构（公式+折叠、高亮内换行、代码块内 `$$`、表格内管道符）是否能无损往返？请给出你实际试算的最小样例（可在报告中贴代码块，不必运行）。
- H29. 中文输入法（IME）组合态下的 `input` 事件处理、粘贴大文档（`markdownPasteWork`）、拖放图片、`trailingEditableParagraph` 不变量。
- H30. 多标签页同时编辑同一记录：草稿与已保存内容的冲突处理；`recordDraftBackup` 是否会覆盖更新的内容。

**AI / OCR / TTS**

- H31. 重试策略（`aiRetry.ts`）：确定性失败（密钥错、Base URL 错、跨域、结构不匹配）是否真的**不重试**？`AbortSignal` 是否真的贯穿到每一层（含 fetch 与原生调用）？
- H32. token 预算（`aiTokens.ts` + `aiContextService.ts`）：估算偏差是否可能造成超限请求？截断是否真的发生在节点边界且被提示词声明？
- H33. 流式回复中断后，半截消息是否会被持久化为完整消息？
- H34. 各 Provider 目录（`lib/aiProviders.ts`、`lib/ttsProviders.ts`、`features/voiceRecall/providerProfiles.ts` + `providerFactory.ts` + `providerRuntime.ts`、`services/ocrSettings.ts`）：**每一个条目**是否都能被真正构造出运行实例并被 UI 触达？有无「配置写进去但没有任何代码读取」的键？
- H35. `browserDirectSupported` 之类的能力标志是否与实际代码分支一致（标志为真但实际走不通，或反之为假被永久禁用）？
- H36. 浏览器自动播放策略：TTS/播放是否可能在无用户手势时启动并静默失败？
- H37. `doubaoTts.ts` 的旧版小模型 V1 路径与 V2 路径：是否有一路已成死代码？
- H38. OCR 三条实现（Desktop `ocr.cjs` / Android `nativeOcr` / Web）：Web 端是否存在一个**永远不会成功**的「假接口」？OCR 任务取消后是否留下孤儿临时文件与孤儿 DB 行？
- H39. AI 设置的「密钥异步加载完成前不写入」修复（CHANGELOG 提到）：**同类「异步加载 → 用户编辑 → 保存」竞态在其它设置项是否也存在**（TTS、OCR、语音、同步、主题）？

**平台与宿主**

- H40. `platform.ts` 的能力判定在 Desktop / Android WebView / 浏览器 / SSR(`typeof window`) 下的行为；是否存在仅靠 UA 判断而误判的分支？
- H41. Android 11 个 Plugin 的**方法名 / 参数形状 / 返回值类型**与 TS 侧调用是否逐一对齐？有无 JS 调用了 Java 不存在的方法（运行即抛），或 Java 提供了但无人调用的方法（死代码）？请做一张「Plugin 方法 × 调用方」对照表。
- H42. iOS 相关配置是否存在但从不使用（属于死资产，见任务 B）。
- H43. Electron `installer.nsh` 与 `electron-builder` 配置的一致性；`preload.cjs` 暴露的 API 与 `main.cjs` 的 `ipcMain.handle` 是否一一对应。
- H44. PWA：`nativeServiceWorker.ts` 与 `vite-plugin-pwa` 的更新策略；是否存在「旧版本用户升级后拿到新资源但旧 IndexedDB 未迁移」的窗口？（这是最典型的「之前能用现在不能用」的成因。）

**通用**

- H45. 时区与日界：`lib/date.ts`、`dailyMotto`、统计与复习到期判断，是否存在 UTC / 本地时间混用导致的跨日偏差？
- H46. 所有 `catch` 块普查：找出**空的或只打日志的 catch**，逐条判断是否应为静默（合理）还是应为用户可见错误（Bug）。同时核对 `AGENTS.md` 的硬约束「React 页面/组件渲染的错误必须经过 `src/lib/uiError.ts`」是否被违反。
- H47. 资源生命周期普查：定时器 / 事件监听 / `AbortController` / `ObjectURL` / WebSocket / MediaStream / AudioContext 的成对创建与释放。

### 5.3 跨端一致性矩阵（回归的高发区）

请为下列**共同逻辑**分别标注 Web / Desktop / Android 三端行为，并指出差异与「某端永远不会进入的分支」：
录音采集、文件读写、ZIP 打包/解包、备份落盘、云同步鉴权、OCR、TTS 播放、图片选择、通知/Toast、返回键与导航历史（`webNavigationHistory` / `tabNavigation`）、视口与键盘弹出（`viewport` / `layoutOverflow`）。

---

## 6. 任务 B：代码与接口清理

### 6.1 接口真实性矩阵（本任务的核心产出）

请建立一张**完整**的接口清单并逐条分类，覆盖以内所有「对外/跨层」接口：

- AI Provider 目录与调用入口（`aiClientService`、`aiProviders.ts`、Coach 的 3 个 gateway：`aiGateway` / `quizExecutionGateway` / `sessionPlanningGateway`）
- TTS Provider（`ttsProviders.ts`、`doubaoTts.ts`、`nativeTts.ts`、`nativePodcastTts.ts`）
- 语音复述：`providerProfiles` / `providerFactory` / `providerRuntime` / 各 transport（`aliyunAsrTransport`、`doubaoAsrTransport`、`androidLlmStream`、`openAiLlmStreamAdapter`、`fishAudioTtsStreamAdapter`、`ttsFallbackAdapters`、`siliconFlowBatchAsr`、`sse`）
- 宿主桥：Electron IPC 通道（`main.cjs` ↔ `preload.cjs` ↔ 渲染进程）、Android Plugin 方法（11 个 Plugin）
- 存储适配：`storageAdapter.ts` 暴露的每个方法、`syncAdapters.ts`、`cloudSyncModel.ts` 的实体映射
- OCR、Firebase Storage 用量、自动备份适配器
- 对外数据格式：备份 ZIP 结构、记录转移包、知识导出格式
- **预览/调试接口**：`?preview=stage3|stage4|stage5|stage6|stage7|coach|voice-recall|ui-v2...` 全部枚举，并核对是否被正确限制在 `localhost` 且排除原生壳

每条必须给出以下分类之一，并附代码证据：

| 分类 | 含义 |
|------|------|
| `REAL` | 有真实实现、被 UI 触达、能真正完成工作 |
| `CONDITIONAL` | 仅在特定平台/配置/凭据下可用，且代码有明确守卫与披露 |
| `DEAD` | 有实现但无任何调用方，或调用方本身不可达 |
| `FAKE` | **有壳无实**：永远返回空/抛未实现/无接线配置项/永不成立的条件分支；用户看到入口但功能不可能生效 |
| `REGRESSED` | 曾经可用，当前不可用或行为变了（需给出 git 证据） |
| `MISLEADING` | 能跑，但 UI 文案/披露与实际能力不符（例如声称已开启某模型实际未使用） |

### 6.2 死代码与废弃资产

请用「**引用计数**」的方式（Grep/Glob 统计调用方）逐项核查并给出删除建议 + 删除风险：

- `src/` 内**零引用**的导出函数、类型、常量、React 组件、CSS 类（注意：`src/styles/*.css` 与 `visual-v2.css` 中存在大量可能已失效的选择器）。
- 零引用的**测试辅助文件**（`src/test/fixtures/*`、`reviewCoachTestFixtures.ts`）。
- 已废弃的**旧实现**：语音预制原型、旧的手动/自动半双工残留路径、旧版 TTS 路径、旧版迁移代码（schema 11/16 之前的分支）。
- **未使用的依赖**：`package.json` 中在源码里找不到 import 的包（例如需重点核对 `mermaid`、`recharts`、`file-saver`、`jszip`、`prosemirror-search`、`@noble/hashes`、`markdown-it` vs `react-markdown` 是否重复承担同一职责）。
- 未使用的脚本 / npm script（`scripts/*.ps1`、`package.json` scripts 中是否有指向已不存在文件的入口）。
- Desktop / Android 侧的死代码：无人调用的 Java 方法、未注册的 Plugin、`@SuppressWarnings` 掩盖的未使用成员、`voiceAsrSocket.cjs` 中已无渲染端使用的消息类型。
- **重复实现**（同一职责存在两套代码）：`nativeTts` vs `nativePodcastTts`、`lib/recordings` vs `services/mediaPlaybackService`、`markdown-it` vs `react-markdown` 渲染链、`ttsProviders` vs `voiceRecall` 内的 TTS 适配、`exportPrivacy` 与实际导出实现、备份的四条路径（ZIP / streaming / native repository / autoBackup）之间是否存在可统一却各自维护的逻辑。

### 6.3 「以前能用、现在不能用」的回归对账（必须用 git 驱动）

对以下最近的重构提交，逐个做**diff 驱动**的回归检查：

`b20aa7f`（voice recall natural conversation）、`829f98d`（AI/TTS settings device-local）、`a1fd43e`（coach replay/verification）、`f92b2dd`、`306e9bb`（AI chat context）、`4280bb5`（editor toolbar）、`9cd502f`（android release assets）、`de4e716`（providers selectable）、`eb198aa`（review layout/motion）、`2f52782`（production voice modes）。

对每个提交，请专门检查这 6 类「静默回归」：

1. **导出被重命名/删除**，但旧调用方仍存在（TS 会报错，但 `any` 或动态调用不会）。
2. **持久化键名变更**：`localStorage` / `idb-keyval` / Dexie 表中的 key 字符串被改，**没有迁移** → 用户已保存的配置/状态静默失效。请把全仓库的 key 字符串列表导出并交叉比对。
3. **路由 / query 参数变更**（含 `?preview=`）→ 旧书签/深链失效。
4. **设置项重命名**（例如 Provider profile 的识别键、默认槽位）→ 已保存的凭据不再被读取（注意「同一 default 槽位歧义」的历史问题）。
5. **行为语义变化但文案未更新** → 属于 `MISLEADING`。
6. **新增了守卫导致旧路径永久不可达** → 属于 `FAKE` / `DEAD`。

### 6.4 文档 vs 代码对账

请以代码为唯一事实源，核对以下文档中**每一条能力声明**是否在代码中成立：

- `README.md`、`CHANGELOG.md`（`[Unreleased]` 与 `Added/Fixed/Changed` 每一条）
- `docs/新的方案.md`（产品边界）
- `AGENTS.md` 的 Current Baseline / 各 Boundaries 段
- `pages/UsageGuidePage.tsx`（使用教程里描述的操作路径能否真的走通——**教程里出现但实际不存在的按钮/入口，就是典型的假接口**）
- `docs/voice-recall-*`、`docs/doubao-voice-provider-compatibility.md`

输出一张表：`文档声明 | 位置 | 代码事实 | 一致? | 处置建议`。重点找三类：**声称已实现但代码里没有**、**代码里有但文档说没有（能力被藏起来）**、**参数/默认值/模型名不一致**。

---

## 7. 任务 C：跨切面不变量审计

以下不变量在 `AGENTS.md` 中被显式声明，请为每一条构造「**反例搜索**」——即主动尝试找出能打破它的代码路径。找不到就写「未发现反例」，找到了就是高优先级发现。

1. 所有 React 渲染的捕获错误必须经过 `src/lib/uiError.ts`，不得裸用 `error.message`。
2. `RecordBlock.contentHtml` 是唯一可编辑真相源；投影必须可从正式事实重建。
3. AI 响应与本地执行缓存**不是**真相源。
4. 记录级 FSRS 负责整记录排程；决策块事实不得静默改写 FSRS。
5. 云端 review event 在未设计检查点+墓碑协议前为 append-only。
6. `reviewAnnotationDrafts` 的写入不得标记云变更。
7. 语音/批注数据不进入云、备份、导出、转移。
8. 语音练习不写 FSRS、不自动评分；语音摘要必须经**显式确认**才成为日志。
9. 普通校验排除 live 测试；真实 Provider 只用于受控验收。
10. 密钥不得出现在源码、测试、文档、日志、截图、备份或同步数据中。

---

## 8. 执行方法与工作纪律

1. **分批推进，避免上下文爆掉**：先做 §2 的基线采集，然后**按模块分批**（建议 M01–M05 → M06–M09 → M10–M11 → M12–M18 → M19–M23），每批结束后把发现**增量写入报告文件**，再继续下一批。不要试图一次读完所有文件。
2. **三角验证**：每个 Bug 结论尽量同时具备「代码引用」「测试覆盖情况（有/无）」「运行时行为推断」三方面证据；缺哪方面要写明。
3. **优先看边界**：模块之间的接缝（hook ↔ service ↔ db ↔ 宿主）比模块内部更可能藏 Bug。请重点关注 `useAppData.ts`(1086 行)、`App.tsx`(1821 行)、`storageAdapter.ts`、`cloudSyncModel.ts`、`orchestrator.ts` 这类「枢纽文件」。
4. **测试覆盖反推**：对每个模块，列出**有测试**与**无测试**的关键函数。无测试 + 高复杂度 = 高危潜伏区，请在报告中标出「高风险无测试清单」。
5. **不要为了凑数而报问题**。如果某个模块确实健康，就明确写「健康」并说明依据。
6. 允许使用只读的辅助手段：Grep/Glob 统计引用、`git log -p`、`git diff`、`npx tsc --noEmit`、`npx vitest run <file> -t <name>`（单点复现，不跑全量 live）。
7. 遇到需要真机 / 真账号 / 付费凭证才能判断的，**不要猜**，统一进 §9 的「无法静态验证清单」。

---

## 9. 交付物与格式（严格按此输出）

写入文件：`docs/audit/final-full-audit-<YYYY-MM-DD>.md`（工作区当前日期为准），并同时在对话里给出摘要。文件结构如下：

```
# StudyJournal 收口阶段全规模审计报告

## 0. 审计范围与基线
（含 git rev-parse HEAD、git status 摘要、审计对象是工作区还是 HEAD）

## 1. 确定性证据
（§2 中每条命令的真实输出摘要；测试/构建是否通过；与 AGENTS.md 声称基线的偏差）

## 2. 总体结论
（健康度判定 + 是否可进入收口 + 最大风险来源排序）

## 3. 覆盖矩阵
（23 个模块 × 结论状态 × 实际读取文件 × 发现编号，不允许有空行）

## 4. 问题总表
（见下方列定义；按严重度排序）

## 5. 模块详细报告
（M01–M23 逐节；每节含：结论、发现、已验证干净的点、无测试高危区）

## 6. 接口真实性矩阵
（REAL / CONDITIONAL / DEAD / FAKE / REGRESSED / MISLEADING）

## 7. 死代码与废弃资产清单
（条目 | 类型 | 位置 | 引用计数 | 删除建议 | 删除风险）

## 8. 回归对账（git 驱动）
（提交 | 变更类型 | 潜在静默回归 | 证据 | 结论）

## 9. 文档 vs 代码对账表

## 10. 跨切面不变量反例搜索记录
（10 条不变量 × 反例 / 未发现反例 + 证据）

## 11. 高风险无测试清单

## 12. 无法静态验证清单
（需真机 / 真账号 / 付费凭证；写明「需要验证什么」与「怎么验证」）

## 13. 已验证干净清单
（负面确认，明确写「以下曾怀疑但不成立」）

## 14. 建议的收口行动顺序
（按 修复收益 / 回归风险 四象限排序；只排序，不动手）
```

**问题总表列定义**（每行必填）：

`ID | 严重度(P0/P1/P2/P3) | 模块 | 位置(file:line) | 现象 | 触发路径 | 证据 | 置信度(高/中/低) | 建议修法 | 改动波及面 | 与既有审计是否重复`

严重度口径：`P0` 数据丢失/泄漏/安全/崩溃；`P1` 功能错误或不可用，用户可感知；`P2` 边界条件下出错、体验退化；`P3` 清理项/维护陷阱。

---

## 10. 质量门槛（交付前请自检并勾选）

- [ ] 23 个模块全部有结论，无一遗漏。
- [ ] 每条问题都有 `文件:行号` 或函数名，且行号来自实际文件内容。
- [ ] 每条问题都写了**触发路径**（什么操作序列会踩到），或明确标注「无法给出触发路径，仅静态推断」。
- [ ] 每条问题都标了置信度，且高/中/低的使用前后一致（低置信度不得进入 P0/P1）。
- [ ] `FAKE` / `DEAD` / `REGRESSED` 三类各有明确条目，或明确写「未发现」并说明搜索方法。
- [ ] 与既有 4 份审计报告做了去重标注（重复的标 `重复`，并说明是「确认仍然存在」还是「已修复」）。
- [ ] 有「已验证干净清单」——只报问题不报干净的审计不可信。
- [ ] 未修改任何代码，未提交 commit，未调用任何真实付费服务。
- [ ] 报告文件已写入 `docs/audit/`。
- [ ] 已列出未完成项与本次审计的明确局限。

---

## 11. 明确不要做的事

1. 不要顺手修 Bug——除非我在看完报告后单独授权第二轮修复。若你发现问题极其清晰（例如一行拼写错误导致功能失效），可以在报告里给出补丁片段，但**不要落到文件**。
2. 不要提议架构重写、不要提议引入新依赖、不要提议升级框架。
3. 不要以文档、注释、CHANGELOG 作为「功能存在」的唯一证据。
4. 不要把「冻结面」当成可改项。
5. 不要输出重复条目（同一根因的多处表现要合并成一条，并列出所有受影响位置）。
6. 不要因为某个模块文件多就降低深度——`features/voiceRecall/`（约 70 个文件）与 `features/reviewCoach/`（约 30 个文件）是本项目的复杂度重心，必须最深入。

---

## 附录 A：建议的第二轮（仅在授权后）

在报告被确认后，再单独下发修复指令，格式为：`按报告第 4 节，修复 P0 与 P1 中标注「改动波及面=小」的条目；每条修复附带一个回归测试；修复后运行 §2 的全部命令并贴出输出；不要触碰冻结面。`

## 附录 B：常用只读命令速查

```bash
# 引用计数（示例：查某导出是否被使用）
grep -rn "函数名\|导出名" src desktop android --include=*.ts --include=*.tsx --include=*.cjs

# 找未使用依赖
grep -rn "from \"包名\"" src desktop

# 找空 catch / 静默失败
grep -rn -A3 "catch" src --include=*.ts --include=*.tsx

# 找直接写表（绕过 repository）
grep -rn "\.\(put\|add\|bulkPut\|delete\)(" src --include=*.ts | grep -v "features/reviewCoach/repository"

# 找本地存储键
grep -rn "localStorage\.\|getItem(\|setItem(\|idb-keyval\|createStore(" src

# 找未实现/占位
grep -rn -i "not implemented\|未实现\|TODO\|FIXME\|throw new Error(\"stub" src desktop android

# 找平台分支
grep -rn "isNative\|Capacitor\|isDesktop\|window.electron" src --include=*.ts --include=*.tsx
```

## 附录 C：可调开关（按需保留 / 删除本段）

- 只要 Bug 排查：保留 §2、§3、§4、§5、§7、§9–§11，删除 §6。
- 只要接口清理：保留 §2–§4、§6、§9–§11，删除 §5、§7。
- 允许直接修复：把 §1.1 改为「允许修改代码，但必须逐条附回归测试，且不得提交 commit」。
- 缩小范围：在 §4 表格里把不需要的模块行标注 `本轮跳过`，并在 §9 的覆盖矩阵中写明跳过原因。

---

现在，请从 §2 的基线采集开始，按 §8 的分批纪律推进，最后按 §9 交付报告。
