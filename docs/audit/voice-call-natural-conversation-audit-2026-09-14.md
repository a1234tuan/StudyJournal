# 语音通话自然对话重构 · 独立审查报告

- 审查日期：2026-09-14
- 审查性质：只审查，不修改。未改动任何代码、测试、配置或文档。
- 需求来源：`docs/voice-call-natural-conversation-freeze-2026-09-14.md`（下称"冻结方案"）
- 事实来源：当前代码库实际内容 + 实际命令运行输出。**未采信冻结方案的"阶段记录/阶段验收记录"，也未采信任何先前会话记忆。**
- 审查对象目录：`D:\StudyJournal-Source`（分支 `main`，HEAD `829f98d`）

---

## 0. 关键前提修正（重要，先读）

审查开始时发现会话声明的 workspace（`C:\Users\Administrator\WorkBuddy\Worktrees\StudyJournal-Source\main-3dbdbb0a`）**不是**本次重构的实现载体：

| 位置 | 分支 | HEAD | 状态 | 是否含本次重构 |
| --- | --- | --- | --- | --- |
| `C:\...\main-3dbdbb0a`（会话 workspace） | `workbuddy/main-3dbdbb0a` | `829f98d` | 工作区干净 | **否**。搜索"你正在和用户进行一通语音电话""playedText""systemGenerated"均无命中，仍是旧的"语音学习复述教练 + `<voice_control>` 教学协议"版本 |
| `D:\StudyJournal-Source`（主仓库工作树） | `main` | `829f98d` | **27 文件已修改 + 7 项未追踪** | **是**。`git diff --stat` 显示 27 文件、+539/−244 |

结论：本次重构的**全部实现以未提交的改动形式存在于 `D:\StudyJournal-Source`**；会话 workspace 只是同 commit 的干净检出。本报告全部证据取自 `D:\StudyJournal-Source`（下称"仓库"）。这一点本身即为 F31 的发现。

另：`docs/voice-call-natural-conversation-freeze-2026-09-14.md` 只存在于 `D:\StudyJournal-Source`，在会话 workspace 与 git 历史（`git log --all`）中均不存在（属未追踪文件）。

---

## 1. 总体结论（五阶段真实完成度）

| 阶段 | 完成度 | 一句话结论 |
| --- | --- | --- |
| 阶段一 基线审计与 Prompt 冻结 | **约 65%** | 结构（指令块→示例→context→历史→当前输入）、示例、材料/自由主题模板、空主题省略均已实现；但**系统提示词文本与冻结版存在 3 处实质性不一致**，且被测试反向固化，旧协议指令仍混入系统提示。 |
| 阶段二 自然对话协议与首轮交互 | **约 80%** | 开场 LLM 请求与固定答题 fallback 已移除，接通播本地提示、用户先说已实现并有测试；但 stop 仍走旧 `createVoiceTeacherFallback`，教学完成 UI/旧 `nextAction` 指令残留。 |
| 阶段三 半双工、按钮打断与 ASR 恢复 | **约 80%** | 状态流、播放期麦克风门控、四步按钮打断、单轮重试+成功归零、代际隔离均已实现；ASR 错误分类不完整，重试逻辑无自动化测试。真机打断未验证。 |
| 阶段四 播放一致性、字幕持久化与恢复 | **约 85%** | 保存先于播放、`playedText/pendingText/playbackStatus` 落地、"继续"直接放 pending、同会话恢复、新会话隔离均已实现；10 轮窗口测试被削弱，多条路径缺测试。 |
| 阶段五 预算、兼容性与观测 | **约 70%** | 224/250 token 预算、thinking 默认不发送、reasoning 不入 TTS 均已实现并测试；观测缺首 token/首音延迟与 ASR 时长，字段定义了但从不写入。 |

整体：**功能主干可达、可编译、全量测试通过**；主要问题在"**与冻结文本的逐字一致性**"和"**旧协议死代码/半成品残留**"，以及**全部实现尚未提交**。

---

## 2. 逐项核对表（A1–F32）

状态图例：✅已实现 / ⚠️部分实现 / ❌未实现 / 🔀偏离设计 / ❓无法静态验证。风险等级：阻断 / 高 / 中 / 低。

### A. Prompt 层

| 项 | 状态 | 证据 | 风险 |
| --- | --- | --- | --- |
| **A1** 系统提示词逐字比对 | 🔀 偏离设计 | `src/features/voiceRecall/teacherPrompt.ts:10-16`。与冻结文本逐句对照，发现 3 处不一致：<br>① L13 缺结尾"，不要机械朗读排版符号。"（冻结版有此句）<br>② L14 缺"，但不要为了维持某种固定流程而提问。"（冻结版有此句）<br>③ L15 为"只有关键信息可能影响回答时才确认"，冻结版为"只有数字、名称或其他关键信息可能影响回答时，才向对方确认。"<br>另：L12 用 ASCII"-"（`1-3 句话`）而冻结版用"–"（`1–3 句话`）。<br>**偏离被测试固化**：`teacherPrompt.test.ts:11-12` 断言的正是缩短后的字符串（`"尽量控制在 50 字以内"`、`"只有关键信息可能影响回答时才确认"`）。 | 中 |
| **A2** 示例存在且位置正确 | ✅ 已实现 | `teacherPrompt.ts:18-24` 定义 `EXAMPLE_DIALOGUE`（傅里叶变换两轮）；在 `teacherPrompt.ts:82` 作为系统消息内容数组第 2 项拼接，位于 `SYSTEM_PROMPT` 之后、变量内容之前。 | 低 |
| **A3** 拼接顺序 指令块→示例→context→历史→当前输入 | ✅ 已实现 | `teacherPrompt.ts:78-117`：`messages[0]`=system（`SYSTEM_PROMPT` + `EXAMPLE_DIALOGUE` + 主题/背景/目标/boundary+userControl，见 80-88）；材料作为 `untrusted-learning-content` 的 user 消息（92-98）；随后历史 turns（100-112）；最后当前 `confirmedText`（114-116）。 | 低 |
| **A4** 材料模式模板 + 截断及标记 | ✅ 已实现（措辞略异） | `teacherPrompt.ts:84`：`"背景：日志是对话素材，不是必须逐条讲解的任务清单。"`（冻结版为"日志是对话素材，不是任务清单"，语义一致）。截断：`teacherPrompt.ts:69-77`（`slice` 到 `VOICE_TEACHER_MAX_RECORD_CHARACTERS`/`maxMaterial`）；截断标记 `teacherPrompt.ts:95` `【日志内容（已截断）】`。测试：`teacherPrompt.test.ts:16-24`（"marks learning material as untrusted and bounds the injected text"，断言长度 ≤ 上限）。 | 低 |
| **A5** 自由主题模板 + 空主题完全省略 | ✅ 已实现 | `teacherPrompt.ts:83`：`input.topic?.trim() ? \`当前通话主题：${...}。主题只是对话的起点；用户聊到别处时跟随用户。\` : ""` —— 空主题返回空串，整块省略，不产生半截句子。测试：`teacherPrompt.test.ts:43-51`（断言 `"当前通话主题：事件循环"`）。**无空主题省略的专项测试**。 | 低 |
| **A6** 全局搜索旧协议残留 | 🔀 偏离设计 / ⚠️ 部分仍在活动链路 | 残留位置与死活判定：<br>• `teacherProtocol.ts` 整文件（`assessment/nextAction/next-topic/follow-up/topicPlan`、`VoiceTeacherStreamParser`、`formatVoiceTeacherControlledReply`）——**编译保留**。<br>• `pipeline.ts:13-17,168-205`：`VoiceTeacherStreamParser` 仅在传入 `policy` 时启用。`productionPipeline.ts:202` 构造 `new VoiceRecallPipeline(asr, llm, tts)` **不传 policy** → 该分支在生产链路**死代码**。<br>• `dialoguePolicy.ts:124-145` `createVoiceTeacherFallback`（含"开场必须提第一问"）——**opening 分支死**；但 `VoiceRecallWorkspace.tsx:643` 在 stop 时**仍调用**（活动）。<br>• `dialoguePolicy.ts:94-116` `validateVoiceTeacherDecision`——仅 `dialoguePolicy.test.ts` 引用（**死**）。<br>• `teacherPrompt.ts:26-33` `userControlInstruction` 在 stop/skip/switch 时仍输出"**nextAction 必须为 finish**"等旧协议指令（**活动**，会进入系统提示）。<br>• `mockProviders.ts:12,40,60-81` 的 `<voice_control>` 受控分支——新流程提示词不含 `<voice_control>`，故 **mock 走自然分支（死）**，但代码保留。 | 中 |

### B. 对话协议

| 项 | 状态 | 证据 | 风险 |
| --- | --- | --- | --- |
| **B7** 接通播本地"已接通"，不调 LLM | ✅ 已实现（系统语音，非缓存音频） | `VoiceRecallWorkspace.tsx:90` `LOCAL_GREETING_TEXT = "已接通，你可以直接说。"`；`92-99` `playLocalGreeting()` 用 `window.speechSynthesis`；`377` 在 `CONNECTED` 后调用。`startSession`(327-384) 全程**无任何 LLM 调用**。注意：这是"系统语音合成"，非冻结方案 B11 措辞所指的"本地预合成音频"。 | 低 |
| **B8** 首轮确实等用户先说 | ✅ 已实现（有测试） | `startSession` 仅播提示并置 listening，无 LLM。测试 `VoiceRecallWorkspace.test.tsx:83` "starts automatic capture after the user-first connection"，且 `:259` `expect(respond).not.toHaveBeenCalled()`（连接后未调用 LLM）；`:267` 显式 `end` 后同样 `expect(respond).not.toHaveBeenCalled()`。 | 低 |
| **B9** 内容错误/LLM 失败/ASR 失败/播放异常 文案区分 | ⚠️ 部分实现 | ASR：`VoiceRecallWorkspace.tsx:511`"本轮没有检测到语音，正在重新监听…"；`:567`"本轮没有收到清晰转写，正在重新监听…"；`:536`"语音识别响应超时…"。LLM/播放：`diagnostics.ts:35-39` `VoiceStageError` → "AI 回复没有完成…"/"音频播放没有完成…"（`describeVoiceError` 于 `productionPipeline.ts:48-49` 分派）。**"内容错误"专项 fallback 已随协议删除而消失**（旧 `validateDecision` fallback 分支在生产不可达）。均为自然语言，**无固定考题**。 | 中 |
| **B10** system fallback 标记 systemGenerated 且排除出 LLM 上下文 | ❌ 未实现（标记侧） | 字段定义 `localTypes.ts:73`、类型 `teacherPrompt.ts:47`、消费 `teacherPrompt.ts:101`（`if (turn.systemGenerated) continue;`）——**排除逻辑存在**。但全仓 `grep systemGenerated` 仅命中上述 3 处定义/消费，**无任何位置写入 `systemGenerated: true`**。即：排除机制是死的，本地兜底文案从未被标记。 | 中 |
| **B11** 固定文案用本地预合成音频而非每次 TTS | ⚠️ 部分实现 | 接通提示用 `window.speechSynthesis`（`VoiceRecallWorkspace.tsx:92-99`），每次实时合成，**非预合成音频资源**；但确实**不调用云端 TTS**。另有 `SystemSpeechTtsFallbackAdapter`（`ttsFallbackAdapters.ts:31-47`）与 `providerFactory.ts:42,46` 的 `systemFallback` 开关，但**无任何生产调用方开启它**（见 F29）。 | 低 |

### C. 状态机与 ASR

| 项 | 状态 | 证据 | 风险 |
| --- | --- | --- | --- |
| **C12** 状态流转 connecting→listening→transcribing→thinking→speaking→listening | ✅ 已实现（命名差异） | `domain.ts:5-17` 定义；`domain.ts:94-214` 迁移表：`CONNECT→connecting`(111-113)、`CONNECTED→listening`(114-122)、`SUBMIT_CAPTURE→finalizing-asr`(132-134)、`ASR_FINALIZED→thinking`(135-137)、`LLM_REPLIED→speaking`(141-149)、`PLAYBACK_FINISHED→listening`(150-157)。**实现用 `finalizing-asr`，冻结方案写 `transcribing`**（命名不一致，非功能缺失）。 | 低 |
| **C13** 播放期间麦克风关闭（半双工） | ✅ 已实现 | `domain.ts:141-149` `LLM_REPLIED` 置 `systemCaptureGate: true`；`domain.ts:91-92` `isVoiceCaptureActive = captureRequested && !userMuted && !systemCaptureGate`；`PLAYBACK_FINISHED`/`INTERRUPT_AND_LISTEN` 清门。 | 低 |
| **C14** 按钮打断四动作 | ✅ 已实现 | `VoiceRecallWorkspace.tsx:1058-1066`（status==="speaking" 时）：① `markPlaybackInterrupted()`（`:1018-1049`，写 `playbackStatus:"interrupted"`）② `runtime.interruptPlayback()`（`runtimeController.ts:207-209`，停止并清空播放队列）③ 标记中断即 ① ④ `runtime.dispatch({type:"INTERRUPT_AND_LISTEN"})`（`domain.ts:158-166`，回到 listening 并 `captureRequested`）。 | 低 |
| **C15** ASR 错误分类 ≥5 类 | ⚠️ 部分实现 | 已区分：**无语音**（`VoiceRecallWorkspace.tsx:507-517`，`detector.hasSpeech` 判定）、**空转写/无清晰转写**（`:559-573`）、**超时**（`:533-538` 35s 竞速）。**断连、麦克风错误无专属分类**：仅落回 `VoiceProviderError` 通用码 `providerRuntime.ts:34`（`unsupported/unauthorized/rate-limited/timeout/network/invalid-response/circuit-open`），无 `no-speech/disconnect/microphone` 等类型化枚举。 | 中 |
| **C16** 每轮最多重试一次 + 成功后归零 | ✅ 已实现（无自动化测试） | 单轮上限：`:508`/`:563` `asrRetryRef.current < 1` 才重试；成功归零：`:549` `asrRetryRef.current = 0`（在拿到 `result.transcript` 后）。**测试缺口**：`VoiceRecallWorkspace.test.tsx`、`auditRegression.test.tsx` 均未覆盖自动重试与归零。 | 中 |
| **C17** turnId/operationId/epoch 代际隔离 | ✅ 已实现（有部分测试） | `runtimeController.ts:33,37,40` `operationEpoch`/`operationGeneration`/`isCurrentOperation`；`:42-46` `cancelActiveTurn` 自增 epoch + 取消树；`:11` `VoiceRecallCancellationTree`；事件回调均带 `isCurrentOperation` 守卫（如 `VoiceRecallWorkspace.tsx:439,548,560`）。测试：`domain.test.ts:50-58`（"invalidates a late playback generation when interrupted"）、`runtimePrimitives.test.ts:45-60`（取消与丢弃晚到音频）。 | 低 |

### D. 持久化与上下文

| 项 | 状态 | 证据 | 风险 |
| --- | --- | --- | --- |
| **D18** 每轮原子保存 用户文本+完整 AI 文本，且保存先于播放 | ✅ 已实现 | `repository.ts:87-123` `commitTurn` 在单个 `rw` 事务内写 `voiceRecallTurns`（含 `confirmedText` + `teacherText`/`assistantText`）与 `voiceRecallSessions`。调用时序：`VoiceRecallWorkspace.tsx:722` `commitTurn` → `:726-727` `enqueueAudio`+`waitForPlayback`，**保存确实先于播放**。 | 低 |
| **D19** playedText/pendingText/playbackStatus 存在且被写入 | ✅ 已实现 | 字段：`localTypes.ts:70-73`。写入：commit（`VoiceRecallWorkspace.tsx:711-713`）、播放完成（`:732-734`）、pending 继续完成（`:844-849`）、打断（`:1021-1026`）、失败（`:770-773`）。测试：`repository.test.ts` 新增 "updates playback metadata without deleting the confirmed transcript"。 | 低 |
| **D20** 下一轮上下文用实际播放内容（或标记未播完） | ✅ 已实现（更强，另有死分支） | `VoiceRecallWorkspace.tsx:671` 只把 `playbackStatus === "completed"` 的 turns 传入；`teacherPrompt.ts:105` 优先 `turn.playedText ?? turn.assistantText ?? turn.teacherText`；`:107-109` 对 pending/interrupted/failed/truncated 会追加"（上一条回复还有内容未播放）"——**但因上游已过滤 completed，该分支在生产不可达**（死分支）。 | 低 |
| **D21** "继续"直接播放 pending 不重调 LLM | ✅ 已实现（无测试） | `VoiceRecallWorkspace.tsx:819-859` `continuePendingPlayback`：取 `pendingText` → `runtime.speakText`（TTS only，无 `respond`）→ 更新 turn。UI：`VoiceRecallPresentation.tsx:356` 渲染"继续回复"按钮，`VoiceRecallWorkspace.tsx:1204-1205` 绑定。**无自动化测试**。 | 中 |
| **D22** LLM 上下文限最近 10 个已完成 turns | ✅ 已实现（测试被削弱） | `teacherPrompt.ts:7` `VOICE_TEACHER_HISTORY_TURNS = 10`；`:100` `.slice(-VOICE_TEACHER_HISTORY_TURNS)`；上游仅传 completed（`VoiceRecallWorkspace.tsx:671`）。**测试缺口**：`teacherPrompt.test.ts:26-36` 用 6 轮数据，原断言"不含回答 2"（窗口=3 时成立）已被改为"含回答 2"——**改为 10 后该测试不再检验窗口边界**（6<10，全部纳入）。 | 中 |
| **D23** 同 session 恢复完整 turns / 新 session 不继承 | ✅ 已实现 / ⚠️ 测试不全 | 恢复：`runtimeController.ts:102-119` `restoreSession`（以 paused 载入 checkpoint）+ `VoiceRecallWorkspace.tsx:289-324` 恢复 effect；测试 `runtimeController.test.ts:139`（"restores an ended session with its checkpoint…"）。新会话不继承：`VoiceRecallWorkspace.tsx:334-339` 显式清空 `transcript/teacherDraft/memory/historySaved`。**新会话清空无专项测试**。 | 中 |
| **D24** LLM 失败保留用户字幕 / TTS 失败保留 AI 字幕 | ✅ 已实现（有测试） | 用户字幕：`VoiceRecallWorkspace.tsx:805-806` `setTranscript(confirmedText)`+ 打开转写编辑。AI 字幕：失败 turn 保留 `assistantText`/`pendingText`（`:770-772`）。测试：`auditRegression.test.tsx` "keeps observed consumption when a provider fails"（现断言失败 turn 落库、`confirmedText:"测试失败计量"`）。 | 低 |

### E. 预算与观测

| 项 | 状态 | 证据 | 风险 |
| --- | --- | --- | --- |
| **E25** max_tokens 默认 224、上限 250，层级生效 | ✅ 已实现（有测试） | 定义/收敛：`productionPipeline.ts:31-37`（`VOICE_LLM_MAX_TOKENS=250`、`VOICE_LLM_DEFAULT_MAX_TOKENS=224`、`clampVoiceLlmMaxTokens`）；应用：`:143` 构造 provider 时 `maxTokens: clampVoiceLlmMaxTokens(...)`；发送：`openAiLlmStreamAdapter.ts:50` `max_tokens: this.profile.maxTokens`；Android 宿主同链路 `androidLlmStream.ts:33`。测试：`productionPipeline.test.ts` 新增 "clamps voice output to the bounded default and global ceiling"（含 4096→224、512→224、250→250）。 | 低 |
| **E26** thinking 默认不发送、仅声明支持的 provider；reasoning 不进 TTS | ✅ 已实现 | `openAiLlmStreamAdapter.ts:53` 仅当 `profile.voiceThinkingMode === "enabled"` 才附带 `thinking`；字段默认 `undefined`（`src/types.ts:348`，本次新增）；`openAiLlmStreamAdapter.ts:72-74` **只读取 `delta.content`，从不读取 `reasoning_content`** → reasoning 自然不进 TTS。测试：`openAiLlmStreamAdapter.test.ts:33`（undefined/"disabled" 均不发送）。**无自动 provider 能力探测**：靠人工字段声明。 | 低 |
| **E27** 观测埋点逐项 | ⚠️ 部分实现 | 已记录：token（`VoiceRecallWorkspace.tsx:741-742`）、LLM 时长（`:743` `llmDurationMs`）、回复长度（`:744-745`）、问句结尾（`:746`）、打断（`:747,1036`）、ASR 重试（`:748,1039`）、错误码、播放状态（`:749,1041,794`）。**缺失**：`diagnostics.ts:16-20` 定义了 `asrDurationMs/firstTokenDelayMs/firstAudioDelayMs/playbackDurationMs`，但三处 `recordVoiceTurnObservation` 调用（`:739,783,1029`）**均未传入**，字段永为 undefined。阶段时间戳由 `recordVoiceStage`（`diagnostics.ts:5-8`）记录，但仅在"通话详情"面板以原始事件展示（`VoiceRecallWorkspace.tsx:1207`），**未换算为首音/首 token 延迟指标**。 | 中 |

### F. 中断残留检查

| 项 | 状态 | 证据 | 风险 |
| --- | --- | --- | --- |
| **F28** TODO/FIXME/HACK 及未完成注释 | ✅ 未发现 | `grep -rn "TODO|FIXME|HACK|XXX|待实现|未实现"` 在 `src/features/voiceRecall` **无命中**。 | 低 |
| **F29** 定义但从未被调用的新函数/字段 | ⚠️ 部分存在 | 半成品/死代码清单：`systemGenerated`（定义+消费，从不写入）；`validateVoiceTeacherDecision`（仅测试引用）；`VoiceTeacherStreamParser`+`formatVoiceTeacherControlledReply`（生产不传 policy，不可达）；`SystemSpeechTtsFallbackAdapter`/`providerFactory.systemFallback`（无生产调用方开启）；`createVoiceTeacherFallback` 的 opening 分支、`applyVoiceTeacherDecision` 的 respond/follow-up/next-topic 分支；`teacherPrompt` 中旧 `nextAction` 指令文本。 | 中 |
| **F30** 引用已删除 API 的测试 / 被跳过的测试 | ✅ 符合预期 | 跳过项仅 2 个，且均为 opt-in 实时测试：`aliyunAsrTransport.live.test.ts`、`voicePipeline.live.test.ts`（`describe.skip` 由缺 key 触发）。另有 e2e `ui-v2-stage4-review.spec.ts:10` 的桌面专用 skip（非本次范围）。无测试引用已删除 API —— 相关断言已同步更新（见 `git diff` 中 teacherPrompt/dialoguePolicy/auditRegression/e2e 断言迁移）。 | 低 |
| **F31** git 工作区是否干净 | ❌ 不干净 | `D:\StudyJournal-Source`：`git status --short` 显示 **27 个已修改文件 + 7 项未追踪**，全部实现**未提交**。未追踪含 `docs/voice-call-natural-conversation-freeze-2026-09-14.md`、`src/features/voiceRecall/openAiLlmStreamAdapter.test.ts`、`.workbuddy/`、`docs/audit/`、`output/`、`img/`、`docs/knowledge-base-evolution-blueprint.md`。会话 workspace `main-3dbdbb0a` 停在旧 `829f98d`。`git diff --check` 干净。 | **高** |
| **F32** 范围外项目是否混入半成品 | ✅ 未发现混入 | 语音 barge-in：无（播放期麦克风关闭）；AEC：未实现（仅采集约束 `echoCancellation:true`，`VoiceRecallWorkspace.tsx:434`，非 AEC 算法）；滚动摘要：无；数据库重命名：无 —— `teacherText` 字段保留（`localTypes.ts:68`），`newProviderName` 类重命名无；普通对话开关、SiliconFlow 实时 ASR 未见半成品。 | 低 |

---

## 3. 命令输出摘要（真实运行）

### 3.1 完整测试套件（`npm test` → `vitest run`）

```
 Test Files  163 passed | 2 skipped (165)
      Tests  1021 passed | 2 skipped (1023)
   Duration  61.45s
```

- 通过：163 个测试文件 / 1021 个测试。
- **跳过（2）**：`src/features/voiceRecall/aliyunAsrTransport.live.test.ts`（1）、`src/features/voiceRecall/voicePipeline.live.test.ts`（1）——均为需真实 key 的 opt-in 实时测试（`describe.skip`），属预期排除。
- 失败：**0**。
- 与本次改动直接相关且通过的测试（节选）：`teacherPrompt.test.ts`(6)、`productionPipeline.test.ts`、`openAiLlmStreamAdapter.test.ts`(3)、`repository.test.ts`、`runtimeController.test.ts`、`dialoguePolicy.test.ts`、`VoiceRecallWorkspace.test.tsx`、`VoiceRecallPresentation.test.tsx`、`auditRegression.test.tsx`。

### 3.2 `npm run build`

- 结果：**失败（SAFE_DELETE_BULK_CONFIRM_REQUIRED）**，但**失败原因与代码无关**：
  ```
  [safe-delete][SAFE_DELETE_BULK_CONFIRM_REQUIRED] {"count":137,"threshold":50,
    "scope":"turn","targets":["D:\\StudyJournal-Source\\dist\\assets"],"targetCount":1}
  ```
  即 Vite `emptyDir(dist)` 时被本机 safe-delete 保护拦截（137 文件 > 阈值 50）。日志同时显示 `tsc -b` 已通过、`✓ 4904 modules transformed`。
- 为排除代码因素，分两步验证：
  - `npx tsc -b` → **exit 0**（TypeScript 类型检查通过）。
  - `npx vite build --outDir dist-verify-review` → **exit 0**，`✓ built in 29.74s`，PWA 预缓存 109 项。
- 结论：**构建在代码层面是干净的**；`npm run build` 的失败是审查环境的删除保护所致，非代码缺陷。
- 备注：为验证打包我生成了 `dist-verify-review/`（临时目录），因本机 safe-delete 拒绝对其回收而**未能删除**，残留于仓库根目录。它是审查产生的可丢弃构建产物，**建议在修复任务中一并清理**。

### 3.3 `git diff --check` 与 `git status`

- `git diff --check` → **无输出，exit 0**（无空白/冲突标记问题）。
- `git status --short` → 27 modified + 7 untracked（详见 F31）。**未提交即为本次审查最需要关注的流程风险。**

---

## 4. "需人工验证"清单（无法静态验证，禁止推定为已完成）

1. **Android 真机按钮打断**（阶段三最终门禁）：`handleMainClick` 在 `speaking` 态是否真机可用、打断后麦克风恢复是否可靠。
2. **自动半双工多轮真机**：端点检测 `VoiceActivityEndpoint`、`preRoll`、120s 上限在真机的行为。
3. **真实 provider 表现**：Aliyun ASR / 配置的 LLM / Fish Audio TTS 的端到端流式、超时、断连、空转写真实表现（对应 live 测试当前被跳过）。
4. **`window.speechSynthesis` 可用性**：目标 Android WebView / 桌面端是否有系统语音；不可用时"仅字幕"降级是否如方案所述。
5. **首 token / 首音延迟、ASR 时长**：观测字段未写入，故只能真机实测，不能由代码推断。
6. **Provider thinking 兼容性**：`voiceThinkingMode="enabled"` 对各真实模型的行为（reasoning 是否混入 `content`）需实测。
7. **Doubao 系列 provider**：仍为 candidate，未见真实账号验证。
8. **Playwright e2e**：`e2e/voice-recall-policy.spec.ts` 已按自然对话改写，但本次未运行 Playwright（需单独执行）。
9. **Pending 继续 / 新会话不继承 / ASR 自动重试**：逻辑存在但**无自动化测试**，行为需人工/补测确认。

---

## 5. 建议的修复优先级（仅排序，不动手）

> 说明：无"阻断级"代码缺陷（编译、类型、全量测试均通过）。以下按风险从高到低排序。

1. **[高] F31 提交并打检查点**：将 27 个修改 + 新测试提交，明确评审基线；同时确认会话 workspace 与主仓库指向一致（避免"审查的是旧代码"）。
2. **[中高] A1 系统提示词逐字对齐冻结文本**：补齐 3 处缺失/简化子句，并同步修正 `teacherPrompt.test.ts` 中被反向固化的断言；顺带清理 A6 中会进入系统提示的旧 `nextAction` 指令（`teacherPrompt.ts:26-33`）。
3. **[中] A6 / F29 清理旧协议死代码**：`teacherProtocol.ts`、`pipeline.ts` 的 parser 分支、`dialoguePolicy.ts` 的 `validateVoiceTeacherDecision` 与 opening 分支、`mockProviders.ts` 受控分支、`providerFactory.systemFallback`/`SystemSpeechTtsFallbackAdapter`。防止后续误读与"看似支持实不生效"。
4. **[中] B10 落实或移除 `systemGenerated`**：若保留本地兜底文案，则真正写入该标记；否则删除字段与消费分支。
5. **[中] C15 补齐 ASR 错误分类**：为"断连""麦克风错误"增加类型化判定与专属文案。
6. **[中] E27 补齐或移除观测字段**：实现 `firstTokenDelayMs/firstAudioDelayMs/asrDurationMs` 的落数，或从接口移除以免误导。
7. **[中] 测试补强**：恢复 D22 的 10 轮窗口边界断言；新增 C16 自动重试与归零、D21 pending 继续、D23 新会话不继承的测试。
8. **[低中] B9/B11 文案与本地音频策略统一**：明确"内容错误"是否还需兜底；统一接通提示的实现位（`speechSynthesis` vs `SystemSpeechTtsFallbackAdapter`）。
9. **[低] C12 命名统一**：`finalizing-asr` ↔ 冻结方案的 `transcribing`（纯命名，可选）。

---

## 附：审查方法与限制

- 本报告所有"已实现"结论均附**文件路径 + 行号**；"可达性"单独核对了导入链与调用点（如 `respondTurn` 未传 policy、`buildVoiceTeacherMessages` 仅接 completed turns）。“代码存在”与“被调用”已分别确认。
- 未修改任何代码/测试/配置/文档；未采信冻结方案的"阶段记录/阶段验收记录"，亦未采信先前会话记忆。
- 已跳过的实时/真机类行为一律标注为"需人工验证"，未作推定。
- 唯一副作用：为验证 `vite build` 生成并残留了 `dist-verify-review/`（见 3.2 备注），非源码改动。
