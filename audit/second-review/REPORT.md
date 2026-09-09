# StudyJournal 四次提交二次审计报告

审计日期：2026-09-09（Asia/Shanghai）
审计性质：历史基线核验、修复审查、针对性回归验证。未修改业务源码，未提交 commit，未调用真实付费 Provider。

## 1. 执行结论

**本批修改有明确价值，但不应按“修复完成”验收。建议保留合理修复，定点返修，而不是整体回滚。**

- 两份原报告的共同核心发现——基线生产语音使用模板回复与伪转写、Web 历史漏路由、部分请求缺少超时——可以从历史源码核实。
- 第二份报告总体仍更有工程价值：准确指出移动端菜单裁切、批注跨卡状态、AI 问答取消等具体问题。但它的问题统计、分级和部分绝对化结论不严谨；报告质量不能替代修复验收。
- 修复已经添加真实 Provider 调用路径，不能继续称当前版本“完全是假语音”。不过真实请求与正确业务闭环是两回事：当前回答未传给 LLM、多句 ASR 丢前句、取消/静音没有完整控制底层请求、重挂后管线丢失等问题仍在。
- 原有自动化全绿。本审计另写的 **11 个针对性契约用例全部在预期断言处失败**，证明现有测试没有覆盖这些边界；不是现有 887 项测试变红。
- 尤其需要返修：第四次提交以 docs 命名，却改变了批注清理保护，允许旧非空草稿覆盖评分清理标记。
- 建议继续由熟悉代码的原修复 AI 实施，但必须逐项补可复现测试、由独立审查验收；不宜再让同一个 AI 仅靠自己的勾选清单宣布完成。

## 2. 范围、基线与证据边界

### 2.1 Git 身份

本次通过 git ls-remote origin refs/heads/main 核对远程，而非假设本地跟踪分支最新：

- 仓库：github.com/a1234tuan/StudyJournal.git。
- 两份原报告的历史基线：5f3cdc0。
- 本次远程 main / 本地 HEAD：8fc0692fb7365d9b6a29f320d08396abc4d959f4。
- 四次提交按顺序：
  1. bf02aeac1c85b97ca4164ef3a5dea9852b138e1c：真实语音管线与宿主桥接，43 文件。
  2. 2abce384c8393b12365c8d04642411087d11a936：P1 修复，17 文件。
  3. fc8e4dba09719c0c966982852a3716281e325aa1：P2 与清理，22 文件。
  4. 8fc0692fb7365d9b6a29f320d08396abc4d959f4：审计与修复文档，以及批注 repository 逻辑修改，13 文件。
- 合并范围：95 个文件，4096 行新增、461 行删除。各提交文件数存在重叠，不能相加当作独立文件数。
- 开始时工作区干净；本次新增文件仅位于 audit/second-review/。

### 2.2 材料与方法

材料 A：D:/DeskTop/408 StudyJournal 全面审计报告.md。
材料 B：D:/StudyJournal-Source/STUDYJOURNAL_AUDIT_REPORT.md。
另参考 STUDYJOURNAL_FIX_PLAN.md、四次提交差异、5f3cdc0 历史源码和当前生产调用链。

历史报告是否准确，以 5f3cdc0 为准；当前是否修复，以 8fc0692 为准。报告中的“已实测”“已完成”只作为待验证声明，不作为指令或验收证据。

证据分层：
- **复现确认**：隔离测试在当前真实实现上触发不符合契约的行为，外部服务为 Mock 或完全不调用。
- **静态确认**：代码和调用参数足以证明，但未用真机/真实 Provider 复现外部后果。
- **需要产品决策**：行为确实存在，但是否应改变依赖体验、保留策略和支持范围。
- **未复核**：不推测、不按报告自述认定已通过。

这不是“全仓库所有缺陷已经穷尽”的保证；重点为本次四提交、原报告重要问题及修复所影响的边界。

## 3. 当前优先返修项

以下路径均相对 D:/StudyJournal-Source；行号对应 8fc0692。P1 表示应在语音对外使用前修复；P2 表示明确正确性/可靠性缺口或需要尽快处理的产品风险。没有以单纯缺少一个增强功能为依据新增 P0。

### R1 [P1] 本轮确认回答没有进入 LLM 请求

**状态：复现确认；bf02aea 新接线引入。**

位置：src/features/voiceRecall/VoiceRecallWorkspace.tsx:376；src/features/voiceRecall/teacherPrompt.ts:25；src/features/voiceRecall/pipeline.ts:78。

工作区拿到 confirmedText 后，仅把学习目标、资料和已提交历史 turns 传给 buildVoiceTeacherMessages；传给 respondTurn 的 messages 没有追加本轮 user 消息。ASR_FINALIZED 更新状态机，但 respondTurn 不会从状态机自动补入回答。pipeline.runTurn 原本会追加 ASR 文本；新工作区却绕过它、分别调用 transcribe/respond。

后果：第一轮模型只看见资料/目标；第二轮模型最多看见上一轮回答。界面和持久化显示当前回答已提交，但模型并未读取它，反馈可能答非所问。

证据：R1 输入唯一标记 UNIQUE_CURRENT_ANSWER_20260909，捕获生产工作区发出的 respondTurn 参数，messages 中不存在该标记。

建议：组装消息时明确追加本轮确认文本，使用 untrusted-learning-content 边界；新增首轮和连续两轮的请求体断言，而不是只验证数据库里保存了 confirmedText。

### R2 [P1] 多句 ASR 转写只留下最后一句

**状态：复现确认；旧管线假设在 bf02aea 接入句级 ASR 后成为实际问题。**

位置：src/features/voiceRecall/aliyunAsrProtocol.ts:78；src/features/voiceRecall/aliyunAsrTransport.ts:104；src/features/voiceRecall/pipeline.ts:71；src/features/voiceRecall/VoiceRecallWorkspace.tsx:331。

Paraformer 映射的是 output.sentence 的句级结果，每个 sentence_end 转成一次 final。管线却对每次 final 执行 transcript = event.text.trim()；工作区也直接 setTranscript(event.text)，没有句子累积。

证据：R2 连续送入“第一句。”和“第二句。”两个 final，结果只有“第二句。”。

建议：在 ASR 适配层规范化“已完成句子 + 当前 partial”，保留分段标识/时序并避免重复 final；不能简单假定所有 Provider 的 final 都是累计全文。用三句、partial/final 交错、重复结束事件验证。

### R3 [P1] “取消当前轮次”未取消 Provider；打断也未建立旧轮次隔离

**状态：取消分支复现确认，打断后的迟到回调风险静态确认。**

位置：src/features/voiceRecall/VoiceRecallWorkspace.tsx:532；src/features/voiceRecall/runtimeController.ts:118；src/features/voiceRecall/VoiceRecallWorkspace.tsx:397。

thinking/finalizing-asr 分支只 dispatch CANCEL_TURN。runtime.dispatch 只改状态、持久化和通知，不调用 cancellation.cancelTurn，因此正在执行的 ASR/LLM/TTS signal 不会中止。

speaking 分支只 interruptPlayback 再改状态，没有取消仍在产出的 LLM/TTS。音频回调丢弃 pipeline 提供的 generation 参数，直接 runtime.enqueueAudio(chunk)，旧轮次之后到达的音频有机会被当成新代队列音频。迟到的 LLM_REPLIED/PLAYBACK_FINISHED 也可能对已取消状态触发非法迁移。

证据：R3 让真实 runtime 把 signal 传入受控 pending pipeline，点击取消后 signal.aborted 仍为 false。

建议：统一 cancelActiveTurn API，同时停止请求、采集和播放；回调和落库同时检查 operationId/generation；对取消与失败分别收尾。断开请求只能减少继续执行的机会，不能据此承诺供应商不收取已经发生的费用。

### R4 [P1] 静音只是状态与视觉变化，采集继续进行

**状态：UI 控制复现确认，静音期间帧仍入队静态确认。**

位置：src/features/voiceRecall/VoiceRecallWorkspace.tsx:621；src/features/voiceRecall/VoiceRecallWorkspace.tsx:288；src/features/voiceRecall/runtimeController.ts:129。

onMute 只发送 SET_USER_MUTED，没有停止/暂停 adapter。采集回调不检查 userMuted 或 systemCaptureGate，继续 queue.push(frame)。active 波形会关闭，让用户误以为已经停止采集；随后结束录音并转写时，这些帧仍可能发送给 ASR。

证据：R4 启动采集后点“静音”，页面变为“已静音”，但 stopCapture 从未调用。测试使用采集启动 seam，不使用真实麦克风；帧过滤缺失由代码确认。

建议：静音控制必须抵达真实采集层，并丢弃不应提交的静音区间帧；恢复不得偷偷取消用户静音选择。补暂停、后台切换与权限弹窗期间取消的测试。

### R5 [P1] 页面重挂后无法继续原来的真实通话

**状态：复现确认；bf02aea 新生产管线生命周期问题。**

位置：src/features/voiceRecall/VoiceRecallWorkspace.tsx:163、src/features/voiceRecall/VoiceRecallWorkspace.tsx:188、src/features/voiceRecall/VoiceRecallWorkspace.tsx:215、src/features/voiceRecall/VoiceRecallWorkspace.tsx:265。

runtime 为单例，可以保留当前 session；真正的 ProductionVoiceSession 却只在组件 sessionRef 中，且仅 startSession 时赋值。页面卸载重挂后 ref 为空。如果 activeSessionId 相同，restore effect 直接跳过；即使从数据库 restore，也只恢复本地状态，不重建 Provider 管线。

证据：R5 暂停、重挂同一通话、点击“继续通话”和“开始回答”，采集没有启动，工作区走“语音服务未就绪”路径。

建议：由 runtime 持有可恢复的管线，或基于持久化 Provider 快照和本机凭据显式重建。仍应保持恢复后 paused、由用户手动继续；不要为解决此问题而自动打开麦克风。

### R6 [P1] ASR 在 WebSocket 打开后等待 task-started 无截止时间

**状态：复现确认。**

位置：src/features/voiceRecall/aliyunAsrTransport.ts:84、src/features/voiceRecall/aliyunAsrTransport.ts:87、src/features/voiceRecall/aliyunAsrTransport.ts:133。

连接定时器在 socket.onopen 中就 clearTimeout，但 started Promise 只有收到 task-started 才 resolve。若 WebSocket 已打开但业务握手不返回，则 await started 无限等待。abort 只关 socket/queue，不保证 reject started；正常 close 也可能不 settle。超时 reject 分支本身没有统一关闭 socket。

证据：R6 模拟 socket open 后永不回应 task-started，推进十倍超时时间仍未 settle。此用例证明业务握手缺失上限；不声称真实服务每次都会挂起。

补充：task-started 之后再来 task-failed 时，仅 reject 一个已 resolve 的 Promise，不会把错误传入事件消费者；已有 final 时还可能把部分转写当成功。需要对整个任务的成功/失败/取消生命周期统一收敛。

建议：分别设 socket-open、task-started、任务整体/idle deadline；所有退出分支关闭资源并拒绝 pending promise；事件队列支持 fail(error)。

### R7 [P2] 评分清理标记允许旧非空草稿覆盖

**状态：复现确认；8fc0692 的新增回归。**

位置：src/features/reviewAnnotations/repository.ts:25；src/features/reviewAnnotations/ReviewAnnotationSurface.tsx:137。

原代码遇到 existing.pendingClear 就阻止 upsert；新代码只有 incoming draft.elements.length === 0 才阻止。组件有 250ms 防抖保存及卸载保存，旧的非空草稿正是必须拒绝的对象。

证据：R7 依次保存非空草稿 → clearAfterRating → 重放旧非空草稿。当前数据库又出现原笔迹，而不是清空结果。750ms 删除定时器之后可能再清掉数据库，但窗口中快速撤回/重新挂载可读到旧笔迹；窗口内进程终止则定时器不再兜底。

这违反“评分撤回不恢复旧批注”的边界。清理陈旧 pendingClear 的动机合理，但放行全部非空写入不是安全实现。

建议：恢复 tombstone 防护，采用 epoch/评分版本/事务区分“旧保存”与“用户评分后新建批注”；单独清理陈旧标记。此变更藏在 docs 提交中，也降低了审查可见性。

### R8 [P1，协议兼容待宿主验证] 桥接抹掉文本帧与二进制帧的区别

**状态：类型转换复现确认；真实 Provider 是否容忍该差异未在本次验证。**

位置：src/features/voiceRecall/bridgeVoiceSocket.ts:75；desktop/main.cjs:589；android/app/src/main/java/com/noteproject/study408/NativeVoiceAsrPlugin.java:109。

createAliyunAsrTransport 发出字符串形式 run-task/finish-task，音频发 Uint8Array。共用 bridge 却把字符串也变成字节数组，Electron 直接 socket.send(data)，Android 固定调用 socket.send(ByteString)。控制消息因此和 PCM 一样变成二进制帧。

证据：R8 把 run-task 字符串送进真实 bridge factory，宿主 send 接到的是 Uint8Array，而非字符串。已有桥接测试只把字节解码回 JSON 来验证内容，没有校验帧类型，因此掩盖了差异。

已提交的 live ASR 用例直接使用 transport 的默认 socket factory，不经过这条宿主桥；它通过不能证明桥接后的线协议等价。本报告不把“字节转换已证实”夸大为“本次已实测供应商拒绝”。

建议：bridge 协议携带 kind=text/binary，宿主分别发送；增加本地 WebSocket 服务端帧类型测试，再做受控 Electron/Android 握手验收。这与 R6 的“打开后永远等待”可能叠加。

### R9 [P2] 教练页面新增 AbortController，但没有传给调用

**状态：复现确认；fc8e4db 的不完整修复。**

位置：src/features/reviewCoach/AdaptiveReviewPage.tsx:58、src/features/reviewCoach/AdaptiveReviewPage.tsx:174、src/features/reviewCoach/AdaptiveReviewPage.tsx:211、src/features/reviewCoach/AdaptiveReviewPage.tsx:224。

useAppData 已接收可选 signal，但页面三处调用仍是 onGenerateTurn(task.id) 和 onSubmitAnswer(id, answer)，未传 requestAbortRef.current.signal。卸载时 abort 的 controller 与实际请求无关。

证据：R9 点击“开始训练”，回调的第二个参数为 undefined；卸载无法取消该请求。现有 AdaptiveReviewPage 测试甚至仍只断言提交回调收到两个参数。

建议：把页面/操作级 signal 全链路透传；注意开发 StrictMode 下 effect cleanup 会中止 controller，重新 setup 时应创建有效 controller。修复计划 B3-3 不能保持“已完成”。

### R10 [P2] 凭据配置与生产解析不一致

**状态：自建 Fish profile 失败已复现；ASR 设置入口缺失为静态确认。**

位置：src/features/voiceRecall/productionPipeline.ts:134；src/features/voiceRecall/credentials.ts:7；src/features/voiceRecall/VoiceRecallPresentation.tsx:34；src/lib/ttsProviders.ts:4。

生产 TTS 凭据只查内置 voice-tts-fish-s21、fish-audio、default 等固定 id，不按 settings.tts 中用户建立的 provider profile id 查找。TTS 设置却按 p.id 存密钥，新建 profile 默认是新 id。

证据：R10 按用户 TTS 设置保存一个有密钥的 Fish profile，同时补齐 ASR 和 LLM 测试凭据，sessionFactory 仍报“缺少 Fish Audio 的密钥”。默认 id 恰好匹配的用户不一定受影响，所以不能表述为“所有用户都无法配置”。

此外，缺 ASR 密钥时提示在语音服务设置填写，但语音设置接口/字段只有模板、endpoint、模型、音色，没有 ASR secret 写入入口；voice-asr-aliyun 槽位没有对应正常 UI 保存路径。环境变量 live 测试或开发者手工写入不能代替用户配置流程。

建议：显式选择实际 ASR/LLM/TTS profile 并按其 id 解析密钥，提供 ASR 本机凭据输入和验证，避免靠多个含义不同的 default 槽位兜底。

### R11 [P2] 用量仍保存为零，修复计划的记账声明不成立

**状态：复现确认；A 已指出，当前仍未修复完整。**

位置：src/features/voiceRecall/VoiceRecallWorkspace.tsx:460；src/features/voiceRecall/localTypes.ts:45；STUDYJOURNAL_FIX_PLAN.md 的 B4-5。

respond 返回真实 usage，但工作区只把 ttsCharacters 赋给 playedCharacterCount；轮次类型没有 llmOutputTokens 字段。saveHistory 仍写 emptyUsage。ASR 的 usage 返回值也没有累积进历史。

证据：R11 注入明确的 8 个输出 token、4 个 TTS 字符，经过生产工作区提交、结束、保存本机历史，读出的 llmOutputTokens 为 0。

所以“ttsCharacters/llmOutputTokens 写入轮次记录”这句执行记录不准确；“能够在返回对象中计算用量”不等于“已记账”。

建议：在本机会话/轮次记录累计实际 usage；未知值不要伪装成零；计量、预算、价格估算分开设计，继续排除云同步与可移植导出。

## 4. 其他静态缺口与需要决策的修改

### R12 [P2] 不可重试错误分类只覆盖部分 Web HTTP 失败

位置：src/features/reviewCoach/orchestrator.ts:346、src/features/reviewCoach/orchestrator.ts:525；src/features/reviewCoach/aiGateway.ts:27；src/features/reviewCoach/aiSchemas.ts；src/services/aiClientService.ts:333。

- Web 非 2xx/非 JSON HTTP 响应已增加 AiRequestError，属于有效修复。
- 但“OpenAI envelope 是合法 JSON、其中 content 不是合法 JSON”由 parseJsonContent 抛普通 Error；schema 校验也抛普通 Error。它们仍越过 instanceof AiRequestError 守卫进入重试。
- Android 原生错误在 runNativeAiChat 分支直接返回/拒绝，未转换成同一结构化错误类型；native 401 等没有该 retryable 分类。
- 可重试错误仍为立即重试，未增加退避；是否需要全局熔断则应另作策略决策。

因此 B3-2 所称“401/403/非 JSON/CORS 等确定性失败立即停止”不能不加平台和错误层级限定。建议做跨平台错误归一化，并对 HTTP envelope、模型 content、schema 错误分别测试。也不应假定所有格式失败都永久不可恢复，可设置有限修复策略，而非无区别禁止重试。

### R13 [P2] 角色 timeout 声称权威，实际只有 turn-generator 生效

位置：src/hooks/useAppData.ts:526、src/hooks/useAppData.ts:540。

循环读取三个角色的 timeoutMs 并回写配置，但只有 turn-generator 会更新 quizTimeoutMs；所有 generate/review/evaluate 请求共享这个值。单独配置 question-quality-reviewer 或 answer-evaluator 的超时不会生效，快速解读/会话规划还有各自路径。

建议：按角色将 timeout 传入对应 gateway 方法，或把真实共享策略明确表示为统一配置；不要仅把不生效的值再次持久化就称为“权威”。此项是原 B 的配置问题修复不完整，不是需要整体重写配置系统。

### R14 [P2，保留策略需确认] 保存第 201 条本机历史会静默删除最旧已保留摘要

位置：src/features/voiceRecall/repository.ts:107；引入提交 bf02aea。

新增 maxHistoryEntries=200 后，saveHistory 自动 bulkDelete 最旧历史。原 B 指出了 listHistory 全量加载/增长问题，但“读取无分页”不必然应通过“删除用户显式保留的数据”来修复。

行为本身由生产代码和原作者新增的 caps the local history 用例共同确认；不是随机竞态。历史本来不参与备份和同步，因此不能用云端恢复作为兜底。正式持久保存应转日志，这一边界也不等于用户已经同意任意静默淘汰历史。

建议：先明确保留规则，在 UI 明示并确认；也可以分页读取、限制继续保存或引导转日志，而非无提示删除。没有用户需求依据前不建议将该项当作普通“无害优化”验收。

### R15 [P2] “自动轮次/停顿后发送”仍没有对应生产端点检测

位置：src/features/voiceRecall/VoiceRecallPresentation.tsx:44；src/features/voiceRecall/VoiceRecallWorkspace.tsx:263、src/features/voiceRecall/VoiceRecallWorkspace.tsx:301。

采集期间只是把 PCM 全量排入 frameQueue；直到 stopCapture 之后才启动 runtime.transcribeTurn。自动模式仍靠用户手动点击发送，未把停顿检测接入；录音阶段没有队列消费方，长时间不停止会一直积累音频。

这不等于“没有真实 ASR”：停止后确实会发真实请求。但“录音时实时识别”和“录完后快速上传给流式 ASR”是不同体验。应接入端点检测/有界队列/最长录音时长，或明确把模式标为手动分段，不能只保留“停顿后发送”的承诺。

同样，当前生产 TTS factory 走 BufferedTtsFallbackAdapter（逐句拿完整音频再播），而非直接走 FishAudioTtsStreamAdapter。应准确说明“句级合成播放”，不要把原 A 的 Fish 首块后无超时直接误算成当前默认生产必经路径。

## 5. 两份原报告的质量与准确度再评估

### 5.1 总体排序：B 高于 A，但不能给出伪精确的准确率

仍推荐 B 作为主修复清单、A 作为补充风险清单。依据不是 B 写得长、问题多，而是 B 对移动端菜单、跨卡批注、取消调用链和发布测试的定位更贴近可执行工程问题。

不能给出“B 准确率 95%”一类数字：两份报告把同一根因拆成不同数量的条目，部分是未来风险，部分是视觉偏好，部分未提供可复现附件，本次也没有逐一重跑所有历史视觉场景。

上轮仅读文档时，我曾因为内容重叠而提出“可能并非独立审计”。这没有足够证据，应撤回该推断。对同一版本发现同样的问题，本来就可能是正常的独立结论；本文不据此评价作者独立性。

### 5.2 两份报告共同准确的重要发现

以下已结合历史 5f3cdc0 源码核实，而不是用最新版本倒推：

- **生产语音未调用真实管线**：旧 Workspace 使用 createTeacherReply，采集只计帧；stopCapture 生成固定说明文字并预填输入框。B 的“伪转写可能进入正式轮次”和 A 的“模板回复/伪播放完成”有事实基础。
- **Web 历史白名单漏四个子路由**：旧 webNavigationHistory 不接受 aiExport/templates/ttsSettings/podcastTemplates；当前改为从唯一运行时列表派生类型，有针对性。
- **默认 AI HTTP 请求缺超时**：旧默认 timeoutMs 为 0，AiChatPage 不传 signal；当前已增加默认截止时间与停止生成。
- **部分失败一律重试、语音用量未记账**：原报告提醒有价值，但要区分平台、错误层级、用量上限与账单预算。
- **主题回退到旧色**：缺 token 的 fallback 属真实实现问题；它的发布优先级不应等同数据丢失或无法操作。

### 5.3 B 特别有价值的发现

- **移动端更多菜单被新增 overflow:hidden 裁切**：历史 CSS 的选择器确实存在，菜单位于裁切区之外；当前去掉该裁切且新增命中测试，实际 E2E 已通过。
- **批注跨卡串写**：旧组件 useState 只用首卡初始化，加载不到新草稿没有 reset，父组件没有 key；当前 reset/key 是合理根因修复。注意这和 R7 的“评分后晚到保存”是不同生命周期问题，修好前者不等于后者正确。
- **E2E 选择器因描述删除失配**：历史 MorePage 与历史测试的可访问名不一致，差异可核实。本次没有重新 checkout 基线跑历史 E2E，所以不能独立证明它当时的精确时长、40/4 日志；当前 44/44 是本次实测。
- **教练选择随快照重置、设置保存时密钥尚未加载**：定位具体，也能从新旧差异看出修复意图和实现对应关系。

### 5.4 A 的不足和歧义

1. **统计明显未闭合**：摘要称 23 项，但正文有 55 个带 Critical/High/Medium/Low 等严重度的标题（包括重叠根因与依赖提示，不代表 55 个独立 bug）。缺少去重规则，不能把摘要当作可靠统计。
2. **“只有教练和播客是真实成本来源”不准确**：基线 AiChatPage 已调用真实 sendChatCompletion，A 自己后面又讨论 aiClientService。它忽略了独立 AI 问答等路径。
3. **把恢复后 paused 当作缺陷，忽略了安全边界**：导航/卸载后暂停、恢复时仍暂停本来是产品要求；也不能把普通 React 重渲直接等同卸载重挂。真正问题应是“用户明确恢复后仍不能工作”，即本次 R5，而不是要求自动继续采集。
4. **计时器静态标记为 High 偏高**：没有计时器和没有真实通话不是同一严重度，应看是否影响额度、结束控制或任务安全。
5. **混淆语音通话详情与 Review Coach 学习驾驶舱**：A 的“驾驶舱为空壳”主要指通话详情面板，不能据此否定整个学习教练模块。
6. **性能/成本推论有过度概括**：“无重试”不必然是 bug；没有全局预算不等于单次没有 max_tokens；串行 await 挂起本身也不证明请求会无限重复收费。
7. **大量 UI 结论是静态推导或视觉偏好**：FAB 是否抬升、左右边界是否齐平、助手字体是否更大，不宜不经设计确认统一当作必须修复的缺陷。grid 的隐式行本身也不是错误，必须证明实际不可用。
8. **依赖漏洞数量不能照抄成当前结论**：A 提到的 npm audit 75 项依赖于数据库时点、锁文件与生产可达性。本次未重做依赖安全审计，不认定该数量当前成立，更不建议 npm audit fix --force 式无差别升级。

A 的价值在于指出语音底层的超时、取消、用量、长文本、队列等风险。但其“检查到代码原语”与“证明用户会遇到缺陷”的距离较大。

### 5.5 B 的不足和歧义

1. **统计也不可靠**：第 14 节实际列出 P0=1、P1=10、P2=18、P3=20，共 49 行；第 15 节却写 1+10+20+25=56。不是简单与 A 口径不同，而是 B 内部计数不一致。
2. **分级混合缺陷、设计偏好和维护建议**：首页 720/1040 宽度差、未开启 noUnusedLocals、无全局熔断不能与数据串写采用同等“必须修复”口径。
3. **同一语音未接线根因重复拆成 P0 与多条 P1**：可以按验收面拆子项，但统计/排期应保留父子关系，避免把数量当作成果。
4. **“无超时/取消 ⇒ 全额计费”“披露不实 ⇒ 同意记录无效”等结论过强**：代码能够证明调用没有终止/描述与实现不一致，不能单独证明供应商实际账单或法律效力。应改成可核验的风险表述。
5. **“修复约 3 行”“接线为同一处改动”低估风险**：跨卡状态与评分清理不是一个状态；真实语音涉及凭据、帧类型、取消、恢复、确认文本、播放完成。四次提交新增的大量代码和本次复现都说明它不是一处小补丁。
6. **“原功能均未被破坏/唯一回归”超过审计证据范围**：单测全绿和几个浏览器探针不能支持全称判断，应写成“已验证路径未发现……”。
7. **修复清单的勾选超前于行为验收**：B3-3 的取消、B3-2 的错误分类、B3-7 的 timeout、B4-5 的记账均存在本文指出的缺口。

### 5.6 对“应该由谁修”的修正建议

B 作者有能力做定向修复，已交付多项正确改动；本次结果并不支持“另一个 AI 一定会修得更好”。但它明显更擅长查找静态缺口和快速接线，跨层集成、取消时序与验收真实性不足。

建议角色分工为：B 作者继续实现，独立审查者掌握失败用例与验收结论。每项关闭必须说明“复现输入 → 修复位置 → 原失败测试转绿 → 相关边界仍通过”，不要仅以“已加 controller/已加 API/已有单测”关闭。

## 6. 哪些修改合理，哪些不应照单全收

### 6.1 应保留的合理改动

- 移除移动菜单裁切，并用真正的点击命中测试验证，而不只用 selectOption 或 DOM 存在性。
- MORE_SUB_ROUTE_VALUES 统一类型与运行时白名单，并对未知值作安全降级。
- 批注组件按记录+复习发生键隔离状态，重置选中/绘制状态。
- AI 问答默认超时、停止按钮、signal 透传；原生/桌面增加可取消请求标识是必要方向，只是不能替代宿主行为验收。
- 教练快速 JSON 路径禁用 thinking、明确区分部分 HTTP 错误；语音短回复预算和不可信资料边界也有价值。
- 工作台候选集合只按稳定 key 重置，而不是每次快照刷新重置。
- 设置保存不再对尚未加载且未编辑的密钥执行 clear；但迟到的加载结果覆盖用户刚编辑的 key 这一相邻竞态仍建议补测。
- 原生 captureError 接收、历史/会话维护入口接入、预览不覆盖既有密钥、生产预览排除 native/desktop。
- 修复选择器以匹配真实可访问名，而不为测试人为恢复过时的产品描述。
- 保持语音三表、批注与 Provider 凭据本机隔离；现有相关测试与 Firebase 验证没有因这批改动变红。

### 6.2 不应采用或需要返工的修法

- **明确应返工**：R7 放宽 pendingClear 守卫，它修了“残留标记”却破坏“拒绝晚到旧保存”。
- **明确不能验收为完成**：R9 只有 controller 没有 signal 参数；R11 只计算返回值却把零写入历史；R13 读取角色配置却仍共用一个 timeout。
- **需要产品确认**：R14 的 200 条自动淘汰，不应把性能优化悄悄变成保留策略。
- **有意图但要补语义**：对原评论直接截到 1000 字、决策块截到 4000 字可以控制成本，却可能丢失后半段关键事实。建议在 AI 输入显式标识截断、对超限拒绝/分块/摘要，而不是声称分析完整原文。历史仅限制五条，其每条 originalComment 仍不等于总字节有界。
- **通常不是必须修**：FAB 抬升、宽度对齐、图表颜色等应按设计规范决定；删除确认无引用的 QuickInsertBar 可以接受，但它不是解决语音阻断的必要前置。
- **不得反向修错**：不要因 A 的 paused 批评恢复自动开麦；不要为“有重试”而对已开始播放/可能重复计费的任务盲目重发；不要为了通过失败测试把真实路径换回 Mock。

## 7. 原 B 问题的覆盖状态与 A 的剩余价值

下面按原 B 第 14 节实际列出的条目顺序归类，不采用其不一致的“P2 共 20 项”统计。

### 7.1 原 P0/P1

- 真实语音未接线：**已经接线，但业务闭环未通过**，见 R1–R6、R8、R10。
- 首次披露/伪状态/伪转写：固定假文本已删除，披露已根据当前 LLM 展示；仍受 R4 静音真实性和 R15 实时性问题限制。
- 移动端菜单：**修复有证据**，当前 E2E 通过。
- 批注跨卡：**根因修复有效**；评分后晚到保存是新回归 R7。
- AI 问答超时/取消：Web 接线与单测通过；Android/桌面“停止供应商端计费”仍不能由代码证明。
- 原生/桌面取消：增加了宿主 API 和信号；真实宿主取消时序、断开仍待验收，不能扩展为语音取消已修，见 R3。
- E2E 红灯：**当前 44/44 通过**。
- Web 返回四路由：**修复有对应测试**。
- 原生采集错误：已订阅错误并传给 UI；启动权限/错误后资源释放等仍应真机验证。

### 7.2 原 P2（实际 18 行）

- 编辑器宽度基准：有定向 CSS 修改；属于体验修复，当前 E2E 未报失败。
- 模板重复返回：已加入页面自带返回排除列表。
- 日志选择 grid：改用 selecting，方向与根因匹配。
- 批注工具栏与评分区：已恢复测量停靠与同时显示；完整键盘/安全区遮挡仍需设备验证。
- 教练选择被快照重置：改为稳定 candidateKey，合理。
- 教练生成/提交取消：**未完成，R9**。
- thinking 与不可重试分类：thinking 已改，错误分类仅部分完成，**R12**。
- 角色运行参数：**部分完成，R13**。
- 可操作错误提示：新增 ActionableError 通路；要避免把 Provider 原始响应内容无差别当作“本方写的安全文案”。
- Android 返回：新增对应分支，意图正确；本次未做物理返回键验收。
- 会话状态跨会话：startSession 清掉多项状态，部分修复；跨挂载恢复另见 **R5**。
- 清理/修复 API 未接线：App 初始化和删除操作已有调用；不把静态接线当作全部云端删除/异常流程都已验证。
- 保存设置清空密钥：增加 loaded/dirty 集合；原场景已覆盖，异步编辑相邻竞态建议补测。
- TTS 超时/重试：播客调用加入超时、Android 4xx/下载失败分类；当前生产语音 TTS 为缓冲 fallback，不应和闲置 Fish 流适配器混为一谈。
- 编辑器 sticky 偏移：已有 CSS 修改；真机 IME/safe-area 门禁保留。
- Ctrl+F 面板：增加 sticky；“任意长文档位置都能看见”的结论仍缺专门浏览器用例，不直接认定 fully fixed。
- 首页宽度：已改为 100%；是否更优是设计判断而非事实性 bug。
- 旧 accent token：已改为主题 token；接受为低风险视觉修复。

### 7.3 原 P3 与合理延期

死组件/导入、预览覆盖密钥、生产预览门控、图表色、历史上限等做了部分处理。其余如退出层可聚焦节点、批量操作错误反馈、撤回栈上限、CSS 结构债务、最近日志排序、更多子页返回样式等，没有理由因本轮未修就一概判为失败：修复计划原本重点是 P0/P1/P2。

但 P3 项里也有会随着真实接线变严重的内容：取消/失败时资源释放、异步持久化错误、凭据边界。应重新基于实际后果定级，而不是沿用最初优先级永久搁置。

### 7.4 A 应继续提供的补充检查

- **已经证实仍有价值**：ASR 截止时间不足（R6）、用量全零（R11）、取消/代际隔离（R3）、麦克风状态与 UI 的一致性（R4）。
- **需继续验证**：长转写/长回复/打开编辑器时对话区滚动与控件裁切；静态计时器；字幕开关与文本编辑器耦合；批注工具栏尾部可发现性与暗色对比度。这些不应标成“已修完”。
- **暂不按当前默认生产缺陷计数**：FishAudioTtsStreamAdapter 首块后超时释放、闲置原语、原型独有 CSS。只有确认具体生产入口时才提升优先级。
- **需要策略而非机械补代码**：会话预算、重试退避、熔断、SSE 缓冲上限和录音最大长度。可先实施确定的资源上限，不必为了齐全而建设复杂计费系统。

## 8. 本次验证结果与测试盲点

### 8.1 实际执行

工作目录：D:/StudyJournal-Source。结果日志整理在 audit/second-review/validation.txt，失败用例在 audit/second-review/probes.test.tsx。

- npm run test -- --exclude '**/*.live.test.ts'：**138 个文件 / 887 项通过**。显式排除两份 live 测试文件，保证不因环境已有密钥而调用付费服务。
- npm run build：**exit 0**，tsc 与 Vite 生产构建通过。
- npm run test:e2e：**44/44 通过**，Chrome Desktop + Android-narrow，约 1.4 分钟。
- npm run test:firebase：**4/4 通过**，仅 demo-noteproject-stage9 本地 Firestore/Storage Emulator。
- git diff --check 5f3cdc0 HEAD 与 git diff --check：通过。
- npx vitest run --config audit/second-review/vitest.config.ts：**11/11 在对应行为断言处失败**，不是网络连接失败、测试初始化失败或因为没有真实 Key。

11 项是刻意挑选的失败复现，不是随机样本，不得推算整个产品“100% 失败”。它们不在 src/ 默认测试 include 中，不会污染原有 887 项基线；返修时可将其迁移为正式测试并逐项转绿。

### 8.2 现有测试为何没有阻止这些问题

- Workspace 的 MockLlmStreamAdapter 能在请求漏掉当前回答时照常返回；原测试只验证确认文本保存，未验证实际 LLM 输入。
- ASR 测试只有单个最终句子，没有句级多 final 聚合断言。
- 桥接测试将字节解码为 JSON 后只看 payload，不看 text/binary 帧语义。
- 取消测试验证局部工具/回调，不验证“点页面按钮 → 实际 Provider signal.aborted”。
- live 回复测试手工构造了含本轮答案的 messages，绕开了 Workspace 错误组装；音频测试只统计字节，不代表真实设备已听到正确播放。
- live ASR 测试默认发送短静音并检查 completed，未覆盖多句内容、宿主桥、按钮取消和导航恢复。修复记录另称做过 TTS→ASR 往返，本次没有重跑该真实账号实验，不能否定或复述为本次证据。
- 生产 E2E 重点是缺配置时拒绝启动与布局；原型 E2E 通过不能证明生产 Provider 链和取消语义正确。

### 8.3 未完成的验证（不得当作通过）

- 未调用真实 ASR/LLM/TTS，未核对供应商账单。
- 未运行 Android 物理设备通话、IME/系统返回/后台恢复验收；未在本次重新编译 Android。
- 本地 Electron 可执行文件不存在于 node_modules/electron/dist/electron.exe，因此未完成 Electron 宿主运行时验证。Node v24.16.0 对 WebSocket options 构造接受不等于 Electron 已验证。
- 未重跑历史 5f3cdc0 的全套浏览器/模拟器；历史判断使用 git show 和差异证据。
- 未重做 npm audit 漏洞数据库核验；未用远程漏洞数量作严重性结论。

## 9. 文档与提交卫生

8fc0692 不是纯文档提交：它修改 src/features/reviewAnnotations/repository.ts 的 pendingClear 守卫并删除一个 API。应把业务修改和文档拆开，便于定位、回滚和审查；本文 R7 正是该提交新增的行为回归。

修复计划也存在时间层次混杂：前段仍写“B3/B4 尚未开始”，后段又标完成；末尾仍称“本文件未执行任何代码改动”，而文首已说明计划+执行记录。可保留历史阶段快照，但应明确标日期/已过期，避免被当成现状。

另有明确冲突：docs/voice-recall-provider-configuration.md 的当前可用性仍说“Android 端 ASR 传输尚未接入”，而当前代码、AGENTS 与其他文档已声明新增 NativeVoiceAsrPlugin。应统一为“已实现桥接，宿主协议/真机验收未通过或待验收”，不要在两个极端间摇摆。

执行记录应将“实现代码存在”“隔离单测通过”“业务 E2E 通过”“真实服务可达”“真机完整流程通过”“账单核对通过”分开，不能统称“已验证”。

## 10. 建议返修顺序与验收标准

1. **先解决内容与隐私正确性**：R1 本轮答案、R2 多句转写、R4 真静音、R3 真取消/旧代隔离。先用本文用例证明失败，再修到通过。
2. **打通真实宿主与恢复**：R8 保留帧类型、R6 有界握手/错误传播、R5 暂停后重建、R10 用户凭据配置。加入从真实生产 Workspace 起步的无网络组合测试。
3. **恢复批注清理安全**：R7 评分与保存竞态用事务/epoch 解决；覆盖评分→卸载→立即撤回，以及进程退出前的待清理状态。
4. **兑现已标完成的可靠性项**：R9 页面取消、R11 用量记账、R12 跨平台错误分类、R13 角色配置。
5. **确认产品策略后再改**：R14 已保留历史的淘汰；R15 自动轮次/录音缓冲边界；长文本截断与视觉优先级。
6. **最后才做受控真实验收**：桌面和 Android 各至少五轮连续通话，覆盖三句回答、静音、取消、打断、后台恢复、弱网；观察实际请求体、帧类型、socket 关闭、播放完成与本机用量，并与账单分开核对。测试记录不得包含 Key、Authorization 或用户真实学习内容。

最终建议：**继续开发可以；语音只能作为待验收候选功能，不建议据本批提交宣布面向普通用户完整可用。** 已修好的菜单、路由和若干状态问题无需撤销，但也不应以它们的测试全绿掩盖真实语音闭环仍存在的缺口。

---

本报告及复现材料仅用于审计。除 audit/second-review 下的报告、隔离测试和证据记录外，未修改任何已跟踪业务文件；未创建分支或提交。
