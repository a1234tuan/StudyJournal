# Real-time 语音主动回忆实现基线

> 状态：阶段 0–7 完成；真实 ASR / LLM / TTS 链路已用受控账号验证，Android 真机与计费核对仍是量产门槛
> 二次审计修复：本轮采用手动录音、校对确认、句级 TTS；详细配置和 R1–R15 验收见 docs/second-audit-repair-acceptance.md。旧 live 记录不替代本轮设备与账户验收。
> 基线日期：2026-09-09
> 产品边界：第一版是实时语音主动回忆，不是视频通话，也不是独立聊天中心。

## 1. 当前已完成

### 阶段 0：隔离原型与契约

- `src/features/voiceRecall/domain.ts` 冻结主状态机：`idle -> preflight -> connecting -> listening -> finalizing-asr -> thinking -> speaking`，并支持 `paused`、`reconnecting`、`ending`、`failed`、`ended`。
- `userMuted` 与 `systemCaptureGate` 是正交状态；系统播放结束不能解除用户静音。
- 生产默认点击录音，保留长按说话；旧自动轮次会话按手动模式恢复。结束录音后必须校对确认，不根据停顿自动发送。
- `src/features/voiceRecall/contracts.ts` 提供协议无关的采集、ASR、LLM、TTS 异步事件接口。
- localhost 隔离预览地址为 `http://127.0.0.1:4177/?preview=voice-recall`。它只使用模拟状态，不请求麦克风或真实 Provider。
- 原型覆盖双视觉主题、Desktop/Android 窄屏、外发清单、静音、字幕开关、打断、错误、重连、返回/结束动作面板和安全区控制。通话页默认采用明亮声场，以连续对话字幕为主体、紧凑声纹表达运行状态，并把静音、字幕、当前轮次动作和结束固定为四键控制；深色声场保留为设备内备选。

### 阶段 1：本地运行态与音频底座

- 数据库升级到 schema 21，新增三个 local-only store：
  - `voiceRecallSessions: "id, status, updatedAt, sourceKind"`
  - `voiceRecallTurns: "id, sessionId, [sessionId+sequence], status, updatedAt"`
  - `voiceRecallLocalHistory: "id, savedAt, sourceKind"`
- `VoiceRecallRepository` 实施单轮文本、会话轮数、摘要容量、sequence 不复用、崩溃修复、来源失效和已结束会话清理约束。
- `voiceRecallSessions`/`voiceRecallTurns` 是临时检查点；完整备份恢复会清除它们。`voiceRecallLocalHistory` 是用户主动保留的本机摘要，完整恢复默认保留，但它本身不来自备份。
- 三张表均不进入 Firebase、ZIP/流式/native backup、知识导出、记录转移或 cloud mutation。
- `VoiceRecallRuntimeController` 持有进程内活动会话、采集、播放、检查点节流与三次本机写入重试；页面卸载或失去焦点只暂停，不等同结束。
- `TurnEndpointController` 仅保留为原型辅助，不接入当前生产自动发送。生产录音在 90 秒提示、120 秒结束并进入待确认转写。
- `VoicePlaybackQueue` 使用递增 generation 丢弃打断后的晚到音频；`VoiceRecallCancellationTree` 分离会话、轮次和请求取消。
- Web/Electron 使用 `WebVoiceCaptureAdapter` 输出单声道 PCM16 帧。Electron 主进程只允许应用自身 origin 请求 media 权限，并在窗口最小化时通知暂停。
- Android 使用独立 `NativeVoiceCapture`/`VoiceCaptureController`，通过 `AudioRecord` 输出 PCM16 帧；它与普通 `NativeAudioRecorder` 双向互斥。

### 阶段 2：Provider 适配与模拟主链

- `VoiceRecallPipeline` 串联 ASR -> LLM -> 句界缓冲 -> TTS，并把确认转写作为 `untrusted-learning-content` 发送，不授予工具能力。
- `OpenAiCompatibleLlmStreamAdapter` 解析 SSE token/usage；现有非流式 `aiClientService` 不变。
- `FishAudioTtsStreamAdapter` 消费 HTTP 音频分片；现有播客整段合成接口不变。
- `TransportAsrStreamAdapter` 把豆包/阿里云的鉴权、帧协议和宿主实现隔离在 `VoiceAsrTransport`，领域流水线不依赖 WebSocket/SSE。
- 提供缓冲式现有 TTS Provider 降级和系统朗读兜底。
- 提供请求超时、显式用户重试、熔断、连接测试、本机用量统计和脱敏诊断原语。
- 内置 `voice-mock-cn@1` 是已验证的确定性模板；`voice-default-cn@2` 组合阿里云 Paraformer ASR、用户配置的 LLM 与 Fish Audio TTS，三条链路已于 2026-09-09 用受控账号验证，但在真机验收前仍保持 `candidate`。豆包语音因测试应用未开通流式服务保留为备选。
- Web 默认只允许 Mock、自建中继或明确 `browserDirectSupported` 的配置。候选豆包、阿里云和 Fish Audio 模板禁止 Web 长期密钥直连。

### 阶段 3：生产工作区与本机历史

- `VoiceRecallWorkspace` 已由“复习”一级流程承载，支持资料范围和自由主题、两种手动输入模式、外发说明确认、暂停/恢复、确认转写、摘要和本机历史。
- 麦克风采集是真实 PCM；阶段 7 之前 ASR 与教师回复是本地模拟，现已替换为真实 Provider 链路（见阶段 7），转写仍必须由用户确认后才发送给模型。
- `VoiceRecallRepository.commitTurn` 在同一事务中写入确认轮次并推进 `nextSequence`，拒绝乱序或复用序号。
- 本机摘要不会自动成为正式学习事实；只有“确认创建并编辑”才通过现有日志创建入口生成记录。

### 阶段 4：上下文入口与返回身份

- 只读 `RecordEditorPage` 和当前复习卡菜单都提供“语音复述”入口，并预选当前记录。
- `VoiceRecallNavigationRoute` 只保存有界路由身份，不放入音频、转写或 Provider 对象；浏览器历史会校验 route、最多 10 条记录及文本长度。
- 从任意日志 Tab 返回时恢复原 Tab/原日志；从当前复习卡返回时保留队列、当前卡和进度。系统返回键走同一来源恢复语义。
- 进入、暂停、结束语音均不评分，不改写 FSRS，也不清除复习批注。

### 阶段 5：Coach 确认语音答案

- `AdaptiveReviewPage` 增加文本/语音分段输入；语音模式使用一次性 PCM 采集，转写可编辑，修改后会撤销确认。
- 未明确确认的转写不能提交；确认后仍调用既有 `onSubmitAnswer` / `ReviewCoachOrchestrator.submitQuizAnswer`。
- 一条 `AdaptiveQuizTurn` 仍只有一个 `answerText`。已提交轮次不可覆盖，继续追问由既有 sequence 递增的新轮次承担。
- 采集结束后必须由用户手动填写或校对转写；系统绝不用示例文本冒充识别结果。

### 阶段 6：同步、隐私与发布收口

- schema 21 增加失败事务回滚后重试覆盖；云发布/no-op、云拉取、完整恢复和过期清理均有 local-only 反向证明测试。
- Firebase Emulator 使用应用云导出结果验证远端不出现语音 session/turn/history、ASR partial、音频字段或 Provider 凭据。
- Provider 模板解析采用最新内置版本，同时保留 endpoint、模型、音色等设备本机覆盖；模板或引用不匹配时拒绝静默降级。
- OpenAI-compatible 语音 LLM 请求为不可信学习内容增加独立系统防护和 JSON 数据边界，且不提供工具定义。
- 使用教程已加入语音学习闭环、逐 Provider 外发范围、确认提交和本机留存说明。
- 发布配套文档：`voice-recall-privacy.md`、`voice-recall-provider-configuration.md`、`voice-recall-release-checklist.md`。

### 阶段 7：真实 Provider 接入（2026-09-09）

- `productionPipeline.ts` 把「模板 + 设备本机覆盖 + 凭据 + 平台」解析成真实管线；任一环节缺失或平台不支持时抛出可执行的中文提示，工作区**拒绝开始通话**，不再呈现模拟通话。
- ASR 传输层按宿主分派：桌面由主进程持有 WebSocket（`study-journal:voice-asr-open/send/close` + 事件通道，渲染层通过 `desktopVoiceSocket.ts` 适配）；Android 使用 `NativeVoiceAsrPlugin`（OkHttp WebSocket，帧以 base64 过 Capacitor 桥，`androidVoiceSocket.ts` 适配）。两者共用 `bridgeVoiceSocket.ts`。
- `aliyunAsrProtocol.ts` 实现 DashScope Paraformer 实时协议（`run-task → task-started → 音频帧 → result-generated → task-finished`），`aliyunAsrTransport.ts` 是它的 `VoiceAsrTransport` 实现；错误与超时映射为可读信息。
- `audioPlaybackSink.ts` 用 Web Audio 真实播放：`provider-native`（Fish MP3）走 `decodeAudioData`，`pcm-s16le` 直接转采样；`play()` 只在播放结束或被打断后 resolve，因此「说完」与「播完」不再靠标志位假装。
- 工作区删除 `createTeacherReply` 与伪造转写；采集帧经 `AsyncQueue` 交给真实 ASR，partial 实时上屏，`finalizing-asr` 阶段承载「转写校对」，用户确认后由 `buildVoiceTeacherMessages` 组装提示词交给真实 LLM。
- 状态真实化：波形与「正在识别」由**真实采集状态**驱动；主按钮文案与实际动作一致；连接指示改为会话状态（通话中 / 正在连接 / 已暂停 / 已断开）；披露文案显示**实际运行的模型**。
- 成本护栏：语音 LLM `max_tokens` 钳制到 320 并强制 `thinking: { type: "disabled" }`（`deepseek-v4-pro` 否则会把预算耗在推理上并返回空正文）；教练提示词限 80 字回复、6k 字符材料、最近 3 轮；TTS 每个请求 2 分钟超时。
- 采集健壮性：原生 `captureError` 被消费并中止采集，异常经 `startCapture(onError)` 上报；`startSession` 重置转写/回复草稿/历史标记；启动时修复中断会话并清理过期临时会话；删除记录时把相关语音来源标记为不可用；本机保留历史不再按数量淘汰，按 savedAt + id 稳定分页，每页 50 条。

**已验证（2026-09-09，受控账号）**

| 链路 | 结果 |
| --- | --- |
| 阿里云 Paraformer 实时 ASR | `aliyunAsrTransport.live.test.ts` 通过，247ms 完成一次真实会话 |
| DeepSeek LLM → Fish Audio TTS | `voicePipeline.live.test.ts` 通过，3.4s 收到真实音频分片 |
| TTS → ASR 往返 | Fish 生成「间隔复习为什么有效」→ ffmpeg 转 16k PCM → 阿里云识别出同一句，首个结果 601ms |
| 浏览器直连 | 实测不可行：ASR 需要自定义 `Authorization` 头（浏览器 WebSocket 不支持），Fish preflight 无 CORS 头 |

**仍未验证**：Android 真机的回声消除、蓝牙、音频焦点、来电、后台与弱网语料；桌面/真机完整 5 轮通话与取消抓包；真实账号账单核对。

## 2. 数据与隐私边界

| 数据 | 本机临时表 | 本机历史 | 云/便携备份 | 正式学习事实 |
| --- | --- | --- | --- | --- |
| 原始音频帧、ASR partial、TTS 分片 | 仅内存/短期临时文件 | 否 | 否 | 否 |
| 会话检查点、确认前转写、Provider 诊断 | 是 | 否 | 否 | 否 |
| 用户主动保存的标题与摘要 | 否 | 是 | 否 | 否 |
| Coach 已确认答案与结果 | 运行数据不作为事实 | 可有摘要 | 沿现有正式实体 | 沿现有 orchestrator |

普通 App 重启保留未完成会话，但恢复为暂停。云拉取和 no-op 同步不触碰三张 local-only 表。完整恢复清除临时会话/轮次并保留恢复前已有本机历史。卸载、清除应用数据和换机均不保证本机历史可恢复；需要跨设备保存时必须整理为正式日志。

## 3. 关键代码位置

- 状态机与接口：`src/features/voiceRecall/domain.ts`、`contracts.ts`
- 本机行类型与仓储：`localTypes.ts`、`repository.ts`
- 运行控制：`runtimeController.ts`、`cancellation.ts`、`turnEndpointController.ts`、`playbackQueue.ts`
- 音频采集：`webVoiceCapture.ts`、`nativeVoiceCapture.ts`
- Provider：`providerProfiles.ts`、`providerFactory.ts`、`openAiLlmStreamAdapter.ts`、`fishAudioTtsStreamAdapter.ts`、`transportAsrAdapter.ts`
- 真实链路解析：`productionPipeline.ts`、`credentials.ts`、`runtimePlatform.ts`
- 阿里云 ASR：`aliyunAsrProtocol.ts`、`aliyunAsrTransport.ts`
- 宿主桥接：`bridgeVoiceSocket.ts`、`desktopVoiceSocket.ts`、`androidVoiceSocket.ts`
- 播放：`audioPlaybackSink.ts`、`playbackQueue.ts`
- 提示词与队列：`teacherPrompt.ts`、`asyncQueue.ts`
- 主链：`pipeline.ts`、`sentenceBuffer.ts`
- Android：`NativeVoiceCapturePlugin.java`、`VoiceCaptureController.java`、`NativeVoiceAsrPlugin.java`
- Electron：`desktop/main.cjs`、`desktop/preload.cjs`
- 原型：`src/preview/VoiceRecallPrototypeApp.tsx`、`voiceRecallPrototype.css`

## 4. 尚未完成与禁止误报

- 阿里云 ASR 与 Fish Audio TTS 已验证单次会话；豆包流式 ASR/TTS 因测试应用未开通服务仍不可用（401 `load grant not found` / `Invalid X-Api-Key`），保留为候选。
- 语音 LLM 与 TTS 的并发、取消、长会话稳定性与真实账单仍未核对。
- Android 尚未完成真实设备的回声消除、蓝牙、音频焦点、来电、后台、弱网和噪声语料验收。
- 通话界面的生产视觉回归需要桌面/真机验收（Web 端不提供真实语音链路，因此 Playwright 只覆盖“未配置时拒绝启动”）。
- 当前只有用户确认后的 Coach 转写会写入既有 `AdaptiveQuizTurn.answerText`；语音本身不改变 FSRS，不自动创建日志，也不保存完整原始通话录音。

## 5. 后续实施边界

阶段 7 完成的是真实链路接入与受控账号验证，不等同于量产放行。Android 真机检查、完整通话抓包与真实账单核对仍按发布清单逐项验收；`voice-default-cn@2` 在真机验收前保持 `candidate`。

## 6. 回归命令

2026-09-09 真实链路接入时的历史基线（不是二次审计后的计数）：Vitest `140` 个文件 / `889` 项测试（其中 2 项为需密钥的线上验收，未提供时跳过），Playwright `44/44`，Firebase Emulator `4/4`，生产构建、Electron 语法检查、Android Java 编译与 `git diff --check` 均通过。

```powershell
npm run test
npm run test:e2e
npm run test:firebase
npm run build
node --check desktop/main.cjs
node --check desktop/preload.cjs
cd android
.\gradlew.bat :app:compileDebugJavaWithJavac
cd ..
git diff --check
```

真实 Provider 验收必须使用专门测试账号、短会话和低额保护。不得把 API Key、音频正文、完整 Prompt 或 Provider 原始响应写入源码、测试夹具、日志、截图、备份或云同步。
