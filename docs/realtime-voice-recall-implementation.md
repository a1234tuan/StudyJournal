# Real-time 语音主动回忆实现基线

> 状态：阶段 0–6 代码与自动化收口完成；真实 Provider 与 Android 真机仍是量产门槛
> 基线日期：2026-09-08
> 产品边界：第一版是实时语音主动回忆，不是视频通话，也不是独立聊天中心。

## 1. 当前已完成

### 阶段 0：隔离原型与契约

- `src/features/voiceRecall/domain.ts` 冻结主状态机：`idle -> preflight -> connecting -> listening -> finalizing-asr -> thinking -> speaking`，并支持 `paused`、`reconnecting`、`ending`、`failed`、`ended`。
- `userMuted` 与 `systemCaptureGate` 是正交状态；系统播放结束不能解除用户静音。
- 自动轮次、长按说话、点击录音是互斥输入模式，只能在通话前或暂停时切换。
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
- `TurnEndpointController` 集中管理 1.8 秒普通停顿、4 秒未完句延长和 45 秒长轮次提示，不把参数散落到组件。
- `VoicePlaybackQueue` 使用递增 generation 丢弃打断后的晚到音频；`VoiceRecallCancellationTree` 分离会话、轮次和请求取消。
- Web/Electron 使用 `WebVoiceCaptureAdapter` 输出单声道 PCM16 帧。Electron 主进程只允许应用自身 origin 请求 media 权限，并在窗口最小化时通知暂停。
- Android 使用独立 `NativeVoiceCapture`/`VoiceCaptureController`，通过 `AudioRecord` 输出 PCM16 帧；它与普通 `NativeAudioRecorder` 双向互斥。

### 阶段 2：Provider 适配与模拟主链

- `VoiceRecallPipeline` 串联 ASR -> LLM -> 句界缓冲 -> TTS，并把确认转写作为 `untrusted-learning-content` 发送，不授予工具能力。
- `OpenAiCompatibleLlmStreamAdapter` 解析 SSE token/usage；现有非流式 `aiClientService` 不变。
- `FishAudioTtsStreamAdapter` 消费 HTTP 音频分片；现有播客整段合成接口不变。
- `TransportAsrStreamAdapter` 把豆包/阿里云的鉴权、帧协议和宿主实现隔离在 `VoiceAsrTransport`，领域流水线不依赖 WebSocket/SSE。
- 提供缓冲式现有 TTS Provider 降级和系统朗读兜底。
- 提供请求超时、输出前有限重试、熔断、连接测试、本机用量统计和脱敏诊断原语。
- 内置 `voice-mock-cn@1` 是已验证的确定性模板；`voice-default-cn@1` 仍是 `candidate`。豆包 ASR、DeepSeek 候选模型和 Fish Audio 候选音色未经过当前账号与真机验收，不能标记为默认量产链路。
- Web 默认只允许 Mock、自建中继或明确 `browserDirectSupported` 的配置。候选豆包、阿里云和 Fish Audio 模板禁止 Web 长期密钥直连。

### 阶段 3：生产工作区与本机历史

- `VoiceRecallWorkspace` 已由“复习”一级流程承载，支持资料范围和自由主题、三种互斥输入模式、外发说明确认、暂停/恢复、确认转写、摘要和本机历史。
- 麦克风采集是真实 PCM；真实 Provider 未验收期间，ASR 与教师回复必须显式标为 Mock，用户可编辑且必须确认转写。
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
- 真实 ASR 未验收时不会用示例文本冒充识别结果；采集结束明确要求用户手动填写或校对。

### 阶段 6：同步、隐私与发布收口

- schema 21 增加失败事务回滚后重试覆盖；云发布/no-op、云拉取、完整恢复和过期清理均有 local-only 反向证明测试。
- Firebase Emulator 使用应用云导出结果验证远端不出现语音 session/turn/history、ASR partial、音频字段或 Provider 凭据。
- Provider 模板解析采用最新内置版本，同时保留 endpoint、模型、音色等设备本机覆盖；模板或引用不匹配时拒绝静默降级。
- OpenAI-compatible 语音 LLM 请求为不可信学习内容增加独立系统防护和 JSON 数据边界，且不提供工具定义。
- 使用教程已加入语音学习闭环、逐 Provider 外发范围、确认提交和本机留存说明。
- 发布配套文档：`voice-recall-privacy.md`、`voice-recall-provider-configuration.md`、`voice-recall-release-checklist.md`。

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
- 主链：`pipeline.ts`、`sentenceBuffer.ts`
- Android：`NativeVoiceCapturePlugin.java`、`VoiceCaptureController.java`
- Electron：`desktop/main.cjs`、`desktop/preload.cjs`
- 原型：`src/preview/VoiceRecallPrototypeApp.tsx`、`voiceRecallPrototype.css`

## 4. 尚未完成与禁止误报

- 豆包/阿里云 ASR 的真实鉴权、二进制/JSON 帧协议、重连和取消尚未用专门测试账号验证。
- DeepSeek 候选模型的流式输出、结构化评估和长会话稳定性尚未实测。
- Fish Audio 候选模型/音色的首包、分片、并发、取消和计费尚未实测。
- Android 尚未完成真实设备的回声消除、蓝牙、音频焦点、来电、后台、弱网和噪声语料验收。
- 当前只有用户确认后的 Coach 转写会写入既有 `AdaptiveQuizTurn.answerText`；语音本身不改变 FSRS，不自动创建日志，也不保存完整原始通话录音。

## 5. 后续实施边界

阶段 6 自动化收口不等同于真实链路放行。受控 Provider 账号与 Android 真机检查仍按发布清单逐项验收；任何候选配置都不能在验证前标为默认可用。2026-09-08 已完成 localhost 隔离通话原型的视觉重构与双视口自动化验收；这项视觉基线不改变生产工作区、Provider 验证状态或真机放行条件。

## 6. 回归命令

2026-09-08 阶段 0–6 收口回归结果：Vitest `125/125` 个文件、`837/837` 项测试，Desktop/Android-narrow Playwright `38/38`，Firebase Emulator `4/4`，生产构建、Electron 语法检查、Android Java 编译和 `git diff --check` 均通过。Stage 4 的当前卡片入口/返回及 Stage 5 的 Coach 转写确认均包含跨视口 E2E。

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
