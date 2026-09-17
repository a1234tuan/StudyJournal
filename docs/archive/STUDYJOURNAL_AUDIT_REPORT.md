# StudyJournal 工程审计报告

**审计类型**：只读工程审计（未修改任何源码、配置、数据库；未提交 commit / PR）
**审计对象**：`D:\StudyJournal-Source`（origin: `https://github.com/a1234tuan/StudyJournal.git`，分支 `main`）
**审计时间**：2026-09-09
**审计基线 commit**：`5f3cdc0 chore: finalize editor layout and project docs`（工作区 clean）

---

## 1. 审计范围与环境

| 项 | 值 |
| -- | -- |
| 应用形态 | React 18 + TypeScript 5.7 + Vite 6 的离线优先学习日志（Dexie/IndexedDB） |
| 目标平台 | Web / PWA、Electron 桌面（`desktop/main.cjs`）、Capacitor Android |
| 规模 | 473 个 git 跟踪文件；`src/` 335 个文件（226 `.ts` / 96 `.tsx` / 10 `.css`） |
| 运行环境 | Windows 11、Node v24.16.0、TypeScript 5.9.3、Chrome（Playwright 用真实 Chrome） |
| 数据库 | Dexie schema 21（`src/db/database.ts`） |
| 主要 AI/付费链路 | AI 问答（OpenAI 兼容）、复习教练（DeepSeek 等）、知识播客 TTS（5 家）、PaddleOCR、Firebase 云同步 |
| 语音链路 | `src/features/voiceRecall/`（30 个文件）+ Android `NativeVoiceCapturePlugin` / `VoiceCaptureController` + Electron IPC |

**本次实际执行的只读验证**

| 命令 / 手段 | 结果 |
| -- | -- |
| `npx tsc -b` | 通过（exit 0） |
| `npx vitest run` | **126 个测试文件 / 840 项测试全部通过**（40.8s） |
| `npm run build`（tsc -b + vite build） | 通过（exit 0，38s，PWA precache 104 项） |
| `npx playwright test`（desktop + android-narrow 双 project） | **40 通过 / 4 失败**（见 P1-8） |
| `git diff --check` | 通过 |
| 真实浏览器探针（Playwright 驱动 Chrome，脚本位于系统临时目录，未写入仓库） | 用于验证移动端编辑器菜单可达性等布局结论 |
| 只读代码审计 | `codegraph` 索引 + 定向 Read/Grep；4 个并行只读审计子任务交叉验证 |

> 说明：报告中的行号对应当前工作区文件。标注“CSS 推导”的条目由样式规则推导（未经渲染验证）；标注“浏览器实测”的条目由上述探针取得实际 DOM/命中测试数据。

---

## 2. 最近重构内容概览

最近 5 次提交（`main`）：

| Commit | 时间 | 标题 | 规模 |
| -- | -- | -- | -- |
| `5f3cdc0` | 2026-09-09 15:29 | chore: finalize editor layout and project docs | 34 文件，+1540 / −279 |
| `f48fd61` | 2026-09-08 21:02 | chore: save current workspace state | 3 文件，+19 / −1 |
| `3c157fe` | 2026-09-08 18:32 | feat: add real-time voice recall workflow | 77 文件，+5515 / −40 |
| `32f4404` | 2026-09-08 14:33 | feat: add review annotations and persistent rating undo | 26 文件，+1657 / −89 |
| `b9d25b5` | 2026-09-07 21:07 | feat: initial open-source release | 全量初始提交 |

**本轮“重构”实质是 3 个特性 + 1 次布局收口**，而非架构重写：

1. **`32f4404` 复习批注 + 评分撤回持久化**：新增 `src/features/reviewAnnotations/*`、`src/features/reviewSession/runtime.ts`；Dexie schema 20；`ReviewPage.tsx` 大幅改动；`pages.css` +298 行。
2. **`3c157fe` 实时语音复述（最大）**：新增 `src/features/voiceRecall/` 30 个文件（契约、状态机、适配器、Provider 工厂、本机持久化）、`VoiceRecallPrototypeApp`（localhost 原型）、Android 原生采集插件、Electron 语音 IPC；Dexie schema 21 新增 3 张纯本机表；`App.tsx` 新增语音路由；`ReviewPage`/`RecordEditorPage` 新增入口。
3. **`5f3cdc0` 编辑器布局收口 + 复习页筛选重构**：
   - `visual-v2.css` +301 行：移动端编辑器“统一宽度基准”、紧凑工具栏、标签低对比输入标题；
   - `ReviewPage.tsx`：删除“到期/新卡/复习中”摘要条，改为可折叠筛选面板（功能保留，去重）；
   - `MorePage.tsx`：移除全部 `description`，改为 `ChevronRight` 尾部图标；
   - `App.tsx`：新增 `openMoreRoot()`（“更多”Tab 重置子路由）、`SystemBars` 样式同步、语音工作区 `visualTheme`；
   - 语音呈现层从工作区抽到 `VoiceRecallPresentation.tsx`（+339 行）。
4. `AGENTS.md` / `CHANGELOG.md` / `docs/` 同步声明“语音复述阶段 0–6 自动化收口完成”“编辑器布局收口完成”。

---

## 3. 本轮重构涉及的主要模块

| 模块 | 文件 | 变更性质 |
| -- | -- | -- |
| 路由 / 导航 | `src/App.tsx`、`src/lib/tabNavigation.ts`、`src/lib/webNavigationHistory.ts` | 新增语音路由、`openMoreRoot`、稳定 page key |
| 语音复述（新） | `src/features/voiceRecall/*`（30 文件） | 全新功能 |
| 复习 | `src/pages/ReviewPage.tsx`、`src/features/reviewSession/runtime.ts` | 批注接入、筛选面板重构、撤回栈上提 |
| 批注（新） | `src/features/reviewAnnotations/*` | 全新功能 |
| 编辑器 | `src/pages/RecordEditorPage.tsx`、`src/styles/visual-v2.css` | 移动端布局收口、标签标题 |
| 更多页 | `src/pages/MorePage.tsx`、`src/components/ui.tsx` | 行项去描述、加尾部箭头 |
| 视觉层 | `src/styles/visual-v2.css`、`pages.css`、`components.css`、`styles.css` | 大量覆写 |
| 持久化 | `src/db/database.ts`、`reviewCoachSchema.ts`、`src/services/storageAdapter.ts` | schema 20/21、恢复边界 |
| 原生 / 桌面 | `android/.../NativeVoiceCapturePlugin.java`、`VoiceCaptureController.java`、`desktop/main.cjs`、`desktop/preload.cjs` | 新增语音采集与 IPC |

---

## 4. 模块影响关系（改动 → 影响功能 → 应重点验证什么）

```
5f3cdc0 编辑器布局收口
  └─ visual-v2.css 新增 .record-editor-topbar{overflow:hidden} / .record-action-row{overflow:hidden} @≤920px
       └─ 影响：记录编辑器“更多操作”下拉菜单被裁剪
            └─ 应验证：手机端能否触达 语音复述/加入复习/导出/收藏/删除/查找替换  ← 实测失败（P1-4）

5f3cdc0 ReviewPage 筛选面板重构
  └─ 删除 .review-library-summary，改为 review-library-filter-panel
       └─ 影响：卡片状态筛选入口位置变化（功能保留）
            └─ 应验证：到期/新卡/复习中 仍可筛选、清除筛选、深链返回

5f3cdc0 MorePage 移除 description
  └─ ListRow 可访问名从“标题+描述”变为“标题”
       └─ 影响：E2E 选择器 /分类管理 按学科和标签/ 失配
            └─ 应验证：e2e 全绿  ← 实测 4 项失败（P1-8）

3c157fe 语音复述（新增）
  └─ VoiceRecallWorkspace 本地伪造 ASR/LLM/TTS；providerFactory/pipeline 无生产引用
       └─ 影响：功能可用性、隐私披露、成本、状态真实性
            └─ 应验证：真实 Provider 调用、披露文案、假状态  ← 全部命中（P0-1、P1-1/2/3）

32f4404 批注（新增）
  └─ ReviewAnnotationSurface 无 key、draft 无重置分支
       └─ 影响：复习卡片切换
            └─ 应验证：切卡后笔迹归属  ← 命中（P1-5）
```

**本轮高风险区域排序**：① 语音复述全链路；② 批注与复习卡片切换；③ 编辑器移动端布局；④ 复习页筛选/撤回；⑤ 导航历史与返回。

---

## 5. 基础交互与路由审计

**结论：路由结构完整、无死界面；但 Web 浏览器返回在 4 条路由上失效，并存在重复返回按钮与两处返回语义不一致。**

已验证正常的方面：
- `tabNavigation.ts` 中 5 个 Tab + 15 个 `MoreSubRoute` + `null` 全部可达（逐个追踪 `onOpen*`）。
- `popTabDepth` 在所有分支严格降低深度，无循环；引用栈的环检测/深度上限（`MAX_RECORD_REFERENCE_DEPTH = 8`）正确（`tabNavigation.ts:172-201`，`App.tsx:742-753`）。
- 新的稳定 `voice` page key（`tabNavigation.ts:289-295`）只影响 review Tab，`voice ≠ queue/manage`，进出语音仍只播放一次过渡动画；`popCurrentTabDepth` 的语音特例（`App.tsx:397-404`）保留 `queueIds`/`currentRecordId`/`progress`。
- 自适应任务入口/返回（`openAdaptiveTask` → `closeAdaptiveTask`）指向正确。

问题见 P1-9、P2-2、P2-10、P3-15、P3-16。

---

## 6. API / TTS / ASR / LLM 成本与容错审计

### 6.1 成本控制：整体有意识、局部有缺口

**已验证存在的成本护栏**（证据充分）：
- **提示词/上下文有界**：分块 2400 字符、选择上限 12k/16k/24k token、索引 1M 字符、存储 markdown 64k 字符、历史 4k token、记忆摘要 1800 字符、上下文缓存 4 条（`aiContextService.ts:17-26, 445, 492-496`；`aiClientService.ts:76-79`）。
- **输出有界**：聊天 `provider.maxTokens`（默认 4096）；播客脚本钳制 16384–32768；教练各角色 600–6000。
- **播客任务单飞 + 可恢复**：`controllers.has(key)` 去重；已有资源的单元跳过；中断任务标记为 failed 而非自动重启（`knowledgePodcastJobService.ts:285, 416-419`；`storageAdapter.ts:409-431`）。
- **云同步无自动轮询**：无 `onSnapshot`/`setInterval`；由用户点击触发；40k reads / 5k writes / 500 objects / 100 MiB 的预算确认；6 分钟看门狗；无自动重试循环。
- **OCR 去重**：单活任务、按 asset 去重、仅 `idle` 状态自动提交、队列满重试上限 5 次、5 分钟轮询上限。
- **对象 URL 释放**：4 处创建点均已 `revokeObjectURL`。
- **密钥不出设备**：`aiSecrets` 不在云同步实体表、不在导出脱敏字段、不在备份路径；源码中无硬编码 `sk-*`。

**缺口**（详见问题清单）：
- AI 问答 Web/桌面**无超时、无取消**（P1-6）；Android/桌面**取消不终止计费请求**（P1-7）。
- 教练路径**对不可重试错误也重试**（解读队列最多 3 次/条）且**未禁用 thinking**（P2-7）。
- TTS Web/桌面**无超时**；Android TTS 对**所有**异常重试 3 次，且阿里云流程中“下载失败”会重跑**已成功的付费合成**（P2-14）。

### 6.2 关键问题：用户是否可能在无感知情况下持续消耗配额？

**是，存在两条路径**：
1. **AI 问答挂起**：Web/桌面无超时、无取消，`busy=true` 永久保持，用户只能刷新页面；若底层 TCP 长时间不返回，请求会一直占用（P1-6）。
2. **取消不生效**：Android 原生 AI 与桌面 TTS 的取消只拒绝 JS Promise，底层请求继续跑完（P1-7）。播客脚本单次 `max_tokens` 最高 32768，是全应用最贵的调用。

此外，**教练解读队列**在 401/Base URL 错误/CORS/schema 失败时会按“每条 × 3 次”重试，错误配置下会放大 N 倍请求（P2-7）。

> 反直觉结论：**语音复述本身目前消耗 0 配额**——因为它根本没调用任何 Provider（见第 7 节）。风险不在“语音烧钱”，而在“AI 问答挂死”和“取消不生效”。

---

## 7. 语音通话审计（P0 集中区）

### 7.1 全链路结论

要求链路：`用户输入 → ASR → 对话状态 → LLM → TTS → UI → 下一轮`。

实际生产链路（`VoiceRecallWorkspace.tsx`）：

| 环节 | 期望 | 实际 |
| -- | -- | -- |
| 麦克风采集 | 真实 | **真实**（`getUserMedia` / Android `AudioRecord`，PCM 帧回调） |
| 音频去向 | 送 ASR | **丢弃**（`onFrame: () => { framesRef.current += 1; }`，仅计数） |
| ASR | 真实识别 | **本地伪造字符串**（`setMockAsrText(sample)`） |
| 对话状态 | 真实推进 | 真实状态机（`domain.ts`），但由本地代码直接驱动 |
| LLM | 真实调用 | **本地模板拼接**（`createTeacherReply`） |
| TTS | 真实合成并播放 | **完全未发生**（默认 runtime 使用 `silentSink` 空实现） |
| 下一轮 | 基于 AI 回复 | 基于本地模板文本 |

**真实的 Provider 层是死代码**：`providerFactory.ts`、`pipeline.ts`、`mockProviders.ts`、`openAiLlmStreamAdapter.ts`、`fishAudioTtsStreamAdapter.ts`、`transportAsrAdapter.ts`、`ttsFallbackAdapters.ts`、`sentenceBuffer.ts`、`turnEndpointController.ts` 在 `src/` 中的唯一导入者是 `providers.test.ts` / `runtimePrimitives.test.ts`。`VoicePlaybackQueue.enqueue()` 全仓无调用。

### 7.2 界面真实性

- 头部连接指示器硬编码：只要状态不是 `failed` 就显示 **“已连接”**（含 `idle`/`connecting`/`paused`/`ended`）。
- 字幕在无转写且 `active` 时显示 **“正在识别你的回答…”**，而音频帧正在被丢弃。
- 门控提示 **“教师播放中，麦克风暂时关闭”**，但从未有任何音频播放。
- 默认 `auto-half-duplex` 下 `CONNECTED` 直接把 `captureRequested` 置 true，于是**麦克风尚未打开时波形已在动画、提示已显示“说完后点击发送”**；此时点击主按钮实际执行的是“开始录音”而非“发送”。

### 7.3 时序 / 竞态 / 清理

- 轮次顺序由 Dexie 事务强约束（`repository.ts:72-99` 拒绝序号复用/乱序），不存在覆盖轮次的竞态——这点实现良好。
- 代际防护（`playbackQueue.generation`、`domain.ts` 的 `generation`）设计正确，但因播放链路未接入而未生效。
- **状态跨会话泄漏**：`VoiceRecallWorkspace` 无 `key`，`transcript` / `mockAsrText` / `historySaved` / `message` 未在 `startSession` 重置 → 第二个会话无法保存摘要、可能带着上一轮文本进入输入框。
- **维护 API 未接线**：`runtime.initialize()`（含 `repairInterruptedSessions`）、`cleanupCompleted()`、`markSourceUnavailable()`、`clearTransient()` 在 `src/` 中**无生产调用者**（仅测试）。7 天保留策略不生效，崩溃会话不会修复，删除记录不会标记语音来源不可用。
- **原生采集错误未被消费**：Java 侧 `notifyListeners("captureError")`，TS 侧只监听 `audioFrame`，且迭代器只在 `stopCurrent()` 后退出 → 麦克风失败时 UI 仍显示“正在听”。

### 7.4 持久化边界（正面）

已用测试证明：`voiceRecallSessions/Turns/LocalHistory` 仅存在于本机 Dexie；云同步派生忽略它们；云拉取保留它们；完整恢复清除会话/轮次但保留历史；恢复不会误删历史。这部分实现与文档一致。

---

## 8. AI 学习驾驶舱审计

**结论：驾驶舱核心数据流与写入正确性没有问题；问题集中在“取消/超时/重试/错误可诊断性”和一处“选择状态被刷新重置”的成本风险。**

已验证正确：
- `taskId`/`snapshot`/`records` 绑定正确；`task`/`blueprint`/`turns`/`record`/`delayedVerification` 字段与 `domain.ts` 一致；`hintsUsed[].level` 形状正确；`record-decision-block[data-decision-block-id]` 选择器与真实属性一致。
- 所有 AI 响应先经严格 schema 校验（精确键）再持久化；答案与证据交叉核对 blueprint。
- 正式状态（`adaptiveQuizTurns`/`taskOutcomeEvents`/`blueprints`）只经幂等、带约束的事务写入。
- 每个教练动作都 `await refresh()` 后再 resolve；`run()` 在 `finally` 复位 `busy`，不存在“永久 loading”。
- 所有页面/组件捕获的错误均经过 `formatUiError`（`uiErrorSurface.test.ts` 守护）。

问题：P2-5（候选块选择被刷新重置）、P2-6（无 AbortSignal）、P2-7（thinking/重试）、P2-8（配置不生效）、P2-9（错误信息丢失）、P3-…（`maxEstimatedTokens`/`maxRetriesPerTurn` 未强制）。

---

## 9. UI / UX 审计

### 9.1 整体视觉一致性

- 视觉层为 7 个 CSS 文件、**12,438 行**，`visual-v2.css` 靠“最后加载”赢得层叠。同选择器重复定义普遍（`.review-rating-bar` 3 处、`.review-mode-tabs` 3 处、`.list-row`/`.record-card` 各 2 处，`styles.css` 内 `.subtle-button`/`.subject-log-list button` 等 4 处）。
- **知识播客 UI 使用未定义变量**：`pages.css` 中 `var(--accent, #6d5dfc)` / `var(--accent-color, #4f46e5)` 的 `--accent*` 在全仓从未定义，因此实际渲染为**硬编码靛蓝**，与当前赭红/绿主色明显冲突（P2-18）。
- `StatsPage` 图表仍用旧调色板（`#2f6f5e`/`#d29045`），不随主题/暗色变化（P3）。
- `::selection` 仍为旧绿色；标签 chip 无暗色变体（P3）。

### 9.2 语音通话界面（沉浸度）

- 信息层级总体清晰：全屏声场 + 连续字幕 + 紧凑状态 + 固定四键控制，横向无溢出（实测 `scrollWidth <= innerWidth`）。
- 但**状态表达与真实不符**（见 7.2）：用户会“一眼理解当前状态”，只是这个状态是假的——这是本功能最大的体验问题。
- 缺播放控制、无音量/重播，且没有任何“演示/Mock”标识（与 localhost 原型形成对比：原型明确标注“Mock 链路/Mock 已连接”）。

### 9.3 AI 交互表现

- **文字显示**：ASR 文本为伪造占位句并直接预填进“确认并发送”输入框（P1-3）；AI 回复为本地模板；TTS 无音频，故不存在“播放内容与文字对应”问题（因为没有播放）。
- **延迟**：端到端无真实网络，延迟≈0；但也因此无法评估真实 ASR/LLM/TTS 延迟。真实链路接入后需重做延迟评估。
- **回复长度 / Prompt**：语音层没有 prompt（未调用 LLM），因此不存在长上下文注入问题。**真正的长上下文风险在 AI 问答与教练**：教练解读提示词注入整块 `decisionBlockContent` + 该块全部历史解读，**无长度护栏**（`aiGateway.ts:37-52`，`orchestrator.ts:292-307`）；规划提示词注入所有块的 `contextMarkdown`（受 64k 字符上限约束）。建议为解读路径补尺寸上限。

---

## 10. 首页与导航审计

- **今日页宽度基准不一致**（浏览器实测 @1440px）：`.today-compose-band` 宽 **720px**，下方记录列表宽 **1040px**，两者左对齐但右边界差 320px（P2-17）。
- 空数据/少量/大量/长文本/长标题/长标签的健壮性整体良好：长标题 `overflow-wrap: anywhere`、列表标题省略号、侧栏置顶标题省略、学科条横向滚动、各页均有空状态。
- 悬浮元素与底部导航的层叠存在一处 token 失配：`--bottom-nav-height: 78px` vs 移动端导航 `min-height: calc(66px + env(safe-area-inset-bottom))`（P3）。
- Tab 切换状态正确；`openMoreRoot()` 会重置 `recordingsState.query/searchOpen` 与 `podcastId`，但保留 `selectedFolderId`/`playerAssetId` 之外的状态并**总是 push 历史**，与其它 Tab 的“重复点击无操作”不一致（P3）。

---

## 11. 编辑器与日志审计

- **P1-4（实测）**：移动端（≤920px）记录编辑器的“更多操作”菜单**不可见且不可点击**。原因：`5f3cdc0` 新增 `.record-editor-topbar { overflow: hidden }`（`visual-v2.css:283-288`）与 `.record-action-row { overflow: hidden }`（`:300-303`），菜单 `top: calc(100% + 8px)` 完全落在顶栏裁剪框之外；同时 `.collapsible-action { display: none }`（`styles.css:4572-4574`）隐藏了顶栏上的等价按钮。实测命中测试：桌面 6/6 可点，移动端编辑 **0/6**、移动端阅读 **0/6**（含“语音复述”）。
- 工具栏与编辑区：桌面 `top: 58px` 与顶栏高度一致；移动端 `top: calc(56px + safe-area)` 与顶栏实际 `54px + safe-area`（下限 58px）**差 2px**（P2-15，CSS 推导）。
- Ctrl+F 查找面板在正文顶部，滚动位置较深时打开“看不见”（P2-16）。
- 移动端“统一宽度基准”声明与实际不符：顶栏 `width: calc(100% + 32px); margin-inline: -16px`（100vw、内边距 10px）vs 工具栏/正文 `width: 100%`（100vw−32px、内边距 16px）（P2-1，CSS 推导）。
- **日志选择**：未选中行的 grid 列数从 2 塌陷为 1（`.selectable-record-row:not(.selected)`），而复选框对每行都渲染 → 复选框被挤到卡片上方，勾选时整行重排（P2-3，CSS 推导）。
- 评分栏（复习）本身布局正常；打开批注工具时评分栏被**整块隐藏**（`{!annotationOpen && <section className="review-bottom-controls">}`），且未给固定工具栏预留底部空间（P2-4）。

---

## 12. Mock / 假实现检查

**结论：AI 问答 / 教练 / 播客 TTS / OCR / 云同步均无“假成功”路径；唯一的端到端假实现是语音复述生产工作区。**

| 链路 | 判定 | 证据 |
| -- | -- | -- |
| AI 问答 | 真实 | `AiChatPage.send()` → `sendChatCompletion` → `fetch`/`NativeAi`；无 canned 分支 |
| 复习教练 | 真实 | `aiGateway`/`quizExecutionGateway`/`sessionPlanningGateway` → `sendChatCompletionDetailed` → `fetch` |
| 知识播客 TTS | 真实 | 5 家 Provider 真实 HTTP；Android 前台服务；Web 无伪造音频回退 |
| OCR | 真实（Web 直接报错而非伪造） | `ocrService.ts:133` 抛“Web 端 OCR 需要服务器代理” |
| 云同步 | 真实 | Firebase SDK；无 mock 分支 |
| **语音复述（生产工作区）** | **假实现** | 见第 7 节 |
| 语音复述（`?preview=voice-recall` 原型） | 允许的演示 | localhost + query 门控，且**明确标注 “Mock 链路 / Mock 已连接”** |
| 预览种子（`?preview=stage3..7/coach`） | 允许的演示 | localhost + query 门控；但会写入真实 IndexedDB（P3-4） |

未发现：硬编码 API Key、`Math.random` 伪造结果、`setTimeout` 伪造网络延迟（生产路径）、把测试 fixture 引入生产。

---

## 13. 测试 / 构建 / 静态检查结果

| 检查 | 命令 | 结果 |
| -- | -- | -- |
| 类型检查 | `npx tsc -b` | ✅ exit 0 |
| 单元/组件测试 | `npx vitest run` | ✅ **126 文件 / 840 通过**（与 `AGENTS.md` 声明一致） |
| 生产构建 | `npm run build` | ✅ exit 0（38s） |
| 空白错误 | `git diff --check` | ✅ 干净 |
| E2E | `npx playwright test` | ❌ **40 通过 / 4 失败** |
| Firebase Emulator | 未运行（需要模拟器环境） | — |

E2E 失败明细（desktop 与 android-narrow 各 2 条，同一原因）：

```
e2e/ui-v2-stage5-surfaces.spec.ts:22
  await page.getByRole("button", { name: /分类管理 按学科和标签/ }).click();
  Error: locator.click: Test timeout of 60000ms exceeded.
```

根因：`5f3cdc0` 从 `MorePage.tsx` 移除了 `description`，`ListRow` 的可访问名由“分类管理 按学科和标签浏览，并管理学科”变为“分类管理”，选择器失配。**这是本轮重构引入的测试回归**，与 `AGENTS.md` 中“42 个 Playwright 测试”的全绿基线声明不符。

---

## 14. 全部问题清单

| 等级 | 模块 | 问题 | 证据 | 影响 | 建议方向 |
| -- | -- | -- | -- | -- | -- |
| **P0** | 语音复述 | 生产链路为纯本地模拟：不调用任何 ASR/LLM/TTS | `VoiceRecallWorkspace.tsx:76-81,258-264,288-289,306-307`；`runtimeController.ts:11,199`；`providerFactory.ts`/`pipeline.ts` 仅被 `providers.test.ts` 引用 | 核心承诺（语音识别、AI 追问、语音播放）均未实现；用户以为在使用语音功能 | 接入 `providerFactory` + `VoiceRecallPipeline` 与真实 `VoicePlaybackSink`，或在完成前隐藏入口 |
| **P1** | 语音复述 | 首次使用披露声称语音交给豆包 ASR、资料交给 deepseek、回复由 Fish Audio 播放，实际无任何数据传输 | `VoiceRecallWorkspace.tsx:543`；`providerProfiles.ts:170-196` | 虚假数据处理声明；同意记录无效；隐私合规风险 | 披露文案改为由“实际已接入的适配器”生成；未接入时明确写“本机演示，不发送数据” |
| **P1** | 语音复述 | 假“已连接/正在识别你的回答/教师播放中”，麦克风未开时波形已动画 | `VoiceRecallPresentation.tsx:297,303,313`；`VoiceRecallWorkspace.tsx:363`；`domain.ts:113-121` | 用户误以为正在录音；点击“发送”实际触发录音 | `active` 由采集适配器真实状态推导；连接指示由真实握手推导 |
| **P1** | 语音复述 | `stopCapture` 伪造转写并写入 `providerFinalText` | `VoiceRecallWorkspace.tsx:251-264,298` | 伪造句子可被直接提交并持久化、进入摘要/日志 | 不向输入框写入伪造文本；`providerFinalText` 留空或显式标注“无 ASR” |
| **P1** | 编辑器 | 移动端“更多操作”菜单不可见/不可点击（本轮回归） | 浏览器实测：移动端可达 0/6；`visual-v2.css:283-288,300-303`（本轮新增 `overflow:hidden`）；`styles.css:4572-4574` | 手机端无法 语音复述/加入复习/导出/收藏/删除/查找替换/宽内容 | 去掉裁剪或改用 Portal + `position: fixed` 定位 |
| **P1** | 批注 | 切换复习卡片时草稿不重置 → 旧笔迹渲染到新卡、新笔迹写入旧卡草稿 | `ReviewAnnotationSurface.tsx:62,74-80`（无 else 分支）；`ReviewPage.tsx:1019-1025`（无 `key`） | 视觉错乱 + 数据写错记录 | 效果分支回落 `emptyDraft`；给组件加 `key={recordId:occurrenceKey}` |
| **P1** | AI 问答 | Web/桌面无超时、无取消 | `aiClientService.ts:331`（`timeoutMs ?? 0`）；`AiChatPage.tsx:499-509`（未传 `request`/`signal`）；页面无取消按钮 | 网络挂起时输入框永久禁用，需刷新应用 | 默认 120s 超时 + `AbortController` + 取消按钮 |
| **P1** | 成本 | Android/桌面取消不终止计费请求 | `NativeAiPlugin.java`（无 cancel 方法）；`nativeTts.ts:37-43`；`desktop/main.cjs:558`（无 AbortController） | 用户取消后仍全额计费（播客脚本单次最高 32k max_tokens） | 原生插件加 `cancel(requestId)`；桌面 IPC 传 id 并 abort |
| **P1** | 测试 | E2E 基线红灯：40 通过 / 4 失败 | `e2e/ui-v2-stage5-surfaces.spec.ts:22`；`MorePage.tsx` 移除 `description` | 与 `AGENTS.md` 的全绿声明不符；发布门禁失效 | 更新选择器为 `/^分类管理$/` 或恢复可访问名 |
| **P1** | 路由 | Web 浏览器返回在 4 条路由被吞掉 | `webNavigationHistory.ts:39-52` 白名单缺 `aiExport/templates/ttsSettings/podcastTemplates`；`:240-243` 返回 null；`App.tsx:566-570` 提前 return | 返回键无反应，历史栈错位 | 白名单从 `MoreSubRoute` 派生，或未知子路由降级为 `null` |
| **P1** | 语音复述 | 原生采集错误未被消费 | `NativeVoiceCapturePlugin.java:56-62`（`captureError`）；`nativeVoiceCapture.ts:19,49`（只监听 `audioFrame`） | 麦克风失败时 UI 仍显示“正在听”，无错误提示 | 订阅 `captureError`，置错误并结束迭代 |
| **P2** | 编辑器 | “统一宽度基准”声明与实际不符 | 实测/推导：顶栏 100vw+10px vs 工具栏 100vw−32px+16px；`visual-v2.css:283-297,965-970` | 返回键与工具按钮左边缘错位；粘性工具栏两侧 16px 透出正文 | 统一为同一内边距基准 |
| **P2** | 路由 | 模板页重复返回按钮 | `App.tsx:1550` 未排除 `templates`；`TemplateLibraryPage.tsx:181-183` 自带返回 | 两个返回入口，其一为无文字图标 | 把 `templates` 加入排除列表 |
| **P2** | 日志选择 | 未选中行 grid 塌陷 | `pages.css:330-339`（`:not(.selected)` 单列）+ `JournalPage.tsx:154`（每行都渲染复选框） | 复选框被挤到卡片上方，勾选时整行重排 | 列模板以 `selecting` 而非 `.selected` 判定 |
| **P2** | 批注 | 工具栏不再“动态避让”评分区，且未预留底部空间 | `ReviewPage.tsx:1271`（`{!annotationOpen && ...}` 整块隐藏）；`pages.css:3776-3782`（`position: fixed; bottom: 10px`）；被删除的 `dockBottom/measure` 代码 | 打开批注时评分栏消失（无解释）；底部内容被遮挡约 54px | 恢复测量偏移，或加 `padding-bottom` |
| **P2** | 教练 | 候选块选择被任何 snapshot 刷新重置 | `ReviewCoachWorkbench.tsx:50-62`（依赖 `planningBlocks` 数组身份）；`useAppData.ts:401-406`（`refresh()` 换新数组） | 用户取消勾选的块被重新勾选 → 为已排除内容付费 | 只依赖 `candidateKey` |
| **P2** | 教练 | 生成轮次/提交答案无 `AbortSignal` | `useAppData.ts:549-554,571` | 离开页面后请求仍跑完并计费、结果仍落库 | 每页/每动作建 `AbortController`，卸载时 abort |
| **P2** | 教练 | 解读/规划未禁用 thinking；对不可重试错误也重试整队列 | `quizExecutionGateway.ts:35`（有 `thinkingMode`）vs `aiGateway.ts:61-66`/`sessionPlanningGateway.ts:59-64`（无）；`orchestrator.ts:290,308-344`；`useAppData.ts:148` | 推理模型可能耗空 JSON 预算返回空；401/CORS/schema 失败按“每条 ×3”放大 | 两个网关补 `thinkingMode: "disabled"`；按错误类型决定是否重试 |
| **P2** | 教练 | `AiRoleConfig.timeoutMs/maxRetries/maxConcurrency` 持久化但从不读取 | `useAppData.ts:515-528`（硬编码 60s/90s）；`aiRoleConfigs` 仅用于 id/createdAt 回写 | 配置界面误导；且该配置进入云同步 | 让网关读取配置，或移除该字段 |
| **P2** | 教练 | AI 失败丢失诊断信息，不可重试的错误也提示“重试” | `AdaptiveReviewPage.tsx:118-120`；`ReviewCoachWorkbench.tsx:104-105`；`uiError.ts:39-47` | 未配置 Provider 时用户反复重试无效操作 | 教练路径改用 `ai-request` 上下文并保留原因 |
| **P2** | 路由 | Android 硬件返回在沉浸式复习会话跳到“今天” | `tabNavigation.ts:238`（queue 模式深度 0）；`App.tsx:655-664` | 与自适应任务“返回复习”不一致 | 让返回退出会话到复习首页 |
| **P2** | 语音复述 | 会话状态跨会话泄漏 | `VoiceRecallWorkspace.tsx:124,129,343`；`App.tsx:1388`（无 key） | 第二个会话无法保存摘要；文本残留 | `startSession` 重置全部会话态，或加 `key={sessionId}` |
| **P2** | 语音复述 | 清理/修复/保留 API 从未接线 | `runtimeController.ts:46-49`；`repository.ts:120-163`（生产无调用者） | 7 天保留不生效；崩溃会话不修复；删除记录不标记 | 启动时调用 `initialize()` 与 `cleanupCompleted()` |
| **P2** | 设置 | 保存 AI/TTS 设置可能静默清空已存 Key | `AiSettingsPanel.tsx:150-155`；`TtsSettingsPanel.tsx:112-113`（异步加载未完成即可保存） | 用户丢失密钥，后续付费调用失败 | 仅对“已加载/已编辑”的字段写密钥；加载完成前禁用保存 |
| **P2** | TTS | Web/桌面无超时；Android 对所有错误重试 3 次且可能重复计费 | `knowledgePodcastService.ts:611,646,685,714,756`；`PodcastTtsForegroundService.java:317,371-374,386+` | 任务可能长期停在 generating；网络抖动可能 3 倍计费 | 加超时；仅对 429/5xx/连接超时重试；合成成功后不重跑 |
| **P2** | 编辑器 | 移动端粘性工具栏偏移 2px | `visual-v2.css:776`（`56px + safe-area`）vs 顶栏实际 `54px + safe-area`（下限 58px） | 无刘海时 2px 重叠；有刘海时 2px 透出 | 统一为同一变量 |
| **P2** | 编辑器 | Ctrl+F 查找面板在视野外打开 | `RecordEditorPage.tsx:239-247`；`RichTextEditor.tsx:2096-2098`；`pages.css:3559-3566`（无 sticky） | 用户按 Ctrl+F 无可见反应 | 面板 sticky 或打开时滚动入视 |
| **P2** | 首页 | 今日页宽度基准不一致（实测 720 vs 1040） | `visual-v2.css:190-196`；`layout.css:66-69` | 桌面宽屏视觉不齐 | 统一容器宽度 |
| **P2** | 视觉 | 知识播客使用未定义 `--accent`/`--accent-color`，实际渲染靛蓝硬编码 | `pages.css:2206,2209,2241,2247,2256,2269,2276,2671-2672` | 与当前主题明显冲突（另一套设计系统观感） | 改用 `--color-accent` |
| P3 | 更多页 | `buildBackupDescription` 死代码；`description={undefined}` 残留 | `MorePage.tsx:35,130` | 维护噪音 | 删除 |
| P3 | 编辑器 | 未使用的 `BarChart3`/`BrainCircuit` 导入；`noUnusedLocals` 未开 | `App.tsx:4-17`；`tsconfig.app.json` | 死代码不被拦截 | 清理并开启 `noUnusedLocals` |
| P3 | 组件 | `QuickInsertBar.tsx` 无任何引用，CSS 残留 | 全仓 grep 仅自引用；`components.css:79-80,136,165-166,212-213,255-257,413` | 死代码 | 删除 |
| P3 | 预览 | 预览种子写入生产 IndexedDB 并覆盖 `default` 供应商密钥 | `stage3PreviewSeed.ts:408-411,43,250` | 开发者本机数据/密钥被污染（localhost 门控，用户不可达） | 独立 Dexie 库名；已有密钥时不写入 |
| P3 | 路由 | `?preview=voice-recall-production` 门控缺少 native/desktop 排除 | `App.tsx:93-95`（其余预览门控均有 `isNativePlatform() \|\| isDesktopPlatform()` 排除） | Capacitor Android origin 为 `localhost`，可能误命中（仅切 Tab + 预置路由，无假数据） | 补平台排除 |
| P3 | 语音复述 | `finish()` 无 catch；`schedulePersist` 未处理拒绝；`focus.stop()` 未在 pause 调用 | `VoiceRecallWorkspace.tsx:318-328,504`；`runtimeController.ts:157-168,185-195` | 失败时停留在通话页无提示；潜在未处理拒绝 | 补 `catch` 与 `focus.stop()` |
| P3 | 语音复述 | 本机历史无行数上限，`listHistory` 全量加载 | `repository.ts:5-10,112-114` | 长期使用后本机存储与渲染变慢 | 增加 `maxHistoryEntries` 与分页 |
| P3 | 批注 | `pendingClear` 行可能永久残留；`deleteRecordDrafts` 死代码 | `repository.ts:23,29-39` | 不可见但永久的脏行；删除记录不清理草稿 | 启动时清理 `pendingClear`；删除记录时调用清理 |
| P3 | 复习 | 撤回栈在 App 生命周期内无上限 | `App.tsx:214`；`reviewSession/runtime.ts:9-17` | 大量评分后内存增长 | 限制栈深 |
| P3 | 批注 | `annotationOpen` 跨“队列/卡片库”模式切换不重置；入口按钮 `position:absolute` 可能压住内容 | `ReviewPage.tsx:414-416`；`pages.css:3751-3757` | 返回队列时工具栏仍打开；入口与标题可能重叠 | 模式切换时一并重置；入口改为流内定位 |
| P3 | 视觉 | 12,438 行 CSS / 7 文件，选择器重复定义普遍 | `.review-rating-bar` 3 处、`.review-mode-tabs` 3 处、`.list-row`/`.record-card` 各 2 处 | 维护与回归风险 | 按层拆分、去重 |
| P3 | 统计 | 图表颜色为旧调色板，无暗色变体 | `StatsPage.tsx:17,99,114` | 主题一致性 | 使用主题 token |
| P3 | 视觉 | `::selection` 仍为旧绿色；标签 chip 无暗色变体 | `theme.css:144-150`；`styles.css:1550-1560` | 暗色模式下不一致 | 补 token |
| P3 | 路由 | 收藏夹只能从“今天”进入却归属“更多”；侧栏“录音” vs 页面“录音库” | `TodayPage.tsx:84`；`App.tsx:178,1215` | IA 与命名不一致 | 统一入口与命名 |
| P3 | 路由 | 多个更多子页无页内返回（`PageHeader` 不支持返回） | `ui.tsx:33-56`；`SettingsPage`/`StatsPage`/`OcrSettingsPage` 等 | 依赖全局返回行/系统返回 | `PageHeader` 增加可选返回 |
| P3 | 路由 | 清空回收站为无进度、无错误处理的串行循环 | `App.tsx:1050-1058`；`TrashPage.tsx:42-51` | 大量记录时卡顿，单个失败静默中断 | 批量化 + 进度 + 错误汇总 |
| P3 | 首页 | 今日“最近日志”按创建顺序升序 | `useAppData.ts:238-241,727` | 最新记录在底部，与“最近”语义相反 | 倒序 |
| P3 | 布局 | `--bottom-nav-height: 78px` 与移动端导航 66px+安全区不符 | `theme.css:42`；`visual-v2.css:280`；`pages.css:352-354` | 悬浮条可能被导航遮挡约 12px | 统一 token |
| P3 | 动画 | `PageTransition` 退出层保留可聚焦子节点 | `PageTransition.tsx:81-84` | `aria-hidden` 下仍可 Tab 进入 | 加 `inert` |
| P3 | 日志选择 | 批量操作无失败路径 | `JournalPage.tsx:102-114` | 回调 reject 时选择栏卡在选中态且无提示 | 加 try/catch 与提示 |

---

## 15. 按 P0 → P3 排序

- **P0（1 项）**：P0-1 语音复述生产链路为纯本地模拟。
- **P1（10 项）**：披露虚假、假状态指示、伪造转写、移动端编辑器菜单不可点（回归）、批注跨卡串写、AI 问答无超时/取消、取消不终止计费、E2E 红灯、Web 返回失效、原生采集错误未消费。
- **P2（20 项）**：见第 14 节。
- **P3（25 项）**：见第 14 节。

---

## 16. 最值得优先修复的问题（按投入产出排序）

1. **P0-1 + P1-1 + P1-2 + P1-3（同一处改动）**：语音复述要么接入真实 Provider，要么在 UI 上明确标注为“本机演示”，并把披露文案改为真实情况。**当前状态是“用户会相信它能用，但它不能”，这是本次审计唯一的产品级阻断项。**
2. **P1-4 移动端编辑器菜单**：一行 CSS 回归，却让 Android 端最常用的记录操作（加入复习/导出/收藏/删除/语音复述）全部不可达。修复成本极低、收益最大。
3. **P1-5 批注跨卡串写**：会造成用户数据写错记录，属数据正确性问题，修复约 3 行。
4. **P1-6 + P1-7 成本失控**：给 AI 问答加超时/取消、给原生/桌面加真正的 abort。直接对应“无感知烧配额”风险。
5. **P1-8 E2E 红灯**：更新选择器即可恢复发布门禁，否则后续所有回归判断都失去依据。
6. **P1-9 + P2-2 路由返回**：白名单补全 + 排除模板页重复返回。
7. **P2-13 密钥被清空**：用户资产损失风险，修复简单。

---

## 17. 总体结论

### 这次重构之后，当前版本是否达到“可继续开发 / 内测 / 正式使用”？

| 阶段 | 结论 |
| -- | -- |
| **继续开发** | ✅ 可以。代码结构清晰、类型检查与 840 项单测全绿、正式数据写入有事务与 schema 校验保护。 |
| **内测** | ⚠️ **有条件可以**，但必须先处理 P0-1（语音复述的真实性/标注）与 P1-4（移动端编辑器不可用），并修掉 E2E 红灯。否则内测用户会在 Android 上直接遇到“记录操作消失”和“语音功能是假的”两类问题。 |
| **正式使用** | ❌ 暂不建议。除上述外，还存在成本失控路径（AI 问答挂死、取消失效）与跨卡批注写错记录的数据正确性问题。 |

### 本轮重构的性质判断

这是一次**以新增特性为主、局部收口为辅**的重构，**没有破坏原有数据流、路由关系与状态管理骨架**：
- 复习评分/撤回、教练正式写入、云同步与备份边界**均未被破坏**，且新增能力（撤回栈上提、批注本机隔离、语音本机三表）都有对应测试守护。
- 真正的风险集中在**新特性自身的完成度**，而不是“重构改坏了老功能”。唯一的重构回归是移动端编辑器顶栏的 `overflow: hidden`（P1-4）与 MorePage 描述移除导致的 E2E 失配（P1-8）。

### 总体健康度

| 维度 | 评分 | 说明 |
| -- | -- | -- |
| 功能完整性 | ★★★☆☆ | 除语音复述外完整；语音复述是“UI 完成、底层未接入” |
| 稳定性 | ★★★★☆ | 840 单测全绿、构建通过；E2E 有 4 项红灯 |
| 路由与交互 | ★★★☆☆ | 路由模型健壮、无死界面；Web 返回在 4 条路由失效、存在重复返回与移动端菜单不可点 |
| AI 调用可靠性 | ★★★☆☆ | 真实调用 + schema 校验 + 有界 prompt；缺超时/取消、错误可诊断性弱 |
| API 成本控制 | ★★★☆☆ | 上下文/输出/任务去重/云同步预算做得不错；AI 问答无超时、取消失效、教练重试策略过宽 |
| 语音通话体验 | ★☆☆☆☆ | 界面设计与布局质量高，但**功能与状态全部是模拟的**，且披露文案不实 |
| UI / UX | ★★★☆☆ | 视觉系统整体统一；存在移动端菜单不可点、宽度基准不一致、播客页靛蓝冲突 |
| 重构后的架构一致性 | ★★★★☆ | 分层清晰（domain/repository/gateway/orchestrator）、边界有文档与测试；存在较多未接线/死代码（语音 Provider 层、若干维护 API） |

**一句话总结：老功能稳、新功能虚。** 本轮重构没有动摇 StudyJournal 的既有骨架，但把“实时语音复述”作为一个看起来能用、实际未接入任何 Provider 的功能交付到了用户可见的 UI 里——这是当前版本最大的风险，也是与 `AGENTS.md` 中“真实 Provider 仍为发布门禁”这一自我认知之间最需要对齐的地方。

---

*本报告为只读审计产物，未修改任何项目源码、配置或数据，未创建 commit / PR。报告文件本身位于仓库根目录，如需纳入版本控制请自行决定。*
