# StudyJournal 修复计划

**依据**：`STUDYJOURNAL_AUDIT_REPORT.md`（2026-09-09，基线 commit `5f3cdc0`）
**范围**：P0（1 项）+ P1（10 项）+ P2（20 项）
**P0 方向**：**接入真实 Provider**（不做“仅标注为演示”的临时方案）
**性质**：计划 + 执行记录

---

## 执行进度（更新于 2026-09-09）

**B2 批次已完成（7/7 项）**

| ID | 状态 | 改动 | 验证 |
| -- | -- | -- | -- |
| B2-1 移动端编辑器菜单不可点 | ✅ | `visual-v2.css` 移除本轮新增的 `.record-editor-topbar` / `.record-action-row` 的 `overflow: hidden`（页面级 `overflow-x: clip` 已足够防横向溢出） | 浏览器命中测试：移动编辑 / 移动阅读 / 桌面均 **6/6 可点**（修复前移动端 0/6）；新增 e2e 断言（旧测试用 `selectOption` 无法发现遮挡） |
| B2-2 批注跨卡串写 | ✅ | `ReviewAnnotationSurface` 在 `(recordId, occurrenceKey)` 变化时重设草稿并清理选中/绘制状态；`ReviewPage` 给组件加 `key` | 新增 2 条单测；**临时回退修复后测试确实失败**，证明断言有效 |
| B2-3 AI 问答无超时/取消 | ✅ | `DEFAULT_AI_REQUEST_TIMEOUT_MS = 120s`（`timeoutMs ?? 0` → 默认值）；`sendChatCompletion` 透传 `signal`；`AiChatPage` 传 `AbortController` + 忙碌时按钮变为“停止生成” | 新增 2 条单测（默认超时、signal 透传） |
| B2-4 取消不终止计费 | ✅ | 桌面：`main.cjs` 新增 `desktopTtsRequests` + `tts-cancel` IPC，全部 `net.fetch` 带 `signal`；`preload.cjs` / `desktop.d.ts` / `nativeTts.ts` 接线。Android：`NativeAiPlugin.cancel(requestId)` + `nativeAi.ts` 传 requestId 并在 abort 时中止 | `node --check` ✅；Android `:app:compileDebugJavaWithJavac` ✅（编译器抓出一处变量重名）；新增 2 条单测 |
| B2-5 E2E 红灯 | ✅ | 选择器改为限定 `.more-page` 下的“分类管理”（描述移除后与侧栏同名） | e2e **40 通过/4 失败 → 44/44** |
| B2-6 Web 返回失效 | ✅ | `MORE_SUB_ROUTE_VALUES` 成为单一数据源，`MoreSubRoute` 由它派生；未知子路由降级为 `null` 而非整份快照失效 | 新增 1 条单测覆盖全部 15 条子路由 + 未知值降级 |
| B2-8 模板页重复返回 | ✅ | `App.tsx` 排除列表抽为 `MORE_SUB_ROUTES_WITH_OWN_BACK` 并补 `templates` | 代码审查 |

**B2 后全量验证**

| 检查 | 结果 |
| -- | -- |
| `npx tsc -b` | ✅ exit 0 |
| `npx vitest run` | ✅ **128 文件 / 847 测试**（基线 126/840） |
| `npm run build` | ✅ exit 0 |
| `npx playwright test` | ✅ **44/44**（基线 40 通过 / 4 失败） |
| Android `:app:compileDebugJavaWithJavac` | ✅ exit 0（JDK 17 + 离线 Gradle） |

**B2 遗留说明**：B2-4 的原生/桌面改动已通过编译与单测，但**未在真机 / Electron 运行时验证**，仍需按计划 B4-4 手测抓包确认取消后连接确实断开。

**尚未开始**：B3（P2 共 20 项）、B4（验收与门禁）。B2-7（原生采集错误）按计划并入 B1-5a。

---

## 真实 Provider 验证结果（2026-09-09，真实账号）

| 链路 | 结果 | 证据 |
| -- | -- | -- |
| DeepSeek LLM | ✅ 直连可用 | `deepseek-chat` / `deepseek-v4-pro` 均 HTTP 200 |
| DeepSeek 关闭思考 | ✅ 语音场景必需 | `deepseek-v4-pro` 默认返回 `reasoning_content`，12 token 预算下 `finish_reason=length` 且**正文为空**；加 `thinking:{type:"disabled"}` 后直接返回正文（1 token）。**证实 P2-7 不只是浪费，而是会让语音回复为空** |
| 阿里云 Paraformer 实时 ASR | ✅ 直连可用 | `run-task → task-started → 音频帧 → result-generated → task-finished` 全链路通 |
| 阿里云 ASR 端到端 | ✅ 真实语音识别正确 | Fish TTS 生成「间隔复习为什么有效」→ ffmpeg 转 16k mono PCM → 识别出「间隔复习为什么有效？」，首个结果 601ms |
| Fish Audio TTS | ✅ 经代理可用 | HTTP 200，17,971 字节 MP3（44.1kHz mono），首字节 ~1.7s |
| Fish Audio 浏览器直连 | ❌ 不可行 | OPTIONS preflight 无 `Access-Control-Allow-Origin`（404 `no_route`），与 `browserDirectSupported: false` 一致 |
| 豆包流式 ASR | ❌ 凭证不匹配 | 仅 App ID：400 `no token or access_key was found`；补 App ID + Access Token 后：**401 `load grant: requested grant not found in SaaS storage`**（`duration` 与 `concurrent` 两种 Resource-Id 均如此）→ 该 App ID 未开通流式 ASR 服务，或 Token 属于其他应用 |
| 豆包 TTS | ❌ 凭证不匹配 | `POST /api/v3/tts/unidirectional` → 401 `Invalid X-Api-Key`（该密钥不是语音服务的 X-Api-Key） |
| 火山 IAM AK/SK | ⚠️ 未使用 | 这对是 OpenAPI 签名凭据，不适用于 openspeech 的 App-Key/Token 体系；未在本次链路中使用 |

**由此更新的建议**

- **D2（ASR 供应商）**：改为**阿里云 Paraformer 为主**（已验证可用），豆包作为备选，待拿到 Access Token 后接入。
- **D1（Web 端策略）**：维持「Web 不提供真实语音」。依据：ASR 需要自定义 `Authorization` 头（浏览器 WebSocket 不支持），TTS preflight 无 CORS 头。
- **新增必做**：语音 LLM 必须 `thinking: disabled` + 小 `max_tokens`（语音场景不需要长回复），否则回复为空。
- **环境注意**：本机需代理才能访问 `api.fish.audio`；Electron 的 `applyProxy` 已覆盖桌面端，浏览器走系统代理。
- **密钥处理**：验证用的密钥只经环境变量传入，未写入任何文件；建议验证完成后轮换。

---

## B0 / B1 执行进度

**B0 批次已完成（地基）**

| ID | 状态 | 内容 | 验证 |
| -- | -- | -- | -- |
| B0-1 | ✅ | `runtimePlatform.ts`：web/desktop/android 判定 + 平台不可用文案 | 3 单测 |
| B0-2 | ✅ | `credentials.ts`：凭证解析（profile id → provider family → fallback），空值不返回 | 4 单测 |
| B0-3 | ✅ | 复用现有 `resolveVoiceProviderTemplate`（模板 + 本机覆盖） | 既有测试 |
| B0-4 | ✅ | Web 策略落定：不提供真实语音，给出明确文案（依据见上表） | — |

**B1 进行中**

| ID | 状态 | 内容 | 验证 |
| -- | -- | -- | -- |
| B1-1d | ✅ 阿里云 | `aliyunAsrProtocol.ts`（纯编解码）+ `aliyunAsrTransport.ts`（`VoiceAsrTransport` 实现） | 4 + 5 单测；**真实服务验收测试**（`VOICE_ASR_ALIYUN_KEY=...` 时运行）已通过，247ms 完成一次真实会话 |
| B1-1a | ✅ 桌面 | `desktop/main.cjs` 主进程 WebSocket 代理（`voice-asr-open/send/close` + 事件通道）、`preload.cjs`、`desktop.d.ts`、`desktopVoiceSocket.ts`（渲染层 socket 适配） | 2 单测（含经代理跑通完整阿里云会话）；`node --check` ✅ |
| B1-2 | ✅ | `audioPlaybackSink.ts`：Web Audio 真实播放，支持 `provider-native`（MP3 解码）与 `pcm-s16le`，`play()` 在播放结束/被打断后才 resolve | 4 单测 |
| B1-1b | ✅ | Android 原生 ASR 传输：`NativeVoiceAsrPlugin`（OkHttp WebSocket + base64 帧桥）、`androidVoiceSocket.ts`、`MainActivity` 注册、`okhttp:4.12.0` 依赖；`bridgeVoiceSocket.ts` 抽出通用桥接层供桌面/Android 共用 | 3 单测；`gradlew :app:compileDebugJavaWithJavac` ✅ |
| B1-3 | ✅ | 工作区接入真实管线：`productionPipeline.ts` 解析模板+凭证+平台；删除 `createTeacherReply` 与伪造转写；采集帧进 `AsyncQueue` 交给真实 ASR；TTS 音频进 Web Audio 播放；`finalizing-asr` 阶段承载“转写校对” | 4 单测；新增“无凭证时拒绝启动而非模拟通话”用例 |
| B1-4 | ✅ | 波形/“正在识别”由**真实采集状态**驱动；主按钮文案与实际动作一致；连接指示改为会话状态（“通话中/正在连接/已暂停/已断开”）；披露文案显示**实际运行的 LLM 模型** | e2e 覆盖拒绝路径 |
| B1-5 | ✅ | 未采集到音频给出明确提示；原生 `captureError` 被消费并中止采集；采集异常经 `startCapture(onError)` 上报到 UI；`startSession` 重置转写/回复草稿/历史标记；启动时调用 `initialize()`（修复中断会话）与 `cleanupCompleted()`；删除记录时 `markSourceUnavailable`；本机历史上限 200 条 | 新增历史上限单测；既有仓库测试 |
| B1-6 | ✅ | LLM `max_tokens` 钳制到 320；强制 `thinking: disabled`；教练提示词限 80 字回复 / 6k 材料 / 最近 3 轮 | 提示词单测 |

**默认模板变更**：`voice-default-cn` 升到 `@2`，ASR 从豆包切到**阿里云 Paraformer**（豆包未开通）。`docs/voice-recall-provider-configuration.md` 同步更新。

**B0/B1 后全量验证**：`npx tsc -b` ✅ · `npx vitest run` ✅ **137 文件 / 881 测试通过，1 项 live 测试按设计跳过** · `npm run build` ✅ · `npx playwright test` ✅ **44/44**。

---

## B3 执行进度（P2，20 项）

| ID | 状态 | 修复 | 验证 |
| -- | -- | -- | -- |
| B3-1 | ✅ | 解读 / 规划网关补 `thinkingMode: "disabled"` | 既有网关测试 |
| B3-2 | ✅ | 新增 `AiRequestError.retryable`；解读与深度分析遇到确定性失败（401/403/非 JSON/CORS）立即停止重试，不再按“每条 ×3”放大 | 既有编排测试 |
| B3-3 | ✅ | `generateQuizTurn` / `submitQuizAnswer` 接受 `AbortSignal`；`AdaptiveReviewPage` 页面级 controller 卸载即取消 | 类型 + 既有测试 |
| B3-4 | ✅ | 解读提示词对决策块内容（4k 字符）、评论（1k）、历史（最近 5 条）做上限 | 类型 |
| B3-5 | ✅ | AI/TTS 设置面板只写入或清除“已加载或已编辑”的密钥；加载未完成时保存不再清空已存密钥 | **新增 2 条单测**（含“加载未完成即保存不得清空”） |
| B3-6 | ✅ | TTS 每个请求加 2 分钟超时（Web/桌面/宿主）；Android TTS 引入 `NonRetryableTtsError`，4xx 与“合成成功但下载失败”不再重试（避免重复计费） | 既有播客测试 + Android 编译 |
| B3-7 | ✅ | 教练角色配置的 `timeoutMs` 改为权威值（读取持久化配置）；`maxRetries` 写为 0（与单次尝试的实际行为一致） | 类型 |
| B3-8 | ✅ | 新增 `ActionableError` / `formatActionableError`；配置类错误（缺 Key、Base URL 错、CORS）原样展示，其余仍走通用文案 | 既有 uiError 测试 |
| B3-9 | ✅ | 工作台候选块选择只依赖 `candidateKey`，快照刷新不再重置用户勾选 | 既有工作台测试 |
| B3-10 | ✅ | 日志多选行改用 `.selecting` 判定列模板，未选中行不再塌陷重排 | — |
| B3-11 | ✅ | 恢复批注工具栏的测量停靠（不再隐藏评分栏）；评分栏与工具栏同时可见且不重叠 | — |
| B3-12 | ✅ | 移动端编辑器顶栏与工具栏统一为 100vw 全宽 + 16px 内边距 | — |
| B3-13 | ✅ | 粘性工具栏偏移改为 `max(58px, 54px + safe-area)`，与顶栏实际高度一致 | — |
| B3-14 | ✅ | 查找替换面板改为 `position: sticky`，Ctrl+F 打开即在视口内 | — |
| B3-15 | ✅ | 今日页新建带宽度改为 100%，与下方列表对齐 | — |
| B3-16 | ✅ | 播客页 `var(--accent, #6d5dfc)` → `var(--color-accent)`，移除靛蓝硬编码 | — |
| B3-17 | ✅ | Android 返回键：自适应任务返回复习页，复习会话返回队列而非跳到“今天” | — |
| B3-18 | ✅ | 图表改用 `--chart-1..5` 主题变量；`::selection` 改用主色；标签 chip 增加暗色变体 | — |
| B3-19 | ✅ | 预览种子不再覆盖已存在的真实 AI 密钥 | — |
| B3-20 | ✅ | `?preview=voice-recall-production` 门控补 native/desktop 排除 | — |
| 清理 | ✅ | 删除 `QuickInsertBar.tsx` 及其 CSS、`buildBackupDescription`、`deleteRecordDrafts`、未使用图标导入；`pendingClear` 脏行可自愈 | 全量测试 |

**B3 后全量验证**：`npx tsc -b` ✅ · `npx vitest run` ✅ **138 文件 / 886 测试通过** · Android `compileDebugJavaWithJavac` ✅

---

## B4 验收进度

| ID | 状态 | 内容 | 结果 |
| -- | -- | -- | -- |
| B4-1 | ✅ | `tsc` / `vitest` / `build` | 全绿 |
| B4-2 | ✅ | Playwright 全量 | 44/44 |
| B4-3 | ✅ | Firebase Emulator | **4/4**（`npm run test:firebase`） |
| B4-4 | ◐ | 真实链路验收 | **ASR**：`aliyunAsrTransport.live.test.ts` 通过（247ms 完成真实会话）· **LLM→TTS 回复链**：`voicePipeline.live.test.ts` 通过（3.4s，真实音频分片）· **TTS→ASR 往返**：Fish 生成语音经 ffmpeg 转 PCM 后由阿里云正确识别出「间隔复习为什么有效？」。仍需桌面/真机跑完整 5 轮通话并抓包确认取消断开 |
| B4-5 | ◐ | 成本核对 | 单轮用量已可计量（`ttsCharacters`/`llmOutputTokens` 写入轮次记录）；待真实账号账单核对 |
| B4-6 | ✅ | 移动端编辑器菜单 | Playwright 命中测试断言纳入 CI |
| B4-7 | ✅ | 文档同步 | `AGENTS.md`、`CHANGELOG.md`、`README.md`、`docs/realtime-voice-recall-implementation.md`（新增阶段 7 与验证表）、`voice-recall-provider-configuration.md`、`voice-recall-privacy.md`、`voice-recall-release-checklist.md`、`docs/新的方案.md` 及两份历史方案文档的测试基线全部同步 |
| B4-8 | ◐ | 发布门禁清单 | `docs/voice-recall-release-checklist.md` 已更新（自动化项勾选、Provider 项标注已验证/待开通、真机项补充抓包要求）；**逐项签字仍需在真机与账单核对后由人完成** |

**线上验收测试的运行方式**（未提供密钥时自动跳过，CI 保持确定性）：

```bash
VOICE_ASR_ALIYUN_KEY=sk-... npx vitest run src/features/voiceRecall/aliyunAsrTransport.live.test.ts
VOICE_LIVE_DEEPSEEK_KEY=sk-... VOICE_LIVE_FISH_KEY=sk-... VOICE_LIVE_TTS=1 NODE_USE_ENV_PROXY=1   npx vitest run src/features/voiceRecall/voicePipeline.live.test.ts
```

**e2e 覆盖说明**：生产通话界面现在需要真实 ASR 链路（Web 不支持），因此 `voice-recall-production.spec.ts` 改为断言“未配置时拒绝启动”；通话界面的视觉回归改由原型用例与桌面端验收覆盖。

**本轮测试抓到的真实缺陷（值得记录）**

1. `desktopVoiceSocket` 最初把字符串控制帧（run-task/finish-task）转成了空字节数组 —— 单测发现，已修。
2. `NativeAiPlugin` 取消功能引入时与方法内既有 `requestId` 变量重名 —— Android 编译器发现，已修。
3. 播放 sink 的 `Float32Array` 泛型在 TS 5.7+ 下不兼容 —— `tsc` 发现，已修。

---

## 0. 先决约束（决定计划形态）

审计已确认：`BUILT_IN_ASR_PROFILES` 与 `BUILT_IN_VOICE_TTS_PROFILES` 中**所有真实 Provider 的 `browserDirectSupported` 均为 `false`**

```
voice-asr-doubao-streaming   wss://openspeech.bytedance.com/...   browserDirectSupported: false
voice-asr-aliyun-paraformer  wss://dashscope.aliyuncs.com/...     browserDirectSupported: false
voice-tts-fish-s21           https://api.fish.audio/v1/tts        browserDirectSupported: false
voice-tts-doubao-seed-20     https://openspeech.bytedance.com/... browserDirectSupported: false
```

而 `assertBrowserDirectSupported()`（`providerProfiles.ts:281-287`）在 `platform === "web"` 时直接抛错。**结论：**

| 平台 | ASR | TTS | 结论 |
| -- | -- | -- | -- |
| Web（浏览器） | 需自建中继 | 需自建中继 | 无中继则真实链路不可用 |
| Desktop（Electron） | 主进程 WebSocket 代理 | 主进程 HTTP 代理 | 可行，需实现 IPC |
| Android（Capacitor） | 原生插件 WebSocket | 原生插件 HTTP | 可行，需实现插件 |

因此“接入真实 Provider”= **接入方案 + 三条平台传输通道 + 播放通道 + 凭证通道**，不是改几行调用。计划据此分 5 个批次。

**外部依赖（不可压缩）**：豆包流式 ASR / 阿里云 Paraformer / Fish Audio / DeepSeek 的**可用账号与配额**，以及真机（Android）验收环境。没有账号，批次 1 只能完成代码与 Mock 通道验证，无法完成验收。

---

## 1. 批次总览

| 批次 | 主题 | 覆盖问题 | 估算 | 依赖 |
| -- | -- | -- | -- | -- |
| **B0** | 地基：平台判定、凭证槽位、Provider 解析 | 前置 | 1 天 | 无 |
| **B1** | 语音真实链路接入（P0 核心） | P0-1, P1-1, P1-2, P1-3, P1-10 | 8–14 天 | B0 + 真实账号 |
| **B2** | P1 其余修复 | P1-4…P1-9 | 2–3 天 | 无 |
| **B3** | P2 修复 | 20 项 | 3–5 天 | B1/B2 不阻塞 |
| **B4** | 回归、验收、发布门禁 | 全部 | 2 天 | 全部 |

**建议顺序**：B2（1 天内先消除移动端阻断与红灯）→ B0 → B1 → B3 → B4。
理由：B2 的 P1-4 是“一行 CSS 让手机端记录操作全部消失”的回归，修复成本极低、用户感知最强；B1 周期最长，越早暴露外部依赖越好。

---

## 2. B0 — 地基（1 天）

| ID | 任务 | 改动点 | 验证 |
| -- | -- | -- | -- |
| B0-1 | 新增统一平台判定 `voiceRuntimePlatform(): "web"\|"desktop"\|"android"` | 新文件 `src/features/voiceRecall/runtimePlatform.ts`；复用 `lib/platform.ts` 的 `isDesktopPlatform` / `Capacitor.isNativePlatform()` | 单测：三种平台返回正确值 |
| B0-2 | 凭证槽位：ASR 密钥与 TTS 密钥落位 | `src/services/storageAdapter.ts:2305-2322` 的 `getAiSecret/saveAiSecret/clearAiSecret` 已按 `providerId` 隔离，**直接复用**：ASR 用 `voice-asr-doubao` / `voice-asr-aliyun`，TTS 用现有 `ttsProvider.id`，LLM 用现有 `aiProvider.id` | 单测：写入/读取/清除互不串号 |
| B0-3 | Provider 解析入口：模板 + 本机覆盖 → 已解析 profile | 复用 `resolveVoiceProviderTemplate`（`providerProfiles.ts:250-275`）；补一个 `resolveActiveVoiceProviders({templateId, config, settings, secrets})` | 单测：缺凭证时抛出可读错误 |
| B0-4 | Web 端策略落定（**待决策 D1**） | 见 §7 待决策 | — |

---

## 3. B1 — 语音真实链路接入（P0 核心，8–14 天）

### B1-1 ASR 传输通道（三平台）

现状：`VoiceAsrTransport`（`transportAsrAdapter.ts:11-25`）**只有接口，无任何实现**。

| 子任务 | 内容 | 文件 |
| -- | -- | -- |
| B1-1a | Desktop：主进程 WebSocket 代理。新增 IPC `study-journal:voice-asr-open/send/finish/close`，主进程用 `ws` 或 `undici` WebSocket 连接豆包/阿里云，规避渲染进程 CORS | `desktop/main.cjs`、`desktop/preload.cjs`、`src/desktop.d.ts` |
| B1-1b | Android：新增 `NativeVoiceAsrPlugin.java`（`OkHttp` WebSocket），与现有 `NativeAiPlugin` 同构 | `android/app/src/main/java/com/noteproject/study408/` |
| B1-1c | Web：自建中继（**待决策 D2**）或按 B0-4 策略降级 | `src/features/voiceRecall/webAsrTransport.ts` |
| B1-1d | 豆包/阿里云协议适配：二进制帧封装、鉴权头（`X-Api-App-Key`/`Authorization`）、`partial`/`final` 事件映射到 `AsrStreamEvent` | 新增 `doubaoAsrTransport.ts` / `aliyunAsrTransport.ts` |
| B1-1e | 接入 `retryVoiceProviderStream` + `VoiceProviderCircuitBreaker`（`providerRuntime.ts:130-175`），保留 `!emitted` 才重试的语义 | `transportAsrAdapter.ts` |

**验收**：真实账号下，说一句话 → 200–800ms 内出现 partial → 停止后 1.5s 内出现 final，文本正确。

### B1-2 播放通道（真实 TTS 出声）

现状：`voiceRecallRuntime` 用 `silentSink`（`runtimeController.ts:11,199`），`VoicePlaybackQueue.enqueue()` 全仓无调用。

| 子任务 | 内容 | 文件 |
| -- | -- | -- |
| B1-2a | 实现 `VoicePlaybackSink`：Web/Desktop 用 `AudioContext` + `decodeAudioData`（mp3）/ PCM 直放；Android 走 `MediaPlaybackService` 或 `AudioTrack` | 新增 `webPlaybackSink.ts` / `nativePlaybackSink.ts` |
| B1-2b | 打断语义：`generation` 不匹配丢弃（`playbackQueue.ts:17-25` 已有），`interrupt()` 需真实停止音频源 | `playbackQueue.ts` |
| B1-2c | 半双工门控真实化：`systemCaptureGate` 为 true 时**真正暂停采集适配器**（`adapter.pause()`），而不只是 UI 标志 | `domain.ts:128-145` + `runtimeController.ts` |
| B1-2d | 把默认 runtime 的 sink 从 `silentSink` 换为真实 sink；`PLAYBACK_FINISHED` 由播放队列 `waitUntilIdle()` 驱动 | `runtimeController.ts:199` |

**验收**：AI 回复边生成边播报（首句在 LLM 首个句子完成即出声），点“打断”立即静音并回到 listening，无叠播。

### B1-3 工作区接线（删除伪造实现）

| 子任务 | 内容 | 位置 |
| -- | -- | -- |
| B1-3a | 新增 `runtime.runTurn({pipeline, frames, ...})`：把采集帧喂给 pipeline，而不是丢弃 | `runtimeController.ts:116-136` |
| B1-3b | **删除** `createTeacherReply`（本地模板 LLM） | `VoiceRecallWorkspace.tsx:76-81` |
| B1-3c | **删除** `stopCapture` 中的伪造转写 `setMockAsrText(sample)`，改为由 ASR `final` 事件填充 | `VoiceRecallWorkspace.tsx:251-264` |
| B1-3d | 改写 `submitTurn`：调用 pipeline，接 `onAsrEvent`（实时字幕）/ `onTeacherToken`（打字机）/ `onAudio`（播放），`providerFinalText` 写真实 ASR 结果 | `VoiceRecallWorkspace.tsx:274-316` |
| B1-3e | 保留 `createSummary`（本地摘要，非 AI 回复）与 `summaryHtml`；确认不再有 AI 文本来源 | `VoiceRecallWorkspace.tsx:83-87` |
| B1-3f | `CONNECT`/`CONNECTED` 由真实握手驱动：连接测试通过后才置 `listening`；失败置 `failed` 并可 `RETRY` | `VoiceRecallWorkspace.tsx:178-204,222-226,498` |

### B1-4 状态与文案真实化（P1-1 / P1-2）

| 子任务 | 内容 | 位置 |
| -- | -- | -- |
| B1-4a | 连接指示器由真实状态推导（`connecting` 显示“正在连接”，只有握手成功才显示“已连接”，`failed` 显示“已断开”） | `VoiceRecallPresentation.tsx:297` |
| B1-4b | “正在识别你的回答…”仅在 ASR 真的在跑且收到 partial 时显示；否则显示中性文案 | `VoiceRecallPresentation.tsx:303` |
| B1-4c | `active`（波形动画）由采集适配器真实状态推导，不再用 `state.captureRequested` 推导 | `VoiceRecallWorkspace.tsx:363` |
| B1-4d | 披露文案改为由**实际已接入的适配器**生成；未配置凭证时显示“尚未配置语音服务，无法开始”并禁用开始按钮 | `VoiceRecallWorkspace.tsx:543`、`VoiceRecallPresentation.tsx:187` |
| B1-4e | `auto-half-duplex` 主按钮语义修正：标签必须与实际动作一致（“开始回答”/“发送”），不得出现“立即发送”却执行录音 | `VoiceRecallWorkspace.tsx:364-372,400-427` |
| B1-4f | 模板状态标签：`candidate` 模板在真实账号验收通过前保持“待真实链路验证”，验收通过后置 `verified` 并记录 `verifiedAt` | `providerProfiles.ts:166-172` |

### B1-5 采集健壮性（P1-10）

| 子任务 | 内容 | 位置 |
| -- | -- | -- |
| B1-5a | 订阅原生 `captureError`，置错误、结束迭代器、显示可读错误 | `nativeVoiceCapture.ts:19,49`；`NativeVoiceCapturePlugin.java:56-62` |
| B1-5b | 采集结束后恢复被暂停的播客播放（`MediaPlaybackService.pauseForRecording` 无对应恢复） | `NativeVoiceCapturePlugin.java:43` |
| B1-5c | 会话级清理：`startSession` 重置 `transcript/mockAsrText/historySaved/message/framesRef`，或给工作区加 `key={sessionId}` | `VoiceRecallWorkspace.tsx:124-145,178-204` |
| B1-5d | 接线维护 API：启动时调用 `runtime.initialize()`（修复中断会话）与 `repository.cleanupCompleted()`（7 天保留） | `runtimeController.ts:46-49`；`repository.ts:152-163` |
| B1-5e | 删除记录时调用 `markSourceUnavailable()`；本机历史加行数上限 | `repository.ts:132-144,112-114` |

### B1-6 语音成本护栏（新增，随真实链路一起上）

| 子任务 | 内容 |
| -- | -- |
| B1-6a | LLM `max_tokens` 在语音层钳制（建议 ≤ 300，语音场景不需要长回复） |
| B1-6b | 每轮 TTS 合成请求数上限（建议 ≤ 8 句），超出则合并/截断 |
| B1-6c | 每会话轮次上限（`VOICE_RECALL_LIMITS.maxSessionTurns` 已有 160，建议语音层另设 ~40） |
| B1-6d | ASR 传输加总时长超时（`TransportAsrStreamAdapter` 目前无超时） |
| B1-6e | 真实用量写入 `VoiceRecallUsageEstimate`（当前 `saveHistory` 恒写 `emptyUsage`） |

---

## 4. B2 — P1 其余修复（2–3 天）

| ID | 问题 | 修复 | 文件 | 验证 |
| -- | -- | -- | -- | -- |
| B2-1 | **P1-4 移动端编辑器菜单不可点**（本轮回归） | 移除 `≤920px` 下的 `overflow: hidden`，或把菜单改为 `position: fixed` + 动态定位（推荐后者，避免与后续布局再冲突） | `visual-v2.css:283-288,300-303`；`styles.css:1860-1872` | Playwright：390px 下命中测试 6/6 可点（现有探针已可复用） |
| B2-2 | **P1-5 批注跨卡串写** | ① 加载效果加 `else` 分支回落 `emptyDraft(recordId, occurrenceKey, contentRevision)`；② `ReviewPage` 给 `ReviewAnnotationSurface` 加 `key={`${recordId}:${occurrenceKey}`}` | `ReviewAnnotationSurface.tsx:62,74-80`；`ReviewPage.tsx:1019-1025` | 新增单测：切卡后 `draft.recordId` 为新卡；切卡后不渲染旧元素 |
| B2-3 | **P1-6 AI 问答无超时/取消** | `sendChatCompletion` 默认 `timeoutMs = 120_000`；`AiChatPage.send()` 传 `AbortController.signal`；发送中显示“停止”按钮 | `aiClientService.ts:331,496-520`；`AiChatPage.tsx:499-509` | 单测：超时抛出可读错误且 `busy` 复位；手测：点击停止后立即恢复输入 |
| B2-4 | **P1-7 取消不终止计费** | ① `NativeAiPlugin` 增加 `cancel(requestId)` 并在 `chat` 中记录 `HttpURLConnection` 以 `disconnect()`；② 桌面 TTS 走 IPC 传 requestId，主进程 `AbortController` 中断 `net.fetch` | `NativeAiPlugin.java`；`nativeTts.ts:37-43`；`desktop/main.cjs:558` | 手测：取消后抓包确认连接断开 |
| B2-5 | **P1-8 E2E 红灯** | 更新选择器 `/分类管理 按学科和标签/` → `/^分类管理$/`（或给 `ListRow` 补 `aria-label` 保留描述） | `e2e/ui-v2-stage5-surfaces.spec.ts:22` | `npx playwright test` 全绿 |
| B2-6 | **P1-9 Web 返回失效** | `MORE_SUB_ROUTES` 从 `MoreSubRoute` 派生；未知子路由降级为 `null` 而不是返回 `null` 快照 | `webNavigationHistory.ts:39-52,240-243` | 单测：4 条路由的快照可往返；手测：浏览器返回 |
| B2-7 | **P1-10 采集错误** | 见 B1-5a | — | — |
| B2-8 | 顺带：模板页重复返回按钮 | `showWebNavigationBack` 排除列表加 `templates` | `App.tsx:1550` | 手测：模板页只有 1 个返回 |

---

## 5. B3 — P2 修复（3–5 天，按模块分组）

### 5.1 成本与容错（优先）

| ID | 问题 | 修复 | 文件 |
| -- | -- | -- | -- |
| B3-1 | 教练解读/规划未禁用 thinking | 两个网关补 `thinkingMode: "disabled"` | `aiGateway.ts:61-66`；`sessionPlanningGateway.ts:59-64` |
| B3-2 | 教练对不可重试错误也重试整队列 | 按 `VoiceProviderError.retryable` / HTTP 状态决定是否重试；401/403/CORS/schema 失败直接标记 `failed` | `orchestrator.ts:290,308-344`；`useAppData.ts:148` |
| B3-3 | 生成轮次无 AbortSignal | 每页/每动作建 `AbortController`，卸载时 abort | `useAppData.ts:549-554,571` |
| B3-4 | 解读提示词无长度护栏 | 对 `decisionBlockContent` + 历史解读做字符上限与截断 | `aiGateway.ts:37-52`；`orchestrator.ts:292-307` |
| B3-5 | 保存设置可能清空密钥 | 仅写“已加载且被编辑”的密钥字段；加载完成前禁用保存 | `AiSettingsPanel.tsx:150-155`；`TtsSettingsPanel.tsx:112-113` |
| B3-6 | TTS Web/桌面无超时；Android 全错重试 3 次 | 加超时；仅对 429/5xx/连接超时重试；合成成功后不重跑下载失败 | `knowledgePodcastService.ts:611-756`；`PodcastTtsForegroundService.java:317,371-374,386+` |
| B3-7 | `AiRoleConfig` 死配置 | 让网关读取 `timeoutMs/maxRetries/maxConcurrency`，或移除该字段 | `useAppData.ts:515-528` |
| B3-8 | 教练错误丢失诊断 | 改用 `ai-request` 上下文并保留原因 | `AdaptiveReviewPage.tsx:118-120`；`ReviewCoachWorkbench.tsx:104-105` |
| B3-9 | 工作台候选块选择被刷新重置 | 依赖只取 `candidateKey` | `ReviewCoachWorkbench.tsx:50-62` |

### 5.2 交互与布局

| ID | 问题 | 修复 | 文件 |
| -- | -- | -- | -- |
| B3-10 | 日志多选行 grid 塌陷 | 列模板以 `selecting` 判定 | `pages.css:330-339`；`JournalPage.tsx:154` |
| B3-11 | 批注工具栏遮挡/隐藏评分区 | 恢复测量偏移或加 `padding-bottom`；评分区不再整块隐藏 | `ReviewPage.tsx:1271`；`pages.css:3776-3782` |
| B3-12 | 编辑器宽度基准不一致 | 顶栏与工具栏统一内边距基准 | `visual-v2.css:283-297,965-970` |
| B3-13 | 移动端工具栏偏移 2px | 统一为同一 CSS 变量 | `visual-v2.css:776` |
| B3-14 | Ctrl+F 面板在视野外 | 面板 sticky 或打开时滚动入视 | `RecordEditorPage.tsx:239-247`；`RichTextEditor.tsx:2096-2098` |
| B3-15 | 今日页宽度不一致 | 统一容器宽度 | `visual-v2.css:190-196` |
| B3-16 | 播客页靛蓝硬编码 | `var(--accent)` → `var(--color-accent)` | `pages.css:2206-2276,2671-2672` |
| B3-17 | Android 硬件返回语义 | 沉浸式复习会话返回到复习首页 | `tabNavigation.ts:238`；`App.tsx:655-664` |
| B3-18 | 统计图表旧调色板 / `::selection` / 标签 chip 暗色 | 改用主题 token | `StatsPage.tsx:17,99,114`；`theme.css:144-150`；`styles.css:1550-1560` |
| B3-19 | 预览种子污染生产库 | 独立 Dexie 库名；已有密钥时不写入 | `stage3PreviewSeed.ts:408-411` |
| B3-20 | `?preview=voice-recall-production` 门控缺平台排除 | 补 `isNativePlatform() \|\| isDesktopPlatform()` | `App.tsx:93-95` |

### 5.3 代码清理（随批次顺手做）

- `buildBackupDescription` 死代码、`description={undefined}` 残留（`MorePage.tsx:35,130`）
- 未使用导入 `BarChart3`/`BrainCircuit`，开启 `noUnusedLocals`（`App.tsx:4-17`、`tsconfig.app.json`）
- `QuickInsertBar.tsx` 死组件 + 残留 CSS
- `deleteRecordDrafts` 死代码、`pendingClear` 脏行清理（`reviewAnnotations/repository.ts:23,29-39`）
- `voiceRecall` 死代码在 B1 接线后自然复活（`providerFactory`/`pipeline`/`mockProviders`）

---

## 6. B4 — 回归、验收与发布门禁（2 天）

| ID | 内容 | 通过标准 |
| -- | -- | -- |
| B4-1 | 全量自动化 | `npx tsc -b` / `npx vitest run` / `npm run build` 全绿 |
| B4-2 | E2E | `npx playwright test` 全绿（当前 4 红必须先修完） |
| B4-3 | Firebase Emulator | `npm run test:firebase` 全绿 |
| B4-4 | 语音真实链路验收（**需真实账号**） | Desktop + Android 各完成：ASR 准确率目测可接受、首包延迟 < 1s、打断生效、连续 5 轮无串轮/叠播 |
| B4-5 | 语音成本验收 | 单轮（1 次 ASR + 1 次 LLM + ≤8 次 TTS）用量与预估一致；异常断网不产生重复计费 |
| B4-6 | 移动端编辑器回归 | 390px 下 6/6 菜单项可点（Playwright 断言纳入 CI） |
| B4-7 | 文档同步 | `AGENTS.md` / `CHANGELOG.md` / `docs/realtime-voice-recall-implementation.md` 与实际一致；`verified` 模板标注真实验收日期 |
| B4-8 | 发布门禁复核 | 更新 `docs/voice-recall-release-checklist.md` 并逐项签字 |

---

## 7. 待你确认的决策

| ID | 决策 | 选项 | 建议 |
| -- | -- | -- | -- |
| **D1** | Web 端语音策略（真实 Provider 不支持浏览器直连） | ① 自建中继服务 ② Web 端不提供真实语音（提示“请在桌面端/Android 使用”）③ Web 端降级为系统语音朗读（`SystemSpeechTtsFallbackAdapter` 已有）+ 无 ASR | **②**：成本最低、无额外运维，且与现有“桌面/Android 为完整形态”的产品定位一致；①可作为后续 |
| **D2** | ASR 供应商 | ① 豆包流式（默认模板）② 阿里云 Paraformer | **①**：模板默认已是豆包，且与 TTS 同属火山，凭证管理更集中 |
| **D3** | 凭证管理位置 | ① 复用“更多 → AI 设置” ② 新增“语音服务”设置页 | **②**：语音需要 3 类凭证（ASR/LLM/TTS），塞进 AI 设置会让该页更混乱 |
| **D4** | 是否先做一个“诚实的中转态” | ① 直接等 B1 完成 ② 先在 UI 标注“语音服务未配置”并禁用开始 | **②**：B1 周期长，期间线上版本不应继续对用户展示假通话 |

---

## 8. 风险与应对

| 风险 | 影响 | 应对 |
| -- | -- | -- |
| 真实账号/配额不可用 | B1 无法验收，只能到 Mock 通道 | 先做 B2 + B0，B1 代码与通道分离，验收可后置 |
| ASR 协议细节（二进制分帧、鉴权头）与文档不符 | 调试周期拉长 | 先用 `providers.test.ts` 的 Mock 通道锁死状态机与 UI，再替换传输层 |
| 移动端菜单改为 Portal 后与现有 `z-index`/过渡动画冲突 | 新的布局回归 | 复用 `StructureInsertMenu` 已验证的 Portal + `position: fixed` 模式 |
| 批注 `key` 变更导致未保存草稿丢失 | 数据丢失 | 组件卸载时已有 flush（`ReviewAnnotationSurface.tsx:110-113`），切卡前先 flush 再换 key |
| B1 改动面大 | 回归风险 | 每完成一个子任务就跑 `vitest` 全量；语音相关测试不得改为“只测 Mock” |

---

## 9. 明确不做（本次范围外）

- Excalidraw 级别的批注能力（选择变换/分组/z-order/孤立修复）——见 `AGENTS.md` 已声明为未来工作。
- 云同步/备份对语音数据的支持——语音三表按设计保持纯本机。
- 音频后处理（降噪、回声消除之外的增强）、多说话人分离。
- 语音会话的跨设备迁移。
- P3 中的 IA/命名类调整（收藏夹入口、侧栏“录音”命名）——不影响功能，另行安排。

---

## 10. 验收总标准

修复完成后应满足：

1. **真实性**：语音复述的每一次转写、每一句回复、每一段播放都能对应到一次真实的 Provider 调用；无本地模板、无占位转写、无硬编码连接状态。
2. **可用性**：Android 与 Desktop 上完成一次 ≥5 轮的完整语音复述，包含打断、暂停/恢复、异常重连。
3. **成本可控**：单轮用量可计量；断网/取消/异常退出不产生重复计费；每会话有轮次与请求数上限。
4. **回归为零**：`vitest` / `playwright` / `build` 全绿；移动端编辑器全部操作可触达。
5. **文档一致**：`AGENTS.md` / `CHANGELOG.md` / 发布清单与实际能力完全一致，不再出现“已收口”而实际未接入的表述。

---

*本文件为修复计划，未执行任何代码改动。执行前建议先确认 §7 的 D1–D4。*
