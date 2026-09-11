# StudyJournal 语音复述 / 实时语音通话修复方案

- 制定日期：2026-09-11
- 审查基线：`1430c3f934d083bfac65822a01f1eca459f5ee59`
- 范围：Android、Desktop 的语音复述链路；Web 继续保持能力边界
- 原则：先修真实链路，再扩大能力；不调用、不写入、不复述任何已暴露凭据；不把候选模型标成已验证

## 1. 总体结论

当前产品不是完整连续通话，而是：

> 手动采集 → 结束录音 → 阿里云 ASR → 用户确认 → LLM → Fish Audio TTS → 音频播放

主要问题可以分为四类：

1. **必然可由 APP 修复**：自动模式未接线、Android LLM 非流式、TTS 完整缓冲、字幕只展示当前轮、配置 UI 混杂、退出遮罩主题作用域、取消信号未贯穿 Android TTS。
2. **可显著改善但不能保证**：ASR 断句、噪音触发、专业词识别、TTS 首句和段间延迟。
3. **主要取决于供应商/网络/设备**：模型本身的同音词错误、Fish Audio 节点可达性、蓝牙麦克风质量、运营商网络。
4. **不能仅靠换模型解决**：状态机、按钮流程、字幕持久展示、取消、音频焦点、Provider 配置架构、错误分类。

## 2. 能否修复矩阵

| 问题 | APP 可修复程度 | 换模型能否解决 | 方案 |
|---|---|---|---|
| 自动听、自动回复 | 完全可修 | 否 | 接通 `auto-half-duplex`，实现 VAD/endpoint/自动提交/播放后重听 |
| 换气即发送 | 高度可修 | 部分 | 分离 ASR final 与 LLM trigger；增加 endpoint、最短语音和未完句延迟 |
| 识别错词 | 部分可修 | 可以改善，不能保证 | 先改善采集、语言、热词、格式；再做同一录音 A/B |
| 专业术语 | 高度可修 | 模型也有影响 | 接入词表/热词；保留原始文本，必要时做候选纠错 |
| 口水话清理 | 高度可修 | 不需要换 ASR | 原始 ASR 与供 LLM 的 clean text 分离；默认不删除可能改变语义的词 |
| AI 播放时误识别 | 高度可修 | 否 | 半双工播放时关闭采集；播放结束后再监听 |
| barge-in | 可修但较复杂 | 模型不能单独解决 | 播放参考、回声消除、语音起始门限、立即停止播放；先做半双工，再做插话 |
| 当前只有一轮字幕 | 完全可修 | 否 | 使用已有本地 turns 加当前临时 turn 展示 |
| 字幕滚动 | 完全可修 | 否 | 底部跟随、上翻锁定、未读提示、160 轮上限内虚拟化/分页 |
| LLM 首字延迟 | Android 可显著修 | 换快模型可改善 | Android 原生增加 SSE/增量事件；桌面保留 SSE |
| TTS 首句延迟 | 可显著修 | 换更快 TTS 可改善 | 语义分段、并行预取、实际流式或短段缓冲 |
| TTS 段间停顿 | 可显著修 | 模型也有影响 | 最短段长、合并短句、预缓冲、播放时间轴 |
| 语速 | 完全可修 | 不必换 | APP 速度抽象，Fish 使用 `prosody.speed`，本地 fallback |
| Provider 切换 | 代码可修 | 否 | provider adapter + providerConfig；先实现，再开放 UI |
| 供应商不可达 | APP 无法保证 | 换节点/供应商可改善 | 明确诊断、超时、手动重试；不自动重复付费请求 |
| 音频焦点 | Android 可修 | 否 | 请求/释放 Audio Focus，失焦暂停或降音量，按系统语义恢复 |
| 退出界面过暗/模糊 | 完全可修 | 否 | 修复主题变量作用域，降低遮罩与 blur，保证关闭后状态清理 |

## 3. 硅基流动模型调查结论

### 3.1 `XingChenASR-V3.2-Ultra`

硅基流动模型广场将其描述为面向工业级场景的端到端语音识别模型，支持中英文及多方言混合识别。它适合进入**离线录音/整段转写 A/B**，但不能仅凭模型广场页面证明它支持本项目需要的实时 WebSocket、partial/final 事件、VAD endpoint 或可取消流式会话。

硅基流动公开的兼容接口是：

- `POST https://api.siliconflow.com/v1/audio/transcriptions`
- multipart 上传音频
- 文档示例模型为 `FunAudioLLM/SenseVoiceSmall`

因此目前不能把 `XingChenASR-V3.2-Ultra` 直接替换到现有阿里云 WebSocket transport。正确做法是新增 `SiliconFlowBatchAsrAdapter`，先在手动模式做整段上传验证；若供应商另有已确认的流式协议，再单独实现 `SiliconFlowRealtimeAsrTransport`。

### 3.2 `XingChenASR-Diarize`

它面向会议和话者分离。对于本 APP 的单用户主动复述，话者分离不是当前核心需求，反而可能增加响应结构和延迟。除非用户明确需要多人会议转写，不建议作为第一替换模型。

### 3.3 `XingChenGSR-V1.0`

GSR 是生成式语音识别/语义理解方向，不应自动当成普通 ASR 的等价替换。它可能适合复杂语义、上下文纠错或生成式识别实验，但当前不能证明它能提供：

- 逐段稳定 partial/final；
- 可控 endpoint；
- 与当前 PCM WebSocket 管线兼容；
- 低延迟连续通话；
- 原文保真输出。

建议只作为受控 A/B 或“语义纠错候选”，不能直接替换原始 ASR，也不能让其输出未经确认就成为学习事实。

### 3.4 是否值得换模型

建议顺序：

1. 当前阿里云 Paraformer 保留为实时链路基线。
2. 增加专业热词、语言提示、服务端断句参数和采集诊断。
3. 录制同一组中文普通词、专业词、完整句、换气句，做本地可复现 A/B。
4. 硅基流动 ASR 先做非实时整段转写对照。
5. 只有在质量/延迟/价格/可达性同时达标后，才进入实时 Provider 适配。

换模型可以改善错词，但**不能修复自动通话、字幕、取消、音频焦点和 UI 状态**。

## 4. 第一阶段：先修现有功能的确定性缺陷

### 4.1 统一 Provider 配置

保持现有 device-local `aiSecrets` 和已有 AI/TTS 设置，不新增第二个密钥数据库。

改造为：

- ASR、LLM、TTS 三个折叠入口；默认只显示当前 provider 名称。
- 展开后仅显示该 provider 的专属字段。
- profile ID 与 secret slot 一一对应。
- 切换 provider 时清除旧表单视图，不删除旧密钥。
- 配置保存后显示“已保存”，不要把输入框清空误导成保存失败；密钥输入可在保存后为空，但必须提供明确的已配置状态。
- 未验证权限、候选模板等开发状态只在诊断详情显示，不放在普通操作主路径。

本阶段不得开放无法实际运行的豆包 TTS/硅基流动 ASR 选项。

### 4.2 错误链路诊断

为每个 operation 记录脱敏阶段事件：

- ASR open/task-started/send/finish/final;
- LLM request/first-token/completed;
- TTS request/first-byte/completed;
- audio decode/play-start/play-end;
- commit/persist。

UI 错误必须明确是 ASR、LLM、TTS、播放、网络、配置还是本地落库，不再把所有错误压成一个通用编号。日志禁止 API key、Authorization、原始响应中的 secret。

### 4.3 取消与生命周期

统一取消入口必须同时：

- 递增 operation generation；
- abort ASR、LLM、TTS；
- 停止采集；
- 停止播放；
- 关闭 WebSocket/HTTP body；
- 清理队列、timer、事件监听；
- 拒绝迟到事件覆盖新状态。

Android TTS 增加 request ID 和原生 cancel，不能只在 JS 层丢弃结果。

### 4.4 退出面板

面板是网页自定义 Bottom Sheet，不是系统弹窗。修复：

- 把通话主题变量提升到共享祖先或在 sheet 上显式绑定。
- 遮罩从 `rgba(..., .68)` 调整到可读范围，blur 降低或按无障碍设置关闭。
- 打开面板后明确暂停/继续语义。
- 结束后清空 error、draft、capture 状态，正常结束不能携带上一轮失败文案。
- 增加 Escape/返回键、焦点管理和点击外部行为测试。

## 5. 第二阶段：实现真正的自动半双工

### 5.1 状态机

明确区分：

`idle → listening-armed → user-speaking → endpoint-wait → finalizing-asr → thinking → preparing-speech → speaking → listening-armed`

异常路径：

`cancelled / paused / failed / ended`

不能以 `ASR final` 直接代表 `user finished`，也不能以 `LLM_REPLIED` 直接代表“扬声器已开始播放”。

### 5.2 VAD 与 endpoint

先用本地 PCM 能量实现最小可靠版本：

- 语音开始：超过自适应噪音底噪门限，并持续多个帧；
- 最短有效语音：约 350 ms；
- 普通结束静音：先从 1.8–2.0 秒开始设备验收；
- 未完句/连接词结尾：约 4 秒；
- 长轮次：45 秒提示，120 秒强制结束但不自动提交空内容；
- 仅有噪音或过短音频：不送 LLM；
- 自动模式停止前保留尾部帧。

这些是 APP endpoint，不是阿里云句级断句参数。阿里云 Paraformer v2 文档中的 `max_sentence_silence` 默认 1300 ms、范围 200–6000 ms；它应作为服务端识别参数单独配置，不直接拿来当自动发送阈值。

### 5.3 ASR 参数

在配置模型中增加可选字段：

- `languageHints`；
- `vocabularyId`；
- `disfluencyRemovalEnabled`；
- `semanticPunctuationEnabled`；
- `maxSentenceSilence`；
- `multiThresholdModeEnabled`；
- `inverseTextNormalizationEnabled`。

默认先保留原始语气词，不自动删除；提供“供 AI 理解的整理文本”开关。

### 5.4 防止 AI 自己触发

自动半双工播放期间：

- 停止 AudioRecord/Web Audio 采集；
- 设置系统 capture gate；
- 播放结束后再创建新轮次采集；
- Android/桌面播放停止后等待短暂稳定时间；
- 不依靠“播放期间仍录音再猜是不是 AI”作为第一版本。

### 5.5 用户控制

自动模式仍保留：静音、暂停、结束、取消、打断按钮。暂停/结束/取消后不得因 `PLAYBACK_FINISHED` 或 React 重挂再次自动起麦。

第一版本建议称为“自动听说（半双工）”，不要宣称完整全双工。

## 6. 第三阶段：字幕与 TTS 流畅度

### 6.1 持续字幕

不新增数据库表：

- 已完成 turns 来自 `voiceRecallTurns`；
- 当前 ASR partial、LLM draft、TTS 状态保存在 runtime；
- UI 组合历史 turns + 当前临时 turn；
- 完整轮次仍按现有事务提交；失败轮次可保存为本地 draft/failed，不能冒充 completed。

增加滚动容器：

- 用户在底部时自动滚动；
- 用户上翻后锁定位置；
- 新内容到达显示“有新消息”；
- 回到底部后恢复跟随；
- 160 轮限制内按需分页或虚拟化。

不要把通话字幕自动写进正式学习日志。

### 6.2 LLM 低延迟

Desktop 当前已使用 SSE；Android 当前 `runNativeAiChat` 等待完整响应，必须新增原生增量传输协议。至少实现：

- 原生读取 SSE 行；
- 通过 Capacitor 事件发送 token/usage/completed/error；
- request ID 取消连接；
- 严格处理 `[DONE]`、断线和超时；
- 失败不能将已有 token 当成完整成功。

### 6.3 TTS 分段与缓冲

当前 `SpeakableSentenceBuffer` 按句号、问号、分号、换行切分；当前 TTS 请求在 Promise 链中串行，生产 Android/Desktop 又会等待完整 MP3。

改造：

1. 设定最小段长，短分句与下一分句合并。
2. 第一段达到合理语义边界后即提交。
3. 后续最多预取 1–2 段，设置缓冲水位。
4. 播放队列按段顺序播放，避免下载完成顺序导致乱序。
5. 首段失败立即显示 TTS 错误；后续段失败停止并保留字幕。
6. 先支持 MP3 完整段预缓冲，再评估真正的 PCM/Opus 增量播放，不把任意 MP3 HTTP chunk 当作可独立解码音频。

增加阶段时间戳，验收指标使用实际测量而非猜测：

- LLM request → first token；
- first token → TTS request；
- TTS request → first byte；
- first byte → play start；
- 段间 gap。

### 6.4 语速

新增本地偏好 `1.0× / 1.2× / 1.5×`，默认 `1.2×`。Fish Audio 官方文档支持 `prosody.speed`，范围 0.5–2.0；应把 APP 值映射到 provider-specific request。对于不支持 speed 的 provider，明确显示“本地播放变速”或“不支持”，不要静默假装生效。

## 7. 第四阶段：供应商扩展

### 7.1 Adapter 契约

保持 ASR、LLM、TTS 三个接口独立，补充能力声明：

- realtime / batch；
- partial / final；
- endpoint control；
- streaming LLM；
- streaming TTS；
- speed；
- cancellation；
- browser direct；
- provider-specific config schema。

### 7.2 硅基流动 ASR

先做 batch adapter，不改变实时默认链路：

- 手动模式停止录音后上传整段音频；
- 支持模型 ID、语言、可选上下文字段；
- 记录服务端响应与延迟；
- 以同一录音与 Paraformer 对比词错率、专业词召回、首结果时间、总时间和费用。

只有拿到硅基流动官方实时协议并完成取消、partial/final、endpoint 测试，才加入自动模式候选。

### 7.3 GSR

隔离为实验性语义识别 provider：

- 原始 ASR 仍保留；
- GSR 输出只作为候选 clean text；
- 用户确认或明确自动模式策略后才送 LLM；
- 不直接覆盖原始文本；
- 单独评估延迟、幻觉式补全和专业词改写风险。

## 8. 测试与验收门禁

### 自动化

新增确定性测试：

- 三种模式创建/恢复不降级；
- VAD：噪音、短语音、连续语音、换气、未完句；
- ASR partial/final 与 endpoint 分离；
- 自动提交只发生一次；
- AI 播放时不采集；
- 播放完成后自动重听；
- 暂停/结束/取消不自动重启；
- barge-in 取消播放并丢弃迟到事件；
- Android SSE token 与取消；
- TTS 分段合并、预取、顺序、失败；
- 字幕滚动和新消息提示；
- provider-specific 表单不串值；
- ASR/LLM/TTS/播放/落库错误分类；
- 退出 sheet 主题和状态清理。

普通验证继续排除 live 测试：

```powershell
npm run test -- --exclude "**/*.live.test.ts"
npm run test:voice-host
npm run build
git diff --check
```

### 手动设备验收

Android 至少覆盖：

- 有线耳机、蓝牙耳机、手机扬声器；
- 权限请求中取消；
- 背景音乐和通知音；
- 换气 0.3 秒后继续说；
- 普通词、专业词、数字、英文缩写；
- AI 播放时点击打断；
- 后台/返回/暂停/结束；
- VPN 开关下 Fish Audio 可达性；
- 1.0×、1.2×、1.5×。

每次记录真实时间线和 provider request ID。没有真实服务额度或真机时，保留“未验收”，不要伪造通过。

## 9. 最终推荐

**立即做：** 自动半双工、Android LLM 增量、TTS 取消、字幕历史、错误分层、退出 sheet、ASR 参数和采集诊断。

**随后做：** TTS 预缓冲、语速、专业热词、音频焦点、硅基流动 batch A/B。

**暂缓：** GSR 直接替换、全双工 barge-in、多供应商生产开放、完整价格系统、无需代理的 Fish Audio 承诺。

换模型可能改善识别准确率，但不能代替状态机、音频生命周期、UI、取消和配置修复。当前最稳妥的产品路径是：先交付可测试的“自动听说半双工”，再根据同一语音样本的量化 A/B 结果决定是否引入硅基流动 ASR 或 GSR。

## 10. 官方资料（调查日期：2026-09-11）

- SiliconFlow 文档：`https://docs.siliconflow.com/en/api-reference/audio/create-audio-transcriptions`，公开示例为 `POST /v1/audio/transcriptions`，示例模型 `FunAudioLLM/SenseVoiceSmall`。
- SiliconFlow 文档：`https://docs.siliconflow.com/en/api-reference/audio/create-speech`，公开的是音频合成接口，不证明 XingChen GSR/ASR 的实时协议。
- SiliconFlow 模型广场：用户截图显示 `XingChenGSR-V1.0`、`XingChenASR-V3.2-Ultra`、`XingChenASR-Diarize-V3.0` 等模型；截图本身不包含完整 API、计费、流式能力或参数契约。
- 阿里云 Paraformer 客户端事件文档：`https://help.aliyun.com/zh/model-studio/paraformer-client-events`；`max_sentence_silence` 默认 1300 ms、范围 200–6000 ms；支持 `vocabulary_id`、`disfluency_removal_enabled`、`semantic_punctuation_enabled`、`language_hints` 等参数。
- Fish Audio TTS 文档：`https://docs.fish.audio/api-reference/endpoint/openapi-v1/text-to-speech`；支持 `prosody.speed`，范围 0.5–2.0；`chunk_length` 范围 100–300。

## 11. 实施边界

本文件是修复方案，不表示功能已经完成。任何真实 provider、账户、费用、模型质量、VPN 可达性和设备播放结论，都必须在单独批准的验收批次中确认。不得将 API key 写入源码、测试、文档、日志、截图、备份、同步或聊天回复。
